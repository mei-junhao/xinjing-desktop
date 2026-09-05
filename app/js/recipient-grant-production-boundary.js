'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultEntitlements = require('./entitlements.js');
const defaultXjsupCore = require('../../supervision-package-core.js');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_PAGE = 100;
const MAX_PUBLIC_BYTES = 32 * 1024;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const B64_HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIVE_STATES = Object.freeze(['active', 'renewed', 'transfer-completed']);
const TERMINAL_STATES = Object.freeze(['expired', 'revoked', 'refunded', 'blocked', 'unknown']);
const STATES = Object.freeze([
  'requested', 'issued', 'delivered', 'active', 'renewed', 'transfer-pending',
  'transfer-completed', 'expired', 'revoked', 'refunded', 'blocked', 'unknown',
]);
const TRANSITIONS = Object.freeze({
  active: Object.freeze(['renewed', 'transfer-pending', 'expired', 'revoked', 'refunded', 'blocked', 'unknown']),
  renewed: Object.freeze(['renewed', 'transfer-pending', 'expired', 'revoked', 'refunded', 'blocked', 'unknown']),
  'transfer-pending': Object.freeze(['transfer-completed', 'active', 'expired', 'revoked', 'refunded', 'blocked', 'unknown']),
  'transfer-completed': Object.freeze(['renewed', 'transfer-pending', 'expired', 'revoked', 'refunded', 'blocked', 'unknown']),
  expired: Object.freeze([]),
  revoked: Object.freeze([]),
  refunded: Object.freeze([]),
  blocked: Object.freeze([]),
  unknown: Object.freeze([]),
});
const PUBLIC_PROJECTION_KEYS = Object.freeze([
  'grantId', 'status', 'packageId', 'packageVersion', 'contentHash', 'authorKeyId',
  'providerPolicyHash', 'grantSequence', 'revocationEpoch', 'issuedAt', 'expiresAt',
  'lastOnlineVerifiedAt', 'offlineGraceUntil', 'revision', 'deviceKeyIdHash',
  'recipientGrantIdHash', 'activePackageDigest', 'freeManualAllowed', 'errorCode',
]);
const AUDIT_PUBLIC_KEYS = Object.freeze([
  'eventId', 'grantId', 'eventType', 'actorClass', 'reasonCode', 'priorStateHash',
  'nextStateHash', 'grantSequence', 'revocationEpoch', 'packageId', 'packageVersion',
  'contentHash', 'timestamp', 'auditHash',
]);
const RECORD_KEYS = Object.freeze([
  'grantId', 'status', 'packageId', 'packageVersion', 'contentHash', 'ciphertextHash',
  'authorKeyId', 'providerPolicyHash', 'subjectIdHash', 'licenseIdHash',
  'deviceKeyIdHash', 'devicePublicKeyHash', 'recipientGrantIdHash', 'grantSequence',
  'revocationEpoch', 'issuedAt', 'expiresAt', 'lastOnlineVerifiedAt',
  'offlineGraceUntil', 'revision', 'activePackageDigest', 'retiredPackageDigests',
  'quotaReservationId', 'freeManualAllowed',
]);
const STATE_KEYS = Object.freeze([
  'schemaVersion', 'revision', 'grants', 'operationReceipts', 'consumedOrders',
  'quotaReservations', 'audit', 'updatedAt',
]);
const AUDIT_KEYS = Object.freeze(AUDIT_PUBLIC_KEYS.concat(['previousAuditHash']));
const FORBIDDEN_KEY = /^(subjectId|licenseId|deviceId|deviceKeyId|privateKey|keyObject|plaintext|clinicalText|transcript|prompt|filePath|localPath|path|token|accessToken|authorization|payment|card|secret|password)$/i;

