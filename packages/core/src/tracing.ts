/**
 * Span-based tracing for agent runs.
 *
 * Design constraints:
 *  - Opt-in. Default state is disabled (no DB opened, all functions are
 *    cheap no-ops). Enable via TINYAGI_TRACING=1 env var at startup, or
 *    programmatically via enableTracing().
 *  - Trace context propagates through AsyncLocalStorage. Child spans
 *    inherit traceId and parentId automatically when run inside withSpan.
 *  - Separate DB file (`traces.db`) so it can be vacuumed, rebuilt, or
 *    deleted without touching agent state.
 *  - Failure-safe. Persistence errors log WARN and swallow; tracing
 *    NEVER blocks or alters the traced operation.
 *
 * Wire-up: any code path that wants to be traced wraps work in withSpan
 * (or calls startSpan/endSpan manually). The streamResponse pipeline is
 * instrumented in response.ts; downstream services may add more.
 */

import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { TINYAGI_HOME } from './config';
import { log } from './logging';

export const TRACES_DB_PATH = path.join(TINYAGI_HOME, 'traces.db');

export interface Span {
    id: string;
    traceId: string;
    parentId?: string;
    name: string;
    attributes: Record<string, unknown>;
    startTime: number;
    endTime?: number;
    status?: 'ok' | 'error';
    error?: string;
}

export interface TraceSummary {
    traceId: string;
    rootName: string;
    startTime: number;
    durationMs?: number;
    status?: 'ok' | 'error';
    spanCount: number;
}

const als = new AsyncLocalStorage<Span>();
let db: Database.Database | null = null;
let enabled: boolean = process.env.TINYAGI_TRACING === '1';

export function isTracingEnabled(): boolean {
    return enabled;
}

export function enableTracing(): void {
    enabled = true;
}

export function disableTracing(): void {
    enabled = false;
}

function ensureDb(): Database.Database {
    if (db) return db;
    fs.mkdirSync(path.dirname(TRACES_DB_PATH), { recursive: true });
    db = new Database(TRACES_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS spans (
            id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL,
            parent_id TEXT,
            name TEXT NOT NULL,
            attributes_json TEXT,
            start_time INTEGER NOT NULL,
            end_time INTEGER,
            status TEXT,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id, start_time);
        CREATE INDEX IF NOT EXISTS idx_spans_recent_roots ON spans(start_time DESC) WHERE parent_id IS NULL;
    `);
    return db;
}

/**
 * Begin a span. Returns null when tracing is disabled — callers should
 * pass that null back to endSpan, which is a no-op for null.
 *
 * If called inside a withSpan, the new span inherits traceId and uses the
 * enclosing span as its parent. Otherwise it starts a fresh trace.
 */
export function startSpan(
    name: string,
    attributes?: Record<string, unknown>
): Span | null {
    if (!enabled) return null;
    const parent = als.getStore();
    return {
        id: nanoid(),
        traceId: parent ? parent.traceId : nanoid(),
        parentId: parent?.id,
        name,
        attributes: attributes ?? {},
        startTime: Date.now(),
    };
}

/**
 * Finalize and persist a span. Safe to call with null. Persistence
 * errors are logged WARN and swallowed.
 */
export function endSpan(
    span: Span | null,
    status: 'ok' | 'error' = 'ok',
    extraAttributes?: Record<string, unknown>,
    error?: string
): void {
    if (!span || !enabled) return;
    span.endTime = Date.now();
    span.status = status;
    if (extraAttributes) span.attributes = { ...span.attributes, ...extraAttributes };
    if (error) span.error = error;
    try {
        const dbh = ensureDb();
        dbh.prepare(
            'INSERT INTO spans(id, trace_id, parent_id, name, attributes_json, start_time, end_time, status, error) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            span.id,
            span.traceId,
            span.parentId ?? null,
            span.name,
            Object.keys(span.attributes).length ? JSON.stringify(span.attributes) : null,
            span.startTime,
            span.endTime,
            span.status,
            span.error ?? null,
        );
    } catch (e) {
        log('WARN', `tracing.endSpan: failed to persist (non-fatal): ${(e as Error).message}`);
    }
}

/**
 * Run `fn` inside a span. The span ends automatically on completion or
 * throw. Child spans created inside `fn` (synchronously or in awaited
 * async chains) inherit the trace context via AsyncLocalStorage.
 *
 * When tracing is disabled, this is a thin pass-through: `fn` runs in
 * place and the return value is returned. No span is created.
 */
export async function withSpan<T>(
    name: string,
    fn: () => Promise<T> | T,
    attributes?: Record<string, unknown>
): Promise<T> {
    if (!enabled) {
        return await Promise.resolve(fn());
    }
    const span = startSpan(name, attributes);
    if (!span) return await Promise.resolve(fn());
    return als.run(span, async () => {
        try {
            const result = await Promise.resolve(fn());
            endSpan(span, 'ok');
            return result;
        } catch (e) {
            endSpan(span, 'error', undefined, (e as Error).message);
            throw e;
        }
    });
}

/** Get the currently-active span (if any). */
export function currentSpan(): Span | null {
    return als.getStore() ?? null;
}

/** Get all spans for a trace, in start-time order. */
export function getTrace(traceId: string): Span[] {
    const dbh = ensureDb();
    const rows = dbh.prepare(
        'SELECT id, trace_id, parent_id, name, attributes_json, start_time, end_time, status, error ' +
        'FROM spans WHERE trace_id = ? ORDER BY start_time ASC'
    ).all(traceId) as Array<{
        id: string; trace_id: string; parent_id: string | null; name: string;
        attributes_json: string | null; start_time: number; end_time: number | null;
        status: string | null; error: string | null;
    }>;
    return rows.map(r => ({
        id: r.id,
        traceId: r.trace_id,
        parentId: r.parent_id ?? undefined,
        name: r.name,
        attributes: r.attributes_json ? JSON.parse(r.attributes_json) : {},
        startTime: r.start_time,
        endTime: r.end_time ?? undefined,
        status: (r.status as 'ok' | 'error' | null) ?? undefined,
        error: r.error ?? undefined,
    }));
}

/** Summaries of recent traces, ordered newest first. */
export function listRecentTraces(limit: number = 50): TraceSummary[] {
    const dbh = ensureDb();
    const rows = dbh.prepare(`
        SELECT
            root.trace_id      AS trace_id,
            root.name          AS root_name,
            root.start_time    AS start_time,
            root.end_time      AS end_time,
            root.status        AS status,
            (SELECT COUNT(*) FROM spans WHERE trace_id = root.trace_id) AS span_count
        FROM spans root
        WHERE root.parent_id IS NULL
        ORDER BY root.start_time DESC
        LIMIT ?
    `).all(limit) as Array<{
        trace_id: string; root_name: string; start_time: number;
        end_time: number | null; status: string | null; span_count: number;
    }>;
    return rows.map(r => ({
        traceId: r.trace_id,
        rootName: r.root_name,
        startTime: r.start_time,
        durationMs: r.end_time ? r.end_time - r.start_time : undefined,
        status: (r.status as 'ok' | 'error' | null) ?? undefined,
        spanCount: r.span_count,
    }));
}

export function closeTracesDb(): void {
    if (db) { db.close(); db = null; }
}
