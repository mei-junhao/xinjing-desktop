#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_DIR = __dirname;
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021');
const RAW_DIR = path.join(SCRATCH, 'raw');
const MUTATION_DIR = path.join(SCRATCH, 'mutations');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORKER = path.join(TEST_DIR, 'electron-worker.cjs');
const FIXTURE = path.join(TEST_DIR, 'fixture.html');
const STORE = path.join(ROOT, 'app', 'js', 'store.js');
const VALIDATORS = path.join(ROOT, 'app', 'js', 'clinical-task-validators.js');
const PORT = 19421;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let currentStorePath = STORE;
let server;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function safeLabel(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, '_'); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function serve(req, res) {
  const pathname = new URL(req.url, ORIGIN).pathname;
  let file;
  if (pathname === '/fixture.html') file = FIXTURE;
  else if (pathname === '/app/js/clinical-task-validators.js') file = VALIDATORS;
  else if (pathname === '/app/js/store.js') file = currentStorePath;
  else { res.writeHead(404); res.end('Not Found'); return; }
  let body;
  try { body = fs.readFileSync(file); } catch (error) { res.writeHead(500); res.end(String(error)); return; }
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function openServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(serve);
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer() {
  return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); });
}

function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).find((item) => item.startsWith('XJ_HYDRATION_RESULT:'));
  if (!line) return null;
  try { return JSON.parse(line.slice('XJ_HYDRATION_RESULT:'.length)); } catch (_) { return null; }
}

function commandText(mode, userData) {
  return [ELECTRON, '--disable-gpu', '--disable-http-cache', `--user-data-dir=${userData}`, WORKER].join(' ')
    + ` [XJ_HYDRATION_MODE=${mode}, XJ_HYDRATION_PORT=${PORT}]`;
}

async function runPhase(label, mode, userData, storePath) {
  currentStorePath = storePath || STORE;
  const started = new Date().toISOString();
  const args = ['--disable-gpu', '--disable-http-cache', `--user-data-dir=${userData}`, WORKER];
  const child = childProcess.spawn(ELECTRON, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      XJ_HYDRATION_USER_DATA: userData,
      XJ_HYDRATION_PORT: String(PORT),
      XJ_HYDRATION_MODE: mode,
      XJ_HYDRATION_PAGE: '/fixture.html',
      ELECTRON_ENABLE_LOGGING: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch (_) {}
      resolve({ code: null, signal: 'timeout' });
    }, 30000);
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const outBytes = Buffer.byteLength(stdout, 'utf8');
  const errBytes = Buffer.byteLength(stderr, 'utf8');
  const stamp = safeLabel(label);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const stdoutPath = path.join(RAW_DIR, `${stamp}.stdout.txt`);
  const stderrPath = path.join(RAW_DIR, `${stamp}.stderr.txt`);
  const metaPath = path.join(RAW_DIR, `${stamp}.meta.json`);
  fs.writeFileSync(stdoutPath, stdout, 'utf8');
  fs.writeFileSync(stderrPath, stderr, 'utf8');
  const meta = {
    task_id: 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021',
    label, mode, started_utc: started, finished_utc: new Date().toISOString(),
    command: commandText(mode, userData), cwd: ROOT, userData, origin: ORIGIN,
    exit_code: exit.code, signal: exit.signal, result: parseResult(stdout),
    stdout: { path: stdoutPath, sha256: sha256(Buffer.from(stdout)), bytes: outBytes },
    stderr: { path: stderrPath, sha256: sha256(Buffer.from(stderr)), bytes: errBytes },
    store_path: storePath || STORE,
    store_sha256: sha256(fs.readFileSync(storePath || STORE)),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}

async function runPositiveSuite() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-021-roundtrip-'));
  const phases = [];
  try {
    phases.push(await runPhase('positive-01-write', 'write', userData));
    phases.push(await runPhase('positive-02-restart-hydrate', 'hydrate', userData));
    const write = phases[0].result;
    const hydrate = phases[1].result;
    assert(phases[0].exit_code === 0 && write && write.ok === true, 'first durable write failed', JSON.stringify(phases[0]));
    assert(phases[1].exit_code === 0 && hydrate && hydrate.ok === true, 'restart hydrate failed', JSON.stringify(phases[1]));
    assert(hydrate.clientCount === 1 && hydrate.sessionCount === 1, 'cross-process collections did not hydrate', JSON.stringify(hydrate));
    assert(hydrate.clientIds.includes('c-xj021-synthetic') && hydrate.sessionIds.includes('s-xj021-synthetic'), 'cross-process IDs missing', JSON.stringify(hydrate));
    assert(hydrate.monthlyPayments.length === 1 && hydrate.monthlyPayments[0].id === 'mp-xj021-synthetic', 'monthlyPayments did not hydrate', JSON.stringify(hydrate));
    return { userData, phases, checks: ['durable-write', 'same-origin-restart', 'monthlyPayments'] };
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
}

