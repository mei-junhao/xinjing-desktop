'use strict';

const assert = require('assert');
const path = require('path');

const moduleFlag = process.argv.indexOf('--module');
const modulePath = moduleFlag >= 0
  ? path.resolve(process.argv[moduleFlag + 1])
  : path.resolve(__dirname, '../../../app/js/commercial-state-machine.js');
const commercial = require(modulePath);

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`PASS ${String(checks).padStart(2, '0')} ${name}\n`);
}

function subscriptionEvent(record, overrides) {
  return Object.assign({
    operationId: `op-${record.revision + 1}`,
    targetState: 'pending',
    revision: record.revision + 1,
    revocationEpoch: record.revocationEpoch,
    deviceBindingHash: record.deviceBindingHash,
    signatureValid: true,
    clockValid: true,
  }, overrides || {});
}

function quotaEvent(wallet, overrides) {
  return Object.assign({
    operationId: `quota-${wallet.revision + 1}`,
    type: 'credit',
    amount: 1,
    revision: wallet.revision + 1,
    revocationEpoch: wallet.revocationEpoch,
    deviceBindingHash: wallet.deviceBindingHash,
    signatureValid: true,
    clockValid: true,
  }, overrides || {});
}

function transition(record, targetState, overrides) {
  const result = commercial.applySubscriptionTransition(record, subscriptionEvent(record, Object.assign({ targetState }, overrides)));
  assert.strictEqual(result.ok, true, result.errorCode);
  return result.value;
}

function access(record, overrides) {
  return commercial.subscriptionAccess(record, Object.assign({
    deviceBindingHash: record.deviceBindingHash,
    signatureValid: true,
    clockValid: true,
    revocationEpoch: record.revocationEpoch,
    nowMs: 1000,
  }, overrides || {}));
}

function newSubscription() {
  return commercial.createSubscription({
    subscriptionId: 'sub_synthetic_001',
    tier: 'pro',
    deviceBindingHash: 'device:alpha',
    revocationEpoch: 3,
  });
}

check('exports the complete fixed state set', function () {
  assert.deepStrictEqual(commercial.STATES, [
    'created', 'pending', 'active', 'expired', 'revoked', 'refunded',
    'transfer-pending', 'transfer-completed', 'offline-grace', 'blocked', 'unknown',
  ]);
});

check('created subscriptions preserve Free manual access but deny paid access', function () {
  const result = access(newSubscription());
  assert.strictEqual(result.freeManualAllowed, true);
  assert.strictEqual(result.paidAccessAllowed, false);
  assert.strictEqual(result.tier, 'free');
});

check('created to pending to active is the explicit happy path', function () {
  const pending = transition(newSubscription(), 'pending');
  const active = transition(pending, 'active');
  const result = access(active);
  assert.strictEqual(result.paidAccessAllowed, true);
  assert.strictEqual(result.tier, 'pro');
});

check('illegal transition fails without mutating input', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  const before = JSON.stringify(active);
  const result = commercial.applySubscriptionTransition(active, subscriptionEvent(active, { targetState: 'pending' }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'illegal-transition');
  assert.strictEqual(JSON.stringify(active), before);
});

