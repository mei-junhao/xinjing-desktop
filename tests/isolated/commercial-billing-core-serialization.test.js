'use strict';
// XJ-5.0.0-cli-reasonix-v5-commercial-live-serialization-candidate-247
// Real behavior tests for the mutation-serialization candidate.
//
// Every assertion uses observable behavior and durable state only:
//   - returned projections ({ok, value, revision, idempotent} / {ok:false, errorCode})
//   - _getEnvelope() (the committed envelope after readback)
//   - adapter readback via _getAdapter().read()
// No source-string checks, no mocks replacing the real module entry point.
//
// runBehaviorSuite(modulePath) loads the REAL module at modulePath (candidate
// or a reverse-mutated temporary copy) and runs the whole suite against it.
// When executed directly, it runs against the candidate and exits non-zero on
// any failure.

var assert = require('assert');
var path = require('path');

var CANDIDATE_PATH = path.join(__dirname, '..', '..', 'app', 'js', 'commercial-billing-core.js');

function makeEnv(overrides) {
  var env = {
    schemaVersion: 1, revision: 0, balanceMinor: 1000, reservedMinor: 0,
    quotaWallets: {}, requestCharges: {}, operationReceipts: {},
    auditEvents: [], updatedAt: new Date().toISOString()
  };
  for (var k in overrides) env[k] = overrides[k];
  return env;
}

function newService(mod, envOverrides, adapter) {
  var config = { initialState: makeEnv(envOverrides) };
  if (adapter) config.persistenceAdapter = adapter;
  return mod.createBillingService(config);
}

function reserveInput(opId, extra) {
  var input = {
    caller: 'c1', deviceId: 'dev1', model: 'model-alpha',
    operationId: opId, billingMode: 'money-per-request'
  };
  for (var k in extra) input[k] = extra[k];
  return input;
}

function quotaInput(opId, walletId, extra) {
  var input = {
    caller: 'c1', deviceId: 'dev1', operationId: opId,
    billingMode: 'request-count-quota', quotaWalletId: walletId
  };
  for (var k in extra) input[k] = extra[k];
  return input;
}

// --- Concurrent money mutations: both must serialize on one envelope ---
// Baseline (no queue): both calls read the same stale envelope (revision 0),
// so the first writer's readback sees the second writer's snapshot and fails
// with readback-mismatch even though the account is fully funded, or both
// succeed against one wallet unit. Serialized: both succeed, revisions 1 and
// 2, and both reservations are durable.
async function t_moneyRace(mod) {
  var svc = newService(mod);
  var p1 = svc.reserveRequestCharge(reserveInput('op-race-1'));
  var p2 = svc.reserveRequestCharge(reserveInput('op-race-2'));
  var r1 = await p1;
  var r2 = await p2;
  assert.strictEqual(r1.ok, true, 'reserve 1 must succeed');
  assert.strictEqual(r2.ok, true, 'reserve 2 must succeed (serialized after reserve 1)');
  assert.strictEqual(r1.revision, 1, 'reserve 1 revision 1');
  assert.strictEqual(r2.revision, 2, 'reserve 2 must observe revision 1, not the stale envelope');
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 2, 'durable revision 2');
  assert.strictEqual(env.reservedMinor, 200, 'both reservations durable (no lost update)');
  assert.strictEqual(Object.keys(env.requestCharges).length, 2, 'two request charges');
  assert.strictEqual(Object.keys(env.operationReceipts).length, 2, 'two operation receipts');
  var readback = await svc._getAdapter().read();
  assert.strictEqual(readback.revision, 2, 'adapter readback revision 2');
  assert.strictEqual(readback.reservedMinor, 200, 'adapter readback reserved 200');
}

