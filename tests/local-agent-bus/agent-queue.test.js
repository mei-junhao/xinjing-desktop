'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = process.env.XJ_AGENT_QUEUE_SCRIPT
  ? path.resolve(process.env.XJ_AGENT_QUEUE_SCRIPT)
  : path.resolve(__dirname, '..', '..', 'scripts', 'agent-queue.js');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-agent-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XJ_AGENT_QUEUE_ROOT: root, ...extraEnv },
    timeout: 10_000,
    windowsHide: true,
  });
}

function jsonFiles(root, state) {
  const dir = path.join(root, state);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function writeAdapter(root, source) {
  const adapter = path.join(root, 'adapter.js');
  fs.writeFileSync(adapter, source, 'utf8');
  return adapter;
}

test('produce uses a caller idempotency key exactly once', (t) => {
  const root = makeRoot(t);
  const args = ['produce', '--agent', 'A', '--action', 'synthetic', '--idempotency-key', 'task-key-1'];
  const first = run(root, args);
  const second = run(root, args);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(jsonFiles(root, 'pending').length, 1);
  assert.match(second.stdout, /existing/i);
});

test('a consumer does not claim another agent task', (t) => {
  const root = makeRoot(t);
  const produced = run(root, ['produce', '--agent', 'B', '--action', 'for B']);
  assert.equal(produced.status, 0, produced.stderr);
  const before = jsonFiles(root, 'pending');
  const adapter = writeAdapter(root, "process.stdout.write(JSON.stringify({status:'delivered'}));\n");

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.deepEqual(jsonFiles(root, 'pending'), before);
  assert.equal(jsonFiles(root, 'running').length, 0);
  assert.equal(jsonFiles(root, 'done').length, 0);
});

test('task content is data and is never evaluated by a shell', (t) => {
  const root = makeRoot(t);
  const marker = path.join(root, 'must-not-exist.txt');
  const malicious = `text & echo owned > "${marker}"`;
  const adapter = writeAdapter(root, [
    "const fs=require('node:fs');",
    "const i=process.argv.indexOf('--task-file');",
    "const task=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));",
    "process.stdout.write(JSON.stringify({status:'delivered',result:task.input}));",
  ].join('\n'));

  const produced = run(root, ['produce', '--agent', 'A', '--action', 'synthetic', '--input', malicious]);
  assert.equal(produced.status, 0, produced.stderr);
  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);

  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(jsonFiles(root, 'done').length, 1);
  const done = JSON.parse(fs.readFileSync(path.join(root, 'done', jsonFiles(root, 'done')[0]), 'utf8'));
  assert.equal(done.result, malicious);
});

test('an expired running lease is recovered and completed', (t) => {
  const root = makeRoot(t);
  for (const state of ['pending', 'running', 'done', 'failed', 'heartbeats', 'errors']) {
    fs.mkdirSync(path.join(root, state), { recursive: true });
  }
  const task = {
    schemaVersion: 1,
    id: 'expired-task',
    idempotencyKey: 'expired-task',
    target: 'A',
    action: 'recover me',
    input: '',
    status: 'running',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lease: { owner: 'A', expiresAt: '2026-01-01T00:00:01.000Z' },
  };
  fs.writeFileSync(path.join(root, 'running', 'expired-task.json'), JSON.stringify(task), 'utf8');
  const adapter = writeAdapter(root, "process.stdout.write(JSON.stringify({status:'delivered',result:'recovered'}));\n");

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(jsonFiles(root, 'running').length, 0);
  assert.equal(jsonFiles(root, 'done').length, 1);
});

test('a missing or relative adapter fails closed', (t) => {
  const root = makeRoot(t);
  const missing = run(root, ['consume', '--agent', 'A', '--adapter', 'adapter.js', '--once']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /absolute|adapter/i);
});

