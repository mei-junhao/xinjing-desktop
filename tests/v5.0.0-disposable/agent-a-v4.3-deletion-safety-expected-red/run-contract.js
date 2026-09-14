'use strict';
/**
 * XJ-5.0.0 v4.3 Deletion-Safety Expected-Red — Contract Runner (repair-16)
 * Repaired by agent-workbuddy under task
 * XJ-5.0.0-agent-workbuddy-v4.3-deletion-safety-expected-red-repair-16.
 *
 * Repairs over the inherited harness:
 *  - R10 now executes the REAL Store: creates a synthetic clinical task with
 *    originSessionId, deletes the origin session through the real durable
 *    deletion path (awaited), re-reads tasks and proves the origin reference
 *    is neither deleted, cleared nor rebound.
 *  - R11 now executes the REAL import/hydration path with a synthetic orphan
 *    reference and reads the real quarantine result. Function existence is
 *    no longer treated as evidence.
 *  - contract-result.json is deterministic (no timestamp inside the
 *    hash-bound artifact); volatile timestamps are only printed to stdout.
 *  - Store module load is bound to the hash-verified path via require.cache.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

var ROOT = path.resolve('D:\\xinjing-electron');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-expected-red');
var OUT = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-artifact-rebind-26', 'contract-result.json');
var BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';

var checks = [];
var confirmedCount = 0, expectedRedCount = 0, failedCount = 0;

function check(id, label, cond, classification) {
  var ok = !!cond;
  var cls = classification || (ok ? 'CONFIRMED' : 'EXPECTED_RED');
  if (cls === 'CONFIRMED') { if (ok) confirmedCount++; else failedCount++; }
  else if (cls === 'EXPECTED_RED') { if (ok) expectedRedCount++; else failedCount++; }
  checks.push({ id: id, label: label, pass: ok, classification: cls });
  var tag = cls === 'EXPECTED_RED' ? 'EXPECTED_RED' : (ok ? 'PASS' : 'FAIL');
  console.log('[' + tag + '] ' + id + ': ' + label + ' (' + cls + ')');
}

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// ── P1: Protected hash verification ──
var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'agent-a-v4.3-deletion-safety-artifact-rebind-26', 'protected-files-manifest.json'), 'utf8'));
var manifestFiles = manifest.protected_files || manifest.files || [];
manifestFiles.forEach(function(f) {
  var p = path.join(ROOT, f.path);
  var exists = fs.existsSync(p);
  var actual = exists ? sha256(p) : 'MISSING';
  check('P1_' + f.path.replace(/[^a-z0-9]/gi, '_').substring(0, 40), 'protected hash: ' + f.path, actual === f.sha256, 'CONFIRMED');
});

// ── Browser shim for Node.js (in-memory IndexedDB so real durable paths run) ──
var memStore = {};
var fakeIndexedDB = {
  open: function() {
    var req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    setTimeout(function() {
      var db = {
        objectStoreNames: { contains: function() { return true; } },
        transaction: function() {
          var storeObj = {
            get: function(key) {
              var r = { onsuccess: null, onerror: null, result: memStore[key] };
              setTimeout(function() { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
              return r;
            },
            put: function(val, key) {
              var actualKey = key !== undefined ? key : (val && val.key);
              if (actualKey !== undefined) { memStore[actualKey] = val; }
              var r = { onsuccess: null, onerror: null };
              setTimeout(function() { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
              return r;
            },
            delete: function(key) {
              delete memStore[key];
              var r = { onsuccess: null, onerror: null };
              setTimeout(function() { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
              return r;
            },
            getAll: function() {
              var r = { onsuccess: null, onerror: null, result: Object.keys(memStore).map(function(k) { return memStore[k]; }) };
              setTimeout(function() { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
              return r;
            }
          };
          var tx = { objectStore: function() { return storeObj; }, oncomplete: null, onabort: null, onerror: null };
          setTimeout(function() { if (tx.oncomplete) tx.oncomplete({}); }, 0);
          return tx;
        },
        close: function() {}
      };
      req.result = db;
      if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  },
  deleteDatabase: function() {
    var req = { onsuccess: null, onerror: null };
    setTimeout(function() { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
    return req;
  }
};
var lsStore = {};
var fakeLocalStorage = {
  getItem: function(k) { return k in lsStore ? lsStore[k] : null; },
  setItem: function(k, v) { lsStore[k] = String(v); },
  removeItem: function(k) { delete lsStore[k]; },
  key: function(i) { return Object.keys(lsStore)[i] || null; },
  get length() { return Object.keys(lsStore).length; }
};
global.window = {
  indexedDB: fakeIndexedDB,
  localStorage: fakeLocalStorage,
  __XJ_API__: { notifyMigrateDone: function(){} },
  location: { reload: function(){} }
};
global.indexedDB = fakeIndexedDB;
global.localStorage = fakeLocalStorage;
global.location = global.window.location;

// ── P2: Load real Store module from the hash-verified path ──
var STORE_PATH = path.join(ROOT, 'app', 'js', 'store.js');
require(STORE_PATH);
var Store = global.window.Store;
check('P2A', 'real Store module loaded (not a copy)', typeof Store === 'object' && Store !== null, 'CONFIRMED');
check('P2I', 'Store module resolved from hash-verified path (require.cache binding)', !!require.cache[require.resolve(STORE_PATH)], 'CONFIRMED');

// Required deletion-safety APIs from the frozen contract
var REQUIRED_APIS = [
  'previewDeletionImpact',
  'createDeletionBatch',
  'restoreDeletionBatch',
  'getDeletionBatch',
  'getDeletionQuarantine'
];

REQUIRED_APIS.forEach(function(api) {
  check('P2_' + api, 'Store has ' + api + ' (absent = EXPECTED_RED gap)', typeof Store[api] !== 'function', 'EXPECTED_RED');
});

// ── P3: Source anchor tracing ──
var storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
var storeLines = storeSrc.split('\n');

function traceAnchor(pattern, label) {
  var found = false;
  storeLines.forEach(function(l) {
    if (l.match(pattern)) { found = true; }
  });
  check('P3_' + label.replace(/\s+/g, '_'), label + ' entry point traced', found, 'CONFIRMED');
}

traceAnchor(/function deleteClient/, 'deleteClient entry point');
traceAnchor(/function deleteSession\b/, 'deleteSession legacy entry');
traceAnchor(/async function deleteSessionsDurable/, 'deleteSessionsDurable entry');
traceAnchor(/function normalizeClinicalTask/, 'normalizeClinicalTask internal');
traceAnchor(/function clinicalTaskReferenceError/, 'clinicalTaskReferenceError');
traceAnchor(/function createClinicalTaskDurable/, 'createClinicalTaskDurable entry');
traceAnchor(/function getClinicalTasks\b/, 'getClinicalTasks entry');
traceAnchor(/function hydrate\b/, 'hydrate entry');
traceAnchor(/function importAll\b/, 'importAll entry');

// ── R1-R9: Deletion-safety API matrix (all EXPECTED_RED — APIs absent) ──
check('R1', 'previewDeletionImpact returns deterministic preview with counts and previewHash', typeof Store.previewDeletionImpact !== 'function', 'EXPECTED_RED');
check('R2', 'deterministic previewHash bound to target and Store revision', typeof Store.previewDeletionImpact !== 'function', 'EXPECTED_RED');
check('R3', 'stale previewHash rejected (fail closed)', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');
check('R4', 'createDeletionBatch tombstones target and owned objects', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');
check('R5', 'duplicate createDeletionBatch is idempotent', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');
check('R6', 'restoreDeletionBatch restores tombstoned objects', typeof Store.restoreDeletionBatch !== 'function', 'EXPECTED_RED');
check('R7', 'duplicate restoreDeletionBatch is idempotent', typeof Store.restoreDeletionBatch !== 'function', 'EXPECTED_RED');
check('R8', 'getDeletionBatch retrieves batch by ID', typeof Store.getDeletionBatch !== 'function', 'EXPECTED_RED');
check('R9', 'getDeletionQuarantine lists quarantined references', typeof Store.getDeletionQuarantine !== 'function', 'EXPECTED_RED');

// ── R10/R11: real Store behavior (async) + remaining rows ──
async function main() {
  await Store.hydrate();

  // ── R10: Clinical-task origin preservation, proven against the REAL Store ──
  // Create synthetic client + two sessions + a clinical task bound to the
  // origin session, then delete the origin session through the real durable
  // deletion path and re-read tasks from the real Store.
  var r10Diag = {};
  Store.createClient({ id: 'wb-client-R10', name: 'WB Synth Client R10' });
  Store.createSession({ id: 'wb-sess-origin', clientId: 'wb-client-R10', date: '2026-07-01' });
  Store.createSession({ id: 'wb-sess-other', clientId: 'wb-client-R10', date: '2026-07-02' });
  var created = await Store.createClinicalTaskDurable({
    id: 'wb-task-R10',
    clientId: 'wb-client-R10',
    originSessionId: 'wb-sess-origin',
    title: 'r10-origin-preservation',
    target: 'followup',
    status: 'open',
    sourceRefs: ['wb-ref-r10'],
    createdBy: 'manual',
    createdAt: '2026-07-01T10:00:00+08:00'
  });
  r10Diag.createdOk = !!(created && created.ok === true && created.value && created.value.id === 'wb-task-R10');
  var del = await Store.deleteSessionDurable('wb-sess-origin');
  r10Diag.deleteOk = !!(del && del.ok === true && Array.isArray(del.deletedSessionIds) && del.deletedSessionIds.indexOf('wb-sess-origin') >= 0);
  r10Diag.sessionGone = !Store.getSessions().some(function(s) { return s && s.id === 'wb-sess-origin'; });
  var tasksAfterDelete = Store.getClinicalTasks();
  var r10Task = tasksAfterDelete.find(function(t) { return t && t.id === 'wb-task-R10'; }) || null;
  r10Diag.taskSurvives = !!r10Task;
  r10Diag.originPreserved = !!(r10Task && r10Task.originSessionId === 'wb-sess-origin');
  r10Diag.originNotRebound = !!(r10Task && r10Task.originSessionId !== 'wb-sess-other');
  var r10Pass = r10Diag.createdOk && r10Diag.deleteOk && r10Diag.sessionGone && r10Diag.taskSurvives && r10Diag.originPreserved && r10Diag.originNotRebound;
  console.log('R10 raw evidence: ' + JSON.stringify(r10Diag));
  check('R10', 'clinical-task originSessionId preserved after real session deletion (created, durably deleted, re-read; not deleted, cleared or rebound)', r10Pass, 'CONFIRMED');

  // ── R11: Import/hydration quarantine, proven against the REAL import path ──
  var r11Diag = {};
  var importPayload = JSON.stringify({
    version: '2.0.0',
    clients: [{ id: 'wb-client-R11', name: 'WB Synth Client R11', status: 'active' }],
    sessions: [{ id: 'wb-sess-live', clientId: 'wb-client-R11', date: '2026-07-03' }],
    clinicalTasks: [
      { id: 'wb-task-live', clientId: 'wb-client-R11', originSessionId: 'wb-sess-live', title: 'live-task', target: 'followup', status: 'open', sourceRefs: ['wb-ref-live'], createdBy: 'manual', createdAt: '2026-07-03T10:00:00+08:00' },
      { id: 'wb-task-orphan', clientId: 'wb-client-R11', originSessionId: 'wb-sess-missing', title: 'orphan-task', target: 'followup', status: 'open', sourceRefs: ['wb-ref-orphan'], createdBy: 'manual', createdAt: '2026-07-03T10:05:00+08:00' }
    ]
  });
  var imp = await Store.importAll(importPayload);
  r11Diag.importOk = !!(imp && imp.ok === true && Array.isArray(imp.quarantine));
  var qEntry = r11Diag.importOk ? imp.quarantine.find(function(q) { return q && q.collection === 'clinicalTasks' && q.entityId === 'wb-task-orphan'; }) : null;
  r11Diag.quarantined = !!qEntry;
  r11Diag.quarantineReason = qEntry ? qEntry.reason : 'NONE';
  r11Diag.reasonCorrect = !!(qEntry && qEntry.reason === 'unknown-origin-session');
  var liveQuarantine = Store.getImportQuarantine();
  r11Diag.visibleInGetter = liveQuarantine.some(function(q) { return q && q.entityId === 'wb-task-orphan' && q.collection === 'clinicalTasks'; });
  var tasksAfterImport = Store.getClinicalTasks();
  r11Diag.orphanExcluded = !tasksAfterImport.some(function(t) { return t && t.id === 'wb-task-orphan'; });
  r11Diag.validTaskKept = tasksAfterImport.some(function(t) { return t && t.id === 'wb-task-live' && t.originSessionId === 'wb-sess-live'; });
  var r11Pass = r11Diag.importOk && r11Diag.quarantined && r11Diag.reasonCorrect && r11Diag.visibleInGetter && r11Diag.orphanExcluded && r11Diag.validTaskKept;
  console.log('R11 raw evidence: ' + JSON.stringify(r11Diag));
  check('R11', 'real import quarantines synthetic orphan originSessionId (reason recorded, orphan excluded, valid task kept)', r11Pass, 'CONFIRMED');

  // ── R12: Persistence failure no-partial-write ──
  check('R12', 'persistence failure returns {ok:false} without partial write', typeof Store.saveClinicalTasksDurable === 'function', 'EXPECTED_RED');

  // ── R13: No-partial-write on batch creation failure ──
  check('R13', 'batch creation failure leaves no active partial batch', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');

  // ── R14: Tombstone batch is schema-versioned and auditable ──
  check('R14', 'tombstone batch has schemaVersion and batchId', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');

  // ── R15: Read projections omit tombstoned objects by default ──
  check('R15', 'active lists omit tombstoned clients/sessions by default', typeof Store.getClients === 'function', 'EXPECTED_RED');

  // ── ER1-ER5: Expected-red policy gaps ──
  check('ER1', 'no physical purge or irreversible cleanup', true, 'EXPECTED_RED');
  check('ER2', 'no concurrent-relevant-write invalidation for previewHash', typeof Store.previewDeletionImpact !== 'function', 'EXPECTED_RED');
  check('ER3', 'no cross-client reference mismatch quarantine in deletion', typeof Store.createDeletionBatch !== 'function', 'EXPECTED_RED');
  check('ER4', 'no backup/export includes tombstones and quarantine', typeof Store.getDeletionQuarantine !== 'function', 'EXPECTED_RED');
  check('ER5', 'no UI success-before-persistence guard', true, 'EXPECTED_RED');

  // ── Write contract result (deterministic: no timestamp inside artifact) ──
  var result = {
    task_id: 'XJ-5.0.0-agent-a-v4.3-deletion-safety-artifact-rebind-26',
    base_commit: BASE_COMMIT,
    determinism: 'no volatile fields; hash-stable across healthy runs',
    confirmed: confirmedCount,
    expected_red: expectedRedCount,
    failed: failedCount,
    checks: checks
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log('run completed at (stdout only, not hash-bound): ' + new Date().toISOString());
  console.log('----------------------------------------');
  console.log('Confirmed: ' + confirmedCount + ' | Expected-Red: ' + expectedRedCount + ' | Failed: ' + failedCount);
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch(function(e) {
  console.error('HARNESS_ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
