'use strict';
/*
 * 4.3.0 OpenSquilla Production Contract Freeze — Contract Runner
 *
 * Real-entry contract runner that loads the actual disposable prototype modules
 * from design-previews/4.3.0-opensquilla-case-atlas/ and tests the seven
 * required production contract items.
 *
 * Classification: CONFIRMED / UNSUPPORTED_EXPECTED_RED / DEGRADED / BLOCKED
 * Never calls UNSUPPORTED behavior PASS. Never creates wrapper fake APIs.
 */

const path = require('path');
const fs = require('fs');
const fixtures = require('./fixtures.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROTOTYPE_DIR = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas');
const ATLAS_PATH = path.join(PROTOTYPE_DIR, 'case-atlas-view-model.js');
const ADAPTER_PATH = path.join(PROTOTYPE_DIR, 'source-ref-adapter.js');

// ---- Real module loading ----
let atlas = null;
let adapter = null;
const prototypeLoadErrors = [];
try { atlas = require(ATLAS_PATH); } catch (e) { prototypeLoadErrors.push('case-atlas-view-model.js :: ' + e.message); }
try { adapter = require(ADAPTER_PATH); } catch (e) { prototypeLoadErrors.push('source-ref-adapter.js :: ' + e.message); }
const prototypeLoaded = !!(atlas && adapter);

const results = [];
function record(c) { results.push(c); }
function cond(b) { return b ? true : false; }

// ---- Anti-substitute guard ----
function scanNoSubstitute() {
  const needles = ['class ' + 'ViewModel', 'build' + 'ViewModel', 'derive' + 'ViewModel', 'Case' + 'Atlas' + 'ViewModel'];
  const files = ['fixtures.js', 'run-contract.js', 'mutation-probes.js'];
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const t of needles) {
      if (src.indexOf(t) !== -1) hits.push(f + ':' + t);
    }
  }
  return hits;
}

function short(v) {
  const s = JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 160) + '\u2026' : s;
}

// ============================ Fixture-level contracts ============================
const ds = fixtures.DATASET;
const structural = fixtures.validateFixtures(ds);

record({ id: 'FI-01', title: '\u5408\u6210\u4f1a\u8c08\u6570\u91cf >= 30', target: 'fixture', status: cond(fixtures.SESSIONS.length >= 30) ? 'CONFIRMED' : 'FAIL', detail: 'sessions=' + fixtures.SESSIONS.length });
record({ id: 'FI-02', title: '\u5355\u4e00\u5408\u6210 client', target: 'fixture', status: cond(ds.client && ds.client.id && !fixtures.OTHER_CLIENT.id.includes(ds.client.id)) ? 'CONFIRMED' : 'FAIL', detail: 'clientId=' + (ds.client && ds.client.id) });
record({ id: 'FI-03', title: '\u4e3b\u6570\u636e\u96c6\u7ed3\u6784\u5951\u7ea6\u901a\u8fc7', target: 'fixture', status: cond(structural.ok) ? 'CONFIRMED' : 'FAIL', detail: structural.ok ? 'ok' : JSON.stringify(structural.violations) });
record({ id: 'FI-04', title: '\u6bcf\u6761 material \u5177\u5907\u5b8c\u6574 SourceRef', target: 'fixture', status: cond(fixtures.MATERIALS.every(function(m) { return fixtures.validateFixtures({ materials: [m] }).violations.filter(function(v) { return v.indexOf('material') === 0; }).length === 0; })) ? 'CONFIRMED' : 'FAIL', detail: 'materials=' + fixtures.MATERIALS.length });
record({ id: 'FI-05', title: '\u7763\u5bfc\u8bb0\u5f55\u5177\u5907\u5b8c\u6574 SourceRef', target: 'fixture', status: cond(fixtures.SUPERVISION.length > 0 && fixtures.SUPERVISION.every(function(s) { return s.sourceRef && s.sourceRef.id && s.sourceRef.sourceContentHash && s.sourceRef.anchorContentHash; })) ? 'CONFIRMED' : 'FAIL', detail: 'supervision=' + fixtures.SUPERVISION.length });
record({ id: 'FI-06', title: 'ClinicalActionRun \u8349\u7a3f: status=draft', target: 'fixture', status: cond(fixtures.CLINICAL_ACTION_DRAFTS.length > 0 && fixtures.CLINICAL_ACTION_DRAFTS.every(function(c) { return c.status === 'draft' && !!c.clinicalActionRunId; })) ? 'CONFIRMED' : 'FAIL', detail: 'drafts=' + fixtures.CLINICAL_ACTION_DRAFTS.length });
record({ id: 'FI-07', title: '\u8986\u76d6\u5931\u6548\u6001: invalid/quarantine/expired', target: 'fixture', status: cond(['invalid', 'quarantine', 'expired'].every(function(s) { return fixtures.MATERIALS.some(function(m) { return m.sourceRef.status === s; }); })) ? 'CONFIRMED' : 'FAIL', detail: 'statuses=' + JSON.stringify(Array.from(new Set(fixtures.MATERIALS.map(function(m) { return m.sourceRef.status; })))) });
record({ id: 'FI-08', title: '\u8986\u76d6\u6765\u6e90\u7248\u672c\u53d8\u5316 (sourceHistory)', target: 'fixture', status: cond(fixtures.SESSIONS.some(function(s) { return Array.isArray(s.sourceRef.sourceHistory) && s.sourceRef.sourceHistory.length > 1; })) ? 'CONFIRMED' : 'FAIL', detail: 'session 12 \u542b sourceHistory' });
record({ id: 'FI-09', title: '\u65ad\u94fe\u6750\u6599\u573a\u666f\u5b58\u5728', target: 'fixture', status: cond(fixtures.detectBrokenLinks(ds).length === 1) ? 'CONFIRMED' : 'FAIL', detail: 'broken=' + JSON.stringify(fixtures.detectBrokenLinks(ds)) });

