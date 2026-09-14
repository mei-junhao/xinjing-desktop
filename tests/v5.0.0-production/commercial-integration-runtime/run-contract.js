'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommercialFacade, initialEnvelope } = require('../../../app/js/commercial-ipc-facade.js');

const DEVICE = 'device:alpha';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-runtime-'));
const STATE = path.join(ROOT, 'commercial-envelope-v3.json');
let checks = 0;

function check(value, message) {
  checks += 1;
  assert.equal(value, true, message);
}

function common(revision, operationId, payload, overrides) {
  return Object.assign({
    requestId: `req-${operationId}`,
    operationId,
    expectedRevision: revision,
    revocationEpoch: 3,
    deviceBindingHash: DEVICE,
    signedEvidence: { signatureValid: true },
    payload,
  }, overrides || {});
}

function subscriptionPayload(targetState, revision, overrides) {
  return {
    subscriptionId: 'sub_synthetic_001',
    create: {
      subscriptionId: 'sub_synthetic_001',
      tier: 'pro',
      deviceBindingHash: DEVICE,
      revocationEpoch: 3,
    },
    event: Object.assign({
      operationId: `domain-${revision}`,
      targetState,
      revision,
      revocationEpoch: 3,
      deviceBindingHash: DEVICE,
      signatureValid: true,
      clockValid: true,
    }, overrides || {}),
  };
}

