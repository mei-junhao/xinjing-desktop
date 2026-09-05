'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./commercial-billing-core.js');

const LEGACY_ENVELOPE_KEYS = ['schemaVersion', 'revision', 'balanceMinor', 'reservedMinor', 'quotaWallets', 'requestCharges', 'operationReceipts', 'auditEvents', 'updatedAt'];
const ENVELOPE_KEYS = ['schemaVersion', 'revision', 'revocationEpoch', 'subscriptions', 'orders', 'devices', 'balanceMinor', 'reservedMinor', 'quotaWallets', 'requestCharges', 'operationReceipts', 'auditEvents', 'updatedAt'];
const RECEIPT_KEYS = ['canonicalHash', 'payload', 'result', 'revision'];
const CHARGE_KEYS = ['requestId', 'model', 'billingMode', 'priceMinor', 'status', 'deviceId', 'catalogRevision', 'createdAt', 'updatedAt'];
const AUDIT_KEYS = ['operationId', 'action', 'mode', 'revision', 'redacted'];
const MODES = ['money-per-request', 'request-count-quota', 'byok', 'trial'];
const FORBIDDEN_KEYS = /clinical|transcript|notebody|reportbody|supervisionbody|knowledgebody|prompt|modelinput|modeloutput|filepath|localpath|secret|token|credential|webhookbody|cardnumber|privatekey/i;

const SUBSCRIPTION_KEYS = [
  'kind', 'subscriptionId', 'subjectIdHash', 'tier', 'state', 'deviceBindingHash',
  'signedLicenseRef', 'revision', 'revocationEpoch', 'pendingTargetDeviceBindingHash',
  'lastVerifiedOnlineAtMs', 'offlineGraceEndsAtMs', 'operations', 'updatedAt'
];
const ORDER_KEYS = [
  'orderId', 'subjectIdHash', 'sku', 'amountMinor', 'currency', 'state', 'status',
  'providerReferenceHash', 'fulfillmentReferenceHash', 'revision', 'revocationEpoch', 'updatedAt'
];
const DEVICE_KEYS = ['deviceBindingHash', 'subjectIdHash', 'status', 'state', 'bindingAssurance', 'revision', 'revocationEpoch', 'updatedAt'];
const CURRENT_AUDIT_KEYS = [
  'auditId', 'operationId', 'actorKind', 'entityType', 'entityId', 'priorState',
  'nextState', 'resultCode', 'revision', 'revocationEpoch', 'timestamp', 'redacted'
];

function failure(errorCode) {
  return { ok: false, errorCode, retryable: false };
}

function stableError(errorCode) {
  const error = new Error(errorCode);
  error.errorCode = errorCode;
  error.retryable = false;
  return error;
}

function ownKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === keys.slice().sort().join('\0');
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function nullableSafeInteger(value) {
  return value === null || safeInteger(value);
}

function plainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function knownKeys(value, required, optional) {
  if (!plainRecord(value)) return false;
  const allowed = new Set((required || []).concat(optional || []));
  if ((required || []).some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  return Object.keys(value).every((key) => allowed.has(key) && !FORBIDDEN_KEYS.test(key));
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.test(key) || containsForbiddenKey(value[key]));
}

function validateOperations(operations) {
  return Array.isArray(operations) && operations.every((entry) => {
    return knownKeys(entry, ['id', 'fingerprint'], []) && stringValue(entry.id) && stringValue(entry.fingerprint);
  });
}

function validateDomainEntity(entity, required, allowed) {
  if (!knownKeys(entity, required, allowed.filter((key) => !required.includes(key)))) return false;
  for (const key of Object.keys(entity)) {
    if (key.endsWith('AtMs') && !nullableSafeInteger(entity[key])) return false;
    if (['revision', 'revocationEpoch', 'amountMinor'].includes(key) && !safeInteger(entity[key])) return false;
    if (['subscriptionId', 'orderId', 'deviceBindingHash', 'subjectIdHash', 'walletId', 'tier', 'state', 'status', 'sku', 'currency', 'bindingAssurance', 'signedLicenseRef', 'pendingTargetDeviceBindingHash', 'updatedAt'].includes(key)
      && entity[key] !== '' && !stringValue(entity[key])) return false;
  }
  return true;
}