// --- Concurrent quota mutations against one wallet unit ---
// Baseline: both calls read remaining=1 from the same stale envelope; the
// second returns success against the same single unit (or the first dies with
// readback-mismatch). Serialized: first consumes the unit (revision 1), second
// fails quota-exhausted, and the queue keeps working for the next operation.
async function t_quotaRace(mod) {
  var svc = newService(mod, { quotaWallets: { w1: { walletId: 'w1', remaining: 1, total: 1 } } });
  var p1 = svc.processNonMoneyRequest(quotaInput('op-q-1', 'w1'));
  var p2 = svc.processNonMoneyRequest(quotaInput('op-q-2', 'w1'));
  var r1 = await p1;
  var r2 = await p2;
  assert.strictEqual(r1.ok, true, 'first quota call must succeed');
  assert.strictEqual(r1.revision, 1, 'first quota call revision 1');
  assert.strictEqual(r2.ok, false, 'second concurrent quota call must fail: one wallet unit');
  assert.strictEqual(r2.errorCode, 'quota-exhausted', 'second call quota-exhausted');
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 1, 'durable revision 1');
  assert.strictEqual(env.quotaWallets.w1.remaining, 0, 'unit consumed exactly once');
  // Queue must remain usable after the {ok:false} result.
  var r3 = await svc.reserveRequestCharge(reserveInput('op-q-3'));
  assert.strictEqual(r3.ok, true, 'queue continues after failed quota call');
  assert.strictEqual(r3.revision, 2, 'money reserve after quota failure lands on revision 2');
}

// --- Concurrent money + quota mutations share one envelope revision ---
async function t_moneyQuotaMix(mod) {
  var svc = newService(mod, { quotaWallets: { w1: { walletId: 'w1', remaining: 1, total: 1 } } });
  var p1 = svc.reserveRequestCharge(reserveInput('op-mix-1'));
  var p2 = svc.processNonMoneyRequest(quotaInput('op-mix-2', 'w1'));
  var r1 = await p1;
  var r2 = await p2;
  assert.strictEqual(r1.ok, true, 'money reserve must succeed');
  assert.strictEqual(r2.ok, true, 'quota consume must succeed');
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 2, 'both mutations serialized on one shared revision order');
  assert.strictEqual(env.reservedMinor, 100, 'money reservation durable');
  assert.strictEqual(env.quotaWallets.w1.remaining, 0, 'quota consume durable');
}

// --- Failure then success: {ok:false} must not poison the queue ---
async function t_failureThenSuccess(mod) {
  var svc = newService(mod);
  svc._setFault('durable-write-failed');
  var r1 = await svc.reserveRequestCharge(reserveInput('op-f-1'));
  assert.strictEqual(r1.ok, false, 'faulted write must fail');
  assert.strictEqual(r1.errorCode, 'durable-write-failed', 'durable error surfaced, not hidden');
  assert.strictEqual(svc._getEnvelope().revision, 0, 'no partial commit after failed write');
  assert.strictEqual(svc._getEnvelope().reservedMinor, 0, 'no partial reservation after failed write');
  var r2 = await svc.reserveRequestCharge(reserveInput('op-f-2'));
  assert.strictEqual(r2.ok, true, 'operation after failed write must succeed');
  assert.strictEqual(r2.revision, 1, 'recovery lands on revision 1');
  var r3 = await svc.reserveRequestCharge(reserveInput('op-f-3'));
  assert.strictEqual(r3.ok, true, 'second operation after failure must also succeed');
  assert.strictEqual(r3.revision, 2, 'second recovery lands on revision 2');
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 2, 'durable revision 2 after two recoveries');
  assert.strictEqual(env.reservedMinor, 200, 'durable reserved 200 after two recoveries');
}

// --- Thrown adapter failure must not poison the queue ---
async function t_thrownAdapterRecovery(mod) {
  var inner = mod.createInMemoryAdapter();
  var thrown = false;
  var adapter = {
    write: function (snapshot) {
      if (!thrown) {
        thrown = true;
        var e = new Error('adapter boom');
        e.errorCode = 'durable-write-failed';
        throw e; // synchronous throw, not a rejected promise
      }
      return inner.write(snapshot);
    },
    read: function () { return inner.read(); },
    hasData: function () { return inner.hasData(); }
  };
  var svc = newService(mod, null, adapter);
  var r1 = await svc.reserveRequestCharge(reserveInput('op-t-1'));
  assert.strictEqual(r1.ok, false, 'thrown adapter failure must surface as failure');
  assert.strictEqual(r1.errorCode, 'durable-write-failed', 'adapter error code preserved');
  assert.strictEqual(svc._getEnvelope().revision, 0, 'no commit after thrown adapter failure');
  var r2 = await svc.reserveRequestCharge(reserveInput('op-t-2'));
  assert.strictEqual(r2.ok, true, 'queue must continue after thrown adapter failure');
  assert.strictEqual(r2.revision, 1, 'recovery lands on revision 1');
  assert.strictEqual(svc._getEnvelope().reservedMinor, 100, 'recovery reservation durable');
}

