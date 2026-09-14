'use strict';
// XJ-5.0.0-cli-reasonix-v5-commercial-empty-price-fail-closed-candidate-251
// 官方空价格目录 fail-closed 行为套件（真实模块 + 真实临时文件，无 mock）。
//
// 契约依据：
//   v5.0-commercial-server-authoritative-balance-v1 §4/§5 —— 管理员服务器目录
//   可用之前，官方目录为空（{ ok:true, value:{}, revision:null, idempotent:false }），
//   生产 facade 的 quote/reserve 必须稳定失败为 catalog-unavailable；不得伪造
//   零价格、不得回退 trial/BYOK/quota，且 revision、balanceMinor、reservedMinor、
//   requestCharges、operationReceipts、auditEvents 全部保持不变。
//
// 每个断言只使用可观察行为与持久化状态：
//   - 返回投影（{ok, value, revision, idempotent} / {ok:false, errorCode, retryable}）
//   - 磁盘信封文件（SHA-256 digest 与解析后的字段）
//   - 重启后重新打开的 facade 读到的状态
// 无源码字符串检查、无替换真实入口的 mock。
//
// runFailClosedSuite(facadeModulePath) 加载 REAL facade 模块（候选或反向变异
// 临时副本）并运行全套；直接执行时针对候选 facade 运行，失败即非零退出。

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

var CANDIDATE_FACADE = path.join(__dirname, '..', '..', 'app', 'js', 'commercial-ipc-facade.js');

