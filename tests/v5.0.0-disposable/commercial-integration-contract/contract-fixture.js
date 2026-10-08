'use strict';

const crypto = require('crypto');

const MAX_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNELS = Object.freeze([
  'commercial.getSnapshot',
  'commercial.evaluateAccess',
  'commercial.applySubscriptionEvent',
  'commercial.applyOrderEvent',
  'commercial.applyDeviceEvent',
  'commercial.applyQuotaOperation',
  'commercial.getAuditPage',
]);
const FORBIDDEN_KEY = /(?:clinical|transcript|noteBody|reportBody|supervisionBody|knowledgeBody|prompt|modelInput|modelOutput|filePath|localPath|secret|token|credential|webhookBody|cardNumber|privateKey)/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function containsForbidden(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEY.test(key) || containsForbidden(value[key]));
}

function failure(errorCode) {
  return Object.freeze({ ok: false, errorCode, retryable: false });
}

function success(value, revision, idempotent) {
  return Object.freeze({ ok: true, value: clone(value), revision, idempotent: !!idempotent });
}

function initialEnvelope() {
  return {
    schemaVersion: 1,
    revision: 0,
    revocationEpoch: 0,
    subscriptions: {},
    orders: {},
    devices: {},
    quotaWallets: {},
    operationReceipts: {},
    auditEvents: [],
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function createMemoryDurable(options) {
  const settings = Object.assign({ delayMs: 8, failRead: false, failCommit: false, initialState: null }, options || {});
  let state = settings.initialState ? clone(settings.initialState) : initialEnvelope();
  return {
    async read() {
      if (settings.failRead) return { ok: false, errorCode: 'durable-read-failed' };
      return { ok: true, value: clone(state), revision: state.revision };
    },
    async commit(snapshot) {
      await new Promise((resolve) => setTimeout(resolve, settings.delayMs));
      if (settings.failCommit) return { ok: false, errorCode: 'durable-write-failed' };
      state = clone(snapshot);
      return { ok: true, revision: state.revision };
    },
  };
}

function validCommonRequest(request) {
  return !!request && typeof request === 'object'
    && typeof request.requestId === 'string' && request.requestId.length > 0
    && typeof request.operationId === 'string' && request.operationId.length > 0
    && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0
    && Number.isSafeInteger(request.revocationEpoch) && request.revocationEpoch >= 0
    && typeof request.deviceBindingHash === 'string' && request.deviceBindingHash.length > 0
    && request.payload && typeof request.payload === 'object';
}

function validRequestId(request) {
  return !!request && typeof request.requestId === 'string' && request.requestId.length > 0;
}

function redactEntity(entity) {
  const allowed = [
    'subscriptionId', 'orderId', 'deviceBindingHash', 'walletId', 'tier', 'state', 'status',
    'sku', 'currency', 'amountMinor', 'balance', 'revision', 'revocationEpoch',
    'lastVerifiedOnlineAtMs', 'offlineGraceEndsAtMs', 'updatedAt',
  ];
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(entity, key)).map((key) => [key, entity[key]]));
}

