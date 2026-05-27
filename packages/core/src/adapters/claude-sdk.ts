/**
 * Direct-SDK adapter for Anthropic — opt-in alternative to the CLI shellout
 * (`adapters/claude.ts`). Provider key: `anthropic-sdk`.
 *
 * Why this exists: the CLI adapter inherits everything Claude Code ships
 * (long context, MCP, prompt caching, tool use, OAuth) for free, but
 * pays 100-500ms of subprocess spawn per turn and cannot coordinate
 * prompt caching across agents. For latency-sensitive or programmatic
 * workloads (batch evals, server-side embedding, web responses), the
 * SDK adapter calls the Anthropic API in-process.
 *
 * Tradeoffs (read before switching agents):
 *  - Requires ANTHROPIC_API_KEY in env or envOverrides. OAuth / Claude
 *    Code subscription auth is NOT supported here — keep those agents
 *    on the CLI adapter (`provider: anthropic`).
 *  - No automatic conversation continuation (the CLI's `-c` flag).
 *    Each invocation is a fresh single-turn call. Callers that need
 *    multi-turn history must pass it in the message themselves, or
 *    stay on the CLI adapter.
 *  - No tool use, MCP, or shell access — pure text in / text out. Use
 *    the CLI adapter when agents need tools.
 *
 * Dependency: `@anthropic-ai/sdk` is loaded lazily on first invocation.
 * If not installed, a clear error is thrown instructing the user to
 * `npm install @anthropic-ai/sdk`. This keeps the package install cost
 * zero for users who don't opt into the SDK adapter.
 *
 * Tests inject a mock client via setClaudeSdkClientFactory() to exercise
 * the adapter contract without making real API calls.
 */

import { AgentAdapter, InvokeOptions } from './types';
import { log } from '../logging';
import { withSpan } from '../tracing';

// Lazy-loaded reference to the @anthropic-ai/sdk export.
let _AnthropicCtor: unknown = null;

async function loadAnthropicCtor(): Promise<new (opts: { apiKey: string }) => unknown> {
    if (_AnthropicCtor) return _AnthropicCtor as new (opts: { apiKey: string }) => unknown;
    try {
        const mod: { default?: unknown; Anthropic?: unknown } = await import('@anthropic-ai/sdk' as string);
        _AnthropicCtor = (mod.default ?? mod.Anthropic ?? mod) as unknown;
        return _AnthropicCtor as new (opts: { apiKey: string }) => unknown;
    } catch {
        throw new Error(
            "claude-sdk adapter requires '@anthropic-ai/sdk' to be installed. " +
            'Run: npm install @anthropic-ai/sdk'
        );
    }
}

/**
 * Minimal client shape this adapter relies on. Both the real
 * @anthropic-ai/sdk Anthropic class and test mocks satisfy this.
 */
export interface ClaudeSdkClient {
    messages: {
        create(args: {
            model: string;
            max_tokens: number;
            system?: string;
            messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        }): Promise<{ content: Array<{ type: string; text?: string }> }>;
        stream(args: {
            model: string;
            max_tokens: number;
            system?: string;
            messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        }): AsyncIterable<{
            type: string;
            delta?: { type: string; text?: string };
        }> & {
            finalMessage?: () => Promise<{ content: Array<{ type: string; text?: string }> }>;
        };
    };
}

export type ClaudeSdkClientFactory = (opts: { apiKey: string }) => ClaudeSdkClient;

let clientFactory: ClaudeSdkClientFactory | null = null;

/**
 * Inject a custom client factory. Set to null to revert to the default
 * (lazy-load @anthropic-ai/sdk and construct an Anthropic client).
 */
export function setClaudeSdkClientFactory(f: ClaudeSdkClientFactory | null): void {
    clientFactory = f;
}

export const DEFAULT_CLAUDE_SDK_MAX_TOKENS = 8192;

export const claudeSdkAdapter: AgentAdapter = {
    providers: ['anthropic-sdk'],

    async invoke(opts: InvokeOptions): Promise<string> {
        return withSpan('adapter.claudeSdk.invoke', async () => {
            const { agentId, message, systemPrompt, model, envOverrides, onEvent } = opts;
            log('DEBUG', `Using claude-sdk adapter (agent: ${agentId})`);

            const apiKey = envOverrides.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';

            let client: ClaudeSdkClient;
            if (clientFactory) {
                client = clientFactory({ apiKey });
            } else {
                if (!apiKey) {
                    throw new Error(
                        'claude-sdk adapter requires ANTHROPIC_API_KEY (in env or envOverrides). ' +
                        'For OAuth / Claude Code subscription auth, keep agents on the CLI adapter ("anthropic").'
                    );
                }
                const Ctor = await loadAnthropicCtor();
                client = new Ctor({ apiKey }) as unknown as ClaudeSdkClient;
            }

            const effectiveModel = model || 'claude-sonnet-4-5';
            const maxTokens = DEFAULT_CLAUDE_SDK_MAX_TOKENS;

            if (onEvent) {
                let response = '';
                const stream = client.messages.stream({
                    model: effectiveModel,
                    max_tokens: maxTokens,
                    system: systemPrompt || undefined,
                    messages: [{ role: 'user', content: message }],
                });

                for await (const event of stream) {
                    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
                        response += event.delta.text;
                        onEvent(event.delta.text);
                    }
                }
                if (stream.finalMessage) {
                    try { await stream.finalMessage(); } catch { /* non-fatal */ }
                }
                return response || 'Empty response from claude-sdk adapter.';
            }

            const result = await client.messages.create({
                model: effectiveModel,
                max_tokens: maxTokens,
                system: systemPrompt || undefined,
                messages: [{ role: 'user', content: message }],
            });

            const texts: string[] = [];
            for (const block of result.content) {
                if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
            }
            return texts.join('\n') || 'Empty response from claude-sdk adapter.';
        }, {
            agentId: opts.agentId,
            model: opts.model,
            adapter: 'claude-sdk',
        });
    },
};
