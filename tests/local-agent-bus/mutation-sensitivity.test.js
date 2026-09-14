'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SOURCE = path.resolve(__dirname, '..', '..', 'scripts', 'agent-queue.js');
const BEHAVIOR_TEST = path.resolve(__dirname, 'agent-queue.test.js');

function rejectMutation(t, name, anchor, replacement, testPattern) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xj-localbus-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const mutated = source.replace(anchor, replacement);
  assert.notEqual(mutated, source);
  const mutationFile = path.join(root, 'agent-queue-mutated.js');
  fs.writeFileSync(mutationFile, mutated, 'utf8');

  const childEnv = { ...process.env, XJ_AGENT_QUEUE_SCRIPT: mutationFile };
  delete childEnv.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, [
    '--test',
    `--test-name-pattern=${testPattern}`,
    BEHAVIOR_TEST,
  ], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 15_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0, `mutation was not rejected:\n${result.stdout}\n${result.stderr}`);
}

test('target-isolation mutation is rejected', (t) => {
  rejectMutation(
    t,
    'target',
    "if (task.target !== '*' && task.target !== agent) continue;",
    'if (false) continue;',
    'a consumer does not claim another agent task',
  );
});

test('idempotency mutation is rejected', (t) => {
  rejectMutation(
    t,
    'idempotency',
    'if (existing) {',
    'if (false && existing) {',
    'produce uses a caller idempotency key exactly once',
  );
});
