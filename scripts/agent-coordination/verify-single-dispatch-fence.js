#!/usr/bin/env node
'use strict';

// Verifies the three-way binding used before an external executor may create
// a task lease.  The claim is intentionally a create-new file so that a
// replay of the same task cannot become a second writer.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function fail(code, message) {
  process.stderr.write(`DISPATCH_FENCE_FAIL ${code}: ${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'claim') {
      options.claim = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function fromRoot(root, supplied) {
  const resolved = path.resolve(root, supplied);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`path escapes project root: ${supplied}`);
  return resolved;
}

function same(value, expected, label) {
  if (value !== expected) throw new Error(`${label} mismatch`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = ['task', 'fence', 'locks', 'card', 'scratch', 'nonce', 'idempotency-key'];
  required.forEach((name) => {
    if (!options[name]) throw new Error(`--${name} is required`);
  });
  if (options.claim && (!options.executor || !options['run-id'])) {
    throw new Error('--claim requires --executor and --run-id');
  }

  const root = process.cwd();
  const fenceFile = fromRoot(root, options.fence);
  const locksFile = fromRoot(root, options.locks);
  const cardFile = fromRoot(root, options.card);
  const scratchDir = fromRoot(root, options.scratch);
  const fence = readJson(fenceFile);
  const locks = readJson(locksFile);
  const lock = (locks.locks || []).find((entry) => entry.task_id === options.task);

  if (!lock) throw new Error('task lock is absent');
  same(fence.schema_version, 1, 'fence schema_version');
  same(fence.state, 'armed', 'fence state');
  same(fence.task_id, options.task, 'fence task_id');
  same(fence.task_card.path, path.relative(root, cardFile).replace(/\\/g, '/'), 'fence task-card path');
  same(fence.task_card.sha256, sha256(cardFile), 'fence task-card sha256');
  same(fence.dispatch.required_nonce, options.nonce, 'fence nonce');
  same(fence.dispatch.idempotency_key, options['idempotency-key'], 'fence idempotency key');
  if (typeof fence.dispatch.message_id !== 'string' || !fence.dispatch.message_id) {
    throw new Error('authoritative group-message ID is not recorded');
  }
  same(lock.state, 'granted', 'lock state');
  same(lock.authorization, 'granted-through-codex-single-dispatch-fence', 'lock authorization');
  same(lock.task_card_sha256, sha256(cardFile), 'lock task-card sha256');
  same(lock.dispatch.fence_path, path.relative(root, fenceFile).replace(/\\/g, '/'), 'lock fence path');
  same(lock.dispatch.fence_sha256, sha256(fenceFile), 'lock fence sha256');
  same(lock.dispatch.nonce, options.nonce, 'lock nonce');
  same(lock.dispatch.idempotency_key, options['idempotency-key'], 'lock idempotency key');
  same(lock.dispatch.message_id, fence.dispatch.message_id, 'lock group-message ID');
  same(lock.dispatch.execution_policy, 'one-claim-one-lease-create-new', 'lock execution policy');

  if (!options.claim) {
    process.stdout.write(JSON.stringify({ ok: true, mode: 'validate', task_id: options.task }) + '\n');
    return;
  }

  fs.mkdirSync(scratchDir, { recursive: true });
  const claim = path.join(scratchDir, 'EXECUTOR_CLAIM.json');
  const payload = {
    schema_version: 1,
    task_id: options.task,
    nonce: options.nonce,
    idempotency_key: options['idempotency-key'],
    executor: options.executor,
    run_id: options['run-id'],
    claimed_at_utc: new Date().toISOString(),
    lease_requirement: "create LEASE.json with fs.writeFileSync flag 'wx' only after this claim succeeds"
  };
  try {
    fs.writeFileSync(claim, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new Error('executor claim already exists; replay/second writer rejected');
    throw error;
  }
  process.stdout.write(JSON.stringify({ ok: true, mode: 'claimed', task_id: options.task, claim: path.relative(root, claim).replace(/\\/g, '/') }) + '\n');
}

try {
  main();
} catch (error) {
  fail('VALIDATION', error && error.message ? error.message : String(error));
}
