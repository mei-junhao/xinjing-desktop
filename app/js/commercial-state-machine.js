/* XinJing v5 commercial domain state machines. Pure logic; no payment or persistence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJCommercialStateMachine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
  const STATES = Object.freeze([
    'created',
    'pending',
    'active',
    'expired',
    'revoked',
    'refunded',
    'transfer-pending',
    'transfer-completed',
    'offline-grace',
    'blocked',
    'unknown',
  ]);
  const PAID_ACCESS_STATES = Object.freeze(new Set(['active', 'offline-grace']));
  const TRANSITIONS = Object.freeze({
    created: Object.freeze(['pending', 'blocked']),
    pending: Object.freeze(['active', 'expired', 'revoked', 'refunded', 'transfer-pending', 'blocked']),
    active: Object.freeze(['expired', 'revoked', 'refunded', 'transfer-pending', 'offline-grace', 'blocked']),
    expired: Object.freeze(['pending', 'revoked', 'refunded', 'blocked']),
    revoked: Object.freeze([]),
    refunded: Object.freeze([]),
    'transfer-pending': Object.freeze(['transfer-completed', 'active', 'revoked', 'refunded', 'blocked']),
    'transfer-completed': Object.freeze(['active', 'revoked', 'refunded', 'blocked']),
    'offline-grace': Object.freeze(['active', 'expired', 'revoked', 'refunded', 'blocked']),
    blocked: Object.freeze(['pending', 'revoked', 'refunded']),
    unknown: Object.freeze([]),
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + canonical(value[key]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function nonempty(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function safeInteger(value, minimum) {
    return Number.isSafeInteger(value) && value >= minimum;
  }

  function knownState(value) {
    return STATES.includes(value);
  }

  function validOperations(value) {
    return Array.isArray(value) && value.every(function (entry) {
      return entry && nonempty(entry.id) && nonempty(entry.fingerprint);
    });
  }

  function findOperation(current, operationId) {
    return current.operations.find(function (entry) { return entry.id === operationId; }) || null;
  }

  function failure(errorCode, current) {
    return Object.freeze({ ok: false, errorCode, value: clone(current) });
  }

  function success(value, idempotent) {
    return Object.freeze({ ok: true, errorCode: '', idempotent: !!idempotent, value: clone(value) });
  }

  function validateSecurity(current, event) {
    if (event.signatureValid !== true) return 'invalid-signature';
    if (event.clockValid !== true) return 'clock-anomaly';
    if (!safeInteger(event.revocationEpoch, 0) || event.revocationEpoch < current.revocationEpoch) {
      return 'revocation-rollback';
    }
    if (!nonempty(event.deviceBindingHash) || event.deviceBindingHash !== current.deviceBindingHash) {
      return 'device-mismatch';
    }
    return '';
  }

  function createSubscription(options) {
    const input = options && typeof options === 'object' ? options : {};
    if (!nonempty(input.subscriptionId)) throw new TypeError('subscriptionId is required');
    if (!nonempty(input.deviceBindingHash)) throw new TypeError('deviceBindingHash is required');
    if (!['pro', 'custom'].includes(input.tier)) throw new TypeError('tier must be pro or custom');
    return Object.freeze({
      kind: 'subscription',
      subscriptionId: input.subscriptionId.trim(),
      state: 'created',
      tier: input.tier,
      revision: 0,
      revocationEpoch: safeInteger(input.revocationEpoch, 0) ? input.revocationEpoch : 0,
      deviceBindingHash: input.deviceBindingHash.trim(),
      pendingTargetDeviceBindingHash: '',
      lastVerifiedOnlineAtMs: null,
      offlineGraceEndsAtMs: null,
      operations: [],
    });
  }

  function validSubscription(record) {
    return !!record && record.kind === 'subscription' && nonempty(record.subscriptionId)
      && knownState(record.state) && ['pro', 'custom'].includes(record.tier)
      && safeInteger(record.revision, 0) && safeInteger(record.revocationEpoch, 0)
      && nonempty(record.deviceBindingHash) && validOperations(record.operations);
  }

  function applySubscriptionTransition(record, event) {
    const current = validSubscription(record) ? clone(record) : null;
    if (!current) return failure('invalid-subscription', record || {});
    if (!event || typeof event !== 'object' || !nonempty(event.operationId)) return failure('invalid-event', current);
    const fingerprint = canonical(event);
    const prior = findOperation(current, event.operationId);
    if (prior) {
      if (prior.fingerprint === fingerprint) return success(current, true);
      return failure('operation-conflict', current);
    }
    if (!knownState(event.targetState) || event.targetState === 'unknown') return failure('unknown-state', current);
    const allowed = TRANSITIONS[current.state] || [];
    if (!allowed.includes(event.targetState)) return failure('illegal-transition', current);
    if (!safeInteger(event.revision, 1) || event.revision <= current.revision) return failure('stale-revision', current);
    const securityError = validateSecurity(current, event);
    if (securityError) return failure(securityError, current);

    const next = clone(current);
    if (event.targetState === 'transfer-pending') {
      if (!nonempty(event.targetDeviceBindingHash) || event.targetDeviceBindingHash === current.deviceBindingHash) {
        return failure('invalid-transfer-target', current);
      }
      next.pendingTargetDeviceBindingHash = event.targetDeviceBindingHash.trim();
    } else if (event.targetState === 'transfer-completed') {
      if (!nonempty(current.pendingTargetDeviceBindingHash)
        || event.targetDeviceBindingHash !== current.pendingTargetDeviceBindingHash) {
        return failure('transfer-target-mismatch', current);
      }
      next.deviceBindingHash = current.pendingTargetDeviceBindingHash;
      next.pendingTargetDeviceBindingHash = '';
    } else if (current.state === 'transfer-pending' && event.targetState === 'active') {
      next.pendingTargetDeviceBindingHash = '';
    }

    if (event.targetState === 'offline-grace') {
      if (!safeInteger(event.lastVerifiedOnlineAtMs, 0) || !safeInteger(event.offlineGraceEndsAtMs, 0)) {
        return failure('invalid-offline-grace', current);
      }
      const maximum = event.lastVerifiedOnlineAtMs + MAX_OFFLINE_GRACE_MS;
      if (event.offlineGraceEndsAtMs <= event.lastVerifiedOnlineAtMs || event.offlineGraceEndsAtMs > maximum) {
        return failure('invalid-offline-grace', current);
      }
      next.lastVerifiedOnlineAtMs = event.lastVerifiedOnlineAtMs;
      next.offlineGraceEndsAtMs = event.offlineGraceEndsAtMs;
    } else {
      next.lastVerifiedOnlineAtMs = null;
      next.offlineGraceEndsAtMs = null;
    }

    next.state = event.targetState;
    next.revision = event.revision;
    next.revocationEpoch = event.revocationEpoch;
    next.operations.push({ id: event.operationId, fingerprint });
    return success(next, false);
  }

  function subscriptionAccess(record, context) {
    const result = {
      freeManualAllowed: true,
      paidAccessAllowed: false,
      tier: 'free',
      state: record && knownState(record.state) ? record.state : 'unknown',
      errorCode: '',
    };
    if (!validSubscription(record)) return Object.freeze(Object.assign(result, { errorCode: 'invalid-subscription' }));
    const current = context && typeof context === 'object' ? context : {};
    if (current.signatureValid !== true) return Object.freeze(Object.assign(result, { errorCode: 'invalid-signature' }));
    if (current.clockValid !== true) return Object.freeze(Object.assign(result, { errorCode: 'clock-anomaly' }));
    if (!safeInteger(current.revocationEpoch, 0) || current.revocationEpoch < record.revocationEpoch) {
      return Object.freeze(Object.assign(result, { errorCode: 'revocation-rollback' }));
    }
    if (current.deviceBindingHash !== record.deviceBindingHash) {
      return Object.freeze(Object.assign(result, { errorCode: 'device-mismatch' }));
    }
    if (!PAID_ACCESS_STATES.has(record.state)) {
      return Object.freeze(Object.assign(result, { errorCode: 'state-not-active' }));
    }
    if (record.state === 'offline-grace') {
      if (!safeInteger(current.nowMs, 0) || !safeInteger(record.lastVerifiedOnlineAtMs, 0)
        || !safeInteger(record.offlineGraceEndsAtMs, 0)) {
        return Object.freeze(Object.assign(result, { errorCode: 'invalid-offline-grace' }));
      }
      const maxEnd = record.lastVerifiedOnlineAtMs + MAX_OFFLINE_GRACE_MS;
      const effectiveEnd = Math.min(record.offlineGraceEndsAtMs, maxEnd);
      if (current.nowMs > effectiveEnd) return Object.freeze(Object.assign(result, { errorCode: 'offline-grace-expired' }));
    }
    return Object.freeze(Object.assign(result, {
      paidAccessAllowed: true,
      tier: record.tier,
      errorCode: '',
    }));
  }

  function createQuotaWallet(options) {
    const input = options && typeof options === 'object' ? options : {};
    if (!nonempty(input.walletId)) throw new TypeError('walletId is required');
    if (!nonempty(input.deviceBindingHash)) throw new TypeError('deviceBindingHash is required');
    const balance = input.balance == null ? 0 : input.balance;
    if (!safeInteger(balance, 0)) throw new TypeError('balance must be a non-negative safe integer');
    return Object.freeze({
      kind: 'request-package-quota',
      walletId: input.walletId.trim(),
      balance,
      revision: 0,
      revocationEpoch: safeInteger(input.revocationEpoch, 0) ? input.revocationEpoch : 0,
      deviceBindingHash: input.deviceBindingHash.trim(),
      operations: [],
    });
  }

  function validWallet(wallet) {
    return !!wallet && wallet.kind === 'request-package-quota' && nonempty(wallet.walletId)
      && safeInteger(wallet.balance, 0) && safeInteger(wallet.revision, 0)
      && safeInteger(wallet.revocationEpoch, 0) && nonempty(wallet.deviceBindingHash)
      && validOperations(wallet.operations);
  }

  function applyQuotaOperation(wallet, event) {
    const current = validWallet(wallet) ? clone(wallet) : null;
    if (!current) return failure('invalid-wallet', wallet || {});
    if (!event || typeof event !== 'object' || !nonempty(event.operationId)) return failure('invalid-event', current);
    const fingerprint = canonical(event);
    const prior = findOperation(current, event.operationId);
    if (prior) {
      if (prior.fingerprint === fingerprint) return success(current, true);
      return failure('operation-conflict', current);
    }
    if (!['credit', 'debit'].includes(event.type) || !safeInteger(event.amount, 1)) {
      return failure('invalid-quota-operation', current);
    }
    if (!safeInteger(event.revision, 1) || event.revision <= current.revision) return failure('stale-revision', current);
    const securityError = validateSecurity(current, event);
    if (securityError) return failure(securityError, current);
    if (event.type === 'debit' && event.amount > current.balance) return failure('insufficient-quota', current);
    const balance = event.type === 'credit' ? current.balance + event.amount : current.balance - event.amount;
    if (!safeInteger(balance, 0)) return failure('quota-overflow', current);
    const next = clone(current);
    next.balance = balance;
    next.revision = event.revision;
    next.revocationEpoch = event.revocationEpoch;
    next.operations.push({ id: event.operationId, fingerprint });
    return success(next, false);
  }

  return Object.freeze({
    MAX_OFFLINE_GRACE_MS,
    STATES,
    TRANSITIONS,
    createSubscription,
    applySubscriptionTransition,
    subscriptionAccess,
    createQuotaWallet,
    applyQuotaOperation,
  });
});
