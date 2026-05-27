/**
 * End-to-end test for the eval harness, including the response.ts wiring.
 *
 * Verifies:
 *   1. defineEvalSpec persists and getEvalSpec retrieves
 *   2. runEval returns null when no spec exists (zero-overhead path)
 *   3. runEval passes a valid output and records a row
 *   4. runEval fails a bad output, lists all 3 failure classes
 *   5. The response.ts streamResponse pipeline auto-runs eval when a spec is registered
 *   6. streamResponse does NOT run eval when no spec is registered (no row written)
 *   7. getEvalSummary aggregates pass/fail correctly
 *   8. deleteEvalSpec disables the agent
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyagi-evals-'));
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'files'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'chats'), { recursive: true });
// settings.json — even an empty one — keeps config loader happy
fs.writeFileSync(path.join(tmpHome, 'settings.json'), '{}');
process.env.TINYAGI_HOME = tmpHome;

const {
    defineEvalSpec,
    getEvalSpec,
    deleteEvalSpec,
    runEval,
    getEvalRuns,
    getEvalSummary,
    closeEvalsDb,
    streamResponse,
    initQueueDb,
    closeQueueDb,
} = await import('../packages/core/dist/index.js');

// streamResponse needs the queue DB initialized — daemon does this at startup.
initQueueDb();

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

console.log('Test 1: defineEvalSpec + getEvalSpec roundtrip');
defineEvalSpec('briefing-agent', {
    requiredSections: ['ACT ON TODAY', 'WATCH'],
    bannedPatterns: ['I cannot', "I don't have access"],
    minLines: 5,
    maxLines: 100,
    notes: 'test spec',
});
const spec = getEvalSpec('briefing-agent');
assert(spec !== null, 'spec retrieved');
assert(spec.requiredSections.length === 2, 'requiredSections persisted');
assert(spec.minLines === 5 && spec.maxLines === 100, 'line bounds persisted');

console.log('Test 2: runEval is a no-op when no spec exists');
const r0 = runEval('unknown-agent', 'any output here', { messageId: 'm0' });
assert(r0 === null, 'returns null with no spec');
const noopRuns = getEvalRuns('unknown-agent');
assert(noopRuns.length === 0, 'no row written for unspec-ed agent');

console.log('Test 3: runEval passes a compliant output');
const goodOutput = [
    '# Briefing',
    '',
    '## ACT ON TODAY',
    '- Ship the eval harness',
    '- Verify nothing breaks',
    '',
    '## WATCH',
    '- The discord channel',
    '- Outstanding follow-ups',
].join('\n');
const r1 = runEval('briefing-agent', goodOutput, { messageId: 'm1', channel: 'slack' });
assert(r1 !== null && r1.passed === true, 'good output passes');
assert(r1.failures.length === 0, 'no failures');
assert(typeof r1.durationMs === 'number' && r1.durationMs >= 0, 'duration recorded');

console.log('Test 4: runEval catches all three failure classes');
const badOutput = "I cannot generate this briefing today.";
const r2 = runEval('briefing-agent', badOutput, { messageId: 'm2' });
assert(r2.passed === false, 'bad output fails');
const failureStr = r2.failures.join(' | ');
assert(/line_count 1 < min 5/.test(failureStr), 'caught line_count violation');
assert(/missing_section.*ACT ON TODAY/i.test(failureStr), 'caught missing_section ACT ON TODAY');
assert(/missing_section.*WATCH/i.test(failureStr), 'caught missing_section WATCH');
assert(/banned_pattern.*I cannot/i.test(failureStr), 'caught banned_pattern "I cannot"');

console.log('Test 5: streamResponse auto-fires eval when spec is registered');
// Pre-check: how many runs exist for briefing-agent right now?
const beforeRuns = getEvalRuns('briefing-agent').length;
await streamResponse(goodOutput, {
    channel: 'test-channel',
    sender: 'user',
    messageId: 'auto-1',
    originalMessage: 'morning briefing',
    agentId: 'briefing-agent',
});
const afterRuns = getEvalRuns('briefing-agent').length;
assert(afterRuns === beforeRuns + 1, `eval row written via streamResponse (before=${beforeRuns}, after=${afterRuns})`);
const latest = getEvalRuns('briefing-agent', 1)[0];
assert(latest.passed === true, 'auto-fired eval passed for good output');
assert(latest.messageId === 'auto-1', 'messageId propagated from streamResponse context');
assert(latest.channel === 'test-channel', 'channel propagated');

console.log('Test 6: streamResponse does NOT run eval for unspec-ed agents');
const before6 = getEvalRuns().length;
await streamResponse('any output here', {
    channel: 'test-channel',
    sender: 'user',
    messageId: 'auto-2',
    originalMessage: 'noop',
    agentId: 'no-spec-agent',
});
const after6 = getEvalRuns().length;
assert(after6 === before6, `no eval row written for unspec-ed agent (before=${before6}, after=${after6})`);

console.log('Test 7: getEvalSummary aggregates correctly');
const summary = getEvalSummary();
const briefingSum = summary.find(s => s.agentId === 'briefing-agent');
assert(briefingSum !== undefined, 'briefing-agent appears in summary');
assert(briefingSum.total >= 3, `total >= 3 (got ${briefingSum.total})`);
assert(briefingSum.passed >= 2 && briefingSum.failed >= 1, `mix of pass/fail (passed=${briefingSum.passed}, failed=${briefingSum.failed})`);
assert(briefingSum.passRate > 0 && briefingSum.passRate <= 1, 'passRate in (0, 1]');

console.log('Test 8: deleteEvalSpec disables the agent');
const deleted = deleteEvalSpec('briefing-agent');
assert(deleted === true, 'deleteEvalSpec returned true');
const r3 = runEval('briefing-agent', goodOutput);
assert(r3 === null, 'runEval is now a no-op for unspec-ed agent');

closeEvalsDb();
closeQueueDb();
console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
