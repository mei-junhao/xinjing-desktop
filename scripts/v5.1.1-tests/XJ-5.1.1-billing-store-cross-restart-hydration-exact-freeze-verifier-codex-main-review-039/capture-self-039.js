'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseArgs() {
  const out = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1]; i += 1; }
  }
  return out;
}

function capture(toolName, command, argv, outDir, expectedExit) {
  fs.mkdirSync(outDir, { recursive: true });
  const stdoutPath = path.join(outDir, 'stdout.txt');
  const stderrPath = path.join(outDir, 'stderr.txt');
  const startUtc = new Date().toISOString();
  const child = spawnSync(command, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  fs.writeFileSync(stdoutPath, stdout, 'utf8');
  fs.writeFileSync(stderrPath, stderr, 'utf8');
  const endUtc = new Date().toISOString();
  const meta = {
    schema: 'xj.v511.codex-main-review-self-run.v1',
    taskId: TASK_ID,
    tool: toolName,
    command,
    argv,
    cwd: ROOT,
    startUtc,
    endUtc,
    exitCode: child.status,
    stdoutPath,
    stderrPath,
    stdoutSha256: sha(Buffer.from(stdout, 'utf8')),
    stderrSha256: sha(Buffer.from(stderr, 'utf8')),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    verdict: child.status === expectedExit ? 'PASS' : 'FAIL'
  };
  const metaPath = path.join(outDir, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { metaPath, meta };
}

function main() {
  const args = parseArgs();
  if (!args.root || !args.tool || !args.script) throw new Error('--root, --tool, --script required');
  const root = path.resolve(args.root);
  const outDir = path.join(root, 'self', args.tool);
  const script = path.resolve(args.script);
  const childArgs = [];
  if (args.extra) childArgs.push(...JSON.parse(args.extra));
  const result = capture(args.tool, process.execPath, [script, ...childArgs], outDir, Number(args.expectedExit || 0));
  process.stdout.write(`${JSON.stringify({ type: 'self-capture-summary', taskId: TASK_ID, tool: args.tool, outDir, metaPath: result.metaPath, exitCode: result.meta.exitCode, verdict: result.meta.verdict })}\n`);
  process.exitCode = result.meta.verdict === 'PASS' ? 0 : 1;
}

try { main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ type: 'self-capture-error', taskId: TASK_ID, error: String(error.message || error) })}\n`);
  process.exitCode = 1;
}
