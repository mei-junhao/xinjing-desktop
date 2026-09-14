'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

function requiredString(args, key) {
  const value = String(args[key] || '').trim();
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const args = parseArgs(process.argv);

try {
  const stageId = requiredString(args, 'stage-id');
  const mode = requiredString(args, 'mode');
  const phasePath = path.resolve(requiredString(args, 'phase-path'));
  const fixturePath = path.resolve(requiredString(args, 'fixture'));
  const runId = requiredString(args, 'run-id');
  const nonce = requiredString(args, 'nonce');
  if (!['baseline', 'mutated', 'restored'].includes(mode)) throw new Error('unsupported phase mode');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const stage = fixture.stages.find((entry) => entry && entry.id === stageId);
  if (!stage) throw new Error('stage is not present in the independent fixture');
  const phaseId = `${stageId}-${mode}`;
  const startUtc = new Date().toISOString();
  const ok = mode !== 'mutated';
  const payload = stage.shape === 'nested'
    ? { nested: { signal: stage.signal, marker: 'independent' } }
    : { signal: stage.signal, marker: 'independent' };
  const raw = {
    schemaVersion: 'phase-raw-033-v1',
    phaseId,
    stageId,
    mode,
    runId,
    nonce,
    ok,
    payload
  };
  const endUtc = new Date().toISOString();
  const exitCode = ok ? 0 : 7;
  const phase = {
    schemaVersion: 'phase-json-033-v1',
    phaseId,
    stageId,
    mode,
    runId,
    nonce,
    command: process.execPath,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    startUtc,
    endUtc,
    exitCode,
    rawSchemaVersion: raw.schemaVersion
  };
  writeJson(phasePath, phase);
  process.stdout.write(`${JSON.stringify(raw)}\n`);
  if (!ok) process.stderr.write(`${JSON.stringify({ schemaVersion: 'phase-error-033-v1', phaseId, runId, nonce, reason: 'expected-red' })}\n`);
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