// ---- Anti-substitute guard ----
var subHits = scanNoSubstitute();
record({ id: 'GUARD-01', title: '\u672a\u521b\u5efa prototype \u590d\u5236\u5b9e\u73b0', target: 'fixture', status: cond(subHits.length === 0) ? 'CONFIRMED' : 'FAIL', detail: subHits.length ? 'forbidden tokens: ' + JSON.stringify(subHits) : 'clean' });

// ============================ Negative fixture contracts ============================
(function () {
  var bad = JSON.parse(JSON.stringify(ds));
  delete bad.sessions[0].sourceRef.sourceContentHash;
  var r = fixtures.validateFixtures(bad);
  record({ id: 'NF-01', title: '\u7f3a sourceContentHash \u7684\u4f1a\u8c08\u88ab\u6355\u83b7', target: 'fixture', status: cond(!r.ok && r.violations.some(function(v) { return v.indexOf('sourceContentHash') >= 0; })) ? 'CONFIRMED' : 'FAIL', detail: r.ok ? '\u672a\u88ab\u6355\u83b7' : '\u6355\u83b7: ' + r.violations.find(function(v) { return v.indexOf('sourceContentHash') >= 0; }) });
})();
(function () {
  var bad = JSON.parse(JSON.stringify(ds));
  bad.sessions[1].clientId = fixtures.OTHER_CLIENT.id;
  var r = fixtures.validateFixtures(bad);
  record({ id: 'NF-02', title: '\u9519 client \u7684\u4f1a\u8c08\u88ab\u6355\u83b7', target: 'fixture', status: cond(!r.ok && r.violations.some(function(v) { return v.indexOf('clientId') >= 0; })) ? 'CONFIRMED' : 'FAIL', detail: r.ok ? '\u672a\u88ab\u6355\u83b7' : '\u6355\u83b7: ' + r.violations.find(function(v) { return v.indexOf('clientId') >= 0; }) });
})();
(function () {
  var bad = JSON.parse(JSON.stringify(ds));
  bad.sessions.splice(0, 25);
  var r = fixtures.validateFixtures(bad);
  record({ id: 'NF-03', title: '\u4f1a\u8c08\u6570\u91cf < 30 \u88ab\u6355\u83b7', target: 'fixture', status: cond(!r.ok && r.violations.some(function(v) { return v.indexOf('count') >= 0; })) ? 'CONFIRMED' : 'FAIL', detail: r.ok ? '\u672a\u88ab\u6355\u83b7' : '\u6355\u83b7: ' + r.violations.find(function(v) { return v.indexOf('count') >= 0; }) });
})();
(function () {
  var bad = JSON.parse(JSON.stringify(ds));
  bad.sessions.push(JSON.parse(JSON.stringify(fixtures.ADVERSARIAL.wrongClientSession)));
  var r = fixtures.validateFixtures(bad);
  record({ id: 'NF-04', title: '\u8de8\u4e2a\u6848\u6c61\u67d3\u88ab\u6355\u83b7', target: 'fixture', status: cond(!r.ok && r.violations.some(function(v) { return v.indexOf('clientId') >= 0; })) ? 'CONFIRMED' : 'FAIL', detail: r.ok ? '\u672a\u88ab\u6355\u83b7' : '\u6355\u83b7: \u8de8 client \u4f1a\u8c08\u88ab\u62d2\u7edd' });
})();

// ============================ Prototype integration contracts ============================
function piRecord(id, title, call, fn) {
  if (!prototypeLoaded) {
    record({ id: id, title: title, target: 'prototype', ran: false, call: call, status: 'BLOCKED', detail: 'prototype \u52a0\u8f7d\u5931\u8d25: ' + JSON.stringify(prototypeLoadErrors) });
    return;
  }
  try {
    var r = fn();
    record({ id: id, title: title, target: 'prototype', ran: true, call: call, status: r.status, observed: r.observed, detail: r.detail || '' });
  } catch (e) {
    record({ id: id, title: title, target: 'prototype', ran: true, call: call, status: 'FAIL', observed: 'unexpected throw', detail: '\u975e\u9884\u671f\u5f02\u5e38: ' + e.message });
  }
}

// PI-00
piRecord('PI-00', '\u771f\u5b9e\u52a0\u8f7d prototype \u6a21\u5757', 'require(case-atlas-view-model.js) / require(source-ref-adapter.js)', function () {
  var ak = Object.keys(adapter);
  var vk = Object.keys(atlas);
  var ok = typeof atlas.createViewModel === 'function' && typeof atlas.validateViewModel === 'function' && typeof atlas.filterNodes === 'function'
    && typeof adapter.createAtlasSourceRef === 'function' && typeof adapter.verifyAtlasSourceRef === 'function' && typeof adapter.isStale === 'function'
    && typeof adapter.quarantineSourceRef === 'function' && typeof adapter.needsCacheInvalidation === 'function' && typeof adapter.rejectAiEdgePersistence === 'function';
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'atlas=' + vk.join(',') + ' | adapter=' + ak.join(',') };
});

