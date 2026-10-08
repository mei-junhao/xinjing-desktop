'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..', '..');
const sourceRefPath = path.join(root, 'app', 'js', 'source-ref.js');
const viewModelPath = path.join(root, 'app', 'js', 'case-space-view-model.js');
const defaultSources = {
  sourceRef: fs.readFileSync(sourceRefPath, 'utf8'),
  viewModel: fs.readFileSync(viewModelPath, 'utf8')
};

function loadSourceRef(source) {
  const context = { window: {}, console, TextEncoder, String, Object, Array, Date, Math, Set, Error };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'source-ref.js' });
  return context.window.SourceRef;
}

function createStore() {
  const data = {
    clients: [{ id: 'client-a', name: 'Synthetic A' }],
    sessions: [{ id: 'session-a', clientId: 'client-a', date: '2026-01-01' }],
    materials: [{
      id: 'material-a', clientId: 'client-a', sessionId: 'session-a', title: 'Synthetic material',
      parseStatus: 'ready', extractedText: 'Synthetic material body', updatedAt: '2026-01-01T00:00:00.000Z'
    }],
    quarantine: [],
    writes: 0
  };
  return {
    getClient(id) { return data.clients.find((item) => item.id === id) || null; },
    getSessionsByClient(id) { return data.sessions.filter((item) => item.clientId === id); },
    getMaterialWorkspacesForSession(clientId, sessionId) {
      return data.materials.filter((item) => item.clientId === clientId && item.sessionId === sessionId).map((item) => ({ id: item.id }));
    },
    getMaterialWorkspace(id) { return data.materials.find((item) => item.id === id) || null; },
    getImportQuarantine() { return data.quarantine.slice(); },
    getSupervisionsByClient() { return []; },
    getClinicalActionRuns() { return []; },
    _data: data
  };
}

function loadViewModel(source, store, SourceRef) {
  const context = {
    window: { Store: store, SourceRef }, console, Object, Promise, Set, Error, AbortController
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'case-space-view-model.js' });
  return context.window.CaseSpaceViewModel;
}

async function runSuite(sources) {
  sources = Object.assign({}, defaultSources, sources || {});
  const checks = [];
  const check = (id, condition) => checks.push({ id, pass: !!condition });
  const SourceRef = loadSourceRef(sources.sourceRef);
  const store = createStore();
  const ViewModel = loadViewModel(sources.viewModel, store, SourceRef);

  const initial = await ViewModel.loadClient('client-a');
  const material = initial.model.nodes.find((item) => item.kind === 'material');
  check('A1', initial.ok && !!material && material.sourceStatus === 'verified');
  check('A2', !!material && !!material.sourceRef && !Object.prototype.hasOwnProperty.call(material.sourceRef, 'sourceText'));
  check('A3', store._data.writes === 0);

  store._data.quarantine.push({ collection: 'materialWorkspaces', entityId: 'material-a' });
  const quarantined = await ViewModel.loadClient('client-a');
  check('A4', quarantined.model.nodes.every((item) => item.kind !== 'material') && quarantined.model.rejected.some((item) => item.reason === 'quarantined' && !Object.prototype.hasOwnProperty.call(item, 'text')));

  store._data.quarantine = [];
  store._data.materials[0].extractedText = 'Synthetic material body changed';
  const changed = await ViewModel.loadClient('client-a');
  check('A5', changed.model.nodes.every((item) => item.kind !== 'material') && changed.model.rejected.some((item) => item.reason === 'source-changed-anchor-not-matched'));

  const mismatch = await ViewModel.loadClient('client-a', { currentContext: { clientId: 'client-b' } });
  check('A6', !mismatch.ok && mismatch.code === 'context-mismatch');

  const storedRef = material.sourceRef;
  const independentMismatch = SourceRef.validateAdmission(storedRef, {
    clientId: 'client-a', sessionId: 'session-a', anchor: storedRef.anchor,
    sourceText: 'Synthetic material body', anchorText: 'Synthetic material body'
  }, { clientId: 'client-b', sessionId: 'session-a' });
  check('A6b', !independentMismatch.admitted && independentMismatch.reason === 'ref-context-mismatch');

  const first = ViewModel.refresh('client-a');
  const second = ViewModel.refresh('client-a');
  const refreshes = await Promise.all([first, second]);
  check('A7', !refreshes[0].ok && refreshes[0].code === 'superseded' && refreshes[1].ok);

  const controller = new AbortController();
  const cancelled = ViewModel.cancelAsync(controller);
  const afterCancel = await ViewModel.refresh('client-a', { signal: controller.signal });
  check('A8', cancelled && !afterCancel.ok && afterCancel.code === 'cancelled');

  store._data.materials[0].extractedText = '';
  const empty = await ViewModel.loadClient('client-a');
  check('A9', empty.model.rejected.some((item) => item.reason === 'source-empty'));
  store._data.materials[0].parseStatus = 'failed';
  const failedParse = await ViewModel.loadClient('client-a');
  check('A10', failedParse.model.rejected.some((item) => item.reason === 'parse-not-ready'));

  return { checks, failed: checks.filter((item) => !item.pass).length };
}

if (require.main === module) {
  runSuite().then((result) => {
    result.checks.forEach((item) => console.log('[' + (item.pass ? 'PASS' : 'FAIL') + '] ' + item.id));
    console.log('Passed: ' + (result.checks.length - result.failed) + ' | Failed: ' + result.failed);
    process.exit(result.failed ? 1 : 0);
  }).catch((error) => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { runSuite, defaultSources };
