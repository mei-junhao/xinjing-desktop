#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_ROOT = path.join(process.env.LOCALAPPDATA || process.cwd(), 'XinJing', 'agent-queue');
const QUEUE_ROOT = path.resolve(process.env.XJ_AGENT_QUEUE_ROOT || DEFAULT_ROOT);
const STATES = ['pending', 'running', 'done', 'failed', 'heartbeats', 'errors'];
const TASK_STATES = ['pending', 'running', 'done', 'failed'];
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ACTION_LENGTH = 16 * 1024;
const MAX_INPUT_LENGTH = 1024 * 1024;
const MAX_RESULT_LENGTH = 1024 * 1024;
const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RETRIES = 3;

function ensureQueue() {
  for (const state of STATES) {
    fs.mkdirSync(path.join(QUEUE_ROOT, state), { recursive: true });
  }
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function requireAgent(value) {
  if (typeof value !== 'string' || !AGENT_PATTERN.test(value)) {
    throw new Error('agent must match ' + AGENT_PATTERN);
  }
  return value;
}

function requireTarget(value) {
  if (value === '*') return value;
  return requireAgent(value);
}

function parseBoundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function makeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function atomicWriteJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}

function atomicMove(source, destination) {
  try {
    fs.renameSync(source, destination);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeTask(raw, filename) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('task must be an object');
  const fallbackId = path.basename(filename, '.json');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
  const target = requireTarget(raw.target);
  const action = typeof raw.action === 'string' ? raw.action : '';
  const input = typeof raw.input === 'string' ? raw.input : '';
  if (!action || action.length > MAX_ACTION_LENGTH) throw new Error('task action is missing or too long');
  if (input.length > MAX_INPUT_LENGTH) throw new Error('task input is too long');
  const idempotencyKey = typeof raw.idempotencyKey === 'string' && raw.idempotencyKey
    ? raw.idempotencyKey
    : id;
  if (idempotencyKey.length > 256) throw new Error('idempotency key is too long');
  return {
    ...raw,
    schemaVersion: 1,
    id,
    idempotencyKey,
    target,
    action,
    input,
    status: typeof raw.status === 'string' ? raw.status : 'pending',
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    createdAt: raw.createdAt || raw.created || new Date().toISOString(),
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
  };
}

function listJson(state) {
  const directory = path.join(QUEUE_ROOT, state);
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
}

function findExistingByIdempotencyKey(key) {
  for (const state of TASK_STATES) {
    for (const name of listJson(state)) {
      try {
        const task = normalizeTask(readJson(path.join(QUEUE_ROOT, state, name)), name);
        if (task.idempotencyKey === key) return { state, name, task };
      } catch (_) {}
    }
  }
  return null;
}

function produce(options) {
  const target = requireTarget(options.agent || '*');
  const action = typeof options.action === 'string' ? options.action : '';
  const input = typeof options.input === 'string' ? options.input : '';
  if (!action || action.length > MAX_ACTION_LENGTH) throw new Error('action is required and must be at most 16384 characters');
  if (input.length > MAX_INPUT_LENGTH) throw new Error('input must be at most 1048576 characters');
  const id = makeId();
  const idempotencyKey = typeof options['idempotency-key'] === 'string' && options['idempotency-key']
    ? options['idempotency-key']
    : id;
  if (idempotencyKey.length > 256) throw new Error('idempotency key is too long');

  const existing = findExistingByIdempotencyKey(idempotencyKey);
  if (existing) {
    console.log(`[queue] existing task ${existing.task.id} in ${existing.state}`);
    return existing.task.id;
  }

  const now = new Date().toISOString();
  const task = {
    schemaVersion: 1,
    id,
    idempotencyKey,
    target,
    action,
    input,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    source: options.source || 'local-coordinator',
  };
  atomicWriteJson(path.join(QUEUE_ROOT, 'pending', `${id}.json`), task);
  console.log(`[queue] created task ${id} for ${target}`);
  return id;
}

function validateAdapter(adapter) {
  if (typeof adapter !== 'string' || !path.isAbsolute(adapter)) {
    throw new Error('adapter must be an absolute JavaScript file path');
  }
  const resolved = path.resolve(adapter);
  if (path.extname(resolved).toLowerCase() !== '.js') throw new Error('adapter must be a JavaScript file');
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new Error('adapter file does not exist');
  return resolved;
}

function writeHeartbeat(agent, status, taskId = null, errorCode = null) {
  atomicWriteJson(path.join(QUEUE_ROOT, 'heartbeats', `${agent}.json`), {
    event: 'heartbeat',
    agentCode: agent,
    pid: process.pid,
    status,
    taskId,
    timestamp: new Date().toISOString(),
    errorCode,
  });
}

function recordError(agent, taskId, errorCode) {
  const event = {
    event: 'consumer_error',
    agentCode: agent,
    taskId: taskId || null,
    errorCode,
    timestamp: new Date().toISOString(),
  };
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  atomicWriteJson(path.join(QUEUE_ROOT, 'errors', name), event);
}

function recoverExpired(agent) {
  const now = Date.now();
  let recovered = 0;
  for (const name of listJson('running')) {
    const runningFile = path.join(QUEUE_ROOT, 'running', name);
    const doneFile = path.join(QUEUE_ROOT, 'done', name);
    const failedFile = path.join(QUEUE_ROOT, 'failed', name);
    if (fs.existsSync(doneFile) || fs.existsSync(failedFile)) {
      fs.unlinkSync(runningFile);
      recordError(agent, path.basename(name, '.json'), 'DUPLICATE_TERMINAL_RECONCILED');
      continue;
    }
    let task;
    try {
      task = normalizeTask(readJson(runningFile), name);
    } catch (_) {
      continue;
    }
    const lease = task.lease;
    if (!lease || lease.owner !== agent) continue;
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    const pendingFile = path.join(QUEUE_ROOT, 'pending', name);
    if (fs.existsSync(pendingFile)) {
      recordError(agent, task.id, 'RECOVERY_DESTINATION_EXISTS');
      continue;
    }
    task.status = 'pending';
    task.recoveredAt = new Date().toISOString();
    task.updatedAt = task.recoveredAt;
    delete task.lease;
    atomicWriteJson(runningFile, task);
    if (atomicMove(runningFile, pendingFile)) recovered += 1;
  }
  return recovered;
}

function parseAdapterOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('adapter output is empty');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('adapter output must be an object');
  if (!['delivered', 'blocked', 'rejected'].includes(parsed.status)) {
    throw new Error('adapter output has an unsupported status');
  }
  if (parsed.deliveryReport !== undefined && !path.isAbsolute(parsed.deliveryReport)) {
    throw new Error('deliveryReport must be absolute');
  }
  return {
    status: parsed.status,
    result: typeof parsed.result === 'string' ? parsed.result.slice(0, MAX_RESULT_LENGTH) : '',
    deliveryReport: parsed.deliveryReport,
    errorCode: typeof parsed.errorCode === 'string' ? parsed.errorCode.slice(0, 128) : undefined,
  };
}

