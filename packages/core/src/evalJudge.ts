/**
 * LLM-as-judge evaluation layer.
 *
 * Why this exists: the structural eval harness (evals.ts) catches
 * format regressions (missing sections, banned phrases, length) but
 * cannot judge whether an agent led with the point, kept the right
 * length, verified before asserting, or matched the user's voice.
 * The judge layer asks a second model to grade each response against
 * a user-supplied rubric of accumulated corrections.
 *
 * Design constraints:
 *  - Opt-in per agent via defineJudgeConfig({enabled: true}). Agents
 *    without config get a single SELECT lookup and bail. Zero cost
 *    for unconfigured agents.
 *  - Rubric is supplied via registerJudgeRubric(agentId, provider).
 *    The provider returns rules at judgment time, so they can be
 *    pulled fresh from whatever source the user keeps them in
 *    (SQLite, markdown files, in-memory list). createSqliteRubricProvider
 *    is a convenience for the common case.
 *  - Judge calls go through the existing claude-sdk adapter, which
 *    gives us tracing, env-var key handling, and test injection for free.
 *  - Persistence in evals.db (`eval_judgments` and `judge_configs` tables)
 *    so the same DB holds structural runs and judgments side by side.
 *  - Failure-safe. Judge API errors, parse failures, missing rubric,
 *    or DB write errors all log WARN and swallow. The judge NEVER
 *    blocks or alters the agent's actual response.
 *  - Fire-and-forget from response.ts (see runJudgmentInBackground).
 *    Awaitable from tests.
 *
 * Cost: ~$0.001 per judgment with Claude Haiku 4.5 (default). 1000
 * judgments/day ≈ $1/day. Tune via judgeModel and maxRules.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { TINYAGI_HOME, getSettings } from './config';
import { log } from './logging';
import { getAdapter } from './adapters';
import { withSpan } from './tracing';

export const JUDGE_DB_PATH = path.join(TINYAGI_HOME, 'evals.db');
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_JUDGE_ADAPTER = 'anthropic-sdk';
export const DEFAULT_SCORING_CRITERIA = [
    'ledWithPoint',
    'lengthAppropriate',
    'factualClaimsVerified',
    'toneMatches',
];
export const DEFAULT_MAX_RULES = 30;

export interface JudgeConfig {
    enabled: boolean;
    judgeModel?: string;
    /**
     * Provider key of the adapter to call for judge inference. Defaults
     * to `anthropic-sdk` (in-process API, fast, requires ANTHROPIC_API_KEY).
     * Use `anthropic` to route judge calls through the CLI adapter
     * instead, which works with OAuth / Claude Code subscription auth
     * at the cost of subprocess-spawn latency. Any registered adapter
     * key works; getAdapter(adapter) must resolve.
     */
    adapter?: string;
    scoringCriteria?: string[];
    maxRules?: number;
    /**
     * Optional persistent rubric source. When present, runJudgment will
     * construct a SQLite-backed rubric provider on demand if no in-memory
     * provider has been registered via registerJudgeRubric. This lets
     * judge configs survive daemon restarts without re-running a setup
     * script. In-memory registration (registerJudgeRubric) still takes
     * precedence when both are set.
     */
    rubricSource?: {
        type: 'sqlite';
        dbPath: string;
        query: string;
        columnName?: string;
    };
}

export interface JudgmentRubric {
    rules: string[];
    examples?: Array<{ rule: string; goodOutput: string; badOutput: string }>;
}

export type RubricProvider = (agentId: string) => Promise<JudgmentRubric>;

export interface Judgment {
    agentId: string;
    passed: boolean;
    violations: Array<{ rule: string; quote: string; severity: 'low' | 'medium' | 'high' }>;
    scores: Record<string, number>;
    notes?: string;
    judgeModel: string;
    inputChars: number;
    outputChars: number;
    durationMs: number;
}

export interface JudgmentRecord extends Judgment {
    id: number;
    runDate: string;
    messageId?: string;
    channel?: string;
}

export interface JudgmentSummary {
    agentId: string;
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    avgScores: Record<string, number>;
    lastRun?: string;
}

let db: Database.Database | null = null;
const rubricProviders = new Map<string, RubricProvider>();

