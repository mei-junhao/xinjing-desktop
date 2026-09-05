'use strict';

// v5 商业边界只在主进程使用。渲染层不能提供 caller、deviceId 或 billingMode。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./commercial-billing-core.js');
const durable = require('./commercial-durable-persistence.js');
const domain = require('./commercial-state-machine.js');
const entitlements = require('./entitlements.js');

const MODES = new Set(['money-per-request', 'request-count-quota', 'byok', 'trial']);
const SENSITIVE_KEY = /prompt|provider.?payload|provider.?secret|clinical|secret|password|token|credential|api.?key|raw.?path|internal.?routing|webhook.?body|card.?number|private.?key/i;

// 官方价格目录边界（v5.0-commercial-server-authoritative-balance-v1 §4/§5）：
// 管理员服务器目录可用之前，官方目录恒为空——没有任何官方付费模型可选或可计费。
// 生产 facade 的 quote/reserve 在任何商业变更之前稳定失败为 catalog-unavailable；
// 不伪造零价格、不回退 trial/BYOK/quota，且 revision、balanceMinor、
// reservedMinor、requestCharges、operationReceipts、auditEvents 全部保持不变。
const OFFICIAL_CATALOG_EMPTY = true;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function failure(errorCode) {
  return { ok: false, errorCode, retryable: false };
}

function errorWithCode(errorCode) {
  const error = new Error(errorCode);
  error.errorCode = errorCode;
  error.retryable = false;
  return error;
}

function ensurePlainObject(value, errorCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errorWithCode(errorCode || 'invalid-request');
  return value;
}

function assertSafeKeys(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertSafeKeys);
    return;
  }
  Object.keys(value).forEach((key) => {
    if (SENSITIVE_KEY.test(key)) throw errorWithCode('sensitive-field-rejected');
    assertSafeKeys(value[key]);
  });
}

function assertAllowedKeys(value, allowed) {
  ensurePlainObject(value);
  assertSafeKeys(value);
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) throw errorWithCode('invalid-request');
  });
}

function identifier(value, field) {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(result)) throw errorWithCode('invalid-request');
  return result;
}

function optionalRevision(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw errorWithCode('invalid-request');
  return value;
}

function initialEnvelope() {
  return {
    schemaVersion: 1,
    revision: 0,
    revocationEpoch: 0,
    subscriptions: {},
    orders: {},
    devices: {},
    balanceMinor: 0,
    reservedMinor: 0,
    quotaWallets: {},
    requestCharges: {},
    operationReceipts: {},
    auditEvents: [],
    updatedAt: new Date().toISOString(),
  };
}

function parseEnvelope(text) {
  try {
    return durable.normalizeEnvelope(JSON.parse(text));
  } catch (error) {
    throw errorWithCode('durable-read-failed');
  }
}