function runAdapter(adapter, taskFile, timeoutMs, onHeartbeat) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [adapter, '--task-file', taskFile], {
      cwd: path.dirname(adapter),
      env: { ...process.env, XJ_AGENT_TASK_FILE: taskFile },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const heartbeat = setInterval(onHeartbeat, Math.min(10_000, Math.max(1_000, Math.floor(timeoutMs / 4))));
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, errorCode: 'ADAPTER_TIMEOUT' });
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve(result);
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_RESULT_LENGTH) stdout += chunk.toString('utf8').slice(0, MAX_RESULT_LENGTH - stdout.length);
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.on('error', () => finish({ ok: false, errorCode: 'ADAPTER_START_FAILED' }));
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        try {
          finish({ ok: true, output: parseAdapterOutput(stdout) });
        } catch (_) {
          finish({ ok: false, errorCode: 'ADAPTER_INVALID_OUTPUT' });
        }
      } else {
        finish({ ok: false, errorCode: signal ? 'ADAPTER_SIGNAL' : `ADAPTER_EXIT_${code}`, stderrBytes });
      }
    });
  });
}

function moveInvalidTask(name, agent, errorCode) {
  const source = path.join(QUEUE_ROOT, 'pending', name);
  let destination = path.join(QUEUE_ROOT, 'failed', name);
  if (fs.existsSync(destination)) destination = path.join(QUEUE_ROOT, 'failed', `${Date.now()}-${name}`);
  if (atomicMove(source, destination)) recordError(agent, path.basename(name, '.json'), errorCode);
}