// PI-01
piRecord('PI-01', 'createViewModel \u6b63\u5e38\u8f93\u5165', 'atlas.createViewModel(toPrototypeInput()); atlas.validateViewModel(vm)', function () {
  var input = fixtures.toPrototypeInput();
  var before = JSON.stringify(input);
  var vm = atlas.createViewModel(input);
  var inputUntouched = JSON.stringify(input) === before;
  var v = atlas.validateViewModel(vm);
  var snap = { normalizationVersion: vm.normalizationVersion, sourceVersion: vm.sourceVersion, clientId: vm.client.id };
  var invalidated = adapter.needsCacheInvalidation(snap, { sourceVersion: 'synthetic-002', clientId: vm.client.id }) === true;
  var kept = adapter.needsCacheInvalidation(snap, { sourceVersion: vm.sourceVersion, clientId: vm.client.id }) === false;
  var ok = vm.stats.totalSessions === 54 && vm.timeline.length === 54 && v.ok === true && inputUntouched && invalidated && kept;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'totalSessions=' + vm.stats.totalSessions + ' nodes=' + vm.stats.totalNodes + ' edges=' + vm.stats.totalEdges + ' validate.ok=' + v.ok + ' inputUntouched=' + inputUntouched, detail: v.ok ? '' : short(v.issues) };
});

// PI-02
piRecord('PI-02', '\u7a7a client \u5931\u8d25\u5173\u95ed', 'atlas.createViewModel({...input, client:null})', function () {
  var threw = false, msg = '';
  try { atlas.createViewModel(Object.assign(fixtures.toPrototypeInput(), { client: null })); } catch (e) { threw = true; msg = e.message; }
  return { status: threw && /client/.test(msg) ? 'CONFIRMED' : 'FAIL', observed: 'threw=' + threw + ' msg=' + msg };
});

// PC-01 Contract item 1
piRecord('PC-01', '\u5951\u7ea6\u98791: Async loadClient unknown-client fail-closed', 'atlas.createViewModel({...input, client:{id:cli-unknown}}); typeof atlas.loadClient', function () {
  var input = fixtures.toPrototypeInput();
  input.client = { id: fixtures.ADVERSARIAL.unknownClientId, name: '\u672a\u77e5\u5408\u6210client', status: 'active' };
  var vm = atlas.createViewModel(input);
  var accepted = vm.client.id === fixtures.ADVERSARIAL.unknownClientId;
  var apiMissing = typeof atlas.loadClient === 'undefined' && typeof adapter.loadClient === 'undefined';
  return {
    status: accepted && apiMissing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: 'createViewModel \u63a5\u53d7\u4e86 unknown client; typeof loadClient=undefined',
    detail: '\u751f\u4ea7\u5951\u7ea6: loadClient(clientId)\u2192Promise, \u672a\u77e5 client \u5931\u8d25\u5173\u95ed. \u5f53\u524d prototype \u65e0\u8be5 API, \u5c5e\u5b9e\u6d4b\u7f3a\u53e3, \u4e0d\u4f2a\u9020\u62d2\u7edd\u884c\u4e3a',
  };
});

// PC-02 Contract item 2
piRecord('PC-02', '\u5951\u7ea6\u98792: Registered-session validation or quarantine', 'input.supervisions[0].sessionId=ses-unknown; atlas.createViewModel(input)', function () {
  var input = fixtures.toPrototypeInput();
  input.supervisions[0].sessionId = fixtures.ADVERSARIAL.unknownSessionId;
  var vm = atlas.createViewModel(input);
  var svNode = vm.nodes.find(function (n) { return n.type === 'supervision' && n.sessionId === fixtures.ADVERSARIAL.unknownSessionId; });
  var accepted = !!svNode;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u672a\u77e5 sessionId \u7684\u7763\u5bfc\u8282\u70b9\u4ecd\u88ab\u6784\u5efa, \u65e0 session \u6ce8\u518c\u8868\u6821\u9a8c',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u8282\u70b9\u6784\u5efa\u5fc5\u987b\u5bf9\u7167\u4f1a\u8c08\u6ce8\u518c\u8868, \u672a\u77e5 sessionId \u5931\u8d25\u5173\u95ed\u6216 quarantine',
  };
});

// PC-03 Contract item 3
piRecord('PC-03', '\u5951\u7ea6\u98793: Expired/invalid/quarantined material filtering', 'input.materials \u542b sourceStatus=expired/invalid/quarantine; atlas.createViewModel(input)', function () {
  var input = fixtures.toPrototypeInput();
  var vm = atlas.createViewModel(input);
  var badIds = input.materials.filter(function (m) { return m.sourceStatus !== 'valid'; }).map(function (m) { return 'material/' + m.id; });
  var builtBad = vm.nodes.filter(function (n) { return n.sourceRef && n.sourceRef.anchor && badIds.indexOf(n.sourceRef.anchor.locator) >= 0; });
  var accepted = builtBad.length === badIds.length;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u5931\u6548\u6001\u6750\u6599 ' + badIds.length + ' \u4efd\u5168\u90e8\u88ab\u6784\u5efa\u4e3a\u8282\u70b9, \u7ba1\u7ebf\u672a\u8bfb\u53d6\u5931\u6548\u72b6\u6001',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u7ba1\u7ebf\u5fc5\u987b\u8bfb\u53d6\u6765\u6e90\u5931\u6548\u72b6\u6001, expired/invalid \u62d2\u7edd, quarantine \u9694\u79bb\u6d41',
  };
});

