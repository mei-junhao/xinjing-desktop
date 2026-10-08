'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035';
const CONTRACT_ID = 'contract-v511-billing-store-cross-restart-hydration-final-binding-v2';
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const TASK_CARD_SHA256 = '7365394966F622C218F02515E5EBDDBBC22F171D8FDBE3C04281A8CFFA0BB06B';
const STORE_SHA256 = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';
const PROTECTED_MANIFEST_SHA256 = 'D52755D4AED2E9E8D8A4CFF316B3B5F8B2D937B33AA766523998006DAA8B336C';

const TASK33 = 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033';
const RUN33 = 'run-033-20260827041958-3ec36f2a3a4bc9';
const AGGREGATE33 = 'aa82b8b788c6f4c462bd8816e17f12ff25448167c9c1753f09c1e7a76d23f315';
const CARD33_SHA256 = 'D3AFF9699E94C371ABC8490750AC408833E558A8F6685499E28D1A63F1044D6B';
const FREEZE33_SHA256 = '22E6CB8942AD4F86AFB9E55DD58129A984DA9566BEF003F79CE1AE0DC1F9D13E';
const COMMON33_SHA256 = 'A5AB48C233F484CA494FBBF46BF7D0C2B349C563921660210E0951B8FA231BEB';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_ROOT = path.resolve(__dirname);
const SCRATCH_ROOT = path.resolve(PROJECT_ROOT, 'qa/task-scratch', TASK_ID);
const SCRIPTS33 = path.resolve(PROJECT_ROOT, 'scripts/v5.1.1-tests', TASK33);
const SCRATCH33 = path.resolve(PROJECT_ROOT, 'qa/task-scratch', TASK33);
const EVIDENCE33 = path.join(SCRATCH33, 'evidence', RUN33);
const CANDIDATE33 = path.join(SCRATCH33, 'candidate', RUN33);
const CLAIM33_PATH = path.join(SCRATCH33, 'EXECUTOR_CLAIM.json');
const LEASE33_PATH = path.join(SCRATCH33, 'LEASE.json');
const CARD33_PATH = path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks', TASK33 + '.md');
const CARD35_PATH = path.resolve(PROJECT_ROOT, 'docs/agent-coordination/v5.1.1/tasks', TASK_ID + '.md');
const STORE_PATH = path.resolve(PROJECT_ROOT, 'app/js/store.js');
const ORIGINAL_FREEZE_PATH = path.join(SCRIPTS33, 'freeze-verifier.js');
const ORIGINAL_COMMON_PATH = path.join(SCRIPTS33, 'common.js');
const HOOK_PATH = path.join(SCRIPT_ROOT, 'candidate-output-redirect-hook.js');

const ALLOWED_KINDS = new Set(['evidence-file', 'harness-source', 'freeze-self', 'candidate-file', 'card', 'store', 'protected-sha']);
const EXPECTED_FLAGS = { createdLocal: true, releaseReady: false, publishAuthorized: false, released: false };

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toLowerCase();
}
function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}
function bytesOf(filePath) {
  return fs.statSync(filePath).size;
}
function nowUtc() {
  return new Date().toISOString();
}
function randomNonce() {
  return crypto.randomBytes(7).toString('hex');
}
function makeRunId() {
  return 'run-035-' + nowUtc().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomNonce();
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + String.fromCharCode(10), 'utf8');
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function toForward(value) {
  return String(value).split(path.sep).join('/');
}

function canonicalAggregate(entries) {
  const sorted = entries.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return 0;
  });
  const input = sorted.map((entry) => ({ kind: entry.kind, label: entry.label, sha256: entry.sha256, bytes: entry.bytes }));
  return { aggregate: sha256Bytes(JSON.stringify(input)), input: input, sorted: sorted };
}

function walkFiles(dir, rel, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relPath = rel ? rel + '/' + name : name;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkFiles(abs, relPath, out);
    else if (stat.isFile()) out.push({ rel: relPath, sha256: sha256File(abs), bytes: stat.size });
  }
  return out;
}

function assertSafeLabel(label) {
  if (!label || typeof label !== 'string') throw new Error('label missing');
  if (label.includes('..')) throw new Error('label path escape: ' + label);
  if (path.isAbsolute(label)) throw new Error('label must be relative: ' + label);
  return label;
}

function assertContained(root, candidate) {
  const rootAbs = path.resolve(root);
  const candAbs = path.resolve(candidate);
  const rel = path.relative(rootAbs, candAbs);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error('path outside allowed root: ' + candAbs);
  }
  return candAbs;
}

function runChild(command, argv, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: opts.cwd || PROJECT_ROOT,
      env: Object.assign({}, process.env, opts.env || {}),
      shell: false,
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      stderr.push(Buffer.from(String((error && error.stack) || error)));
      resolve({ exitCode: -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.on('close', (code) => resolve({ exitCode: Number.isInteger(code) ? code : -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

function installSelfCapture(options) {
  const dir = ensureDir(path.join(options.root, 'self', options.toolName));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(stdoutPath, '');
  fs.writeFileSync(stderrPath, '');
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  let finalised = false;
  process.stdout.write = function captureStdout(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    fs.appendFileSync(stdoutPath, buffer);
    return originalStdout(chunk, encoding, callback);
  };
  process.stderr.write = function captureStderr(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    fs.appendFileSync(stderrPath, buffer);
    return originalStderr(chunk, encoding, callback);
  };
  return function finalizeSelf(exitCode, verdict) {
    if (finalised) return null;
    finalised = true;
    const endUtc = nowUtc();
    const meta = {
      taskId: TASK_ID,
      runId: options.runId,
      tool: options.toolName,
      command: process.execPath,
      argv: process.argv.slice(1),
      cwd: process.cwd(),
      startUtc: process.env.XJ_SELF_START_UTC || endUtc,
      endUtc: endUtc,
      exitCode: Number.isInteger(exitCode) ? exitCode : 0,
      verdict: verdict || (exitCode === 0 ? 'PASS' : 'FAIL'),
      stdoutPath: path.resolve(stdoutPath),
      stderrPath: path.resolve(stderrPath),
      metaPath: path.resolve(metaPath),
      stdoutSha256: sha256File(stdoutPath),
      stderrSha256: sha256File(stderrPath),
      stdoutBytes: bytesOf(stdoutPath),
      stderrBytes: bytesOf(stderrPath)
    };
    writeJson(metaPath, meta);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    return meta;
  };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

module.exports = {
  TASK_ID, CONTRACT_ID, BASE_COMMIT, TASK_CARD_SHA256, STORE_SHA256, PROTECTED_MANIFEST_SHA256,
  TASK33, RUN33, AGGREGATE33, CARD33_SHA256, FREEZE33_SHA256, COMMON33_SHA256,
  PROJECT_ROOT, SCRIPT_ROOT, SCRATCH_ROOT, SCRIPTS33, SCRATCH33, EVIDENCE33, CANDIDATE33, CLAIM33_PATH, LEASE33_PATH,
  CARD33_PATH, CARD35_PATH, STORE_PATH, ORIGINAL_FREEZE_PATH, ORIGINAL_COMMON_PATH, HOOK_PATH,
  ALLOWED_KINDS, EXPECTED_FLAGS,
  sha256Bytes, sha256File, bytesOf, nowUtc, randomNonce, makeRunId, ensureDir, writeJson, readJson, toForward,
  canonicalAggregate, walkFiles, assertSafeLabel, assertContained, runChild, installSelfCapture, argValue
};
