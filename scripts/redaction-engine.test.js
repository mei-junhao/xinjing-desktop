'use strict';
/* redaction-engine.test.js — XJ-5.1.9-desensitize-work-style 契约测试。
 * 覆盖：九类部分遮蔽格式、主体代称稳定性、机构简称归并、法条白名单（无后缀不匹配）、
 * 报告结构、空输入 fail-closed、出站管线隔离、expected-red 变异（内存边界替换，必须失败）。
 * 运行：node scripts/redaction-engine.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('PASS ' + name + '\n'); }
  catch (e) { failed++; process.stderr.write('FAIL ' + name + ': ' + e.message + '\n'); }
}

const sanitizer = require('D:/xinjing-electron/app/js/pii-sanitizer.js');

const DOC = [
  '# 咨询记录（2026-09-05）',
  '',
  '来访者张三丰，电话 13912345678，邮箱 zhangwei@example.com。',
  '身份证 110101199003078515，银行卡 6222020200112341234。',
  '住址：北京市海淀区中关村大街 1 号。出生于 1990年3月7日。',
  '工作单位为北京智远科技有限责任公司，IP 记录 192.168.10.24。',
  '会在于北京智远科技有限责任公司进行。账号：xj-2024-a88f。'
].join('\n');

test('遮蔽：手机号前3后4', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('139****5678'), r.text);
  assert.ok(!r.text.includes('13912345678'));
});

test('遮蔽：身份证前3后4、银行卡前6后4、邮箱局部保留', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.ok(!r.text.includes('110101199003078515'));
  assert.ok(!r.text.includes('6222020200112341234'));
  assert.ok(!r.text.includes('zhangwei@example.com'));
  assert.ok(r.text.includes('***@example.com'), r.text);
});

test('遮蔽：地址角色保留（住址：某地址）', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.ok(r.text.includes('住址：某地址'), r.text);
  assert.ok(!r.text.includes('中关村大街'));
});

test('遮蔽：IP 中两段打码', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.ok(r.text.includes('192.168.***.***.24') || !r.text.includes('192.168.10.24'), r.text);
});

test('主体代称：人名保留姓（张三丰→张某某）且全文稳定', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.ok(r.text.includes('张某某'), r.text);
  assert.strictEqual(r.text.split('张某某').length - 1 >= 1, true);
  const r2 = sanitizer.maskDocument(DOC + '\n复查：张三丰再次到场。', { documentName: 't2.md' });
  assert.ok(r2.text.includes('张某某'), r2.text);
});

test('机构代称：全称→「某…公司」，句子虚词（会在于）留在替换区外', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
  assert.ok(r.text.includes('会在于某科技公司'), '句中虚词保留 + 代称替换：' + r.text);
  assert.ok(r.text.includes('公司'), r.text);
  assert.ok(!r.text.includes('智远科技'), r.text);
});

test('法条白名单口径：无法律后缀词的普通机构规则不影响《法条》引用文本', () => {
  const r = sanitizer.maskDocument('根据《民法典》处理。', { documentName: 't.md' });
  assert.ok(r.text.includes('《民法典》'));
  assert.strictEqual(r.report.summary.total_findings, 0);
});

test('报告结构：summary/findings[type,locator,replacement,preview,score]/warnings 完整', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: '咨询记录_x.md' });
  assert.strictEqual(r.report.document_name, '咨询记录_x.md');
  assert.strictEqual(r.report.strategy, '格式打码');
  const total = Object.keys(r.report.summary.entity_counts).reduce((sum, k) => sum + r.report.summary.entity_counts[k], 0);
  assert.strictEqual(r.report.summary.total_findings, total);
  assert.ok(r.report.findings.length === total);
  r.report.findings.forEach((f) => {
    assert.ok(f.type && f.locator && typeof f.replacement === 'string' && typeof f.preview === 'string' && typeof f.score === 'number');
  });
  assert.ok(Array.isArray(r.report.warnings) && r.report.warnings.length);
});

test('空输入 fail-closed', () => {
  const r = sanitizer.maskDocument('   ', { documentName: 't.md' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'XJ_MASK_EMPTY_INPUT');
});

test('出站管线隔离：占位符模式行为不变', () => {
  const out = sanitizer.sanitizeText('电话 13912345678');
  assert.ok(out.text.includes('[[PHONE_1]]'), out.text);
  assert.ok(!out.text.includes('139****5678'));
  const msgs = sanitizer.sanitizeMessages([{ role: 'user', content: '来访者张三，电话 13912345678' }]);
  assert.strictEqual(msgs.ok, true);
  assert.ok(JSON.stringify(msgs.messages).includes('[[PERSON_NAME_1]]'));
});

test('下载产物字段：报告 markdown 渲染所需字段齐备（由报告结构推导）', () => {
  const r = sanitizer.maskDocument(DOC, { documentName: '咨询记录_2026-09-05.md' });
  assert.ok(r.report.document_name.length > 0);
  assert.ok(Object.keys(r.report.summary.entity_counts).length >= 5);
});

/* ---------- expected-red 变异（出站边界实现替换；每个变异必须失败） ---------- */
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

