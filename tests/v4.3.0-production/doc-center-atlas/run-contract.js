'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(root, 'app', 'js', 'doc-center.js');
const htmlPath = path.join(root, 'app', 'doc-center.html');

function mutate(source, name) {
  const replacements = {
    'admit-unverified': [
      "node.sourceStatus === 'verified'",
      "node.sourceStatus !== 'verified'"
    ],
    'admit-non-material': [
      "node.kind === 'material'",
      "node.kind !== 'material'"
    ],
    'expose-source-body': [
      "material.title || source.name || '未命名材料'",
      "material.extractedText || material.title || source.name || '未命名材料'"
    ],
    'accept-stale-projection': [
      "if (requestId !== atlasState.requestId || currentTab !== 'atlas' || currentClientId !== atlasState.clientId) return;",
      "if (currentTab !== 'atlas') return;"
    ],
    'bypass-deep-link-validation': [
      "if (!material || material.clientId !== currentClientId || material.sessionId !== node.sessionId || material.parseStatus !== 'ready') return null;",
      "if (!material) return null;",
      "if (!material || material.clientId !== currentClientId || material.sessionId !== meta.sessionId || material.parseStatus !== 'ready')",
      "if (!material)"
    ]
  };
  if (!name) return source;
  const values = replacements[name];
  assert(values, 'unknown mutation: ' + name);
  for (let index = 0; index < values.length; index += 2) {
    assert(source.includes(values[index]), 'mutation target missing: ' + name + ' #' + index);
    source = source.replace(values[index], values[index + 1]);
  }
  return source;
}

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    value: '',
    dataset: {},
    attributes: {},
    focused: false,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    focus() { this.focused = true; }
  };
}

function buildFixtures() {
  const clients = [
    { id: 'client-a', name: 'Alpha', status: 'active' },
    { id: 'client-b', name: 'Beta', status: 'active' }
  ];
  const sessions = [
    { id: 'session-a', clientId: 'client-a', sessionNumber: 1, date: '2026-07-01' },
    { id: 'session-b', clientId: 'client-b', sessionNumber: 2, date: '2026-07-02' }
  ];
  const materials = {
    'mat-verified': {
      id: 'mat-verified', clientId: 'client-a', sessionId: 'session-a', parseStatus: 'ready',
      title: 'Verified material', source: { name: 'verified.txt', ext: 'txt' },
      extractedText: 'REAL_CLINICAL_BODY_MUST_NOT_RENDER', updatedAt: '2026-07-01T10:00:00Z'
    },
    'mat-unverified': {
      id: 'mat-unverified', clientId: 'client-a', sessionId: 'session-a', parseStatus: 'ready',
      title: 'UNVERIFIED_TITLE', source: { name: 'unverified.txt', ext: 'txt' },
      extractedText: 'UNVERIFIED_SOURCE_BODY', updatedAt: '2026-07-01T10:00:00Z'
    },
    'mat-action': {
      id: 'mat-action', clientId: 'client-a', sessionId: 'session-a', parseStatus: 'ready',
      title: 'ACTION_MATERIAL_TITLE', source: { name: 'action.txt', ext: 'txt' },
      extractedText: 'ACTION_BODY', updatedAt: '2026-07-01T10:00:00Z'
    },
    'mat-b': {
      id: 'mat-b', clientId: 'client-b', sessionId: 'session-b', parseStatus: 'ready',
      title: 'B_MATERIAL_TITLE', source: { name: 'b.txt', ext: 'txt' },
      extractedText: 'B_BODY', updatedAt: '2026-07-02T10:00:00Z'
    },
    'mat-stale': {
      id: 'mat-stale', clientId: 'client-b', sessionId: 'session-b', parseStatus: 'ready',
      title: 'STALE_A_TITLE', source: { name: 'stale.txt', ext: 'txt' },
      extractedText: 'STALE_BODY', updatedAt: '2026-07-02T10:00:00Z'
    }
  };
  const ref = (materialId) => ({ id: 'sr:' + materialId, anchor: { kind: 'material:text', locator: 'material:' + materialId } });
  return {
    clients,
    sessions,
    materials,
    models: {
      'client-a': {
        ok: true,
        model: {
          nodes: [
            { id: 'node-material-client-a-mat-verified', kind: 'material', clientId: 'client-a', sessionId: 'session-a', sourceStatus: 'verified', sourceRef: ref('mat-verified') },
            { id: 'node-material-client-a-mat-unverified', kind: 'material', clientId: 'client-a', sessionId: 'session-a', sourceStatus: 'unverified', sourceRef: ref('mat-unverified') },
            { id: 'node-action-client-a-mat-action', kind: 'action-run', clientId: 'client-a', sessionId: 'session-a', sourceStatus: 'verified', sourceRef: ref('mat-action') }
          ]
        }
      },
      'client-b': {
        ok: true,
        model: {
          nodes: [
            { id: 'node-material-client-b-mat-b', kind: 'material', clientId: 'client-b', sessionId: 'session-b', sourceStatus: 'verified', sourceRef: ref('mat-b') }
          ]
        }
      },
      stale: {
        ok: true,
        model: {
          nodes: [
            { id: 'node-material-client-a-mat-stale', kind: 'material', clientId: 'client-b', sessionId: 'session-b', sourceStatus: 'verified', sourceRef: ref('mat-stale') }
          ]
        }
      }
    }
  };
}

