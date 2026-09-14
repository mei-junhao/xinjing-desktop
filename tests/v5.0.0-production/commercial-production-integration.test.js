'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCommercialFacade, initialEnvelope } = require('../../app/js/commercial-ipc-facade.js');
const entitlements = require('../../app/js/entitlements.js');

function makeWorkspace(balanceMinor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-commercial-production-'));
  const filePath = path.join(root, 'commercial-envelope-v3.json');
  const state = initialEnvelope();
  state.balanceMinor = balanceMinor;
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  return { root, filePath };
}

async function closeAndRemove(facades, root) {
  for (const facade of facades) {
    if (facade) await facade.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test('production facade fails closed on the official empty catalog and leaves durable state unchanged', async () => {
  const workspace = makeWorkspace(100);
  const facades = [];
  try {
    const facade = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-a' });
    facades.push(facade);
    // 官方目录为空（v5.0-commercial-server-authoritative-balance-v1 §4）。
    const catalog = await facade.getModelPriceCatalog({});
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.value, {});
    assert.equal(catalog.revision, null);

    // quote/reserve 稳定 catalog-unavailable，不返回任何价格。
    const quote = await facade.quoteRequestCharge({ model: 'model-alpha' });
    assert.equal(quote.ok, false);
    assert.equal(quote.errorCode, 'catalog-unavailable');
    assert.equal(quote.retryable, false);

    const reserved = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-1' });
    assert.equal(reserved.ok, false);
    assert.equal(reserved.errorCode, 'catalog-unavailable');
    assert.equal(reserved.retryable, false);

    // 失败闭合：信封资源全部不变。
    const raw = JSON.parse(fs.readFileSync(workspace.filePath, 'utf8'));
    assert.equal(raw.revision, 0);
    assert.equal(raw.balanceMinor, 100);
    assert.equal(raw.reservedMinor, 0);
    assert.deepEqual(raw.requestCharges, {});
    assert.deepEqual(raw.operationReceipts, {});
    assert.deepEqual(raw.auditEvents, []);

    // 余额投影仍可读，绑定未变的 revision。
    const balance = await facade.getAccountBalance({});
    assert.equal(balance.ok, true);
    assert.deepEqual(balance.value, {
      currency: 'CNY', remainingBalanceMinor: 100, availableBalanceMinor: 100, revision: 0,
    });

    // 重启路径：重新打开后金钱状态仍未变，quote 仍 fail-closed。
    const reopened = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-a' });
    facades.push(reopened);
    const balance2 = await reopened.getAccountBalance({});
    assert.equal(balance2.ok, true);
    assert.equal(balance2.value.revision, 0);
    const quote2 = await reopened.quoteRequestCharge({ model: 'model-alpha' });
    assert.equal(quote2.ok, false);
    assert.equal(quote2.errorCode, 'catalog-unavailable');
  } finally {
    await closeAndRemove(facades, workspace.root);
  }
});

test('non-money requests never fabricate a charge and replay keeps its original revision', async () => {
  const workspace = makeWorkspace(100);
  const facades = [];
  try {
    const facade = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-b' });
    facades.push(facade);
    const trial = await facade.processNonMoneyRequest({ billingMode: 'trial', operationId: 'trial-1' });
    assert.equal(trial.ok, true);
    assert.deepEqual(trial.value, {
      billingMode: 'trial', chargeStatus: 'not-applicable', chargedMinor: null,
      priceMinor: null, currency: null, catalogRevision: null,
      remainingBalanceMinor: null, availableBalanceMinor: null,
    });
    assert.equal(trial.revision, 1);

    const byok = await facade.processNonMoneyRequest({ billingMode: 'byok', operationId: 'byok-1' });
    assert.equal(byok.ok, true);
    assert.equal(byok.revision, 2);
    const replay = await facade.processNonMoneyRequest({ billingMode: 'trial', operationId: 'trial-1' });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.revision, 1);

    const raw = JSON.parse(fs.readFileSync(workspace.filePath, 'utf8'));
    assert.equal(raw.balanceMinor, 100);
    assert.equal(raw.reservedMinor, 0);
    assert.deepEqual(raw.requestCharges, {});
    assert.equal(Object.keys(raw.operationReceipts).length, 2);
  } finally {
    await closeAndRemove(facades, workspace.root);
  }
});

test('main-owned validation rejects renderer field injection, empty-catalog fail-closed and stale account reads', async () => {
  const workspace = makeWorkspace(0);
  const facades = [];
  try {
    const facade = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-c' });
    facades.push(facade);
    const sensitive = await facade.processNonMoneyRequest({ billingMode: 'trial', operationId: 'trial-2', prompt: 'synthetic clinical text' });
    assert.equal(sensitive.ok, false);
    assert.equal(sensitive.errorCode, 'sensitive-field-rejected');
    const forgedMode = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-2', billingMode: 'trial' });
    assert.equal(forgedMode.ok, false);
    assert.equal(forgedMode.errorCode, 'invalid-request');
    // 空官方目录：reserve 在余额判断之前就稳定失败，且信封不变。
    const unavailable = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-3' });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.errorCode, 'catalog-unavailable');
    assert.equal(unavailable.retryable, false);
    const raw = JSON.parse(fs.readFileSync(workspace.filePath, 'utf8'));
    assert.equal(raw.revision, 0);
    assert.equal(raw.balanceMinor, 0);
    assert.equal(raw.reservedMinor, 0);
    assert.deepEqual(raw.requestCharges, {});
    assert.deepEqual(raw.operationReceipts, {});
    assert.deepEqual(raw.auditEvents, []);
    const stale = await facade.getAccountBalance({ expectedRevision: 99 });
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, 'stale-revision');
  } finally {
    await closeAndRemove(facades, workspace.root);
  }
});

test('two facade instances fail closed instead of overwriting the same revision', async () => {
  const workspace = makeWorkspace(0);
  const facades = [];
  try {
    const first = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-d1' });
    const second = await createCommercialFacade({ filePath: workspace.filePath, deviceId: 'synthetic-device-d2' });
    facades.push(first, second);
    const results = await Promise.all([
      first.processNonMoneyRequest({ billingMode: 'trial', operationId: 'concurrent-1' }),
      second.processNonMoneyRequest({ billingMode: 'trial', operationId: 'concurrent-2' }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.errorCode === 'stale-revision').length, 1);
    const state = JSON.parse(fs.readFileSync(workspace.filePath, 'utf8'));
    assert.equal(state.revision, 1);
    assert.equal(Object.keys(state.operationReceipts).length, 1);
  } finally {
    await closeAndRemove(facades, workspace.root);
  }
});

test('renderer helpers accept only the redacted commercial projection', () => {
  const safe = entitlements.normalizeCommercialProjection({
    billing: { billingMode: 'trial', chargeStatus: 'not-applicable' },
    revision: 3,
  });
  assert.equal(safe.revision, 3);
  assert.equal(entitlements.normalizeCommercialProjection({
    billing: { billingMode: 'trial', chargeStatus: 'not-applicable', prompt: 'blocked' },
    revision: 3,
  }), null);
  assert.equal(entitlements.normalizeCommercialProjection({ billing: { billingMode: 'money-per-request' } }), null);
});