function ensureDb(): Database.Database {
    if (db) return db;
    fs.mkdirSync(path.dirname(JUDGE_DB_PATH), { recursive: true });
    db = new Database(JUDGE_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS judge_configs (
            agent_id TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS eval_judgments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            run_date TEXT NOT NULL DEFAULT (datetime('now')),
            passed INTEGER NOT NULL,
            violations_json TEXT,
            scores_json TEXT,
            notes TEXT,
            judge_model TEXT,
            input_chars INTEGER,
            output_chars INTEGER,
            duration_ms INTEGER,
            message_id TEXT,
            channel TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_eval_judgments_agent ON eval_judgments(agent_id, id DESC);
    `);
    return db;
}

export function defineJudgeConfig(agentId: string, config: JudgeConfig): void {
    if (!agentId) throw new Error('defineJudgeConfig: agentId is required');
    const dbh = ensureDb();
    dbh.prepare(
        'INSERT INTO judge_configs(agent_id, config_json) VALUES (?, ?) ' +
        'ON CONFLICT(agent_id) DO UPDATE SET config_json = excluded.config_json, updated_at = datetime(\'now\')'
    ).run(agentId, JSON.stringify(config));
}

export function getJudgeConfig(agentId: string): JudgeConfig | null {
    try {
        const dbh = ensureDb();
        const row = dbh.prepare('SELECT config_json FROM judge_configs WHERE agent_id = ?').get(agentId) as
            | { config_json: string }
            | undefined;
        if (!row) return null;
        return JSON.parse(row.config_json) as JudgeConfig;
    } catch {
        return null;
    }
}

export function deleteJudgeConfig(agentId: string): boolean {
    const dbh = ensureDb();
    return dbh.prepare('DELETE FROM judge_configs WHERE agent_id = ?').run(agentId).changes > 0;
}

export function registerJudgeRubric(agentId: string, provider: RubricProvider): void {
    rubricProviders.set(agentId, provider);
}

export function unregisterJudgeRubric(agentId: string): void {
    rubricProviders.delete(agentId);
}

function buildJudgePrompt(opts: {
    agentId: string;
    output: string;
    rubric: JudgmentRubric;
    scoringCriteria: string[];
    maxRules: number;
}): { system: string; user: string } {
    const rules = opts.rubric.rules.slice(0, opts.maxRules);
    const system = [
        'You are an evaluator. You read an AI agent\'s response and grade it against the user\'s accumulated rules.',
        'Identify violations of any rule, quoting the exact text from the response.',
        'Score the response on each listed criterion as an integer 1-10 (10 = perfect).',
        'Output ONLY a single JSON object. No prose before or after. No markdown fences. Just JSON.',
        '',
        'JSON shape:',
        '{',
        '  "violations": [{"rule": "<exact rule violated>", "quote": "<exact quote from response>", "severity": "low|medium|high"}],',
        '  "scores": {<criterion>: <integer 1-10>, ...},',
        '  "notes": "<one short sentence>"',
        '}',
        '',
        'If no violations, return an empty violations array. Always include scores for every listed criterion.',
    ].join('\n');

    const exampleSection = (opts.rubric.examples && opts.rubric.examples.length > 0)
        ? '\n\nExamples of past corrections:\n' + opts.rubric.examples.map(e =>
            `- Rule: ${e.rule}\n  Bad: ${e.badOutput}\n  Good: ${e.goodOutput}`
          ).join('\n')
        : '';

    const user = [
        `Agent: ${opts.agentId}`,
        '',
        `User's rules (${rules.length} of ${opts.rubric.rules.length} total):`,
        ...rules.map((r, i) => `${i + 1}. ${r}`),
        exampleSection,
        '',
        `Score on these criteria: ${opts.scoringCriteria.join(', ')}`,
        '',
        'Response to evaluate:',
        '---',
        opts.output,
        '---',
    ].join('\n');

    return { system, user };
}

/**
 * Extract a JSON object from text that should contain one. Tolerates a
 * leading ```json fence (in case the judge ignores the no-fence rule).
 */
function extractJudgeJson(text: string): unknown | null {
    let t = text.trim();
    if (t.startsWith('```json')) {
        t = t.slice('```json'.length);
        const close = t.indexOf('```');
        if (close >= 0) t = t.slice(0, close);
    } else if (t.startsWith('```')) {
        t = t.slice(3);
        const close = t.indexOf('```');
        if (close >= 0) t = t.slice(0, close);
    }
    t = t.trim();
    if (!t.startsWith('{')) {
        const firstBrace = t.indexOf('{');
        const lastBrace = t.lastIndexOf('}');
        if (firstBrace < 0 || lastBrace <= firstBrace) return null;
        t = t.slice(firstBrace, lastBrace + 1);
    }
    try { return JSON.parse(t); } catch { return null; }
}

interface ParsedJudgment {
    violations: Array<{ rule: string; quote: string; severity: 'low' | 'medium' | 'high' }>;
    scores: Record<string, number>;
    notes?: string;
}

function validateJudgeResponse(parsed: unknown): ParsedJudgment | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    const violations: ParsedJudgment['violations'] = [];
    if (Array.isArray(obj.violations)) {
        for (const v of obj.violations) {
            if (v && typeof v === 'object') {
                const vr = v as Record<string, unknown>;
                if (typeof vr.rule === 'string' && typeof vr.quote === 'string') {
                    const sev = vr.severity === 'high' || vr.severity === 'medium' || vr.severity === 'low'
                        ? vr.severity : 'medium';
                    violations.push({ rule: vr.rule, quote: vr.quote, severity: sev });
                }
            }
        }
    }

    const scores: Record<string, number> = {};
    if (obj.scores && typeof obj.scores === 'object' && !Array.isArray(obj.scores)) {
        for (const [k, v] of Object.entries(obj.scores as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) {
                scores[k] = Math.max(1, Math.min(10, Math.round(v)));
            }
        }
    }

    const notes = typeof obj.notes === 'string' ? obj.notes : undefined;
    return { violations, scores, notes };
}