const DEFENSE = Object.freeze({
  canonicalEntitlement: true,
  signatureBeforeDecrypt: true,
  packageBinding: true,
  providerPolicy: true,
  deviceBinding: true,
  singleActiveDevice: true,
  idempotentQuota: true,
  staleRevision: true,
  grantSequence: true,
  revocationEpoch: true,
  retiredEnvelope: true,
  terminalFreeManual: true,
  durableReadback: true,
  publicRedaction: true,
  capabilityCeiling: true,
  semanticFailureExit: true,
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.slice().sort().join('\0');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}
function hashBase64url(value) {
  const raw = Buffer.from(String(value || ''), 'base64url');
  if (raw.length !== 32) fail('record-hash');
  return 'sha256:' + raw.toString('hex');
}
function nowIso() { return new Date().toISOString(); }
function validIso(value) { return typeof value === 'string' && ISO_RE.test(value) && new Date(value).toISOString() === value; }
function safeId(value) { return typeof value === 'string' && ID_RE.test(value); }
function safeHash(value) { return typeof value === 'string' && HASH_RE.test(value); }
function safeInteger(value, minimum) { return Number.isSafeInteger(value) && value >= (minimum || 0); }
function fail(errorCode) { const error = new Error(errorCode); error.errorCode = errorCode; throw error; }
function failure(error, freeManualAllowed) {
  return Object.freeze({ ok: false, errorCode: error && error.errorCode ? error.errorCode : error && error.code ? String(error.code) : 'recipient-grant-failed', freeManualAllowed: freeManualAllowed !== false });
}
function assertNoSensitive(value) {
  const walk = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (FORBIDDEN_KEY.test(key)) fail('sensitive-field-rejected');
      walk(child);
    }
  };
  walk(value);
}
function assertBounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PUBLIC_BYTES) fail('public-output-oversized');
}
function publicProjection(record, errorCode) {
  const value = {
    grantId: record.grantId,
    status: record.status,
    packageId: record.packageId,
    packageVersion: record.packageVersion,
    contentHash: record.contentHash,
    authorKeyId: record.authorKeyId,
    providerPolicyHash: record.providerPolicyHash,
    grantSequence: record.grantSequence,
    revocationEpoch: record.revocationEpoch,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    lastOnlineVerifiedAt: record.lastOnlineVerifiedAt,
    offlineGraceUntil: record.offlineGraceUntil,
    revision: record.revision,
    deviceKeyIdHash: record.deviceKeyIdHash,
    recipientGrantIdHash: record.recipientGrantIdHash,
    activePackageDigest: record.activePackageDigest,
    freeManualAllowed: true,
    errorCode: errorCode || '',
  };
  if (DEFENSE.publicRedaction) {
    if (!exactKeys(value, PUBLIC_PROJECTION_KEYS)) fail('public-projection-fields');
    assertNoSensitive(value);
    assertBounded(value);
  }
  return Object.freeze(value);
}
function auditProjection(entry) {
  const value = {};
  for (const key of AUDIT_PUBLIC_KEYS) value[key] = entry[key];
  if (!exactKeys(value, AUDIT_PUBLIC_KEYS)) fail('audit-projection-fields');
  assertNoSensitive(value);
  return Object.freeze(value);
}
function initialState() {
  return { schemaVersion: 1, revision: 0, grants: {}, operationReceipts: {}, consumedOrders: {}, quotaReservations: {}, audit: [], updatedAt: '1970-01-01T00:00:00.000Z' };
}
function validateRecord(record) {
  if (!exactKeys(record, RECORD_KEYS)) fail('record-fields');
  ['grantId', 'packageId', 'packageVersion', 'authorKeyId', 'quotaReservationId', 'status'].forEach((key) => { if (!safeId(record[key])) fail('record-id'); });
  ['contentHash', 'ciphertextHash', 'providerPolicyHash', 'subjectIdHash', 'licenseIdHash', 'deviceKeyIdHash', 'recipientGrantIdHash', 'activePackageDigest'].forEach((key) => { if (!safeHash(record[key])) fail('record-hash'); });
  if (!B64_HASH_RE.test(record.devicePublicKeyHash)) fail('record-device-public-key-hash');
  if (!STATES.includes(record.status)) fail('record-state');
  ['grantSequence', 'revocationEpoch', 'revision'].forEach((key) => { if (!safeInteger(record[key])) fail('record-counter'); });
  ['issuedAt', 'expiresAt', 'lastOnlineVerifiedAt', 'offlineGraceUntil'].forEach((key) => { if (!validIso(record[key])) fail('record-time'); });
  if (!Array.isArray(record.retiredPackageDigests) || record.retiredPackageDigests.some((item) => !safeHash(item))) fail('record-retired-digest');
  if (record.freeManualAllowed !== true) fail('free-manual-blocked');
  assertNoSensitive(record);
  return clone(record);
}
function validateAudit(entry) {
  if (!exactKeys(entry, AUDIT_KEYS)) fail('audit-fields');
  ['eventId', 'grantId', 'eventType', 'actorClass', 'reasonCode', 'packageId', 'packageVersion'].forEach((key) => { if (!safeId(entry[key])) fail('audit-id'); });
  ['priorStateHash', 'nextStateHash', 'contentHash', 'auditHash', 'previousAuditHash'].forEach((key) => { if (!safeHash(entry[key])) fail('audit-hash'); });
  if (!safeInteger(entry.grantSequence) || !safeInteger(entry.revocationEpoch) || !validIso(entry.timestamp)) fail('audit-value');
  assertNoSensitive(entry);
  return clone(entry);
}
function validateState(state) {
  if (!exactKeys(state, STATE_KEYS) || state.schemaVersion !== 1 || !safeInteger(state.revision) || !validIso(state.updatedAt)) fail('repository-corrupt');
  ['grants', 'operationReceipts', 'consumedOrders', 'quotaReservations'].forEach((key) => {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) fail('repository-corrupt');
  });
  if (!Array.isArray(state.audit)) fail('repository-corrupt');
  Object.values(state.grants).forEach(validateRecord);
  state.audit.forEach(validateAudit);
  let previous = hash('audit-genesis');
  for (const entry of state.audit) {
    if (entry.previousAuditHash !== previous) fail('audit-chain-invalid');
    const body = {};
    for (const key of AUDIT_PUBLIC_KEYS) if (key !== 'auditHash') body[key] = entry[key];
    const expected = hash({ previousAuditHash: previous, body });
    if (entry.auditHash !== expected) fail('audit-chain-invalid');
    previous = entry.auditHash;
  }
  assertNoSensitive(state);
  return clone(state);
}
function appendAudit(state, input) {
  if (state.audit.some((entry) => entry.eventId === input.eventId)) fail('event-replay');
  const previousAuditHash = state.audit.length ? state.audit[state.audit.length - 1].auditHash : hash('audit-genesis');
  const body = {
    eventId: input.eventId,
    grantId: input.grantId,
    eventType: input.eventType,
    actorClass: input.actorClass || 'commercial-service',
    reasonCode: input.reasonCode || input.eventType,
    priorStateHash: input.priorStateHash,
    nextStateHash: input.nextStateHash,
    grantSequence: input.grantSequence,
    revocationEpoch: input.revocationEpoch,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    contentHash: input.contentHash,
    timestamp: input.timestamp,
  };
  const entry = Object.assign({}, body, { auditHash: hash({ previousAuditHash, body }), previousAuditHash });
  validateAudit(entry);
  state.audit.push(entry);
}

