'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { candidateRoot: ROOT, inputRoot: INPUT } = require('./harness-paths');
const BASELINE = path.join(INPUT, 'baseline-candidate');
function candidate(name) { return path.join(ROOT, 'app', 'js', name); }
function input(name) { return path.join(BASELINE, 'app', 'js', name); }
function read(file) { return fs.readFileSync(file, 'utf8'); }

function loadFixture() {
  const runs = [];
  const state = {
    material: { id: 'material-a1', clientId: 'client-a', sessionId: 'session-a1', parseStatus: 'ready', extractedText: 'SYNTHETIC_ALPHA', updatedAt: 'v1' },
    session: { id: 'session-a1', clientId: 'client-a', updatedAt: 'v1' },
  };
  const scope = {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise,
    Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: {
      getClient: (id) => id === 'client-a' ? { id: 'client-a', name: 'Synthetic A' } : null,
      getSession: (id) => id === 'session-a1' ? state.session : null,
      getMaterialWorkspace: (id) => id === 'material-a1' ? state.material : null,
      getSupervision: () => null,
      createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-' + (runs.length + 1) }, value); runs.push(run); return run; },
      updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
    },
    App: { featureGate: () => true, hasAICompute: () => true },
    CaseSpaceViewModel: {
      refresh: async () => ({ ok: true, model: { clientId: 'client-a', nodes: [{
        id: 'node-a1', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'verified',
        sourceRef: { id: 'source-a1', schemaVersion: '1', normalizationVersion: '1', sourceVersion: '1', sourceContentHash: 'sha256:source', anchorContentHash: 'sha256:anchor', anchor: { locator: 'material:material-a1' } },
        occurredAt: '2026-08-01T00:00:00.000Z'
      }] } }),
    },
    module: { exports: {} }, exports: {},
  };
  scope.window = scope;
  vm.createContext(scope);
  const validators = fs.existsSync(candidate('clinical-task-validators.js')) ? candidate('clinical-task-validators.js') : input('clinical-task-validators.js');
  vm.runInContext(read(validators), scope, { filename: validators });
  vm.runInContext(read(candidate('clinical-context.js')), scope, { filename: candidate('clinical-context.js') });
  vm.runInContext(read(candidate('longitudinal-summary.js')), scope, { filename: candidate('longitudinal-summary.js') });
  return { api: scope.LongitudinalSummary, state, runs, contextApi: scope.ClinicalContext };
}

async function run() {
  const fixture = loadFixture();
  const prepared = await fixture.api.prepare('client-a', { skipFeatureGate: true });
  assert.strictEqual(prepared.ok, true);
  assert.strictEqual(prepared.context.taskSpec.id, 'growth-summary');
  assert.strictEqual(prepared.context.outputMode, 'preview-only');
  assert.strictEqual(prepared.context.references.length, 1);
  const ref = prepared.context.references[0];
  for (const key of ['sourceId', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'status']) assert.ok(ref[key], 'reference missing ' + key);
  assert.strictEqual(JSON.stringify({ snapshot: prepared.context.snapshot, references: prepared.context.references, sources: prepared.context.sources }).includes('SYNTHETIC_ALPHA'), false);

  const parsed = fixture.api.parsePreview(JSON.stringify({ summary: 'Synthetic preview', changes: [], citations: [ref] }), prepared.context);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.preview.mode, 'preview-only');
  assert.strictEqual(typeof fixture.api.save, 'undefined', 'module must not expose a durable save API');

  const runRecord = fixture.api.createPreviewActionRun(prepared.context);
  assert.ok(runRecord && runRecord.task === 'growth-summary');
  const completed = fixture.api.completePreviewActionRun(runRecord.id, parsed.preview);
  assert.ok(completed && completed.status === 'succeeded');
  assert.deepStrictEqual(Object.keys(completed.output).sort(), ['kind', 'ref']);
  assert.strictEqual(JSON.stringify(fixture.runs).includes('Synthetic preview'), false, 'preview prose must not persist');

  fixture.state.material.extractedText = 'SYNTHETIC_CHANGED';
  fixture.state.material.updatedAt = 'v2';
  assert.strictEqual(await fixture.api.isCurrent(prepared.context), false, 'changed source must invalidate preview');
  assert.strictEqual(fixture.api.parsePreview(JSON.stringify({ summary: 'x', changes: [], citations: [{ nodeId: 'node-a1', sourceId: 'foreign', sessionId: 'session-a1' }] }), prepared.context).reason, 'citation-unknown');

  console.log(JSON.stringify({ suite: 'longitudinal-summary-candidate', pass: 15, fail: 0, root: ROOT }, null, 2));
}

run().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