test('broadcast tasks are accepted and consumed by one agent', (t) => {
  const root = makeRoot(t);
  const adapter = writeAdapter(root, "process.stdout.write(JSON.stringify({status:'delivered',result:'broadcast'}));\n");
  const produced = run(root, ['produce', '--agent', '*', '--action', 'broadcast']);
  assert.equal(produced.status, 0, produced.stderr);

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(jsonFiles(root, 'done').length, 1);
});

test('invalid adapter output fails closed instead of becoming delivered', (t) => {
  const root = makeRoot(t);
  const adapter = writeAdapter(root, "process.stdout.write('not-json');\n");
  const produced = run(root, ['produce', '--agent', 'A', '--action', 'invalid output']);
  assert.equal(produced.status, 0, produced.stderr);

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once', '--max-retries', '1']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(jsonFiles(root, 'done').length, 0);
  assert.equal(jsonFiles(root, 'failed').length, 1);
  const failed = JSON.parse(fs.readFileSync(path.join(root, 'failed', jsonFiles(root, 'failed')[0]), 'utf8'));
  assert.equal(failed.lastErrorCode, 'ADAPTER_INVALID_OUTPUT');
});

test('adapter retries keep the same task file and stop at the limit', (t) => {
  const root = makeRoot(t);
  const adapter = writeAdapter(root, 'process.exitCode=7;\n');
  const produced = run(root, ['produce', '--agent', 'A', '--action', 'retry']);
  assert.equal(produced.status, 0, produced.stderr);
  const original = jsonFiles(root, 'pending')[0];

  const first = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once', '--max-retries', '2']);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(jsonFiles(root, 'pending'), [original]);

  const second = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once', '--max-retries', '2']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(jsonFiles(root, 'failed'), [original]);
  const failed = JSON.parse(fs.readFileSync(path.join(root, 'failed', original), 'utf8'));
  assert.equal(failed.attempts, 2);
  assert.equal(failed.lastErrorCode, 'ADAPTER_EXIT_7');
});

test('an active lease is not recovered or executed', (t) => {
  const root = makeRoot(t);
  for (const state of ['pending', 'running', 'done', 'failed', 'heartbeats', 'errors']) {
    fs.mkdirSync(path.join(root, state), { recursive: true });
  }
  const task = {
    schemaVersion: 1,
    id: 'active-task',
    idempotencyKey: 'active-task',
    target: 'A',
    action: 'leave me running',
    input: '',
    status: 'running',
    attempts: 1,
    createdAt: new Date().toISOString(),
    lease: { owner: 'A', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  fs.writeFileSync(path.join(root, 'running', 'active-task.json'), JSON.stringify(task), 'utf8');
  const adapter = writeAdapter(root, "process.stdout.write(JSON.stringify({status:'delivered'}));\n");

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(jsonFiles(root, 'running').length, 1);
  assert.equal(jsonFiles(root, 'done').length, 0);
});

test('a terminal twin prevents stale running task re-execution', (t) => {
  const root = makeRoot(t);
  for (const state of ['pending', 'running', 'done', 'failed', 'heartbeats', 'errors']) {
    fs.mkdirSync(path.join(root, state), { recursive: true });
  }
  const task = {
    schemaVersion: 1,
    id: 'terminal-twin',
    idempotencyKey: 'terminal-twin',
    target: 'A',
    action: 'must not execute twice',
    input: '',
    status: 'running',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lease: { owner: 'A', expiresAt: '2026-01-01T00:00:01.000Z' },
  };
  fs.writeFileSync(path.join(root, 'running', 'terminal-twin.json'), JSON.stringify(task), 'utf8');
  fs.writeFileSync(path.join(root, 'done', 'terminal-twin.json'), JSON.stringify({ ...task, status: 'done' }), 'utf8');
  const marker = path.join(root, 'adapter-ran.txt');
  const adapter = writeAdapter(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(JSON.stringify({status:'delivered'}));\n`);

  const consumed = run(root, ['consume', '--agent', 'A', '--adapter', adapter, '--once']);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(jsonFiles(root, 'running').length, 0);
  assert.equal(jsonFiles(root, 'done').length, 1);
  assert.equal(fs.existsSync(marker), false);
});