function createHarness(options) {
  const fixture = buildFixtures();
  const elements = {
    'doc-content': makeElement('doc-content'),
    'client-list': makeElement('client-list'),
    'dc-client-select': makeElement('dc-client-select'),
    'dc-search': makeElement('dc-search'),
    'dc-growth-link': makeElement('dc-growth-link')
  };
  const tabs = ['all', 'transcript', 'report', 'supervision', 'timeline', 'atlas', 'trajectory'].map((tab) => {
    const element = makeElement('tab-' + tab);
    element.dataset.tab = tab;
    return element;
  });
  const events = {};
  let deferredA;
  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },
    querySelectorAll(selector) { return selector === '.dr-tab' ? tabs : []; },
    addEventListener(type, handler) { events[type] = handler; }
  };
  const location = { search: '?clientId=client-a&view=atlas', pathname: '/doc-center.html', hash: '', href: '' };
  const window = {
    innerWidth: 1440,
    location,
    history: { replaceState() {} },
    Store: {
      getClients: () => fixture.clients.slice(),
      getClient: (id) => fixture.clients.find((client) => client.id === id) || null,
      getSessionsByClient: (clientId) => fixture.sessions.filter((session) => session.clientId === clientId),
      getSessionsForPicker: (clientId) => fixture.sessions.filter((session) => session.clientId === clientId),
      getSession: (id) => fixture.sessions.find((session) => session.id === id) || null,
      getMaterialWorkspace: (id) => fixture.materials[id] || null,
      getSupervisionsByClient: () => [],
      isBillableSession: () => false
    },
    CaseSpaceViewModel: {
      refresh(clientId) {
        if (options && options.deferA && clientId === 'client-a') {
          return new Promise((resolve) => { deferredA = resolve; });
        }
        return Promise.resolve(fixture.models[clientId]);
      }
    },
    App: {
      initPage(spec) { spec.onReady(); },
      setActiveClientId() {},
      getActiveClientId() { return ''; },
      svgIcon(name) { return '<i data-icon="' + name + '"></i>'; },
      escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); },
      formatDate(value) { return String(value || ''); },
      showToast(message) { window.lastToast = message; },
      lockBadge() { return ''; },
      featureGate() { return true; }
    },
    setTimeout,
    clearTimeout
  };
  const context = vm.createContext({
    window,
    document,
    location,
    App: window.App,
    Store: window.Store,
    URLSearchParams,
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    console
  });
  let source = fs.readFileSync(scriptPath, 'utf8');
  source = mutate(source, process.env.XJ_ATLAS_MUTANT || '');
  vm.runInContext(source, context, { filename: scriptPath });
  return { fixture, document, window, events, resolveA(value) { deferredA(value); } };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function run() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert(html.includes('data-tab="atlas"'), 'Atlas tab must exist in the production page');
  assert(html.indexOf('js/source-ref.js') < html.indexOf('js/case-space-view-model.js'), 'SourceRef must load before CaseSpaceViewModel');
  assert(html.indexOf('js/case-space-view-model.js') < html.indexOf('js/doc-center.js'), 'CaseSpaceViewModel must load before the page renderer');

  const harness = createHarness();
  await settle();
  let output = harness.document.getElementById('doc-content').innerHTML;
  assert(output.includes('材料画布'), 'Atlas must render its read-only canvas');
  assert(output.includes('Verified material'), 'verified material must render');
  assert(!output.includes('UNVERIFIED_TITLE'), 'unverified material must be rejected from the canvas');
  assert(!output.includes('ACTION_MATERIAL_TITLE'), 'non-material projection rows must be rejected from the canvas');
  assert(!output.includes('REAL_CLINICAL_BODY_MUST_NOT_RENDER'), 'source body text must never render in Atlas');

  harness.window.openAtlasSource();
  assert.strictEqual(harness.window.location.href, 'transcript.html?clientId=client-a&sessionId=session-a&materialId=mat-verified', 'open source must create the existing validated material route');

  harness.window.selectAtlasSession('session-b');
  output = harness.document.getElementById('doc-content').innerHTML;
  assert(output.includes('当前材料已被筛选隐藏'), 'a hidden current selection must remain explicit');

  harness.fixture.materials['mat-verified'].clientId = 'client-b';
  harness.window.location.href = '';
  const beforeInvalidRoute = harness.window.location.href;
  harness.window.openAtlasSource();
  assert.strictEqual(harness.window.location.href, beforeInvalidRoute, 'changed material ownership must block the deep link');

  const staleHarness = createHarness({ deferA: true });
  staleHarness.window.selectClient('client-b');
  await settle();
  staleHarness.resolveA(staleHarness.fixture.models.stale);
  await settle();
  output = staleHarness.document.getElementById('doc-content').innerHTML;
  assert(output.includes('B_MATERIAL_TITLE'), 'the current client projection must render after a client switch');
  assert(!output.includes('STALE_A_TITLE'), 'a superseded projection must not overwrite the current client');

  process.stdout.write('doc-center-atlas contract: 14/14 passed\n');
}

run().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
