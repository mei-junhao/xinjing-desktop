'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const runner = require('./run-contract.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER_PATH = path.join(__dirname, 'run-contract.js');

async function expectKilled(id, options) {
  let killed = false;
  try {
    await runner.run(options);
  } catch (error) {
    killed = true;
  }
  assert.strictEqual(killed, true, id + ' mutation survived');
  console.log('killed:', id);
}

function replace(source, from, to, id) {
  assert.ok(source.includes(from), id + ' mutation anchor missing');
  return source.replace(from, to);
}

async function main() {
  const longitudinal = runner.readLongitudinalSource();
  const store = runner.readStoreSource();

  await expectKilled('M1-unverified-source-admission', {
    longitudinalSource: replace(longitudinal, "node.sourceStatus !== 'verified'", 'false', 'M1'),
  });
  await expectKilled('M2-cross-client-node-admission', {
    longitudinalSource: replace(longitudinal, 'node.clientId !== clientId', 'false', 'M2'),
  });
  await expectKilled('M3-cross-session-material-admission', {
    longitudinalSource: replace(longitudinal, 'material.sessionId !== node.sessionId', 'false', 'M3'),
  });
  await expectKilled('M4-entitlement-recheck-bypass', {
    longitudinalSource: replace(longitudinal, 'var next = await prepare(context.origin.clientId);', 'var next = await prepare(context.origin.clientId, { skipFeatureGate: true });', 'M4'),
  });
  await expectKilled('M5-duplicate-citation-acceptance', {
    longitudinalSource: replace(longitudinal, 'if (!allowed[key] || seen[key])', 'if (!allowed[key] || false)', 'M5'),
  });
  await expectKilled('M6-nonmaterial-action-source', {
    storeSource: replace(store, "if (isLongitudinalGrowth && source.kind !== 'material') return 'longitudinal-source-must-be-material';", "if (false) return 'longitudinal-source-must-be-material';", 'M6'),
  });
  await expectKilled('M7-cross-client-selected-session', {
    storeSource: replace(store, "return !!(selectedSession && String(selectedSession.clientId || '') === origin.clientId);", 'return !!selectedSession;', 'M7'),
  });
  await expectKilled('M8-preview-prose-persistence', {
    storeSource: replace(store, "output: { kind: String(value.output && value.output.kind || ''), ref: String(value.output && value.output.ref || '') },", 'output: Object.assign({}, value.output || {}),', 'M8'),
  });

  const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
  const mutatedRunner = replace(runnerSource, 'assert.strictEqual(prepared.context.references.length, 2,', 'assert.strictEqual(prepared.context.references.length, 3,', 'M9');
  const temporaryRunner = path.join(__dirname, 'mutated-run-contract.js');
  try {
    fs.writeFileSync(temporaryRunner, mutatedRunner, 'utf8');
    const result = childProcess.spawnSync('node', [temporaryRunner], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.notStrictEqual(result.status, 0, 'M9 runner-oracle mutation survived');
    console.log('killed: M9-runner-oracle');
  } finally {
    try { fs.unlinkSync(temporaryRunner); } catch (_) {}
  }
  console.log('longitudinal-summary mutations: 9/9 killed');
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