/**
 * Run a judgment for an agent's output. Returns null when no config is
 * registered, the config is disabled, or no rubric provider is registered.
 *
 * Failures (no API key, judge call error, parse error, DB write error)
 * all return null and log WARN — never throw to caller.
 */
export async function runJudgment(
    agentId: string,
    output: string,
    context?: { messageId?: string; channel?: string }
): Promise<Judgment | null> {
    return withSpan('evalJudge.runJudgment', async () => {
        const config = getJudgeConfig(agentId);
        if (!config || !config.enabled) return null;

        // Resolve a rubric provider: in-memory registration takes precedence,
        // then fall back to a persistent rubricSource in the config.
        let provider = rubricProviders.get(agentId);
        if (!provider && config.rubricSource && config.rubricSource.type === 'sqlite') {
            provider = createSqliteRubricProvider({
                dbPath: config.rubricSource.dbPath,
                query: config.rubricSource.query,
                columnName: config.rubricSource.columnName,
            });
        }
        if (!provider) {
            log('WARN', `evalJudge: agent=${agentId} has config but no rubric provider (in-memory or rubricSource) — skipping`);
            return null;
        }

        let rubric: JudgmentRubric;
        try {
            rubric = await provider(agentId);
        } catch (e) {
            log('WARN', `evalJudge: rubric provider threw for ${agentId}: ${(e as Error).message}`);
            return null;
        }
        if (!rubric || !Array.isArray(rubric.rules) || rubric.rules.length === 0) {
            return null;
        }

        const judgeModel = config.judgeModel || DEFAULT_JUDGE_MODEL;
        const scoringCriteria = config.scoringCriteria || DEFAULT_SCORING_CRITERIA;
        const maxRules = config.maxRules || DEFAULT_MAX_RULES;

        const { system, user } = buildJudgePrompt({ agentId, output, rubric, scoringCriteria, maxRules });

        const adapterKey = config.adapter || DEFAULT_JUDGE_ADAPTER;
        const adapter = getAdapter(adapterKey);
        if (!adapter) {
            log('WARN', `evalJudge: adapter '${adapterKey}' not registered, skipping`);
            return null;
        }

        // Build envOverrides from settings.json so the judge subprocess
        // gets the same OAuth/API auth that invoke.ts gives regular agent
        // calls. Without this, the CLI adapter's `claude` subprocess has
        // no credentials and fails with 401, and the SDK adapter falls
        // back to (possibly missing) process.env.ANTHROPIC_API_KEY.
        const envOverrides: Record<string, string> = {};
        try {
            const settings = getSettings();
            const anthropicSettings = settings.models?.anthropic;
            if (anthropicSettings) {
                if (adapterKey === 'anthropic-sdk') {
                    if (anthropicSettings.api_key) {
                        envOverrides.ANTHROPIC_API_KEY = anthropicSettings.api_key;
                    }
                } else if (adapterKey === 'anthropic') {
                    if (anthropicSettings.oauth_token) {
                        envOverrides.CLAUDE_CODE_OAUTH_TOKEN = anthropicSettings.oauth_token;
                        envOverrides.ANTHROPIC_AUTH_TOKEN = '';
                        envOverrides.ANTHROPIC_API_KEY = '';
                    } else if (anthropicSettings.api_key) {
                        envOverrides.ANTHROPIC_API_KEY = anthropicSettings.api_key;
                    }
                }
            }
        } catch (e) {
            log('WARN', `evalJudge: getSettings() threw (non-fatal, judge may fail downstream): ${(e as Error).message}`);
        }

        const start = Date.now();
        let judgeText: string;
        try {
            judgeText = await adapter.invoke({
                agentId: `__judge_${agentId}`,
                message: user,
                workingDir: TINYAGI_HOME,
                systemPrompt: system,
                model: judgeModel,
                shouldReset: true,
                envOverrides,
            });
        } catch (e) {
            log('WARN', `evalJudge: judge adapter call failed for ${agentId}: ${(e as Error).message}`);
            return null;
        }
        const durationMs = Date.now() - start;

        const parsed = extractJudgeJson(judgeText);
        if (!parsed) {
            log('WARN', `evalJudge: judge returned unparseable output for ${agentId}: ${judgeText.slice(0, 200)}`);
            return null;
        }
        const validated = validateJudgeResponse(parsed);
        if (!validated) {
            log('WARN', `evalJudge: judge response failed schema validation for ${agentId}`);
            return null;
        }

        const judgment: Judgment = {
            agentId,
            passed: validated.violations.length === 0,
            violations: validated.violations,
            scores: validated.scores,
            notes: validated.notes,
            judgeModel,
            inputChars: user.length + system.length,
            outputChars: judgeText.length,
            durationMs,
        };

        try {
            const dbh = ensureDb();
            dbh.prepare(
                'INSERT INTO eval_judgments(agent_id, passed, violations_json, scores_json, notes, judge_model, ' +
                'input_chars, output_chars, duration_ms, message_id, channel) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
                agentId,
                judgment.passed ? 1 : 0,
                judgment.violations.length > 0 ? JSON.stringify(judgment.violations) : null,
                Object.keys(judgment.scores).length > 0 ? JSON.stringify(judgment.scores) : null,
                judgment.notes ?? null,
                judgment.judgeModel,
                judgment.inputChars,
                judgment.outputChars,
                judgment.durationMs,
                context?.messageId ?? null,
                context?.channel ?? null,
            );
        } catch (e) {
            log('WARN', `evalJudge: failed to persist judgment for ${agentId}: ${(e as Error).message}`);
        }

        if (!judgment.passed) {
            const summary = judgment.violations.slice(0, 3).map(v => `[${v.severity}] ${v.rule}`).join(' | ');
            log('WARN', `judge FAIL @${agentId}${context?.messageId ? ` msg=${context.messageId}` : ''}: ${summary}`);
        }

        return judgment;
    }, { agentId, source: 'evalJudge' });
}