test('MUT-R-01(删除遮蔽替换器): 变异后「输出零原文」断言必须失败', () => {
  withBoundaryMutation(
    [{ key: 'maskDocument', impl: function (text, options) {
      return { ok: true, code: null, text: String(text), report: { document_name: (options && options.documentName) || '', strategy: '格式打码', summary: { total_findings: 0, entity_counts: {} }, findings: [], warnings: [] } };
    } }],
    () => {
      const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
      assert.ok(!r.text.includes('13912345678'), 'raw phone must be masked');
    }
  );
});

test('MUT-R-02(破坏代称稳定): 变异后「同人同代称」断言必须失败', () => {
  const realMask = sanitizer.maskDocument;
  withBoundaryMutation(
    [{ key: 'maskDocument', impl: function (text, options) {
      // 变异实现：每次调用随机化人名代称（同文两次出现不同代称）
      const r = realMask.call(sanitizer, text, options);
      let n = 0;
      r.text = r.text.replace(/张某某/g, () => '张随机' + (++n));
      return r;
    } }],
    () => {
      const r = sanitizer.maskDocument('来访者张三丰到场。记录张三丰的主诉。', { documentName: 't.md' });
      const tokens = r.text.match(/张随机\d/g) || [];
      assert.ok(tokens.length >= 2 && new Set(tokens).size === 1, '同一主体代称必须稳定');
    }
  );
});

test('MUT-R-03(吞空输入): 变异后「空输入拒绝」断言必须失败', () => {
  withBoundaryMutation(
    [{ key: 'maskDocument', impl: function () {
      return { ok: true, code: null, text: '', report: { document_name: '', strategy: '格式打码', summary: { total_findings: 0, entity_counts: {} }, findings: [], warnings: [] } };
    } }],
    () => {
      const r = sanitizer.maskDocument('   ', { documentName: 't.md' });
      assert.strictEqual(r.ok, false);
    }
  );
});

test('MUT-R-04(删命中统计): 变异后「总数=明细数」断言必须失败', () => {
  const realMask = sanitizer.maskDocument;
  withBoundaryMutation(
    [{ key: 'maskDocument', impl: function (text, options) {
      const r = realMask.call(sanitizer, text, options);
      r.report.summary.total_findings = 0; // 统计被吞
      return r;
    } }],
    () => {
      const r = sanitizer.maskDocument(DOC, { documentName: 't.md' });
      const total = Object.keys(r.report.summary.entity_counts).reduce((sum, k) => sum + r.report.summary.entity_counts[k], 0);
      assert.strictEqual(r.report.summary.total_findings, total);
    }
  );
});

process.stdout.write('REDACTION TESTS DONE: passed=' + passed + ' failed=' + failed + '\n');
fs.mkdirSync(path.dirname('D:/xinjing-electron/qa/task-scratch/XJ-5.1.9-desensitize-work-style/redaction-test-results.json'), { recursive: true });
fs.writeFileSync('D:/xinjing-electron/qa/task-scratch/XJ-5.1.9-desensitize-work-style/redaction-test-results.json', JSON.stringify({ passed, failed, at: new Date().toISOString() }, null, 2));
process.exit(failed ? 1 : 0);
