/**
 * End-to-end test for the LLM-as-judge layer.
 *
 * Uses setClaudeSdkClientFactory to inject a mock judge so we exercise
 * the full pipeline without hitting Anthropic.
 *
 * Verifies:
 *   1. defineJudgeConfig + getJudgeConfig roundtrip
 *   2. runJudgment is no-op when no config (zero overhead path)
 *   3. runJudgment is no-op when config.enabled = false
 *   4. runJudgment is no-op when no rubric provider registered
 *   5. runJudgment is no-op when rubric.rules is empty
 *   6. Valid judge response with no violations → passed=true
 *   7. Valid judge response with violations → passed=false, all parsed
 *   8. Severity defaults to "medium" if judge returns something invalid
 *   9. Fenced ```json wrapper tolerated (judge ignores no-fence rule)
 *   10. Unparseable judge output → null + WARN, no row persisted
 *   11. Bad schema (missing scores) still extracts what it can
 *   12. getJudgments and getJudgmentSummary return correct shapes
 *   13. streamResponse auto-fires judgment when configured (background)
 *   14. streamResponse does NOT fire judgment when not configured
 *   15. createSqliteRubricProvider reads from external SQLite DB
 *   16. Rubric provider that throws → graceful skip
 *   17. judgeModel from config used (not just default)
 *   18. deleteJudgeConfig disables the agent
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyagi-judge-'));
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'files'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'chats'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'settings.json'), '{}');
process.env.TINYAGI_HOME = tmpHome;

const {
    defineJudgeConfig, getJudgeConfig, deleteJudgeConfig,
    registerJudgeRubric, unregisterJudgeRubric,
    runJudgment, runJudgmentInBackground,
    getJudgments, getJudgmentSummary,
    createSqliteRubricProvider, closeJudgeDb,
    setClaudeSdkClientFactory,
    initQueueDb, closeQueueDb, streamResponse,
    DEFAULT_JUDGE_MODEL,
} = await import('../packages/core/dist/index.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

// ── Mock helpers ────────────────────────────────────────────────────────
let lastJudgeUserPrompt = null;
let lastJudgeSystemPrompt = null;
let lastJudgeModel = null;
function mockJudge(responseText) {
    setClaudeSdkClientFactory(() => ({
        messages: {
            create: async (args) => {
                lastJudgeModel = args.model;
                lastJudgeSystemPrompt = args.system;
                lastJudgeUserPrompt = args.messages[0].content;
                return { content: [{ type: 'text', text: responseText }] };
            },
            stream: () => { throw new Error('stream not used by judge'); },
        },
    }));
}

// Set a fake API key so claude-sdk adapter doesn't bail before reaching the mock client
process.env.ANTHROPIC_API_KEY = 'fake-test-key';

console.log('Test 1: defineJudgeConfig + getJudgeConfig roundtrip');
defineJudgeConfig('agent-a', { enabled: true, judgeModel: 'claude-haiku-4-5-20251001', scoringCriteria: ['x', 'y'], maxRules: 10 });
const cfg = getJudgeConfig('agent-a');
assert(cfg !== null && cfg.enabled === true, 'config persisted');
assert(cfg.judgeModel === 'claude-haiku-4-5-20251001', 'judgeModel persisted');
assert(cfg.scoringCriteria.length === 2, 'scoringCriteria persisted');

console.log('Test 2: no config → no-op');
mockJudge('should not be called');
const r2 = await runJudgment('agent-with-no-config', 'any output');
assert(r2 === null, 'returns null without config');
assert(getJudgments('agent-with-no-config').length === 0, 'no row written');

console.log('Test 3: disabled config → no-op');
defineJudgeConfig('agent-disabled', { enabled: false });
registerJudgeRubric('agent-disabled', async () => ({ rules: ['some rule'] }));
const r3 = await runJudgment('agent-disabled', 'any output');
assert(r3 === null, 'returns null when disabled');

console.log('Test 4: enabled but no rubric → no-op');
defineJudgeConfig('agent-no-rubric', { enabled: true });
// note: no registerJudgeRubric call for this agent
const r4 = await runJudgment('agent-no-rubric', 'any output');
assert(r4 === null, 'returns null when no rubric provider');

console.log('Test 5: enabled with empty rubric → no-op');
defineJudgeConfig('agent-empty-rubric', { enabled: true });
registerJudgeRubric('agent-empty-rubric', async () => ({ rules: [] }));
const r5 = await runJudgment('agent-empty-rubric', 'any output');
assert(r5 === null, 'returns null when rubric is empty');

console.log('Test 6: valid response, no violations → passed=true');
defineJudgeConfig('agent-a', { enabled: true });
registerJudgeRubric('agent-a', async () => ({
    rules: ['Lead with the point', 'Use plain language', 'Never say "I cannot"'],
}));
mockJudge(JSON.stringify({
    violations: [],
    scores: { ledWithPoint: 9, lengthAppropriate: 8, factualClaimsVerified: 10, toneMatches: 9 },
    notes: 'Clean response',
}));
const r6 = await runJudgment('agent-a', 'Direct answer.', { messageId: 'm6', channel: 'slack' });
assert(r6 !== null, 'judgment returned');
assert(r6.passed === true, 'passed=true with no violations');
assert(r6.violations.length === 0, 'violations array empty');
assert(r6.scores.ledWithPoint === 9, 'scores parsed');
assert(r6.notes === 'Clean response', 'notes parsed');
assert(typeof r6.durationMs === 'number' && r6.durationMs >= 0, 'duration recorded');
assert(lastJudgeUserPrompt.includes('Lead with the point'), 'rules included in prompt');
assert(lastJudgeUserPrompt.includes('Direct answer.'), 'output included in prompt');

console.log('Test 7: violations parsed correctly');
mockJudge(JSON.stringify({
    violations: [
        { rule: 'Lead with the point', quote: 'Sure! I can help with that.', severity: 'medium' },
        { rule: 'Never say "I cannot"', quote: 'I cannot do that today', severity: 'high' },
    ],
    scores: { ledWithPoint: 3, toneMatches: 5 },
}));
const r7 = await runJudgment('agent-a', 'Sure! I can help with that. I cannot do that today.', { messageId: 'm7' });
assert(r7.passed === false, 'passed=false with violations');
assert(r7.violations.length === 2, 'both violations captured');
assert(r7.violations[0].severity === 'medium', 'first severity preserved');
assert(r7.violations[1].severity === 'high', 'second severity preserved');
assert(r7.violations[1].quote === 'I cannot do that today', 'quote captured');

console.log('Test 8: invalid severity defaults to medium');
mockJudge(JSON.stringify({
    violations: [{ rule: 'A rule', quote: 'a quote', severity: 'CATASTROPHIC' }],
    scores: { ledWithPoint: 5 },
}));
const r8 = await runJudgment('agent-a', 'output');
assert(r8.violations[0].severity === 'medium', 'invalid severity coerced to medium');

console.log('Test 9: fenced ```json wrapper tolerated');
mockJudge('```json\n' + JSON.stringify({
    violations: [],
    scores: { ledWithPoint: 8 },
}) + '\n```');
const r9 = await runJudgment('agent-a', 'output');
assert(r9 !== null && r9.passed === true, 'fenced JSON parsed');
assert(r9.scores.ledWithPoint === 8, 'scores parsed from fenced JSON');

console.log('Test 10: unparseable output → null, WARN logged, no row persisted');
const beforeJ = getJudgments('agent-a').length;
mockJudge('garbage that is not json at all');
const r10 = await runJudgment('agent-a', 'output');
assert(r10 === null, 'unparseable judge response returns null');
const afterJ = getJudgments('agent-a').length;
assert(afterJ === beforeJ, 'no row written for unparseable response');

console.log('Test 11: missing scores field still works');
mockJudge(JSON.stringify({ violations: [], notes: 'ok' }));
const r11 = await runJudgment('agent-a', 'output');
assert(r11 !== null, 'judgment returned even without scores');
assert(Object.keys(r11.scores).length === 0, 'empty scores object');
assert(r11.passed === true, 'still passes if no violations');

console.log('Test 12: getJudgments + getJudgmentSummary');
const judgments = getJudgments('agent-a', 10);
assert(judgments.length >= 4, `judgments persisted (got ${judgments.length})`);
const summary = getJudgmentSummary();
const aSum = summary.find(s => s.agentId === 'agent-a');
assert(aSum !== undefined, 'agent-a in summary');
assert(aSum.total >= 4 && aSum.passed >= 1 && aSum.failed >= 1, 'summary has pass + fail mix');
assert(typeof aSum.passRate === 'number' && aSum.passRate >= 0 && aSum.passRate <= 1, 'passRate in [0, 1]');
assert(aSum.avgScores.ledWithPoint > 0, 'average scores computed');

console.log('Test 13: streamResponse auto-fires judgment when configured (background)');
initQueueDb();
const beforeS13 = getJudgments('agent-a').length;
mockJudge(JSON.stringify({
    violations: [],
    scores: { ledWithPoint: 10, lengthAppropriate: 10, factualClaimsVerified: 10, toneMatches: 10 },
    notes: 'auto-fired',
}));
await streamResponse('a response', {
    channel: 'test', sender: 'u', messageId: 'auto-13', originalMessage: 'q', agentId: 'agent-a',
});
// fire-and-forget — wait a tick for the background promise to settle
await new Promise(r => setTimeout(r, 100));
const afterS13 = getJudgments('agent-a').length;
assert(afterS13 === beforeS13 + 1, `streamResponse triggered judgment (before=${beforeS13}, after=${afterS13})`);
const latest = getJudgments('agent-a', 1)[0];
assert(latest.messageId === 'auto-13', 'messageId propagated');
assert(latest.channel === 'test', 'channel propagated');

console.log('Test 14: streamResponse does NOT fire judgment when not configured');
const beforeS14 = getJudgments().length;
mockJudge('should not be called');
await streamResponse('a response', {
    channel: 'test', sender: 'u', messageId: 'auto-14', originalMessage: 'q', agentId: 'agent-with-no-config-ever',
});
await new Promise(r => setTimeout(r, 50));
const afterS14 = getJudgments().length;
assert(afterS14 === beforeS14, `no judgment row for unconfigured agent (before=${beforeS14}, after=${afterS14})`);

console.log('Test 15: createSqliteRubricProvider reads from external DB');
// Build a fake mira-memory-style external DB
const extDbPath = path.join(tmpHome, 'external-rules.db');
const extDb = new Database(extDbPath);
extDb.exec("CREATE TABLE agent_learnings (id INTEGER PRIMARY KEY, learning TEXT, active INTEGER)");
extDb.exec("INSERT INTO agent_learnings(learning, active) VALUES ('Lead with the point', 1), ('Never use emdashes', 1), ('Inactive rule', 0)");
extDb.close();
const provider = createSqliteRubricProvider({
    dbPath: extDbPath,
    query: 'SELECT learning FROM agent_learnings WHERE active = 1',
});
const fetched = await provider('any-agent');
assert(fetched.rules.length === 2, `external provider returned 2 active rules (got ${fetched.rules.length})`);
assert(fetched.rules.includes('Lead with the point'), 'first rule returned');
assert(fetched.rules.includes('Never use emdashes'), 'second rule returned');
assert(!fetched.rules.includes('Inactive rule'), 'inactive rule filtered by query');

console.log('Test 15b: persistent rubricSource in config survives without in-memory provider');
// Use the same external DB built in Test 15
defineJudgeConfig('agent-with-persistent-rubric', {
    enabled: true,
    rubricSource: {
        type: 'sqlite',
        dbPath: extDbPath,
        query: 'SELECT learning FROM agent_learnings WHERE active = 1',
    },
});
// NB: deliberately NOT calling registerJudgeRubric — only config + rubricSource
mockJudge(JSON.stringify({
    violations: [],
    scores: { ledWithPoint: 8 },
    notes: 'persistent rubric',
}));
const r15b = await runJudgment('agent-with-persistent-rubric', 'response');
assert(r15b !== null, 'judgment runs using persistent rubricSource (no in-memory provider needed)');
assert(r15b.passed === true, 'passed with persistent rubric');

console.log('Test 15c: in-memory provider takes precedence over rubricSource when both set');
const memoryCalls = { count: 0 };
registerJudgeRubric('agent-with-persistent-rubric', async () => {
    memoryCalls.count++;
    return { rules: ['in-memory rule that the external DB does not have'] };
});
mockJudge(JSON.stringify({ violations: [], scores: { x: 7 } }));
await runJudgment('agent-with-persistent-rubric', 'response');
assert(memoryCalls.count === 1, 'in-memory provider was called (took precedence)');
assert(lastJudgeUserPrompt.includes('in-memory rule that the external DB does not have'), 'in-memory rule appeared in prompt');
unregisterJudgeRubric('agent-with-persistent-rubric');

console.log('Test 16: rubric provider that throws → graceful skip');
defineJudgeConfig('throwing-agent', { enabled: true });
registerJudgeRubric('throwing-agent', async () => { throw new Error('rubric source unavailable'); });
mockJudge('should not be called');
const r16 = await runJudgment('throwing-agent', 'output');
assert(r16 === null, 'returns null when provider throws');

console.log('Test 17: judgeModel from config used (not just default)');
defineJudgeConfig('model-test-agent', { enabled: true, judgeModel: 'claude-opus-4-7' });
registerJudgeRubric('model-test-agent', async () => ({ rules: ['some rule'] }));
mockJudge(JSON.stringify({ violations: [], scores: { x: 5 } }));
await runJudgment('model-test-agent', 'output');
assert(lastJudgeModel === 'claude-opus-4-7', `custom judgeModel passed to adapter (got ${lastJudgeModel})`);

console.log('Test 18: deleteJudgeConfig disables the agent');
defineJudgeConfig('agent-to-delete', { enabled: true });
registerJudgeRubric('agent-to-delete', async () => ({ rules: ['r'] }));
mockJudge(JSON.stringify({ violations: [], scores: { x: 5 } }));
const before18 = (await runJudgment('agent-to-delete', 'o'));
assert(before18 !== null, 'judgment runs while config exists');
const wasDeleted = deleteJudgeConfig('agent-to-delete');
assert(wasDeleted === true, 'deleteJudgeConfig returned true');
const after18 = await runJudgment('agent-to-delete', 'o');
assert(after18 === null, 'judgment skips after config deleted');

// Cleanup
setClaudeSdkClientFactory(null);
unregisterJudgeRubric('agent-a');
delete process.env.ANTHROPIC_API_KEY;
closeJudgeDb();
closeQueueDb();

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