class DurableRecipientGrantRepository {
  constructor(options) {
    if (!options || typeof options.filePath !== 'string' || !options.filePath) fail('repository-path');
    this.filePath = path.resolve(options.filePath);
    this._queue = Promise.resolve();
    this.failBeforeCommit = false;
    this.failReadback = false;
  }
  async initialize() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try { await fs.promises.access(this.filePath); }
    catch (error) {
      if (error.code !== 'ENOENT') fail('durable-read-failed');
      await this._atomicReplace(initialState());
    }
    return this.read();
  }
  async read() {
    let text;
    try { text = await fs.promises.readFile(this.filePath, 'utf8'); }
    catch (_) { fail('repository-missing'); }
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('repository-oversized');
    try { return validateState(JSON.parse(text)); }
    catch (error) { if (error.errorCode) throw error; fail('repository-corrupt'); }
  }
  async _atomicReplace(state) {
    validateState(state);
    const text = JSON.stringify(state);
    const temp = this.filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    const backup = this.filePath + '.bak';
    let handle;
    let hadPrior = false;
    try {
      try { await fs.promises.copyFile(this.filePath, backup); hadPrior = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      handle = await fs.promises.open(temp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temp, this.filePath);
      let directory;
      try {
        directory = await fs.promises.open(path.dirname(this.filePath), 'r');
        await directory.sync();
      } catch (error) {
        if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error && error.code)) throw error;
      } finally {
        if (directory) await directory.close();
      }
      const readback = await fs.promises.readFile(this.filePath, 'utf8');
      if (this.failReadback || readback !== text || hash(readback) !== hash(text)) fail('readback-mismatch');
      try { await fs.promises.unlink(backup); } catch (_) {}
    } catch (error) {
      if (handle) { try { await handle.close(); } catch (_) {} }
      try { await fs.promises.unlink(temp); } catch (_) {}
      if (hadPrior) { try { await fs.promises.copyFile(backup, this.filePath); } catch (_) {} }
      if (error.errorCode) throw error;
      fail('durable-write-failed');
    }
  }
  async commit(expectedRevision, operationId, requestHash, mutate) {
    const work = async () => {
      const current = await this.read();
      const receipt = current.operationReceipts[operationId];
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail('idempotency-conflict');
        return { state: current, result: clone(receipt.result), idempotent: true };
      }
      if (DEFENSE.staleRevision && expectedRevision !== current.revision) fail('stale-revision');
      const next = clone(current);
      const result = await mutate(next, current);
      next.revision = current.revision + 1;
      next.updatedAt = result.timestamp;
      next.operationReceipts[operationId] = { requestHash, result: clone(result.publicResult), revision: next.revision };
      if (this.failBeforeCommit) fail('durable-write-failed');
      await this._atomicReplace(next);
      const readback = await this.read();
      if (DEFENSE.durableReadback && (readback.revision !== next.revision || hash(readback) !== hash(next))) fail('readback-mismatch');
      return { state: readback, result: clone(readback.operationReceipts[operationId].result), idempotent: false };
    };
    const pending = this._queue.then(work, work);
    this._queue = pending.catch(() => undefined);
    return pending;
  }
}