function createFileAdapter(filePath) {
  const lockPath = filePath + '.lock';
  let lockHandle = null;
  let previousText;
  let pendingSnapshot = null;
  let sequence = 0;
  let closed = false;
  let writeQueue = Promise.resolve();

  function queued(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function acquireLock() {
    if (lockHandle) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        lockHandle = await fs.promises.open(lockPath, 'wx', 0o600);
        return;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw errorWithCode('durable-write-failed');
        await sleep(25);
      }
    }
    throw errorWithCode('durable-write-failed');
  }

  async function releaseLock() {
    const handle = lockHandle;
    lockHandle = null;
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
    try { await fs.promises.unlink(lockPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw errorWithCode('durable-write-failed');
    }
  }

  async function atomicReplace(text) {
    const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now() + '-' + (++sequence);
    let handle = null;
    try {
      handle = await fs.promises.open(tempPath, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch (_) {}
      }
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      throw errorWithCode('durable-write-failed');
    }
  }

  async function restorePrevious() {
    if (previousText === undefined) return;
    try {
      await atomicReplace(previousText);
    } catch (_) {
      // 保留原始失败码；调用方仍然按失败关闭，绝不把回滚失败当成功。
    }
  }

  async function readCurrent() {
    try {
      return parseEnvelope(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') throw errorWithCode('durable-read-failed');
      throw errorWithCode('durable-read-failed');
    }
  }

  async function ensureInitial(state) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try {
      return await readCurrent();
    } catch (error) {
      if (!error || error.errorCode !== 'durable-read-failed' || fs.existsSync(filePath)) throw error;
      durable.validateEnvelope(state);
      await acquireLock();
      try {
        if (fs.existsSync(filePath)) return await readCurrent();
        await atomicReplace(JSON.stringify(state));
        return clone(state);
      } finally {
        await releaseLock();
      }
    }
  }

  return {
    ensureInitial,
    readCurrent,
    write(snapshot) {
      return queued(async () => {
        if (closed) throw errorWithCode('durable-write-failed');
        const legacyInput = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
          && Object.keys(snapshot).sort().join('\0') === ['schemaVersion', 'revision', 'balanceMinor', 'reservedMinor', 'quotaWallets', 'requestCharges', 'operationReceipts', 'auditEvents', 'updatedAt'].sort().join('\0');
        snapshot = durable.normalizeEnvelope(snapshot);
        durable.validateEnvelope(snapshot);
        await acquireLock();
        try {
          previousText = await fs.promises.readFile(filePath, 'utf8');
          const current = parseEnvelope(previousText);
          if (current.revision !== snapshot.revision - 1) throw errorWithCode('stale-revision');
          if (legacyInput) {
            snapshot.revocationEpoch = current.revocationEpoch;
            snapshot.subscriptions = clone(current.subscriptions);
            snapshot.orders = clone(current.orders);
            snapshot.devices = clone(current.devices);
          }
          pendingSnapshot = clone(snapshot);
          await atomicReplace(JSON.stringify(snapshot));
        } catch (error) {
          await releaseLock();
          previousText = undefined;
          pendingSnapshot = null;
          throw error && error.errorCode ? error : errorWithCode('durable-write-failed');
        }
      });
    },
    async read() {
      if (closed || !lockHandle || !pendingSnapshot) throw errorWithCode('durable-read-failed');
      try {
        const text = await fs.promises.readFile(filePath, 'utf8');
        const value = parseEnvelope(text);
        if (durable.digest(value) !== durable.digest(pendingSnapshot) || JSON.stringify(value) !== JSON.stringify(pendingSnapshot)) {
          await restorePrevious();
          throw errorWithCode('readback-mismatch');
        }
        await releaseLock();
        previousText = undefined;
        pendingSnapshot = null;
        return clone(value);
      } catch (error) {
        await restorePrevious();
        try { await releaseLock(); } catch (_) {}
        previousText = undefined;
        pendingSnapshot = null;
        throw error && error.errorCode ? error : errorWithCode('durable-read-failed');
      }
    },
    async close() {
      closed = true;
      if (lockHandle) {
        await restorePrevious();
        try { await releaseLock(); } catch (_) {}
      }
      previousText = undefined;
      pendingSnapshot = null;
    },
  };
}

function addCaller(input, caller, deviceId) {
  const next = Object.assign({}, input, { caller, deviceId });
  return next;
}

