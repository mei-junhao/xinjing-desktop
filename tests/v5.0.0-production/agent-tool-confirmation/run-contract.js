'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AGENT_CORE_SOURCE_PATH = path.resolve(__dirname, '../../../app/js/agent-core.js');

function buildRuntime(source, kind) {
  let modelCalls = 0;
  let handlerCalls = 0;
  let confirmationCalls = 0;
  const schema = { function: { name: 'synthetic.tool', parameters: { type: 'object' } } };
  const sandbox = {
    console,
    Promise,
    Set,
    Date,
    Math,
    JSON,
    module: { exports: {} },
    exports: {},
    AI: {
      send(_messages, callback) {
        modelCalls += 1;
        if (modelCalls === 1) {
          callback({
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'synthetic-tool-call',
                  type: 'function',
                  function: { name: 'synthetic.tool', arguments: '{}' },
                }],
              },
            }],
          });
          return;
        }
        callback({ choices: [{ message: { role: 'assistant', content: 'synthetic complete' } }] });
      },
    },
    AgentTools: {
      TOOL_SCHEMAS: [schema],
      TOOL_REGISTRY: {
        'synthetic.tool': {
          ...(kind === undefined ? {} : { kind }),
          schema,
          async handler() {
            handlerCalls += 1;
            return { ok: true, data: { synthetic: true } };
          },
        },
      },
    },
  };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: AGENT_CORE_SOURCE_PATH });
  return {
    run(confirmDecision) {
      const confirm = typeof confirmDecision === 'function'
        ? async function (toolCall, args) {
          confirmationCalls += 1;
          return confirmDecision(toolCall, args);
        }
        : undefined;
      return sandbox.window.AgentCore.runRound([
        { role: 'system', content: 'synthetic system' },
        { role: 'user', content: 'synthetic request' },
      ], confirm);
    },
    get handlerCalls() { return handlerCalls; },
    get confirmationCalls() { return confirmationCalls; },
  };
}

async function assertReadSkipsConfirmation(source) {
  const runtime = buildRuntime(source, 'read');
  const result = await runtime.run();
  assert.strictEqual(result.reply, 'synthetic complete', 'read tool round must complete');
  assert.strictEqual(runtime.confirmationCalls, 0, 'read tool must not request confirmation');
  assert.strictEqual(runtime.handlerCalls, 1, 'read tool must execute once');
}

async function assertKindRequiresConfirmation(source, kind) {
  const runtime = buildRuntime(source, kind);
  await runtime.run(async function () { return { ok: false }; });
  assert.strictEqual(runtime.confirmationCalls, 1, String(kind) + ' must request confirmation');
  assert.strictEqual(runtime.handlerCalls, 0, String(kind) + ' must not execute after rejection');
}

async function assertMissingConfirmationFailsClosed(source, kind) {
  const runtime = buildRuntime(source, kind);
  await runtime.run();
  assert.strictEqual(runtime.confirmationCalls, 0, String(kind) + ' must not invent a confirmation');
  assert.strictEqual(runtime.handlerCalls, 0, String(kind) + ' must fail closed without a confirmation callback');
}

async function assertKindExecutesOnlyAfterConfirmation(source, kind) {
  const runtime = buildRuntime(source, kind);
  const result = await runtime.run(async function () { return { ok: true }; });
  assert.strictEqual(result.reply, 'synthetic complete', String(kind) + ' approved round must complete');
  assert.strictEqual(runtime.confirmationCalls, 1, String(kind) + ' must request confirmation before execution');
  assert.strictEqual(runtime.handlerCalls, 1, String(kind) + ' must execute exactly once after approval');
}

async function main() {
  const source = fs.readFileSync(AGENT_CORE_SOURCE_PATH, 'utf8');
  await assertReadSkipsConfirmation(source);
  await assertKindRequiresConfirmation(source, 'write');
  await assertKindRequiresConfirmation(source, 'write-light');
  await assertKindRequiresConfirmation(source, 'config');
  await assertKindRequiresConfirmation(source, undefined);
  await assertKindRequiresConfirmation(source, 'future-admin');
  await assertMissingConfirmationFailsClosed(source, 'config');
  await assertMissingConfirmationFailsClosed(source, 'write-light');
  await assertKindExecutesOnlyAfterConfirmation(source, 'config');
  await assertKindExecutesOnlyAfterConfirmation(source, 'write-light');
  console.log('PASS agent-tool-confirmation: only read bypasses confirmation; all non-read kinds fail closed');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('FAIL agent-tool-confirmation:', error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  AGENT_CORE_SOURCE_PATH,
  assertReadSkipsConfirmation,
  assertKindRequiresConfirmation,
  assertMissingConfirmationFailsClosed,
  assertKindExecutesOnlyAfterConfirmation,
};
