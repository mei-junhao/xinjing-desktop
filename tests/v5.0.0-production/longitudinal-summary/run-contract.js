'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LONGITUDINAL_PATH = path.join(ROOT, 'app', 'js', 'longitudinal-summary.js');
const CLINICAL_CONTEXT_PATH = path.join(ROOT, 'app', 'js', 'clinical-context.js');
const CLINICAL_TASK_VALIDATORS_PATH = path.join(ROOT, 'app', 'js', 'clinical-task-validators.js');
const STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');

function source(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    key(index) { return Array.from(values.keys())[index] || null; },
  };
}

function loadStore(storeSource) {
  const scope = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    localStorage: memoryStorage(),
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(source(CLINICAL_TASK_VALIDATORS_PATH), scope, { filename: CLINICAL_TASK_VALIDATORS_PATH });
  vm.runInContext((storeSource || source(STORE_PATH)) + '\nthis.__store = Store;', scope, { filename: STORE_PATH });
  return scope.__store;
}

function projectionFixture(longitudinalSource) {
  const state = {
    featureEnabled: true,
    computeAvailable: true,
    clients: new Map([
      ['client-a', { id: 'client-a', name: 'Synthetic A' }],
      ['client-b', { id: 'client-b', name: 'Synthetic B' }],
    ]),
    sessions: new Map([
      ['session-a1', { id: 'session-a1', clientId: 'client-a', updatedAt: '2026-07-27T00:00:00.000Z' }],
      ['session-a2', { id: 'session-a2', clientId: 'client-a', updatedAt: '2026-07-27T00:01:00.000Z' }],
      ['session-b1', { id: 'session-b1', clientId: 'client-b', updatedAt: '2026-07-27T00:02:00.000Z' }],
    ]),
    materials: new Map([
      ['material-a1', { id: 'material-a1', clientId: 'client-a', sessionId: 'session-a1', parseStatus: 'ready', extractedText: 'SAFE_ALPHA', updatedAt: '2026-07-27T00:00:00.000Z' }],
      ['material-a2', { id: 'material-a2', clientId: 'client-a', sessionId: 'session-a2', parseStatus: 'ready', extractedText: 'SAFE_BRAVO', updatedAt: '2026-07-27T00:01:00.000Z' }],
      ['material-b1', { id: 'material-b1', clientId: 'client-b', sessionId: 'session-b1', parseStatus: 'ready', extractedText: 'REJECT_CROSS_CLIENT', updatedAt: '2026-07-27T00:02:00.000Z' }],
      ['material-failed', { id: 'material-failed', clientId: 'client-a', sessionId: 'session-a1', parseStatus: 'failed', extractedText: 'REJECT_FAILED_PARSE', updatedAt: '2026-07-27T00:03:00.000Z' }],
    ]),
  };
  state.model = {
    status: 'ok',
    clientId: 'client-a',
    nodes: [
      { id: 'node-a1', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'verified', sourceRef: { id: 'source-a1', anchor: { locator: 'material:material-a1' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:00:00.000Z' },
      { id: 'node-a2', kind: 'material', clientId: 'client-a', sessionId: 'session-a2', sourceStatus: 'verified', sourceRef: { id: 'source-a2', anchor: { locator: 'material:material-a2' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:01:00.000Z' },
      { id: 'node-unverified', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'unverified', sourceRef: { id: 'source-unverified', anchor: { locator: 'material:material-a1' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:04:00.000Z' },
      { id: 'node-cross-client', kind: 'material', clientId: 'client-b', sessionId: 'session-a1', sourceStatus: 'verified', sourceRef: { id: 'source-cross-client', anchor: { locator: 'material:material-a1' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:05:00.000Z' },
      { id: 'node-cross-session', kind: 'material', clientId: 'client-a', sessionId: 'session-a2', sourceStatus: 'verified', sourceRef: { id: 'source-cross-session', anchor: { locator: 'material:material-a1' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:06:00.000Z' },
      { id: 'node-cross-material', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'verified', sourceRef: { id: 'source-cross-material', anchor: { locator: 'material:material-b1' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:07:00.000Z' },
      { id: 'node-failed', kind: 'material', clientId: 'client-a', sessionId: 'session-a1', sourceStatus: 'verified', sourceRef: { id: 'source-failed', anchor: { locator: 'material:material-failed' }, normalizationVersion: 'v1', sourceVersion: '1', sourceContentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', anchorContentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }, occurredAt: '2026-07-27T00:08:00.000Z' },
    ],
  };
  const scope = {
    console,
    TextEncoder,
    encodeURIComponent,
    unescape,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Store: {
      getClient: (id) => state.clients.get(String(id)) || null,
      getSession: (id) => state.sessions.get(String(id)) || null,
      getMaterialWorkspace: (id) => state.materials.get(String(id)) || null,
    },
    App: {
      featureGate: () => state.featureEnabled,
      hasAICompute: () => state.computeAvailable,
    },
    CaseSpaceViewModel: {
      refresh: async () => ({ ok: true, model: state.model }),
    },
    module: { exports: {} },
    exports: {},
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(source(CLINICAL_CONTEXT_PATH), scope, { filename: CLINICAL_CONTEXT_PATH });
  vm.runInContext(longitudinalSource || source(LONGITUDINAL_PATH), scope, { filename: LONGITUDINAL_PATH });
  return { api: scope.LongitudinalSummary, state };
}

function runStoreContract(storeSource) {
  const Store = loadStore(storeSource);
  Store.createClient({ id: 'client-a', name: 'Synthetic A' });
  Store.createClient({ id: 'client-b', name: 'Synthetic B' });
  Store.createSession({ id: 'session-a1', clientId: 'client-a', sessionNumber: 1 });
  Store.createSession({ id: 'session-b1', clientId: 'client-b', sessionNumber: 1 });
  Store.createMaterialWorkspace({ id: 'material-a1', title: 'Synthetic material A', clientId: 'client-a', sessionId: 'session-a1', parseStatus: 'ready', extractedText: 'SYNTHETIC_ONLY' });
  Store.createMaterialWorkspace({ id: 'material-b1', title: 'Synthetic material B', clientId: 'client-b', sessionId: 'session-b1', parseStatus: 'ready', extractedText: 'SYNTHETIC_ONLY' });

  const base = {
    task: 'growth-summary',
    status: 'pending',
    origin: { clientId: 'client-a', sessionId: '', materialId: '', supervisionId: '' },
    sources: [{ kind: 'material', id: 'material-a1', label: 'Verified material 1', chars: 14, truncated: false }],
    snapshot: { clientId: 'client-a', sessionId: '', materialId: '', supervisionId: '', selectedSessionIds: ['session-a1'], inputDigest: 'sha256:synthetic', key: 'synthetic' },
    output: { kind: '', ref: '' },
  };
  const valid = Store.createClinicalActionRun(base);
  assert.ok(valid, 'a bounded, same-client longitudinal action run must be accepted');
  const completed = Store.updateClinicalActionRun(valid.id, {
    status: 'succeeded',
    output: { kind: 'growth-summary-preview', ref: 'sha256:preview', prose: 'MUST_NOT_PERSIST' },
  });
  assert.deepStrictEqual(Object.keys(completed.output).sort(), ['kind', 'ref'], 'action output must retain metadata only');
  assert.strictEqual(JSON.stringify(completed).includes('MUST_NOT_PERSIST'), false, 'preview prose must not persist in the action run');

  const wrongSourceKind = Object.assign({}, base, { sources: [{ kind: 'session', id: 'session-a1', label: 'Wrong kind', chars: 1, truncated: false }] });
  assert.strictEqual(Store.createClinicalActionRun(wrongSourceKind), null, 'longitudinal runs reject non-material sources');
  const wrongSession = Object.assign({}, base, { snapshot: Object.assign({}, base.snapshot, { selectedSessionIds: ['session-a1', 'session-b1'] }) });
  assert.strictEqual(Store.createClinicalActionRun(wrongSession), null, 'longitudinal runs reject cross-client selected sessions');
  const wrongMaterial = Object.assign({}, base, { sources: [{ kind: 'material', id: 'material-b1', label: 'Foreign material', chars: 1, truncated: false }] });
  assert.strictEqual(Store.createClinicalActionRun(wrongMaterial), null, 'longitudinal runs reject cross-client materials');
}

async function run(options) {
  options = options || {};
  const fixture = projectionFixture(options.longitudinalSource);
  const api = fixture.api;
  const state = fixture.state;

  assert.ok(api && typeof api.prepare === 'function' && typeof api.isCurrent === 'function' && typeof api.parsePreview === 'function', 'real longitudinal module must expose its public API');
  const prepared = await api.prepare('client-a');
  assert.strictEqual(prepared.ok, true, 'verified same-client sources must prepare');
  assert.strictEqual(prepared.context.references.length, 2, 'only two verified, linked source nodes may enter the preview');
  assert.deepStrictEqual(Array.from(prepared.context.references, (item) => item.nodeId), ['node-a1', 'node-a2'], 'cross-client, unverified, stale-session, foreign-material, and failed-parse nodes must be excluded');
  assert.ok(prepared.context.messages[1].content.includes('SAFE_ALPHA') && prepared.context.messages[1].content.includes('SAFE_BRAVO'), 'AI request receives admitted synthetic material only');
  assert.strictEqual(prepared.context.messages[1].content.includes('REJECT_CROSS_CLIENT'), false, 'foreign source body must not enter the AI request');
  assert.strictEqual(JSON.stringify({ sources: prepared.context.sources, snapshot: prepared.context.snapshot }).includes('SAFE_ALPHA'), false, 'provenance metadata must not retain source body text');

  const validPreview = api.parsePreview(JSON.stringify({
    summary: 'Synthetic longitudinal preview',
    changes: [{ title: 'Pattern', detail: 'Synthetic change observation' }],
    citations: prepared.context.references,
  }), prepared.context);
  assert.strictEqual(validPreview.ok, true, 'JSON preview with allowed citations must parse');
  assert.strictEqual(validPreview.preview.citations.length, 2, 'validated preview preserves metadata citations');
  assert.strictEqual(api.parsePreview(JSON.stringify({ summary: 'x', citations: [{ nodeId: 'unknown', sourceId: 'unknown', sessionId: 'unknown' }] }), prepared.context).reason, 'citation-unknown', 'unknown citation must fail closed');
  assert.strictEqual(api.parsePreview(JSON.stringify({ summary: 'x', citations: [prepared.context.references[0], prepared.context.references[0]] }), prepared.context).reason, 'citation-duplicate', 'duplicate citation must fail closed');

  assert.strictEqual(await api.isCurrent(prepared.context), true, 'unchanged prepared context must remain current');
  state.featureEnabled = false;
  assert.strictEqual(await api.isCurrent(prepared.context), false, 'lost entitlement must invalidate a pending preview');
  state.featureEnabled = true;
  state.computeAvailable = false;
  assert.strictEqual((await api.prepare('client-a')).reason, 'compute-unavailable', 'missing compute must fail before source admission');
  state.computeAvailable = true;
  state.materials.get('material-a1').extractedText = 'SAFE_ALPHA_CHANGED';
  assert.strictEqual(await api.isCurrent(prepared.context), false, 'changed verified material must invalidate the snapshot');
  state.materials.get('material-a1').extractedText = 'SAFE_ALPHA';
  state.model = { status: 'ok', clientId: 'client-a', nodes: [] };
  assert.strictEqual((await api.prepare('client-a')).reason, 'no-verified-sources', 'empty source projection must fail closed');

  runStoreContract(options.storeSource);
  console.log('longitudinal-summary contract: PASS');
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}

module.exports = { run, readLongitudinalSource: () => source(LONGITUDINAL_PATH), readStoreSource: () => source(STORE_PATH) };