check('unknown target states fail closed', function () {
  const record = newSubscription();
  const result = commercial.applySubscriptionTransition(record, subscriptionEvent(record, { targetState: 'unknown' }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'unknown-state');
});

check('stale revisions fail closed', function () {
  const pending = transition(newSubscription(), 'pending');
  const result = commercial.applySubscriptionTransition(pending, subscriptionEvent(pending, {
    targetState: 'active',
    revision: pending.revision,
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'stale-revision');
});

check('wrong device and invalid security evidence fail closed', function () {
  const pending = transition(newSubscription(), 'pending');
  const wrongDevice = commercial.applySubscriptionTransition(pending, subscriptionEvent(pending, {
    targetState: 'active', deviceBindingHash: 'device:other',
  }));
  const badSignature = commercial.applySubscriptionTransition(pending, subscriptionEvent(pending, {
    targetState: 'active', signatureValid: false,
  }));
  const badClock = commercial.applySubscriptionTransition(pending, subscriptionEvent(pending, {
    targetState: 'active', clockValid: false,
  }));
  assert.strictEqual(wrongDevice.errorCode, 'device-mismatch');
  assert.strictEqual(badSignature.errorCode, 'invalid-signature');
  assert.strictEqual(badClock.errorCode, 'clock-anomaly');
});

check('revocation epoch rollback fails closed', function () {
  const pending = transition(newSubscription(), 'pending');
  const result = commercial.applySubscriptionTransition(pending, subscriptionEvent(pending, {
    targetState: 'active', revocationEpoch: 2,
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'revocation-rollback');
});

check('identical subscription operations are idempotent and conflicts are rejected', function () {
  const record = newSubscription();
  const event = subscriptionEvent(record, { operationId: 'same-op', targetState: 'pending' });
  const first = commercial.applySubscriptionTransition(record, event);
  const repeated = commercial.applySubscriptionTransition(first.value, event);
  const conflict = commercial.applySubscriptionTransition(first.value, Object.assign({}, event, { targetState: 'blocked' }));
  assert.strictEqual(repeated.ok, true);
  assert.strictEqual(repeated.idempotent, true);
  assert.deepStrictEqual(repeated.value, first.value);
  assert.strictEqual(conflict.errorCode, 'operation-conflict');
});

check('refunded and revoked subscriptions are terminal and never paid', function () {
  const activeA = transition(transition(newSubscription(), 'pending'), 'active');
  const refunded = transition(activeA, 'refunded');
  const activeB = transition(transition(newSubscription(), 'pending'), 'active');
  const revoked = transition(activeB, 'revoked', { revocationEpoch: 4 });
  assert.strictEqual(access(refunded).paidAccessAllowed, false);
  assert.strictEqual(access(revoked, { revocationEpoch: 4 }).paidAccessAllowed, false);
  assert.strictEqual(commercial.applySubscriptionTransition(refunded, subscriptionEvent(refunded, { targetState: 'active' })).ok, false);
  assert.strictEqual(commercial.applySubscriptionTransition(revoked, subscriptionEvent(revoked, { targetState: 'active', revocationEpoch: 4 })).ok, false);
});

check('access validation rejects wrong device, bad signature, bad clock and revocation rollback', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  assert.strictEqual(access(active, { deviceBindingHash: 'device:other' }).paidAccessAllowed, false);
  assert.strictEqual(access(active, { signatureValid: false }).paidAccessAllowed, false);
  assert.strictEqual(access(active, { clockValid: false }).paidAccessAllowed, false);
  assert.strictEqual(access(active, { revocationEpoch: 2 }).paidAccessAllowed, false);
  assert.strictEqual(access(active, { deviceBindingHash: 'device:other' }).freeManualAllowed, true);
});

check('offline grace is valid only inside the signed seven-day ceiling', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  const start = 1_000_000;
  const end = start + commercial.MAX_OFFLINE_GRACE_MS;
  const grace = transition(active, 'offline-grace', {
    lastVerifiedOnlineAtMs: start,
    offlineGraceEndsAtMs: end,
  });
  assert.strictEqual(access(grace, { nowMs: end }).paidAccessAllowed, true);
  assert.strictEqual(access(grace, { nowMs: end + 1 }).paidAccessAllowed, false);
  const tooLong = commercial.applySubscriptionTransition(active, subscriptionEvent(active, {
    operationId: 'grace-too-long',
    targetState: 'offline-grace',
    lastVerifiedOnlineAtMs: start,
    offlineGraceEndsAtMs: end + 1,
  }));
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(tooLong.errorCode, 'invalid-offline-grace');
});

check('offline access clamps tampered records to the seven-day ceiling', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  const start = 5_000;
  const grace = transition(active, 'offline-grace', {
    lastVerifiedOnlineAtMs: start,
    offlineGraceEndsAtMs: start + commercial.MAX_OFFLINE_GRACE_MS,
  });
  const tampered = Object.assign({}, grace, { offlineGraceEndsAtMs: start + commercial.MAX_OFFLINE_GRACE_MS * 2 });
  assert.strictEqual(access(tampered, { nowMs: start + commercial.MAX_OFFLINE_GRACE_MS + 1 }).paidAccessAllowed, false);
});

check('device transfer requires a distinct target and reactivation on the new device', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  const pendingTransfer = transition(active, 'transfer-pending', { targetDeviceBindingHash: 'device:beta' });
  const completed = transition(pendingTransfer, 'transfer-completed', { targetDeviceBindingHash: 'device:beta' });
  assert.strictEqual(completed.deviceBindingHash, 'device:beta');
  assert.strictEqual(access(completed, { deviceBindingHash: 'device:beta' }).paidAccessAllowed, false);
  const reactivated = transition(completed, 'active');
  assert.strictEqual(access(reactivated).paidAccessAllowed, true);
  assert.strictEqual(access(reactivated, { deviceBindingHash: 'device:alpha' }).paidAccessAllowed, false);
});

check('transfer completion rejects a mismatched target', function () {
  const active = transition(transition(newSubscription(), 'pending'), 'active');
  const pendingTransfer = transition(active, 'transfer-pending', { targetDeviceBindingHash: 'device:beta' });
  const result = commercial.applySubscriptionTransition(pendingTransfer, subscriptionEvent(pendingTransfer, {
    targetState: 'transfer-completed', targetDeviceBindingHash: 'device:gamma',
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'transfer-target-mismatch');
});

check('every non-paid state preserves Free manual access and denies paid access', function () {
  commercial.STATES.filter(function (state) { return state !== 'active' && state !== 'offline-grace'; }).forEach(function (state) {
    const base = newSubscription();
    const record = Object.assign({}, base, { state });
    const result = access(record);
    assert.strictEqual(result.freeManualAllowed, true, state);
    assert.strictEqual(result.paidAccessAllowed, false, state);
  });
});

check('quota credits and debits are separate from subscription entitlement', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_001', deviceBindingHash: 'device:alpha' });
  const credited = commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { amount: 5 }));
  const debited = commercial.applyQuotaOperation(credited.value, quotaEvent(credited.value, { type: 'debit', amount: 2 }));
  assert.strictEqual(debited.ok, true);
  assert.strictEqual(debited.value.balance, 3);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(debited.value, 'tier'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(debited.value, 'subscriptionTier'), false);
});

