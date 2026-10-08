'use strict';
/**
 * XJ-4.3.0-opensquilla-case-atlas-disposable-v1
 * Test suite — validates ViewModel, SourceRef, cache invalidation,
 * quarantine, AI edge rejection, and all required states.
 *
 * Exit codes: 0 = ALL-GREEN | 1 = CONTRACT-BROKEN
 */
var path = require('path');
var ROOT = path.resolve(__dirname, '..', '..', '..');
var ViewModel = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'case-atlas-view-model.js'));
var SourceRefAdapter = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'source-ref-adapter.js'));
var fixtures = require(path.join(__dirname, 'fixtures.js'));

var passed = 0, failed = 0, blocked = 0;
var results = [];

function test(name, fn) {
  try { fn(); results.push('[PASS] ' + name); passed++; }
  catch (e) { results.push('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ===== A: ViewModel creation =====
test('A1: createViewModel returns valid structure', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var validation = ViewModel.validateViewModel(vm);
  assert(validation.ok, 'validation failed: ' + JSON.stringify(validation.issues));
});

test('A2: timeline has exactly 30 sessions', function () {
  var vm = ViewModel.createViewModel(fixtures);
  assert(vm.timeline.length === 30, 'expected 30, got ' + vm.timeline.length);
});

test('A3: timeline sorted by sessionNumber ascending', function () {
  var vm = ViewModel.createViewModel(fixtures);
  for (var i = 1; i < vm.timeline.length; i++) {
    assert(vm.timeline[i].sessionNumber > vm.timeline[i - 1].sessionNumber,
      'timeline not sorted at index ' + i);
  }
});

test('A4: all 6 node types present', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var types = {};
  vm.nodes.forEach(function (n) { types[n.type] = true; });
  ViewModel.NODE_TYPES.forEach(function (t) {
    assert(types[t], 'missing node type: ' + t);
  });
});

test('A5: every node has SourceRef with stable id', function () {
  var vm = ViewModel.createViewModel(fixtures);
  vm.nodes.forEach(function (n, i) {
    assert(n.sourceRef, 'node[' + i + '] missing sourceRef');
    assert(n.sourceRef.id, 'node[' + i + '] sourceRef missing id');
    assert(n.sourceRef.id.indexOf('sr:') === 0, 'node[' + i + '] sourceRef.id invalid format: ' + n.sourceRef.id);
  });
});

test('A6: every node has clientId and sessionId', function () {
  var vm = ViewModel.createViewModel(fixtures);
  vm.nodes.forEach(function (n, i) {
    assert(n.clientId, 'node[' + i + '] missing clientId');
    assert(n.sessionId, 'node[' + i + '] missing sessionId');
  });
});

test('A7: SourceRef covers normalizationVersion, sourceVersion, hashes', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var sample = vm.nodes[0].sourceRef;
  assert(sample.normalizationVersion, 'normalizationVersion missing');
  assert(sample.sourceVersion, 'sourceVersion missing');
  assert(sample.sourceContentHash, 'sourceContentHash missing');
  assert(sample.anchorContentHash, 'anchorContentHash missing');
});

test('A8: AI edge is preview-only in edges', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var aiEdges = vm.edges.filter(function (e) { return e.previewOnly; });
  assert(aiEdges.length === 1, 'expected 1 AI edge, got ' + aiEdges.length);
  assert(aiEdges[0].previewOnly === true, 'AI edge not marked previewOnly');
  assert(aiEdges[0].confidence >= 0 && aiEdges[0].confidence <= 1, 'AI edge confidence out of range');
});

test('A8b: supervision edges exist and match supervision count', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var supEdges = vm.edges.filter(function (e) { return e.sourceType === 'supervision'; });
  assert(supEdges.length > 0, 'no supervision edges found');
  assert(supEdges.length === fixtures.supervisions.length,
    'supervision edge count ' + supEdges.length + ' != supervision count ' + fixtures.supervisions.length);
});

test('A9: AI edge rejected by persistence adapter', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var aiEdge = vm.edges.find(function (e) { return e.previewOnly; });
  var result = SourceRefAdapter.rejectAiEdgePersistence(aiEdge);
  assert(result.ok === false, 'AI edge was NOT rejected');
  assert(result.reason === 'ai-edge-persistence-denied', 'wrong reason: ' + result.reason);
});

test('A10: non-AI edges also rejected in disposable prototype', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var regularEdge = vm.edges.find(function (e) { return !e.previewOnly; });
  var result = SourceRefAdapter.rejectAiEdgePersistence(regularEdge);
  assert(result.ok === false, 'non-AI edge should also be rejected in disposable');
  assert(result.reason === 'persistence-not-allowed-in-disposable-prototype', 'wrong reason: ' + result.reason);
});