// PC-04 Contract item 4
piRecord('PC-04', '\u5951\u7ea6\u98794: SourceRef.verify anchor validation before material admission', 'atlas.createViewModel(input) \u5bf9 mat-prod-0008 \u91cd\u7b97\u54c8\u5e0c', function () {
  var input = fixtures.toPrototypeInput();
  var vm = atlas.createViewModel(input);
  var node = vm.nodes.find(function (n) { return n.sourceRef && n.sourceRef.anchor && n.sourceRef.anchor.locator === 'material/mat-prod-0008'; });
  var brokenOriginal = fixtures.detectBrokenLinks(fixtures.DATASET).indexOf('mat-prod-0008') >= 0;
  var rebuiltNotRejected = !!node && node.sourceRef.sourceContentHash !== '' && brokenOriginal;
  return {
    status: rebuiltNotRejected ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u65ad\u94fe\u6750\u6599\u8282\u70b9\u4ecd\u88ab\u6784\u5efa, \u7ba1\u7ebf\u91cd\u7b97\u54c8\u5e0c\u4e0d\u6821\u9a8c originalAnchorContentHash',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u6750\u6599\u5bfc\u5165\u5fc5\u987b\u5148\u4ee5 SourceRef.verify \u6821\u9a8c anchorContentHash, \u65ad\u94fe\u5931\u8d25\u5173\u95ed',
  };
});

// PC-05 Contract item 5
piRecord('PC-05', '\u5951\u7ea6\u98795: AI-edge persistence denied; draft save requires human confirmation', 'adapter.rejectAiEdgePersistence(aiEdge); adapter.isAiEdge(...)', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var aiEdges = vm.edges.filter(function (e) { return e.previewOnly === true; });
  var rejAi = adapter.rejectAiEdgePersistence(aiEdges[0] || { type: 'ai-inference' });
  var rejPlain = adapter.rejectAiEdgePersistence({ id: 'edge_plain' });
  var isAi = adapter.isAiEdge({ type: 'ai-inference' }) === true && adapter.isAiEdge({ previewOnly: true }) === true && adapter.isAiEdge({ id: 'x' }) === false;
  var v = atlas.validateViewModel(vm);
  var persistAiMissing = typeof atlas.persistAIEdge === 'undefined' && typeof adapter.persistAIEdge === 'undefined';
  var saveDraftMissing = typeof atlas.saveDraft === 'undefined' && typeof adapter.saveDraft === 'undefined';
  var ok = aiEdges.length === 1 && rejAi.ok === false && rejAi.reason === 'ai-edge-persistence-denied' && rejPlain.ok === false && isAi && v.ok === true && persistAiMissing && saveDraftMissing;
  return {
    status: ok ? 'CONFIRMED' : 'FAIL',
    observed: 'aiEdges=' + aiEdges.length + ' rejAi.ok=' + rejAi.ok + ' rejPlain.reason=' + rejPlain.reason + ' validate.ok=' + v.ok + ' persistMissing=' + persistAiMissing + ' saveDraftMissing=' + saveDraftMissing,
  };
});

// PC-06 Contract item 6
piRecord('PC-06', '\u5951\u7ea6\u98796: Refresh/cancellation/recovery Promise semantics', 'atlas.createViewModel(...) instanceof Promise === false; typeof atlas.refresh', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 's/t' }, sourceText: 'x' });
  var allSync = !(vm instanceof Promise) && !(adapter.verifyAtlasSourceRef(ref, 'x') instanceof Promise) && !(adapter.needsCacheInvalidation(null, {}) instanceof Promise);
  var refreshMissing = typeof atlas.refresh === 'undefined' && typeof adapter.refresh === 'undefined';
  return {
    status: allSync && refreshMissing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u5168\u90e8\u8fd4\u56de\u503c\u5747\u975e Promise; typeof refresh=undefined',
    detail: '\u751f\u4ea7\u5951\u7ea6: refresh(snapshot)\u2192Promise, \u63a5\u53d7 AbortSignal, \u5931\u8d25\u6062\u590d, \u9632 stale \u8de8 client \u5199\u5165',
  };
});

