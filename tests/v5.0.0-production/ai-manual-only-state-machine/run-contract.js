'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AI_SOURCE_PATH = path.resolve(__dirname, '../../../app/js/ai.js');

function buildRuntime(source, options) {
  const chatCalls = [];
  const primaryFails = !!(options && options.primaryFails);
  const primaryAborts = !!(options && options.primaryAborts);
  const primaryStreamsPartial = !!(options && options.primaryStreamsPartial);
  const primaryFailure = options && options.primaryFailure;
  const primaryThrow = options && options.primaryThrow;
  let chunkListener = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    URL,
    module: { exports: {} },
    exports: {},
    Store: {
      getSettings() {
        return {
          apiConfig: {
            apiKey: 'synthetic-user-key',
            baseUrl: 'https://provider.invalid',
            modelPreference: 'synthetic-model',
            verified: true,
          },
        };
      },
    },
  };
  sandbox.window = {
    __XJ_API__: {
      async aiRequest(payload) {
        if (payload.kind === 'quota') return { ok: true, headers: {}, bodyText: '{"percent":100,"tier":"v4-flash"}' };
        chatCalls.push({ isTrial: !!(payload.config && payload.config.isTrial), requestId: payload.requestId });
        if (primaryStreamsPartial && !payload.config.isTrial) {
          if (typeof chunkListener === 'function') {
            chunkListener({ requestId: payload.requestId, chunk: 'data: {"choices":[{"delta":{"content":"synthetic partial"}}]}\n\n' });
          }
          return { ok: false, status: 503, error: { code: 'XJ_AI_PROVIDER_HTTP', message: 'synthetic stream failure' } };
        }
        if (primaryThrow && !payload.config.isTrial) {
          const error = new Error(primaryThrow.message);
          error.code = primaryThrow.code;
          throw error;
        }
        if (primaryFailure && !payload.config.isTrial) return primaryFailure;
        if (primaryAborts && !payload.config.isTrial) {
          return { ok: false, error: { code: 'ABORT_ERR', message: 'synthetic cancellation' } };
        }
        if (primaryFails && !payload.config.isTrial) {
          return { ok: false, status: 503, error: { code: 'XJ_AI_PROVIDER_HTTP', message: 'synthetic primary failure' } };
        }
        return { ok: true, headers: {}, bodyText: '{"choices":[{"message":{"content":"synthetic response"}}]}' };
      },
      cancelAiRequest() {},
      onAiChunk(listener) { chunkListener = listener; return function () { chunkListener = null; }; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: AI_SOURCE_PATH });
  return { ai: sandbox.window.AI, chatCalls };
}

function send(ai, options) {
  return new Promise((resolve) => {
    ai.send([{ role: 'user', content: 'synthetic request' }], resolve, options);
  });
}

async function assertManualOnly(source) {
  const runtime = buildRuntime(source, { primaryFails: true });
  const result = await send(runtime.ai);
  assert.ok(result && result.error, 'primary failure must return a safe manual result');
  assert.strictEqual(result.transportState, 'manual-only', 'primary failure must enter manual-only');
  assert.strictEqual(runtime.chatCalls.length, 1, 'primary failure must not replay the request');
  assert.strictEqual(runtime.chatCalls[0].isTrial, false, 'the sole request must stay on the configured provider');
}

async function assertFailureManualOnly(source, label, options) {
  const runtime = buildRuntime(source, options);
  const result = await send(runtime.ai);
  assert.ok(result && result.error, label + ' must remain visible to the caller');
  assert.strictEqual(result.transportState, 'manual-only', label + ' must enter manual-only');
  assert.strictEqual(runtime.chatCalls.length, 1, label + ' must not replay the request');
  assert.strictEqual(runtime.chatCalls[0].isTrial, false, label + ' must not switch providers');
}

async function assertPrimaryReady(source) {
  const runtime = buildRuntime(source, { primaryFails: false });
  const result = await send(runtime.ai);
  assert.strictEqual(result.error, undefined, 'successful primary request must not be degraded');
  assert.strictEqual(result.transportState, 'primary-ready', 'successful request must report primary-ready');
  assert.strictEqual(runtime.chatCalls.length, 1, 'successful request must run once');
  assert.strictEqual(runtime.chatCalls[0].isTrial, false, 'successful request must use the configured provider');
}

async function assertCancellationDoesNotReplay(source) {
  const runtime = buildRuntime(source, { primaryAborts: true });
  const result = await send(runtime.ai);
  assert.ok(result && result.error, 'cancellation must remain visible');
  assert.strictEqual(result.transportState, 'manual-only', 'cancellation must not change transport state silently');
  assert.strictEqual(runtime.chatCalls.length, 1, 'cancellation must not replay the request');
}

async function assertPartialDoesNotReplay(source) {
  const runtime = buildRuntime(source, { primaryStreamsPartial: true });
  const result = await send(runtime.ai, { onDelta() {} });
  assert.ok(result && result.error, 'stream failure after a partial response must remain visible');
  assert.strictEqual(result.transportState, 'manual-only', 'partial stream failure must enter manual-only');
  assert.strictEqual(result.partialContent, 'synthetic partial', 'partial stream content must be retained locally');
  assert.strictEqual(runtime.chatCalls.length, 1, 'partial stream failure must not replay the request');
}

async function main() {
  const source = fs.readFileSync(AI_SOURCE_PATH, 'utf8');
  await assertPrimaryReady(source);
  await assertManualOnly(source);
  await assertFailureManualOnly(source, 'authentication failure', {
    primaryFailure: { ok: false, status: 401, error: { code: 'XJ_AI_AUTH_FAILED', message: 'synthetic auth failure' } },
  });
  await assertFailureManualOnly(source, 'rate-limit failure', {
    primaryFailure: { ok: false, status: 429, error: { code: 'XJ_AI_RATE_LIMIT', message: 'synthetic rate failure' } },
  });
  await assertFailureManualOnly(source, 'timeout failure', {
    primaryThrow: { code: 'XJ_AI_TIMEOUT', message: 'synthetic timeout' },
  });
  await assertCancellationDoesNotReplay(source);
  await assertPartialDoesNotReplay(source);
  console.log('PASS ai-manual-only-state-machine: primary-ready, manual-only, cancellation and partial-stream no-replay verified');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FAIL ai-manual-only-state-machine:', error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { assertManualOnly, assertFailureManualOnly, assertPrimaryReady, assertCancellationDoesNotReplay, assertPartialDoesNotReplay, AI_SOURCE_PATH };
