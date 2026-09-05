'use strict';
// XinJing v5.0 Commercial Billing Core v3.
// Dependency-free CommonJS module. Synthetic commercial metadata only.
// Implements the frozen v3 commercial request-billing contract
// (contract_id: v5.0-commercial-request-billing-v3).
//
// Exported factory: createBillingService(config)
//   config: initial envelope state object, OR
//           { initialState, persistenceAdapter } for custom adapter injection.
//
// All mutable state is held behind the factory closure. The persistence
// adapter demonstrates the durable commit/readback contract from section 3.
//
// Quota exhaustion remains a distinct non-money failure. Reconciliation of a
// still-reserved request remains pending until the provider outcome is marked
// unknown; neither behavior may silently debit or release money.
//
// Mutation markers /*C1*/–/*C14*/ support reverse-mutation testing.

const crypto = require('crypto');

// --- Sensitive field blocklist (section 6: no provider payload, prompt,
//     clinical content, secret, raw path, or internal routing crosses IPC) ---
var SENSITIVE = [
  'prompt', 'providerpayload', 'apikey', 'token', 'credential',
  'clinicaltext', 'rawpath', 'internalrouting', 'secret', 'password'
];

// --- Utilities ---
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function nowISO() { return new Date().toISOString(); }
function fail(code) { return { ok: false, errorCode: code, retryable: false }; }