// PC-07 Contract item 7
piRecord('PC-07', '\u5951\u7ea6\u98797: verifyAtlasSourceRef using independent current context', 'adapter.verifyAtlasSourceRef({...ref, clientId:cli-9999}, sameText)', function () {
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PC07' });
  var swapped = Object.assign({}, ref, { clientId: fixtures.OTHER_CLIENT.id });
  var r = adapter.verifyAtlasSourceRef(swapped, '\u5408\u6210\u6765\u6e90\u6587\u672c-PC07');
  var degradedConfirmed = r.verified === true && r.status === 'unchanged';
  var directVerify = adapter.SourceRef.verify(ref, { clientId: fixtures.OTHER_CLIENT.id, sessionId: ref.sessionId, anchor: ref.anchor, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PC07' });
  var directCatch = directVerify.status === 'ambiguous' && directVerify.reason === 'client-mismatch' && directVerify.verified === false;
  return {
    status: degradedConfirmed && directCatch ? 'DEGRADED' : 'FAIL',
    observed: 'swappedClient verify=' + short(r) + ' | SourceRef.verify(wrongClient)=' + directVerify.status + '/' + directVerify.reason,
    detail: '\u5305\u88c5\u51fd\u6570\u4ece ref \u81ea\u8eab\u590d\u5236 clientId \u2192 \u7be1\u6539\u540e\u4ecd verified=true (DEGRADED). SourceRef.verify \u771f\u5b9e\u6355\u83b7 client-mismatch. \u751f\u4ea7\u5951\u7ea6: verifyAtlasSourceRef \u5fc5\u987b\u63a5\u53d7\u72ec\u7acb currentContext \u53c2\u6570',
  };
});

// PI-03
piRecord('PI-03', '\u5c11\u4e8e 30 \u8282\u5931\u8d25\u5173\u95ed', 'atlas.createViewModel({sessions:29}); atlas.validateViewModel(vm{timeline:5})', function () {
  var input = fixtures.toPrototypeInput();
  input.sessions = input.sessions.slice(0, 29);
  var threw = false, msg = '';
  try { atlas.createViewModel(input); } catch (e) { threw = true; msg = e.message; }
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var bad = JSON.parse(JSON.stringify(vm));
  bad.timeline = bad.timeline.slice(0, 5);
  var v = atlas.validateViewModel(bad);
  var flagged = !v.ok && v.issues.some(function (i) { return i.indexOf('fewer than 30') >= 0; });
  return { status: threw && /minimum 30/.test(msg) && flagged ? 'CONFIRMED' : 'FAIL', observed: 'threw=' + threw + ' msg=' + msg + ' | validate flagged=' + flagged };
});

// PI-04
piRecord('PI-04', '\u574f node \u5931\u8d25\u5173\u95ed', 'vmBad.nodes[0].type=hacked; delete vmBad.nodes[1].sourceRef.sourceContentHash', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var bad = JSON.parse(JSON.stringify(vm));
  bad.nodes[0].type = 'hacked';
  delete bad.nodes[1].sourceRef.sourceContentHash;
  var v = atlas.validateViewModel(bad);
  var typeFlag = v.issues.some(function (i) { return i.indexOf('type invalid') >= 0; });
  var hashFlag = v.issues.some(function (i) { return i.indexOf('sourceContentHash missing') >= 0; });
  return { status: !v.ok && typeFlag && hashFlag ? 'CONFIRMED' : 'FAIL', observed: 'ok=' + v.ok + ' typeFlag=' + typeFlag + ' hashFlag=' + hashFlag, detail: short(v.issues.slice(0, 3)) };
});

// PI-05
piRecord('PI-05', 'AI \u751f\u6210\u8fb9\u4ec5\u9884\u89c8; rejectAiEdgePersistence \u62d2\u7edd\u4e00\u5207\u6301\u4e45\u5316', 'adapter.rejectAiEdgePersistence(aiEdge); adapter.isAiEdge(...)', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var aiEdges = vm.edges.filter(function (e) { return e.previewOnly === true; });
  var rejAi = adapter.rejectAiEdgePersistence(aiEdges[0] || { type: 'ai-inference' });
  var rejPlain = adapter.rejectAiEdgePersistence({ id: 'edge_plain' });
  var isAi = adapter.isAiEdge({ type: 'ai-inference' }) === true && adapter.isAiEdge({ previewOnly: true }) === true && adapter.isAiEdge({ id: 'x' }) === false;
  var v = atlas.validateViewModel(vm);
  var ok = aiEdges.length === 1 && rejAi.ok === false && rejAi.reason === 'ai-edge-persistence-denied' && rejPlain.ok === false && isAi && v.ok === true;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'aiEdges=' + aiEdges.length + ' rejAi.ok=' + rejAi.ok + ' rejPlain.reason=' + rejPlain.reason + ' validate.ok=' + v.ok };
});

// PI-06
piRecord('PI-06', 'filterNodes: \u7c7b\u578b/confirmed/ai-draft/query \u8fc7\u6ee4', 'atlas.filterNodes(nodes,quote|confirmed|ai-draft|all,\u7763\u5bfc)', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var nodes = vm.nodes;
  var lenBefore = nodes.length;
  var quotes = atlas.filterNodes(nodes, 'quote');
  var allNodes = atlas.filterNodes(nodes, 'all');
  var confirmed = atlas.filterNodes(nodes, 'confirmed');
  var drafts = atlas.filterNodes(nodes, 'ai-draft');
  var queried = atlas.filterNodes(nodes, 'all', '\u7763\u5bfc');
  var crafted = nodes.map(function (n, i) { return i === 0 ? Object.assign({}, n, { isAiDraft: true, isConfirmed: false }) : n; });
  var confirmed2 = atlas.filterNodes(crafted, 'confirmed');
  var drafts2 = atlas.filterNodes(crafted, 'ai-draft');
  var ok = quotes.length === 54 && quotes.every(function (n) { return n.type === 'quote'; })
    && allNodes.length === lenBefore && confirmed.length === lenBefore && drafts.length === 0
    && queried.length >= 2 && queried.every(function (n) { return (n.label + n.summary).indexOf('\u7763\u5bfc') >= 0; })
    && confirmed2.length === lenBefore - 1 && drafts2.length === 1
    && nodes.length === lenBefore;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'quote=' + quotes.length + ' all=' + allNodes.length + ' confirmed=' + confirmed.length + ' ai-draft=' + drafts.length + ' query=' + queried.length + ' crafted(confirmed=' + confirmed2.length + ',draft=' + drafts2.length + ') inputLenUnchanged=' + (nodes.length === lenBefore) };
});

