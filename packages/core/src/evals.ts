/**
 * Structural eval harness for agent responses.
 *
 * Design constraints:
 *  - Opt-in per agent. An agent with no registered spec is never evaluated;
 *    callers pay zero overhead. The wiring in response.ts is a single
 *    no-op lookup when no specs exist.
 *  - Failure-safe. If the eval DB cannot be opened, a spec is malformed,
 *    or any check throws, the eval pipeline logs WARN and swallows. Evals
 *    NEVER block, retry, or alter response delivery.
 *  - Separate DB file (`evals.db`) so it can be rebuilt without touching
 *    the queue or memory DBs.
 *  - Validation surface intentionally small in v0: required sections,
 *    banned patterns, line bounds. Matches the workspace harness so
 *    fixtures and tooling transfer.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { TINYAGI_HOME } from './config';
import { log } from './logging';

export const EVALS_DB_PATH = path.join(TINYAGI_HOME, 'evals.db');

export interface EvalSpec {
    requiredSections?: string[];
    bannedPatterns?: string[];
    minLines?: number;
    maxLines?: number;
    notes?: string;
}

export interface EvalRunResult {
    agentId: string;
    passed: boolean;
    failures: string[];
    durationMs: number;
}

export interface EvalRunRecord extends EvalRunResult {
    id: number;
    runDate: string;
    messageId?: string;
    channel?: string;
}

let db: Database.Database | null = null;

function ensureDb(): Database.Database {
    if (db) return db;
    fs.mkdirSync(path.dirname(EVALS_DB_PATH), { recursive: true });
    db = new Database(EVALS_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS eval_specs (
            agent_id TEXT PRIMARY KEY,
            spec_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS eval_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            run_date TEXT NOT NULL DEFAULT (datetime('now')),
            passed INTEGER NOT NULL,
            failures_json TEXT,
            message_id TEXT,
            channel TEXT,
            duration_ms INTEGER,
            output_chars INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_eval_runs_agent ON eval_runs(agent_id, run_date DESC);
    `);
    return db;
}

export function defineEvalSpec(agentId: string, spec: EvalSpec): void {
    if (!agentId) throw new Error('defineEvalSpec: agentId is required');
    const dbh = ensureDb();
    dbh.prepare(
        'INSERT INTO eval_specs(agent_id, spec_json) VALUES (?, ?) ' +
        'ON CONFLICT(agent_id) DO UPDATE SET spec_json = excluded.spec_json, updated_at = datetime(\'now\')'
    ).run(agentId, JSON.stringify(spec));
}

export function getEvalSpec(agentId: string): EvalSpec | null {
    try {
        const dbh = ensureDb();
        const row = dbh.prepare('SELECT spec_json FROM eval_specs WHERE agent_id = ?').get(agentId) as
            | { spec_json: string }
            | undefined;
        if (!row) return null;
        return JSON.parse(row.spec_json) as EvalSpec;
    } catch {
        return null;
    }
}

export function deleteEvalSpec(agentId: string): boolean {
    const dbh = ensureDb();
    const info = dbh.prepare('DELETE FROM eval_specs WHERE agent_id = ?').run(agentId);
    return info.changes > 0;
}

function validate(output: string, spec: EvalSpec): string[] {
    const failures: string[] = [];

    const nonBlankLines = output.split('\n').filter(l => l.trim().length > 0);
    const n = nonBlankLines.length;
    if (spec.minLines !== undefined && n < spec.minLines) {
        failures.push(`line_count ${n} < min ${spec.minLines}`);
    }
    if (spec.maxLines !== undefined && n > spec.maxLines) {
        failures.push(`line_count ${n} > max ${spec.maxLines}`);
    }

    const lower = output.toLowerCase();
    for (const section of spec.requiredSections || []) {
        if (!lower.includes(section.toLowerCase())) {
            failures.push(`missing_section: ${JSON.stringify(section)}`);
        }
    }
    for (const pattern of spec.bannedPatterns || []) {
        if (lower.includes(pattern.toLowerCase())) {
            failures.push(`banned_pattern: ${JSON.stringify(pattern)}`);
        }
    }
    return failures;
}

/**
 * Run an eval for an agent's output. Returns null if no spec is registered
 * (the common no-op path); never throws to caller.
 *
 * Side effects: writes a row to eval_runs, logs a WARN if failed.
 */
