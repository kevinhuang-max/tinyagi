/**
 * End-to-end test for the tracing module.
 *
 * Verifies:
 *   1. Tracing is OFF by default — startSpan returns null, no DB writes
 *   2. enableTracing() persists spans
 *   3. withSpan auto-completes a span on success
 *   4. withSpan marks status='error' on throw and rethrows
 *   5. Nested withSpan inherits traceId, sets parentId correctly
 *   6. AsyncLocalStorage propagation across awaited boundaries
 *   7. getTrace returns spans in start-time order
 *   8. listRecentTraces returns root spans with correct counts/durations
 *   9. streamResponse wraps the pipeline in a root trace when enabled
 *   10. streamResponse adds zero tracing rows when disabled
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyagi-tracing-'));
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'files'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'chats'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'settings.json'), '{}');
process.env.TINYAGI_HOME = tmpHome;
// Default OFF, the module reads env once at import time.
delete process.env.TINYAGI_TRACING;

const {
    startSpan, endSpan, withSpan, currentSpan,
    enableTracing, disableTracing, isTracingEnabled,
    getTrace, listRecentTraces, closeTracesDb,
    initQueueDb, closeQueueDb, streamResponse,
} = await import('../packages/core/dist/index.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

console.log('Test 1: tracing OFF by default — startSpan returns null');
assert(isTracingEnabled() === false, 'isTracingEnabled() false on import');
const nullSpan = startSpan('should-be-null');
assert(nullSpan === null, 'startSpan returns null when disabled');
endSpan(nullSpan, 'ok'); // should be safe to call with null

console.log('Test 2: withSpan disabled is a pass-through, no DB created');
const r1 = await withSpan('disabled', async () => 42);
assert(r1 === 42, 'withSpan still returns fn result when disabled');
assert(!fs.existsSync(path.join(tmpHome, 'traces.db')), 'traces.db NOT created when disabled');

console.log('Test 3: enable + startSpan/endSpan roundtrip');
enableTracing();
assert(isTracingEnabled() === true, 'isTracingEnabled() now true');
const s = startSpan('manual.test', { foo: 'bar' });
assert(s !== null, 'startSpan returns a span when enabled');
assert(typeof s.id === 'string' && s.id.length > 0, 'span has id');
assert(s.traceId === s.id || typeof s.traceId === 'string', 'span has traceId');
assert(s.parentId === undefined, 'top-level span has no parent');
endSpan(s, 'ok', { extra: 1 });
const all = getTrace(s.traceId);
assert(all.length === 1, 'one row persisted');
assert(all[0].name === 'manual.test', 'persisted name matches');
assert(all[0].attributes.foo === 'bar', 'persisted attributes include constructor attrs');
assert(all[0].attributes.extra === 1, 'persisted attributes include endSpan extras');
assert(all[0].status === 'ok', 'status ok');
assert(typeof all[0].endTime === 'number' && all[0].endTime >= all[0].startTime, 'endTime >= startTime');

console.log('Test 4: withSpan auto-completes on success');
const traceIdT4 = await withSpan('auto.success', async () => {
    return currentSpan().traceId;
});
const t4spans = getTrace(traceIdT4);
assert(t4spans.length === 1, 'one span persisted by withSpan');
assert(t4spans[0].status === 'ok', 'auto-completed with status=ok');

console.log('Test 5: withSpan marks error on throw and rethrows');
let threw = null;
let t5TraceId = null;
try {
    await withSpan('auto.fail', async () => {
        t5TraceId = currentSpan().traceId;
        throw new Error('intentional');
    });
} catch (e) { threw = e; }
assert(threw && threw.message === 'intentional', 'original error rethrown');
const t5spans = getTrace(t5TraceId);
assert(t5spans.length === 1, 'failed span still persisted');
assert(t5spans[0].status === 'error', 'status=error');
assert(t5spans[0].error === 'intentional', 'error message captured');

console.log('Test 6: nested withSpan inherits traceId, sets parentId');
let outerTraceId = null;
let outerId = null;
let innerId = null;
await withSpan('outer', async () => {
    const outer = currentSpan();
    outerTraceId = outer.traceId;
    outerId = outer.id;
    await withSpan('inner', async () => {
        const inner = currentSpan();
        innerId = inner.id;
        assert(inner.traceId === outerTraceId, 'inner inherits traceId');
        assert(inner.parentId === outerId, 'inner.parentId === outer.id');
    });
});
const nested = getTrace(outerTraceId);
assert(nested.length === 2, 'two spans persisted for nested trace');
const inner = nested.find(s => s.name === 'inner');
const outer = nested.find(s => s.name === 'outer');
assert(inner && outer, 'both spans present by name');
assert(inner.parentId === outer.id, 'parentId persisted correctly');

console.log('Test 7: AsyncLocalStorage propagates through awaited boundaries');
let propagatedTraceId = null;
await withSpan('parent', async () => {
    const tid = currentSpan().traceId;
    await new Promise(r => setTimeout(r, 5)); // force async boundary
    await withSpan('after-await', async () => {
        propagatedTraceId = currentSpan().traceId;
    });
    assert(propagatedTraceId === tid, 'traceId still set after setTimeout + nested withSpan');
});

console.log('Test 8: listRecentTraces returns root summaries with span counts');
const summaries = listRecentTraces(10);
assert(summaries.length >= 5, `got at least 5 trace summaries (got ${summaries.length})`);
const outerSummary = summaries.find(s => s.rootName === 'outer');
assert(outerSummary && outerSummary.spanCount === 2, 'outer trace summary has spanCount=2');
const failSummary = summaries.find(s => s.rootName === 'auto.fail');
assert(failSummary && failSummary.status === 'error', 'failed trace surfaces status=error');

console.log('Test 9: streamResponse wraps pipeline when tracing enabled');
initQueueDb();
const before9 = listRecentTraces(50).length;
await streamResponse('hello world from a test', {
    channel: 'test-channel',
    sender: 'tester',
    messageId: 'msg-9',
    originalMessage: 'ping',
    agentId: 'tracer-agent',
});
const after9 = listRecentTraces(50);
assert(after9.length === before9 + 1, `one new root trace from streamResponse (before=${before9}, after=${after9.length})`);
const newest = after9[0];
assert(newest.rootName === 'response.streamResponse', `root span name is response.streamResponse (got ${newest.rootName})`);
const newestSpans = getTrace(newest.traceId);
assert(newestSpans.some(s => s.name === 'response.runOutgoingHooks'), 'hooks child span present');
const rootSpan = newestSpans.find(s => s.name === 'response.streamResponse');
assert(rootSpan.attributes.agentId === 'tracer-agent', 'root span attributes include agentId');
assert(rootSpan.attributes.messageId === 'msg-9', 'root span attributes include messageId');

console.log('Test 10: streamResponse adds zero rows when tracing disabled');
disableTracing();
const before10 = listRecentTraces(100).length;
await streamResponse('disabled-mode response', {
    channel: 'test-channel',
    sender: 'tester',
    messageId: 'msg-10',
    originalMessage: 'ping',
    agentId: 'tracer-agent',
});
// Re-enable just to query; query is read-only
enableTracing();
const after10 = listRecentTraces(100).length;
assert(after10 === before10, `no new traces written when disabled (before=${before10}, after=${after10})`);

closeTracesDb();
closeQueueDb();
console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