// ===== B: SourceRef operations =====
test('B1: createAtlasSourceRef produces valid SourceRef', function () {
  var ref = SourceRefAdapter.createAtlasSourceRef({
    clientId: 'c_test', sessionId: 's_test',
    anchor: { kind: 'record', locator: 'test/1' },
    sourceText: 'test content'
  });
  assert(ref.id.indexOf('sr:') === 0, 'invalid id format');
  assert(ref.clientId === 'c_test', 'clientId mismatch');
  assert(ref.sourceContentHash, 'missing sourceContentHash');
  assert(ref.anchorContentHash, 'missing anchorContentHash');
});

test('B2: verifyAtlasSourceRef detects unchanged source', function () {
  var ref = SourceRefAdapter.createAtlasSourceRef({
    clientId: 'c_test', sessionId: 's_test',
    anchor: { kind: 'record', locator: 'test/1' },
    sourceText: 'test content'
  });
  var result = SourceRefAdapter.verifyAtlasSourceRef(ref, 'test content', '');
  assert(result.status === 'unchanged', 'expected unchanged, got ' + result.status);
  assert(result.verified === true, 'should be verified');
});

test('B3: verifyAtlasSourceRef detects source change', function () {
  var ref = SourceRefAdapter.createAtlasSourceRef({
    clientId: 'c_test', sessionId: 's_test',
    anchor: { kind: 'record', locator: 'test/1' },
    sourceText: 'original content'
  });
  var result = SourceRefAdapter.verifyAtlasSourceRef(ref, 'modified content', '');
  assert(result.verified === false, 'changed source must NOT be verified');
  assert(result.status === 'warning' || result.status === 'changed',
    'expected warning/changed, got ' + result.status);
});

test('B4: isStale returns true when source content changes', function () {
  var ref = SourceRefAdapter.createAtlasSourceRef({
    clientId: 'c_test', sessionId: 's_test',
    anchor: { kind: 'record', locator: 'test/1' },
    sourceText: 'original content'
  });
  assert(SourceRefAdapter.isStale(ref, 'modified content', '') === true, 'should be stale');
  assert(SourceRefAdapter.isStale(ref, 'original content', '') === false, 'should NOT be stale');
});

test('B5: isAiEdge correctly identifies AI edges', function () {
  assert(SourceRefAdapter.isAiEdge({ type: 'ai-inference' }) === true, 'type=ai-inference');
  assert(SourceRefAdapter.isAiEdge({ previewOnly: true }) === true, 'previewOnly=true');
  assert(SourceRefAdapter.isAiEdge({ type: 'record' }) === false, 'type=record');
  assert(SourceRefAdapter.isAiEdge(null) === false, 'null edge');
});

// ===== C: Quarantine and invalid sources =====
test('C1: quarantineSourceRef marks source as quarantined', function () {
  var ref = SourceRefAdapter.createAtlasSourceRef({
    clientId: 'c_test', sessionId: 's_test',
    anchor: { kind: 'record', locator: 'test/1' },
    sourceText: 'test'
  });
  var quarantined = SourceRefAdapter.quarantineSourceRef(ref, 'source-deleted');
  assert(quarantined.status === 'quarantined', 'status not quarantined');
  assert(quarantined.quarantineReason === 'source-deleted', 'reason mismatch');
  assert(quarantined.quarantinedAt, 'missing quarantinedAt');
  assert(quarantined.verified === false, 'quarantined must not be verified');
});

test('C2: createInvalidSourceRef produces legacy-unverified ref', function () {
  var invalid = SourceRefAdapter.createInvalidSourceRef();
  assert(invalid.status === 'legacy-unverified', 'expected legacy-unverified');
  assert(invalid.verified === false, 'invalid must not be verified');
  assert(invalid.clientId === '', 'clientId should be empty');
  assert(invalid.sourceContentHash === '', 'hash should be empty');
});

test('C3: verifyAtlasSourceRef on invalid ref returns legacy-unverified', function () {
  var invalid = SourceRefAdapter.createInvalidSourceRef();
  var result = SourceRefAdapter.verifyAtlasSourceRef(invalid, 'any text', '');
  assert(result.status === 'legacy-unverified' || result.status === 'invalid' || result.status === 'missing',
    'expected legacy-unverified/invalid/missing, got ' + result.status);
});

// ===== D: Cache invalidation =====
test('D1: needsCacheInvalidation returns true for null snapshot', function () {
  assert(SourceRefAdapter.needsCacheInvalidation(null, { sourceVersion: 'v1' }) === true, 'null snapshot');
});