// PI-07
piRecord('PI-07', 'createAtlasSourceRef: \u6b63\u5e38\u8f93\u5165\u5168\u5b57\u6bb5; \u7f3a clientId / \u7edd\u5bf9\u8def\u5f84 \u629b\u9519', 'adapter.createAtlasSourceRef({...}); (no clientId); (locator:C:\\evil)', function () {
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI07' });
  var fields = ['id', 'schemaVersion', 'clientId', 'sessionId', 'anchor', 'normalizationVersion', 'sourceVersion', 'sourceContentHash', 'anchorContentHash', 'capturedAt'];
  var full = fields.every(function (f) { return ref[f] !== undefined && ref[f] !== null && ref[f] !== ''; });
  var threwNoClient = false;
  try { adapter.createAtlasSourceRef({ sessionId: 's', anchor: { kind: 'quote', locator: 'a/b' }, sourceText: 'x' }); } catch (e) { threwNoClient = true; }
  var threwAbs = false;
  try { adapter.createAtlasSourceRef({ clientId: 'c', sessionId: 's', anchor: { kind: 'quote', locator: 'C:\\evil\\path' }, sourceText: 'x' }); } catch (e) { threwAbs = true; }
  var ok = full && ref.id.indexOf('sr:') === 0 && threwNoClient && threwAbs;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'fields=' + full + ' id=' + ref.id.slice(0, 18) + ' threwNoClient=' + threwNoClient + ' threwAbs=' + threwAbs };
});

// PI-08
piRecord('PI-08', 'verifyAtlasSourceRef + isStale: \u4e0d\u53d8/\u53d8\u5316/\u65ad\u94fe \u4e09\u6001', 'adapter.verifyAtlasSourceRef(ref, sameText|changedText); adapter.isStale(...)', function () {
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI08' });
  var same = adapter.verifyAtlasSourceRef(ref, '\u5408\u6210\u6765\u6e90\u6587\u672c-PI08');
  var changed = adapter.verifyAtlasSourceRef(ref, '\u5408\u6210\u6765\u6e90\u6587\u672c-PI08\u3010\u5df2\u88ab\u7be1\u6539\u3011');
  var refFrag = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript', fragment: '\u5173\u952e\u7247\u6bb5\u7532' }, sourceText: '\u524d\u6587 \u5173\u952e\u7247\u6bb5\u7532 \u540e\u6587' });
  var broken = adapter.verifyAtlasSourceRef(refFrag, '\u5b8c\u5168\u65e0\u5173\u7684\u65b0\u6587\u672c');
  var staleTrue = adapter.isStale(ref, '\u5408\u6210\u6765\u6e90\u6587\u672c-PI08\u3010\u5df2\u88ab\u7be1\u6539\u3011') === true;
  var staleFalse = adapter.isStale(ref, '\u5408\u6210\u6765\u6e90\u6587\u672c-PI08') === false;
  var ok = same.status === 'unchanged' && same.verified === true
    && changed.status === 'warning' && changed.verified === false
    && broken.status === 'changed' && broken.verified === false
    && staleTrue && staleFalse;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'same=' + same.status + '/' + same.verified + ' changed=' + changed.status + '/' + changed.verified + ' broken=' + broken.status + '/' + broken.verified + ' isStale(changed)=' + staleTrue + ' isStale(same)=' + !staleFalse };
});

// PI-09
piRecord('PI-09', '\u9519 client/session: SourceRef.verify \u8fd4\u56de ambiguous', 'adapter.SourceRef.verify(ref, {clientId:cli-9999,...}); (sessionId mismatch)', function () {
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI09' });
  var wrongClient = adapter.SourceRef.verify(ref, { clientId: fixtures.OTHER_CLIENT.id, sessionId: ref.sessionId, anchor: ref.anchor, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI09' });
  var wrongSession = adapter.SourceRef.verify(ref, { clientId: ref.clientId, sessionId: 'ses-unknown-9999', anchor: ref.anchor, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI09' });
  var ok = wrongClient.status === 'ambiguous' && wrongClient.reason === 'client-mismatch' && wrongClient.verified === false
    && wrongSession.status === 'ambiguous' && wrongSession.reason === 'session-mismatch' && wrongSession.verified === false;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'wrongClient=' + short(wrongClient) + ' wrongSession=' + wrongSession.status + '/' + wrongSession.reason };
});

// PI-10
piRecord('PI-10', 'quarantineSourceRef: \u9694\u79bb\u6001\u5b8c\u6574\u4e14\u4e0d\u53d8\u5f02\u539f ref', 'adapter.quarantineSourceRef(ref, unknown-client)', function () {
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '\u5408\u6210\u6765\u6e90\u6587\u672c-PI10' });
  var q = adapter.quarantineSourceRef(ref, 'unknown-client');
  var qDefault = adapter.quarantineSourceRef(ref);
  var ok = q.status === 'quarantined' && q.verified === false && q.quarantineReason === 'unknown-client' && !!q.quarantinedAt
    && qDefault.quarantineReason === 'source-deleted-or-invalid'
    && ref.status === undefined && ref.verified === undefined;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'q=' + q.status + '/' + q.quarantineReason + '/verified=' + q.verified + ' originalUntouched=' + (ref.status === undefined) };
});

