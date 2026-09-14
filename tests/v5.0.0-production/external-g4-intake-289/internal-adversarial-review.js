'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { workspace: WORKSPACE, candidateRoot: ROOT, evidenceFile } = require('./harness-paths');
const read = (name) => fs.readFileSync(path.join(ROOT, 'app', 'js', name), 'utf8');

function loadClinical() {
  const runs = [];
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise,
    Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: (id) => id === 'a' ? { id: 'a', name: 'Synthetic' } : null,
      getSession: (id) => id === 's1' ? { id: 's1', clientId: 'a', transcript: 'SYNTHETIC', updatedAt: 'v1' } : null,
      getMaterialWorkspace: () => null,
      getSupervision: () => null,
      createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-' + (runs.length + 1) }, value); runs.push(run); return run; },
      updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
    },
    App: { featureGate: () => true, hasAICompute: () => true },
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(read('clinical-task-validators.js'), scope);
  vm.runInContext(read('clinical-context.js'), scope);
  return { api: scope.ClinicalContext, runs };
}

function main() {
  const { api, runs } = loadClinical();
  const built = api.build('transcript-ai-detect', { clientId: 'a', sessionId: 's1' }, { inputText: 'BODY' });
  assert.strictEqual(built.ok, true);
  const source = built.sources.find((item) => item.kind === 'session') || built.sources[0];
  const checks = [];
  function check(id, fn) { fn(); checks.push(id); }

  check('A01-unknown-task', () => assert.strictEqual(api.validateSources('forged-task', [source], built.origin).reason, 'unknown-task'));
  check('A02-unknown-source-kind', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { kind: 'unknown' })], built.origin).reason, 'source-kind-unknown'));
  check('A03-missing-hash', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { sourceContentHash: '' })], built.origin).reason, 'source-hash-missing'));
  check('A04-missing-version', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { sourceVersion: '' })], built.origin).reason, 'source-version-missing'));
  check('A05-missing-client', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { clientId: '' })], built.origin).reason, 'source-client-missing'));
  check('A06-missing-session', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { sessionId: '' })], built.origin).reason, 'source-session-missing'));
  check('A07-cross-client', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { clientId: 'b' })], built.origin).reason, 'source-client-mismatch'));
  check('A08-cross-session', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { sessionId: 's2' })], built.origin).reason, 'source-session-mismatch'));
  check('A09-quarantined-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, source, { status: 'quarantined' })], built.origin).reason, 'source-not-admissible'));
  check('A10-schema-smuggling', () => assert.strictEqual(api.validateOutput('transcript-ai-detect', { kind: 'transcript-detection-preview', citations: [], formalRecord: 'x' }).reason, 'output-schema-additional-property'));
  check('A11-automatic-persistence', () => assert.strictEqual(api.createActionRun(Object.assign({}, built, { outputMode: 'durable-save' })), null));
  check('A12-bounded-output', () => {
    const run = api.createActionRun(built);
    const done = api.completeActionRun(run.id, { kind: 'transcript-detection-preview', findings: [], citations: [], summary: 'SECRET' });
    assert.deepStrictEqual(Object.keys(done.output).sort(), ['kind', 'ref']);
    assert.strictEqual(JSON.stringify(runs).includes('SECRET'), false);
  });

  const governance = require(path.join(ROOT, 'app', 'js', 'prompt-governance.js'));
  const hA = governance.sha256('A');
  check('A13-source-label-conflict', () => assert.strictEqual(governance.mergeKnowledgeSources([
    { id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: hA },
    { id: 'k', version: 'v1', kind: 'user-library', label: 'b', source: 'b', content: 'B', contentHash: governance.sha256('B') },
  ]).ok, false));
  check('A14-absent-await', () => {
    const summary = read('longitudinal-summary.js');
    assert.ok(summary.includes('var projection = await root.CaseSpaceViewModel.refresh('));
  });
  check('A15-live-path-leakage', () => {
    const candidateFiles = ['clinical-context.js', 'clinical-task-validators.js', 'source-ref.js', 'prompt-governance.js', 'longitudinal-summary.js', 'agent-core.js'];
    const testFiles = ['source-context-admission-contract.js', 'trusted-ai-provenance-governance-contract.js', 'longitudinal-summary-candidate-contract.js', 'prompt-governance-candidate-contract.js'];
    const sources = candidateFiles.map(read).concat(testFiles.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8'))).map((value) => value.replace(/\\/g, '/'));
    assert.ok(sources.every((value) => !/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(value)));
  });

  const output = { suite: 'internal-adversarial-review', pass: checks.length, fail: 0, checks };
  const evidence = evidenceFile('internal-adversarial-review.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
