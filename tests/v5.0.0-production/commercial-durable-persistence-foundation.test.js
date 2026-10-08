'use strict';
// XJ-5.0.0 商业持久化运行时基础闭环。
// 从 app/js 加载真实模块，覆盖 v3 计费契约的 durable adapter + billing service。
// 全部使用合成账号/模型/请求与 os.tmpdir() 临时目录。
// 本测试使用合成商业元数据和临时目录，不触碰真实账户或临床数据。
// 关键故障注入点：
//   1) 故障注入前用普通 fs 预创建初始状态文件，故障只命中 write() 的 atomicReplace 阶段；
//   2) readback 篡改改为在 rename 之后修改 balanceMinor（保持 envelope 结构合法、仅内容不同），
//      精确命中写后 readback → readback-mismatch；
//   3) 故障注入走 service 真实入口（reserve 等方法）而非裸 adapter 内部路径；
//   4) 增加候选增强点验证：requestCharges 未知字段、receipt payload/result 数组拒绝；
//   5) 增加关闭后拒绝、insufficient-balance、mark-unknown/reconcile、敏感字段拒绝。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const child = require('child_process');
const {
  createDurableBillingService,
  createFilesystemPersistenceAdapter,
  validateEnvelope,
  digest
} = require('../../app/js/commercial-durable-persistence');
const { canonicalHash } = require('../../app/js/commercial-billing-core');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-durable-'));
const filePath = path.join(root, 'state.json');
const initialState = {
  schemaVersion: 1, revision: 0, balanceMinor: 1000, reservedMinor: 0,
  quotaWallets: { synthetic: { remaining: 2 } }, requestCharges: {}, operationReceipts: {},
  auditEvents: [], updatedAt: new Date().toISOString()
};
let assertions = 0;
function check(value, message) { assertions += 1; assert(value, message); }
function failResult(result, code) {
  check(result && result.ok === false && result.errorCode === code && result.retryable === false,
    'expected ' + code + ' got ' + JSON.stringify(result));
}
function moneyInput(operationId, expectedRevision) {
  return { caller: 'synthetic-caller', deviceId: 'synthetic-device', model: 'model-alpha', operationId, billingMode: 'money-per-request', expectedRevision };
}
function quotaInput(operationId, expectedRevision) {
  return { caller: 'synthetic-caller', deviceId: 'synthetic-device', operationId, billingMode: 'request-count-quota', quotaWalletId: 'synthetic', expectedRevision };
}

// 修复版故障注入 fs：故障只命中 write() 阶段。
// - write: open(tempPath) 抛错（文件预创建，open() 阶段不触发）
// - rename: rename 抛错
// - fsync: 句柄 sync 抛错
// - read: readFile 抛错（open 阶段即失败）
// - readback: rename 成功后的写后 readFile 篡改 balanceMinor（结构合法、内容不同）
function makeFaultFs(kind) {
  const base = fs.promises;
  const wrapped = Object.create(base);
  let renameCount = 0;
  wrapped.open = async function () {
    if (kind === 'write') throw new Error('write');
    const handle = await base.open.apply(base, arguments);
    if (kind === 'fsync') handle.sync = async function () { throw new Error('fsync'); };
    return handle;
  };
  wrapped.rename = async function () {
    if (kind === 'rename') throw new Error('rename');
    renameCount += 1;
    return base.rename.apply(base, arguments);
  };
  wrapped.readFile = async function () {
    if (kind === 'read') throw new Error('read');
    const value = await base.readFile.apply(base, arguments);
    if (kind === 'readback' && renameCount >= 1) {
      return value.replace('"balanceMinor":1000', '"balanceMinor":999');
    }
    return value;
  };
  return { promises: wrapped };
}