function createIntegration(dependencies) {
  const durable = dependencies.durable;
  const domain = dependencies.domain;
  const featureRegistry = dependencies.featureRegistry;
  const verifyLicense = dependencies.verifyLicense;

  async function readEnvelope() {
    const result = await durable.read();
    if (!result || !result.ok) return failure((result && result.errorCode) || 'durable-read-failed');
    if (!result.value || result.value.schemaVersion !== 1 || !Number.isSafeInteger(result.value.revision)) return failure('corrupt-state');
    return result;
  }

  async function commitCommand(request, entityType, entityId, apply) {
    if (!validCommonRequest(request)) return failure('invalid-request');
    if (containsForbidden(request)) return failure('sensitive-field-rejected');
    const read = await readEnvelope();
    if (!read.ok) return read;
    const current = read.value;
    const requestHash = digest({ entityType, entityId, request: Object.assign({}, request, { requestId: undefined }) });
    const prior = current.operationReceipts[request.operationId];
    if (prior) {
      if (prior.requestHash !== requestHash) return failure('operation-conflict');
      return success(prior.value, prior.resultingRevision, true);
    }
    if (request.expectedRevision !== current.revision) return failure('stale-revision');
    if (request.revocationEpoch < current.revocationEpoch) return failure('revocation-rollback');

    const domainResult = apply(current);
    if (!domainResult.ok) return domainResult;
    const next = clone(current);
    next.revision += 1;
    next.revocationEpoch = Math.max(next.revocationEpoch, request.revocationEpoch);
    next.updatedAt = '2026-07-27T00:00:00.000Z';
    domainResult.write(next);
    const value = redactEntity(domainResult.value);
    next.operationReceipts[request.operationId] = {
      operationId: request.operationId,
      requestHash,
      entityType,
      entityId,
      resultingRevision: next.revision,
      resultCode: 'ok',
      timestamp: next.updatedAt,
      value,
    };
    next.auditEvents.push({
      auditId: `audit-${next.revision}`,
      operationId: request.operationId,
      actorKind: 'local-user',
      entityType,
      entityId,
      priorState: domainResult.priorState || '',
      nextState: domainResult.nextState || '',
      resultCode: 'ok',
      revision: next.revision,
      revocationEpoch: next.revocationEpoch,
      timestamp: next.updatedAt,
    });

    const committed = await durable.commit(next);
    if (!committed || !committed.ok) return failure((committed && committed.errorCode) || 'durable-write-failed');
    const persisted = await readEnvelope();
    if (!persisted.ok || persisted.revision !== next.revision) return failure('durable-readback-mismatch');
    return success(value, next.revision, false);
  }

  async function applySubscriptionEvent(request) {
    const id = request && request.payload && request.payload.subscriptionId;
    return commitCommand(request, 'subscription', id, (envelope) => {
      const existing = envelope.subscriptions[id];
      let result;
      try {
        if (!existing) {
          const created = domain.createSubscription(request.payload.create);
          result = domain.applySubscriptionTransition(created, request.payload.event);
        } else {
          result = domain.applySubscriptionTransition(existing, request.payload.event);
        }
      } catch (_error) {
        return failure('invalid-subscription-event');
      }
      if (!result.ok) return result;
      return {
        ok: true,
        value: result.value,
        priorState: existing ? existing.state : '',
        nextState: result.value.state,
        write(next) { next.subscriptions[id] = clone(result.value); },
      };
    });
  }

  async function applyQuotaOperation(request) {
    const id = request && request.payload && request.payload.walletId;
    return commitCommand(request, 'quota', id, (envelope) => {
      let wallet = envelope.quotaWallets[id];
      try {
        if (!wallet) wallet = domain.createQuotaWallet(request.payload.create);
        const result = domain.applyQuotaOperation(wallet, request.payload.event);
        if (!result.ok) return result;
        return {
          ok: true,
          value: result.value,
          write(next) { next.quotaWallets[id] = clone(result.value); },
        };
      } catch (_error) {
        return failure('invalid-quota-operation');
      }
    });
  }

  async function applySimpleEntity(request, entityType, collection, idKey, allowedFields) {
    const payload = request && request.payload;
    const id = payload && payload[idKey];
    return commitCommand(request, entityType, id, (envelope) => {
      if (!id || !payload || typeof payload.nextState !== 'string') return failure('invalid-event');
      const fields = payload.fields || {};
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return failure('invalid-event');
      if (Object.keys(fields).some((key) => !allowedFields.includes(key))) return failure('invalid-event');
      const prior = envelope[collection][id];
      const revision = prior ? prior.revision + 1 : 1;
      const value = Object.assign({}, prior || {}, fields, {
        [idKey]: id,
        state: payload.nextState,
        revision,
        revocationEpoch: request.revocationEpoch,
        updatedAt: '2026-07-27T00:00:00.000Z',
      });
      return {
        ok: true,
        value,
        priorState: prior ? prior.state : '',
        nextState: value.state,
        write(next) { next[collection][id] = clone(value); },
      };
    });
  }

  async function evaluateAccess(request) {
    if (!validRequestId(request) || typeof request.featureKey !== 'string') return failure('invalid-request');
    if (request.featureKey === 'manual-core') {
      return success({ freeManualAllowed: true, paidAccessAllowed: false, reason: 'free-manual', tier: 'free', quotaAvailable: false }, 0, false);
    }
    const feature = featureRegistry[request.featureKey];
    if (!feature) return failure('unknown-feature');
    if (typeof request.deviceBindingHash !== 'string' || !Number.isSafeInteger(request.revocationEpoch) || !Number.isFinite(request.nowMs)) return failure('invalid-request');
    const license = verifyLicense(request.signedEvidence);
    if (!license || !license.ok) return failure('invalid-license');
    const read = await readEnvelope();
    if (!read.ok) return read;
    const subscription = read.value.subscriptions[license.subscriptionId];
    const access = domain.subscriptionAccess(subscription, {
      deviceBindingHash: request.deviceBindingHash,
      signatureValid: true,
      clockValid: true,
      revocationEpoch: request.revocationEpoch,
      nowMs: request.nowMs,
    });
    const tierAllowed = feature.minimumTier === 'free'
      || (feature.minimumTier === 'pro' && ['pro', 'custom'].includes(access.tier))
      || (feature.minimumTier === 'custom' && access.tier === 'custom');
    return success({
      freeManualAllowed: true,
      paidAccessAllowed: !!access.paidAccessAllowed && tierAllowed,
      reason: access.errorCode || (tierAllowed ? 'allowed' : 'tier-denied'),
      tier: access.tier,
      quotaAvailable: false,
    }, read.revision, false);
  }

  async function getSnapshot(request) {
    if (!validRequestId(request)) return failure('invalid-request');
    const read = await readEnvelope();
    if (!read.ok) return read;
    return success({
      subscriptions: Object.values(read.value.subscriptions).map(redactEntity),
      orders: Object.values(read.value.orders).map(redactEntity),
      devices: Object.values(read.value.devices).map(redactEntity),
      quotaWallets: Object.values(read.value.quotaWallets).map(redactEntity),
    }, read.revision, false);
  }

  async function getAuditPage(request) {
    if (!validRequestId(request)) return failure('invalid-request');
    const read = await readEnvelope();
    if (!read.ok) return read;
    const limit = request && Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(100, request.limit)) : 50;
    return success({ items: read.value.auditEvents.slice(-limit).map(clone), nextCursor: null }, read.revision, false);
  }

  const handlers = {
    'commercial.getSnapshot': getSnapshot,
    'commercial.evaluateAccess': evaluateAccess,
    'commercial.applySubscriptionEvent': applySubscriptionEvent,
    'commercial.applyOrderEvent': (request) => applySimpleEntity(request, 'order', 'orders', 'orderId', [
      'subjectIdHash', 'sku', 'amountMinor', 'currency', 'status', 'providerReferenceHash', 'fulfillmentReferenceHash',
    ]),
    'commercial.applyDeviceEvent': (request) => applySimpleEntity(request, 'device', 'devices', 'deviceBindingHash', [
      'subjectIdHash', 'status', 'bindingAssurance',
    ]),
    'commercial.applyQuotaOperation': applyQuotaOperation,
    'commercial.getAuditPage': getAuditPage,
  };

  return {
    channels: CHANNELS,
    async invoke(channel, request) {
      const handler = handlers[channel];
      if (!handler) return failure('unknown-channel');
      return handler(request);
    },
  };
}

module.exports = {
  CHANNELS,
  MAX_OFFLINE_GRACE_MS,
  createIntegration,
  createMemoryDurable,
  initialEnvelope,
};