/**
 * Fire-and-forget wrapper for use in latency-sensitive pipelines
 * (e.g. response.ts after enqueueResponse). The judgment runs in the
 * background; the caller does not await it.
 *
 * Rejected promises are caught and logged so they don't surface as
 * unhandled rejections.
 */
export function runJudgmentInBackground(
    agentId: string,
    output: string,
    context?: { messageId?: string; channel?: string }
): void {
    runJudgment(agentId, output, context).catch(e => {
        log('WARN', `evalJudge: background judgment threw (non-fatal): ${(e as Error).message}`);
    });
}

export function getJudgments(agentId?: string, limit: number = 50): JudgmentRecord[] {
    const dbh = ensureDb();
    const rows = agentId
        ? dbh.prepare(
              'SELECT id, agent_id, run_date, passed, violations_json, scores_json, notes, ' +
              'judge_model, input_chars, output_chars, duration_ms, message_id, channel ' +
              'FROM eval_judgments WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
          ).all(agentId, limit)
        : dbh.prepare(
              'SELECT id, agent_id, run_date, passed, violations_json, scores_json, notes, ' +
              'judge_model, input_chars, output_chars, duration_ms, message_id, channel ' +
              'FROM eval_judgments ORDER BY id DESC LIMIT ?'
          ).all(limit);

    return (rows as Array<{
        id: number; agent_id: string; run_date: string; passed: number;
        violations_json: string | null; scores_json: string | null; notes: string | null;
        judge_model: string | null; input_chars: number | null; output_chars: number | null;
        duration_ms: number | null; message_id: string | null; channel: string | null;
    }>).map(r => ({
        id: r.id,
        agentId: r.agent_id,
        runDate: r.run_date,
        passed: r.passed === 1,
        violations: r.violations_json ? JSON.parse(r.violations_json) : [],
        scores: r.scores_json ? JSON.parse(r.scores_json) : {},
        notes: r.notes ?? undefined,
        judgeModel: r.judge_model ?? 'unknown',
        inputChars: r.input_chars ?? 0,
        outputChars: r.output_chars ?? 0,
        durationMs: r.duration_ms ?? 0,
        messageId: r.message_id ?? undefined,
        channel: r.channel ?? undefined,
    }));
}

