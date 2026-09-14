'use strict';
// XJ-5.0.0-g8-commercial-m4-m5-expected-red-coverage-001
// XJ-5.0.0-g9-commercial-stale-revision-expected-red-closure-001 追加：
//   M4 实体通道 stale expectedRevision 永久 expected-red 场景（含重启后仍拒绝与
//   正向控制），用于行为级杀死 ADV-G6-3（commitIntegration stale guard 恒假变异）。
// M4 实体通道 commitIntegration 收据/幂等路径 + M5 直连 unknown-model 守卫的聚焦覆盖。
//
// 背景：round-3 变异审计中两个 SURVIVOR（R3-M4 commitIntegration 收据写入被跳过、
// R3-M5 billing-core unknown-model 守卫被移除）当时仅由 task-local 场景检测，
// 5 个验收测试（commercial-durable-persistence-foundation / commercial-empty-catalog-fail-closed /
// commercial-production-integration / server-authoritative-balance-route /
// server-authoritative-balance-router-runtime）都不触达这两条路径。本文件把这两条路径
// 的正例与 expected-red 行为固化为永久测试。
//
// 约束（contract XJ-5.0.0-G8-COMMERCIAL-M4-M5-EXPECTED-RED-V1）：
//   - 只读生产源码 + 真实临时文件；无 mock、无替换生产入口的 proxy。
//   - M4 走真实 facade 实体通道（applyOrderEvent / applySubscriptionEvent → commitIntegration）。
//   - M5 走 createDurableBillingService / createBillingService 直连 billing-core，
//     绕过生产 facade 的空官方目录 gate（该 gate 使 quote/reserve 稳定 catalog-unavailable，
//     因此 unknown-model 守卫只能在直连 service 通道被观测）。
//   - expected-red：operation-conflict / stale 重放偏离 / unknown-model 必须稳定失败，
//     且失败不产生任何 durable 状态变化。
//
// runM4M5Suite(paths) 供反向变异 harness 复用：加载 paths 指定的 REAL 模块副本
// （生产路径或 task-local 变异副本）运行全部场景，返回 [{name, pass, error, ms}]。

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REAL_FACADE = path.resolve(__dirname, '..', '..', 'app', 'js', 'commercial-ipc-facade.js');
const REAL_DURABLE = path.resolve(__dirname, '..', '..', 'app', 'js', 'commercial-durable-persistence.js');
const REAL_CORE = path.resolve(__dirname, '..', '..', 'app', 'js', 'commercial-billing-core.js');

const DEVICE = 'device:synthetic';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFacadeWorkspace(mod) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-m4m5-facade-'));
  const filePath = path.join(root, 'commercial-envelope.json');
  fs.writeFileSync(filePath, JSON.stringify(mod.initialEnvelope()), 'utf8');
  return { root, filePath };
}

function makeLegacyEnvelope(balanceMinor) {
  return {
    schemaVersion: 1, revision: 0, balanceMinor, reservedMinor: 0,
    quotaWallets: {}, requestCharges: {}, operationReceipts: {},
    auditEvents: [], updatedAt: new Date().toISOString(),
  };
}

function makeDurableWorkspace(balanceMinor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-m4m5-durable-'));
  const filePath = path.join(root, 'durable-envelope.json');
  return { root, filePath, initialState: makeLegacyEnvelope(balanceMinor) };
}

function requireReal(modulePath) {
  const resolved = require.resolve(modulePath);
  assert.equal(resolved, path.resolve(modulePath), 'module must resolve to the exact entry path (no proxy/mock): ' + modulePath);
  return require(modulePath);
}

// M4 实体通道命令（order）：顶层字段与 commonRequest 校验一致。
function orderCommand(expectedRevision, operationId, orderId) {
  return {
    requestId: 'req-' + operationId,
    operationId,
    expectedRevision,
    revocationEpoch: 0,
    deviceBindingHash: DEVICE,
    signedEvidence: { signatureValid: true },
    payload: {
      orderId,
      nextState: 'issued',
      fields: { sku: 'SKU-A', amountMinor: 100, currency: 'CNY' },
    },
  };
}