// PI-11
piRecord('PI-11', 'needsCacheInvalidation \u77e9\u9635', 'adapter.needsCacheInvalidation(snapshot, current) x6', function () {
  var base = { normalizationVersion: adapter.NORMALIZATION_VERSION, sourceVersion: 'synthetic-001', clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id };
  var cur = { sourceVersion: 'synthetic-001', clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id };
  var rNull = adapter.needsCacheInvalidation(null, cur) === true;
  var rNorm = adapter.needsCacheInvalidation(Object.assign({}, base, { normalizationVersion: '\u65e7\u7248\u672c' }), cur) === true;
  var rSrc = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { sourceVersion: 'synthetic-002' })) === true;
  var rCli = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { clientId: fixtures.OTHER_CLIENT.id })) === true;
  var rSes = adapter.needsCacheInvalidation(base, Object.assign({}, cur, { sessionId: 'ses-prod-0001-02' })) === true;
  var rSame = adapter.needsCacheInvalidation(base, cur) === false;
  var ok = rNull && rNorm && rSrc && rCli && rSes && rSame;
  return { status: ok ? 'CONFIRMED' : 'FAIL', observed: 'null=' + rNull + ' normVer=' + rNorm + ' srcVer=' + rSrc + ' client=' + rCli + ' session=' + rSes + ' same->false=' + rSame };
});

// PI-12
piRecord('PI-12', 'unknown session \u65e0\u6ce8\u518c\u8868\u6821\u9a8c', 'input.supervisions[0].sessionId=ses-unknown; atlas.createViewModel(input)', function () {
  var input = fixtures.toPrototypeInput();
  input.supervisions[0].sessionId = fixtures.ADVERSARIAL.unknownSessionId;
  var vm = atlas.createViewModel(input);
  var svNode = vm.nodes.find(function (n) { return n.type === 'supervision' && n.sessionId === fixtures.ADVERSARIAL.unknownSessionId; });
  var accepted = !!svNode;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u672a\u77e5 sessionId \u7684\u7763\u5bfc\u8282\u70b9\u4ecd\u88ab\u6784\u5efa, \u65e0 session \u6ce8\u518c\u8868\u6821\u9a8c',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u8282\u70b9\u6784\u5efa\u5fc5\u987b\u5bf9\u7167\u4f1a\u8c08\u6ce8\u518c\u8868, \u672a\u77e5 sessionId \u5931\u8d25\u5173\u95ed\u6216 quarantine',
  };
});

// PI-13
piRecord('PI-13', '\u5931\u6548\u6001 material \u672a\u88ab\u7ba1\u7ebf\u8fc7\u6ee4', 'input.materials \u542b sourceStatus=expired/invalid/quarantine; atlas.createViewModel(input)', function () {
  var input = fixtures.toPrototypeInput();
  var vm = atlas.createViewModel(input);
  var badIds = input.materials.filter(function (m) { return m.sourceStatus !== 'valid'; }).map(function (m) { return 'material/' + m.id; });
  var builtBad = vm.nodes.filter(function (n) { return n.sourceRef && n.sourceRef.anchor && badIds.indexOf(n.sourceRef.anchor.locator) >= 0; });
  var accepted = builtBad.length === badIds.length;
  return {
    status: accepted ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u5931\u6548\u6001\u6750\u6599 ' + badIds.length + ' \u4efd\u5168\u90e8\u88ab\u6784\u5efa\u4e3a\u8282\u70b9, \u7ba1\u7ebf\u672a\u8bfb\u53d6\u5931\u6548\u72b6\u6001',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u7ba1\u7ebf\u5fc5\u987b\u8bfb\u53d6\u6765\u6e90\u5931\u6548\u72b6\u6001, expired/invalid \u62d2\u7edd, quarantine \u9694\u79bb\u6d41',
  };
});

// PI-14
piRecord('PI-14', '\u65ad\u94fe material \u7ba1\u7ebf\u7ea7\u81ea\u52a8\u62d2\u7edd\u7f3a\u5931', 'atlas.createViewModel(input) \u5bf9 mat-prod-0008 \u91cd\u7b97\u54c8\u5e0c', function () {
  var input = fixtures.toPrototypeInput();
  var vm = atlas.createViewModel(input);
  var node = vm.nodes.find(function (n) { return n.sourceRef && n.sourceRef.anchor && n.sourceRef.anchor.locator === 'material/mat-prod-0008'; });
  var brokenOriginal = fixtures.detectBrokenLinks(fixtures.DATASET).indexOf('mat-prod-0008') >= 0;
  var rebuiltNotRejected = !!node && node.sourceRef.sourceContentHash !== '' && brokenOriginal;
  return {
    status: rebuiltNotRejected ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u65ad\u94fe\u6750\u6599\u8282\u70b9\u4ecd\u88ab\u6784\u5efa, \u7ba1\u7ebf\u91cd\u7b97\u54c8\u5e0c\u4e0d\u6821\u9a8c originalAnchorContentHash',
    detail: '\u751f\u4ea7\u5951\u7ea6: \u6750\u6599\u5bfc\u5165\u5fc5\u987b\u5148\u4ee5 SourceRef.verify \u6821\u9a8c anchorContentHash, \u65ad\u94fe\u5931\u8d25\u5173\u95ed',
  };
});

