/**
 * End-to-end test for the structured-output envelope.
 *
 * Verifies:
 *   1. Valid envelope at start of message parses correctly
 *   2. Whitespace before the fence is tolerated
 *   3. Output without a fence returns null (fall back to regex)
 *   4. Mid-message JSON fence is NOT treated as envelope (must be at start)
 *   5. Invalid JSON inside fence returns null
 *   6. Non-object JSON (array, primitive) returns null
 *   7. Unknown fields in envelope are ignored
 *   8. Field type validation: bad route shape is filtered out
 *   9. extractEnvelopeOrText returns synthetic envelope for plain text
 *   10. serializeEnvelope roundtrips through parseAgentEnvelope
 *   11. getEnvelopeInstructions returns usable instruction text
 *   12. Existing regex parsing (legacy file tags) still works in parallel
 */
import {
    parseAgentEnvelope,
    extractEnvelopeOrText,
    serializeEnvelope,
    getEnvelopeInstructions,
    ENVELOPE_FENCE_OPEN,
    ENVELOPE_FENCE_CLOSE,
    collectFiles,
} from '../packages/core/dist/index.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

console.log('Test 1: valid envelope at start parses');
const out1 = '```json\n{"text":"hello","routes":[{"to":"@bob","body":"hi bob"}],"files":["/tmp/a.md"]}\n```';
const e1 = parseAgentEnvelope(out1);
assert(e1 !== null, 'envelope returned');
assert(e1.text === 'hello', 'text field');
assert(e1.routes.length === 1 && e1.routes[0].to === '@bob' && e1.routes[0].body === 'hi bob', 'routes field');
assert(e1.files.length === 1 && e1.files[0] === '/tmp/a.md', 'files field');

console.log('Test 2: leading whitespace before fence is tolerated');
const out2 = '   \n\n```json\n{"text":"ok"}\n```';
const e2 = parseAgentEnvelope(out2);
assert(e2 !== null && e2.text === 'ok', 'parsed despite leading whitespace');

console.log('Test 3: no fence → null (fall back to regex)');
assert(parseAgentEnvelope('just a plain text response') === null, 'plain text returns null');
assert(parseAgentEnvelope('[@bob: legacy regex routing here]') === null, 'legacy regex text returns null');
assert(parseAgentEnvelope('') === null, 'empty string returns null');

console.log('Test 4: mid-message JSON fence is NOT treated as envelope');
const out4 = 'Here is some output before the fence.\n\n```json\n{"text":"too late"}\n```';
assert(parseAgentEnvelope(out4) === null, 'envelope must be at start');

console.log('Test 5: invalid JSON inside fence → null');
assert(parseAgentEnvelope('```json\n{this is not valid json}\n```') === null, 'malformed JSON returns null');
assert(parseAgentEnvelope('```json\n\n```') === null, 'empty body returns null');

console.log('Test 6: non-object JSON → null');
assert(parseAgentEnvelope('```json\n["array","not","object"]\n```') === null, 'array returns null');
assert(parseAgentEnvelope('```json\n"just a string"\n```') === null, 'string returns null');
assert(parseAgentEnvelope('```json\n42\n```') === null, 'number returns null');

console.log('Test 7: unknown fields are ignored');
const out7 = '```json\n{"text":"hi","futureField":"ignored","weirdThing":{"x":1}}\n```';
const e7 = parseAgentEnvelope(out7);
assert(e7 !== null && e7.text === 'hi', 'known field preserved');
assert(e7.futureField === undefined, 'unknown field not exposed on envelope');

console.log('Test 8: bad route entries filtered, good ones kept');
const out8 = '```json\n{"routes":[{"to":"@a","body":"ok"},{"missing":"body"},{"to":"@b","body":"also ok"}]}\n```';
const e8 = parseAgentEnvelope(out8);
assert(e8 !== null, 'envelope parsed');
assert(e8.routes.length === 2, 'two valid routes retained');
assert(e8.routes[0].to === '@a' && e8.routes[1].to === '@b', 'order preserved');

console.log('Test 9: extractEnvelopeOrText synthesises envelope for plain text');
const r9a = extractEnvelopeOrText('just text');
assert(r9a.usedStructured === false, 'plain text marked as unstructured');
assert(r9a.envelope.text === 'just text', 'plain text becomes envelope.text');
const r9b = extractEnvelopeOrText('```json\n{"text":"structured"}\n```');
assert(r9b.usedStructured === true, 'envelope marked as structured');
assert(r9b.envelope.text === 'structured', 'structured text preserved');

console.log('Test 10: serializeEnvelope roundtrips');
const src = { text: 'hi', routes: [{ to: '@x', body: 'yo' }], files: ['/p'] };
const serialized = serializeEnvelope(src);
assert(serialized.startsWith(ENVELOPE_FENCE_OPEN), 'starts with json fence');
assert(serialized.endsWith(ENVELOPE_FENCE_CLOSE), 'ends with close fence');
const reparsed = parseAgentEnvelope(serialized);
assert(reparsed.text === src.text, 'roundtrip preserves text');
assert(reparsed.routes[0].to === src.routes[0].to, 'roundtrip preserves routes');
assert(reparsed.files[0] === src.files[0], 'roundtrip preserves files');

console.log('Test 11: getEnvelopeInstructions returns usable prompt text');
const instructions = getEnvelopeInstructions();
assert(typeof instructions === 'string' && instructions.length > 100, 'non-trivial length');
assert(instructions.includes('```json'), 'shows fence format');
assert(instructions.includes('@agent_id'), 'mentions agent routing');
assert(instructions.includes('#team_id'), 'mentions team routing');

console.log('Test 12: legacy [send_file: ...] regex still works in parallel');
// Sanity check that we did NOT break existing regex parsing — they coexist.
const fileSet = new Set();
collectFiles('See attached [send_file: /etc/hosts] for details', fileSet);
assert(fileSet.size === 1 && fileSet.has('/etc/hosts'), 'legacy regex collectFiles still functional');

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
