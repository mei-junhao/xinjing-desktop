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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const args = parseArgs(process.argv);
const scratchRoot = path.resolve(String(args['scratch-root'] || path.resolve(__dirname, '../../../qa/task-scratch')));
const runRoot = path.resolve(String(args['run-root'] || scratchRoot));
const fixturePath = path.resolve(String(args.fixture || path.join(scratchRoot, 'XJ-5.1.1-masters-expected-red-evidence-clean-room-strict-verifier-mutation-ledger-escalation-033', 'rules-fixture.json')));
const outputPath = path.resolve(String(args.output || path.join(runRoot, 'path-self-check.json')));

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoParentSegments(value, label) {
  const normalized = String(value).replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) throw new Error(`${label} contains parent segment`);
}

try {
  if (!path.isAbsolute(scratchRoot) || !path.isAbsolute(runRoot) || !path.isAbsolute(fixturePath) || !path.isAbsolute(outputPath)) {
    throw new Error('all path inputs must be absolute');
  }
  assertNoParentSegments(scratchRoot, 'scratchRoot');
  assertNoParentSegments(runRoot, 'runRoot');
  assertNoParentSegments(fixturePath, 'fixturePath');
  assertNoParentSegments(outputPath, 'outputPath');
  if (!isContained(scratchRoot, runRoot)) throw new Error('runRoot escapes scratchRoot');
  if (!isContained(scratchRoot, fixturePath)) throw new Error('fixturePath escapes scratchRoot');
  if (!isContained(runRoot, outputPath)) throw new Error('outputPath escapes runRoot');
  if (/[\\/]03[0-2](?:[\\/]|$)/i.test(runRoot) || /(?:029|030|031|032)/i.test(fixturePath)) {
    throw new Error('legacy evidence path fragment detected');
  }
  if (!fs.existsSync(fixturePath)) throw new Error('independent rules fixture is missing');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!fixture || fixture.schemaVersion !== 'rules-033-v1' || !Array.isArray(fixture.stages) || !Array.isArray(fixture.mutations)) {
    throw new Error('independent rules fixture schema is invalid');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const payload = {
    schemaVersion: 'path-self-check-033-v1',
    scratchRoot,
    runRoot,
    fixturePath,
    outputPath,
    scratchContained: isContained(scratchRoot, runRoot) && isContained(scratchRoot, fixturePath),
    outputContained: isContained(runRoot, outputPath),
    legacyFragmentsRejected: true,
    fixtureId: fixture.fixtureId,
    stageCount: fixture.stages.length,
    mutationCount: fixture.mutations.length,
    checkedUtc: new Date().toISOString()
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, stageCount: payload.stageCount, mutationCount: payload.mutationCount })}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
