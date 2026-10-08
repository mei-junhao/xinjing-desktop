'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033';
const CONTRACT_ID = 'contract-v511-billing-store-cross-restart-hydration-canonical-evidence-v1';
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const FIXED_ORIGIN = 'http://127.0.0.1:19503';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT_ROOT = path.resolve(__dirname);
const SCRATCH_ROOT = path.resolve(PROJECT_ROOT, 'qa/task-scratch', TASK_ID);
const ELECTRON_PATH = path.resolve(PROJECT_ROOT, 'node_modules/electron/dist/electron.exe');
const PROTECTED_FILES_MANIFEST_SHA256 = 'D52755D4AED2E9E8D8A4CFF316B3B5F8B2D937B33AA766523998006DAA8B336C';
const TASK_CARD_SHA256 = 'D3AFF9699E94C371ABC8490750AC408833E558A8F6685499E28D1A63F1044D6B';

const REQUIRED_META_KEYS = Object.freeze([
  'taskId', 'runId', 'caseId', 'stage', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode',
  'stdoutPath', 'stderrPath', 'metaPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes', 'verdict'
]);
const ALLOWED_VERDICTS = new Set(['PASS', 'REJECTED', 'FAIL', 'BLOCKED']);
const LEGACY_TASK_MARKERS = ['-021-', '-022-', '-023-', '-024-', '-025-', '-026-', '-027-', '-028-', '-029-', '-030-', '-031-', '-032-'];

function toForward(value) {
  return String(value).split(path.sep).join('/');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeUtf8(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function writeJson(filePath, value) {
  writeUtf8(filePath, JSON.stringify(value, null, 2) + String.fromCharCode(10));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function byteLength(filePath) {
  return fs.statSync(filePath).size;
}

function nowUtc() {
  return new Date().toISOString();
}

function randomNonce() {
  return crypto.randomBytes(7).toString('hex');
}

function makeRunId() {
  return 'run-033-' + nowUtc().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomNonce();
}

function isAbsolutePath(value) {
  return path.isAbsolute(String(value || '')) || /^[A-Za-z]:[\/]/.test(String(value || ''));
}

function hasLegacyPathMarker(candidate) {
  const normalized = toForward(candidate);
  return LEGACY_TASK_MARKERS.some((marker) => normalized.includes(marker));
}

function resolvedRelative(root, candidate) {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  const rel = path.relative(rootAbs, candidateAbs);
  if (!rel || rel === '' || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error('path outside evidence root: ' + candidateAbs);
  }
  return { rootAbs: rootAbs, candidateAbs: candidateAbs, rel: rel };
}

function realPathForContainment(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    return path.join(fs.realpathSync(parent), path.basename(filePath));
  }
}

function assertContained(root, candidate) {
  const check = resolvedRelative(root, candidate);
  const rootReal = realPathForContainment(check.rootAbs);
  const candidateReal = realPathForContainment(check.candidateAbs);
  const relReal = path.relative(rootReal, candidateReal);
  if (!relReal || relReal === '' || relReal.startsWith('..' + path.sep) || relReal === '..' || path.isAbsolute(relReal)) {
    throw new Error('realpath outside evidence root: ' + check.candidateAbs);
  }
  if (hasLegacyPathMarker(check.candidateAbs)) {
    throw new Error('legacy evidence path rejected: ' + check.candidateAbs);
  }
  return check.candidateAbs;
}

function assertFreshEvidencePath(root, candidate) {
  const abs = assertContained(root, candidate);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error('evidence path is not a file: ' + abs);
  }
  const rootAbs = path.resolve(root);
  let current = abs;
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('symbolic-link evidence path rejected: ' + current);
    if (path.resolve(current) === rootAbs) break;
    const parent = path.dirname(current);
    if (parent === current || path.relative(rootAbs, parent).startsWith('..' + path.sep)) {
      throw new Error('evidence path parent escaped root: ' + abs);
    }
    current = parent;
  }
  return abs;
}

