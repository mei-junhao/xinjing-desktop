'use strict';

const assert = require('assert');
const path = require('path');

function argumentPath(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? path.resolve(process.argv[index + 1]) : path.resolve(__dirname, fallback);
}

const fixture = require(argumentPath('--module', 'contract-fixture.js'));
const domain = require(argumentPath('--domain', '../../../app/js/commercial-state-machine.js'));
const registry = Object.freeze({
  'manual-core': Object.freeze({ minimumTier: 'free', trialEligible: false, handlerOwner: 'store' }),
  'ai-notes': Object.freeze({ minimumTier: 'pro', trialEligible: true, handlerOwner: 'ai' }),
  'custom-supervisors': Object.freeze({ minimumTier: 'custom', trialEligible: false, handlerOwner: 'supervisionSkill' }),
});

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`PASS ${String(checks).padStart(2, '0')} ${name}\n`);
}

function dependencies(options) {
  const settings = options || {};
  return {
    durable: fixture.createMemoryDurable(settings.durable),
    domain,
    featureRegistry: registry,
    verifyLicense(evidence) {
      if (!evidence || evidence.signatureValid !== true) return { ok: false };
      return { ok: true, subscriptionId: evidence.subscriptionId };
    },
  };
}

function common(revision, operationId, payload, overrides) {
  return Object.assign({
    requestId: `req-${operationId}`,
    operationId,
    expectedRevision: revision,
    revocationEpoch: 3,
    deviceBindingHash: 'device:alpha',
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
      deviceBindingHash: 'device:alpha',
      revocationEpoch: 3,
    },
    event: Object.assign({
      operationId: `domain-${revision}`,
      targetState,
      revision,
      revocationEpoch: 3,
      deviceBindingHash: 'device:alpha',
      signatureValid: true,
      clockValid: true,
    }, overrides || {}),
  };
}

async function activate(integration) {
  const pending = await integration.invoke('commercial.applySubscriptionEvent', common(0, 'sub-pending', subscriptionPayload('pending', 1)));
  assert.strictEqual(pending.ok, true, pending.errorCode);
  const active = await integration.invoke('commercial.applySubscriptionEvent', common(1, 'sub-active', subscriptionPayload('active', 2)));
  assert.strictEqual(active.ok, true, active.errorCode);
  return active;
}

