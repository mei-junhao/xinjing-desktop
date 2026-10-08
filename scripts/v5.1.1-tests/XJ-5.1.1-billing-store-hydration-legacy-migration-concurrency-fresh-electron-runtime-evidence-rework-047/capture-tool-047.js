'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  ROOT,
  TASK,
  SCRATCH_ROOT,
  shaBytes,
  ensureDir,
  loadIdentity,
} = require('./common-047');

const identity = loadIdentity();
const target = String(process.argv[2] || '');
const label = String(process.argv[3] || path.basename(target, path.extname(target)));
const suffix = String(process.argv[4] || 'final');
if (!target) throw new Error('target script is required');
const targetPath = path.resolve(SCRATCH_ROOT, '..', '..', '..', 'scripts', 'v5.1.1-tests', path.basename(identity.scriptRoot), target);
const command = process.execPath;
const argv = [targetPath];
const selfDir = path.join(identity.selfRoot, label);
const safeSuffix = suffix ? `-${suffix.replace(/[^A-Za-z0-9._-]/g, '-')}` : '';
const targetEvidenceRoot = path.join(SCRATCH_ROOT, 'evidence', `${identity.runId}${safeSuffix}`);
ensureDir(selfDir);
const stdoutPath = path.join(selfDir, 'stdout.txt');
const stderrPath = path.join(selfDir, 'stderr.txt');
const startUtc = new Date().toISOString();
const env = { ...process.env, XJ_047_EVIDENCE_SUFFIX: suffix };
const child = cp.spawnSync(command, argv, { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const stdout = String(child.stdout || '');
const stderr = String(child.stderr || '');
fs.writeFileSync(stdoutPath, stdout, 'utf8');
fs.writeFileSync(stderrPath, stderr, 'utf8');
const endUtc = new Date().toISOString();
const exitCode = typeof child.status === 'number' ? child.status : 3;
const meta = {
  schema: 'xj-047-self-meta-v1',
  taskId: TASK,
  runId: identity.runId,
  runNonce: identity.runNonce,
  cardSha256: identity.cardSha256,
  storeSha256: identity.storeSha256,
  protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
  tool: label,
  command,
  argv,
  cwd: ROOT,
  startUtc,
  endUtc,
  exitCode,
  stdoutPath,
  stderrPath,
  stdoutSha256: shaBytes(Buffer.from(stdout, 'utf8')),
  stderrSha256: shaBytes(Buffer.from(stderr, 'utf8')),
  stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
  stderrBytes: Buffer.byteLength(stderr, 'utf8'),
  evidenceSuffix: suffix,
  evidenceRoot: targetEvidenceRoot,
};
fs.writeFileSync(path.join(selfDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({ tool: label, exitCode, stdoutPath, stderrPath, metaPath: path.join(selfDir, 'meta.json') }) + '\n');
process.exitCode = exitCode;
