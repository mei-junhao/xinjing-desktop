'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-masters-fold-evidence-process-cleanup-rework-004';
const BASE = path.resolve(process.env.XJ_EXPECTED_RED_ROOT || path.join(ROOT, 'qa', 'task-scratch', TASK_ID, 'expected-red-final2'));
const OUT = path.join(path.dirname(BASE), 'adversarial-004');
const VERIFIER = path.join(__dirname, 'verify-expected-red-004.js');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive:true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

function clone(name) {
  const target = path.join(OUT, name);
  fs.rmSync(target, { recursive:true, force:true });
  fs.cpSync(BASE, target, { recursive:true });
  return target;
}

function runMutation(name, mutate) {
  const root = clone(name);
  const summaryFile = path.join(root, 'expected-red-summary.json');
  const summary = readJson(summaryFile);
  mutate(summary);
  writeJson(summaryFile, summary);
  const child = cp.spawnSync(process.execPath, [VERIFIER], {
    cwd:ROOT, windowsHide:true, encoding:'utf8', timeout:30000, maxBuffer:16 * 1024 * 1024,
    env:Object.assign({}, process.env, { XJ_TASK_ID:TASK_ID, XJ_EXPECTED_RED_ROOT:root }),
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  const result = {
    attack:name, verifierExit:child.status == null ? null : child.status,
    expectedFailure:child.status !== 0, stdoutSha256:sha256(Buffer.from(stdout, 'utf8')),
    stderrSha256:sha256(Buffer.from(stderr, 'utf8')), stdoutBytes:Buffer.byteLength(stdout, 'utf8'),
    stderrBytes:Buffer.byteLength(stderr, 'utf8'), root,
  };
  fs.writeFileSync(path.join(root, 'attack.stdout.txt'), stdout, 'utf8');
  fs.writeFileSync(path.join(root, 'attack.stderr.txt'), stderr, 'utf8');
  writeJson(path.join(root, 'attack.meta.json'), result);
  return result;
}

function main() {
  ensureDir(OUT);
  const attacks = [
    ['delete-await-cleanup', (summary) => { summary.cases[0].baseline.result.cleanup = null; }],
    ['remove-force-reclaim', (summary) => { summary.cases[1].mutated.result.cleanup.ok = false; summary.cases[1].mutated.result.cleanup.treeExited = false; }],
    ['swallow-timeout', (summary) => { summary.cases[2].baseline.meta.timedOut = true; summary.cases[2].baseline.result.cleanup.events = ['window-close-requested']; }],
    ['fake-exit-zero', (summary) => { summary.cases[3].mutated.meta.exitCode = 0; }],
  ];
  const results = attacks.map(([name, mutate]) => runMutation(name, mutate));
  const result = { taskId:TASK_ID, attack:'adversarial-004', attackCount:results.length, killedCount:results.filter((item) => item.expectedFailure).length, status:results.every((item) => item.expectedFailure) ? 'PASS' : 'FAIL', results };
  writeJson(path.join(OUT, 'adversarial-results.json'), result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
