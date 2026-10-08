#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021');
const STORE = path.join(ROOT, 'app', 'js', 'store.js');
const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-fix-codex-subagent-021';
const BASELINE_SHA = '84DED0E7EAF3B8DE98A727D5F1671ED42B9EA27AE7EA27CAA644E8EF20CF768D';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SCRATCH = path.resolve(argValue('--scratch', DEFAULT_SCRATCH));
const SUMMARY_PATH = path.join(SCRATCH, 'runtime-summary.json');
const RAW_DIR = path.join(SCRATCH, 'raw');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyRaw(metaPath) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert(meta.task_id === TASK_ID, `${metaPath}: wrong task_id`);
  assert(meta.origin === 'http://127.0.0.1:19421', `${metaPath}: wrong fixed origin`);
  assert(meta.cwd === ROOT, `${metaPath}: wrong cwd`);
  assert(typeof meta.command === 'string' && /electron(?:\\|\/)dist(?:\\|\/)electron\.exe/i.test(meta.command), `${metaPath}: command is not real Electron`);
  assert(typeof meta.started_utc === 'string' && !Number.isNaN(Date.parse(meta.started_utc)), `${metaPath}: invalid start timestamp`);
  assert(typeof meta.finished_utc === 'string' && !Number.isNaN(Date.parse(meta.finished_utc)), `${metaPath}: invalid finish timestamp`);
  assert(meta.exit_code === 0 && meta.signal === null, `${metaPath}: process was not a graceful zero-exit run`);
  for (const stream of ['stdout', 'stderr']) {
    const record = meta[stream];
    assert(record && record.path && fs.existsSync(record.path), `${metaPath}: missing ${stream} raw`);
    const bytes = fs.readFileSync(record.path);
    assert(bytes.length === record.bytes, `${metaPath}: ${stream} bytes mismatch`);
    assert(sha256(bytes) === record.sha256, `${metaPath}: ${stream} SHA mismatch`);
  }
  assert(meta.store_sha256 && /^[0-9A-F]{64}$/.test(meta.store_sha256), `${metaPath}: missing store SHA`);
  return meta;
}

function verifyPhaseMeta(meta, label, requireResult) {
  assert(meta && meta.label === label, `${label}: summary/meta label mismatch`);
  const rawMetaPath = path.join(RAW_DIR, `${label.replace(/[^A-Za-z0-9._-]+/g, '_')}.meta.json`);
  assert(fs.existsSync(rawMetaPath), `${label}: raw metadata file is missing`);
  const checked = verifyRaw(rawMetaPath);
  assert(checked.label === label, `${label}: raw metadata label mismatch`);
  if (requireResult) {
    const rawStdout = fs.readFileSync(checked.stdout.path, 'utf8');
    assert(rawStdout.includes('XJ_HYDRATION_RESULT:'), `${label}: no real renderer result marker`);
    assert(checked.result && typeof checked.result === 'object', `${label}: missing real renderer result`);
  }
}

function collectMutations(summary) {
  const expected = [
    'M01-wrong-db-name', 'M02-wrong-store-name', 'M03-wrong-read-key', 'M04-skip-await-open',
    'M05-swallow-read-error', 'M06-object-as-array', 'M07-old-value-reuse', 'M08-cross-userdata',
  ];
  assert(Array.isArray(summary.mutations) && summary.mutations.length === expected.length, 'mutation count is not exactly 8');
  for (const id of expected) {
    const row = summary.mutations.find((item) => item.id === id);
    assert(row && row.killed === true, `${id}: not killed`);
    for (const phase of ['baseline', 'mutated', 'restore']) {
      assert(row[phase] && row[phase].task_id === TASK_ID, `${id}: ${phase} raw meta missing`);
      assert(row[phase].origin === 'http://127.0.0.1:19421', `${id}: ${phase} origin mismatch`);
      if (phase !== 'mutated') assert(row[phase].store_sha256 === BASELINE_SHA, `${id}: ${phase} was not production bytes`);
      else assert(row[phase].store_sha256 !== BASELINE_SHA, `${id}: mutated bytes equal production`);
    }
  }
}

function main() {
  assert(fs.existsSync(SUMMARY_PATH), 'runtime-summary.json is missing');
  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  assert(summary.task_id === TASK_ID, 'summary task_id mismatch');
  assert(summary.origin === 'http://127.0.0.1:19421' && summary.fixed_port === 19421, 'summary fixed-origin evidence missing');
  assert(summary.production_store_sha256 === BASELINE_SHA, 'production store SHA drifted');
  assert(summary.positive && summary.positive.checks.length === 3, 'positive suite incomplete');
  assert(summary.behavior && summary.behavior.length >= 6, 'behavior suite incomplete');
  assert(summary.mutation_killed === 8 && summary.mutation_total === 8, 'mutation suite incomplete');
  assert(summary.positive.phases[0].userData === summary.positive.phases[1].userData, 'positive phases did not share userData');
  assert(summary.positive.phases[0].origin === summary.positive.phases[1].origin, 'positive phases did not share origin');
  verifyPhaseMeta(summary.positive.phases[0], 'positive-01-write', true);
  verifyPhaseMeta(summary.positive.phases[1], 'positive-02-restart-hydrate', true);
  assert(summary.positive.phases[1].exit_code === 0 && summary.positive.phases[1].signal === null, 'restart was not graceful');
  assert(summary.positive.phases[1].result.rawClientCount === 1 && summary.positive.phases[1].result.rawSessionCount === 1, 'restart result lacks raw durable counts');
  assert(summary.positive.phases[1].result.clientCount === 1 && summary.positive.phases[1].result.sessionCount === 1 && summary.positive.phases[1].result.monthlyPayments.length === 1, 'restart result lacks collection readback');
  collectMutations(summary);
  const rawFiles = fs.readdirSync(RAW_DIR).filter((name) => name.endsWith('.meta.json'));
  assert(rawFiles.length >= 1 + 1 + 6 + (8 * 3), `raw metadata count too small: ${rawFiles.length}`);
  const metas = rawFiles.map((name) => verifyRaw(path.join(RAW_DIR, name)));
  assert(metas.some((meta) => meta.label === 'positive-01-write' && meta.result && meta.result.ok === true), 'positive write raw missing');
  assert(metas.some((meta) => meta.label === 'positive-02-restart-hydrate' && meta.result && meta.result.rawClientCount === 1 && meta.result.rawSessionCount === 1 && meta.result.clientCount === 1 && meta.result.monthlyPayments.length === 1), 'positive restart raw missing');
  assert(metas.some((meta) => meta.label === 'behavior-fallback-read' && meta.result && meta.result.ok === true), 'fallback raw missing');
  assert(metas.some((meta) => meta.label === 'behavior-fail-closed-write' && meta.result && meta.result.ok === true), 'fail-closed raw missing');
  console.log(JSON.stringify({ task_id: TASK_ID, raw_meta_count: rawFiles.length, mutation_killed: 8, positive_restart: 'clients=1,sessions=1,monthlyPayments=1', verified: true }, null, 2));
}

try { main(); } catch (error) {
  console.error('[FAIL] ' + (error && error.stack || error));
  process.exitCode = 1;
}