async function consumeOne(agent, adapter, options) {
  for (const name of listJson('pending')) {
    const pendingFile = path.join(QUEUE_ROOT, 'pending', name);
    let task;
    try {
      task = normalizeTask(readJson(pendingFile), name);
    } catch (_) {
      moveInvalidTask(name, agent, 'INVALID_TASK');
      continue;
    }
    if (task.target !== '*' && task.target !== agent) continue;

    const runningFile = path.join(QUEUE_ROOT, 'running', name);
    if (!atomicMove(pendingFile, runningFile)) continue;
    const now = new Date();
    task.status = 'running';
    task.attempts += 1;
    task.receivedAt = task.receivedAt || now.toISOString();
    task.startedAt = now.toISOString();
    task.updatedAt = now.toISOString();
    task.lease = {
      owner: agent,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + options.leaseMs).toISOString(),
    };
    atomicWriteJson(runningFile, task);
    writeHeartbeat(agent, 'running', task.id);

    const execution = await runAdapter(adapter, runningFile, options.timeoutMs, () => {
      task.lease.expiresAt = new Date(Date.now() + options.leaseMs).toISOString();
      task.updatedAt = new Date().toISOString();
      atomicWriteJson(runningFile, task);
      writeHeartbeat(agent, 'running', task.id);
    });

    if (execution.ok && execution.output.status === 'delivered') {
      const completedAt = new Date().toISOString();
      task.status = 'done';
      task.result = execution.output.result;
      if (execution.output.deliveryReport) task.deliveryReport = execution.output.deliveryReport;
      task.completedAt = completedAt;
      task.updatedAt = completedAt;
      delete task.lease;
      atomicWriteJson(path.join(QUEUE_ROOT, 'done', name), task);
      fs.unlinkSync(runningFile);
      writeHeartbeat(agent, 'idle');
      console.log(`[queue] delivered task ${task.id}`);
      return true;
    }

    if (execution.ok && ['blocked', 'rejected'].includes(execution.output.status)) {
      task.status = execution.output.status;
      task.errorCode = execution.output.errorCode || execution.output.status.toUpperCase();
      task.updatedAt = new Date().toISOString();
      delete task.lease;
      atomicWriteJson(path.join(QUEUE_ROOT, 'failed', name), task);
      fs.unlinkSync(runningFile);
      recordError(agent, task.id, task.errorCode);
      writeHeartbeat(agent, execution.output.status, task.id, task.errorCode);
      return true;
    }

    const errorCode = execution.errorCode || 'ADAPTER_FAILED';
    task.lastErrorCode = errorCode;
    task.updatedAt = new Date().toISOString();
    recordError(agent, task.id, errorCode);
    if (task.attempts < options.maxRetries) {
      task.status = 'pending';
      task.lease.expiresAt = new Date(0).toISOString();
      atomicWriteJson(runningFile, task);
      if (!atomicMove(runningFile, pendingFile)) throw new Error('failed to requeue task');
      writeHeartbeat(agent, 'idle', null, errorCode);
      console.log(`[queue] requeued task ${task.id} after ${errorCode}`);
    } else {
      task.status = 'failed';
      task.failedAt = new Date().toISOString();
      delete task.lease;
      atomicWriteJson(path.join(QUEUE_ROOT, 'failed', name), task);
      fs.unlinkSync(runningFile);
      writeHeartbeat(agent, 'idle', null, errorCode);
      console.log(`[queue] failed task ${task.id} after ${task.attempts} attempts`);
    }
    return true;
  }
  writeHeartbeat(agent, 'idle');
  return false;
}

async function consume(options) {
  const agent = requireAgent(options.agent || process.env.AGENT_NAME);
  const adapter = validateAdapter(options.adapter);
  const config = {
    leaseMs: parseBoundedInteger(options['lease-ms'], DEFAULT_LEASE_MS, 5_000, 24 * 60 * 60 * 1000, 'lease-ms'),
    timeoutMs: parseBoundedInteger(options['timeout-ms'], DEFAULT_TIMEOUT_MS, 1_000, 24 * 60 * 60 * 1000, 'timeout-ms'),
    maxRetries: parseBoundedInteger(options['max-retries'], DEFAULT_RETRIES, 1, 10, 'max-retries'),
  };
  recoverExpired(agent);
  writeHeartbeat(agent, 'online');

  if (options.once) {
    await consumeOne(agent, adapter, config);
    return;
  }

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      recoverExpired(agent);
      while (await consumeOne(agent, adapter, config)) {}
    } catch (_) {
      recordError(agent, null, 'CONSUMER_TICK_FAILED');
      writeHeartbeat(agent, 'error', null, 'CONSUMER_TICK_FAILED');
    } finally {
      ticking = false;
    }
  };
  const watcher = fs.watch(path.join(QUEUE_ROOT, 'pending'), { persistent: true }, () => { void tick(); });
  const interval = setInterval(() => { void tick(); }, 3_000);
  const heartbeat = setInterval(() => {
    if (!ticking) writeHeartbeat(agent, 'idle');
  }, 10_000);
  const stop = () => {
    watcher.close();
    clearInterval(interval);
    clearInterval(heartbeat);
    writeHeartbeat(agent, 'stopping');
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`[queue] agent ${agent} watching ${path.join(QUEUE_ROOT, 'pending')}`);
  await tick();
}

function status(options) {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, listJson(state).length]));
  if (options.json) {
    console.log(JSON.stringify({ queueRoot: QUEUE_ROOT, counts }));
    return;
  }
  for (const state of TASK_STATES) console.log(`${state}: ${counts[state]}`);
}

function recover(options) {
  const agent = requireAgent(options.agent);
  const count = recoverExpired(agent);
  console.log(`[queue] recovered ${count} expired task(s) for ${agent}`);
}

function printHelp() {
  console.log('agent-queue.js - secure local agent task queue');
  console.log('  produce --agent <code> --action <text> [--input <text>] [--idempotency-key <key>]');
  console.log('  consume --agent <code> --adapter <absolute-js-path> [--once]');
  console.log('  recover --agent <code>');
  console.log('  status [--json]');
}

async function main() {
  ensureQueue();
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (command === 'produce') return produce(options);
  if (command === 'consume') return consume(options);
  if (command === 'recover') return recover(options);
  if (command === 'status') return status(options);
  printHelp();
  if (command) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[queue] fatal: ${error.message}`);
  process.exitCode = 1;
});