function subscriptionCommand(expectedRevision, operationId, entityRevision) {
  return {
    requestId: 'req-' + operationId,
    operationId,
    expectedRevision,
    revocationEpoch: 0,
    deviceBindingHash: DEVICE,
    signedEvidence: { signatureValid: true },
    payload: {
      subscriptionId: 'sub_m4m5_001',
      create: {
        subscriptionId: 'sub_m4m5_001',
        tier: 'pro',
        deviceBindingHash: DEVICE,
        revocationEpoch: 0,
      },
      event: {
        operationId: 'domain-sub-' + entityRevision,
        targetState: 'pending',
        revision: entityRevision,
        revocationEpoch: 0,
        deviceBindingHash: DEVICE,
        signatureValid: true,
        clockValid: true,
      },
    },
  };
}

const REDACTED_RESULT_KEYS = new Set([
  'subscriptionId', 'orderId', 'deviceBindingHash', 'walletId', 'tier', 'state', 'status',
  'sku', 'currency', 'amountMinor', 'balance', 'revision', 'revocationEpoch',
  'lastVerifiedOnlineAtMs', 'offlineGraceEndsAtMs', 'updatedAt', 'remaining',
]);

function assertRedactedResult(result, subset) {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'receipt result must be an object');
  for (const key of Object.keys(result)) {
    assert.ok(REDACTED_RESULT_KEYS.has(key), 'receipt result key must be redacted-allowlisted: ' + key);
  }
  for (const key of Object.keys(subset)) {
    assert.deepEqual(result[key], subset[key], 'receipt result.' + key);
  }
}

// ---------- M4 scenarios ----------