// --- Readback mismatch: fail closed, then queue keeps working ---
async function t_readbackMismatch(mod) {
  var svc = newService(mod);
  svc._setFault('corrupt-readback');
  var r1 = await svc.reserveRequestCharge(reserveInput('op-rb-1'));
  assert.strictEqual(r1.ok, false, 'corrupted readback must fail closed');
  assert.strictEqual(r1.errorCode, 'readback-mismatch', 'readback-mismatch surfaced');
  assert.strictEqual(svc._getEnvelope().revision, 0, 'no commit on readback mismatch');
  var r2 = await svc.reserveRequestCharge(reserveInput('op-rb-2'));
  assert.strictEqual(r2.ok, true, 'queue continues after readback mismatch');
  assert.strictEqual(r2.revision, 1, 'recovery lands on revision 1');
}

// --- Insufficient balance stays a distinct non-money-free failure ---
async function t_insufficientBalance(mod) {
  var svc = newService(mod, { balanceMinor: 50 });
  var r = await svc.reserveRequestCharge(reserveInput('op-ib-1'));
  assert.strictEqual(r.ok, false, 'reserve over balance must fail');
  assert.strictEqual(r.errorCode, 'insufficient-balance', 'insufficient-balance error code');
  assert.strictEqual(svc._getEnvelope().revision, 0, 'no revision change on failure');
  assert.strictEqual(svc._getEnvelope().reservedMinor, 0, 'no reservation on failure');
}

// --- No silent trial/BYOK/quota fallback and no money-quota mixing ---
async function t_noTrialFallback(mod) {
  var svc = newService(mod);
  var r = await svc.processNonMoneyRequest({
    caller: 'c1', deviceId: 'dev1', operationId: 'op-nf-1',
    billingMode: 'money-per-request', model: 'model-alpha'
  });
  assert.strictEqual(r.ok, false, 'money mode must never be silently processed as non-money');
  assert.strictEqual(r.errorCode, 'invalid-request', 'money mode rejected with invalid-request');
  // Insufficient money must not consume a quota wallet even when one exists.
  var svc2 = newService(mod, {
    balanceMinor: 50,
    quotaWallets: { w1: { walletId: 'w1', remaining: 5, total: 5 } }
  });
  var r2 = await svc2.reserveRequestCharge(reserveInput('op-nf-2'));
  assert.strictEqual(r2.ok, false, 'money reserve over balance must fail');
  assert.strictEqual(r2.errorCode, 'insufficient-balance', 'no fallback allowed');
  var env2 = svc2._getEnvelope();
  assert.strictEqual(env2.quotaWallets.w1.remaining, 5, 'quota untouched by money failure');
  assert.strictEqual(env2.revision, 0, 'no revision change');
}

// --- Non-money projections never touch money fields ---
async function t_nonMoneyProjection(mod) {
  var svc = newService(mod, { quotaWallets: { w1: { walletId: 'w1', remaining: 3, total: 3 } } });
  var r1 = await svc.processNonMoneyRequest(quotaInput('op-nm-1', 'w1'));
  assert.strictEqual(r1.ok, true, 'quota call succeeds');
  assert.strictEqual(r1.value.chargeStatus, 'not-applicable', 'exact non-money status');
  assert.strictEqual(r1.value.chargedMinor, null, 'chargedMinor null');
  assert.strictEqual(r1.value.priceMinor, null, 'priceMinor null');
  assert.strictEqual(r1.value.remainingBalanceMinor, null, 'remainingBalanceMinor null');
  assert.strictEqual(r1.value.availableBalanceMinor, null, 'availableBalanceMinor null');
  assert.strictEqual(r1.value.quotaRemaining, 2, 'quotaRemaining 2');
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 1, 'quota revision 1');
  assert.strictEqual(env.balanceMinor, 1000, 'money untouched by quota');
  assert.strictEqual(env.reservedMinor, 0, 'reserved untouched by quota');
  assert.strictEqual(env.quotaWallets.w1.remaining, 2, 'quota consumed once');
  var r2 = await svc.processNonMoneyRequest({
    caller: 'c1', deviceId: 'dev1', operationId: 'op-nm-2', billingMode: 'byok'
  });
  assert.strictEqual(r2.ok, true, 'byok succeeds');
  assert.strictEqual(r2.value.chargeStatus, 'not-applicable', 'byok exact projection');
  var env2 = svc._getEnvelope();
  assert.strictEqual(env2.revision, 2, 'byok revision 2');
  assert.strictEqual(env2.balanceMinor, 1000, 'money untouched by byok');
  assert.strictEqual(env2.reservedMinor, 0, 'reserved untouched by byok');
  assert.strictEqual(env2.quotaWallets.w1.remaining, 2, 'byok consumes no quota');
}