function canonicalPaidAccess(entitlements, state) {
  const access = entitlements.access('custom-supervisors', state);
  return access && access.feature === 'custom-supervisors' && access.eligible === true
    && access.effectiveTier === 'custom' && state && state.activated === true && state.expired !== true;
}
function canonicalFreeManual(entitlements) {
  return entitlements.canUse('manual-core', { activated: false }) === true;
}
function safeProviderPolicy(core, policy) {
  const allowed = policy && (policy.mode === 'local-only' || (policy.mode === 'trusted-remote' && typeof policy.providerId === 'string' && typeof policy.purpose === 'string'));
  if (DEFENSE.providerPolicy && !allowed) fail('provider-policy-denied');
  if (DEFENSE.capabilityCeiling && policy && (policy.allowTools === true || policy.allowNetwork === true || policy.formalClinicalWrite === true)) fail('capability-expansion-denied');
  return hash(core.canonicalBytes(policy));
}
function normalizeIssueInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-request');
  ['operationId', 'eventId', 'correlationId'].forEach((key) => { if (!safeId(input[key])) fail('invalid-request'); });
  if (!safeInteger(input.expectedRevision) || !validIso(input.now) || !Buffer.isBuffer(input.packageBytes)) fail('invalid-request');
  return input;
}

class RecipientGrantProductionBoundary {
  constructor(options) {
    const input = options || {};
    if (!input.repository) fail('repository-required');
    this.repository = input.repository;
    this.entitlements = input.entitlements || defaultEntitlements;
    this.core = input.xjsupCore || defaultXjsupCore;
  }
  publicApi() {
    return Object.freeze({
      getProjection: (input) => this.getProjection(input),
      getAuditPage: (input) => this.getAuditPage(input),
    });
  }
  async issueFromOrder(rawInput) {
    const freeManualAllowed = canonicalFreeManual(this.entitlements);
    try {
      const input = normalizeIssueInput(rawInput);
      if (!freeManualAllowed) fail('free-manual-blocked');
      const requestHash = hash({
        operationId: input.operationId,
        eventId: input.eventId,
        correlationId: input.correlationId,
        expectedRevision: input.expectedRevision,
        now: input.now,
        order: input.order,
        priceCatalog: input.priceCatalog,
        entitlementState: input.entitlementState,
        quota: input.quota,
        packageDigest: hash(input.packageBytes),
      });
      const result = await this.repository.commit(input.expectedRevision, input.operationId, requestHash, async (state) => {
        if (!input.order || input.order.status !== 'paid' || input.order.refunded === true || input.order.expired === true || input.order.productKey !== 'custom-supervisors') fail('order-not-paid');
        if (!safeId(input.order.orderId) || !safeId(input.order.sku) || !safeId(input.order.catalogRevision) || !safeHash(input.order.priceSnapshotHash)) fail('order-invalid');
        if (!Array.isArray(input.priceCatalog) || !input.priceCatalog.length) fail('price-catalog-missing');
        const price = input.priceCatalog.find((entry) => entry && entry.sku === input.order.sku && entry.active === true);
        if (!price || !safeInteger(price.priceMinor, 1) || price.catalogRevision !== input.order.catalogRevision || hash(price) !== input.order.priceSnapshotHash) fail('price-snapshot-invalid');
        const entitlementAllowed = canonicalPaidAccess(this.entitlements, input.entitlementState);
        if (DEFENSE.canonicalEntitlement && !entitlementAllowed) fail('entitlement-denied');
        const parsed = this.core.parseXjsup(input.packageBytes, input.parseOptions);
        const manifest = parsed.manifest;
        const grant = manifest.recipientGrant;
        const packageDigest = hash(input.packageBytes);
        const policyHash = safeProviderPolicy(this.core, manifest.providerPolicy);
        if (DEFENSE.packageBinding && (input.order.packageId !== manifest.packageId || input.order.packageVersion !== manifest.packageVersion || input.order.contentHash !== manifest.contentSchemaHash || input.order.authorKeyId !== manifest.authorKeyId)) fail('package-binding-mismatch');
        if (DEFENSE.deviceBinding && (!input.runtimeContext || input.runtimeContext.deviceKeyId !== grant.deviceKeyId || input.runtimeContext.devicePublicKeyHash !== grant.devicePublicKeyHash)) fail('device-mismatch');
        const subjectIdHash = input.runtimeContext && input.runtimeContext.subjectIdHash;
        const licenseIdHash = input.runtimeContext && input.runtimeContext.licenseIdHash;
        if (!safeHash(subjectIdHash) || !safeHash(licenseIdHash) || subjectIdHash !== grant.subjectIdHash || licenseIdHash !== grant.licenseIdHash) fail('grant-binding-mismatch');
        const deviceKeyIdHash = hash(grant.deviceKeyId);
        if (DEFENSE.singleActiveDevice && Object.values(state.grants).some((record) => ACTIVE_STATES.includes(record.status) && record.subjectIdHash === subjectIdHash && record.deviceKeyIdHash !== deviceKeyIdHash)) fail('second-device-denied');
        const orderHash = hash(input.order.orderId);
        if (state.consumedOrders[orderHash] && state.consumedOrders[orderHash] !== grant.grantId) fail('order-consumed');
        if (!input.quota || !safeId(input.quota.reservationId) || !safeInteger(input.quota.available, 1)) fail('quota-unavailable');
        if (DEFENSE.idempotentQuota && state.quotaReservations[input.quota.reservationId] && state.quotaReservations[input.quota.reservationId] !== input.operationId) fail('quota-conflict');
        const currentSameGrant = state.grants[grant.grantId];
        if (currentSameGrant && currentSameGrant.activePackageDigest !== packageDigest) fail('grant-conflict');
        const context = Object.assign({}, input.runtimeContext, { entitlementAllowed });
        const opened = this.core.openPackage(input.packageBytes, context, input.parseOptions);
        if (DEFENSE.signatureBeforeDecrypt && (!opened || !opened.parsed || !opened.authorization || !opened.resources)) fail('xjsup-consumer-bypassed');
        const record = validateRecord({
          grantId: grant.grantId,
          status: 'active',
          packageId: manifest.packageId,
          packageVersion: manifest.packageVersion,
          contentHash: hashBase64url(manifest.contentSchemaHash),
          ciphertextHash: hashBase64url(manifest.ciphertextHash),
          authorKeyId: manifest.authorKeyId,
          providerPolicyHash: policyHash,
          subjectIdHash,
          licenseIdHash,
          deviceKeyIdHash,
          devicePublicKeyHash: grant.devicePublicKeyHash,
          recipientGrantIdHash: hash(grant.grantId),
          grantSequence: grant.grantSequence,
          revocationEpoch: grant.revocationEpoch,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
          lastOnlineVerifiedAt: new Date(Number(context.revocation && context.revocation.lastVerifiedOnlineAtMs || Date.parse(input.now))).toISOString(),
          offlineGraceUntil: new Date(Math.min(Date.parse(grant.expiresAt), Number(context.revocation && context.revocation.lastVerifiedOnlineAtMs || Date.parse(input.now)) + this.core.MAX_OFFLINE_GRACE_MS)).toISOString(),
          revision: currentSameGrant ? currentSameGrant.revision + 1 : 1,
          activePackageDigest: packageDigest,
          retiredPackageDigests: currentSameGrant ? currentSameGrant.retiredPackageDigests.slice() : [],
          quotaReservationId: input.quota.reservationId,
          freeManualAllowed: true,
        });
        const stages = ['requested', 'issued', 'delivered', 'active'];
        let prior = null;
        stages.forEach((eventType, index) => {
          const stageRecord = Object.assign({}, record, { status: eventType, revision: index + 1 });
          appendAudit(state, {
            eventId: input.eventId + '-' + eventType,
            grantId: record.grantId,
            eventType,
            actorClass: 'commercial-service',
            reasonCode: eventType,
            priorStateHash: hash(prior || 'none'),
            nextStateHash: hash(stageRecord),
            grantSequence: record.grantSequence,
            revocationEpoch: record.revocationEpoch,
            packageId: record.packageId,
            packageVersion: record.packageVersion,
            contentHash: record.contentHash,
            timestamp: input.now,
          });
          prior = stageRecord;
        });
        state.grants[record.grantId] = record;
        state.consumedOrders[orderHash] = record.grantId;
        state.quotaReservations[input.quota.reservationId] = input.operationId;
        const publicResult = { grant: publicProjection(record), delivery: { packageDigest, descriptor: opened.descriptor } };
        assertNoSensitive(publicResult.grant);
        return { publicResult, timestamp: input.now };
      });
      if (DEFENSE.durableReadback) {
        const readback = await this.repository.read();
        if (!readback.grants[result.result.grant.grantId] || readback.audit.length < 4) fail('audit-persistence-failed');
      }
      return Object.freeze({ ok: true, value: result.result, revision: result.state.revision, idempotent: result.idempotent, freeManualAllowed: true });
    } catch (error) { return failure(error, freeManualAllowed); }
  }
  async consumePackage(input) {
    const freeManualAllowed = canonicalFreeManual(this.entitlements);
    try {
      if (!input || !safeId(input.grantId) || !Buffer.isBuffer(input.packageBytes)) fail('invalid-request');
      const state = await this.repository.read();
      const record = state.grants[input.grantId];
      if (!record) fail('grant-not-found');
      if (!ACTIVE_STATES.includes(record.status)) fail('grant-not-active');
      const packageDigest = hash(input.packageBytes);
      if (DEFENSE.retiredEnvelope && (record.retiredPackageDigests.includes(packageDigest) || packageDigest !== record.activePackageDigest)) fail('package-envelope-stale');
      const entitlementAllowed = canonicalPaidAccess(this.entitlements, input.entitlementState);
      if (DEFENSE.canonicalEntitlement && !entitlementAllowed) fail('entitlement-denied');
      const context = Object.assign({}, input.runtimeContext, { entitlementAllowed, highWater: input.runtimeContext && input.runtimeContext.highWater || this.core.createHighWaterState() });
      if (DEFENSE.grantSequence) context.highWater.grants[record.grantId] = { grantSequence: record.grantSequence };
      if (DEFENSE.revocationEpoch) context.highWater.revocationEpoch = Math.max(Number(context.highWater.revocationEpoch || 0), record.revocationEpoch);
      const opened = this.core.openPackage(input.packageBytes, context, input.parseOptions);
      return Object.freeze({ ok: true, value: { descriptor: opened.descriptor, projection: publicProjection(record) }, freeManualAllowed: true });
    } catch (error) { return failure(error, freeManualAllowed); }
  }
  async transition(input) {
    const freeManualAllowed = canonicalFreeManual(this.entitlements);
    try {
      if (!input || !safeId(input.operationId) || !safeId(input.eventId) || !safeId(input.grantId) || !safeInteger(input.expectedRevision) || !validIso(input.now) || !STATES.includes(input.targetState)) fail('invalid-request');
      const requestHash = hash(input);
      const result = await this.repository.commit(input.expectedRevision, input.operationId, requestHash, async (state) => {
        const current = state.grants[input.grantId];
        if (!current) fail('grant-not-found');
        const allowed = TRANSITIONS[current.status] || [];
        if (!allowed.includes(input.targetState)) fail('illegal-transition');
        const next = clone(current);
        if (input.targetState === 'renewed') {
          if (!validIso(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(current.expiresAt)) fail('renewal-not-monotonic');
          if (DEFENSE.grantSequence && input.grantSequence <= current.grantSequence) fail('grant-sequence-rollback');
          next.expiresAt = input.expiresAt;
          next.grantSequence = input.grantSequence;
        }
        if (input.targetState === 'revoked') {
          if (input.signatureValid !== true || input.online !== true) fail('revocation-invalid');
          if (DEFENSE.revocationEpoch && (!safeInteger(input.revocationEpoch) || input.revocationEpoch <= current.revocationEpoch)) fail('revocation-epoch-rollback');
          next.revocationEpoch = input.revocationEpoch;
          next.grantSequence += 1;
        }
        if (input.targetState === 'transfer-pending') {
          if (!safeId(input.targetDeviceKeyId) || input.targetDeviceKeyIdHash !== hash(input.targetDeviceKeyId) || input.targetDeviceKeyIdHash === current.deviceKeyIdHash) fail('migration-target-invalid');
        }
        if (input.targetState === 'transfer-completed') {
          if (input.oldDeviceRevoked !== true || !safeId(input.targetDeviceKeyId) || input.targetDeviceKeyIdHash !== hash(input.targetDeviceKeyId)) fail('migration-revocation-required');
          if (DEFENSE.grantSequence && input.grantSequence <= current.grantSequence) fail('grant-sequence-rollback');
          if (DEFENSE.revocationEpoch && input.revocationEpoch <= current.revocationEpoch) fail('revocation-epoch-rollback');
          if (!safeHash(input.newPackageDigest) || input.newPackageDigest === current.activePackageDigest) fail('migration-envelope-invalid');
          next.retiredPackageDigests.push(current.activePackageDigest);
          next.activePackageDigest = input.newPackageDigest;
          next.deviceKeyIdHash = input.targetDeviceKeyIdHash;
          next.grantSequence = input.grantSequence;
          next.revocationEpoch = input.revocationEpoch;
        }
        next.status = input.targetState;
        next.revision += 1;
        if (DEFENSE.terminalFreeManual) next.freeManualAllowed = true;
        validateRecord(next);
        appendAudit(state, {
          eventId: input.eventId,
          grantId: next.grantId,
          eventType: input.targetState,
          actorClass: input.actorClass || 'commercial-service',
          reasonCode: input.reasonCode || input.targetState,
          priorStateHash: hash(current),
          nextStateHash: hash(next),
          grantSequence: next.grantSequence,
          revocationEpoch: next.revocationEpoch,
          packageId: next.packageId,
          packageVersion: next.packageVersion,
          contentHash: next.contentHash,
          timestamp: input.now,
        });
        state.grants[next.grantId] = next;
        return { publicResult: publicProjection(next), timestamp: input.now };
      });
      return Object.freeze({ ok: true, value: result.result, revision: result.state.revision, idempotent: result.idempotent, freeManualAllowed: true });
    } catch (error) { return failure(error, freeManualAllowed); }
  }
  async getProjection(input) {
    const freeManualAllowed = canonicalFreeManual(this.entitlements);
    try {
      if (!input || !exactKeys(input, ['grantId']) || !safeId(input.grantId)) fail('invalid-request');
      const state = await this.repository.read();
      const record = state.grants[input.grantId];
      if (!record) return Object.freeze({ ok: false, errorCode: 'grant-not-found', freeManualAllowed: true });
      return Object.freeze({ ok: true, value: publicProjection(record), revision: state.revision, freeManualAllowed: true });
    } catch (error) { return failure(error, freeManualAllowed); }
  }
  async getAuditPage(input) {
    const freeManualAllowed = canonicalFreeManual(this.entitlements);
    try {
      const request = input || {};
      if (!exactKeys(request, ['cursor', 'limit']) || !safeInteger(request.cursor) || !safeInteger(request.limit, 1) || request.limit > MAX_AUDIT_PAGE) fail('invalid-request');
      const state = await this.repository.read();
      const page = state.audit.slice(request.cursor, request.cursor + request.limit).map(auditProjection);
      const value = { items: page, nextCursor: request.cursor + page.length < state.audit.length ? request.cursor + page.length : null };
      assertBounded(value);
      return Object.freeze({ ok: true, value: Object.freeze(value), revision: state.revision, freeManualAllowed: true });
    } catch (error) { return failure(error, freeManualAllowed); }
  }
}

function createDurableRecipientGrantRepository(options) { return new DurableRecipientGrantRepository(options); }
function createRecipientGrantBoundary(options) { return new RecipientGrantProductionBoundary(options); }

module.exports = Object.freeze({
  STATES,
  ACTIVE_STATES,
  TERMINAL_STATES,
  PUBLIC_PROJECTION_KEYS,
  AUDIT_PUBLIC_KEYS,
  RECORD_KEYS,
  DEFENSE,
  hash,
  canonical,
  validateState,
  publicProjection,
  DurableRecipientGrantRepository,
  RecipientGrantProductionBoundary,
  createDurableRecipientGrantRepository,
  createRecipientGrantBoundary,
});