export function getJudgmentSummary(sinceIsoDate?: string): JudgmentSummary[] {
    const dbh = ensureDb();
    const baseSql = sinceIsoDate
        ? 'SELECT agent_id, passed, scores_json, run_date FROM eval_judgments WHERE run_date >= ?'
        : 'SELECT agent_id, passed, scores_json, run_date FROM eval_judgments';
    const rows = (sinceIsoDate
        ? dbh.prepare(baseSql).all(sinceIsoDate)
        : dbh.prepare(baseSql).all()
    ) as Array<{ agent_id: string; passed: number; scores_json: string | null; run_date: string }>;

    const byAgent = new Map<string, {
        total: number; passed: number; lastRun: string;
        scoreTotals: Record<string, { sum: number; count: number }>;
    }>();

    for (const r of rows) {
        let agg = byAgent.get(r.agent_id);
        if (!agg) {
            agg = { total: 0, passed: 0, lastRun: r.run_date, scoreTotals: {} };
            byAgent.set(r.agent_id, agg);
        }
        agg.total++;
        if (r.passed === 1) agg.passed++;
        if (r.run_date > agg.lastRun) agg.lastRun = r.run_date;
        if (r.scores_json) {
            try {
                const s = JSON.parse(r.scores_json) as Record<string, number>;
                for (const [k, v] of Object.entries(s)) {
                    if (typeof v === 'number') {
                        if (!agg.scoreTotals[k]) agg.scoreTotals[k] = { sum: 0, count: 0 };
                        agg.scoreTotals[k].sum += v;
                        agg.scoreTotals[k].count++;
                    }
                }
            } catch { /* skip */ }
        }
    }

    return Array.from(byAgent.entries()).map(([agentId, agg]) => {
        const avgScores: Record<string, number> = {};
        for (const [k, t] of Object.entries(agg.scoreTotals)) {
            avgScores[k] = t.count > 0 ? +(t.sum / t.count).toFixed(2) : 0;
        }
        return {
            agentId,
            total: agg.total,
            passed: agg.passed,
            failed: agg.total - agg.passed,
            passRate: agg.total > 0 ? +(agg.passed / agg.total).toFixed(3) : 0,
            avgScores,
            lastRun: agg.lastRun,
        };
    }).sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Convenience: build a rubric provider that reads rules from a SQLite
 * table. Useful for users who keep corrections in an external DB
 * (e.g. Kevin's mira-memory.db agent_learnings table).
 *
 * The query should return rows containing a single text column with the
 * rule text. `columnName` defaults to 'learning' (matches mira-memory),
 * but can be set to whatever the source uses.
 */
export function createSqliteRubricProvider(opts: {
    dbPath: string;
    query: string;
    columnName?: string;
    examples?: JudgmentRubric['examples'];
}): RubricProvider {
    return async (_agentId: string) => {
        const col = opts.columnName || 'learning';
        const srcDb = new Database(opts.dbPath, { readonly: true });
        try {
            const rows = srcDb.prepare(opts.query).all() as Array<Record<string, unknown>>;
            const rules = rows
                .map(r => r[col])
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
            return { rules, examples: opts.examples };
        } finally {
            srcDb.close();
        }
    };
}

export function closeJudgeDb(): void {
    if (db) { db.close(); db = null; }
}