function normalizeLegacyEnvelope(value) {
  if (ownKeys(value, LEGACY_ENVELOPE_KEYS)) {
    return Object.assign({
      revocationEpoch: 0,
      subscriptions: {},
      orders: {},
      devices: {},
    }, value);
  }
  return value;
}

function validateEnvelope(value) {
  if (!plainRecord(value) || (!ownKeys(value, LEGACY_ENVELOPE_KEYS) && !ownKeys(value, ENVELOPE_KEYS))) throw stableError('durable-read-failed');
  if (value.schemaVersion !== 1 || !safeInteger(value.revision) || !safeInteger(value.balanceMinor) || !safeInteger(value.reservedMinor) || value.reservedMinor > value.balanceMinor || !stringValue(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) throw stableError('durable-read-failed');
  if (!ownKeys(value, LEGACY_ENVELOPE_KEYS) && (!safeInteger(value.revocationEpoch) || !plainRecord(value.subscriptions) || !plainRecord(value.orders) || !plainRecord(value.devices))) throw stableError('durable-read-failed');
  if (!plainRecord(value.quotaWallets) || !plainRecord(value.requestCharges) || !plainRecord(value.operationReceipts) || !Array.isArray(value.auditEvents)) throw stableError('durable-read-failed');
  if (value.subscriptions && !plainRecord(value.subscriptions)) throw stableError('durable-read-failed');
  for (const id of Object.keys(value.subscriptions || {})) {
    const subscription = value.subscriptions[id];
    if (!validateDomainEntity(subscription, ['subscriptionId', 'state', 'tier', 'revision', 'revocationEpoch', 'deviceBindingHash'], SUBSCRIPTION_KEYS.filter((key) => !['subscriptionId', 'state', 'tier', 'revision', 'revocationEpoch', 'deviceBindingHash'].includes(key)))) throw stableError('durable-read-failed');
    if (!validateOperations(subscription.operations || [])) throw stableError('durable-read-failed');
  }
  for (const id of Object.keys(value.orders || {})) {
    const order = value.orders[id];
    if (!validateDomainEntity(order, ['orderId', 'state', 'revision', 'revocationEpoch', 'updatedAt'], ORDER_KEYS.filter((key) => !['orderId', 'state', 'revision', 'revocationEpoch', 'updatedAt'].includes(key)))) throw stableError('durable-read-failed');
  }
  for (const id of Object.keys(value.devices || {})) {
    const device = value.devices[id];
    if (!validateDomainEntity(device, ['deviceBindingHash', 'status', 'revision', 'revocationEpoch', 'updatedAt'], DEVICE_KEYS.filter((key) => !['deviceBindingHash', 'status', 'revision', 'revocationEpoch', 'updatedAt'].includes(key)))) throw stableError('durable-read-failed');
  }
  for (const id of Object.keys(value.quotaWallets)) {
    const wallet = value.quotaWallets[id];
    const legacyWallet = ownKeys(wallet, ['remaining']);
    const domainWallet = knownKeys(wallet, ['kind', 'walletId', 'balance', 'revision', 'revocationEpoch', 'deviceBindingHash', 'operations'], ['updatedAt', 'subjectIdHash']);
    if ((!legacyWallet && !domainWallet) || (legacyWallet && !safeInteger(wallet.remaining)) || (domainWallet && (!safeInteger(wallet.balance) || !safeInteger(wallet.revision) || !safeInteger(wallet.revocationEpoch) || !stringValue(wallet.walletId) || !stringValue(wallet.deviceBindingHash) || (wallet.subjectIdHash !== undefined && !stringValue(wallet.subjectIdHash)) || !validateOperations(wallet.operations)))) throw stableError('durable-read-failed');
  }
  for (const id of Object.keys(value.requestCharges)) {
    const charge = value.requestCharges[id];
    if (!charge || typeof charge !== 'object' || Array.isArray(charge) || !ownKeys(charge, CHARGE_KEYS) || !stringValue(charge.requestId) || !stringValue(charge.model) || !MODES.includes(charge.billingMode) || !safeInteger(charge.priceMinor) || !['reserved', 'settled', 'released', 'unknown'].includes(charge.status) || !stringValue(charge.deviceId) || !safeInteger(charge.catalogRevision) || !stringValue(charge.createdAt) || !stringValue(charge.updatedAt)) throw stableError('durable-read-failed');
  }
  for (const id of Object.keys(value.operationReceipts)) {
    const receipt = value.operationReceipts[id];
    const receiptAllowed = RECEIPT_KEYS.concat(['operationId', 'requestHash', 'entityType', 'entityId', 'resultingRevision', 'resultCode', 'timestamp', 'value']);
    if (!receipt || !knownKeys(receipt, RECEIPT_KEYS, receiptAllowed.filter((key) => !RECEIPT_KEYS.includes(key))) || !stringValue(receipt.canonicalHash) || !plainRecord(receipt.payload) || !plainRecord(receipt.result) || containsForbiddenKey(receipt.payload) || containsForbiddenKey(receipt.result) || !safeInteger(receipt.revision)) throw stableError('durable-read-failed');
  }
  for (const event of value.auditEvents) {
    const legacyAudit = ownKeys(event, AUDIT_KEYS);
    const currentAudit = knownKeys(event, CURRENT_AUDIT_KEYS.filter((key) => key !== 'redacted'), ['redacted']);
    if ((!legacyAudit && !currentAudit) || !stringValue(event.operationId) || !safeInteger(event.revision)) throw stableError('durable-read-failed');
    if (legacyAudit && (!stringValue(event.action) || !MODES.includes(event.mode) || event.redacted !== true)) throw stableError('durable-read-failed');
    if (currentAudit && (event.redacted !== undefined && event.redacted !== true || !stringValue(event.auditId) || !stringValue(event.actorKind) || !stringValue(event.entityType) || !stringValue(event.entityId) || !stringValue(event.resultCode) || !safeInteger(event.revocationEpoch) || !stringValue(event.timestamp))) throw stableError('durable-read-failed');
  }
  return value;
}

function normalizeEnvelope(value) {
  validateEnvelope(value);
  return normalizeLegacyEnvelope(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseSnapshot(text) {
  try {
    return normalizeEnvelope(JSON.parse(text));
  } catch (error) {
    if (error && error.errorCode === 'durable-read-failed') throw error;
    throw stableError('durable-read-failed');
  }
}

function makeInitialState(state) {
  if (state === undefined) throw stableError('durable-read-failed');
  return normalizeEnvelope(core.clone(state));
}

function createFilesystemPersistenceAdapter(options) {
  if (!options || typeof options.filePath !== 'string' || options.filePath.length === 0) throw new TypeError('filePath');
  const filePath = options.filePath;
  const fsLike = options.fs || fs;
  const promises = fsLike.promises || fsLike;
  let currentRevision;
  let closed = false;
  let sequence = 0;
  let writeQueue = Promise.resolve();

  function serializeWrite(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  }

  async function readFile() {
    try {
      const text = await promises.readFile(filePath, 'utf8');
      return parseSnapshot(text);
    } catch (error) {
      if (error && error.errorCode === 'durable-read-failed') throw error;
      throw stableError('durable-read-failed');
    }
  }

  async function atomicReplace(snapshot, previousText) {
    const encoded = JSON.stringify(snapshot);
    const expectedHash = digest(snapshot);
    const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now() + '-' + (++sequence);
    let handle;
    try {
      handle = await promises.open(tempPath, 'wx');
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await promises.rename(tempPath, filePath);
      const readback = await readFile();
      if (digest(readback) !== expectedHash || JSON.stringify(readback) !== encoded) {
        // readback mismatch fails closed without changing any resource (contract
        // section 3): roll the file back to its previous content before failing.
        await rollbackReplace(previousText);
        throw stableError('readback-mismatch');
      }
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch (_) {}
      }
      try { await promises.unlink(tempPath); } catch (_) {}
      if (error && error.errorCode) throw error;
      throw stableError(error && error.code === 'ENOENT' ? 'durable-write-failed' : 'durable-write-failed');
    }
  }

  // Restores the file to previousText (undefined = file did not exist before).
  // Best-effort: if the rollback itself fails, the original error is preserved.
  async function rollbackReplace(previousText) {
    if (previousText === undefined) {
      try { await promises.unlink(filePath); } catch (_) {}
      return;
    }
    const rbPath = filePath + '.rb-' + process.pid + '-' + Date.now() + '-' + (++sequence);
    let rb;
    try {
      rb = await promises.open(rbPath, 'wx');
      await rb.writeFile(previousText, 'utf8');
      await rb.sync();
      await rb.close();
      rb = undefined;
      await promises.rename(rbPath, filePath);
    } catch (rollbackError) {
      if (rb) {
        try { await rb.close(); } catch (_) {}
      }
      try { await promises.unlink(rbPath); } catch (_) {}
    }
  }

  return {
    async open() {
      if (closed) throw stableError('durable-read-failed');
      let snapshot;
      try {
        snapshot = await readFile();
      } catch (error) {
        let missing = false;
        try { await promises.access(filePath); } catch (accessError) { missing = accessError && accessError.code === 'ENOENT'; }
        if (!missing || options.initialState === undefined) throw stableError('durable-read-failed');
        snapshot = makeInitialState(options.initialState);
        await atomicReplace(snapshot, undefined);
      }
      currentRevision = snapshot.revision;
      return core.clone(snapshot);
    },
    async read() {
      if (closed || currentRevision === undefined) throw stableError('durable-read-failed');
      return core.clone(await readFile());
    },
    async write(snapshot) {
      return serializeWrite(async function () {
        if (closed || currentRevision === undefined) throw stableError('durable-write-failed');
        const legacyInput = plainRecord(snapshot) && ownKeys(snapshot, LEGACY_ENVELOPE_KEYS);
        snapshot = normalizeEnvelope(snapshot);
        if (snapshot.revision !== currentRevision + 1) throw stableError('stale-revision');
        const disk = await readFile();
        if (disk.revision !== currentRevision) throw stableError('stale-revision');
        if (legacyInput) {
          snapshot.revocationEpoch = disk.revocationEpoch;
          snapshot.subscriptions = core.clone(disk.subscriptions);
          snapshot.orders = core.clone(disk.orders);
          snapshot.devices = core.clone(disk.devices);
        }
        await atomicReplace(snapshot, JSON.stringify(disk));
        currentRevision = snapshot.revision;
      });
    },
    async close() {
      closed = true;
    }
  };
}

async function createDurableBillingService(options) {
  const adapter = createFilesystemPersistenceAdapter(options);
  const initialState = await adapter.open();
  const service = core.createBillingService({ initialState, persistenceAdapter: adapter });
  return {
    getModelPriceCatalog: service.getModelPriceCatalog,
    getAccountBalance: service.getAccountBalance,
    quoteRequestCharge: service.quoteRequestCharge,
    reserveRequestCharge: service.reserveRequestCharge,
    settleRequestCharge: service.settleRequestCharge,
    releaseRequestCharge: service.releaseRequestCharge,
    markRequestUnknown: service.markRequestUnknown,
    reconcileRequestCharge: service.reconcileRequestCharge,
    processNonMoneyRequest: service.processNonMoneyRequest,
    close: function () { return adapter.close(); }
  };
}

module.exports = { createDurableBillingService, createFilesystemPersistenceAdapter, validateEnvelope, normalizeEnvelope, digest };
