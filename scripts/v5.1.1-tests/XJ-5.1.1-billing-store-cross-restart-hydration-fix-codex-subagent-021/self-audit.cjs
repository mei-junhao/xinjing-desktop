#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021');
const SUMMARY_PATH = path.join(SCRATCH, 'runtime-summary.json');
const RAW_DIR = path.join(SCRATCH, 'raw');
const VERIFIER = path.join(__dirname, 'verify-evidence.cjs');
const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021';

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safe(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, '_'); }

function runVerifier(scratch) {
  const result = childProcess.spawnSync(process.execPath, [VERIFIER, '--scratch', scratch], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function copyEvidence(caseDir, sourceSummary) {
  fs.mkdirSync(caseDir, { recursive: true });
  const caseRaw = path.join(caseDir, 'raw');
  fs.cpSync(RAW_DIR, caseRaw, { recursive: true });
  for (const name of fs.readdirSync(caseRaw).filter((entry) => entry.endsWith('.meta.json'))) {
    const metaPath = path.join(caseRaw, name);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.stdout.path = path.join(caseRaw, path.basename(meta.stdout.path));
    meta.stderr.path = path.join(caseRaw, path.basename(meta.stderr.path));
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }
  fs.writeFileSync(path.join(caseDir, 'runtime-summary.json'), JSON.stringify(sourceSummary, null, 2) + '\n', 'utf8');
  return caseRaw;
}

function mutateByLabel(summary, caseRaw, label, mutate) {
  const update = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.label === label) mutate(value);
    Object.keys(value).forEach((key) => {
      if (key !== 'label') update(value[key]);
    });
  };
  update(summary);
  const rawMetaPath = path.join(caseRaw, `${label}.meta.json`);
  assert(fs.existsSync(rawMetaPath), `raw meta missing for ${label}`);
  const raw = JSON.parse(fs.readFileSync(rawMetaPath, 'utf8'));
  mutate(raw);
  fs.writeFileSync(rawMetaPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

function writeAuditCase(sourceSummary, name, mutate) {
  const caseDir = path.join(SCRATCH, 'self-audit', 'cases', safe(name));
  const summary = clone(sourceSummary);
  const caseRaw = copyEvidence(caseDir, summary);
  mutate(summary, caseRaw);
  fs.writeFileSync(path.join(caseDir, 'runtime-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const result = runVerifier(caseDir);
  const record = {
    task_id: TASK_ID,
    attack: name,
    verifier_command: `${process.execPath} ${VERIFIER} --scratch ${caseDir}`,
    expected: 'reject',
    actual_exit_code: result.exit_code,
    actual_signal: result.signal,
    rejected: result.exit_code !== 0,
    stdout: { sha256: sha256(Buffer.from(result.stdout)), bytes: Buffer.byteLength(result.stdout, 'utf8') },
    stderr: { sha256: sha256(Buffer.from(result.stderr)), bytes: Buffer.byteLength(result.stderr, 'utf8') },
  };
  fs.writeFileSync(path.join(caseDir, 'result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  assert(record.rejected, `${name}: verifier accepted adversarial evidence`);
  return record;
}

function main() {
  assert(fs.existsSync(SUMMARY_PATH), 'runtime-summary.json is missing');
  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  const baseline = runVerifier(SCRATCH);
  assert(baseline.exit_code === 0, `baseline evidence verifier failed: ${baseline.stderr || baseline.stdout}`);
  const attacks = [];
  attacks.push(writeAuditCase(summary, 'fabricated-ok', (copy, raw) => {
    mutateByLabel(copy, raw, 'positive-02-restart-hydrate', (meta) => {
      meta.result = Object.assign({}, meta.result, { ok: true, clientCount: 0, sessionCount: 0, rawClientCount: 0, rawSessionCount: 0, monthlyPayments: [] });
    });
  }));
  attacks.push(writeAuditCase(summary, 'bypass-real-electron', (copy, raw) => {
    mutateByLabel(copy, raw, 'positive-01-write', (meta) => { meta.command = 'node fake-runner.cjs'; });
  }));
  attacks.push(writeAuditCase(summary, 'reuse-020-raw', (copy, raw) => {
    copy.task_id = 'XJ-5.1.1-billing-monthly-override-feedback-runtime-schema-and-evidence-rebind-020';
    for (const name of fs.readdirSync(raw).filter((entry) => entry.endsWith('.meta.json'))) {
      const p = path.join(raw, name);
      const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
      meta.task_id = copy.task_id;
      fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
  }));
  attacks.push(writeAuditCase(summary, 'forced-kill-as-graceful', (copy, raw) => {
    mutateByLabel(copy, raw, 'positive-02-restart-hydrate', (meta) => { meta.signal = 'SIGKILL'; });
  }));
  attacks.push(writeAuditCase(summary, 'memory-snapshot-as-restart', (copy, raw) => {
    mutateByLabel(copy, raw, 'positive-02-restart-hydrate', (meta) => {
      meta.result = Object.assign({}, meta.result, { rawClientCount: 0, rawSessionCount: 0 });
    });
  }));
  const summaryRecord = {
    task_id: TASK_ID,
    baseline_verifier_exit_code: baseline.exit_code,
    attacks,
    attack_count: attacks.length,
    attack_rejections: attacks.filter((item) => item.rejected).length,
    mutation_killed: summary.mutation_killed,
    mutation_total: summary.mutation_total,
    completed_utc: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(SCRATCH, 'self-audit'), { recursive: true });
  fs.writeFileSync(path.join(SCRATCH, 'self-audit', 'summary.json'), JSON.stringify(summaryRecord, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summaryRecord, null, 2));
}

try { main(); } catch (error) {
  console.error('[FAIL] ' + (error && error.stack || error));
  process.exitCode = 1;
}