async function runBehaviorSuite() {
  const cases = [
    ['behavior-roundtrip', 'roundtrip'],
    ['behavior-duplicate-hydrate', 'duplicate-hydrate'],
    ['behavior-legacy-migration', 'legacy'],
    ['behavior-fallback-read', 'fallback-read'],
    ['behavior-fail-closed-write', 'fail-closed-write'],
  ];
  const results = [];
  for (const [label, mode] of cases) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), `xj-021-${safeLabel(mode)}-`));
    try {
      const meta = await runPhase(label, mode, userData);
      const result = meta.result;
      assert(meta.exit_code === 0 && result && result.ok === true, `${mode} behavior failed`, JSON.stringify(meta));
      results.push({ label, mode, result });
    } finally {
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    }
  }
  const badUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-021-bad-'));
  try {
    const seed = await runPhase('behavior-bad-value-seed', 'seed-bad', badUserData);
    const hydrate = await runPhase('behavior-bad-value-hydrate', 'bad-value-hydrate', badUserData);
    assert(seed.exit_code === 0 && seed.result && seed.result.ok === true, 'bad-value seed failed', JSON.stringify(seed));
    assert(hydrate.exit_code === 0 && hydrate.result && hydrate.result.ok === true, 'bad-value hydrate failed', JSON.stringify(hydrate));
    results.push({ label: 'behavior-bad-value', seed: seed.result, hydrate: hydrate.result });
  } finally { try { fs.rmSync(badUserData, { recursive: true, force: true }); } catch (_) {} }
  return results;
}

function makeMutations(source) {
  return [
    { id: 'M01-wrong-db-name', find: "const req = indexedDB.open(DB_NAME, DB_VERSION);", replace: "const req = indexedDB.open(DB_NAME + '-mutant', DB_VERSION);" },
    { id: 'M02-wrong-store-name', find: "const STORE = 'kv';", replace: "const STORE = 'kv-mutant';" },
    { id: 'M03-wrong-read-key', find: "const r = tx.objectStore(STORE).get(key);", replace: "const r = tx.objectStore(STORE).get('__wrong_key__');" },
    { id: 'M04-skip-await-open', find: "const db = await getDB();", replace: "const db = getDB();" },
    { id: 'M05-swallow-read-error', find: "r.onerror = () => reject(r.error);", replace: "r.onerror = () => resolve(undefined);" },
    { id: 'M06-object-as-array', find: "cache.clients = Array.isArray(clients) ? clients : [];", replace: "cache.clients = clients || [];" },
    { id: 'M07-old-value-reuse', find: "      idbGet('clients'),", replace: "      Promise.resolve(cache.clients)," },
    { id: 'M08-cross-userdata', find: "const db = await getDB();", replace: "const db = await getDB();\n      if (typeof db.close === 'function') db.close();" },
  ].map((mutation) => {
    assert(source.includes(mutation.find), `mutation anchor missing ${mutation.id}`);
    const mutated = source.replace(mutation.find, mutation.replace);
    assert(mutated !== source, `mutation did not change source ${mutation.id}`);
    return Object.assign({}, mutation, { source: mutated });
  });
}

async function runMutationSuite() {
  const source = fs.readFileSync(STORE, 'utf8');
  const mutations = makeMutations(source);
  const all = [];
  for (const mutation of mutations) {
    const mutationDir = path.join(MUTATION_DIR, mutation.id);
    fs.mkdirSync(mutationDir, { recursive: true });
    const mutantPath = path.join(mutationDir, 'store.js');
    fs.writeFileSync(mutantPath, mutation.source, 'utf8');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), `xj-021-${safeLabel(mutation.id)}-`));
    try {
      const seedMode = mutation.id === 'M06-object-as-array' ? 'seed-bad' : 'write';
      const mutantMode = mutation.id === 'M05-swallow-read-error'
        ? 'read-error'
        : (mutation.id === 'M06-object-as-array' ? 'bad-value-hydrate' : 'hydrate');
      const restoreMode = mutation.id === 'M06-object-as-array' ? 'bad-value-hydrate' : 'hydrate';
      const baseline = await runPhase(`${mutation.id}-baseline`, seedMode, userData, STORE);
      const mutated = await runPhase(`${mutation.id}-mutated`, mutantMode, userData, mutantPath);
      const restore = await runPhase(`${mutation.id}-restore`, restoreMode, userData, STORE);
      const killed = mutation.id === 'M05-swallow-read-error'
        ? !(mutated.exit_code === 0 && mutated.result && mutated.result.ok === true && mutated.result.errorPropagated === true)
        : !(mutated.exit_code === 0 && mutated.result && mutated.result.ok === true && mutated.result.clientCount >= 1);
      assert(baseline.exit_code === 0 && baseline.result && baseline.result.ok === true, `${mutation.id} baseline did not pass`, JSON.stringify(baseline));
      assert(killed, `${mutation.id} expected-red survived`, JSON.stringify(mutated));
      assert(restore.exit_code === 0 && restore.result && restore.result.ok === true, `${mutation.id} restore did not pass`, JSON.stringify(restore));
      all.push({ id: mutation.id, baseline, mutated, restore, killed });
    } finally { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {} }
  }
  return all;
}

async function main() {
  assert(fs.existsSync(ELECTRON), 'Electron executable is absent', ELECTRON);
  assert(fs.existsSync(STORE) && fs.existsSync(VALIDATORS) && fs.existsSync(FIXTURE), 'fixture files are absent');
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(MUTATION_DIR, { recursive: true });
  await openServer();
  const summary = { task_id: 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021', origin: ORIGIN, fixed_port: PORT, production_store_sha256: sha256(fs.readFileSync(STORE)), positive: null, behavior: null, mutations: null };
  try {
    summary.positive = await runPositiveSuite();
    summary.behavior = await runBehaviorSuite();
    summary.mutations = await runMutationSuite();
  } finally {
    await closeServer();
  }
  summary.mutation_killed = summary.mutations.filter((item) => item.killed).length;
  summary.mutation_total = summary.mutations.length;
  summary.completed_utc = new Date().toISOString();
  fs.writeFileSync(path.join(SCRATCH, 'runtime-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ positive: summary.positive.checks, behavior: summary.behavior.length, mutation_killed: summary.mutation_killed, mutation_total: summary.mutation_total, origin: ORIGIN }, null, 2));
}

main().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack || error));
  process.exitCode = 1;
});