async function createCommercialFacade(options) {
  const config = options || {};
  const filePath = String(config.filePath || '');
  if (!path.isAbsolute(filePath)) throw new TypeError('filePath must be absolute');
  const deviceId = identifier(config.deviceId || 'synthetic-device', 'deviceId');
  const caller = 'main-process';
  const trustedReconciliation = config.trustedReconciliation === true;
  const trustedContextProvider = typeof config.trustedContextProvider === 'function' ? config.trustedContextProvider : null;
  const adapter = createFileAdapter(filePath);
  const initial = await adapter.ensureInitial(initialEnvelope());
  const service = core.createBillingService({ initialState: initial, persistenceAdapter: adapter });
  let integrationQueue = Promise.resolve();

  function enqueueIntegration(operation) {
    const run = integrationQueue.then(operation, operation);
    integrationQueue = run.catch(() => undefined);
    return run;
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function safeState(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(value);
  }

  function trustedContext(input) {
    const supplied = trustedContextProvider ? (trustedContextProvider() || {}) : null;
    const source = supplied || input || {};
    const binding = source.deviceBindingHash || (input && input.deviceBindingHash) || deviceId;
    if (!safeState(binding)) throw errorWithCode('invalid-request');
    const epoch = source.revocationEpoch !== undefined ? source.revocationEpoch : (input && input.revocationEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw errorWithCode('invalid-request');
    const evidence = source.signedEvidence !== undefined ? source.signedEvidence : (input && input.signedEvidence);
    if (evidence !== undefined && evidence !== null) assertAllowedKeys(evidence, new Set(['signatureValid', 'clockValid', 'subscriptionId', 'tier', 'revocationEpoch', 'licenseIdHash']));
    return {
      deviceBindingHash: binding,
      revocationEpoch: epoch,
      signedEvidence: evidence || null,
      signatureValid: evidence && evidence.signatureValid === true,
      clockValid: evidence && evidence.clockValid !== false,
      trusted: !!supplied,
    };
  }

  function commonRequest(input) {
    const value = ensurePlainObject(input);
    assertAllowedKeys(value, new Set(['requestId', 'operationId', 'expectedRevision', 'revocationEpoch', 'deviceBindingHash', 'signedEvidence', 'payload']));
    if (!safeState(value.requestId) || !safeState(value.operationId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !plainPayload(value.payload)) throw errorWithCode('invalid-request');
    const context = trustedContext(value);
    return {
      requestId: value.requestId,
      operationId: value.operationId,
      expectedRevision: value.expectedRevision,
      revocationEpoch: context.revocationEpoch,
      deviceBindingHash: context.deviceBindingHash,
      signedEvidence: context.signedEvidence,
      payload: value.payload,
      context,
    };
  }

  function plainPayload(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function publicRequestHash(request) {
    const copy = clone(request);
    delete copy.requestId;
    delete copy.context;
    return core.canonicalHash(copy);
  }

  function redactEntity(entity) {
    const allowed = [
      'subscriptionId', 'orderId', 'deviceBindingHash', 'walletId', 'tier', 'state', 'status',
      'sku', 'currency', 'amountMinor', 'balance', 'revision', 'revocationEpoch',
      'lastVerifiedOnlineAtMs', 'offlineGraceEndsAtMs', 'updatedAt',
    ];
    const result = {};
    if (entity && Object.prototype.hasOwnProperty.call(entity, 'balance')) entity.remaining = entity.balance;
    if (entity && Object.prototype.hasOwnProperty.call(entity, 'remaining') && !Object.prototype.hasOwnProperty.call(entity, 'balance')) entity.balance = entity.remaining;
    allowed.forEach((key) => {
      if (entity && Object.prototype.hasOwnProperty.call(entity, key)) result[key] = entity[key];
    });
    return result;
  }

  function redactedAudit(event, fallbackRevision) {
    const value = event || {};
    return {
      auditId: String(value.auditId || 'audit-' + String(value.revision || fallbackRevision)),
      operationId: String(value.operationId || 'unknown'),
      actorKind: String(value.actorKind || 'main-process'),
      entityType: String(value.entityType || 'commercial'),
      entityId: String(value.entityId || ''),
      priorState: String(value.priorState || ''),
      nextState: String(value.nextState || ''),
      resultCode: String(value.resultCode || 'ok'),
      revision: Number.isSafeInteger(value.revision) ? value.revision : fallbackRevision,
      revocationEpoch: Number.isSafeInteger(value.revocationEpoch) ? value.revocationEpoch : 0,
      timestamp: String(value.timestamp || nowISO()),
    };
  }

  function stableDomainFailure(result, fallback) {
    return result && result.ok === false ? failure(result.errorCode || fallback) : failure(fallback);
  }

  function success(value, revision, idempotent) {
    return { ok: true, value: clone(value), revision, idempotent: idempotent === true };
  }

  function eventWithTrustedSecurity(event, context) {
    const next = clone(event);
    next.deviceBindingHash = context.deviceBindingHash;
    next.revocationEpoch = context.revocationEpoch;
    next.signatureValid = context.signatureValid;
    next.clockValid = context.clockValid;
    return next;
  }

  function assertEventPayload(value, allowed) {
    if (!plainPayload(value)) throw errorWithCode('invalid-event');
    assertAllowedKeys(value, allowed);
    return value;
  }

  function safeEntityId(value, field) {
    return identifier(value, field);
  }

  async function applySubscriptionEvent(input) {
    try {
      const request = commonRequest(input);
      const payload = assertEventPayload(request.payload, new Set(['subscriptionId', 'create', 'event']));
      const id = safeEntityId(payload.subscriptionId, 'subscriptionId');
      const event = assertEventPayload(payload.event, new Set([
        'operationId', 'targetState', 'revision', 'revocationEpoch', 'deviceBindingHash',
        'signatureValid', 'clockValid', 'targetDeviceBindingHash', 'lastVerifiedOnlineAtMs', 'offlineGraceEndsAtMs',
      ]));
      if (!safeState(event.operationId) || !safeState(event.targetState) || !Number.isSafeInteger(event.revision) || event.revision < 1) throw errorWithCode('invalid-event');
      if (!payload.create && !payload.subscriptionId) throw errorWithCode('invalid-subscription-event');
      if (payload.create) {
        assertEventPayload(payload.create, new Set(['subscriptionId', 'subjectIdHash', 'tier', 'deviceBindingHash', 'revocationEpoch', 'signedLicenseRef']));
      }
      return await commitIntegration(request, 'subscription', id, (current) => {
        const existing = current.subscriptions[id];
        try {
          let record;
          if (existing) {
            record = existing;
          } else {
            if (!payload.create) return failure('invalid-subscription-event');
            const create = Object.assign({}, payload.create, {
              subscriptionId: id,
              deviceBindingHash: request.context.deviceBindingHash,
              revocationEpoch: request.context.revocationEpoch,
            });
            record = domain.createSubscription(create);
          }
          const transitioned = domain.applySubscriptionTransition(record, eventWithTrustedSecurity(event, request.context));
          if (!transitioned || transitioned.ok !== true) return transitioned;
          const value = Object.assign({}, transitioned.value, { updatedAt: nowISO() });
          if (payload.create && payload.create.subjectIdHash) value.subjectIdHash = payload.create.subjectIdHash;
          if (payload.create && payload.create.signedLicenseRef) value.signedLicenseRef = payload.create.signedLicenseRef;
          return {
            ok: true,
            value,
            priorState: existing ? existing.state : '',
            nextState: value.state,
            write(next) { next.subscriptions[id] = clone(value); },
          };
        } catch (_) {
          return failure('invalid-subscription-event');
        }
      });
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'invalid-request');
    }
  }

  function simpleEntityHandler(kind, input) {
    const request = commonRequest(input);
    const payload = assertEventPayload(request.payload, new Set([kind === 'order' ? 'orderId' : 'deviceBindingHash', 'nextState', 'fields']));
    const idKey = kind === 'order' ? 'orderId' : 'deviceBindingHash';
    const collection = kind === 'order' ? 'orders' : 'devices';
    const id = safeEntityId(payload[idKey], idKey);
    if (!safeState(payload.nextState)) throw errorWithCode('invalid-event');
    if (kind === 'device' && id !== request.deviceBindingHash) return failure('device-mismatch');
    const allowedFields = kind === 'order'
      ? new Set(['subjectIdHash', 'sku', 'amountMinor', 'currency', 'status', 'providerReferenceHash', 'fulfillmentReferenceHash'])
      : new Set(['subjectIdHash', 'status', 'bindingAssurance']);
    let fields = {};
    if (payload.fields !== undefined) {
      try {
        fields = assertEventPayload(payload.fields, allowedFields);
      } catch (error) {
        if (error && error.errorCode === 'sensitive-field-rejected') throw error;
        throw errorWithCode('invalid-event');
      }
    }
    if (kind === 'order' && fields.amountMinor !== undefined && (!Number.isSafeInteger(fields.amountMinor) || fields.amountMinor < 0)) throw errorWithCode('invalid-event');
    if (fields.currency !== undefined && (typeof fields.currency !== 'string' || !/^[A-Z]{3}$/.test(fields.currency))) throw errorWithCode('invalid-event');
    Object.keys(fields).forEach((key) => {
      if (typeof fields[key] === 'string' && fields[key] !== '' && !safeState(fields[key])) throw errorWithCode('invalid-event');
    });
    return { request, kind, collection, id, fields, nextState: payload.nextState };
  }

  async function applyOrderEvent(input) {
    try {
      const prepared = simpleEntityHandler('order', input);
      return await commitIntegration(prepared.request, 'order', prepared.id, (current) => {
        const prior = current.orders[prepared.id];
        const value = Object.assign({}, prior || {}, prepared.fields, {
          orderId: prepared.id,
          state: prepared.nextState,
          revision: prior ? prior.revision + 1 : 1,
          revocationEpoch: prepared.request.revocationEpoch,
          updatedAt: nowISO(),
        });
        return {
          ok: true,
          value,
          priorState: prior ? prior.state : '',
          nextState: value.state,
          write(next) { next.orders[prepared.id] = clone(value); },
        };
      });
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'invalid-request');
    }
  }

  async function applyDeviceEvent(input) {
    try {
      const prepared = simpleEntityHandler('device', input);
      // 错设备必须直接保留稳定错误码，不能进入提交路径后被兜底错误覆盖。
      if (prepared && prepared.ok === false) return prepared;
      return await commitIntegration(prepared.request, 'device', prepared.id, (current) => {
        const prior = current.devices[prepared.id];
        const value = Object.assign({}, prior || {}, prepared.fields, {
          deviceBindingHash: prepared.id,
          status: prepared.fields.status || prepared.nextState,
          state: prepared.nextState,
          revision: prior ? prior.revision + 1 : 1,
          revocationEpoch: prepared.request.revocationEpoch,
          updatedAt: nowISO(),
        });
        return {
          ok: true,
          value,
          priorState: prior ? prior.state : '',
          nextState: value.state,
          write(next) { next.devices[prepared.id] = clone(value); },
        };
      });
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'invalid-request');
    }
  }

  async function applyQuotaOperation(input) {
    try {
      const request = commonRequest(input);
      const payload = assertEventPayload(request.payload, new Set(['walletId', 'create', 'event']));
      const id = safeEntityId(payload.walletId, 'walletId');
      const event = assertEventPayload(payload.event, new Set([
        'operationId', 'type', 'amount', 'revision', 'revocationEpoch', 'deviceBindingHash', 'signatureValid', 'clockValid',
      ]));
      if (!safeState(event.operationId) || !['credit', 'debit'].includes(event.type) || !Number.isSafeInteger(event.amount) || event.amount < 1 || !Number.isSafeInteger(event.revision) || event.revision < 1) throw errorWithCode('invalid-quota-operation');
      if (payload.create) assertEventPayload(payload.create, new Set(['walletId', 'subjectIdHash', 'deviceBindingHash', 'balance', 'revocationEpoch']));
      return await commitIntegration(request, 'quota', id, (current) => {
        try {
          let wallet = current.quotaWallets[id];
          if (wallet && Object.prototype.hasOwnProperty.call(wallet, 'remaining') && !Object.prototype.hasOwnProperty.call(wallet, 'balance')) {
            wallet = domain.createQuotaWallet({ walletId: id, deviceBindingHash: request.context.deviceBindingHash, balance: wallet.remaining, revocationEpoch: current.revocationEpoch });
          } else if (!wallet) {
            if (!payload.create) return failure('invalid-quota-operation');
            const create = Object.assign({}, payload.create, {
              walletId: id,
              deviceBindingHash: request.context.deviceBindingHash,
              revocationEpoch: request.context.revocationEpoch,
            });
            wallet = domain.createQuotaWallet(create);
          }
          const transitioned = domain.applyQuotaOperation(wallet, eventWithTrustedSecurity(event, request.context));
          if (!transitioned || transitioned.ok !== true) return transitioned;
          const value = Object.assign({}, transitioned.value, { updatedAt: nowISO() });
          if (payload.create && payload.create.subjectIdHash) value.subjectIdHash = payload.create.subjectIdHash;
          return {
            ok: true,
            value,
            write(next) { next.quotaWallets[id] = clone(value); },
          };
        } catch (_) {
          return failure('invalid-quota-operation');
        }
      });
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'invalid-request');
    }
  }

  async function evaluateAccess(input) {
    try {
      const value = ensurePlainObject(input);
      assertAllowedKeys(value, new Set(['requestId', 'featureKey', 'deviceBindingHash', 'revocationEpoch', 'nowMs', 'signedEvidence']));
      if (!safeState(value.requestId) || !safeState(value.featureKey)) return failure('invalid-request');
      if (value.featureKey === 'manual-core') return success({ freeManualAllowed: true, paidAccessAllowed: false, reason: 'free-manual', tier: 'free', quotaAvailable: false }, 0, false);
      const feature = entitlements.FEATURE_REGISTRY[value.featureKey];
      if (!feature) return failure('unknown-feature');
      const context = trustedContext(value);
      if (!Number.isSafeInteger(value.nowMs) || value.nowMs < 0) return failure('invalid-request');
      const evidence = context.signedEvidence;
      if (!evidence || evidence.signatureValid !== true || !safeState(evidence.subscriptionId)) return failure('invalid-license');
      const current = await readIntegrationEnvelope();
      if (context.revocationEpoch < current.revocationEpoch) return failure('revocation-rollback');
      const subscription = current.subscriptions[evidence.subscriptionId];
      const access = domain.subscriptionAccess(subscription, {
        deviceBindingHash: context.deviceBindingHash,
        signatureValid: evidence.signatureValid === true,
        clockValid: context.clockValid,
        revocationEpoch: context.revocationEpoch,
        nowMs: value.nowMs,
      });
      const actualRank = entitlements.TIER_RANK[access.tier] || 0;
      const requiredRank = entitlements.TIER_RANK[feature.minimumTier] || 0;
      const tierAllowed = actualRank >= requiredRank;
      return success({
        freeManualAllowed: true,
        paidAccessAllowed: access.paidAccessAllowed === true && tierAllowed,
        reason: access.errorCode || (tierAllowed ? 'allowed' : 'tier-denied'),
        tier: access.tier,
        quotaAvailable: false,
      }, current.revision, false);
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'durable-read-failed');
    }
  }

  async function getSnapshot(input) {
    try {
      const value = ensurePlainObject(input === undefined ? {} : input);
      assertAllowedKeys(value, new Set(['requestId']));
      if (!safeState(value.requestId)) return failure('invalid-request');
      const current = await readIntegrationEnvelope();
      return success({
        subscriptions: Object.values(current.subscriptions || {}).map(redactEntity),
        orders: Object.values(current.orders || {}).map(redactEntity),
        devices: Object.values(current.devices || {}).map(redactEntity),
        quotaWallets: Object.values(current.quotaWallets || {}).map(redactEntity),
      }, current.revision, false);
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'durable-read-failed');
    }
  }

  async function getAuditPage(input) {
    try {
      const value = ensurePlainObject(input === undefined ? {} : input);
      assertAllowedKeys(value, new Set(['requestId', 'cursor', 'limit']));
      if (!safeState(value.requestId)) return failure('invalid-request');
      if (value.cursor !== undefined && !/^[0-9]+$/.test(String(value.cursor))) return failure('invalid-request');
      if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1)) return failure('invalid-request');
      const current = await readIntegrationEnvelope();
      const start = value.cursor === undefined ? 0 : Math.min(Number(value.cursor), current.auditEvents.length);
      const limit = value.limit === undefined ? 50 : Math.min(100, value.limit);
      const end = Math.min(current.auditEvents.length, start + limit);
      return success({
        items: current.auditEvents.slice(start, end).map((event) => redactedAudit(event, current.revision)),
        nextCursor: end < current.auditEvents.length ? String(end) : null,
      }, current.revision, false);
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'durable-read-failed');
    }
  }

  async function readIntegrationEnvelope() {
    try {
      return await adapter.readCurrent();
    } catch (error) {
      throw errorWithCode(error && error.errorCode ? error.errorCode : 'durable-read-failed');
    }
  }

  async function commitIntegration(request, entityType, entityId, apply) {
    return enqueueIntegration(async () => {
      try {
        if (request.context.trusted && request.context.signatureValid !== true) return failure('invalid-license');
        const current = await readIntegrationEnvelope();
        const requestHash = publicRequestHash(request);
        const prior = current.operationReceipts[request.operationId];
        if (prior) {
          const priorHash = prior.canonicalHash || prior.requestHash;
          if (priorHash !== requestHash) return failure('operation-conflict');
          return { ok: true, value: clone(prior.result), revision: prior.revision, idempotent: true };
        }
        if (request.expectedRevision !== current.revision) return failure('stale-revision');
        if (request.revocationEpoch < current.revocationEpoch) return failure('revocation-rollback');
        const applied = await apply(current, request);
        if (!applied || applied.ok !== true) return stableDomainFailure(applied, 'invalid-event');
        const next = clone(current);
        next.revision += 1;
        next.revocationEpoch = Math.max(next.revocationEpoch, request.revocationEpoch);
        next.updatedAt = nowISO();
        applied.write(next);
        const value = redactEntity(applied.value);
        const receiptPayload = clone(request);
        delete receiptPayload.context;
        next.operationReceipts[request.operationId] = {
          canonicalHash: requestHash,
          payload: receiptPayload,
          result: value,
          revision: next.revision,
          operationId: request.operationId,
          entityType,
          entityId: String(entityId || ''),
          resultCode: 'ok',
          timestamp: next.updatedAt,
        };
        next.auditEvents.push({
          auditId: 'audit-' + String(next.revision),
          operationId: request.operationId,
          actorKind: 'main-process',
          entityType,
          entityId: String(entityId || ''),
          priorState: String(applied.priorState || ''),
          nextState: String(applied.nextState || ''),
          resultCode: 'ok',
          revision: next.revision,
          revocationEpoch: next.revocationEpoch,
          timestamp: next.updatedAt,
          redacted: true,
        });
        await adapter.write(next);
        const persisted = await adapter.read();
        if (!persisted || persisted.revision !== next.revision) return failure('readback-mismatch');
        // 实体通道提交后同步 billing service 的闭包快照，维持单一 revision 权威。
        service._replaceEnvelope(persisted);
        return { ok: true, value, revision: next.revision, idempotent: false };
      } catch (error) {
        return failure(error && error.errorCode ? error.errorCode : 'durable-write-failed');
      }
    });
  }

  async function currentRevision() {
    const snapshot = await adapter.readCurrent();
    return snapshot.revision;
  }

  async function normalizeResult(result, operationId) {
    if (!result || result.ok !== true || !operationId) return result;
    try {
      const snapshot = await adapter.readCurrent();
      const receipt = snapshot.operationReceipts[operationId];
      if (!receipt) return result;
      return Object.assign({}, result, { revision: receipt.revision });
    } catch (_) {
      return failure('durable-read-failed');
    }
  }

  async function hydrateReplayRevision(input, operationId) {
    if (!operationId || !input || input.expectedRevision !== undefined) return input;
    const snapshot = await adapter.readCurrent();
    const receipt = snapshot.operationReceipts[operationId];
    if (!receipt || !receipt.payload || !Number.isSafeInteger(receipt.payload.expectedRevision)) return input;
    return Object.assign({}, input, { expectedRevision: receipt.payload.expectedRevision });
  }

  async function call(method, input, operationId) {
    try {
      const replayInput = await hydrateReplayRevision(input, operationId);
      return await normalizeResult(await service[method](addCaller(replayInput, caller, deviceId)), operationId);
    } catch (error) {
      return failure(error && error.errorCode ? error.errorCode : 'durable-read-failed');
    }
  }

  async function getModelPriceCatalog(input) {
    try {
      const value = input === undefined ? {} : input;
      assertAllowedKeys(value, new Set(['catalogRevision']));
      const normalized = {};
      if (value.catalogRevision !== undefined) {
        normalized.catalogRevision = optionalRevision(value.catalogRevision);
        // 官方目录为空且没有 revision：请求任何目录 revision 都是 mismatch。
        if (OFFICIAL_CATALOG_EMPTY) return failure('catalog-revision-mismatch');
      }
      if (OFFICIAL_CATALOG_EMPTY) {
        // 契约 §4 规范空目录响应：value 为空 map，revision 为 null。
        return { ok: true, value: {}, revision: null, idempotent: false };
      }
      return await call('getModelPriceCatalog', normalized);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  async function getAccountBalance(input) {
    try {
      const value = input === undefined ? {} : input;
      assertAllowedKeys(value, new Set(['expectedRevision']));
      const expectedRevision = optionalRevision(value.expectedRevision);
      const snapshot = await adapter.readCurrent();
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) return failure('stale-revision');
      return {
        ok: true,
        value: {
          currency: 'CNY',
          remainingBalanceMinor: snapshot.balanceMinor,
          availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor,
          revision: snapshot.revision,
        },
        revision: snapshot.revision,
        idempotent: false,
      };
    } catch (error) {
      return failure(error.errorCode || 'durable-read-failed');
    }
  }

  async function quoteRequestCharge(input) {
    try {
      const value = input === undefined ? {} : input;
      assertAllowedKeys(value, new Set(['model', 'catalogRevision']));
      const normalized = { model: identifier(value.model, 'model') };
      if (value.catalogRevision !== undefined) normalized.catalogRevision = optionalRevision(value.catalogRevision);
      // 空官方目录下任何 quote 都稳定失败，不返回任何价格（含零价格）。
      if (OFFICIAL_CATALOG_EMPTY) return failure('catalog-unavailable');
      return await call('quoteRequestCharge', normalized);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  async function reserveRequestCharge(input) {
    try {
      const value = ensurePlainObject(input);
      assertAllowedKeys(value, new Set(['model', 'catalogRevision', 'expectedRevision', 'operationId']));
      const normalized = {
        model: identifier(value.model, 'model'),
        operationId: identifier(value.operationId, 'operationId'),
        billingMode: 'money-per-request',
      };
      if (value.catalogRevision !== undefined) normalized.catalogRevision = optionalRevision(value.catalogRevision);
      if (value.expectedRevision !== undefined) normalized.expectedRevision = optionalRevision(value.expectedRevision);
      // 空官方目录下任何 reserve 都在变更前失败：不写 envelope、不写 receipt、
      // 不写 audit，revision/balance/reservedMinor 全部保持原样。
      if (OFFICIAL_CATALOG_EMPTY) return failure('catalog-unavailable');
      return await call('reserveRequestCharge', normalized, normalized.operationId);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  async function chargeTransition(method, input) {
    try {
      const value = ensurePlainObject(input);
      assertAllowedKeys(value, new Set(['requestId', 'operationId', 'expectedRevision']));
      const normalized = {
        requestId: identifier(value.requestId, 'requestId'),
        operationId: identifier(value.operationId, 'operationId'),
      };
      if (value.expectedRevision !== undefined) normalized.expectedRevision = optionalRevision(value.expectedRevision);
      return await call(method, normalized, normalized.operationId);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  async function reconcileRequestCharge(input) {
    try {
      const value = ensurePlainObject(input);
      assertAllowedKeys(value, new Set(['requestId', 'operationId', 'expectedRevision', 'outcome', 'evidence']));
      if (!trustedReconciliation || !value.evidence || value.evidence.trusted !== true) return failure('invalid-evidence');
      if (Object.keys(value.evidence).some((key) => !['trusted', 'source'].includes(key))) return failure('invalid-evidence');
      const normalized = {
        requestId: identifier(value.requestId, 'requestId'),
        operationId: identifier(value.operationId, 'operationId'),
        outcome: value.outcome,
        evidence: { trusted: true, source: String(value.evidence.source || 'main') },
      };
      if (!['settled', 'released'].includes(normalized.outcome)) return failure('invalid-request');
      if (value.expectedRevision !== undefined) normalized.expectedRevision = optionalRevision(value.expectedRevision);
      return await call('reconcileRequestCharge', normalized, normalized.operationId);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  async function processNonMoneyRequest(input) {
    try {
      const value = ensurePlainObject(input);
      assertAllowedKeys(value, new Set(['billingMode', 'operationId', 'expectedRevision', 'quotaWalletId']));
      if (!MODES.has(value.billingMode) || value.billingMode === 'money-per-request') return failure('invalid-request');
      const normalized = {
        billingMode: value.billingMode,
        operationId: identifier(value.operationId, 'operationId'),
      };
      if (value.expectedRevision !== undefined) normalized.expectedRevision = optionalRevision(value.expectedRevision);
      if (value.billingMode === 'request-count-quota') normalized.quotaWalletId = identifier(value.quotaWalletId, 'quotaWalletId');
      return await call('processNonMoneyRequest', normalized, normalized.operationId);
    } catch (error) {
      return failure(error.errorCode || 'invalid-request');
    }
  }

  return Object.freeze({
    getSnapshot,
    evaluateAccess,
    applySubscriptionEvent,
    applyOrderEvent,
    applyDeviceEvent,
    applyQuotaOperation,
    getAuditPage,
    getModelPriceCatalog,
    getAccountBalance,
    quoteRequestCharge,
    reserveRequestCharge,
    settleRequestCharge: (input) => chargeTransition('settleRequestCharge', input),
    releaseRequestCharge: (input) => chargeTransition('releaseRequestCharge', input),
    markRequestUnknown: (input) => chargeTransition('markRequestUnknown', input),
    reconcileRequestCharge,
    processNonMoneyRequest,
    getCurrentRevision: currentRevision,
    close: () => adapter.close(),
    filePath,
    deviceIdHash: crypto.createHash('sha256').update(deviceId).digest('hex'),
  });
}

module.exports = { createCommercialFacade, createFileAdapter, initialEnvelope, failure };