check('duplicate quota debit is idempotent and cannot charge twice', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_002', deviceBindingHash: 'device:alpha', balance: 5 });
  const event = quotaEvent(wallet, { operationId: 'debit-once', type: 'debit', amount: 2 });
  const first = commercial.applyQuotaOperation(wallet, event);
  const repeated = commercial.applyQuotaOperation(first.value, event);
  assert.strictEqual(first.value.balance, 3);
  assert.strictEqual(repeated.ok, true);
  assert.strictEqual(repeated.idempotent, true);
  assert.strictEqual(repeated.value.balance, 3);
});

check('quota operation ID conflicts fail closed', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_003', deviceBindingHash: 'device:alpha' });
  const firstEvent = quotaEvent(wallet, { operationId: 'quota-conflict', amount: 5 });
  const first = commercial.applyQuotaOperation(wallet, firstEvent);
  const conflict = commercial.applyQuotaOperation(first.value, Object.assign({}, firstEvent, { amount: 6 }));
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.errorCode, 'operation-conflict');
});

check('quota insufficient balance fails without mutation', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_004', deviceBindingHash: 'device:alpha', balance: 1 });
  const before = JSON.stringify(wallet);
  const result = commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { type: 'debit', amount: 2 }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'insufficient-quota');
  assert.strictEqual(JSON.stringify(wallet), before);
});

check('quota rejects stale revision, wrong device, invalid signature, clock anomaly and revocation rollback', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_005', deviceBindingHash: 'device:alpha', revocationEpoch: 4 });
  assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { revision: 0 })).errorCode, 'stale-revision');
  assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { deviceBindingHash: 'device:other' })).errorCode, 'device-mismatch');
  assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { signatureValid: false })).errorCode, 'invalid-signature');
  assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { clockValid: false })).errorCode, 'clock-anomaly');
  assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { revocationEpoch: 3 })).errorCode, 'revocation-rollback');
});

check('quota rejects zero, negative, fractional and overflowing amounts', function () {
  const wallet = commercial.createQuotaWallet({ walletId: 'wallet_synthetic_006', deviceBindingHash: 'device:alpha' });
  [0, -1, 1.5].forEach(function (amount) {
    assert.strictEqual(commercial.applyQuotaOperation(wallet, quotaEvent(wallet, { amount })).ok, false);
  });
  const huge = commercial.createQuotaWallet({
    walletId: 'wallet_synthetic_007', deviceBindingHash: 'device:alpha', balance: Number.MAX_SAFE_INTEGER,
  });
  assert.strictEqual(commercial.applyQuotaOperation(huge, quotaEvent(huge, { amount: 1 })).errorCode, 'quota-overflow');
});

process.stdout.write(`COMMERCIAL_STATE_MACHINE_CONTRACT: PASS (${checks}/${checks})\n`);