// Uses the real filesystem but fails if two writes from one adapter overlap.
// The guard is armed only after open(), so it does not inspect initialization.
function makeAdapterConcurrencyFs(targetPath) {
  const base = fs.promises;
  const wrapped = Object.create(base);
  let armed = false;
  let activeWrites = 0;
  wrapped.arm = function () { armed = true; };
  wrapped.open = async function () {
    const candidate = String(arguments[0]);
    if (armed && candidate.includes('.tmp-')) {
      if (activeWrites > 0) throw new Error('adapter-write-overlap');
      activeWrites += 1;
    }
    return base.open.apply(base, arguments);
  };
  wrapped.readFile = async function () {
    const value = await base.readFile.apply(base, arguments);
    if (armed && String(arguments[0]) === targetPath && activeWrites > 0) activeWrites -= 1;
    return value;
  };
  return { promises: wrapped, arm: wrapped.arm };
}

(async function main() {
  try {
    // ---- 1. 生命周期：初始创建 → reserve → 幂等 replay → conflict → 配额 → byok/trial → 重启 ----
    const first = await createDurableBillingService({ filePath, initialState });
    const balance0 = await first.getAccountBalance({ caller: 'synthetic-caller' });
    check(balance0.ok && balance0.value.currency === 'CNY' && balance0.value.remainingBalanceMinor === 1000 &&
      balance0.value.availableBalanceMinor === 1000 && balance0.revision === 0, 'initialization ' + JSON.stringify(balance0));

    const reserve = await first.reserveRequestCharge(moneyInput('op-reserve', 0));
    check(reserve.ok && reserve.revision === 1 && reserve.value.chargeStatus === 'reserved' &&
      reserve.value.priceMinor === 100 && reserve.value.chargedMinor === null &&
      reserve.value.remainingBalanceMinor === 1000 && reserve.value.availableBalanceMinor === 900 &&
      reserve.value.currency === 'CNY' && reserve.idempotent === false, 'reserve arithmetic ' + JSON.stringify(reserve));

    const replay = await first.reserveRequestCharge(moneyInput('op-reserve', 0));
    check(replay.ok && replay.idempotent === true && replay.revision === 1 &&
      replay.value.availableBalanceMinor === 900, 'idempotent replay ' + JSON.stringify(replay));

    const conflict = await first.reserveRequestCharge({ ...moneyInput('op-reserve', 1), model: 'model-beta' });
    failResult(conflict, 'operation-conflict');

    const revisionConflict = await first.reserveRequestCharge({ ...moneyInput('op-reserve', 99), model: 'model-alpha' });
    failResult(revisionConflict, 'operation-conflict');

    const staleEarly = await first.reserveRequestCharge(moneyInput('op-stale-early', 5));
    failResult(staleEarly, 'stale-revision');

    const quota = await first.processNonMoneyRequest(quotaInput('op-quota', 1));
    check(quota.ok && quota.revision === 2 && quota.value.billingMode === 'request-count-quota' &&
      quota.value.chargeStatus === 'not-applicable' && quota.value.quotaRemaining === 1 &&
      quota.value.chargedMinor === null && quota.value.priceMinor === null &&
      quota.value.currency === null && quota.value.catalogRevision === null &&
      quota.value.remainingBalanceMinor === null && quota.value.availableBalanceMinor === null,
      'quota shared revision + exact non-money projection ' + JSON.stringify(quota));

    const byok = await first.processNonMoneyRequest({ caller: 'synthetic-caller', deviceId: 'synthetic-device', operationId: 'op-byok', billingMode: 'byok', expectedRevision: 2 });
    check(byok.ok && byok.revision === 3 && byok.value.billingMode === 'byok' && byok.value.quotaRemaining === undefined, 'byok no money/quota ' + JSON.stringify(byok));

    const trial = await first.processNonMoneyRequest({ caller: 'synthetic-caller', deviceId: 'synthetic-device', operationId: 'op-trial', billingMode: 'trial', expectedRevision: 3 });
    check(trial.ok && trial.revision === 4 && trial.value.billingMode === 'trial', 'trial no money/quota ' + JSON.stringify(trial));

    check((await first.getAccountBalance({ caller: 'synthetic-caller' })).value.remainingBalanceMinor === 1000, 'quota/byok/trial never touch money');
    await first.close();

    // ---- 2. 真实重启：新进程实例从文件读回同一 revision ----
    const second = await createDurableBillingService({ filePath });
    const restartBalance = await second.getAccountBalance({ caller: 'synthetic-caller' });
    check(restartBalance.ok && restartBalance.revision === 4 && restartBalance.value.availableBalanceMinor === 900, 'real restart ' + JSON.stringify(restartBalance));

    const settle = await second.settleRequestCharge({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-reserve', operationId: 'op-settle', expectedRevision: 4 });
    check(settle.ok && settle.value.chargedMinor === 100 && settle.value.chargeStatus === 'settled' &&
      settle.value.remainingBalanceMinor === 900 && settle.value.availableBalanceMinor === 900 && settle.revision === 5,
      'settle arithmetic ' + JSON.stringify(settle));

    const staleSettle = await second.releaseRequestCharge({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-reserve', operationId: 'op-stale', expectedRevision: 4 });
    failResult(staleSettle, 'invalid-state');
    await second.close();

    // ---- 3. CAS 并发：两实例同 revision 写，第二写入 stale-revision ----
    const staleA = await createDurableBillingService({ filePath });
    const staleB = await createDurableBillingService({ filePath });
    const a = await staleA.processNonMoneyRequest(quotaInput('op-stale-a', 5));
    check(a.ok && a.revision === 6, 'first CAS writer ' + JSON.stringify(a));
    const b = await staleB.processNonMoneyRequest(quotaInput('op-stale-b', 5));
    failResult(b, 'stale-revision');
    await staleA.close(); await staleB.close();

    // ---- 3b. 同实例 adapter 直写并发必须由 adapter queue 串行化 ----
    const adapterFile = path.join(root, 'adapter-concurrent.json');
    fs.writeFileSync(adapterFile, JSON.stringify(initialState));
    const concurrencyFs = makeAdapterConcurrencyFs(adapterFile);
    const adapter = createFilesystemPersistenceAdapter({ filePath: adapterFile, fs: concurrencyFs });
    await adapter.open();
    concurrencyFs.arm();
    const adapterRevision1 = JSON.parse(JSON.stringify(initialState));
    adapterRevision1.revision = 1;
    const adapterRevision2 = JSON.parse(JSON.stringify(initialState));
    adapterRevision2.revision = 2;
    const adapterWrites = await Promise.all([
      adapter.write(adapterRevision1).then(() => null, error => error),
      adapter.write(adapterRevision2).then(() => null, error => error)
    ]);
    check(adapterWrites[0] === null && adapterWrites[1] === null,
      'same-instance adapter writes are serialized ' + JSON.stringify(adapterWrites));
    await adapter.close();
    const adapterRestart = createFilesystemPersistenceAdapter({ filePath: adapterFile });
    await adapterRestart.open();
    const adapterFinal = await adapterRestart.read();
    check(adapterFinal.revision === 2, 'same-instance adapter restart revision ' + JSON.stringify(adapterFinal));
    await adapterRestart.close();

    // ---- 4. 损坏/未知字段 envelope 全部 fail-closed（durable-read-failed）----
    const original = fs.readFileSync(filePath, 'utf8');
    const corrupted = [
      ['truncated', original.slice(0, 10)],
      ['top-level unknown', original.replace(/}\s*$/, ',"unknown":1}')],
      ['not json', '{not-json'],
      ['charge extra field', original.replace('"status":"settled"', '"status":"settled","secretPrompt":"x"')],
      ['receipt payload array', original.replace('"payload":{"caller"', '"payload":[{"caller"')],
      ['quota wallet extra field', original.replace('"remaining":0', '"remaining":0,"tier":"gold"')],
      ['reserved > balance', original.replace('"balanceMinor":900', '"balanceMinor":100').replace('"reservedMinor":0', '"reservedMinor":200')],
      ['negative revision', original.replace('"revision":6', '"revision":-1')],
      ['audit unredacted', original.replace('"redacted":true', '"redacted":false')]
    ];
    for (const [name, bad] of corrupted) {
      fs.writeFileSync(filePath, bad);
      const rejected = await createDurableBillingService({ filePath }).catch(error => error);
      check(rejected && rejected.errorCode === 'durable-read-failed', name + ' rejection got ' + (rejected && rejected.errorCode));
      fs.writeFileSync(filePath, original);
    }

    // ---- 5. 故障注入（修复时序后）：真实 service 入口 + 状态未变 ----
    const failures = ['write', 'rename', 'read', 'fsync', 'readback'];
    for (const kind of failures) {
      const faultFile = path.join(root, kind + '.json');
      fs.writeFileSync(faultFile, JSON.stringify(initialState)); // 预创建：故障只命中 write 阶段
      const faultFs = makeFaultFs(kind);
      let fault;
      if (kind === 'read') {
        fault = await createDurableBillingService({ filePath: faultFile, fs: faultFs }).then(() => null, e => e);
      } else {
        const svc = await createDurableBillingService({ filePath: faultFile, fs: faultFs });
        fault = await svc.reserveRequestCharge(moneyInput('op-fault-' + kind, 0));
        await svc.close();
      }
      const expected = kind === 'read' ? 'durable-read-failed' : kind === 'readback' ? 'readback-mismatch' : 'durable-write-failed';
      check(fault && fault.errorCode === expected, kind + ' injection expected ' + expected + ' got ' + JSON.stringify(fault));
      // 故障后状态未变：真实重启读盘仍为 revision 0 / balance 1000
      const revived = await createDurableBillingService({ filePath: faultFile });
      const afterFault = await revived.getAccountBalance({ caller: 'synthetic-caller' });
      check(afterFault.ok && afterFault.revision === 0 && afterFault.value.remainingBalanceMinor === 1000, kind + ' state unchanged after failure');
      await revived.close();
    }

    // ---- 6. 关闭后拒绝（adapter 层面）+ temp 清理 ----
    const closedFile = path.join(root, 'closed.json');
    fs.writeFileSync(closedFile, JSON.stringify(initialState));
    const closedAdapter = createFilesystemPersistenceAdapter({ filePath: closedFile });
    await closedAdapter.open();
    await closedAdapter.close();
    const closedRead = await closedAdapter.read().then(() => null, e => e);
    check(closedRead && closedRead.errorCode === 'durable-read-failed', 'adapter read after close');
    const closedWrite = await closedAdapter.write({ ...JSON.parse(JSON.stringify(initialState)), revision: 1 }).then(() => null, e => e);
    check(closedWrite && closedWrite.errorCode === 'durable-write-failed', 'adapter write after close');
    const closedOpen = await closedAdapter.open().then(() => null, e => e);
    check(closedOpen && closedOpen.errorCode === 'durable-read-failed', 'adapter open after close');

    // 文件缺失且无 initialState → fail-closed durable-read-failed
    const missingFile = path.join(root, 'missing-no-initial.json');
    const missingErr = await createDurableBillingService({ filePath: missingFile }).then(() => null, e => e);
    check(missingErr && missingErr.errorCode === 'durable-read-failed', 'missing file without initialState fails closed');

    check(!fs.readdirSync(root).some(name => name.includes('.tmp-') || name.includes('.rb-')), 'temporary file cleanup');

    // ---- 7. insufficient-balance：money 通道余额不足 fail-closed ----
    const poorFile = path.join(root, 'poor.json');
    const poorInitial = { ...JSON.parse(JSON.stringify(initialState)), balanceMinor: 50, quotaWallets: {} };
    const poor = await createDurableBillingService({ filePath: poorFile, initialState: poorInitial });
    const poorReserve = await poor.reserveRequestCharge(moneyInput('op-poor', 0));
    failResult(poorReserve, 'insufficient-balance');
    await poor.close();

    // ---- 8. mark-unknown / reconcile 路径（money 语义表第 5 行）----
    const recFile = path.join(root, 'reconcile.json');
    const rec = await createDurableBillingService({ filePath: recFile, initialState: JSON.parse(JSON.stringify(initialState)) });
    const r1 = await rec.reserveRequestCharge(moneyInput('op-rec-reserve', 0));
    check(r1.ok && r1.revision === 1, 'reconcile reserve');
    const r2 = await rec.markRequestUnknown({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-rec-reserve', operationId: 'op-rec-unknown', expectedRevision: 1 });
    check(r2.ok && r2.value.chargeStatus === 'pending-reconciliation' && r2.revision === 2, 'mark unknown ' + JSON.stringify(r2));
    const rBad = await rec.reconcileRequestCharge({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-rec-reserve', operationId: 'op-rec-bad-evidence', expectedRevision: 2, evidence: { trusted: false }, outcome: 'released' });
    failResult(rBad, 'invalid-evidence');
    const r3 = await rec.reconcileRequestCharge({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-rec-reserve', operationId: 'op-rec-settle', expectedRevision: 2, evidence: { trusted: true }, outcome: 'settled' });
    check(r3.ok && r3.value.chargedMinor === 100 && r3.revision === 3 && r3.value.remainingBalanceMinor === 900, 'reconcile settled ' + JSON.stringify(r3));
    const r5 = await rec.reconcileRequestCharge({ caller: 'synthetic-caller', deviceId: 'synthetic-device', requestId: 'req-op-rec-reserve', operationId: 'op-rec-reserved', expectedRevision: 3, evidence: { trusted: true }, outcome: 'settled' });
    failResult(r5, 'invalid-state'); // 已 settled，不能再 reconcile
    await rec.close();

    // ---- 9. 敏感字段拒绝：任何含敏感键的输入 fail-closed ----
    const sensFile = path.join(root, 'sensitive.json');
    const sens = await createDurableBillingService({ filePath: sensFile, initialState: JSON.parse(JSON.stringify(initialState)) });
    const sensReserve = await sens.reserveRequestCharge({ ...moneyInput('op-sens', 0), providerPayload: { prompt: 'x' } });
    failResult(sensReserve, 'sensitive-field-rejected');
    const sensBalance = await sens.getAccountBalance({ caller: 'synthetic-caller', apiKey: 'secret' });
    failResult(sensBalance, 'sensitive-field-rejected');
    await sens.close();

    // ---- 10. 真实模块入口复查：独立进程加载生产基础模块 ----
    const review = path.join(root, 'review.js');
    fs.writeFileSync(review, 'const m = require(' + JSON.stringify(path.join(__dirname, '..', '..', 'app', 'js', 'commercial-durable-persistence.js')) + '); if (!m.createDurableBillingService || !m.createFilesystemPersistenceAdapter || !m.validateEnvelope || !m.digest) process.exit(1);\n');
    child.execFileSync(process.execPath, [review], { stdio: 'pipe' });
    check(true, 'real production foundation module review');

    // ---- 11. validateEnvelope/digest 导出行为 ----
    check(validateEnvelope(JSON.parse(JSON.stringify(initialState))) !== null, 'validateEnvelope accepts initial');
    check(typeof digest(initialState) === 'string' && digest(initialState).length === 64, 'digest sha256 hex');
    check(canonicalHash({ b: 2, a: 1 }) === canonicalHash({ a: 1, b: 2 }) &&
      canonicalHash({ a: 1 }) !== canonicalHash({ a: 1, expectedRevision: 0 }) &&
      canonicalHash(initialState).length === 64, 'canonical request hash is complete and stable');

    console.log('PASS assertions=' + assertions + ' faultKinds=' + failures.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
