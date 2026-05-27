import fs from 'fs';
import path from 'path';
import { FILES_DIR } from './config';
import { log, emitEvent } from './logging';
import { runOutgoingHooks } from './plugins';
import { enqueueResponse } from './queues';
import { runEval } from './evals';
import { runJudgmentInBackground } from './evalJudge';
import { withSpan, startSpan, endSpan } from './tracing';

export const LONG_RESPONSE_THRESHOLD = 4000;

/**
 * Resolve threshold at call time so TINYAGI_LONG_RESPONSE_THRESHOLD env var
 * can override the default without changing exports.
 */
function resolveThreshold(): number {
    const raw = process.env.TINYAGI_LONG_RESPONSE_THRESHOLD;
    if (!raw) return LONG_RESPONSE_THRESHOLD;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : LONG_RESPONSE_THRESHOLD;
}

/**
 * Truncate to a natural boundary before `limit` so the preview never ends
 * mid-word. Falls back to a hard char-level cut if no boundary is found
 * within the last ~25% of the budget.
 */
function truncateToBoundary(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const window = text.substring(0, limit);
    const minBoundary = Math.floor(limit * 0.75);

    const paraBreak = window.lastIndexOf('\n\n');
    if (paraBreak >= minBoundary) return window.substring(0, paraBreak);

    const lineBreak = window.lastIndexOf('\n');
    if (lineBreak >= minBoundary) return window.substring(0, lineBreak);

    const sentenceBreak = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
    );
    if (sentenceBreak >= minBoundary) return window.substring(0, sentenceBreak + 1);

    return window;
}

function sanitizeForFilename(s: string | undefined): string {
    if (!s) return '';
    return s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/**
 * If a response exceeds the threshold, save full text as a .md file
 * and return a truncated preview with the file attached.
 *
 * `context` is optional and additive: when provided, the saved filename
 * includes the agent and channel for easier grep-ability. Callers that
 * don't pass it get the legacy `response_<timestamp>.md` naming.
 */
export function handleLongResponse(
    response: string,
    existingFiles: string[],
    context?: { agentId?: string; channel?: string }
): { message: string; files: string[] } {
    const threshold = resolveThreshold();

    if (response.length <= threshold) {
        return { message: response, files: existingFiles };
    }

    let filename: string;
    if (context && (context.agentId || context.channel)) {
        const parts = [
            'response',
            sanitizeForFilename(context.agentId),
            sanitizeForFilename(context.channel),
            String(Date.now()),
        ].filter(Boolean);
        filename = parts.join('_') + '.md';
    } else {
        filename = `response_${Date.now()}.md`;
    }

    const filePath = path.join(FILES_DIR, filename);
    fs.writeFileSync(filePath, response);
    log('INFO', `Long response (${response.length} chars, threshold=${threshold}) saved to ${filename}`);

    const previewBody = truncateToBoundary(response, threshold);
    const preview = `${previewBody}\n\n_(Full response: ${response.length} chars, attached as ${filename})_`;

    return { message: preview, files: [...existingFiles, filePath] };
}

/**
 * Collect files from a response text.
 */
export function collectFiles(response: string, fileSet: Set<string>): void {
    const fileRegex = /\[send_file:\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = match[1].trim();
        if (fs.existsSync(filePath)) fileSet.add(filePath);
    }
}

/**
 * Shared pipeline for processing and enqueuing a response.
 * Used by both direct responses and streamed team responses.
 *
 * Pipeline: transform? → collectFiles + strip tags → runOutgoingHooks → handleLongResponse → enqueueResponse → emitEvent
 */
export async function streamResponse(response: string, options: {
    channel: string;
    sender: string;
    senderId?: string;
    messageId: string;
    originalMessage: string;
    agentId: string;
    transform?: (text: string) => string;
}): Promise<void> {
    // Whole pipeline traced as one root span when tracing is enabled.
    // Cheap no-op when disabled. Never throws.
    return withSpan('response.streamResponse', async () => {
        let finalResponse = response.trim();

        if (options.transform) {
            finalResponse = options.transform(finalResponse);
        }

        const outboundFilesSet = new Set<string>();
        collectFiles(finalResponse, outboundFilesSet);
        const outboundFiles = Array.from(outboundFilesSet);
        if (outboundFiles.length > 0) {
            finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
        }

        const hooksSpan = startSpan('response.runOutgoingHooks');
        const { text: hookedResponse, metadata } = await runOutgoingHooks(finalResponse, {
            channel: options.channel, sender: options.sender, messageId: options.messageId, originalMessage: options.originalMessage,
        });
        endSpan(hooksSpan, 'ok', { hookCount: Object.keys(metadata).length });

        const { message: responseMessage, files: allFiles } = handleLongResponse(
            hookedResponse,
            outboundFiles,
            { agentId: options.agentId, channel: options.channel }
        );

        enqueueResponse({
            channel: options.channel,
            sender: options.sender,
            senderId: options.senderId,
            message: responseMessage,
            originalMessage: options.originalMessage,
            messageId: options.messageId,
            agent: options.agentId,
            files: allFiles.length > 0 ? allFiles : undefined,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });

        // Non-blocking, post-enqueue eval hook. No-op when no spec is registered
        // for this agent. Wrapped so eval failures NEVER affect response delivery.
        try {
            runEval(options.agentId, hookedResponse, {
                messageId: options.messageId,
                channel: options.channel,
            });
        } catch (e) {
            log('WARN', `eval hook threw (non-fatal): ${(e as Error).message}`);
        }

        // Fire-and-forget LLM-as-judge. No-op when judge is not configured
        // and enabled for this agent. The judge call runs in the background
        // (returns immediately); errors and persistence happen async.
        try {
            runJudgmentInBackground(options.agentId, hookedResponse, {
                messageId: options.messageId,
                channel: options.channel,
            });
        } catch (e) {
            log('WARN', `judge dispatch threw (non-fatal): ${(e as Error).message}`);
        }

        log('INFO', `@${options.agentId} responded:\n${finalResponse}`);
        emitEvent('message:done', { channel: options.channel, sender: options.sender, agentId: options.agentId, responseLength: finalResponse.length, responseText: finalResponse, messageId: options.messageId });
    }, {
        agentId: options.agentId,
        channel: options.channel,
        messageId: options.messageId,
        responseChars: response.length,
    });
}