function makeWorkspace(balanceMinor) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-empty-catalog-'));
  var filePath = path.join(root, 'commercial-envelope-v3.json');
  var state = {
    schemaVersion: 1, revision: 0, balanceMinor: balanceMinor, reservedMinor: 0,
    quotaWallets: {}, requestCharges: {}, operationReceipts: {},
    auditEvents: [], updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  return { root: root, filePath: filePath };
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function failResult(result, code, message) {
  assert.strictEqual(result.ok, false, (message || '') + ': expected ok:false, got ' + JSON.stringify(result));
  assert.strictEqual(result.errorCode, code, (message || '') + ': expected errorCode ' + code + ', got ' + JSON.stringify(result));
  assert.strictEqual(result.retryable, false, (message || '') + ': retryable must be false');
}

// --- 官方目录必须是空 map；不能出现 fixture 模型或任何零价格 ---
async function t_catalogEmpty(facadeModulePath) {
  var ws = makeWorkspace(1000);
  try {
    var mod = require(facadeModulePath);
    var facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-empty-cat' });
    try {
      var catalog = await facade.getModelPriceCatalog({});
      assert.strictEqual(catalog.ok, true, 'catalog must be ok:true');
      assert.deepStrictEqual(catalog.value, {}, 'official catalog must be the empty map (no fixture model, no fake zero price)');
      assert.strictEqual(catalog.revision, null, 'canonical empty catalog revision must be null');
      assert.strictEqual(catalog.idempotent, false, 'catalog read is not idempotent');
      var mismatch = await facade.getModelPriceCatalog({ catalogRevision: 1 });
      failResult(mismatch, 'catalog-revision-mismatch', 'requested revision on empty official catalog');
    } finally {
      await facade.close();
    }
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// --- quote 必须稳定 catalog-unavailable；任何模型、任何 revision 请求都一样 ---
async function t_quoteFailClosed(facadeModulePath) {
  var ws = makeWorkspace(1000);
  try {
    var mod = require(facadeModulePath);
    var facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-quote' });
    try {
      var q1 = await facade.quoteRequestCharge({ model: 'model-alpha' });
      failResult(q1, 'catalog-unavailable', 'quote on empty official catalog');
      var q2 = await facade.quoteRequestCharge({ model: 'model-alpha', catalogRevision: 1 });
      failResult(q2, 'catalog-unavailable', 'quote with requested revision still unavailable');
      var q3 = await facade.quoteRequestCharge({ model: 'model-beta' });
      failResult(q3, 'catalog-unavailable', 'quote of any official model unavailable');
    } finally {
      await facade.close();
    }
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// --- reserve 必须稳定 catalog-unavailable 且信封字节级不变 ---
async function t_reserveFailClosedNoStateChange(facadeModulePath) {
  var ws = makeWorkspace(1000);
  try {
    var mod = require(facadeModulePath);
    var facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-reserve' });
    try {
      var before = fileDigest(ws.filePath);
      var r1 = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-fail-1' });
      failResult(r1, 'catalog-unavailable', 'reserve on empty official catalog');
      var r2 = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-fail-2', expectedRevision: 0 });
      failResult(r2, 'catalog-unavailable', 'reserve with expectedRevision still unavailable');
      // 重试路径：同一 operationId 再次进入，得到同一个稳定失败，仍无状态改变。
      var r3 = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'reserve-fail-1' });
      failResult(r3, 'catalog-unavailable', 'reserve retry is a stable failure');
      var after = fileDigest(ws.filePath);
      assert.strictEqual(after, before, 'durable envelope file must be byte-identical after failed quote/reserve');
      var state = JSON.parse(fs.readFileSync(ws.filePath, 'utf8'));
      assert.strictEqual(state.revision, 0, 'revision unchanged');
      assert.strictEqual(state.balanceMinor, 1000, 'balanceMinor unchanged');
      assert.strictEqual(state.reservedMinor, 0, 'reservedMinor unchanged');
      assert.deepStrictEqual(state.requestCharges, {}, 'requestCharges unchanged');
      assert.deepStrictEqual(state.operationReceipts, {}, 'operationReceipts unchanged');
      assert.deepStrictEqual(state.auditEvents, [], 'auditEvents unchanged');
      var revision = await facade.getCurrentRevision();
      assert.strictEqual(revision, 0, 'facade current revision unchanged');
      // 余额投影仍可读，且绑定未变的 revision。
      var balance = await facade.getAccountBalance({});
      assert.strictEqual(balance.ok, true, 'balance read still works');
      assert.strictEqual(balance.value.remainingBalanceMinor, 1000, 'balance projection 1000');
      assert.strictEqual(balance.value.availableBalanceMinor, 1000, 'available 1000');
      assert.strictEqual(balance.value.revision, 0, 'balance revision 0');
    } finally {
      await facade.close();
    }
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// --- 重启路径 + 非金钱通道不受影响 + 对不存在请求的转移保持原稳定失败 ---
async function t_restartAndNonMoney(facadeModulePath) {
  var ws = makeWorkspace(1000);
  try {
    var mod = require(facadeModulePath);
    var facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-restart', trustedReconciliation: true });
    try {
      var settle = await facade.settleRequestCharge({ requestId: 'req-missing', operationId: 'settle-missing' });
      failResult(settle, 'unknown-request', 'settle unknown request');
      var release = await facade.releaseRequestCharge({ requestId: 'req-missing', operationId: 'release-missing' });
      failResult(release, 'unknown-request', 'release unknown request');
      var unknown = await facade.markRequestUnknown({ requestId: 'req-missing', operationId: 'unknown-missing' });
      failResult(unknown, 'unknown-request', 'markUnknown unknown request');
      var reconcile = await facade.reconcileRequestCharge({
        requestId: 'req-missing', operationId: 'reconcile-missing',
        outcome: 'settled', evidence: { trusted: true }
      });
      failResult(reconcile, 'unknown-request', 'reconcile unknown request');
      // 非金钱通道仍然可用（trial/byok/quota 是显式路由，不是失败回退）。
      var trial = await facade.processNonMoneyRequest({ billingMode: 'trial', operationId: 'trial-ok' });
      assert.strictEqual(trial.ok, true, 'trial still works');
      assert.strictEqual(trial.revision, 1, 'trial revision 1');
      var byok = await facade.processNonMoneyRequest({ billingMode: 'byok', operationId: 'byok-ok' });
      assert.strictEqual(byok.ok, true, 'byok still works');
      var quota = await facade.processNonMoneyRequest({ billingMode: 'request-count-quota', operationId: 'quota-ok', quotaWalletId: 'synthetic' });
      assert.strictEqual(quota.ok, false, 'missing quota wallet fails');
      assert.strictEqual(quota.errorCode, 'quota-exhausted', 'missing wallet is quota-exhausted');
    } finally {
      await facade.close();
    }
    // 重启路径：重新打开 facade，金钱状态仍未变，quote 仍 fail-closed。
    var reopened = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-restart' });
    try {
      var balance = await reopened.getAccountBalance({});
      assert.strictEqual(balance.ok, true, 'reopened facade balance ok');
      assert.strictEqual(balance.value.remainingBalanceMinor, 1000, 'money untouched by non-money');
      assert.strictEqual(balance.value.revision, 2, 'only non-money revisions (trial+byok)');
      var quote = await reopened.quoteRequestCharge({ model: 'model-alpha' });
      failResult(quote, 'catalog-unavailable', 'quote still fail-closed after restart');
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

// --- 输入校验仍生效；持久化读失败路径 fail-closed；gate 与持久化状态无关 ---
async function t_validationAndDurableFail(facadeModulePath) {
  var ws = makeWorkspace(1000);
  try {
    var mod = require(facadeModulePath);
    var facade = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-valid' });
    try {
      var sensitiveQuote = await facade.quoteRequestCharge({ model: 'model-alpha', prompt: 'synthetic clinical text' });
      failResult(sensitiveQuote, 'sensitive-field-rejected', 'sensitive key rejected on quote');
      var sensitiveReserve = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'res-sens', apiKey: 'secret' });
      failResult(sensitiveReserve, 'sensitive-field-rejected', 'sensitive key rejected on reserve');
      var noModel = await facade.quoteRequestCharge({});
      failResult(noModel, 'invalid-request', 'missing model invalid-request');
      var noOp = await facade.reserveRequestCharge({ model: 'model-alpha' });
      failResult(noOp, 'invalid-request', 'missing operationId invalid-request');
      var forged = await facade.reserveRequestCharge({ model: 'model-alpha', operationId: 'res-forge', billingMode: 'trial' });
      failResult(forged, 'invalid-request', 'renderer cannot forge billingMode');
    } finally {
      await facade.close();
    }
    // 持久化故障路径：创建后损坏信封文件 → 读取稳定 durable-read-failed，
    // 而 quote gate 在文件损坏时仍然稳定 catalog-unavailable 且不再写文件。
    var facade2 = await mod.createCommercialFacade({ filePath: ws.filePath, deviceId: 'synthetic-valid' });
    fs.writeFileSync(ws.filePath, '{corrupted-json', 'utf8');
    var before = fileDigest(ws.filePath);
    try {
      var bal = await facade2.getAccountBalance({});
      failResult(bal, 'durable-read-failed', 'corrupted envelope read fails closed');
      var quote = await facade2.quoteRequestCharge({ model: 'model-alpha' });
      failResult(quote, 'catalog-unavailable', 'quote gate independent of durable state');
    } finally {
      await facade2.close();
    }
    var after = fileDigest(ws.filePath);
    assert.strictEqual(after, before, 'corrupted file untouched by failed gate');
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
}

var ALL_TESTS = [
  ['catalogEmpty', t_catalogEmpty],
  ['quoteFailClosed', t_quoteFailClosed],
  ['reserveFailClosedNoStateChange', t_reserveFailClosedNoStateChange],
  ['restartAndNonMoney', t_restartAndNonMoney],
  ['validationAndDurableFail', t_validationAndDurableFail]
];

// 加载 modulePath 处的 REAL facade 模块并对真实临时文件运行全部行为测试。
// 返回 [{name, pass, error}]。不调用 process.exit，供反向变异 harness 复用。
async function runFailClosedSuite(facadeModulePath) {
  var results = [];
  for (var i = 0; i < ALL_TESTS.length; i++) {
    var name = ALL_TESTS[i][0];
    var fn = ALL_TESTS[i][1];
    var started = Date.now();
    try {
      await fn(facadeModulePath);
      results.push({ name: name, pass: true, ms: Date.now() - started });
    } catch (e) {
      results.push({ name: name, pass: false, error: (e && e.message) || String(e), ms: Date.now() - started });
    }
  }
  return results;
}

if (require.main === module) {
  var target = process.argv[2] || CANDIDATE_FACADE;
  runFailClosedSuite(target).then(function (results) {
    var fails = 0;
    results.forEach(function (r) {
      console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.pass ? '' : ' :: ' + r.error));
      if (!r.pass) fails += 1;
    });
    console.log(fails === 0 ? 'ALL PASS (' + results.length + ' tests)' : (fails + ' FAILURES / ' + results.length));
    process.exitCode = fails === 0 ? 0 : 1;
  }).catch(function (e) {
    console.error('SUITE ERROR: ' + (e && e.stack || e));
    process.exitCode = 2;
  });
}

module.exports = { runFailClosedSuite: runFailClosedSuite, ALL_TESTS: ALL_TESTS };