// --- Read-only methods are not serialized behind the mutation queue ---
async function t_readsNotQueued(mod) {
  var svc = newService(mod);
  var p = svc.reserveRequestCharge(reserveInput('op-rq-1'));
  var bal = await svc.getAccountBalance({ caller: 'c1' });
  var r = await p;
  assert.strictEqual(bal.ok, true, 'balance read succeeds while mutation is in flight');
  assert.strictEqual(bal.revision, 0, 'read observed committed state (not blocked by queue)');
  assert.strictEqual(r.ok, true, 'reserve completes');
  assert.strictEqual(r.revision, 1, 'reserve lands on revision 1');
}

// --- Idempotent replay and conflict detection through the queue ---
async function t_idempotentReplay(mod) {
  var svc = newService(mod);
  var input = reserveInput('op-dup-1');
  var r1 = await svc.reserveRequestCharge(input);
  assert.strictEqual(r1.ok, true, 'first reserve succeeds');
  assert.strictEqual(r1.idempotent, false, 'first call not idempotent');
  var r2 = await svc.reserveRequestCharge(input);
  assert.strictEqual(r2.ok, true, 'replay succeeds');
  assert.strictEqual(r2.idempotent, true, 'replay flagged idempotent');
  assert.strictEqual(r2.revision, r1.revision, 'replay returns original revision');
  assert.strictEqual(svc._getEnvelope().revision, 1, 'replay did not increment revision');
  var r3 = await svc.reserveRequestCharge(Object.assign({}, input, { model: 'model-beta' }));
  assert.strictEqual(r3.ok, false, 'conflicting payload rejected');
  assert.strictEqual(r3.errorCode, 'operation-conflict', 'operation-conflict error code');
}

