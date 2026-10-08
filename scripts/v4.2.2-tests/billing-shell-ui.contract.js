#!/usr/bin/env node
/* ============================================================
   XJ-4.2.2-billing-shell-ui-v1 — 账务工作区 UI 契约测试（契约硬化版）
   真实读取 billing-shell.html 源码，验证 handler 语义映射、
   异常捕获、单一主操作、事件冒泡修复和变异敏感性。

   硬化要点（相对上一版）：
   - S1–S16 重构为可调用断言 assertS1(src)…assertS16(src)，
     接受源码字符串（账务 shell 为静态 HTML，无 VM 执行上下文，
     故以源码字符串作为唯一输入；与 JS 模块契约的“隔离 VM fixture”
     同义：断言接收被验证对象本身，而非全局常量）。
   - M1–M5 不再以“源码是否被改动”作为变异敏感证据；
     每个变异测试：(1) 先在原始源码上运行同一断言，确认基线 GREEN；
     (2) 对临时变异源码运行同一断言，期望其抛错（即断言真实探测到变异）。
     若变异未被同一断言探测到（断言未在变异源上抛错）→ 测试 FAIL。
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..', '..');
var SHELL_PATH = path.join(ROOT, 'app', 'billing-shell.html');
var SRC = fs.readFileSync(SHELL_PATH, 'utf8');

var passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('[PASS] ' + name); }
  catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); }
}

// 运行断言并捕获是否抛错；返回是否抛错。
function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

// ---- Helper: extract a function body from source by name ----
function extractFnBody(src, fnName) {
  var idx = src.indexOf('function ' + fnName);
  if (idx < 0) {
    idx = src.indexOf(fnName + ' = function');
    if (idx < 0) idx = src.indexOf(fnName + ': function');
    if (idx < 0) idx = src.indexOf(fnName + ': async function');
  }
  if (idx < 0) return null;
  var braceStart = src.indexOf('{', idx);
  if (braceStart < 0) return null;
  var depth = 0, end = -1;
  for (var i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  return src.slice(idx, end + 1);
}

// ===================== 可调用断言（源码字符串输入） =====================

// S1: 收入列不出现重复的“记一笔”主操作
function assertS1(src) {
  var incomeColStart = src.indexOf('id="income-col"');
  if (incomeColStart < 0) throw new Error('income-col not found');
  var incomeColEnd = src.indexOf('</div>', src.indexOf('id="bin-body"', incomeColStart));
  if (incomeColEnd < 0) incomeColEnd = incomeColStart + 2000;
  var incomeCol = src.slice(incomeColStart, incomeColEnd);
  if (/记一笔/.test(incomeCol)) throw new Error('income col still has 记一笔 button — duplicate primary action');
}

// S2: 月结单调用 toggleSettleForm，而非 billing-calendar
function assertS2(src) {
  var button = /<button[^>]+id=["']bf-monthly-settle["'][^>]+data-billing-action=["']monthly-invoice["'][^>]*>月结单<\/button>/.test(src);
  if (!button) throw new Error('月结单 button must use the stable monthly-invoice action');
  var body = extractFnBody(src, 'bindBillingPrimaryActions');
  if (!body || !/monthlyInvoice\.addEventListener\(['"]click['"]/.test(body) || !/toggleSettleForm\(\)/.test(body)) throw new Error('月结单 does not bind toggleSettleForm');
  if (/billing-calendar\.html/.test(body)) throw new Error('月结单 still opens billing-calendar.html (wrong handler)');
}

// S3: 月历按钮打开 billing-calendar.html
function assertS3(src) {
  var idx = src.indexOf('月历');
  if (idx < 0) throw new Error('月历 button not found');
  var ctx = src.slice(Math.max(0, idx - 300), idx + 80);
  if (!/billing-calendar\.html/.test(ctx)) throw new Error('月历 does not open billing-calendar.html');
}

// S4: ImportModal.confirm 具备 try-catch，且 catch 显示错误 toast
function assertS4(src) {
  var body = extractFnBody(src, 'confirm');
  if (!body) {
    var idx = src.indexOf('confirm: async function');
    if (idx < 0) throw new Error('ImportModal.confirm not found');
    body = src.slice(idx, idx + 600);
  }
  if (!/try\s*[({]/.test(body)) throw new Error('confirm() has no try block');
  if (!/catch\s*[(]e[)]|catch\s*\{/.test(body)) throw new Error('confirm() has no catch block');
  if (!/showToast.*error/.test(body)) throw new Error('confirm() catch does not show error toast');
}

// S5: ImportModal.confirm 的成功 toast 必须在 durable 落库后、且位于 if(ok) 之内
function assertS5(src) {
  var idx = src.indexOf('confirm: async function');
  if (idx < 0) throw new Error('confirm not found');
  var body = src.slice(idx, idx + 800);
  var successIdx = body.indexOf("showToast('导入完成");
  if (successIdx < 0) successIdx = body.indexOf('showToast(\'导入完成');
  if (successIdx < 0) throw new Error('success toast not found in confirm');
  var catchIdx = body.indexOf('catch');
  if (catchIdx > 0 && catchIdx < successIdx) throw new Error('success toast appears after catch — may fire on error');
  var ifOkIdx = body.indexOf('if (ok)');
  if (ifOkIdx < 0) ifOkIdx = body.indexOf('if(ok)');
  if (ifOkIdx < 0) throw new Error('if(ok) guard not found — success toast may fire on failure');
  if (successIdx < ifOkIdx) throw new Error('success toast appears before if(ok) guard');
}

// S6: 清除数据按钮存在并调用 confirmClearData
function assertS6(src) {
  var idx = src.indexOf('清除数据');
  if (idx < 0) throw new Error('清除数据 button not found');
  var ctx = src.slice(Math.max(0, idx - 200), idx + 80);
  if (!/confirmClearData/.test(ctx)) throw new Error('清除数据 button does not call confirmClearData');
}

// S7: 清除数据按钮具备 danger 视觉分离与间距
function assertS7(src) {
  var idx = src.indexOf('清除数据');
  if (idx < 0) throw new Error('清除数据 button not found');
  var ctx = src.slice(Math.max(0, idx - 200), idx + 30);
  if (!/danger/.test(ctx)) throw new Error('清除数据 button lacks danger class/separation');
  if (!/margin-left/.test(ctx)) throw new Error('清除数据 button lacks spacing from normal actions');
}

// S8: 顶栏主操作是 toggleAddForm（记一笔）
function assertS8(src) {
  var button = /<button[^>]+class=["']primary["'][^>]+id=["']bf-add-record["'][^>]+data-billing-action=["']add-record["'][^>]*>[\s\S]*?记一笔<\/button>/.test(src);
  if (!button) throw new Error('primary button must use the stable add-record action');
  var body = extractFnBody(src, 'bindBillingPrimaryActions');
  if (!body || !/addRecord\.addEventListener\(['"]click['"]/.test(body) || !/toggleAddForm\(\)/.test(body)) throw new Error('primary button does not bind toggleAddForm');
}

// S9: onIncomeColClick 在切换状态前过滤按钮点击
function assertS9(src) {
  var body = extractFnBody(src, 'onIncomeColClick');
  if (!body) throw new Error('onIncomeColClick not found');
  if (!/closest\(['"]button['"]\)/.test(body)) throw new Error('onIncomeColClick does not check closest button');
  if (!/stopPropagation/.test(body)) throw new Error('onIncomeColClick does not stopPropagation for button children');
}

// S10: onExpColClick 在切换状态前过滤按钮点击
function assertS10(src) {
  var body = extractFnBody(src, 'onExpColClick');
  if (!body) throw new Error('onExpColClick not found');
  if (!/closest\(['"]button['"]\)/.test(body)) throw new Error('onExpColClick does not check closest button');
  if (!/stopPropagation/.test(body)) throw new Error('onExpColClick does not stopPropagation for button children');
}

// S11: 临床说明文字不得小于 12px
function assertS11(src) {
  var idx = src.indexOf('点击窄边栏可以恢复双栏视图');
  if (idx < 0) throw new Error('clinical hint text not found');
  var ctx = src.slice(Math.max(0, idx - 100), idx + 10);
  if (/font-size:\s*(8|9|10|11)px/.test(ctx)) throw new Error('clinical text uses font-size below 12px');
  if (!/var\(--xj-font-min/.test(ctx) && !/font-size:\s*1[2-9]px/.test(ctx) && !/font-size:\s*[2-9][0-9]px/.test(ctx)) {
    if (/font-size:\s*(8|9|10|11)px/.test(ctx)) throw new Error('clinical text font-size below 12px');
  }
}

// S12: toggleSettleForm 委托 openMonthlyInvoicePicker
function assertS12(src) {
  var body = extractFnBody(src, 'toggleSettleForm');
  if (!body) throw new Error('toggleSettleForm not found');
  if (!/openMonthlyInvoicePicker/.test(body)) throw new Error('toggleSettleForm does not call openMonthlyInvoicePicker');
}

// S13: openMonthlyInvoicePicker 已定义
function assertS13(src) {
  if (!/function openMonthlyInvoicePicker|openMonthlyInvoicePicker\s*=/.test(src)) throw new Error('openMonthlyInvoicePicker not defined');
}

// S14: 可见 onclick 处理器均引用已定义函数
function assertS14(src) {
  var onclickRe = /onclick="([A-Za-z_$][A-Za-z0-9_.$\s'()]*)"/g;
  var match;
  var undefinedHandlers = [];
  while ((match = onclickRe.exec(src)) !== null) {
    var expr = match[1].trim();
    var fnName = expr.split('(')[0].trim().split('.').pop();
    if (fnName === 'App' || fnName === 'location' || fnName === 'this' || fnName === 'window' || fnName === 'print') continue;
    var definedPatterns = [
      'function ' + fnName + ' ',
      'function ' + fnName + '(',
      fnName + ' = function',
      fnName + ': function',
      fnName + ': async function',
      'window.' + fnName + ' =',
      'var ' + fnName + ' =',
      'let ' + fnName + ' =',
      'const ' + fnName + ' ='
    ];
    var isDefined = definedPatterns.some(function (p) { return src.indexOf(p) >= 0; });
    if (!isDefined) undefinedHandlers.push(fnName);
  }
  var real = undefinedHandlers.filter(function (n) { return n && n.length > 1 && !/^[0-9]/.test(n); });
  real = real.filter(function (n, i, a) { return a.indexOf(n) === i; });
  if (real.length > 0) throw new Error('handlers with no definition: ' + real.join(', '));
}

// S15: 具备 reduced-motion 支持
function assertS15(src) {
  if (!/prefers-reduced-motion/.test(src)) throw new Error('no prefers-reduced-motion media query');
}

// S16: 具备响应式布局约束
function assertS16(src) {
  if (!/@media/.test(src)) throw new Error('no media queries found');
  if (!/max-width/.test(src)) throw new Error('no max-width breakpoints');
}

// S17: 月结单按钮有 type=button 和稳定 id
function assertS17(src) {
  var idx = src.indexOf('月结单');
  if (idx < 0) throw new Error('月结单 button not found');
  var ctx = src.slice(Math.max(0, idx - 200), idx + 40);
  if (!/type=["']button["']/.test(ctx)) throw new Error('月结单 button missing type=button');
  if (!/id=["']bf-monthly-settle["']/.test(ctx)) throw new Error('月结单 button missing stable id bf-monthly-settle');
}

// S18: 记一笔弹窗有 role=dialog, aria-modal, aria-labelledby, Escape 清理
function assertS18(src) {
  var body = extractFnBody(src, 'openAddModal');
  if (!body) throw new Error('openAddModal not found');
  if (!/role.*dialog/.test(body)) throw new Error('openAddModal missing role=dialog');
  if (!/aria-modal.*true/.test(body)) throw new Error('openAddModal missing aria-modal=true');
  if (!/aria-labelledby.*bf-add-modal-title/.test(body)) throw new Error('openAddModal missing aria-labelledby');
  if (!/amOnKey/.test(body)) throw new Error('openAddModal missing Escape keydown handler (amOnKey)');
  if (!/removeEventListener.*amOnKey/.test(body)) throw new Error('openAddModal missing listener cleanup for amOnKey');
}

// S19: 月结单弹窗有 role=dialog, aria-modal, aria-labelledby, Escape 清理
function assertS19(src) {
  var body = extractFnBody(src, 'openMonthlyInvoicePicker');
  if (!body) throw new Error('openMonthlyInvoicePicker not found');
  if (!/role.*dialog/.test(body)) throw new Error('monthly invoice picker missing role=dialog');
  if (!/aria-modal.*true/.test(body)) throw new Error('monthly invoice picker missing aria-modal=true');
  if (!/aria-labelledby.*bf-monthly-invoice-heading/.test(body)) throw new Error('monthly invoice picker missing aria-labelledby');
  if (!/miOnKey/.test(body)) throw new Error('monthly invoice picker missing Escape keydown handler (miOnKey)');
  if (!/removeEventListener.*miOnKey/.test(body)) throw new Error('monthly invoice picker missing listener cleanup for miOnKey');
}

// S20: 月历预览弹窗有 role=dialog, aria-modal, Escape 清理, close/plans 按钮
function assertS20(src) {
  var body = extractFnBody(src, 'bfShowCalendarPreview');
  if (!body) throw new Error('bfShowCalendarPreview not found');
  if (!/role.*dialog/.test(body)) throw new Error('bfShowCalendarPreview missing role=dialog');
  if (!/aria-modal.*true/.test(body)) throw new Error('bfShowCalendarPreview missing aria-modal=true');
  if (!/onKey/.test(body)) throw new Error('bfShowCalendarPreview missing Escape keydown handler (onKey)');
  // onKey 必须在使用前声明
  var onKeyIdx = body.indexOf('var onKey');
  var firstRemoveIdx = body.indexOf("removeEventListener('keydown', onKey)");
  if (onKeyIdx < 0 || firstRemoveIdx < 0) throw new Error('onKey or removeEventListener not found');
  if (onKeyIdx > firstRemoveIdx) throw new Error('onKey used before declaration (use-before-declare)');
  // 至少 3 处 removeEventListener (backdrop, close, plans)
  var count = (body.match(/removeEventListener\('keydown', onKey\)/g) || []).length;
  if (count < 3) throw new Error('expected >=3 removeEventListener for keydown cleanup, found ' + count);
  if (!/bf-cal-close/.test(body)) throw new Error('bfShowCalendarPreview missing bf-cal-close button');
  if (!/bf-cal-plans/.test(body)) throw new Error('bfShowCalendarPreview missing bf-cal-plans button');
}

// S21: bfOpenCalendar 直接处理，不覆写 App.openFeaturePage
function assertS21(src) {
  if (/App\.openFeaturePage\s*=\s*function/.test(src)) throw new Error('App.openFeaturePage is being overwritten (forbidden)');
  var body = extractFnBody(src, 'bfOpenCalendar');
  if (!body) throw new Error('bfOpenCalendar not found');
  if (!/canUse/.test(body)) throw new Error('bfOpenCalendar missing entitlement check (canUse)');
  if (!/bfShowCalendarPreview/.test(body)) throw new Error('bfOpenCalendar missing Free-preview branch (bfShowCalendarPreview)');
  if (!/App\.openFeaturePage/.test(body)) throw new Error('bfOpenCalendar missing Pro-path App.openFeaturePage call');
}

// S22: 所有弹窗的遮罩点击关闭路径也清理 keydown 监听器
function assertS22(src) {
  var addModal = extractFnBody(src, 'openAddModal');
  if (!addModal) throw new Error('openAddModal not found');
  if (!/event\.target === overlay[\s\S]*?removeEventListener.*amOnKey/.test(addModal)) throw new Error('openAddModal backdrop click does not clean amOnKey listener');
  var calPreview = extractFnBody(src, 'bfShowCalendarPreview');
  if (!calPreview) throw new Error('bfShowCalendarPreview not found');
  if (!/event\.target === overlay[\s\S]*?removeEventListener.*onKey/.test(calPreview)) throw new Error('bfShowCalendarPreview backdrop click does not clean onKey listener');
}

// ===================== 正向检查（S1–S22） =====================
// 全部使用同一批可调用断言，输入为真实生产源码 SRC。
test('S1: income column has no duplicate 记一笔 button', function () { assertS1(SRC); });
test('S2: 月结单 button calls toggleSettleForm, not billing-calendar', function () { assertS2(SRC); });
test('S3: 月历 button opens billing-calendar.html', function () { assertS3(SRC); });
test('S4: ImportModal.confirm has try-catch error handling', function () { assertS4(SRC); });
test('S5: ImportModal.confirm does not show success before durable persistence resolves', function () { assertS5(SRC); });
test('S6: 清除数据 button calls confirmClearData', function () { assertS6(SRC); });
test('S7: 清除数据 button has danger visual separation', function () { assertS7(SRC); });
test('S8: topbar primary action is toggleAddForm', function () { assertS8(SRC); });
test('S9: onIncomeColClick filters button clicks to prevent bubbling', function () { assertS9(SRC); });
test('S10: onExpColClick filters button clicks to prevent bubbling', function () { assertS10(SRC); });
test('S11: clinical explanatory text is not below 12px', function () { assertS11(SRC); });
test('S12: toggleSettleForm delegates to openMonthlyInvoicePicker', function () { assertS12(SRC); });
test('S13: openMonthlyInvoicePicker is defined', function () { assertS13(SRC); });
test('S14: visible onclick handlers reference defined functions', function () { assertS14(SRC); });
test('S15: page has reduced-motion support', function () { assertS15(SRC); });
test('S16: responsive layout constraints exist', function () { assertS16(SRC); });
test('S17: 月结单 button has type=button and stable id', function () { assertS17(SRC); });
test('S18: 记一笔 dialog has role=dialog, aria-modal, Escape cleanup', function () { assertS18(SRC); });
test('S19: 月结单 dialog has role=dialog, aria-modal, Escape cleanup', function () { assertS19(SRC); });
test('S20: 月历预览 dialog has role=dialog, aria-modal, Escape cleanup, bf-cal-close/plans', function () { assertS20(SRC); });
test('S21: bfOpenCalendar directly handles without overwriting App.openFeaturePage', function () { assertS21(SRC); });
test('S22: all backdrop click close paths clean their keydown listeners', function () { assertS22(SRC); });

// ===================== 变异门（M1–M9，执行同一断言） =====================
// 硬化规则：不得仅以“源码被改动”作为变异敏感证据。
// 每个 M 测试：(1) 在原始源码上运行同一断言，确认基线 GREEN；
//           (2) 对临时变异源码运行同一断言，期望其抛错；
//           (3) 若变异未被该断言探测到（未抛错）→ 测试 FAIL。

// M1 → S2：把月结单 handler 退回 billing-calendar，应被 S2 探测。
test('M1: mutation — reverting 月结单 to billing-calendar is detected by same S2 assertion', function () {
  if (throws(function () { assertS2(SRC); })) throw new Error('baseline S2 failed on original source — assertion is broken');
  var mutated = SRC.replace('data-billing-action="monthly-invoice"', 'data-billing-action="billing-calendar"');
  if (mutated === SRC) throw new Error('mutation no-op: 月结单 button pattern not found');
  if (!throws(function () { assertS2(mutated); })) throw new Error('mutant NOT detected by S2 assertion (false green)');
});

// M2 → S4：移除 ImportModal.confirm 的 try 块，应被 S4 探测。
test('M2: mutation — removing try-catch from ImportModal.confirm is detected by same S4 assertion', function () {
  if (throws(function () { assertS4(SRC); })) throw new Error('baseline S4 failed on original source — assertion is broken');
  var mutated = SRC.replace(/confirm: async function \(\) \{[\s\S]*?try \{/, function (m) { return m.replace('try {', '{'); });
  if (mutated === SRC) {
    mutated = SRC.replace(/\n\s*try \{\n\s*let ok = false;/, '\n        let ok = false;');
  }
  if (mutated === SRC) throw new Error('mutation no-op: try block pattern not found');
  if (!throws(function () { assertS4(mutated); })) throw new Error('mutant NOT detected by S4 assertion (false green)');
});

// M3 → S1：在收入列新增重复的“记一笔”按钮，应被 S1 探测。
test('M3: mutation — adding duplicate 记一笔 to income col is detected by same S1 assertion', function () {
  if (throws(function () { assertS1(SRC); })) throw new Error('baseline S1 failed on original source — assertion is broken');
  var mutated = SRC.replace(
    /(<button\s+type=["']button["']\s+id=["']bf-monthly-settle["']\s+data-billing-action=["']monthly-invoice["']>月结单<\/button>)/,
    '<button onclick="billingToggleAddForm()">+ 记一笔</button>$1'
  );
  if (mutated === SRC) throw new Error('mutation no-op: income col button pattern not found');
  if (!throws(function () { assertS1(mutated); })) throw new Error('mutant NOT detected by S1 assertion (false green)');
});

// M4 → S9：移除 onIncomeColClick 的按钮过滤，应被 S9 探测。
test('M4: mutation — removing button filter from onIncomeColClick is detected by same S9 assertion', function () {
  if (throws(function () { assertS9(SRC); })) throw new Error('baseline S9 failed on original source — assertion is broken');
  var mutated = SRC.replace(
    /\/\/ P5 修复[\s\S]*?if \(event && event\.target\) \{[\s\S]*?var t = event\.target\.closest\('button'\);[\s\S]*?if \(t\) \{ event\.stopPropagation\(\); return; \}[\s\S]*?\}/,
    '/* P5 filter removed */'
  );
  if (mutated === SRC) throw new Error('mutation no-op: button filter pattern not found in onIncomeColClick');
  if (!throws(function () { assertS9(mutated); })) throw new Error('mutant NOT detected by S9 assertion (false green)');
});

