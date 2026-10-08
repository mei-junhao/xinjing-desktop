'use strict';

/*
 * Task 294 — trusted-AI source-context fail-closed contract.
 *
 * Reproduces and locks down a REAL fail-open at the candidate's real entry points:
 *   - ClinicalContext.build / validateSources / createActionRun (transcript task)
 *   - LongitudinalSummary.prepare / ClinicalContext.validateSources / createPreviewActionRun (summary task)
 *
 * For a task already bound to client-a / session-a1, ALL of the following must
 * fail closed (admission {ok:false}, no action run created):
 *   1. every source's clientId cleared
 *   2. every source's sessionId cleared
 *   3. both cleared
 *
 * The file loads ONLY from the candidate root (XJ_CANDIDATE_ROOT honored so the
 * mutation probes can run the same contract against byte-mutated copies). It never
 * reads the live project tree.
 *
 * Pre-fix this contract prints the observed fail-open values (admitted=true) and
 * exits non-zero (expected-red). Post-fix it asserts fail-closed and exits 0.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKSPACE = path.resolve(__dirname, '..');
const ROOT = process.env.XJ_CANDIDATE_ROOT || path.join(WORKSPACE, 'candidate', 'repo');
const INPUT = path.join(WORKSPACE, 'input');
function candidate(name) { return path.join(ROOT, 'app', 'js', name); }
function frozen(name) { return path.join(INPUT, 'app', 'js', name); }
function read(file) { return fs.readFileSync(file, 'utf8'); }

function clearClient(source) { return Object.assign({}, source, { clientId: '' }); }
function clearSession(source) { return Object.assign({}, source, { sessionId: '' }); }
function clearBoth(source) { return Object.assign({}, source, { clientId: '', sessionId: '' }); }
function clearClientWhitespace(source) { return Object.assign({}, source, { clientId: '   ' }); }

function baseScope(store) {
  return {
    console, TextEncoder, encodeURIComponent, unescape, Date, Math, JSON, Promise,
    Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Store: store,
    App: { featureGate: () => true, hasAICompute: () => true },
  };
}

function loadTranscriptFixture() {
  const runs = [];
  const clients = new Map([['client-a', { id: 'client-a', name: 'Synthetic A', notes: 'SYNTHETIC_NOTE' }]]);
  const sessions = new Map([['session-a1', { id: 'session-a1', clientId: 'client-a', sessionNumber: 1, date: '2026-08-01', transcript: 'SYNTHETIC_ALPHA', updatedAt: 'v1' }]]);
  const scope = baseScope({
    getClient: (id) => clients.get(String(id)) || null,
    getSession: (id) => sessions.get(String(id)) || null,
    getMaterialWorkspace: () => null,
    getSupervision: () => null,
    createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-' + (runs.length + 1) }, value); runs.push(run); return run; },
    updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
  });
  scope.window = scope;
  vm.createContext(scope);
  const validators = fs.existsSync(candidate('clinical-task-validators.js')) ? candidate('clinical-task-validators.js') : frozen('clinical-task-validators.js');
  vm.runInContext(read(validators), scope, { filename: validators });
  vm.runInContext(read(candidate('clinical-context.js')), scope, { filename: candidate('clinical-context.js') });
  return { api: scope.ClinicalContext, runs };
}

function loadSummaryFixture() {
  const runs = [];
  const state = {
    material: { id: 'material-a1', clientId: 'client-a', sessionId: 'session-a1', parseStatus: 'ready', extractedText: 'SYNTHETIC_ALPHA', updatedAt: 'v1' },
    session: { id: 'session-a1', clientId: 'client-a', updatedAt: 'v1' },
  };
  const scope = baseScope({
    getClient: (id) => id === 'client-a' ? { id: 'client-a', name: 'Synthetic A' } : null,
    getSession: (id) => id === 'session-a1' ? state.session : null,
    getMaterialWorkspace: (id) => id === 'material-a1' ? state.material : null,
    getSupervision: () => null,
    createClinicalActionRun: (value) => { const run = Object.assign({ id: 'run-' + (runs.length + 1) }, value); runs.push(run); return run; },
    updateClinicalActionRun: (id, patch) => { const run = runs.find((item) => item.id === id); if (!run) return null; Object.assign(run, patch); return run; },
  });
  scope.CaseSpaceViewModel = {
    refresh: async () => ({ ok: true, model: { clientId: 'client-a', nodes: [{
      id: 'node-a1', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'verified',
      sourceRef: { id: 'source-a1', schemaVersion: '1', normalizationVersion: '1', sourceVersion: '1', sourceContentHash: 'sha256:source', anchorContentHash: 'sha256:anchor', anchor: { locator: 'material:material-a1' } },
      occurredAt: '2026-08-01T00:00:00.000Z'
    }] } }),
  };
  scope.window = scope;
  vm.createContext(scope);
  const validators = fs.existsSync(candidate('clinical-task-validators.js')) ? candidate('clinical-task-validators.js') : frozen('clinical-task-validators.js');
  vm.runInContext(read(validators), scope, { filename: validators });
  vm.runInContext(read(candidate('clinical-context.js')), scope, { filename: candidate('clinical-context.js') });
  vm.runInContext(read(candidate('longitudinal-summary.js')), scope, { filename: candidate('longitudinal-summary.js') });
  return { api: scope.LongitudinalSummary, contextApi: scope.ClinicalContext, state, runs };
}

async function run() {
  // Candidate root must never be the live project tree.
  const rootNorm = ROOT.replace(/\\/g, '/');
  assert.ok(!/D:\/xinjing-electron\/(?:app|main\.js|preload\.js)/i.test(rootNorm), 'candidate root must not be the live project: ' + ROOT);

  const observed = [];
  let positive = 0;

  // ---- transcript task (real entry: build -> validateSources / createActionRun) ----
  const transcript = loadTranscriptFixture();
  const api = transcript.api;
  const built = api.build('transcript-ai-detect', { clientId: 'client-a', sessionId: 'session-a1' }, { selectedSessionIds: ['session-a1'], inputText: 'SYNTHETIC_INPUT' });
  assert.strictEqual(built.ok, true, 'positive transcript build must succeed at the real entry');
  positive++;
  assert.strictEqual(api.validateSources('transcript-ai-detect', built.sources, built.origin).ok, true, 'positive transcript admission must succeed');
  positive++;
  assert.ok(api.createActionRun(built), 'positive transcript action run must be created');
  positive++;

  const transcriptCases = [
    { name: 'transcript/all-sources-clientId-cleared', mutate: clearClient },
    { name: 'transcript/all-sources-sessionId-cleared', mutate: clearSession },
    { name: 'transcript/all-sources-clientId-and-sessionId-cleared', mutate: clearBoth },
  ];
  for (const c of transcriptCases) {
    const sources = built.sources.map(c.mutate);
    const admission = api.validateSources('transcript-ai-detect', sources, built.origin);
    const runRecord = api.createActionRun(Object.assign({}, built, { sources: sources }));
    observed.push({ entry: 'ClinicalContext.validateSources/createActionRun', name: c.name, admitted: admission.ok === true, reason: admission.reason || null, runCreated: !!runRecord });
  }
  // Whitespace-only clientId must also be treated as missing (no trim-and-continue normalization).
  {
    const sources = built.sources.map(clearClientWhitespace);
    const admission = api.validateSources('transcript-ai-detect', sources, built.origin);
    observed.push({ entry: 'ClinicalContext.validateSources', name: 'transcript/all-sources-clientId-whitespace', admitted: admission.ok === true, reason: admission.reason || null, runCreated: false });
  }

  // ---- summary task (real entry: LongitudinalSummary.prepare -> validateSources / createPreviewActionRun) ----
  const summary = loadSummaryFixture();
  const prepared = await summary.api.prepare('client-a', { skipFeatureGate: true });
  assert.strictEqual(prepared.ok, true, 'positive summary prepare must succeed at the real entry');
  positive++;
  const summaryContext = prepared.context;
  assert.ok(summary.api.createPreviewActionRun(summaryContext), 'positive summary preview action run must be created');
  positive++;

  const summaryCases = [
    { name: 'summary/all-sources-clientId-cleared', mutate: clearClient },
    { name: 'summary/all-sources-sessionId-cleared', mutate: clearSession },
    { name: 'summary/all-sources-clientId-and-sessionId-cleared', mutate: clearBoth },
  ];
  for (const c of summaryCases) {
    const sources = summaryContext.sources.map(c.mutate);
    const admission = summary.contextApi.validateSources('growth-summary', sources, summaryContext.origin);
    const runRecord = summary.api.createPreviewActionRun(Object.assign({}, summaryContext, { sources: sources }));
    observed.push({ entry: 'ClinicalContext.validateSources/LongitudinalSummary.createPreviewActionRun', name: c.name, admitted: admission.ok === true, reason: admission.reason || null, runCreated: !!runRecord });
  }

  // Print the observed results BEFORE asserting so the pre-fix run captures the
  // real fail-open values for every case (expected-red evidence).
  console.log(JSON.stringify({ suite: 'source-context-fail-closed-contract', phase: 'observe', root: ROOT, observed }, null, 2));

  // Fail-closed assertions on the real entry results.
  const failing = observed.filter((item) => item.admitted || item.runCreated);
  for (const item of observed) {
    assert.strictEqual(item.admitted, false, item.name + ' must fail closed at the real entry (admission was ok=true)');
    assert.strictEqual(item.runCreated, false, item.name + ' must not create an action run');
    if (!/source-(client|session)-missing/.test(item.reason || '')) {
      assert.fail(item.name + ' must reject with a missing-context reason, got: ' + item.reason);
    }
  }
  assert.strictEqual(failing.length, 0, 'all missing-context cases must fail closed');

  console.log(JSON.stringify({ suite: 'source-context-fail-closed-contract', phase: 'assert', pass: positive + observed.length, fail: 0, root: ROOT }, null, 2));
}

run().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