// --- Full money lifecycle through the queue: settle, unknown, reconcile, release ---
async function t_lifecycle(mod) {
  var svc = newService(mod);
  // reserve + settle (price frozen at reservation, current catalog irrelevant)
  var res = await svc.reserveRequestCharge(reserveInput('op-lc-1'));
  assert.strictEqual(res.ok, true, 'reserve ok');
  svc._setCatalogPrice('model-alpha', 999); // catalog price changes after reservation
  var settled = await svc.settleRequestCharge({
    caller: 'c1', deviceId: 'dev1', requestId: res.value.requestId, operationId: 'op-lc-2'
  });
  assert.strictEqual(settled.ok, true, 'settle ok');
  assert.strictEqual(settled.value.chargeStatus, 'settled', 'settled status');
  assert.strictEqual(settled.value.priceMinor, 100, 'frozen reservation price used, not current catalog');
  assert.strictEqual(settled.value.chargedMinor, 100, 'charged at frozen price');
  svc._setCatalogPrice('model-alpha', 100); // restore catalog for later reserves
  var env = svc._getEnvelope();
  assert.strictEqual(env.revision, 2, 'revision 2 after settle');
  assert.strictEqual(env.balanceMinor, 900, 'balance 900 after settle');
  assert.strictEqual(env.reservedMinor, 0, 'reserved 0 after settle');
  // reserve + markUnknown + reconcile
  var res2 = await svc.reserveRequestCharge(reserveInput('op-lc-3'));
  var unknown = await svc.markRequestUnknown({
    caller: 'c1', deviceId: 'dev1', requestId: res2.value.requestId, operationId: 'op-lc-4'
  });
  assert.strictEqual(unknown.ok, true, 'markUnknown ok');
  assert.strictEqual(unknown.value.chargeStatus, 'pending-reconciliation', 'pending-reconciliation status');
  var reconcile = await svc.reconcileRequestCharge({
    caller: 'c1', deviceId: 'dev1', requestId: res2.value.requestId,
    operationId: 'op-lc-5', outcome: 'settled', evidence: { trusted: true }
  });
  assert.strictEqual(reconcile.ok, true, 'reconcile ok');
  assert.strictEqual(reconcile.value.chargeStatus, 'settled', 'reconciled settled');
  var env2 = svc._getEnvelope();
  assert.strictEqual(env2.revision, 5, 'revision 5 after reconcile');
  assert.strictEqual(env2.balanceMinor, 800, 'balance 800 after reconciled settle');
  assert.strictEqual(env2.reservedMinor, 0, 'reserved 0 after reconcile');
  // reserve + release
  var res3 = await svc.reserveRequestCharge(reserveInput('op-lc-6'));
  var released = await svc.releaseRequestCharge({
    caller: 'c1', deviceId: 'dev1', requestId: res3.value.requestId, operationId: 'op-lc-7'
  });
  assert.strictEqual(released.ok, true, 'release ok');
  assert.strictEqual(released.value.chargeStatus, 'released', 'released status');
  var env3 = svc._getEnvelope();
  assert.strictEqual(env3.revision, 7, 'revision 7 after release');
  assert.strictEqual(env3.balanceMinor, 800, 'release does not debit');
  assert.strictEqual(env3.reservedMinor, 0, 'release frees reservation');
  // stable failure codes preserved
  var bad = await svc.releaseRequestCharge({
    caller: 'c1', deviceId: 'other-device', requestId: res3.value.requestId, operationId: 'op-lc-8'
  });
  assert.strictEqual(bad.ok, false, 'device mismatch fails');
  assert.strictEqual(bad.errorCode, 'device-mismatch', 'device-mismatch error code');
}

var ALL_TESTS = [
  ['moneyRace', t_moneyRace],
  ['quotaRace', t_quotaRace],
  ['moneyQuotaMix', t_moneyQuotaMix],
  ['failureThenSuccess', t_failureThenSuccess],
  ['thrownAdapterRecovery', t_thrownAdapterRecovery],
  ['readbackMismatch', t_readbackMismatch],
  ['insufficientBalance', t_insufficientBalance],
  ['noTrialFallback', t_noTrialFallback],
  ['nonMoneyProjection', t_nonMoneyProjection],
  ['readsNotQueued', t_readsNotQueued],
  ['idempotentReplay', t_idempotentReplay],
  ['lifecycle', t_lifecycle]
];

// Loads the REAL module at modulePath and runs every behavior test against it.
// Returns [{name, pass, error}]. Never calls process.exit so the reverse-
// mutation harness can reuse the same suite.
async function runBehaviorSuite(modulePath) {
  var mod = require(modulePath);
  var results = [];
  for (var i = 0; i < ALL_TESTS.length; i++) {
    var name = ALL_TESTS[i][0];
    var fn = ALL_TESTS[i][1];
    var started = Date.now();
    try {
      await fn(mod);
      results.push({ name: name, pass: true, ms: Date.now() - started });
    } catch (e) {
      results.push({ name: name, pass: false, error: (e && e.message) || String(e), ms: Date.now() - started });
    }
  }
  return results;
}

if (require.main === module) {
  var target = process.argv[2] || CANDIDATE_PATH;
  runBehaviorSuite(target).then(function (results) {
    var fails = 0;
    results.forEach(function (r) {
      console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.pass ? '' : ' :: ' + r.error));
      if (!r.pass) fails += 1;
    });
    console.log(fails === 0 ? 'ALL PASS (' + results.length + ' tests)' : (fails + ' FAILURES / ' + results.length));
    process.exitCode = fails === 0 ? 0 : 1;
  }).catch(function (e) {
    console.error('SUITE ERROR: ' + (e && e.stack || e));
    process.exitCode = 2;
  });
}

module.exports = { runBehaviorSuite: runBehaviorSuite, ALL_TESTS: ALL_TESTS };

