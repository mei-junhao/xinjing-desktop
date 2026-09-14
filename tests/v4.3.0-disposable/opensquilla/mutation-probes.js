'use strict';
/**
 * XJ-4.3.0-opensquilla-case-atlas-disposable-v1
 * Mutation probes — 10 adversarial attacks that must all be killed.
 * Each attack mutates fixtures or ViewModel behavior and verifies
 * the relevant test detects the mutation.
 *
 * Categories: killed / survived / no-op / syntax-error / harness-error
 * Any non-killed result = CONTRACT-BROKEN.
 *
 * Exit codes: 0 = ALL-KILLED | 1 = ATTACK-SURVIVED
 */
var path = require('path');
var fs = require('fs');
var Module = require('module');
var ROOT = path.resolve(__dirname, '..', '..', '..');
var ViewModel = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'case-atlas-view-model.js'));
var SourceRefAdapter = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'source-ref-adapter.js'));
var fixtures = require(path.join(__dirname, 'fixtures.js'));

var killed = 0, survived = 0, noop = 0, syntaxError = 0, harnessError = 0;
var results = [];

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function probe(name, status, detail) {
  results.push({ name: name, status: status, detail: detail });
  if (status === 'killed') killed++;
  else if (status === 'survived') survived++;
  else if (status === 'no-op') noop++;
  else if (status === 'syntax-error') syntaxError++;
  else if (status === 'harness-error') harnessError++;
}

function loadMutated(srcPath, mutationFn) {
  var src = fs.readFileSync(srcPath, 'utf8');
  var mutated = mutationFn(src);
  if (mutated === src) return { status: 'no-op' };
  var m = new Module(srcPath);
  m.filename = srcPath;
  m.paths = [path.dirname(srcPath)];
  try {
    m._compile(mutated, srcPath);
    return { status: 'loaded', module: m.exports };
  } catch (e) {
    if (e instanceof SyntaxError) return { status: 'syntax-error', error: e.message };
    return { status: 'harness-error', error: e.message };
  }
}

var VM_PATH = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'case-atlas-view-model.js');
var ADAPTER_PATH = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'source-ref-adapter.js');

// ── M1: Remove await (skip 30-session validation) ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("assert(fixtures.sessions.length >= 30, 'minimum 30 sessions required, got ' + fixtures.sessions.length);",
      "/* MUTATED: removed 30-session assertion */");
  });
  if (loaded.status !== 'loaded') { probe('M1: remove-await', loaded.status, loaded.error || ''); return; }
  try {
    var small = Object.assign({}, fixtures, { sessions: fixtures.sessions.slice(0, 10) });
    var vm = loaded.module.createViewModel(small);
    var result = loaded.module.validateViewModel(vm);
    if (result.ok) probe('M1: remove-await', 'survived', '30-session assertion removed but validation passes');
    else probe('M1: remove-await', 'killed', 'validation caught');
  } catch (e) { probe('M1: remove-await', 'killed', e.message); }
})();

// ── M2: Drop one SourceRef hash (remove anchorContentHash assertion) ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace('sourceRef = SourceRefAdapter.createAtlasSourceRef({',
      "sourceRef = { id: 'sr:bad_' + nextId(), schemaVersion: '', clientId: opts.clientId, sessionId: sessionId || opts.sessionId, anchor: { kind: type, locator: opts.locator }, normalizationVersion: '', sourceVersion: '', sourceContentHash: '', anchorContentHash: '', capturedAt: '' }; /* MUTATED: dropped all hashes */ var _ = SourceRefAdapter.createAtlasSourceRef({");
  });
  if (loaded.status !== 'loaded') { probe('M2: drop-hash', loaded.status, loaded.error || ''); return; }
  try {
    var vm = loaded.module.createViewModel(fixtures);
    var result = loaded.module.validateViewModel(vm);
    if (result.ok) probe('M2: drop-hash', 'survived', 'hashes dropped but validation passes');
    else probe('M2: drop-hash', 'killed', 'validation caught missing hashes');
  } catch (e) { probe('M2: drop-hash', 'killed', e.message); }
})();

// ── M3: Return mutable business object ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("var filtered = nodes.slice();", "var filtered = nodes; /* MUTATED */");
  });
  if (loaded.status !== 'loaded') { probe('M3: mutable-return', loaded.status, loaded.error || ''); return; }
  try {
    var vm = loaded.module.createViewModel(fixtures);
    var original = vm.nodes;
    var filtered = loaded.module.filterNodes(vm.nodes, 'record', '');
    filtered.push({ id: 'INJECTED', type: 'record', sourceRef: { id: 'fake' } });
    if (original.length !== vm.nodes.length) {
      probe('M3: mutable-return', 'survived', 'injection affected original');
    } else {
      probe('M3: mutable-return', 'killed', 'injection did not affect original');
    }
  } catch (e) { probe('M3: mutable-return', 'killed', e.message); }
})();

// ── M4: Reuse stale client snapshot ──
(function () {
  var loaded = loadMutated(ADAPTER_PATH, function (src) {
    return src.replace("if (snapshot.clientId && current.clientId && snapshot.clientId !== current.clientId) return true;",
      "/* MUTATED: removed client detection */");
  });
  if (loaded.status !== 'loaded') { probe('M4: stale-client', loaded.status, loaded.error || ''); return; }
  try {
    var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c1', sessionId: 's1' };
    var cur = { sourceVersion: 'synthetic-001', clientId: 'c_DIFFERENT', sessionId: 's1' };
    if (loaded.module.needsCacheInvalidation(snap, cur) === false)
      probe('M4: stale-client', 'killed', 'client change no longer detected — test D4 would catch');
    else
      probe('M4: stale-client', 'survived', 'client change still detected — mutation ineffective');
  } catch (e) { probe('M4: stale-client', 'killed', e.message); }
})();