export function runEval(
    agentId: string,
    output: string,
    context?: { messageId?: string; channel?: string }
): EvalRunResult | null {
    const start = Date.now();
    let spec: EvalSpec | null;
    try {
        spec = getEvalSpec(agentId);
    } catch (e) {
        log('WARN', `evals.runEval: failed to load spec for ${agentId}: ${(e as Error).message}`);
        return null;
    }
    if (!spec) return null;

    let failures: string[] = [];
    try {
        failures = validate(output, spec);
    } catch (e) {
        log('WARN', `evals.runEval: validate threw for ${agentId}: ${(e as Error).message}`);
        return null;
    }
    const durationMs = Date.now() - start;
    const passed = failures.length === 0;

    try {
        const dbh = ensureDb();
        dbh.prepare(
            'INSERT INTO eval_runs(agent_id, passed, failures_json, message_id, channel, duration_ms, output_chars) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
            agentId,
            passed ? 1 : 0,
            failures.length > 0 ? JSON.stringify(failures) : null,
            context?.messageId ?? null,
            context?.channel ?? null,
            durationMs,
            output.length,
        );
    } catch (e) {
        log('WARN', `evals.runEval: failed to record run for ${agentId}: ${(e as Error).message}`);
    }

    if (!passed) {
        log('WARN', `eval FAIL @${agentId}${context?.messageId ? ` msg=${context.messageId}` : ''}: ${failures.join(', ')}`);
    }

    return { agentId, passed, failures, durationMs };
}

export function getEvalRuns(agentId?: string, limit: number = 50): EvalRunRecord[] {
    const dbh = ensureDb();
    const rows = agentId
        ? dbh.prepare(
              'SELECT id, agent_id, run_date, passed, failures_json, message_id, channel, duration_ms ' +
              'FROM eval_runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
          ).all(agentId, limit)
        : dbh.prepare(
              'SELECT id, agent_id, run_date, passed, failures_json, message_id, channel, duration_ms ' +
              'FROM eval_runs ORDER BY id DESC LIMIT ?'
          ).all(limit);

    return (rows as Array<{
        id: number; agent_id: string; run_date: string; passed: number;
        failures_json: string | null; message_id: string | null; channel: string | null;
        duration_ms: number | null;
    }>).map(r => ({
        id: r.id,
        agentId: r.agent_id,
        runDate: r.run_date,
        passed: r.passed === 1,
        failures: r.failures_json ? JSON.parse(r.failures_json) : [],
        messageId: r.message_id ?? undefined,
        channel: r.channel ?? undefined,
        durationMs: r.duration_ms ?? 0,
    }));
}

export interface EvalSummary {
    agentId: string;
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    lastRun?: string;
}

export function getEvalSummary(sinceIsoDate?: string): EvalSummary[] {
    const dbh = ensureDb();
    const sql = sinceIsoDate
        ? 'SELECT agent_id, COUNT(*) AS total, SUM(passed) AS passed, MAX(run_date) AS last_run ' +
          'FROM eval_runs WHERE run_date >= ? GROUP BY agent_id ORDER BY agent_id'
        : 'SELECT agent_id, COUNT(*) AS total, SUM(passed) AS passed, MAX(run_date) AS last_run ' +
          'FROM eval_runs GROUP BY agent_id ORDER BY agent_id';
    const rows = (sinceIsoDate
        ? dbh.prepare(sql).all(sinceIsoDate)
        : dbh.prepare(sql).all()) as Array<{ agent_id: string; total: number; passed: number; last_run: string }>;

    return rows.map(r => ({
        agentId: r.agent_id,
        total: r.total,
        passed: r.passed,
        failed: r.total - r.passed,
        passRate: r.total > 0 ? r.passed / r.total : 0,
        lastRun: r.last_run,
    }));
}

export function closeEvalsDb(): void {
    if (db) { db.close(); db = null; }
}
