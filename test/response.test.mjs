import { handleLongResponse, LONG_RESPONSE_THRESHOLD } from '../packages/core/dist/response.js';
import fs from 'fs';
import path from 'path';

// Use a tmp FILES_DIR
process.env.TINYAGI_HOME = '/tmp/tinyagi-test-' + Date.now();
const filesDir = path.join(process.env.TINYAGI_HOME, 'files');
fs.mkdirSync(filesDir, { recursive: true });

let failed = 0;
let passed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  PASS', msg); } else { failed++; console.log('  FAIL', msg); } }

// Re-import after setting env (config caches via const at import time, but FILES_DIR is set at top of config.ts)
// To make this work we'll just pass paths via NODE
// NB: handleLongResponse uses FILES_DIR from config, which is computed at module load.
// For this test we set TINYAGI_HOME BEFORE importing — so we re-run via a spawn.

console.log('Test 1: short response passes through unchanged');
const r1 = handleLongResponse('hello world', []);
assert(r1.message === 'hello world', 'short body unchanged');
assert(r1.files.length === 0, 'no files added');

console.log('Test 2: long response is truncated and file attached');
const longBody = ('paragraph one.\n\nparagraph two.\n\n' + 'x'.repeat(LONG_RESPONSE_THRESHOLD + 500));
const r2 = handleLongResponse(longBody, [], { agentId: 'test-agent', channel: 'test-channel' });
assert(r2.message.length < longBody.length, 'preview is shorter than original');
assert(r2.message.includes(`${longBody.length} chars`), 'preview suffix shows full size');
assert(r2.files.length === 1, 'one file attached');
const savedPath = r2.files[0];
assert(fs.existsSync(savedPath), 'attached file exists on disk');
assert(fs.readFileSync(savedPath, 'utf8') === longBody, 'attached file contains FULL response (no data loss)');
assert(/response_test-agent_test-channel_\d+\.md$/.test(savedPath), 'filename includes agent + channel context');

console.log('Test 3: truncation lands on a natural boundary, not mid-word');
const proseBody = Array(200).fill('This is a sentence that ends with a period.').join(' ');
const r3 = handleLongResponse(proseBody + 'x'.repeat(2000), []);
const endsAtBoundary = /\.\s*$|\n$/.test(r3.message.split('\n\n_(Full response')[0]);
assert(endsAtBoundary, 'preview ends at sentence/line boundary, not mid-word');

console.log('Test 4: env override changes threshold');
process.env.TINYAGI_LONG_RESPONSE_THRESHOLD = '100';
const r4 = handleLongResponse('a'.repeat(150), []);
assert(r4.files.length === 1, 'env-overridden threshold triggers truncation');
delete process.env.TINYAGI_LONG_RESPONSE_THRESHOLD;

console.log('Test 5: legacy call signature (no context) still works');
const r5 = handleLongResponse('y'.repeat(LONG_RESPONSE_THRESHOLD + 100), []);
assert(/response_\d+\.md$/.test(r5.files[0]), 'legacy filename shape preserved when no context');

console.log('Test 6: invalid env value falls back to default, no crash');
process.env.TINYAGI_LONG_RESPONSE_THRESHOLD = 'not-a-number';
const r6 = handleLongResponse('z'.repeat(LONG_RESPONSE_THRESHOLD - 1), []);
assert(r6.files.length === 0, 'invalid env value falls back to default');
delete process.env.TINYAGI_LONG_RESPONSE_THRESHOLD;

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
