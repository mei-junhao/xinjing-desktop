'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', 'candidate', 'repo');
const read = (name) => fs.readFileSync(path.join(ROOT, 'app', 'js', name), 'utf8');

function loadClinical() {
  const runs = [];
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: (id) => id === 'a' ? { id: 'a', name: 'Synthetic' } : null,
      getSession: (id) => id === 's1' ? { id: 's1', clientId: 'a', transcript: 'SYNTHETIC', updatedAt: 'v1' } : null,
      getMaterialWorkspace: () => null, getSupervision: () => null,
      createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-1' }, value); runs.push(run); return run; },
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
  const good = api.build('transcript-ai-detect', { clientId: 'a', sessionId: 's1' }, { inputText: 'BODY' });
  const checks = [];
  function check(id, fn) { fn(); checks.push(id); }

  check('A01-unknown-task', () => assert.strictEqual(api.build('forged-task', {}, {}).reason, 'unknown-task'));
  check('A02-cross-client-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { clientId: 'b' })], good.origin).reason, 'source-client-mismatch'));
  check('A03-quarantined-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { status: 'quarantined' })], good.origin).reason, 'source-not-admissible'));
  check('A04-unknown-source-kind', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { kind: 'unknown' })], good.origin).reason, 'source-kind-unknown'));
  check('A05-hashless-source', () => assert.strictEqual(api.validateSources('transcript-ai-detect', [Object.assign({}, good.sources[0], { sourceContentHash: '' })], good.origin).reason, 'source-hash-missing'));
  check('A06-schema-smuggling', () => assert.strictEqual(api.validateOutput('transcript-ai-detect', { kind: 'transcript-detection-preview', citations: [], formalRecord: 'x' }).reason, 'output-schema-additional-property'));
  check('A07-automatic-persist', () => assert.strictEqual(api.createActionRun(Object.assign({}, good, { outputMode: 'durable-save' })), null));
  check('A08-bounded-output', () => {
    const run = api.createActionRun(good);
    const done = api.completeActionRun(run.id, { kind: 'transcript-detection-preview', findings: [], citations: [], summary: 'SECRET' });
    assert.deepStrictEqual(Object.keys(done.output).sort(), ['kind', 'ref']);
    assert.strictEqual(JSON.stringify(runs).includes('SECRET'), false);
  });

  const governance = require(path.join(ROOT, 'app', 'js', 'prompt-governance.js'));
  const h = governance.sha256('A');
  check('A09-cross-label-dedup', () => assert.strictEqual(governance.mergeKnowledgeSources([
    { id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: h },
    { id: 'k', version: 'v1', kind: 'user-library', label: 'b', source: 'b', content: 'A', contentHash: h },
  ]).sources.length, 1));
  check('A10-cross-label-conflict', () => assert.strictEqual(governance.mergeKnowledgeSources([
    { id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: h },
    { id: 'k', version: 'v1', kind: 'user-library', label: 'b', source: 'b', content: 'B', contentHash: governance.sha256('B') },
  ]).ok, false));
  check('A11-declared-hash-mismatch', () => assert.throws(() => governance.mergeKnowledgeSources([{ id: 'k', version: 'v1', kind: 'master-builtin', label: 'a', source: 'a', content: 'A', contentHash: governance.sha256('B') }]), /hash mismatch/i));
  check('A12-no-live-project-bindings', () => {
    const candidateContracts = ['trusted-ai-provenance-governance-contract.js', 'longitudinal-summary-candidate-contract.js', 'prompt-governance-candidate-contract.js'];
    const testSources = candidateContracts.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\\/g, '/'));
    assert.ok(testSources.every((source) => !/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(source)));
  });

  console.log(JSON.stringify({ suite: 'internal-adversarial-review', pass: checks.length, fail: 0, checks }, null, 2));
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
