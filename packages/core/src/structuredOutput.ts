/**
 * Structured-output envelope for agent responses.
 *
 * Why this exists: today's inter-agent routing relies on regex parsing
 * of `[@agent: msg]` and `[#team: msg]` tags inside the agent's free-text
 * output. That works but is fragile to model phrasing variance and
 * paraphrasing. This module gives agents (and consumers) an opt-in path
 * to emit and parse a structured envelope instead, falling back to
 * regex when no envelope is present.
 *
 * Backwards compatibility: nothing in the existing code calls this
 * module. Existing routing (`teams/src/routing.ts`, `response.ts`
 * collectFiles) continues to use regex unchanged. To opt in, a consumer
 * checks parseAgentEnvelope(output) first; if it returns non-null, it
 * uses the structured fields. Otherwise it falls back to the legacy
 * regex path. Agents opt in by including getEnvelopeInstructions() in
 * their system prompt.
 *
 * Envelope detection is conservative: only a single JSON code fence
 * at the START of the response is treated as an envelope. Mid-response
 * JSON, multiple fences, or invalid JSON all yield null (fall back to
 * regex).
 */

export interface AgentEnvelopeRoute {
    /** Destination — either "@agent_id" or "#team_id". */
    to: string;
    /** Message body sent to the destination. */
    body: string;
}

export interface AgentEnvelope {
    /** The main response body shown to the original sender. */
    text?: string;
    /** Inter-agent / team broadcast routes. */
    routes?: AgentEnvelopeRoute[];
    /** Absolute file paths to attach. */
    files?: string[];
}

/**
 * Prompt instructions an agent can include to opt into envelope output.
 * Returning this verbatim from a system-prompt builder keeps the wire
 * format in sync with the parser.
 */
export function getEnvelopeInstructions(): string {
    return [
        'When you want to (a) send a side message to another agent, (b) broadcast to a team,',
        'or (c) attach files, you MAY respond with a structured envelope as your FIRST',
        'output. Wrap it in a ```json fenced code block at the very start of your message:',
        '',
        '```json',
        '{',
        '  "text": "main reply body shown to the original sender",',
        '  "routes": [',
        '    {"to": "@agent_id", "body": "side message to that agent"},',
        '    {"to": "#team_id", "body": "broadcast to that team"}',
        '  ],',
        '  "files": ["/absolute/path/to/file.md"]',
        '}',
        '```',
        '',
        'All fields are optional. If you omit the envelope entirely, your response is',
        'treated as plain text and routed with the existing regex tags.',
    ].join('\n');
}

/** Constants exposed for callers that want to assert on the fence shape. */
export const ENVELOPE_FENCE_OPEN = '```json';
export const ENVELOPE_FENCE_CLOSE = '```';

function tryParseJson(s: string): unknown | null {
    try { return JSON.parse(s); } catch { return null; }
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isValidRoute(v: unknown): v is AgentEnvelopeRoute {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return typeof r.to === 'string' && typeof r.body === 'string';
}

/**
 * Try to parse an envelope from the beginning of an agent's output.
 * Returns null when no envelope is present or the envelope is malformed
 * (calling code should fall back to legacy regex parsing).
 *
 * Conservative detection rules:
 *   - The output must START with ```json (optionally preceded by whitespace).
 *   - The fenced block must contain valid JSON.
 *   - The JSON must be an object (not array/primitive).
 *   - Fields are validated for type; unknown fields are ignored.
 *   - Any text after the closing fence is NOT part of the envelope and
 *     is ignored (typically the envelope is the entire message; callers
 *     who want both should prefer envelope.text).
 */
export function parseAgentEnvelope(output: string): AgentEnvelope | null {
    const trimmed = output.trimStart();
    if (!trimmed.startsWith(ENVELOPE_FENCE_OPEN)) return null;

    const afterOpen = trimmed.slice(ENVELOPE_FENCE_OPEN.length);
    const closeIdx = afterOpen.indexOf(ENVELOPE_FENCE_CLOSE);
    if (closeIdx < 0) return null;

    const jsonText = afterOpen.slice(0, closeIdx).trim();
    const parsed = tryParseJson(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const obj = parsed as Record<string, unknown>;
    const envelope: AgentEnvelope = {};

    if (typeof obj.text === 'string') envelope.text = obj.text;
    if (Array.isArray(obj.routes)) {
        const routes = obj.routes.filter(isValidRoute);
        if (routes.length > 0) envelope.routes = routes;
    }
    if (isStringArray(obj.files)) envelope.files = obj.files;

    return envelope;
}

/**
 * Convenience: parse if possible, otherwise return a synthetic envelope
 * containing the raw text. `usedStructured` tells callers which path
 * was taken so they can decide whether to also run legacy regex over
 * `text` for file-tag and @-mention extraction.
 */
export function extractEnvelopeOrText(output: string): {
    envelope: AgentEnvelope;
    usedStructured: boolean;
} {
    const parsed = parseAgentEnvelope(output);
    if (parsed) return { envelope: parsed, usedStructured: true };
    return { envelope: { text: output }, usedStructured: false };
}

/**
 * Serialize an AgentEnvelope back into the wire format. Useful for
 * tests, replays, and programmatic agents.
 */
export function serializeEnvelope(env: AgentEnvelope): string {
    return `${ENVELOPE_FENCE_OPEN}\n${JSON.stringify(env, null, 2)}\n${ENVELOPE_FENCE_CLOSE}`;
}