function ensureFreshEvidenceRoot(root) {
  const abs = path.resolve(root);
  const scratch = path.resolve(SCRATCH_ROOT);
  const rel = path.relative(scratch, abs);
  if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('run root must be under task scratch: ' + abs);
  }
  if (hasLegacyPathMarker(abs)) {
    throw new Error('legacy run root rejected: ' + abs);
  }
  ensureDir(abs);
  return abs;
}

function stageDir(root, caseId, stage) {
  if (!/^[A-Za-z0-9._-]+$/.test(caseId) || !/^[A-Za-z0-9._-]+$/.test(stage)) {
    throw new Error('unsafe case/stage identifier');
  }
  return ensureDir(path.join(root, 'cases', caseId, stage));
}

function makeMeta(options) {
  const meta = {
    taskId: String(options.taskId || TASK_ID),
    runId: String(options.runId),
    caseId: String(options.caseId),
    stage: String(options.stage),
    command: String(options.command),
    argv: Array.isArray(options.argv) ? options.argv.map(String) : [],
    cwd: path.resolve(options.cwd),
    startUtc: String(options.startUtc),
    endUtc: String(options.endUtc),
    exitCode: Number.isInteger(options.exitCode) ? options.exitCode : -1,
    stdoutPath: path.resolve(options.stdoutPath),
    stderrPath: path.resolve(options.stderrPath),
    metaPath: path.resolve(options.metaPath),
    stdoutSha256: sha256File(options.stdoutPath),
    stderrSha256: sha256File(options.stderrPath),
    stdoutBytes: byteLength(options.stdoutPath),
    stderrBytes: byteLength(options.stderrPath),
    verdict: String(options.verdict)
  };
  return meta;
}

