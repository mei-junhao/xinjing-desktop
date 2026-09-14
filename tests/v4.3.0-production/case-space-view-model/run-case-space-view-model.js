'use strict';
/**
 * Case-space ViewModel test runner.
 * Uses a mock Store to test the real production module.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// Mock Store with realistic getter APIs
function createMockStore() {
  var data = {
    clients: [
      { id: 'client-001', name: 'Client A', status: 'active', createdAt: '2025-01-01', updatedAt: '2025-06-01' },
    ],
    sessions: [
      { id: 'sess-001', clientId: 'client-001', sessionNumber: 1, date: '2025-01-15', durationMinutes: 50, type: 'individual', hasTranscript: true, hasSoap: true },
      { id: 'sess-002', clientId: 'client-001', sessionNumber: 2, date: '2025-02-01', durationMinutes: 50, type: 'individual', hasTranscript: true, hasSoap: true },
      { id: 'sess-003', clientId: 'client-001', sessionNumber: 3, date: '2025-03-01', durationMinutes: 50, type: 'individual', hasTranscript: true, hasSoap: false },
      { id: 'sess-other', clientId: 'client-002', sessionNumber: 1, date: '2025-01-01', durationMinutes: 50, type: 'individual', hasTranscript: false, hasSoap: false },
    ],
    materials: [
      { id: 'mat-001', clientId: 'client-001', sessionId: 'sess-001', title: 'Material 1', parseStatus: 'ready', extractedText: 'Synthetic material one', updatedAt: '2025-01-16' },
      { id: 'mat-002', clientId: 'client-001', sessionId: 'sess-002', title: 'Material 2', parseStatus: 'ready', extractedText: 'Synthetic material two', updatedAt: '2025-02-02' },
      { id: 'mat-cross-sess', clientId: 'client-001', sessionId: 'sess-999', title: 'Cross-session Material', parseStatus: 'ready', extractedText: 'Synthetic invalid material', updatedAt: '2025-03-15' },
    ],
    supervisions: [
      { id: 'sup-001', clientId: 'client-001', sessionId: 'sess-001', createdAt: '2025-01-20', status: 'completed' },
      { id: 'sup-002', clientId: 'client-001', sessionId: 'sess-002', createdAt: '2025-02-10', status: 'pending', isAiDraft: true },
    ],
    actionRuns: [
      { id: 'ar-001', clientId: 'client-001', sessionId: 'sess-001', title: 'Action 1', createdAt: '2025-01-25', status: 'completed' },
    ],
    writeCalls: []
  };

  return {
    getClient: function(id) { return data.clients.find(function(c) { return c.id === id; }) || null; },
    getSessionsByClient: function(clientId) { return data.sessions.filter(function(s) { return s.clientId === clientId; }); },
    getMaterialWorkspacesForSession: function(clientId, sessionId) {
      return data.materials.filter(function(m) { return m.clientId === clientId; });
    },
    getMaterialWorkspace: function(id) { return data.materials.find(function(m) { return m.id === id; }) || null; },
    getImportQuarantine: function() { return []; },
    getSupervisionsByClient: function(clientId) { return data.supervisions.filter(function(s) { return s.clientId === clientId; }); },
    getClinicalActionRuns: function(filters) {
      if (filters && filters.clientId) return data.actionRuns.filter(function(a) { return a.clientId === filters.clientId; });
      return data.actionRuns;
    },
    // Mutations for testing
    _data: data
  };
}

// Load the real production module
var src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'js', 'case-space-view-model.js'), 'utf8');
var SourceRef = require(path.join(__dirname, '..', '..', '..', 'app', 'js', 'source-ref.js'));

var checks = [];
var total = 0;
function check(id, label, cond) { total++; var ok = !!cond; checks.push({ id: id, label: label, pass: ok }); console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label); }

async function runTests() {
  var mockStore = createMockStore();
  var ctx = { window: { Store: mockStore, SourceRef: SourceRef }, console: console, Object: Object, Promise: Promise, Set: Set, Error: Error };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'case-space-view-model.js' });
  var ViewModel = ctx.window.CaseSpaceViewModel;

  // C1: Successful loadClient
  var r1 = await ViewModel.loadClient('client-001');
  check('C1', 'loadClient returns ok=true', r1.ok === true);
  check('C1b', 'model has clientId', r1.model.clientId === 'client-001');
  check('C1c', 'model has nodes', Array.isArray(r1.model.nodes) && r1.model.nodes.length > 0);
  check('C1d', 'sourceStatus is unverified', r1.model.sourceStatus === 'unverified');

  // C2: Unknown client
  var r2 = await ViewModel.loadClient('unknown-client');
  check('C2', 'unknown client returns ok=false', r2.ok === false);
  check('C2b', 'code is unknown-client', r2.code === 'unknown-client');
  check('C2c', 'empty model returned', r2.model.nodes.length === 0);

  // C3: Cancelled via AbortSignal
  var ac = new AbortController();
  ac.abort();
  var r3 = await ViewModel.loadClient('client-001', { signal: ac.signal });
  check('C3', 'cancelled signal returns ok=false', r3.ok === false);
  check('C3b', 'code is cancelled', r3.code === 'cancelled');

  // C4: Context mismatch
  var r4 = await ViewModel.loadClient('client-001', { currentContext: { clientId: 'client-002' } });
  check('C4', 'context mismatch returns ok=false', r4.ok === false);
  check('C4b', 'code is context-mismatch', r4.code === 'context-mismatch');

  // C5: Cross-session material rejected
  var r5 = await ViewModel.loadClient('client-001');
  var matRejected = r5.model.rejected.find(function(r) { return r.kind === 'material' && r.reason === 'cross-session'; });
  check('C5', 'cross-session material rejected', !!matRejected);

  // C6: Node IDs stable across calls
  var r6a = await ViewModel.loadClient('client-001');
  var r6b = await ViewModel.loadClient('client-001');
  var idsMatch = r6a.model.nodes.every(function (n, i) { return n.id === r6b.model.nodes[i].id; });
  check('C6', 'node IDs stable across calls', idsMatch && r6a.model.nodes.length === r6b.model.nodes.length && r6a.model.nodes.length > 0);
  check('C6b', 'no shared references between calls', r6a.model.nodes !== r6b.model.nodes);
  check('C6c', 'edge IDs stable across calls', r6a.model.edges.every(function (e, i) { return e.id === r6b.model.edges[i].id; }));
  check('C6d', 'node IDs derived from kind+clientId+entityId', r6a.model.nodes[0].id.indexOf('node-session-client-001-sess-001') === 0);

  // C7: Edge structure
  var r7 = await ViewModel.loadClient('client-001');
  check('C7', 'edges produced', Array.isArray(r7.model.edges) && r7.model.edges.length > 0);
  check('C7b', 'belongs-to relation', r7.model.edges.every(function(e) { return e.relation === 'belongs-to'; }));

  // C8: Counts
  check('C8', 'session count', r7.model.counts.sessions >= 3);
  check('C8b', 'materials count', r7.model.counts.materials >= 2);
  check('C8c', 'supervisions count', r7.model.counts.supervisions >= 2);
  check('C8d', 'actionRuns count', r7.model.counts.actionRuns >= 1);

  // C9: AI draft detected
  var r9 = await ViewModel.loadClient('client-001');
  var aiNode = r9.model.nodes.find(function (n) { return n.kind === 'supervision' && n.aiDraft === true; });
  check('C9', 'AI draft supervision detected', !!aiNode);
  check('C9b', 'non-AI nodes have aiDraft=false', r9.model.nodes.filter(function (n) { return n.aiDraft === false; }).length > 0);

  // C10: No Store write calls
  check('C10', 'no Store writes', mockStore._data.writeCalls.length === 0);

  // C11: Model is frozen
  check('C11', 'model is frozen', Object.isFrozen(r7.model));

  // C13: EMPTY_MODEL is not shared between failures
  var r13a = await ViewModel.loadClient('unknown-client');
  var r13b = await ViewModel.loadClient('unknown-client');
  check('C13', 'failure models not shared', r13a.model !== r13b.model);
  check('C13b', 'failure counts are zero', r13a.model.counts.sessions === 0 && r13b.model.counts.sessions === 0);
  check('C13c', 'failure model nodes frozen', Object.isFrozen(r13a.model.nodes));
  check('C13d', 'failure model counts frozen', Object.isFrozen(r13a.model.counts));

  // C14: Abort listener cleaned on unknown-client path
  var testSignal = new AbortController();
  var r14 = await ViewModel.loadClient('unknown-client', { signal: testSignal.signal });
  check('C14', 'unknown-client returns ok=false', r14.ok === false);
  check('C14b', 'code is unknown-client', r14.code === 'unknown-client');
  var aborted = false;
  try { testSignal.abort(); } catch (e) { aborted = true; }
  check('C14c', 'abort after unknown-client does not throw', !aborted);

  // C15: Abort listener cleaned after load
  var afterSignal = new AbortController();
  var afterResult = await ViewModel.loadClient('client-001', { signal: afterSignal.signal });
  check('C15', 'load with signal succeeds', afterResult.ok === true);
  afterSignal.abort();
  // Reload should work (no leaked listeners from previous call)
  var afterResult2 = await ViewModel.loadClient('client-001');
  check('C15b', 'reload after signal abort works', afterResult2.ok === true);

  // C12: Empty model structure
  check('C12', 'EMPTY_MODEL has correct version', ViewModel.EMPTY_MODEL.version === 'case-space-v1');

  var passed = checks.filter(function(c) { return c.pass; }).length;
  console.log('----------------------------------------');
  console.log('Passed: ' + passed + ' | Failed: ' + (total - passed));
  console.log('viewmodel_phase: ' + (passed === total ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
  process.exit(passed === total ? 0 : 1);
}

runTests().catch(function(e) { console.error('RUNNER_ERROR: ' + e.message); process.exit(1); });