test('D2: needsCacheInvalidation detects normalization version change', function () {
  var snap = { normalizationVersion: 'old-version', sourceVersion: 'synthetic-001' };
  assert(SourceRefAdapter.needsCacheInvalidation(snap, { sourceVersion: 'synthetic-001' }) === true,
    'normalization version change not detected');
});

test('D3: needsCacheInvalidation detects source version change', function () {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'old-source' };
  assert(SourceRefAdapter.needsCacheInvalidation(snap, { sourceVersion: 'synthetic-001' }) === true,
    'source version change not detected');
});

test('D4: needsCacheInvalidation detects client change', function () {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c1', sessionId: 's1' };
  var cur = { sourceVersion: 'synthetic-001', clientId: 'c2', sessionId: 's1' };
  assert(SourceRefAdapter.needsCacheInvalidation(snap, cur) === true, 'client change not detected');
});

test('D5: needsCacheInvalidation detects session change', function () {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c1', sessionId: 's1' };
  var cur = { sourceVersion: 'synthetic-001', clientId: 'c1', sessionId: 's2' };
  assert(SourceRefAdapter.needsCacheInvalidation(snap, cur) === true, 'session change not detected');
});

test('D6: needsCacheInvalidation returns false for matching snapshot', function () {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001' };
  assert(SourceRefAdapter.needsCacheInvalidation(snap, { sourceVersion: 'synthetic-001' }) === false,
    'matching snapshot should not invalidate');
});

// ===== E: Filter =====
test('E1: filterNodes by type returns correct subset', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var quotes = ViewModel.filterNodes(vm.nodes, 'quote', '');
  quotes.forEach(function (n) { assert(n.type === 'quote', 'filter returned non-quote'); });
  assert(quotes.length > 0, 'no quotes found');
});

test('E2: filterNodes with search query filters by label/summary', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var results = ViewModel.filterNodes(vm.nodes, 'all', '风险');
  assert(results.length > 0, 'search returned no results');
  results.forEach(function (n) {
    assert(n.label.indexOf('风险') >= 0 || n.summary.indexOf('风险') >= 0,
      'search result does not contain query: ' + n.label);
  });
});

test('E3: filterNodes with empty query returns all nodes', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var all = ViewModel.filterNodes(vm.nodes, 'all', '');
  assert(all.length === vm.nodes.length, 'filter all with empty query should return all nodes');
});

test('E4: filter confirmed excludes AI drafts', function () {
  var vm = ViewModel.createViewModel(fixtures);
  var confirmed = ViewModel.filterNodes(vm.nodes, 'confirmed', '');
  confirmed.forEach(function (n) {
    assert(n.isConfirmed === true, 'confirmed filter returned non-confirmed node');
    assert(n.isAiDraft === false, 'confirmed filter returned AI draft');
  });
});

// ===== F: Validation rejects bad input =====
test('F1: validateViewModel rejects null', function () {
  var result = ViewModel.validateViewModel(null);
  assert(result.ok === false, 'null should fail validation');
});

test('F2: validateViewModel rejects missing nodes', function () {
  var result = ViewModel.validateViewModel({ client: { id: 'x' }, edges: [] });
  assert(result.ok === false, 'missing nodes should fail');
});

test('F3: validateViewModel rejects invalid node type', function () {
  var result = ViewModel.validateViewModel({
    normalizationVersion: 'v1', sourceVersion: 'v1',
    client: { id: 'x' }, nodes: [{ id: 'n1', type: 'invalid-type', sourceRef: { id: 'sr:1' } }],
    edges: [], timeline: []
  });
  assert(result.ok === false, 'invalid node type should fail');
});

// ===== G: Unknown client state =====
test('G1: unknown client throws with helpful message', function () {
  var badFixtures = Object.assign({}, fixtures, { client: null });
  var threw = false;
  try { ViewModel.createViewModel(badFixtures); } catch (e) {
    threw = true;
    assert(e.message.indexOf('client') >= 0, 'error should mention client');
  }
  assert(threw, 'createViewModel did not throw on null client');
});

// ===== Summary =====
console.log('');
console.log('=== XJ-4.3.0 OpenSquilla Case Atlas Disposable Tests ===');
console.log('----------------------------------------');
results.forEach(function (r) { console.log(r); });
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed + ' | Blocked: ' + blocked);

if (failed > 0) {
  console.log('test_phase: CONTRACT-BROKEN');
  process.exit(1);
} else {
  console.log('test_phase: ALL-GREEN');
  console.log('注：仅验证 4.3.0 隔离 disposable 原型，不宣称生产就绪。');
  process.exit(0);
}
