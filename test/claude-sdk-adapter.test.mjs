/**
 * End-to-end test for the claude-sdk adapter contract.
 *
 * Uses setClaudeSdkClientFactory to inject a mock client so we exercise
 * the adapter without hitting Anthropic's API or requiring the SDK
 * package to be installed.
 *
 * Verifies:
 *   1. Adapter registered under 'anthropic-sdk' (and NOT replacing 'anthropic')
 *   2. CLI adapter remains the one bound to 'anthropic' (no regression)
 *   3. Non-streaming invoke calls messages.create with correct shape
 *   4. Text extraction concatenates only text blocks (ignores tool_use, etc.)
 *   5. Streaming invoke calls messages.stream and surfaces text deltas via onEvent
 *   6. Missing API key without factory injection throws clear error
 *   7. envOverrides.ANTHROPIC_API_KEY takes precedence over process.env
 *   8. Adapter span emitted under tracing (root: adapter.claudeSdk.invoke)
 *   9. Default model used when opts.model is empty
 *   10. Streaming mode uses provided model
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyagi-sdk-'));
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'settings.json'), '{}');
process.env.TINYAGI_HOME = tmpHome;
process.env.TINYAGI_TRACING = '1'; // verify span emission

const {
    getAdapter,
    setClaudeSdkClientFactory,
    DEFAULT_CLAUDE_SDK_MAX_TOKENS,
    enableTracing,
    listRecentTraces,
    getTrace,
    closeTracesDb,
} = await import('../packages/core/dist/index.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  PASS', msg); }
    else { failed++; console.log('  FAIL', msg); }
}

enableTracing();

console.log('Test 1: adapter registered under anthropic-sdk');
const sdk = getAdapter('anthropic-sdk');
assert(sdk !== undefined, 'getAdapter("anthropic-sdk") returns the SDK adapter');
assert(sdk.providers.includes('anthropic-sdk'), 'providers array contains anthropic-sdk');

console.log('Test 2: CLI adapter still bound to anthropic — no regression');
const cli = getAdapter('anthropic');
assert(cli !== undefined, 'getAdapter("anthropic") still resolves to an adapter');
assert(cli !== sdk, 'CLI adapter is distinct from SDK adapter');

console.log('Test 3: non-streaming invoke calls messages.create with correct shape');
let captured = null;
setClaudeSdkClientFactory(({ apiKey }) => ({
    messages: {
        create: async (args) => {
            captured = { args, apiKey };
            return { content: [{ type: 'text', text: 'mock response from create' }] };
        },
        stream: () => { throw new Error('should not be called in non-streaming test'); },
    },
}));
const r3 = await sdk.invoke({
    agentId: 'sdk-test-agent',
    message: 'hello SDK',
    workingDir: tmpHome,
    systemPrompt: 'you are a test agent',
    model: 'claude-sonnet-4-5',
    shouldReset: false,
    envOverrides: { ANTHROPIC_API_KEY: 'fake-key-from-env-overrides' },
});
assert(r3 === 'mock response from create', `non-streaming returns text (got: ${JSON.stringify(r3)})`);
assert(captured && captured.args.model === 'claude-sonnet-4-5', 'model passed through');
assert(captured.args.system === 'you are a test agent', 'system prompt passed through');
assert(captured.args.max_tokens === DEFAULT_CLAUDE_SDK_MAX_TOKENS, 'default max_tokens used');
assert(captured.args.messages.length === 1 && captured.args.messages[0].role === 'user', 'user message wrapped');
assert(captured.args.messages[0].content === 'hello SDK', 'message content passed through');
assert(captured.apiKey === 'fake-key-from-env-overrides', 'envOverrides apiKey propagated to factory');

console.log('Test 4: text extraction ignores non-text blocks');
setClaudeSdkClientFactory(() => ({
    messages: {
        create: async () => ({
            content: [
                { type: 'text', text: 'part one' },
                { type: 'tool_use', name: 'some_tool' },
                { type: 'text', text: 'part two' },
                { type: 'unknown_kind', text: 'should be ignored' },
            ],
        }),
        stream: () => { throw new Error('not used'); },
    },
}));
const r4 = await sdk.invoke({
    agentId: 'extract-test', message: 'm', workingDir: tmpHome, systemPrompt: 's', model: 'claude-sonnet-4-5',
    shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'k' },
});
assert(r4 === 'part one\npart two', `only text blocks extracted, joined with newline (got: ${JSON.stringify(r4)})`);

console.log('Test 5: streaming surfaces deltas via onEvent');
const events = [];
setClaudeSdkClientFactory(() => ({
    messages: {
        create: async () => { throw new Error('should not be called in streaming test'); },
        stream: () => ({
            async *[Symbol.asyncIterator]() {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'stream ' } };
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk ' } };
                yield { type: 'message_stop' }; // unrelated event, should be ignored
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'end' } };
            },
            finalMessage: async () => ({ content: [{ type: 'text', text: 'stream chunk end' }] }),
        }),
    },
}));
const r5 = await sdk.invoke({
    agentId: 'stream-test', message: 'm', workingDir: tmpHome, systemPrompt: 's', model: 'claude-sonnet-4-5',
    shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'k' },
    onEvent: (text) => events.push(text),
});
assert(r5 === 'stream chunk end', `streaming returns concatenated deltas (got: ${JSON.stringify(r5)})`);
assert(events.length === 3, `onEvent called 3 times (got ${events.length})`);
assert(events.join('') === 'stream chunk end', 'onEvent received deltas in order');

console.log('Test 6: missing API key without factory throws clear error');
setClaudeSdkClientFactory(null); // revert to real lazy-load path
const prevKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
let threw6 = null;
try {
    await sdk.invoke({
        agentId: 'no-key-test', message: 'm', workingDir: tmpHome, systemPrompt: 's',
        model: 'claude-sonnet-4-5', shouldReset: false, envOverrides: {},
    });
} catch (e) { threw6 = e; }
assert(threw6 !== null, 'invoke without API key throws');
assert(/ANTHROPIC_API_KEY/.test(threw6.message), 'error message mentions ANTHROPIC_API_KEY');
if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;

console.log('Test 7: envOverrides.ANTHROPIC_API_KEY takes precedence over process.env');
let receivedKey = null;
setClaudeSdkClientFactory(({ apiKey }) => {
    receivedKey = apiKey;
    return {
        messages: {
            create: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            stream: () => { throw new Error('not used'); },
        },
    };
});
process.env.ANTHROPIC_API_KEY = 'process-env-key';
await sdk.invoke({
    agentId: 'precedence-test', message: 'm', workingDir: tmpHome, systemPrompt: 's', model: 'claude-sonnet-4-5',
    shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'override-key-wins' },
});
assert(receivedKey === 'override-key-wins', 'envOverrides apiKey takes precedence');
delete process.env.ANTHROPIC_API_KEY;

console.log('Test 8: invocation creates a tracing span');
setClaudeSdkClientFactory(() => ({
    messages: {
        create: async () => ({ content: [{ type: 'text', text: 'traced' }] }),
        stream: () => { throw new Error('not used'); },
    },
}));
const before = listRecentTraces(50).length;
await sdk.invoke({
    agentId: 'trace-test-agent', message: 'm', workingDir: tmpHome, systemPrompt: 's', model: 'claude-sonnet-4-5',
    shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'k' },
});
const after = listRecentTraces(50);
assert(after.length === before + 1, `new trace recorded (before=${before}, after=${after.length})`);
const newest = after[0];
assert(newest.rootName === 'adapter.claudeSdk.invoke', `root span name correct (got ${newest.rootName})`);
const newestSpans = getTrace(newest.traceId);
assert(newestSpans[0].attributes.agentId === 'trace-test-agent', `span carries agentId attribute (got ${JSON.stringify(newestSpans[0].attributes)})`);
assert(newestSpans[0].attributes.adapter === 'claude-sdk', 'span carries adapter attribute');

console.log('Test 9: default model used when opts.model empty');
let modelSeen = null;
setClaudeSdkClientFactory(() => ({
    messages: {
        create: async (args) => { modelSeen = args.model; return { content: [{ type: 'text', text: 'd' }] }; },
        stream: () => { throw new Error('not used'); },
    },
}));
await sdk.invoke({
    agentId: 'default-model', message: 'm', workingDir: tmpHome, systemPrompt: 's', model: '',
    shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'k' },
});
assert(modelSeen === 'claude-sonnet-4-5', `default model used when opts.model empty (got ${modelSeen})`);

console.log('Test 10: streaming uses provided model');
let streamModelSeen = null;
setClaudeSdkClientFactory(() => ({
    messages: {
        create: async () => { throw new Error('not used'); },
        stream: (args) => {
            streamModelSeen = args.model;
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };
                },
                finalMessage: async () => ({ content: [] }),
            };
        },
    },
}));
await sdk.invoke({
    agentId: 'stream-model', message: 'm', workingDir: tmpHome, systemPrompt: 's',
    model: 'claude-opus-4-5', shouldReset: false, envOverrides: { ANTHROPIC_API_KEY: 'k' },
    onEvent: () => {},
});
assert(streamModelSeen === 'claude-opus-4-5', `streaming uses provided model (got ${streamModelSeen})`);

setClaudeSdkClientFactory(null);
closeTracesDb();
console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
