'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      out.rest = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function requiredString(args, key) {
  const value = String(args[key] || '').trim();
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function writeUtf8(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

const args = parseArgs(process.argv);

try {
  const name = requiredString(args, 'name');
  const target = path.resolve(requiredString(args, 'target'));
  const cwd = path.resolve(requiredString(args, 'cwd'));
  const stdoutPath = path.resolve(requiredString(args, 'stdout'));
  const stderrPath = path.resolve(requiredString(args, 'stderr'));
  const metaPath = path.resolve(requiredString(args, 'meta'));
  const runId = requiredString(args, 'run-id');
  const nonce = requiredString(args, 'nonce');
  const targetArgs = args['target-args-json'] ? JSON.parse(String(args['target-args-json'])) : (args.rest || []);
  if (!Array.isArray(targetArgs) || targetArgs.some((entry) => typeof entry !== 'string')) {
    throw new Error('target args must be a string array');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('target script is missing');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd is missing');

  const startUtc = new Date().toISOString();
  const result = childProcess.spawnSync(process.execPath, [target, ...targetArgs], {
    cwd,
    encoding: null,
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024
  });
  let stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  let stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  if (result.error) stderr = Buffer.concat([stderr, Buffer.from(`${result.error.message}\n`, 'utf8')]);
  const endUtc = new Date().toISOString();
  const exitCode = Number.isInteger(result.status) ? result.status : -1;

  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  const meta = {
    schemaVersion: 'wrapper-meta-033-v1',
    name,
    wrapperPath: __filename,
    targetPath: target,
    command: process.execPath,
    argv: [target, ...targetArgs],
    cwd,
    startUtc,
    endUtc,
    exitCode,
    runId,
    nonce,
    stdoutPath,
    stdoutSha256: sha256(stdout),
    stdoutBytes: stdout.length,
    stderrPath,
    stderrSha256: sha256(stderr),
    stderrBytes: stderr.length
  };
  writeUtf8(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: exitCode === 0, name, exitCode, stdoutPath, stderrPath, metaPath })}\n`);
  process.exitCode = exitCode === 0 ? 0 : exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