// M5 → S4：移除 ImportModal.confirm catch 中的错误 toast，应被 S4 探测。
test('M5: mutation — removing error toast from ImportModal.confirm catch is detected by same S4 assertion', function () {
  if (throws(function () { assertS4(SRC); })) throw new Error('baseline S4 failed on original source — assertion is broken');
  var mutated = SRC.replace(
    /App\.showToast\('导入失败:[^']*'[^)]*\)/,
    '/* removed error toast */'
  );
  if (mutated === SRC) throw new Error('mutation no-op: error toast pattern not found');
  if (!throws(function () { assertS4(mutated); })) throw new Error('mutant NOT detected by S4 assertion (false green)');
});

// M6 → S17: 移除月结单 button 的 type=button
  test('M6: mutation — removing type=button from 月结单 is detected by S17', function () {
  if (throws(function () { assertS17(SRC); })) throw new Error('baseline S17 failed');
  var mutated = SRC.replace(/(<button\s+)type=["']button["']\s+id=["']bf-monthly-settle["']/, '$1id="bf-monthly-settle"');
  if (mutated === SRC) throw new Error('mutation no-op: type=button pattern not found');
  if (!throws(function () { assertS17(mutated); })) throw new Error('mutant NOT detected by S17 (false green)');
});

// M7 → S21: 覆写 App.openFeaturePage
  test('M7: mutation — overwriting App.openFeaturePage is detected by S21', function () {
  if (throws(function () { assertS21(SRC); })) throw new Error('baseline S21 failed');
  var mutated = SRC.replace('function bfOpenCalendar(href, feature) {', 'App.openFeaturePage = function(href, feature) { function bfOpenCalendar(href, feature) {');
  if (mutated === SRC) throw new Error('mutation no-op: bfOpenCalendar pattern not found');
  if (!throws(function () { assertS21(mutated); })) throw new Error('mutant NOT detected by S21 (false green)');
});

// M8 → S18: 移除 openAddModal 的 Escape 监听器清理
  test('M8: mutation — removing listener cleanup from openAddModal is detected by S18', function () {
  if (throws(function () { assertS18(SRC); })) throw new Error('baseline S18 failed');
  var mutated = SRC.replace(/removeEventListener.*amOnKey/g, '/* removed cleanup */');
  if (mutated === SRC) throw new Error('mutation no-op: amOnKey cleanup pattern not found');
  if (!throws(function () { assertS18(mutated); })) throw new Error('mutant NOT detected by S18 (false green)');
});

// M9 → S19: 移除月结单弹窗的 role=dialog
  test('M9: mutation — removing role=dialog from monthly invoice picker is detected by S19', function () {
  if (throws(function () { assertS19(SRC); })) throw new Error('baseline S19 failed');
  var mutated = SRC.replace('role="dialog" aria-modal="true" aria-labelledby="bf-monthly-invoice-heading"', 'role="banner" aria-modal="true" aria-labelledby="bf-monthly-invoice-heading"');
  if (mutated === SRC) throw new Error('mutation no-op: role=dialog pattern not found in monthly picker');
  if (!throws(function () { assertS19(mutated); })) throw new Error('mutant NOT detected by S19 (false green)');
});

// ---- Summary ----
console.log('');
console.log('=== XJ-4.2.2-billing-shell-ui-v1 contract (hardened) ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);

var sha = crypto.createHash('sha256').update(SRC).digest('hex');
console.log('billing_shell_sha256: ' + sha);

if (failed > 0) {
  console.log('contract_phase: CONTRACT-BROKEN');
  process.exit(1);
} else {
  console.log('contract_phase: ALL-GREEN');
  console.log('注：仅验证 4.2.2 账务工作区 UI 契约，不宣称 release-ready。');
  process.exit(0);
}