(async function run() {
  await check('freezes the seven typed IPC channels', async () => {
    const integration = fixture.createIntegration(dependencies());
    assert.deepStrictEqual(integration.channels, [
      'commercial.getSnapshot', 'commercial.evaluateAccess', 'commercial.applySubscriptionEvent',
      'commercial.applyOrderEvent', 'commercial.applyDeviceEvent', 'commercial.applyQuotaOperation',
      'commercial.getAuditPage',
    ]);
  });

  await check('freezes the versioned durable commercial envelope', async () => {
    assert.deepStrictEqual(Object.keys(fixture.initialEnvelope()).sort(), [
      'auditEvents', 'devices', 'operationReceipts', 'orders', 'quotaWallets', 'revision',
      'revocationEpoch', 'schemaVersion', 'subscriptions', 'updatedAt',
    ]);
  });

  await check('unknown IPC handlers fail closed', async () => {
    const result = await fixture.createIntegration(dependencies()).invoke('commercial.directWrite', {});
    assert.deepStrictEqual(result, { ok: false, errorCode: 'unknown-channel', retryable: false });
  });

  await check('Free manual access survives durable and license failures', async () => {
    const integration = fixture.createIntegration(dependencies({ durable: { failRead: true } }));
    const result = await integration.invoke('commercial.evaluateAccess', { requestId: 'manual-free', featureKey: 'manual-core', signedEvidence: null });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.freeManualAllowed, true);
    assert.strictEqual(result.value.paidAccessAllowed, false);
  });

  await check('unknown feature keys cannot bypass the canonical registry', async () => {
    const integration = fixture.createIntegration(dependencies());
    const result = await integration.invoke('commercial.evaluateAccess', {
      requestId: 'unknown-feature', featureKey: 'private-paid-feature', signedEvidence: { signatureValid: true }, deviceBindingHash: 'device:alpha', revocationEpoch: 3, nowMs: 1000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'unknown-feature');
  });

  await check('paid access requires registry, signed evidence, device and active subscription', async () => {
    const integration = fixture.createIntegration(dependencies());
    await activate(integration);
    const denied = await integration.invoke('commercial.evaluateAccess', {
      requestId: 'paid-denied', featureKey: 'ai-notes', signedEvidence: { signatureValid: false }, deviceBindingHash: 'device:alpha', revocationEpoch: 3, nowMs: 1000,
    });
    const allowed = await integration.invoke('commercial.evaluateAccess', {
      requestId: 'paid-allowed', featureKey: 'ai-notes', signedEvidence: { signatureValid: true, subscriptionId: 'sub_synthetic_001' }, deviceBindingHash: 'device:alpha', revocationEpoch: 3, nowMs: 1000,
    });
    assert.strictEqual(denied.errorCode, 'invalid-license');
    assert.strictEqual(allowed.value.paidAccessAllowed, true);
    assert.strictEqual(allowed.value.freeManualAllowed, true);
  });

  await check('subscription command awaits durable commit and readback', async () => {
    const integration = fixture.createIntegration(dependencies({ durable: { delayMs: 20 } }));
    const result = await integration.invoke('commercial.applySubscriptionEvent', common(0, 'awaited-sub', subscriptionPayload('pending', 1)));
    assert.strictEqual(result.ok, true, result.errorCode);
    assert.strictEqual(result.revision, 1);
    const snapshot = await integration.invoke('commercial.getSnapshot', { requestId: 'snapshot-1' });
    assert.strictEqual(snapshot.revision, 1);
    assert.strictEqual(snapshot.value.subscriptions[0].state, 'pending');
  });

  await check('durable no-op or failed commits cannot return success', async () => {
    const integration = fixture.createIntegration(dependencies({ durable: { failCommit: true } }));
    const result = await integration.invoke('commercial.applySubscriptionEvent', common(0, 'failed-sub', subscriptionPayload('pending', 1)));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'durable-write-failed');
  });

  await check('domain {ok:false} is propagated without a durable write', async () => {
    const integration = fixture.createIntegration(dependencies());
    await activate(integration);
    const illegal = await integration.invoke('commercial.applySubscriptionEvent', common(2, 'illegal-sub', subscriptionPayload('pending', 3)));
    assert.strictEqual(illegal.ok, false);
    assert.strictEqual(illegal.errorCode, 'illegal-transition');
    const snapshot = await integration.invoke('commercial.getSnapshot', { requestId: 'snapshot-illegal' });
    assert.strictEqual(snapshot.revision, 2);
  });

  await check('identical operation replay is durable and idempotent', async () => {
    const integration = fixture.createIntegration(dependencies());
    const request = common(0, 'idempotent-sub', subscriptionPayload('pending', 1));
    const first = await integration.invoke('commercial.applySubscriptionEvent', request);
    const repeated = await integration.invoke('commercial.applySubscriptionEvent', request);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(repeated.ok, true);
    assert.strictEqual(repeated.idempotent, true);
    assert.strictEqual(repeated.revision, 1);
    const audit = await integration.invoke('commercial.getAuditPage', { requestId: 'audit-replay', limit: 100 });
    assert.strictEqual(audit.value.items.length, 1);
  });

  await check('operation ID reuse with changed content fails closed', async () => {
    const integration = fixture.createIntegration(dependencies());
    const first = await integration.invoke('commercial.applyOrderEvent', common(0, 'order-same', { orderId: 'order-1', nextState: 'pending', fields: { amountMinor: 1000, currency: 'CNY' } }));
    const conflict = await integration.invoke('commercial.applyOrderEvent', common(0, 'order-same', { orderId: 'order-1', nextState: 'paid', fields: { amountMinor: 1000, currency: 'CNY' } }));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(conflict.errorCode, 'operation-conflict');
  });

  await check('revocation epoch rollback fails without state change', async () => {
    const integration = fixture.createIntegration(dependencies());
    const first = await integration.invoke('commercial.applyDeviceEvent', common(0, 'device-1', { deviceBindingHash: 'device:alpha', nextState: 'active', fields: { status: 'active' } }, { revocationEpoch: 4 }));
    const rollback = await integration.invoke('commercial.applyDeviceEvent', common(1, 'device-2', { deviceBindingHash: 'device:alpha', nextState: 'revoked', fields: { status: 'revoked' } }, { revocationEpoch: 3 }));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(rollback.errorCode, 'revocation-rollback');
  });

  await check('quota debit is separate from tier and cannot double charge', async () => {
    const integration = fixture.createIntegration(dependencies());
    const credit = common(0, 'quota-credit', {
      walletId: 'wallet-1',
      create: { walletId: 'wallet-1', deviceBindingHash: 'device:alpha', balance: 5, revocationEpoch: 3 },
      event: { operationId: 'domain-credit', type: 'credit', amount: 2, revision: 1, revocationEpoch: 3, deviceBindingHash: 'device:alpha', signatureValid: true, clockValid: true },
    });
    const credited = await integration.invoke('commercial.applyQuotaOperation', credit);
    const debit = common(1, 'quota-debit', {
      walletId: 'wallet-1',
      event: { operationId: 'domain-debit', type: 'debit', amount: 3, revision: 2, revocationEpoch: 3, deviceBindingHash: 'device:alpha', signatureValid: true, clockValid: true },
    });
    const first = await integration.invoke('commercial.applyQuotaOperation', debit);
    const repeated = await integration.invoke('commercial.applyQuotaOperation', debit);
    assert.strictEqual(credited.ok, true);
    assert.strictEqual(first.value.balance, 4);
    assert.strictEqual(repeated.value.balance, 4);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(first.value, 'tier'), false);
  });

  await check('offline grace cannot exceed the signed seven-day ceiling', async () => {
    const integration = fixture.createIntegration(dependencies());
    await activate(integration);
    const start = 1_000_000;
    const grace = await integration.invoke('commercial.applySubscriptionEvent', common(2, 'sub-grace', subscriptionPayload('offline-grace', 3, {
      lastVerifiedOnlineAtMs: start,
      offlineGraceEndsAtMs: start + fixture.MAX_OFFLINE_GRACE_MS,
    })));
    assert.strictEqual(grace.ok, true);
    const expired = await integration.invoke('commercial.evaluateAccess', {
      requestId: 'grace-expired', featureKey: 'ai-notes', signedEvidence: { signatureValid: true, subscriptionId: 'sub_synthetic_001' }, deviceBindingHash: 'device:alpha', revocationEpoch: 3, nowMs: start + fixture.MAX_OFFLINE_GRACE_MS + 1,
    });
    assert.strictEqual(expired.value.paidAccessAllowed, false);
    assert.strictEqual(expired.value.freeManualAllowed, true);

    const created = domain.createSubscription({
      subscriptionId: 'sub_synthetic_001', tier: 'pro', deviceBindingHash: 'device:alpha', revocationEpoch: 3,
    });
    const pending = domain.applySubscriptionTransition(created, subscriptionPayload('pending', 1).event).value;
    const active = domain.applySubscriptionTransition(pending, subscriptionPayload('active', 2).event).value;
    const validGrace = domain.applySubscriptionTransition(active, subscriptionPayload('offline-grace', 3, {
      lastVerifiedOnlineAtMs: start,
      offlineGraceEndsAtMs: start + fixture.MAX_OFFLINE_GRACE_MS,
    }).event).value;
    const tamperedEnvelope = fixture.initialEnvelope();
    tamperedEnvelope.revision = 1;
    tamperedEnvelope.subscriptions.sub_synthetic_001 = Object.assign({}, validGrace, {
      offlineGraceEndsAtMs: start + fixture.MAX_OFFLINE_GRACE_MS * 2,
    });
    const tamperedIntegration = fixture.createIntegration(dependencies({ durable: { initialState: tamperedEnvelope } }));
    const clamped = await tamperedIntegration.invoke('commercial.evaluateAccess', {
      requestId: 'grace-tampered', featureKey: 'ai-notes', signedEvidence: { signatureValid: true, subscriptionId: 'sub_synthetic_001' }, deviceBindingHash: 'device:alpha', revocationEpoch: 3, nowMs: start + fixture.MAX_OFFLINE_GRACE_MS + 1,
    });
    assert.strictEqual(clamped.value.paidAccessAllowed, false);
  });

  await check('sensitive clinical, path and secret fields are rejected before persistence', async () => {
    const integration = fixture.createIntegration(dependencies());
    for (const fields of [{ transcriptBody: 'synthetic' }, { localPath: 'C:\\synthetic' }, { providerSecret: 'synthetic' }]) {
      const result = await integration.invoke('commercial.applyOrderEvent', common(0, `sensitive-${Object.keys(fields)[0]}`, { orderId: 'order-sensitive', nextState: 'pending', fields }));
      assert.strictEqual(result.errorCode, 'sensitive-field-rejected');
    }
    const disguised = await integration.invoke('commercial.applyOrderEvent', common(0, 'unknown-field', {
      orderId: 'order-sensitive', nextState: 'pending', fields: { description: 'synthetic clinical-like body' },
    }));
    assert.strictEqual(disguised.errorCode, 'invalid-event');
    const snapshot = await integration.invoke('commercial.getSnapshot', { requestId: 'snapshot-sensitive' });
    assert.strictEqual(snapshot.revision, 0);
  });

  await check('order and device records expose only redacted UI projections', async () => {
    const integration = fixture.createIntegration(dependencies());
    await integration.invoke('commercial.applyOrderEvent', common(0, 'order-projection', { orderId: 'order-2', nextState: 'paid', fields: { amountMinor: 8800, currency: 'CNY', providerReferenceHash: 'opaque' } }));
    await integration.invoke('commercial.applyDeviceEvent', common(1, 'device-projection', { deviceBindingHash: 'device:alpha', nextState: 'active', fields: { status: 'active', bindingAssurance: 'dpapi' } }));
    const snapshot = await integration.invoke('commercial.getSnapshot', { requestId: 'projection' });
    const encoded = JSON.stringify(snapshot.value);
    assert.strictEqual(encoded.includes('providerReferenceHash'), false);
    assert.strictEqual(encoded.includes('bindingAssurance'), false);
    assert.strictEqual(snapshot.value.orders[0].state, 'paid');
    assert.strictEqual(snapshot.value.devices[0].status, 'active');
  });

  await check('audit events are append-only identifier/status metadata', async () => {
    const integration = fixture.createIntegration(dependencies());
    await integration.invoke('commercial.applyOrderEvent', common(0, 'audit-order', { orderId: 'order-audit', nextState: 'paid', fields: { amountMinor: 100, currency: 'CNY' } }));
    const audit = await integration.invoke('commercial.getAuditPage', { requestId: 'audit-page', limit: 10 });
    assert.strictEqual(audit.value.items.length, 1);
    assert.deepStrictEqual(Object.keys(audit.value.items[0]).sort(), [
      'actorKind', 'auditId', 'entityId', 'entityType', 'nextState', 'operationId',
      'priorState', 'resultCode', 'revision', 'revocationEpoch', 'timestamp',
    ]);
  });

  process.stdout.write(`COMMERCIAL_INTEGRATION_CONTRACT: PASS (${checks}/${checks})\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