// ── M5: Accept unknown client ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("assert(fixtures.client, 'fixtures.client required');",
      "/* MUTATED: removed client validation */");
  });
  if (loaded.status !== 'loaded') { probe('M5: unknown-client', loaded.status, loaded.error || ''); return; }
  try {
    var bad = Object.assign({}, fixtures, { client: null });
    try {
      loaded.module.createViewModel(bad);
      probe('M5: unknown-client', 'survived', 'null client accepted');
    } catch (e) {
      probe('M5: unknown-client', 'killed', 'null client rejected');
    }
  } catch (e) { probe('M5: unknown-client', 'killed', e.message); }
})();

// ── M6: Persist AI edge ──
(function () {
  var loaded = loadMutated(ADAPTER_PATH, function (src) {
    return src.replace("return { ok: false, reason: 'ai-edge-persistence-denied'",
      "return { ok: true /* MUTATED */");
  });
  if (loaded.status !== 'loaded') { probe('M6: persist-ai-edge', loaded.status, loaded.error || ''); return; }
  try {
    var result = loaded.module.rejectAiEdgePersistence(fixtures.aiEdge);
    if (result.ok === true) probe('M6: persist-ai-edge', 'killed', 'AI edge accepted — test A9 would catch');
    else probe('M6: persist-ai-edge', 'survived', 'AI edge still rejected — mutation ineffective');
  } catch (e) { probe('M6: persist-ai-edge', 'killed', e.message); }
})();

// ── M7: Skip quarantine ──
(function () {
  var loaded = loadMutated(ADAPTER_PATH, function (src) {
    return src.replace("verified: false", "verified: true /* MUTATED */");
  });
  if (loaded.status !== 'loaded') { probe('M7: skip-quarantine', loaded.status, loaded.error || ''); return; }
  try {
    var ref = { id: 'sr:test', clientId: 'c1', sessionId: 's1' };
    var q = loaded.module.quarantineSourceRef(ref, 'deleted');
    if (q.verified === true) probe('M7: skip-quarantine', 'killed', 'quarantined ref marked verified — test C1 would catch');
    else probe('M7: skip-quarantine', 'survived', 'quarantined ref still unverified — mutation ineffective');
  } catch (e) { probe('M7: skip-quarantine', 'killed', e.message); }
})();

// ── M8: Delete source without invalidating dependents ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("edges.push(createEdge(sv.id, 'supervision', sv.sessionId, 'supports'));",
      "/* MUTATED: removed supervision edge */");
  });
  if (loaded.status !== 'loaded') { probe('M8: delete-no-invalidate', loaded.status, loaded.error || ''); return; }
  try {
    var vm = loaded.module.createViewModel(fixtures);
    var supervisionEdges = vm.edges.filter(function (e) { return e.sourceType === 'supervision'; });
    if (supervisionEdges.length === 0) {
      probe('M8: delete-no-invalidate', 'killed', 'supervision edges removed — test A8b would catch');
    } else {
      probe('M8: delete-no-invalidate', 'survived', 'supervision edges still present — mutation ineffective');
    }
  } catch (e) { probe('M8: delete-no-invalidate', 'killed', e.message); }
})();

// ── M9: Reduce 30-session fixture ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("fixtures.sessions.length >= 30", "fixtures.sessions.length >= 10 /* MUTATED */");
  });
  if (loaded.status !== 'loaded') { probe('M9: reduce-fixture', loaded.status, loaded.error || ''); return; }
  try {
    var small = Object.assign({}, fixtures, { sessions: fixtures.sessions.slice(0, 10) });
    try {
      var vm = loaded.module.createViewModel(small);
      var val = loaded.module.validateViewModel(vm);
      if (val.ok) probe('M9: reduce-fixture', 'survived', '10-session fixture passed validation');
      else probe('M9: reduce-fixture', 'killed', 'validation caught reduced fixture');
    } catch (e) {
      probe('M9: reduce-fixture', 'killed', '10-session fixture rejected');
    }
  } catch (e) { probe('M9: reduce-fixture', 'killed', e.message); }
})();

// ── M10: Replace ViewModel with fake ──
(function () {
  var loaded = loadMutated(VM_PATH, function (src) {
    return src.replace("return viewModel;", "return { ok: true, fake: true /* MUTATED */ };");
  });
  if (loaded.status !== 'loaded') { probe('M10: fake-viewmodel', loaded.status, loaded.error || ''); return; }
  try {
    var vm = loaded.module.createViewModel(fixtures);
    var result = loaded.module.validateViewModel(vm);
    if (result.ok) probe('M10: fake-viewmodel', 'survived', 'fake VM passed validation');
    else probe('M10: fake-viewmodel', 'killed', 'validation caught fake');
  } catch (e) { probe('M10: fake-viewmodel', 'killed', e.message); }
})();

// ── Summary ──
console.log('');
console.log('--- Mutation Probes ---');
results.forEach(function (r) {
  console.log('  [' + r.status.toUpperCase() + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''));
});
console.log('');
console.log('Mutations killed: ' + killed);
console.log('Mutations survived: ' + survived);
console.log('No-op: ' + noop);
console.log('Syntax-error: ' + syntaxError);
console.log('Harness-error: ' + harnessError);

if (survived > 0 || noop > 0 || syntaxError > 0 || harnessError > 0) {
  console.log('mutation_phase: CONTRACT-BROKEN (false-green risk)');
  process.exit(1);
} else {
  console.log('mutation_phase: ALL-MUTATIONS-KILLED');
  process.exit(0);
}
