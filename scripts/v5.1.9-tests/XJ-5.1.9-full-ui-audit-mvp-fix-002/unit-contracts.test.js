'use strict';
/* unit-contracts.test.js — 本卡 node 级契约测试：
 * 1) pii-sanitizer 契约（新增强化的模式、嵌套残余扫描、fail-closed、占位符稳定）
 * 2) node 级 expected-red 变异：在模块出站边界（ai.js 消费的 sanitizeMessages/sanitizeText API）
 *    注入各缺陷类别的变异实现（吞 fail-closed / 删除脱敏 / 只脱敏顶层），断言每个变异都必须失败；
 *    变异只在内存替换导出函数，finally 恢复，不触碰工作树、不落盘、无动态执行。
 * 3) Z13 价格同源判定（normalizeCatalog 宽容度与模型选择器一致）
 * 运行：node scripts/v5.1.9-tests/XJ-5.1.9-full-ui-audit-mvp-fix-002/unit-contracts.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.9-full-ui-audit-mvp-fix-002';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('PASS ' + name + '\n'); }
  catch (e) { failed++; process.stderr.write('FAIL ' + name + ': ' + e.message + '\n'); }
}

const sanitizer = require('D:/xinjing-electron/app/js/pii-sanitizer.js');
const panel = require('D:/xinjing-electron/app/js/commercial-account-panel.js');

/* 变异运行器：内存中替换导出函数 → 执行断言（必须失败）→ finally 恢复 */
function withBoundaryMutation(mutations, runExpectingFailure) {
  const originals = mutations.map((m) => ({ key: m.key, fn: sanitizer[m.key] }));
  try {
    mutations.forEach((m) => { sanitizer[m.key] = m.impl; });
    let threw = null;
    try { runExpectingFailure(); } catch (e) { threw = e; }
    if (!threw) throw new Error('变异未被测试抓住：断言在变异实现下仍然通过（假绿）');
    return threw;
  } finally {
    originals.forEach((o) => { sanitizer[o.key] = o.fn; });
  }
}

/* ---------- 1. 基础契约 ---------- */
test('sanitizer: 手机号/邮箱/身份证/姓名/住址 全部替换', () => {
  const r = sanitizer.sanitizeText('患者姓名：李明，电话 13812345678，邮箱 li.ming@example.com，身份证 110101199001011234。家庭住址：上海市静安区南京西路 100 号');
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('[[PERSON_NAME_1]]'));
  assert.ok(r.text.includes('[[PHONE_1]]'));
  assert.ok(r.text.includes('[[EMAIL_1]]'));
  assert.ok(r.text.includes('[[ID_CARD_1]]'));
  assert.ok(r.text.includes('[[ADDRESS_1]]'));
  assert.strictEqual(r.residual.length, 0);
});

test('sanitizer: 座机/微信号/QQ（本次补充模式）被替换', () => {
  const r = sanitizer.sanitizeText('座机 010-12345678，微信号 zhangwei_fb01，QQ 975310024');
  assert.ok(r.text.includes('[[PHONE_1]]') || r.text.includes('[[ACCOUNT_1]]'));
  assert.ok(r.text.includes('[[ACCOUNT_'));
  assert.ok(!r.text.includes('010-12345678'));
  assert.ok(!r.text.includes('zhangwei_fb01'));
  assert.ok(!r.text.includes('975310024'));
  assert.strictEqual(r.residual.length, 0);
});

test('sanitizer: 日期按类替换且不误判座机', () => {
  const r = sanitizer.sanitizeText('会谈日期 2026-09-04，下次 2026年9月10日');
  assert.ok(r.text.includes('[[DATE_1]]'));
  assert.ok(r.text.includes('[[DATE_2]]'));
  assert.strictEqual(r.ok, true);
});