function assertMetaShape(meta, evidenceRoot, expected) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta must be an object');
  const keys = Object.keys(meta).sort();
  const expectedKeys = REQUIRED_META_KEYS.slice().sort();
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
    throw new Error('meta has unknown or missing fields');
  }
  if (meta.taskId !== TASK_ID) throw new Error('meta taskId is not the 033 task');
  for (const key of ['runId', 'caseId', 'stage', 'command', 'cwd', 'startUtc', 'endUtc', 'stdoutPath', 'stderrPath', 'metaPath', 'stdoutSha256', 'stderrSha256', 'verdict']) {
    if (typeof meta[key] !== 'string' || !meta[key]) throw new Error('meta field invalid: ' + key);
  }
  if (!Array.isArray(meta.argv) || meta.argv.some((value) => typeof value !== 'string')) throw new Error('meta argv invalid');
  if (!isAbsolutePath(meta.cwd) || path.resolve(meta.cwd) !== meta.cwd) throw new Error('meta cwd must be absolute');
  if (!Number.isInteger(meta.exitCode)) throw new Error('meta exitCode must be an integer');
  if (!Number.isInteger(meta.stdoutBytes) || meta.stdoutBytes < 0 || !Number.isInteger(meta.stderrBytes) || meta.stderrBytes < 0) {
    throw new Error('meta byte count invalid');
  }
  if (!/^[a-f0-9]{64}$/i.test(meta.stdoutSha256) || !/^[a-f0-9]{64}$/i.test(meta.stderrSha256)) {
    throw new Error('meta sha256 invalid');
  }
  if (!ALLOWED_VERDICTS.has(meta.verdict)) throw new Error('meta verdict invalid');
  const start = Date.parse(meta.startUtc);
  const end = Date.parse(meta.endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 60000) throw new Error('meta timestamp invalid');
  const stdoutPath = assertFreshEvidencePath(evidenceRoot, meta.stdoutPath);
  const stderrPath = assertFreshEvidencePath(evidenceRoot, meta.stderrPath);
  const metaPath = assertFreshEvidencePath(evidenceRoot, meta.metaPath);
  if (stdoutPath === stderrPath || stdoutPath === metaPath || stderrPath === metaPath) throw new Error('stdout/stderr/meta paths must differ');
  if (meta.stdoutBytes !== byteLength(stdoutPath) || meta.stderrBytes !== byteLength(stderrPath)) throw new Error('meta byte count mismatch');
  if (meta.stdoutSha256.toLowerCase() !== sha256File(stdoutPath) || meta.stderrSha256.toLowerCase() !== sha256File(stderrPath)) {
    throw new Error('meta sha256 mismatch');
  }
  if (expected) {
    if (expected.runId && meta.runId !== expected.runId) throw new Error('meta runId mismatch');
    if (expected.caseId && meta.caseId !== expected.caseId) throw new Error('meta caseId mismatch');
    if (expected.stage && meta.stage !== expected.stage) throw new Error('meta stage mismatch');
  }
  return true;
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
      resolve({ exitCode: -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error: error });
    });
    child.on('close', (code) => resolve({ exitCode: Number.isInteger(code) ? code : -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

async function runAndCapture(options) {
  const dir = stageDir(options.root, options.caseId, options.stage);
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const metaPath = path.join(dir, 'meta.json');
  const startUtc = nowUtc();
  const result = await runChild(options.command, options.argv, { cwd: options.cwd, env: options.env });
  const endUtc = nowUtc();
  fs.writeFileSync(stdoutPath, result.stdout);
  fs.writeFileSync(stderrPath, result.stderr);
  const verdict = result.exitCode === 0 ? (options.verdictOnZero || 'PASS') : (options.verdictOnNonZero || 'FAIL');
  const meta = makeMeta({
    taskId: TASK_ID, runId: options.runId, caseId: options.caseId, stage: options.stage,
    command: options.command, argv: options.argv, cwd: options.cwd, startUtc: startUtc, endUtc: endUtc,
    exitCode: result.exitCode, stdoutPath: stdoutPath, stderrPath: stderrPath, metaPath: metaPath, verdict: verdict
  });
  writeJson(metaPath, meta);
  return { result: result, meta: meta, dir: dir, stdoutPath: stdoutPath, stderrPath: stderrPath, metaPath: metaPath };
}

function installSelfCapture(options) {
  const dir = ensureDir(path.join(options.root, 'self', options.toolName));
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(stdoutPath, '');
  fs.writeFileSync(stderrPath, '');
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let finalised = false;
  process.stdout.write = function captureStdout(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    fs.appendFileSync(stdoutPath, buffer);
    return originalStdoutWrite(chunk, encoding, callback);
  };
  process.stderr.write = function captureStderr(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    fs.appendFileSync(stderrPath, buffer);
    return originalStderrWrite(chunk, encoding, callback);
  };
  return function finalizeSelf(exitCode, verdict) {
    if (finalised) return null;
    finalised = true;
    const endUtc = nowUtc();
    const meta = makeMeta({
      taskId: TASK_ID, runId: options.runId, caseId: '__self__', stage: options.toolName,
      command: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(),
      startUtc: process.env.XJ_SELF_START_UTC || endUtc, endUtc: endUtc,
      exitCode: Number.isInteger(exitCode) ? exitCode : 0,
      stdoutPath: stdoutPath, stderrPath: stderrPath, metaPath: metaPath,
      verdict: verdict || (exitCode === 0 ? 'PASS' : 'FAIL')
    });
    writeJson(metaPath, meta);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    return meta;
  };
}

function parseJsonLines(text) {
  const values = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { values.push(JSON.parse(trimmed)); } catch (error) {}
  }
  return values;
}

function lastJsonLine(text, type) {
  const values = parseJsonLines(text).filter((value) => !type || value.type === type);
  return values.length ? values[values.length - 1] : null;
}

module.exports = {
  TASK_ID, CONTRACT_ID, BASE_COMMIT, FIXED_ORIGIN, PROJECT_ROOT, SCRIPT_ROOT, SCRATCH_ROOT, ELECTRON_PATH,
  PROTECTED_FILES_MANIFEST_SHA256, TASK_CARD_SHA256, REQUIRED_META_KEYS, ALLOWED_VERDICTS,
  toForward, ensureDir, writeUtf8, writeJson, readJson, sha256Bytes, sha256File, byteLength, nowUtc, randomNonce, makeRunId,
  isAbsolutePath, hasLegacyPathMarker, resolvedRelative, realPathForContainment, assertContained, assertFreshEvidencePath,
  ensureFreshEvidenceRoot, stageDir, makeMeta, assertMetaShape, runChild, runAndCapture, installSelfCapture,
  parseJsonLines, lastJsonLine
};