function assertNoSensitive(obj) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(assertNoSensitive); return; }
  for (var i = 0, keys = Object.keys(obj); i < keys.length; i++) {
    var k = keys[i], lo = k.toLowerCase();
    for (var j = 0; j < SENSITIVE.length; j++) {
      var sf = SENSITIVE[j];
      if (lo === sf || lo.indexOf(sf) !== -1) {
        var e = new Error('sensitive');
        e.errorCode = 'sensitive-field-rejected';
        e.retryable = false;
        throw e;
      }
    }
    assertNoSensitive(obj[k]);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonicalize(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalHash(input) {
  return crypto.createHash('sha256').update(canonicalize(input)).digest('hex');
}

// 领域钱包使用 balance；remaining 仅作为旧数据格式兼容读取。
function walletBalance(wallet) {
  if (!wallet || typeof wallet !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(wallet, 'balance')) {
    if (!Number.isSafeInteger(wallet.balance) || wallet.balance < 0) return null;
    return wallet.balance;
  }
  if (Object.prototype.hasOwnProperty.call(wallet, 'remaining')) {
    if (!Number.isSafeInteger(wallet.remaining) || wallet.remaining < 0) return null;
    return wallet.remaining;
  }
  return null;
}

// --- In-memory persistence adapter ---
// Demonstrates the durable commit/readback contract (contract section 3):
// write → read → compare → fail-closed on mismatch.
function createInMemoryAdapter() {
  var store = null;
  var corruptNext = false;
  var failNextWrite = false;
  var failNextRead = false;
  return {
    write: function (snapshot) {
      return new Promise(function (resolve, reject) {
        if (failNextWrite) {
          failNextWrite = false;
          reject({ errorCode: 'durable-write-failed', retryable: false });
          return;
        }
        store = clone(snapshot);
        resolve();
      });
    },
    read: function () {
      return new Promise(function (resolve, reject) {
        if (failNextRead) {
          failNextRead = false;
          reject({ errorCode: 'durable-read-failed', retryable: false });
          return;
        }
        if (store === null) {
          reject({ errorCode: 'durable-read-failed', retryable: false });
          return;
        }
        var result = clone(store);
        if (corruptNext) {
          corruptNext = false;
          result.revision = -999;
        }
        resolve(result);
      });
    },
    hasData: function () { return store !== null; },
    _corruptNextReadback: function (v) { corruptNext = v; },
    _failNextWrite: function (v) { failNextWrite = v; },
    _failNextRead: function (v) { failNextRead = v; }
  };
}

// --- Factory ---
function createBillingService(config) {
  var initialState;
  var adapter;
  if (config && typeof config === 'object' && config.initialState !== undefined) {
    initialState = config.initialState;
    adapter = config.persistenceAdapter || createInMemoryAdapter();
  } else {
    initialState = config;
    adapter = createInMemoryAdapter();
  }

  var envelope = clone(initialState || {
    schemaVersion: 1, revision: 0, balanceMinor: 1000, reservedMinor: 0,
    quotaWallets: {}, requestCharges: {}, operationReceipts: {},
    auditEvents: [], updatedAt: nowISO()
  });

  var catalog = {
    'model-alpha': { priceMinor: 100, active: true, catalogRevision: 1 },
    'model-beta': { priceMinor: 250, active: true, catalogRevision: 1 },
    'model-inactive': { priceMinor: 50, active: false, catalogRevision: 1 }
  };

  var readFault = false; // simulates durable-read-failed on read operations

  // Serialize mutating operations per service instance so each operation reads
  // the durable state committed by the preceding operation. The settled tail
  // keeps later mutations runnable after a failed or thrown operation.
  var mutationQueue = Promise.resolve();
  function enqueueMutation(fn) {
    var run = mutationQueue.then(fn);
    mutationQueue = run.then(function () {}, function () {});
    return run;
  }

  // --- Durable commit and readback (section 3) ---
  // Commits the complete snapshot, reads it back, and fails closed on mismatch.
  async function commitAndReadback(snapshot) {
    await adapter.write(snapshot);
    var readback = await adapter.read();
    /*C1*/ if (JSON.stringify(readback) !== JSON.stringify(snapshot)) {
      throw { errorCode: 'readback-mismatch', retryable: false };
    }
    envelope = clone(snapshot);
  }

  // --- Idempotent replay / conflict detection (section 3) ---
  function checkExisting(opId, payload) {
    var ex = envelope.operationReceipts[opId];
    if (ex) {
      if (ex.canonicalHash !== canonicalHash(payload)) {
        throw { errorCode: 'operation-conflict', retryable: false };
      }
      return ex;
    }
    return null;
  }

  function catchErr(e) {
    if (e && typeof e === 'object' && e.errorCode) return fail(e.errorCode);
    return fail('invalid-request');
  }

  function checkReadFault() {
    if (readFault) {
      readFault = false;
      throw { errorCode: 'durable-read-failed', retryable: false };
    }
  }

  // --- Non-money projection builder (section 6) ---
  function buildNonMoneyProjection(mode, snapshot, quotaWalletId) {
    var projection = {
      billingMode: mode,
      chargeStatus: 'not-applicable',
      /*C5*/ chargedMinor: null,
      priceMinor: null,
      currency: null,
      catalogRevision: null,
      remainingBalanceMinor: null,
      availableBalanceMinor: null
    };
    if (mode === 'request-count-quota' && quotaWalletId) {
      projection.quotaRemaining = walletBalance(snapshot.quotaWallets[quotaWalletId]);
    }
    return projection;
  }

  // --- Channel: commercial.getModelPriceCatalog ---
  async function getModelPriceCatalog(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller) return fail('invalid-request');
      checkReadFault();
      if (input.catalogRevision !== undefined && input.catalogRevision !== 1) {
        return fail('catalog-revision-mismatch');
      }
      return { ok: true, value: clone(catalog), revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.getAccountBalance ---
  // Read-only balance projection (section 6). Separate from non-money billing.
  async function getAccountBalance(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller) return fail('invalid-request');
      checkReadFault();
      /*C6*/ var avail = envelope.balanceMinor - envelope.reservedMinor;
      return {
        ok: true,
        value: {
          currency: 'CNY',
          remainingBalanceMinor: envelope.balanceMinor,
          availableBalanceMinor: avail,
          revision: envelope.revision
        },
        revision: envelope.revision,
        idempotent: false
      };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.quoteRequestCharge ---
  async function quoteRequestCharge(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.model) return fail('invalid-request');
      var entry = catalog[input.model];
      if (!entry) return fail('unknown-model');
      if (!entry.active) return fail('model-not-active');
      if (input.catalogRevision !== undefined && input.catalogRevision !== entry.catalogRevision) {
        return fail('catalog-revision-mismatch');
      }
      return {
        ok: true,
        value: {
          model: input.model, priceMinor: entry.priceMinor, currency: 'CNY',
          catalogRevision: entry.catalogRevision, billingMode: 'money-per-request'
        },
        revision: envelope.revision, idempotent: false
      };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.reserveRequestCharge ---
  // Money-per-request only (section 2, 4, 5). Price snapshotted at reservation.
  async function reserveRequestCharge(input) {
    return enqueueMutation(function () { return reserveRequestChargeImpl(input); });
  }

  async function reserveRequestChargeImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.model || !input.operationId) {
        return fail('invalid-request');
      }
      if (input.billingMode !== 'money-per-request') return fail('invalid-request');
      /*C9*/ var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      var entry = catalog[input.model];
      if (!entry) return fail('unknown-model');
      if (!entry.active) return fail('model-not-active');
      if (input.catalogRevision !== undefined && input.catalogRevision !== entry.catalogRevision) {
        return fail('catalog-revision-mismatch');
      }
      /*C10*/ if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      var priceMinor = entry.priceMinor;
      var available = envelope.balanceMinor - envelope.reservedMinor;
      /*C14*/ // no silent fallback to trial/quota/byok
      /*C4*/ if (available < priceMinor) return fail('insufficient-balance');
      var requestId = 'req-' + input.operationId;
      var snapshot = clone(envelope);
      snapshot.reservedMinor += priceMinor;
      snapshot.requestCharges[requestId] = {
        requestId: requestId, model: input.model, billingMode: 'money-per-request',
        priceMinor: priceMinor, status: 'reserved', deviceId: input.deviceId,
        catalogRevision: entry.catalogRevision, createdAt: nowISO(), updatedAt: nowISO()
      };
      snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      var result = {
        requestId: requestId, billingMode: 'money-per-request',
        chargeStatus: 'reserved', priceMinor: priceMinor, chargedMinor: null,
        currency: 'CNY', catalogRevision: entry.catalogRevision,
        remainingBalanceMinor: snapshot.balanceMinor,
        availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor
        /*C13*/
      };
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: result, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'reserve',
        mode: 'money-per-request', revision: snapshot.revision, redacted: true
      });
      /*C11*/ await commitAndReadback(snapshot);
      return { ok: true, value: result, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.settleRequestCharge ---
  // Uses frozen price from reservation (section 5).
  async function settleRequestCharge(input) {
    return enqueueMutation(function () { return settleRequestChargeImpl(input); });
  }

  async function settleRequestChargeImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.requestId || !input.operationId) {
        return fail('invalid-request');
      }
      var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      var charge = envelope.requestCharges[input.requestId];
      if (!charge) return fail('unknown-request');
      if (charge.deviceId !== input.deviceId) return fail('device-mismatch');
      if (charge.status !== 'reserved') return fail('invalid-state');
      if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      /*C7*/ var priceMinor = charge.priceMinor;
      var snapshot = clone(envelope);
      snapshot.balanceMinor -= priceMinor;
      snapshot.reservedMinor -= priceMinor;
      snapshot.requestCharges[input.requestId].status = 'settled';
      snapshot.requestCharges[input.requestId].updatedAt = nowISO();
      snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      var result = {
        requestId: input.requestId, billingMode: 'money-per-request',
        chargeStatus: 'settled', priceMinor: priceMinor, chargedMinor: priceMinor,
        currency: 'CNY', catalogRevision: charge.catalogRevision,
        remainingBalanceMinor: snapshot.balanceMinor,
        availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor
      };
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: result, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'settle',
        mode: 'money-per-request', revision: snapshot.revision, redacted: true
      });
      await commitAndReadback(snapshot);
      return { ok: true, value: result, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.releaseRequestCharge ---
  async function releaseRequestCharge(input) {
    return enqueueMutation(function () { return releaseRequestChargeImpl(input); });
  }

  async function releaseRequestChargeImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.requestId || !input.operationId) {
        return fail('invalid-request');
      }
      var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      var charge = envelope.requestCharges[input.requestId];
      if (!charge) return fail('unknown-request');
      if (charge.deviceId !== input.deviceId) return fail('device-mismatch');
      if (charge.status !== 'reserved') return fail('invalid-state');
      if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      var priceMinor = charge.priceMinor;
      var snapshot = clone(envelope);
      snapshot.reservedMinor -= priceMinor;
      snapshot.requestCharges[input.requestId].status = 'released';
      snapshot.requestCharges[input.requestId].updatedAt = nowISO();
      snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      var result = {
        requestId: input.requestId, billingMode: 'money-per-request',
        chargeStatus: 'released', priceMinor: priceMinor, chargedMinor: null,
        currency: 'CNY', catalogRevision: charge.catalogRevision,
        remainingBalanceMinor: snapshot.balanceMinor,
        availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor
      };
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: result, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'release',
        mode: 'money-per-request', revision: snapshot.revision, redacted: true
      });
      await commitAndReadback(snapshot);
      return { ok: true, value: result, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.markRequestUnknown ---
  // Holds reservation until trusted reconciliation (section 5).
  async function markRequestUnknown(input) {
    return enqueueMutation(function () { return markRequestUnknownImpl(input); });
  }

  async function markRequestUnknownImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.requestId || !input.operationId) {
        return fail('invalid-request');
      }
      var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      var charge = envelope.requestCharges[input.requestId];
      if (!charge) return fail('unknown-request');
      if (charge.deviceId !== input.deviceId) return fail('device-mismatch');
      if (charge.status !== 'reserved') return fail('invalid-state');
      if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      var priceMinor = charge.priceMinor;
      var snapshot = clone(envelope);
      snapshot.requestCharges[input.requestId].status = 'unknown';
      snapshot.requestCharges[input.requestId].updatedAt = nowISO();
      snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      var result = {
        requestId: input.requestId, billingMode: 'money-per-request',
        chargeStatus: 'pending-reconciliation', priceMinor: priceMinor,
        chargedMinor: null, currency: 'CNY', catalogRevision: charge.catalogRevision,
        remainingBalanceMinor: snapshot.balanceMinor,
        availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor
      };
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: result, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'mark-unknown',
        mode: 'money-per-request', revision: snapshot.revision, redacted: true
      });
      await commitAndReadback(snapshot);
      return { ok: true, value: result, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Channel: commercial.reconcileRequestCharge ---
  // Trusted reconciliation of an unknown request (section 5).
  async function reconcileRequestCharge(input) {
    return enqueueMutation(function () { return reconcileRequestChargeImpl(input); });
  }

  async function reconcileRequestChargeImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.requestId || !input.operationId) {
        return fail('invalid-request');
      }
      var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      var charge = envelope.requestCharges[input.requestId];
      if (!charge) return fail('unknown-request');
      if (charge.deviceId !== input.deviceId) return fail('device-mismatch');
      // A reserved request must be marked unknown before trusted reconciliation.
      if (charge.status === 'reserved') return fail('reconciliation-pending');
      if (charge.status !== 'unknown') return fail('invalid-state');
      if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      if (!input.evidence || input.evidence.trusted !== true) return fail('invalid-evidence');
      var priceMinor = charge.priceMinor;
      var snapshot = clone(envelope);
      if (input.outcome === 'settled') {
        snapshot.balanceMinor -= priceMinor;
        snapshot.reservedMinor -= priceMinor;
        snapshot.requestCharges[input.requestId].status = 'settled';
      } else if (input.outcome === 'released') {
        snapshot.reservedMinor -= priceMinor;
        snapshot.requestCharges[input.requestId].status = 'released';
      } else {
        return fail('invalid-request');
      }
      snapshot.requestCharges[input.requestId].updatedAt = nowISO();
      snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      var result = {
        requestId: input.requestId, billingMode: 'money-per-request',
        chargeStatus: input.outcome, priceMinor: priceMinor,
        chargedMinor: input.outcome === 'settled' ? priceMinor : null,
        currency: 'CNY', catalogRevision: charge.catalogRevision,
        remainingBalanceMinor: snapshot.balanceMinor,
        availableBalanceMinor: snapshot.balanceMinor - snapshot.reservedMinor
      };
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: result, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'reconcile-' + input.outcome,
        mode: 'money-per-request', revision: snapshot.revision, redacted: true
      });
      await commitAndReadback(snapshot);
      return { ok: true, value: result, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  // --- Non-money request processing (sections 2, 4, 6, 7) ---
  // Handles request-count-quota, byok, and trial modes.
  async function processNonMoneyRequest(input) {
    return enqueueMutation(function () { return processNonMoneyRequestImpl(input); });
  }

  async function processNonMoneyRequestImpl(input) {
    try {
      assertNoSensitive(input);
      if (!input || !input.caller || !input.deviceId || !input.operationId) {
        return fail('invalid-request');
      }
      var mode = input.billingMode;
      if (mode !== 'request-count-quota' && mode !== 'byok' && mode !== 'trial') {
        return fail('invalid-request');
      }
      var existing = checkExisting(input.operationId, input);
      if (existing) {
        return { ok: true, value: existing.result, revision: envelope.revision, idempotent: true };
      }
      if (input.expectedRevision != null && input.expectedRevision !== envelope.revision) {
        return fail('stale-revision');
      }
      var snapshot = clone(envelope);
      if (mode === 'request-count-quota') {
        var wid = input.quotaWalletId;
        if (!wid) return fail('invalid-request');
        var wallet = snapshot.quotaWallets[wid];
        var balance = walletBalance(wallet);
        if (balance === null || balance <= 0) {
          return fail('quota-exhausted');
        }
        /*C3*/ if (Object.prototype.hasOwnProperty.call(wallet, 'balance')) {
          wallet.balance = balance - 1;
        } else {
          wallet.remaining = balance - 1;
        }
      }
      /*C12*/ // money-quota separation enforced: no money mutation in non-money modes
      var projection = buildNonMoneyProjection(mode, snapshot, input.quotaWalletId);
      /*C2*/ snapshot.revision += 1;
      snapshot.updatedAt = nowISO();
      snapshot.operationReceipts[input.operationId] = {
        canonicalHash: canonicalHash(input), payload: input,
        result: projection, revision: snapshot.revision
      };
      snapshot.auditEvents.push({
        operationId: input.operationId, action: 'process',
        mode: mode, revision: snapshot.revision, redacted: true
      });
      /*C8*/ await commitAndReadback(snapshot);
      return { ok: true, value: projection, revision: envelope.revision, idempotent: false };
    } catch (e) { return catchErr(e); }
  }

  return {
    getModelPriceCatalog: getModelPriceCatalog,
    getAccountBalance: getAccountBalance,
    quoteRequestCharge: quoteRequestCharge,
    reserveRequestCharge: reserveRequestCharge,
    settleRequestCharge: settleRequestCharge,
    releaseRequestCharge: releaseRequestCharge,
    markRequestUnknown: markRequestUnknown,
    reconcileRequestCharge: reconcileRequestCharge,
    processNonMoneyRequest: processNonMoneyRequest,
    _replaceEnvelope: function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.revision)) {
        throw { errorCode: 'durable-read-failed', retryable: false };
      }
      envelope = clone(value);
    },
    _getEnvelope: function () { return clone(envelope); },
    _setFault: function (n) {
      if (n === 'corrupt-readback') adapter._corruptNextReadback(true);
      else if (n === 'durable-write-failed') adapter._failNextWrite(true);
      else if (n === 'durable-read-failed') readFault = true;
    },
    _setCatalogPrice: function (m, p) { catalog[m].priceMinor = p; },
    _getCatalog: function () { return clone(catalog); },
    _getAdapter: function () { return adapter; }
  };
}

module.exports = {
  createBillingService: createBillingService,
  SENSITIVE: SENSITIVE,
  clone: clone,
  assertNoSensitive: assertNoSensitive,
  canonicalHash: canonicalHash,
  createInMemoryAdapter: createInMemoryAdapter
};
