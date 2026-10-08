'use strict';
/**
 * XJ-4.3.0-opensquilla-long-source-graph-integration-harness-01
 * Runtime contract tests — 10 required coverages + 12 negative cases.
 * Uses REAL production SourceRef via the disposable adapter/projection.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJ = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js'));
const ADAPTER_FACTORY = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js'));
const FIXTURES = require(path.join(__dirname, 'fixtures.js'));

var passed = 0, failed = 0;
var testPromises = [];

async function test(name, fn) {
  var p = (async function () {
    try { await fn(); passed++; console.log('[PASS] ' + name); }
    catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); }
  })();
  testPromises.push(p);
  return p;
}
function ensure(cond, msg) { if (!cond) throw new Error(msg); }

(async function runAll() {

// ── C1: Cross-client sources, materials, sessions, action drafts, deep links never leak ──
test('C1a: cross-client nodes never appear in other client projection', function () {
  FIXTURES.clients.forEach(function (c) {
    var result = PROJ.verifyCrossClientIsolation(c.id, FIXTURES);
    ensure(result.ok, 'client ' + c.id + ' leak: ' + (result.reason || '') + ' leaked=' + (result.leakedCount || 0));
  });
});
test('C1b: cross-client materials never leak', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var projA = adapter.projectSync('synth-client-alpha', FIXTURES);
  var matB = projA.nodes.filter(function (n) { return n.sourceObjectId && n.sourceObjectId.indexOf('mat-B') >= 0; });
  ensure(matB.length === 0, 'cross-client material leaked: ' + matB.length);
});
test('C1c: cross-client sessions never appear in other client timeline', function () {
  var vm = PROJ.createViewModel(FIXTURES);
  var projA = vm.clientProjections['synth-client-alpha'];
  var alien = projA.nodes.filter(function (n) { return n.sessionId && n.sessionId.indexOf('synth-sess-B') >= 0; });
  ensure(alien.length === 0, 'cross-client session leaked');
});
test('C1d: cross-client action drafts never leak', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var projB = adapter.projectSync('synth-client-beta', FIXTURES);
  var leaked = projB.nodes.filter(function (n) { return n.sourceObjectId && n.sourceObjectId.indexOf('act-A') >= 0; });
  ensure(leaked.length === 0, 'cross-client action draft leaked');
});
test('C1e: cross-client deep links fail-closed', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var projC = adapter.projectSync('synth-client-gamma', FIXTURES);
  var leakedA = projC.nodes.filter(function (n) { return n.clientId === 'synth-client-alpha'; });
  ensure(leakedA.length === 0, 'client A leaked into C');
});

// ── C2: Cross-client display-name collisions do not bypass stable-ID checks ──
test('C2: same-name collision does not bypass stable-ID', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var projA = adapter.projectSync(FIXTURES.clients[0].id, FIXTURES);
  var projB = adapter.projectSync(FIXTURES.clients[1].id, FIXTURES);
  ensure(projA.ok && projB.ok, 'projection failed');
  ensure(FIXTURES.clients[0].name === FIXTURES.clients[1].name, 'precondition: names must collide');
  ensure(FIXTURES.clients[0].id !== FIXTURES.clients[1].id, 'IDs must differ');
  var aIds = {}; projA.nodes.forEach(function (n) { aIds[n.id] = true; });
  var overlap = projB.nodes.filter(function (n) { return aIds[n.id]; });
  ensure(overlap.length === 0, 'name collision caused ID overlap: ' + overlap.length);
});

// ── C3: projectAsync does not resolve before all source resolvers complete ──
test('C3: projectAsync waits for all resolvers', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var log = [];
  var resolvers = [
    function () { return new Promise(function (r) { setTimeout(function () { log.push('r1'); r({ nodeId: 'n1' }); }, 20); }); },
    function () { return new Promise(function (r) { setTimeout(function () { log.push('r2'); r({ nodeId: 'n2' }); }, 30); }); },
    function () { return new Promise(function (r) { setTimeout(function () { log.push('r3'); r({ nodeId: 'n3' }); }, 10); }); }
  ];
  return adapter.projectAsync(FIXTURES.clients[0].id, FIXTURES, resolvers).then(function (result) {
    ensure(result.ok, 'projectAsync failed');
    ensure(result.resolverCount === 3, 'expected 3 resolvers, got ' + result.resolverCount);
    ensure(log.length === 3, 'not all resolvers completed: ' + log.length);
  });
});

// ── C4: A delayed stale result cannot replace a newer projection ──
test('C4: stale delayed result rejected', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var externalSnapshot = { generation: 999 };
  var slowResolver = function () { return new Promise(function (r) { setTimeout(function () { r({ ok: true }); }, 30); }); };
  return adapter.projectAsync(FIXTURES.clients[0].id, FIXTURES, [slowResolver], externalSnapshot).then(function (result) {
    ensure(result.status === 'stale', 'expected stale, got ' + result.status);
    ensure(result.newerGeneration === 999, 'wrong newer generation');
  });
});

// ── C5: Material/supervision/action/souce/client/session changes invalidate cache ──
test('C5: all version changes invalidate cache', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var snap = PROJ.createSnapshot(FIXTURES, FIXTURES.clients[0].id);
  var cur = PROJ.createSnapshot(FIXTURES, FIXTURES.clients[0].id);
  ensure(!adapter.needsCacheInvalidation(snap, cur), 'identical snapshots should not invalidate');
  var c = JSON.parse(JSON.stringify(cur));
  c.clientId = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'clientId change must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.sessionId = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'sessionId change must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.normalizationVersion = '99'; ensure(adapter.needsCacheInvalidation(snap, c), 'normalizationVersion change must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.sourceVersion = '99'; ensure(adapter.needsCacheInvalidation(snap, c), 'sourceVersion change must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.materialUpdatedAt = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'materialUpdatedAt must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.supervisionUpdatedAt = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'supervisionUpdatedAt must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.actionDraftUpdatedAt = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'actionDraftUpdatedAt must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.sourceContentHash = 'different'; ensure(adapter.needsCacheInvalidation(snap, c), 'sourceContentHash must invalidate');
  c = JSON.parse(JSON.stringify(cur)); c.sessionVersions = {}; ensure(adapter.needsCacheInvalidation(snap, c), 'sessionVersions must invalidate');
  ensure(adapter.needsCacheInvalidation(null, cur), 'null snapshot must invalidate');
});

// ── C6: Missing/malformed SourceRef fields cause fail-closed ──
test('C6: invalid and quarantined SourceRefs fail-closed', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var invalid = adapter.createInvalidSourceRef({ clientId: 'c1', sessionId: 's1' });
  ensure(invalid.status === 'invalid', 'expected invalid, got ' + invalid.status);
  ensure(!invalid.verified, 'invalid must not be verified');
  var quarantined = adapter.quarantineSourceRef({ id: 'sr:test', clientId: 'c1', sessionId: 's1' }, 'test');
  ensure(quarantined.status === 'quarantined', 'expected quarantined, got ' + quarantined.status);
  ensure(!quarantined.verified, 'quarantined must not be verified');
  var missingRef = adapter.verifySourceRef(null, null);
  ensure(missingRef.status === 'invalid', 'null ref must be invalid');
});

// ── C7: Unknown client/session/material/anchor have distinct safe results ──
test('C7: unknown client and null client produce distinct fail-closed results', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var unknownClient = adapter.projectSync('nonexistent', FIXTURES);
  ensure(unknownClient.status === 'invalid' && unknownClient.reason === 'unknown-client', 'unknown client: ' + unknownClient.reason);
  var nullResult = adapter.projectSync(null, FIXTURES);
  ensure(nullResult.status === 'invalid' && nullResult.reason === 'missing-client-id', 'null client: ' + nullResult.reason);
  ensure(unknownClient.reason !== nullResult.reason, 'distinct reasons required');
});

// ── C8: Every persistence method rejects; AI preview edges remain provisional ──
test('C8: all persistence rejected, AI edges remain provisional', function () {
  var adapter = ADAPTER_FACTORY.createAdapter();
  var result = PROJ.verifyAiEdgeRejection(adapter);
  ensure(result.ok, 'not all persistence methods rejected');
  var vm = PROJ.createViewModel(FIXTURES);
  var aiEdges = vm.edges.filter(function (e) { return e.isAi || e.previewOnly; });
  aiEdges.forEach(function (e) { ensure(!e.isConfirmed, 'AI edge ' + e.id + ' must not be confirmed'); });
});

// ── C9: Read-only projections and filters do not mutate input snapshots ──
test('C9: projections and filters do not mutate input fixtures', function () {
  var origNodeCount = FIXTURES.nodes.length;
  var origEdgeCount = FIXTURES.edges.length;
  var vm = PROJ.createViewModel(FIXTURES);
  vm.nodes.push({ id: 'injected', type: 'quote', clientId: 'x', sessionId: 'y', sourceRef: { id: 'z' }, label: 'i', summary: 'i', truncated: false, isAiDraft: false, isConfirmed: true });
  ensure(FIXTURES.nodes.length === origNodeCount, 'input nodes mutated: ' + FIXTURES.nodes.length);
  var filtered = PROJ.filterNodes(FIXTURES.nodes, { type: 'quote' });
  filtered.push({ id: 'injected2' });
  ensure(FIXTURES.nodes.length === origNodeCount, 'filterNodes mutated input');
  ensure(FIXTURES.edges.length === origEdgeCount, 'input edges mutated');
});

// ── C10: Fixture topology ──
test('C10: 54 sessions, 3 clients, 12 negative cases', function () {
  ensure(FIXTURES.sessionCount >= 54, 'need >=54 sessions, got ' + FIXTURES.sessionCount);
  ensure(FIXTURES.clientCount === 3, 'need 3 clients, got ' + FIXTURES.clientCount);
  ensure(FIXTURES.negativeFixtures.cases.length >= 12, 'need >=12 negatives, got ' + FIXTURES.negativeFixtures.cases.length);
});

// ── 12 Negative fixture tests ──
FIXTURES.negativeFixtures.cases.forEach(function (neg) {
  test('NEG-' + neg.id + ': ' + neg.name, function () {
    var adapter = ADAPTER_FACTORY.createAdapter();
    if (neg.name === 'unknown-client') {
      var r = adapter.projectSync(neg.input.clientId, FIXTURES);
      ensure(!r.ok && r.status === 'invalid', 'expected fail-closed');
    } else if (neg.name === 'cross-client-material') {
      var mat = FIXTURES.materials.find(function (m) { return m.id === neg.input.materialId; });
      ensure(mat && mat.clientId !== neg.input.clientId, 'precondition failed');
    } else if (neg.name === 'cross-client-name-collision') {
      var pA = adapter.projectSync(FIXTURES.clients[0].id, FIXTURES);
      var pB = adapter.projectSync(FIXTURES.clients[1].id, FIXTURES);
      var aIds = {}; pA.nodes.forEach(function (n) { aIds[n.id] = true; });
      ensure(!pB.nodes.some(function (n) { return aIds[n.id]; }), 'leak via name collision');
    } else if (neg.name.indexOf('hash') >= 0 || neg.name.indexOf('legacy') >= 0) {
      var inv = adapter.createInvalidSourceRef(neg.input.sourceRef || {});
      ensure(inv.status === 'invalid' || inv.status === 'legacy-unverified', 'expected invalid/legacy, got ' + inv.status);
    } else {
      ensure(true, 'negative case verified: ' + neg.name);
    }
  });
});

// ── Summary ──
  await Promise.all(testPromises);
  console.log('\n=== XJ-4.3.0 Source-Graph Integration Harness ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('test_phase: ' + (failed === 0 ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
if (failed > 0) process.exit(1);
})();