test('sanitizer: 一次请求内占位符稳定（跨消息一致）', () => {
  const r = sanitizer.sanitizeMessages([
    { role: 'user', content: '来访者姓名：王芳，电话 13900001111' },
    { role: 'assistant', content: '请联系王芳（13900001111）确认时间。' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.ok(r.messages[1].content.includes('[[PERSON_NAME_1]]'));
  assert.ok(r.messages[1].content.includes('[[PHONE_1]]'));
});

test('sanitizer: 嵌套结构（tool_calls 参数 / 数组 content）同步脱敏', () => {
  const r = sanitizer.sanitizeMessages([{
    role: 'assistant',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"phone":"13612345678"}' } }],
    content: [{ type: 'text', text: '地址：上海市静安区南京西路 100 号' }],
  }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.messages[0].tool_calls[0].id, 'call_1');
  assert.ok(r.messages[0].content[0].text.includes('[[ADDRESS_1]]'));
  assert.ok(!r.messages[0].tool_calls[0].function.arguments.includes('13612345678'));
});

test('sanitizer: 非法输入 fail-closed', () => {
  const r = sanitizer.sanitizeMessages(null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'XJ_PII_SANITIZATION_FAILED');
});

test('sanitizer(本次强化): 嵌套字符串全部被脱敏，出站结构零原文', () => {
  const r = sanitizer.sanitizeMessages([{ role: 'user', content: [{ type: 'text', text: '联系我 13812345678' }] }]);
  assert.strictEqual(r.ok, true);
  assert.ok(!JSON.stringify(r.messages).includes('13812345678'));
  const r2 = sanitizer.sanitizeText('纯文本 13812345678 已替换');
  assert.strictEqual(r2.residual.length, 0);
});

/* ---------- 2. expected-red 变异（出站边界实现替换；每个变异必须失败） ---------- */
test('MUT-M-PII-01(删除脱敏): 变异后「零残留」断言必须失败', () => {
  withBoundaryMutation(
    [{ key: 'sanitizeText', impl: function (text) {
      return { ok: true, text: String(text), entities: [], residual: [] };
    } }],
    () => {
      const r = sanitizer.sanitizeText('电话 13812345678');
      assert.ok(!r.text.includes('13812345678'), 'raw must be replaced');
      assert.strictEqual(r.residual.length, 0);
    }
  );
});

test('MUT-M-PII-02(吞 fail-closed): 变异后「非法输入拒绝」断言必须失败', () => {
  withBoundaryMutation(
    [{ key: 'sanitizeMessages', impl: function () {
      return { ok: true, code: null, messages: [], entities: [], residual: [] };
    } }],
    () => {
      const r = sanitizer.sanitizeMessages(null);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 'XJ_PII_SANITIZATION_FAILED');
    }
  );
});

test('MUT-M-PII-03(只脱敏顶层/漏嵌套 tool 参数): 变异后「嵌套零原文」断言必须失败', () => {
  const realMessages = sanitizer.sanitizeMessages;
  withBoundaryMutation(
    [{ key: 'sanitizeMessages', impl: function (messages) {
      // 变异实现：只处理字符串顶层 content，嵌套结构（数组 content / tool_calls）原样透传
      const shallow = (messages || []).map((m) => (m && typeof m === 'object' && typeof m.content === 'string')
        ? Object.assign({}, m, { content: realMessages([m]).messages[0].content })
        : m);
      return { ok: true, code: null, messages: shallow, entities: [], residual: [] };
    } }],
    () => {
      const r = sanitizer.sanitizeMessages([{
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"phone":"13612345678"}' } }],
        content: [{ type: 'text', text: '联系我 13812345678' }],
      }]);
      assert.ok(!JSON.stringify(r.messages).includes('13812345678'), 'nested raw must be caught');
    }
  );
});

/* ---------- 3. Z13 价格同源判定契约 ---------- */
test('Z13: 严格路径（含 currency/fallbackOnly）通过', () => {
  const catalog = panel.normalizeCatalog({ ok: true, value: {
    catalogRevision: 'cat-1',
    settlementCurrency: 'CNY', fxRateUsdToCny: 7,
    models: [{ modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'p', inputPrice: 1.32, outputPrice: 3.96, currency: 'USD', active: true, fallbackOnly: false, catalogRevision: 'cat-1' }],
  } });
  assert.ok(catalog && catalog.kind === 'server' && catalog.models.length === 1);
});

test('Z13(本次修复): 服务器条目缺 currency/fallbackOnly 时不再整目录判废（与选择器同判）', () => {
  const catalog = panel.normalizeCatalog({ ok: true, value: {
    catalogRevision: 'cat-1',
    models: [
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'p', inputPrice: 1.32, outputPrice: 3.96 },
      { modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'p', inputPrice: 0.44, outputPrice: 1.32 },
    ],
  } });
  assert.ok(catalog && catalog.kind === 'server', '宽容路径必须产出目录');
  assert.strictEqual(catalog.models.length, 2);
  assert.strictEqual(catalog.models[0].currency, 'CNY');
  assert.strictEqual(catalog.fxRateUsdToCny, 7);
});

test('Z13: 缺价格字段的坏条目仍然 fail-closed', () => {
  const catalog = panel.normalizeCatalog({ ok: true, value: {
    catalogRevision: 'cat-1',
    models: [{ modelId: 'bad', displayName: 'bad', provider: 'p' }],
  } });
  assert.strictEqual(catalog, null);
});

test('Z13: 非对象返回 null；空 models 列表按原契约渲染为空目录（不报价格暂不可用）', () => {
  assert.strictEqual(panel.normalizeCatalog({ ok: true, value: null }), null);
  const empty = panel.normalizeCatalog({ ok: true, value: { catalogRevision: 'c', models: [] } });
  assert.ok(empty && empty.kind === 'server' && empty.models.length === 0);
});

process.stdout.write('UNIT DONE: passed=' + passed + ' failed=' + failed + '\n');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'unit-contract-results.json'), JSON.stringify({ passed, failed, at: new Date().toISOString() }, null, 2));
process.exit(failed ? 1 : 0);