// PI-15
piRecord('PI-15', '\u7f3a hash \u8282\u70b9\u5931\u8d25\u5173\u95ed', 'input.sessions[3].transcript=; notes=; atlas.validateViewModel(atlas.createViewModel(input))', function () {
  var input = fixtures.toPrototypeInput();
  input.sessions[3].transcript = '';
  input.sessions[3].notes = '';
  var vm = atlas.createViewModel(input);
  var v = atlas.validateViewModel(vm);
  var flagged = !v.ok && v.issues.some(function (i) { return i.indexOf('sourceContentHash missing') >= 0; }) && v.issues.some(function (i) { return i.indexOf('anchorContentHash missing') >= 0; });
  return { status: flagged ? 'CONFIRMED' : 'FAIL', observed: 'validate.ok=' + v.ok + ' issues=' + v.issues.length + ' \u999c\u6761=' + (v.issues[0] || '') };
});

// PI-16
piRecord('PI-16', '\u7f3a\u5931 API \u8bc1\u636e: loadClient/refresh/persistAIEdge/saveDraft \u5747\u4e0d\u5b58\u5728', 'typeof atlas.loadClient / atlas.refresh / adapter.persistAIEdge / atlas.saveDraft', function () {
  var missing = {
    'atlas.loadClient': typeof atlas.loadClient,
    'atlas.refresh': typeof atlas.refresh,
    'adapter.persistAIEdge': typeof adapter.persistAIEdge,
    'atlas.saveDraft': typeof atlas.saveDraft,
    'adapter.saveDraft': typeof adapter.saveDraft,
  };
  var allMissing = Object.keys(missing).every(function (k) { return missing[k] === 'undefined'; });
  return {
    status: allMissing ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: short(missing),
    detail: '\u751f\u4ea7\u5951\u7ea6: loadClient\u2192Promise, refresh\u2192Promise, persistAIEdge \u4e0d\u5b58\u5728\u6216\u6c38\u4e45\u62d2\u7edd, saveDraft \u9700\u663e\u5f0f\u4eba\u5de5\u786e\u8ba4',
  };
});

// PI-17
piRecord('PI-17', '\u5f02\u6b65\u8bed\u4e49\u7f3a\u5931: \u5168\u90e8\u5165\u53e3\u540c\u6b65\u8fd4\u56de', 'atlas.createViewModel(...) instanceof Promise === false', function () {
  var vm = atlas.createViewModel(fixtures.toPrototypeInput());
  var ref = adapter.createAtlasSourceRef({ clientId: fixtures.CLIENT.id, sessionId: fixtures.SESSIONS[0].id, anchor: { kind: 'quote', locator: 's/t' }, sourceText: 'x' });
  var allSync = !(vm instanceof Promise) && !(adapter.verifyAtlasSourceRef(ref, 'x') instanceof Promise) && !(adapter.needsCacheInvalidation(null, {}) instanceof Promise);
  return {
    status: allSync ? 'UNSUPPORTED_EXPECTED_RED' : 'FAIL',
    observed: '\u5168\u90e8\u8fd4\u56de\u503c\u5747\u975e Promise (createViewModel/verifyAtlasSourceRef/needsCacheInvalidation \u5b9e\u6d4b)',
    detail: '\u751f\u4ea7\u5951\u7ea6: refresh(snapshot)\u2192Promise, \u63a5\u53d7 AbortSignal, \u5931\u8d25\u6062\u590d, \u9632 stale \u8de8 client \u5199\u5165',
  };
});

// ============================ Summary ============================
var counts = { CONFIRMED: 0, UNSUPPORTED_EXPECTED_RED: 0, DEGRADED: 0, BLOCKED: 0, FAIL: 0 };
for (var i = 0; i < results.length; i++) { counts[results[i].status] = (counts[results[i].status] || 0) + 1; }

var anyFail = counts.FAIL > 0;
console.log('=== 4.3.0 OpenSquilla Production Contract Freeze \u2014 Contract Results ===');
console.log('\u771f\u5b9e\u52a0\u8f7d\u5165\u53e3: ' + (prototypeLoaded ? ATLAS_PATH + ' , ' + ADAPTER_PATH : '\u52a0\u8f7d\u5931\u8d25'));
if (prototypeLoadErrors.length) console.log('prototype \u52a0\u8f7d\u9519\u8bef: ' + JSON.stringify(prototypeLoadErrors));
console.log('\u7528\u4f8b\u603b\u6570=' + results.length + '  ' + JSON.stringify(counts));
for (var j = 0; j < results.length; j++) {
  var r = results[j];
  var ranTag = r.target === 'prototype' ? ' ran=' + !!r.ran : '';
  console.log('[' + r.status + '] ' + r.id + ' ' + r.title + ranTag);
  if (r.call) console.log('    call: ' + r.call);
  if (r.observed) console.log('    observed: ' + r.observed);
  if (r.detail) console.log('    detail: ' + r.detail);
}
console.log('FAIL=' + counts.FAIL + '  UNSUPPORTED_EXPECTED_RED=' + counts.UNSUPPORTED_EXPECTED_RED + '  DEGRADED=' + counts.DEGRADED);

process.exit(anyFail ? 1 : 0);