async function m4OrderCommitWritesReceiptAndAudit(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const first = await facade.applyOrderEvent(orderCommand(0, 'op-m4-commit', 'order-m4'));
    assert.equal(first.ok, true, 'entity commit must succeed: ' + JSON.stringify(first));
    assert.equal(first.idempotent, false, 'first commit is not a replay');
    assert.equal(first.revision, 1, 'first commit advances envelope revision to 1');
    assert.equal(first.value.orderId, 'order-m4');
    assert.equal(first.value.state, 'issued');

    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.equal(raw.revision, 1, 'durable envelope revision persisted');
    assert.ok(raw.orders['order-m4'], 'entity record persisted');
    assert.equal(raw.orders['order-m4'].state, 'issued');

    const receipt = raw.operationReceipts['op-m4-commit'];
    assert.ok(receipt, 'commitIntegration receipt must be persisted');
    assert.equal(receipt.entityType, 'order');
    assert.equal(receipt.entityId, 'order-m4');
    assert.equal(receipt.resultCode, 'ok');
    assert.equal(receipt.revision, 1, 'receipt is bound to the commit revision');
    assert.match(receipt.canonicalHash, /^[0-9a-f]{64}$/, 'receipt carries a canonical request hash');
    assert.ok(!Object.prototype.hasOwnProperty.call(receipt.payload, 'context'), 'receipt payload must not carry the trusted context');
    assert.equal(receipt.payload.operationId, 'op-m4-commit');
    assert.equal(receipt.payload.expectedRevision, 0, 'receipt payload preserves the original expectedRevision for replay hydration');
    assertRedactedResult(receipt.result, { orderId: 'order-m4', state: 'issued', sku: 'SKU-A', amountMinor: 100, currency: 'CNY', revision: 1 });

    assert.equal(raw.auditEvents.length, 1, 'commit appends exactly one redacted audit event');
    const audit = raw.auditEvents[0];
    assert.equal(audit.operationId, 'op-m4-commit');
    assert.equal(audit.entityType, 'order');
    assert.equal(audit.entityId, 'order-m4');
    assert.equal(audit.resultCode, 'ok');
    assert.equal(audit.revision, 1);
    assert.equal(audit.redacted, true);
  } finally {
    await facade.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m4OrderReplayIdempotentSameRevisionNoStateChange(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const first = await facade.applyOrderEvent(orderCommand(0, 'op-m4-replay', 'order-replay'));
    assert.equal(first.ok, true, 'first commit must succeed: ' + JSON.stringify(first));
    assert.equal(first.idempotent, false);
    assert.equal(first.revision, 1);

    const digestBefore = sha256File(ws.filePath);
    const replay = await facade.applyOrderEvent(orderCommand(0, 'op-m4-replay', 'order-replay'));
    assert.equal(replay.ok, true, 'identical replay must be accepted: ' + JSON.stringify(replay));
    assert.equal(replay.idempotent, true, 'identical replay must be marked idempotent');
    assert.equal(replay.revision, 1, 'replay returns the ORIGINAL commit revision, not a new one');
    assert.deepEqual(replay.value, first.value, 'replay returns the original redacted result');

    assert.equal(sha256File(ws.filePath), digestBefore, 'replay must not rewrite the durable envelope');
    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.equal(raw.revision, 1, 'revision unchanged by replay');
    assert.equal(Object.keys(raw.operationReceipts).length, 1, 'no second receipt written');
    assert.equal(raw.auditEvents.length, 1, 'no second audit event written');

    const conflictOnReplayReceipt = await facade.applyOrderEvent(orderCommand(0, 'op-m4-replay', 'order-different'));
    assert.equal(conflictOnReplayReceipt.ok, false, 'operationId reuse with a different payload must fail closed: ' + JSON.stringify(conflictOnReplayReceipt));
    assert.equal(conflictOnReplayReceipt.errorCode, 'operation-conflict');
    assert.equal(conflictOnReplayReceipt.retryable, false);
    assert.equal(sha256File(ws.filePath), digestBefore, 'operation-conflict must not touch durable state');
  } finally {
    await facade.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m4OrderReplayAfterRestartStillIdempotent(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  const first = await facade.applyOrderEvent(orderCommand(0, 'op-m4-restart', 'order-restart'));
  assert.equal(first.ok, true, 'first commit must succeed: ' + JSON.stringify(first));
  assert.equal(first.revision, 1);
  await facade.close();

  const reopened = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const digestBefore = sha256File(ws.filePath);
    const replay = await reopened.applyOrderEvent(orderCommand(0, 'op-m4-restart', 'order-restart'));
    assert.equal(replay.ok, true, 'replay after restart must resolve: ' + JSON.stringify(replay));
    assert.equal(replay.idempotent, true, 'receipt survives restart and keeps replay idempotent');
    assert.equal(replay.revision, 1, 'restart replay returns the original revision');
    assert.deepEqual(replay.value, first.value);
    assert.equal(sha256File(ws.filePath), digestBefore, 'restart replay does not rewrite durable state');
  } finally {
    await reopened.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m4ConcurrentSameOperationCommitsOnce(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const results = await Promise.all([
      facade.applyOrderEvent(orderCommand(0, 'op-m4-concurrent', 'order-concurrent')),
      facade.applyOrderEvent(orderCommand(0, 'op-m4-concurrent', 'order-concurrent')),
    ]);
    for (const result of results) {
      assert.equal(result.ok, true, 'serialized identical operations both resolve: ' + JSON.stringify(result));
      assert.equal(result.revision, 1);
    }
    const idempotencies = results.map((result) => result.idempotent).sort();
    assert.deepEqual(idempotencies, [false, true], 'exactly one commit and one idempotent replay');

    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.equal(raw.revision, 1, 'envelope committed exactly once');
    assert.equal(Object.keys(raw.operationReceipts).length, 1, 'one receipt for one operationId');
    assert.equal(raw.auditEvents.length, 1, 'one audit event for one operationId');
  } finally {
    await facade.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m4SubscriptionChannelReceiptAndReplay(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const first = await facade.applySubscriptionEvent(subscriptionCommand(0, 'op-sub-commit', 1));
    assert.equal(first.ok, true, 'subscription entity commit must succeed: ' + JSON.stringify(first));
    assert.equal(first.idempotent, false);
    assert.equal(first.revision, 1);
    assert.equal(first.value.state, 'pending');

    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    const receipt = raw.operationReceipts['op-sub-commit'];
    assert.ok(receipt, 'subscription commit receipt must be persisted');
    assert.equal(receipt.entityType, 'subscription');
    assert.equal(receipt.entityId, 'sub_m4m5_001');
    assert.equal(receipt.revision, 1);

    const replay = await facade.applySubscriptionEvent(subscriptionCommand(0, 'op-sub-commit', 1));
    assert.equal(replay.ok, true, 'subscription replay must resolve: ' + JSON.stringify(replay));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.revision, 1);

    const conflict = await facade.applySubscriptionEvent(subscriptionCommand(1, 'op-sub-commit', 2));
    assert.equal(conflict.ok, false, 'subscription operationId reuse with different payload must conflict');
    assert.equal(conflict.errorCode, 'operation-conflict');
    assert.equal(conflict.retryable, false);
  } finally {
    await facade.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// XJ-5.0.0-g9-commercial-stale-revision-expected-red-closure-001：
// 真实 facade + durable repository 的 stale expectedRevision 永久 expected-red 链。
// 行为级守卫证明 ADV-G6-3（commitIntegration 中
// `if (request.expectedRevision !== current.revision) return failure('stale-revision');`
// 被变异为恒假）必须被本场景杀死：变异后 stale 提交会返回 ok:true 并写入
// durable 状态，本场景的 ok/errorCode/retryable/SHA/深度状态断言必然失败。
async function m4StaleExpectedRevisionRejectedDurableUnchangedAcrossRestart(paths) {
  const mod = requireReal(paths.facadePath);
  const ws = makeFacadeWorkspace(mod);
  const facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });

  // 步骤 1-3：合法提交使 revision 0 -> 1，随后完整记录请求前状态。
  const first = await facade.applyOrderEvent(orderCommand(0, 'op-m4-stale-base', 'order-stale-base'));
  assert.equal(first.ok, true, 'baseline entity commit must succeed: ' + JSON.stringify(first));
  assert.equal(first.idempotent, false, 'baseline commit is not a replay');
  assert.equal(first.revision, 1, 'baseline commit advances envelope revision to 1');
  assert.equal(await facade.getCurrentRevision(), 1, 'getCurrentRevision reflects the committed revision');

  const digestBeforeStale = sha256File(ws.filePath);
  const snapshotBeforeStale = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
  assert.equal(snapshotBeforeStale.revision, 1, 'parsed durable revision is 1 before the stale attempt');
  assert.ok(snapshotBeforeStale.orders['order-stale-base'], 'baseline entity persisted');
  assert.ok(snapshotBeforeStale.operationReceipts['op-m4-stale-base'], 'baseline receipt persisted');
  assert.equal(snapshotBeforeStale.auditEvents.length, 1, 'baseline audit event persisted');

  try {
    // 步骤 4-5：新 requestId/operationId/实体 ID，但携带旧 expectedRevision: 0。
    const staleCommand = orderCommand(0, 'op-m4-stale-attempt', 'order-stale-attempt');
    assert.notEqual(staleCommand.requestId, 'req-op-m4-stale-base', 'stale attempt uses a fresh requestId');
    const stale = await facade.applyOrderEvent(staleCommand);
    assert.equal(stale.ok, false, 'stale expectedRevision commit must fail closed: ' + JSON.stringify(stale));
    assert.equal(stale.errorCode, 'stale-revision', 'stale commit must keep the stable stale-revision code');
    assert.equal(stale.retryable, false, 'stale commit is not retryable');
    assert.equal(Object.prototype.hasOwnProperty.call(stale, 'value'), false, 'stale failure must not carry a value');
    assert.notEqual(stale.revision, 2, 'stale attempt must not advance the revision');

    // 步骤 6：durable 字节、深度状态、receipt/audit 全部不变。
    assert.equal(sha256File(ws.filePath), digestBeforeStale, 'stale attempt must leave the durable file byte-identical');
    const snapshotAfterStale = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.deepEqual(snapshotAfterStale, snapshotBeforeStale, 'parsed durable snapshot must be deep-equal after the stale attempt');
    assert.equal(snapshotAfterStale.revision, 1, 'revision unchanged by stale attempt');
    assert.deepEqual(snapshotAfterStale.orders, snapshotBeforeStale.orders, 'entity collections unchanged');
    assert.deepEqual(snapshotAfterStale.operationReceipts, snapshotBeforeStale.operationReceipts, 'operationReceipts unchanged');
    assert.deepEqual(snapshotAfterStale.auditEvents, snapshotBeforeStale.auditEvents, 'auditEvents unchanged');
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotAfterStale.operationReceipts, 'op-m4-stale-attempt'), false, 'failed operationId leaves no receipt');
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotAfterStale.orders, 'order-stale-attempt'), false, 'failed operationId leaves no entity record');
    assert.equal(snapshotAfterStale.auditEvents.some((event) => event.operationId === 'op-m4-stale-attempt'), false, 'failed operationId leaves no audit event');
    assert.equal(await facade.getCurrentRevision(), 1, 'in-memory revision authority unchanged after stale attempt');
  } finally {
    await facade.close();
  }

  // 步骤 7：关闭并重新打开真实 facade 后，同一 stale 请求仍必须被拒绝。
  const reopened = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: DEVICE });
  try {
    const digestBeforeRestartStale = sha256File(ws.filePath);
    const snapshotBeforeRestartStale = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));

    const staleAgain = await reopened.applyOrderEvent(orderCommand(0, 'op-m4-stale-attempt', 'order-stale-attempt'));
    assert.equal(staleAgain.ok, false, 'stale attempt after restart must still fail closed: ' + JSON.stringify(staleAgain));
    assert.equal(staleAgain.errorCode, 'stale-revision', 'restart keeps the stable stale-revision code');
    assert.equal(staleAgain.retryable, false);

    assert.equal(sha256File(ws.filePath), digestBeforeRestartStale, 'restart stale attempt must leave the durable file byte-identical');
    const snapshotAfterRestartStale = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.deepEqual(snapshotAfterRestartStale, snapshotBeforeRestartStale, 'restart stale attempt must not change parsed state');
    assert.equal(snapshotAfterRestartStale.revision, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotAfterRestartStale.operationReceipts, 'op-m4-stale-attempt'), false, 'restart stale attempt leaves no receipt');
    assert.equal(await reopened.getCurrentRevision(), 1, 'restart stale attempt does not advance the revision');

    // 步骤 8：重启后的正向控制——当前 revision 的合法提交仍可成功且只前进一个 revision。
    const control = await reopened.applyOrderEvent(orderCommand(1, 'op-m4-stale-control', 'order-stale-control'));
    assert.equal(control.ok, true, 'legitimate commit at the current revision must succeed after restart (guard must not over-block): ' + JSON.stringify(control));
    assert.equal(control.idempotent, false);
    assert.equal(control.revision, 2, 'positive control advances exactly one revision');

    const finalRaw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.equal(finalRaw.revision, 2, 'positive control persisted revision 2');
    assert.ok(finalRaw.orders['order-stale-control'], 'positive control entity persisted');
    assert.ok(finalRaw.operationReceipts['op-m4-stale-control'], 'positive control receipt persisted');
    assert.equal(Object.prototype.hasOwnProperty.call(finalRaw.orders, 'order-stale-attempt'), false, 'stale entity never materialized');
    assert.equal(Object.prototype.hasOwnProperty.call(finalRaw.operationReceipts, 'op-m4-stale-attempt'), false, 'stale receipt never materialized');
    assert.equal(Object.keys(finalRaw.operationReceipts).length, 2, 'only the two successful operations hold receipts');
    assert.equal(finalRaw.auditEvents.length, 2, 'only the two successful operations wrote audit events');
  } finally {
    await reopened.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// ---------- M5 scenarios ----------

async function m5DirectQuoteUnknownModelFailClosed(paths) {
  const durable = requireReal(paths.durablePath);
  const ws = makeDurableWorkspace(1000);
  const svc = await durable.createDurableBillingService({ filePath: ws.filePath, initialState: ws.initialState });
  try {
    const quote = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'definitely-unknown-model' });
    assert.equal(quote.ok, false, 'unknown model quote must fail closed: ' + JSON.stringify(quote));
    assert.equal(quote.errorCode, 'unknown-model', 'unknown model must keep the stable unknown-model code');
    assert.equal(quote.retryable, false);
    assert.equal(Object.prototype.hasOwnProperty.call(quote, 'value'), false, 'failed quote must not carry a price projection');

    const retry = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'definitely-unknown-model' });
    assert.equal(retry.ok, false, 'retry of unknown model quote stays fail-closed');
    assert.equal(retry.errorCode, 'unknown-model');

    const fabricatedZero = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'unknown-model-zero' });
    assert.equal(fabricatedZero.ok, false, 'no fabricated zero-price quote for unknown models');
    assert.equal(fabricatedZero.errorCode, 'unknown-model');
  } finally {
    await svc.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m5DirectReserveUnknownModelNoStateChange(paths) {
  const durable = requireReal(paths.durablePath);
  const ws = makeDurableWorkspace(1000);
  const svc = await durable.createDurableBillingService({ filePath: ws.filePath, initialState: ws.initialState });
  try {
    const before = sha256File(ws.filePath);
    const reserve = await svc.reserveRequestCharge({
      caller: 'synthetic-caller', deviceId: 'synthetic-device',
      operationId: 'op-unknown-reserve', billingMode: 'money-per-request',
      model: 'definitely-unknown-model',
    });
    assert.equal(reserve.ok, false, 'unknown model reserve must fail closed: ' + JSON.stringify(reserve));
    assert.equal(reserve.errorCode, 'unknown-model');
    assert.equal(reserve.retryable, false);

    assert.equal(sha256File(ws.filePath), before, 'failed reserve must leave the durable envelope byte-identical');
    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.equal(raw.revision, 0, 'no revision advance for unknown model');
    assert.equal(raw.balanceMinor, 1000, 'balance untouched');
    assert.equal(raw.reservedMinor, 0, 'no reservation for unknown model');
    assert.deepEqual(raw.requestCharges, {}, 'no charge record for unknown model');
    assert.deepEqual(raw.operationReceipts, {}, 'no receipt for a failed reserve');
    assert.deepEqual(raw.auditEvents, [], 'no audit event for a failed reserve');

    const retry = await svc.reserveRequestCharge({
      caller: 'synthetic-caller', deviceId: 'synthetic-device',
      operationId: 'op-unknown-reserve', billingMode: 'money-per-request',
      model: 'definitely-unknown-model',
    });
    assert.equal(retry.ok, false, 'retry stays fail-closed');
    assert.equal(retry.errorCode, 'unknown-model');
    assert.equal(sha256File(ws.filePath), before, 'retry still writes nothing');
  } finally {
    await svc.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m5DirectQuoteKnownPositiveAndInactiveDistinct(paths) {
  const durable = requireReal(paths.durablePath);
  const ws = makeDurableWorkspace(1000);
  const svc = await durable.createDurableBillingService({ filePath: ws.filePath, initialState: ws.initialState });
  try {
    const known = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'model-alpha' });
    assert.equal(known.ok, true, 'known active model quote succeeds (guard must not over-block): ' + JSON.stringify(known));
    assert.equal(known.value.model, 'model-alpha');
    assert.equal(known.value.priceMinor, 100);
    assert.equal(known.value.currency, 'CNY');
    assert.equal(known.value.catalogRevision, 1);
    assert.equal(known.value.billingMode, 'money-per-request');

    const inactive = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'model-inactive' });
    assert.equal(inactive.ok, false, 'known-but-inactive model is a distinct failure');
    assert.equal(inactive.errorCode, 'model-not-active', 'inactive model must NOT be reported as unknown-model');
    assert.equal(inactive.retryable, false);
  } finally {
    await svc.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m5DirectReserveKnownReplayAndUnknownAfter(paths) {
  const durable = requireReal(paths.durablePath);
  const ws = makeDurableWorkspace(1000);
  const svc = await durable.createDurableBillingService({ filePath: ws.filePath, initialState: ws.initialState });
  try {
    const reserve = await svc.reserveRequestCharge({
      caller: 'synthetic-caller', deviceId: 'synthetic-device',
      operationId: 'op-known-reserve', billingMode: 'money-per-request',
      model: 'model-alpha', expectedRevision: 0,
    });
    assert.equal(reserve.ok, true, 'known model reserve succeeds: ' + JSON.stringify(reserve));
    assert.equal(reserve.idempotent, false);
    assert.equal(reserve.revision, 1);
    assert.equal(reserve.value.chargeStatus, 'reserved');
    assert.equal(reserve.value.priceMinor, 100);
    assert.equal(reserve.value.remainingBalanceMinor, 1000);
    assert.equal(reserve.value.availableBalanceMinor, 900);

    const replay = await svc.reserveRequestCharge({
      caller: 'synthetic-caller', deviceId: 'synthetic-device',
      operationId: 'op-known-reserve', billingMode: 'money-per-request',
      model: 'model-alpha', expectedRevision: 0,
    });
    assert.equal(replay.ok, true, 'reserve replay resolves: ' + JSON.stringify(replay));
    assert.equal(replay.idempotent, true, 'reserve replay is idempotent');
    assert.deepEqual(replay.value, reserve.value, 'reserve replay returns the original projection');

    const unknownAfter = await svc.reserveRequestCharge({
      caller: 'synthetic-caller', deviceId: 'synthetic-device',
      operationId: 'op-unknown-after', billingMode: 'money-per-request',
      model: 'definitely-unknown-model',
    });
    assert.equal(unknownAfter.ok, false, 'unknown model reserve after a successful reserve still fails closed');
    assert.equal(unknownAfter.errorCode, 'unknown-model');

    const balance = await svc.getAccountBalance({ caller: 'synthetic-caller' });
    assert.equal(balance.ok, true);
    assert.equal(balance.value.remainingBalanceMinor, 1000, 'money balance only moves on settle');
    assert.equal(balance.value.availableBalanceMinor, 900, 'reservation held');
    assert.equal(balance.value.revision, 1, 'unknown-model attempt added no revision');

    const raw = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
    assert.deepEqual(Object.keys(raw.operationReceipts), ['op-known-reserve'], 'only the successful reserve wrote a receipt');
    assert.deepEqual(Object.keys(raw.requestCharges), ['req-op-known-reserve'], 'no charge record for the unknown model');
  } finally {
    await svc.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

async function m5InMemoryCoreUnknownModelGuards(paths) {
  const core = requireReal(paths.corePath);
  const svc = core.createBillingService(makeLegacyEnvelope(1000));

  const quote = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'definitely-unknown-model' });
  assert.equal(quote.ok, false, 'in-memory core quote must fail closed for unknown model');
  assert.equal(quote.errorCode, 'unknown-model');
  assert.equal(quote.retryable, false);

  const reserve = await svc.reserveRequestCharge({
    caller: 'synthetic-caller', deviceId: 'synthetic-device',
    operationId: 'op-core-unknown', billingMode: 'money-per-request',
    model: 'definitely-unknown-model',
  });
  assert.equal(reserve.ok, false, 'in-memory core reserve must fail closed for unknown model');
  assert.equal(reserve.errorCode, 'unknown-model');
  assert.equal(reserve.retryable, false);

  const envelope = svc._getEnvelope();
  assert.equal(envelope.revision, 0, 'unknown-model attempts mutate nothing');
  assert.equal(envelope.reservedMinor, 0);
  assert.deepEqual(envelope.operationReceipts, {});
  assert.deepEqual(envelope.requestCharges, {});
  assert.deepEqual(envelope.auditEvents, []);

  const positive = await svc.quoteRequestCharge({ caller: 'synthetic-caller', model: 'model-alpha' });
  assert.equal(positive.ok, true, 'known model still quotable on the same core service');
  assert.equal(positive.value.priceMinor, 100);
}

const ALL_SCENARIOS = [
  ['m4OrderCommitWritesReceiptAndAudit', m4OrderCommitWritesReceiptAndAudit],
  ['m4OrderReplayIdempotentSameRevisionNoStateChange', m4OrderReplayIdempotentSameRevisionNoStateChange],
  ['m4OrderReplayAfterRestartStillIdempotent', m4OrderReplayAfterRestartStillIdempotent],
  ['m4ConcurrentSameOperationCommitsOnce', m4ConcurrentSameOperationCommitsOnce],
  ['m4SubscriptionChannelReceiptAndReplay', m4SubscriptionChannelReceiptAndReplay],
  ['m4StaleExpectedRevisionRejectedDurableUnchangedAcrossRestart', m4StaleExpectedRevisionRejectedDurableUnchangedAcrossRestart],
  ['m5DirectQuoteUnknownModelFailClosed', m5DirectQuoteUnknownModelFailClosed],
  ['m5DirectReserveUnknownModelNoStateChange', m5DirectReserveUnknownModelNoStateChange],
  ['m5DirectQuoteKnownPositiveAndInactiveDistinct', m5DirectQuoteKnownPositiveAndInactiveDistinct],
  ['m5DirectReserveKnownReplayAndUnknownAfter', m5DirectReserveKnownReplayAndUnknownAfter],
  ['m5InMemoryCoreUnknownModelGuards', m5InMemoryCoreUnknownModelGuards],
];

function defaultPaths() {
  return { facadePath: REAL_FACADE, durablePath: REAL_DURABLE, corePath: REAL_CORE };
}

// 加载 paths 处的 REAL 模块副本并运行全部场景；返回 [{name, pass, error, ms}]。
// 不调用 process.exit，供 run-adversarial.js 反向变异复用。
async function runM4M5Suite(paths) {
  const resolved = Object.assign({}, defaultPaths(), paths || {});
  assert.ok(fs.existsSync(resolved.facadePath), 'facade module must exist: ' + resolved.facadePath);
  assert.ok(fs.existsSync(resolved.durablePath), 'durable module must exist: ' + resolved.durablePath);
  assert.ok(fs.existsSync(resolved.corePath), 'core module must exist: ' + resolved.corePath);
  const results = [];
  for (const [name, fn] of ALL_SCENARIOS) {
    const started = Date.now();
    try {
      await fn(resolved);
      results.push({ name, pass: true, ms: Date.now() - started });
    } catch (error) {
      results.push({ name, pass: false, error: (error && error.message) || String(error), ms: Date.now() - started });
    }
  }
  return results;
}

if (require.main === module) {
  const test = require('node:test');

  test('real entry path binding (no mock/proxy false-green)', () => {
    for (const entry of [REAL_FACADE, REAL_DURABLE, REAL_CORE]) {
      assert.ok(fs.existsSync(entry), entry + ' must exist');
      assert.equal(require.resolve(entry), entry, 'require must resolve to the production file itself');
    }
  });

  for (const [name, fn] of ALL_SCENARIOS) {
    test(name + ' (REAL production modules)', async () => {
      await fn(defaultPaths());
    });
  }
}

if (require.main === module && process.env.XJ_M4M5_SUITE_DIRECT === '1') {
  runM4M5Suite(defaultPaths()).then((results) => {
    let fails = 0;
    for (const item of results) {
      console.log((item.pass ? 'PASS ' : 'FAIL ') + item.name + (item.pass ? '' : ' :: ' + item.error));
      if (!item.pass) fails += 1;
    }
    console.log(fails === 0 ? 'ALL PASS (' + results.length + ' scenarios)' : fails + ' FAILURES / ' + results.length);
    process.exitCode = fails === 0 ? 0 : 1;
  }).catch((error) => {
    console.error('SUITE ERROR: ' + ((error && error.stack) || error));
    process.exitCode = 2;
  });
}

module.exports = { runM4M5Suite, ALL_SCENARIOS, REAL_FACADE, REAL_DURABLE, REAL_CORE };