(async function run() {
  try {
    fs.writeFileSync(STATE, JSON.stringify(initialEnvelope()), 'utf8');
    const facade = await createCommercialFacade({ filePath: STATE, deviceId: DEVICE });

    const snapshot0 = await facade.getSnapshot({ requestId: 'snapshot-0' });
    check(snapshot0.ok && snapshot0.revision === 0 && Array.isArray(snapshot0.value.subscriptions), 'initial redacted snapshot');
    const manual = await facade.evaluateAccess({ requestId: 'manual', featureKey: 'manual-core' });
    check(manual.ok && manual.value.freeManualAllowed && !manual.value.paidAccessAllowed, 'Free manual access is independent');

    const pending = await facade.applySubscriptionEvent(common(0, 'sub-pending', subscriptionPayload('pending', 1)));
    check(pending.ok && pending.revision === 1 && pending.value.state === 'pending', 'subscription pending transition');
    const active = await facade.applySubscriptionEvent(common(1, 'sub-active', subscriptionPayload('active', 2)));
    check(active.ok && active.revision === 2 && active.value.state === 'active', 'subscription active transition');
    const access = await facade.evaluateAccess({
      requestId: 'paid-access', featureKey: 'ai-notes', deviceBindingHash: DEVICE,
      revocationEpoch: 3, nowMs: 1000, signedEvidence: { signatureValid: true, subscriptionId: 'sub_synthetic_001' },
    });
    check(access.ok && access.value.paidAccessAllowed === true && access.value.freeManualAllowed === true, 'paid access uses registry and domain state');

    const replay = await facade.applySubscriptionEvent(common(1, 'sub-active', subscriptionPayload('active', 2)));
    check(replay.ok && replay.idempotent === true && replay.revision === 2, 'identical operation is idempotent');
    const conflict = await facade.applySubscriptionEvent(common(1, 'sub-active', subscriptionPayload('expired', 2)));
    check(conflict.ok === false && conflict.errorCode === 'operation-conflict', 'operation reuse conflicts');

    const order = await facade.applyOrderEvent(common(2, 'order-1', {
      orderId: 'order-1', nextState: 'paid',
      fields: { amountMinor: 8800, currency: 'CNY', providerReferenceHash: 'opaque-reference' },
    }));
    check(order.ok && order.revision === 3 && order.value.state === 'paid', 'order event commits');
    const device = await facade.applyDeviceEvent(common(3, 'device-1', {
      deviceBindingHash: DEVICE, nextState: 'active', fields: { status: 'active', bindingAssurance: 'dpapi' },
    }));
    check(device.ok && device.revision === 4 && device.value.status === 'active', 'device event commits');

    const credited = await facade.applyQuotaOperation(common(4, 'quota-credit', {
      walletId: 'wallet-1',
      create: { walletId: 'wallet-1', deviceBindingHash: DEVICE, balance: 5, revocationEpoch: 3 },
      event: { operationId: 'domain-credit', type: 'credit', amount: 2, revision: 1, revocationEpoch: 3, deviceBindingHash: DEVICE, signatureValid: true, clockValid: true },
    }));
    const debited = await facade.applyQuotaOperation(common(5, 'quota-debit', {
      walletId: 'wallet-1',
      event: { operationId: 'domain-debit', type: 'debit', amount: 3, revision: 2, revocationEpoch: 3, deviceBindingHash: DEVICE, signatureValid: true, clockValid: true },
    }));
    const quotaReplay = await facade.applyQuotaOperation(common(5, 'quota-debit', {
      walletId: 'wallet-1',
      event: { operationId: 'domain-debit', type: 'debit', amount: 3, revision: 2, revocationEpoch: 3, deviceBindingHash: DEVICE, signatureValid: true, clockValid: true },
    }));
    check(credited.ok && debited.ok && debited.value.balance === 4 && quotaReplay.idempotent === true, 'quota is separate and replay-safe');

    const projected = await facade.getSnapshot({ requestId: 'snapshot-1' });
    const encoded = JSON.stringify(projected.value);
    check(projected.ok && projected.revision === 6 && projected.value.orders[0].state === 'paid' && projected.value.devices[0].status === 'active', 'snapshot exposes entities');
    check(!encoded.includes('providerReferenceHash') && !encoded.includes('bindingAssurance') && !encoded.includes('operations'), 'snapshot is redacted');
    const audit = await facade.getAuditPage({ requestId: 'audit-1', limit: 100 });
    check(audit.ok && audit.value.items.length === 6 && audit.value.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'redacted')), 'audit projection is append-only metadata');

    const sensitive = await facade.applyOrderEvent(common(6, 'sensitive', {
      orderId: 'order-sensitive', nextState: 'pending', fields: { providerSecret: 'synthetic' },
    }));
    check(sensitive.ok === false && sensitive.errorCode === 'sensitive-field-rejected', 'sensitive fields fail closed');
    const disguised = await facade.applyOrderEvent(common(6, 'unknown-field', {
      orderId: 'order-sensitive', nextState: 'pending', fields: { description: 'synthetic clinical-like body' },
    }));
    check(disguised.ok === false && disguised.errorCode === 'invalid-event', 'unknown entity fields fail closed');
    const rollback = await facade.applyDeviceEvent(common(6, 'rollback', {
      deviceBindingHash: DEVICE, nextState: 'revoked', fields: { status: 'revoked' },
    }, { revocationEpoch: 2 }));
    check(rollback.ok === false && rollback.errorCode === 'revocation-rollback', 'revocation rollback fails closed');
    await facade.close();
    const reopened = await createCommercialFacade({ filePath: STATE, deviceId: DEVICE });
    const restart = await reopened.getSnapshot({ requestId: 'snapshot-restart' });
    check(restart.ok && restart.revision === 6 && restart.value.orders[0].state === 'paid', 'new entities survive a process restart');
    await reopened.close();

    const invalidTrusted = await createCommercialFacade({
      filePath: STATE,
      deviceId: DEVICE,
      trustedContextProvider: () => ({
        deviceBindingHash: DEVICE,
        revocationEpoch: 3,
        signedEvidence: { signatureValid: false, clockValid: true, subscriptionId: '' },
      }),
    });
    const forged = await invalidTrusted.applyOrderEvent(common(6, 'forged', {
      orderId: 'forged', nextState: 'paid', fields: { amountMinor: 1, currency: 'CNY' },
    }));
    check(forged.ok === false && forged.errorCode === 'invalid-license', 'main-owned invalid evidence cannot mutate');
    await invalidTrusted.close();
    process.stdout.write(`COMMERCIAL_INTEGRATION_RUNTIME: PASS (${checks}/${checks})\n`);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
