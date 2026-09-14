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
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021', 'origin-drift');
const RAW_DIR = path.join(SCRATCH, 'raw');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORKER = path.join(TEST_DIR, 'electron-worker.cjs');
const FIXTURE = path.join(TEST_DIR, 'fixture.html');
const STORE = path.join(ROOT, 'app', 'js', 'store.js');
const VALIDATORS = path.join(ROOT, 'app', 'js', 'clinical-task-validators.js');
const PORT_A = 19421;
const PORT_B = 19422;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function serverFor(port) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    const file = pathname === '/fixture.html' ? FIXTURE
      : pathname === '/app/js/clinical-task-validators.js' ? VALIDATORS
        : pathname === '/app/js/store.js' ? STORE : null;
    if (!file) { res.writeHead(404); res.end('Not Found'); return; }
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
}

function openServer(port) {
  const server = serverFor(port);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server); });
  });
}

function closeServer(server) {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).find((item) => item.startsWith('XJ_HYDRATION_RESULT:'));
  if (!line) return null;
  try { return JSON.parse(line.slice('XJ_HYDRATION_RESULT:'.length)); } catch (_) { return null; }
}

async function runPhase(label, mode, port, userData) {
  const origin = `http://127.0.0.1:${port}`;
  const started = new Date().toISOString();
  const child = childProcess.spawn(ELECTRON, ['--disable-gpu', '--disable-http-cache', `--user-data-dir=${userData}`, WORKER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { XJ_HYDRATION_USER_DATA: userData, XJ_HYDRATION_PORT: String(port), XJ_HYDRATION_MODE: mode, XJ_HYDRATION_PAGE: '/fixture.html', ELECTRON_ENABLE_LOGGING: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve({ code: null, signal: 'timeout' });
    }, 30000);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const stdoutPath = path.join(RAW_DIR, `${label}.stdout.txt`);
  const stderrPath = path.join(RAW_DIR, `${label}.stderr.txt`);
  const metaPath = path.join(RAW_DIR, `${label}.meta.json`);
  fs.writeFileSync(stdoutPath, stdout, 'utf8');
  fs.writeFileSync(stderrPath, stderr, 'utf8');
  const meta = {
    task_id: 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021', label, mode,
    started_utc: started, finished_utc: new Date().toISOString(),
    command: `${ELECTRON} --disable-gpu --disable-http-cache --user-data-dir=${userData} ${WORKER}`,
    cwd: ROOT, userData, origin, exit_code: exit.code, signal: exit.signal, result: parseResult(stdout),
    stdout: { path: stdoutPath, sha256: sha256(Buffer.from(stdout)), bytes: Buffer.byteLength(stdout, 'utf8') },
    stderr: { path: stderrPath, sha256: sha256(Buffer.from(stderr)), bytes: Buffer.byteLength(stderr, 'utf8') },
    store_sha256: sha256(fs.readFileSync(STORE)),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-021-origin-drift-'));
  let server;
  let first;
  let second;
  try {
    server = await openServer(PORT_A);
    first = await runPhase('origin-drift-01-write-19421', 'write', PORT_A, userData);
    await closeServer(server);
    server = await openServer(PORT_B);
    second = await runPhase('origin-drift-02-hydrate-19422', 'hydrate', PORT_B, userData);
    if (first.exit_code !== 0 || !first.result || first.result.ok !== true) throw new Error('origin A write did not pass');
    if (second.exit_code !== 0 || !second.result || second.result.clientCount !== 0 || second.result.sessionCount !== 0) throw new Error(`origin drift unexpectedly hydrated data: ${JSON.stringify(second.result)}`);
    const summary = {
      task_id: 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021',
      same_user_data: first.userData === second.userData,
      origin_a: first.origin,
      origin_b: second.origin,
      first_write: first,
      second_hydrate: second,
      observed: 'same userData with changed origin reads zero by IndexedDB origin isolation',
      completed_utc: new Date().toISOString(),
    };
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ same_user_data: summary.same_user_data, origin_a: summary.origin_a, origin_b: summary.origin_b, first_client_count: first.result.clientCount, second_client_count: second.result.clientCount, observed: summary.observed }, null, 2));
  } finally {
    if (server) await closeServer(server);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => { console.error('[FATAL] ' + (error && error.stack || error)); process.exitCode = 1; });
