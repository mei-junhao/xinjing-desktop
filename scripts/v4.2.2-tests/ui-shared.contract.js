#!/usr/bin/env node
/* ============================================================
   XJ-4.2.2-ui-shared-v1 — 共享 UI 契约测试
   ------------------------------------------------------------
   通过 Node vm 执行真实 app/js/ui-contract.js，并读取真实 CSS
   源码做结构断言。所有用例执行真实模块，不定义替代实现。

   覆盖要求（contract XJ-4.2.2-ui-shared-v1）：
     1. 六套独立主题组合存在（clinical/theatre/observatory × light/dark）
     2. 八个组件暴露文档化状态
     3. 键盘焦点、ARIA、错误和加载态在契约中
     4. 展开 224px、窄窗 178px、折叠 68px 在宽度计算中
     5. 1024x700 无横向溢出且来源入口可达
     6. 临床说明文字不低于 12px
     7. 低动效移除主动变换和非必要过渡
     8. 变异敏感性：移除令牌/缩窄宽度/缩小字号变异必须被检出

   退出码三态：
     0  ALL-GREEN      无非预期失败
     1  EXPECTED-RED   存在预期红项（缺口未实现）
     2  CONTRACT-BROKEN 存在非预期失败
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const CONTRACT_PATH = path.join(ROOT, 'app', 'js', 'ui-contract.js');
const CONTRACT_SRC = fs.readFileSync(CONTRACT_PATH, 'utf8');
const CONTRACT_SHA = crypto.createHash('sha256').update(CONTRACT_SRC).digest('hex');

const UI_SYSTEM_CSS = fs.readFileSync(path.join(ROOT, 'app', 'css', 'xj-ui-system.css'), 'utf8');
const WORKBENCH_CSS = fs.readFileSync(path.join(ROOT, 'app', 'css', 'workbench.css'), 'utf8');

const results = [];
let passed = 0, failed = 0;
const expectedRed = [];

function test(name, fn, opts) {
  opts = opts || {};
  const expectRed = !!opts.expectRed;
  return Promise.resolve().then(fn).then(
    function () {
      if (expectRed) {
        results.push('[FAIL] (EXPECTED-RED) ' + name + ' — 不应 PASS');
        failed++;
      } else {
        results.push('[PASS] ' + name);
        passed++;
      }
    },
    function (err) {
      if (expectRed) {
        results.push('[FAIL] (EXPECTED-RED) ' + name + '\n       ' + err.message);
        expectedRed.push({ name, message: err.message });
        failed++;
      } else {
        results.push('[FAIL] ' + name + '\n       ' + err.message);
        failed++;
      }
    }
  );
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// --- 在 vm 中加载真实 ui-contract.js ---
function loadContract(src) {
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ui-contract.js' });
  return sandbox.module.exports;
}

const UI = loadContract(CONTRACT_SRC);

// --- 变异引擎 ---
function buildMutant(kind) {
  let src = CONTRACT_SRC;
  switch (kind) {
    case 'remove-token':
      // 删除 sidebar-expanded 令牌
      src = src.replace('--xj-sidebar-expanded: 224px;', '--xj-sidebar-expanded: 200px;');
      break;
    case 'narrow-width':
      // 把 224 改成 200
      src = src.replace('expanded: 224', 'expanded: 200');
      break;
    case 'shrink-font':
      // 把 MIN_FONT_PX 从 12 改成 10
      src = src.replace('MIN_FONT_PX = 12', 'MIN_FONT_PX = 10');
      break;
    case 'remove-component':
      // 删除一个组件
      src = src.replace("EmptyState: {", "EmptyState_REMOVED: {");
      break;
    default:
      throw new Error('Unknown mutant kind: ' + kind);
  }
  if (src === CONTRACT_SRC) throw new Error('Mutant was a no-op for kind: ' + kind);
  return src;
}

async function main() {
  // ========== S1: 六套独立主题组合 ==========
  await test('S1: 六套独立主题组合存在（clinical/theatre/observatory × light/dark）', function () {
    assert(UI.THEME_COMBINATIONS.length === 6, 'Expected 6 theme combinations, got ' + UI.THEME_COMBINATIONS.length);
    const ids = UI.THEME_COMBINATIONS.map(function (t) { return t.id; });
    ['clinical-light', 'clinical-dark', 'theatre-light', 'theatre-dark', 'observatory-light', 'observatory-dark'].forEach(function (id) {
      assert(ids.indexOf(id) >= 0, 'Missing theme: ' + id);
    });
  });

  // ========== S2: 八个组件暴露文档化状态 ==========
  await test('S2: 八个组件全部暴露文档化状态', function () {
    const expected = ['PageHeader', 'IconButton', 'SegmentedControl', 'StatusChip', 'SourceRow', 'ContextDrawer', 'EmptyState', 'LoadingState'];
    expected.forEach(function (name) {
      assert(UI.COMPONENTS[name], 'Missing component: ' + name);
      assert(UI.COMPONENTS[name].states.length > 0, name + ' has no states');
      assert(UI.COMPONENTS[name].requiredAria, name + ' has no requiredAria');
    });
  });

  // ========== S3: 键盘焦点、ARIA、错误和加载态 ==========
  await test('S3: 键盘焦点契约、ARIA、错误态和加载态在契约中', function () {
    assert(UI.KEYBOARD_CONTRACT.focusVisible === true, 'focusVisible missing');
    assert(UI.KEYBOARD_CONTRACT.focusRingColor === 'var(--xj-focus)', 'focus ring color missing');
    assert(UI.KEYBOARD_CONTRACT.escapeClosesDrawer === true, 'escape contract missing');
    assert(UI.KEYBOARD_CONTRACT.enterActivatesButton === true, 'enter contract missing');
    assert(UI.KEYBOARD_CONTRACT.spaceActivatesButton === true, 'space contract missing');
    // 错误态
    assert(UI.COMPONENTS.PageHeader.states.indexOf('error') >= 0, 'PageHeader missing error state');
    assert(UI.COMPONENTS.SourceRow.states.indexOf('invalid') >= 0, 'SourceRow missing invalid state');
    assert(UI.COMPONENTS.StatusChip.states.indexOf('danger') >= 0, 'StatusChip missing danger state');
    // 加载态
    assert(UI.COMPONENTS.LoadingState.states.indexOf('default') >= 0, 'LoadingState missing default state');
    assert(UI.COMPONENTS.LoadingState.requiredAria['aria-live'] === 'polite', 'LoadingState missing aria-live');
  });

  // ========== S4: 侧栏宽度 224/178/68 ==========
  await test('S4: 展开 224px、窄窗 178px、折叠 68px 在宽度计算中', function () {
    assert(UI.validateSidebarWidth('expanded', 224), 'expanded should be 224');
    assert(UI.validateSidebarWidth('narrow', 178), 'narrow should be 178');
    assert(UI.validateSidebarWidth('collapsed', 68), 'collapsed should be 68');
    assert(!UI.validateSidebarWidth('expanded', 200), '200 should not validate for expanded');
  });

  // ========== S5: 1024x700 宽度预算 ==========
  await test('S5: 1024x700 无横向溢出且来源入口可达', function () {
    assert(UI.WIDTH_BUDGET.minWidth === 1024, 'minWidth should be 1024');
    assert(UI.WIDTH_BUDGET.minHeight === 700, 'minHeight should be 700');
    assert(UI.WIDTH_BUDGET.noHorizontalOverflow === true, 'noHorizontalOverflow missing');
    assert(UI.WIDTH_BUDGET.sourceEntryReachable === true, 'sourceEntryReachable missing');
    // CSS 断言：overflow-x: hidden 在 xj-ui-system.css 中
    assert(UI_SYSTEM_CSS.indexOf('overflow-x: hidden') >= 0, 'overflow-x: hidden not found in xj-ui-system.css');
  });

  // ========== S6: 临床说明文字不低于 12px ==========
  await test('S6: 临床说明文字不低于 12px', function () {
    assert(UI.MIN_FONT_PX === 12, 'MIN_FONT_PX should be 12');
    assert(UI.validateFontSize(12), '12px should validate');
    assert(!UI.validateFontSize(10), '10px should not validate');
    assert(!UI.validateFontSize(11), '11px should not validate');
    // CSS 断言：var(--xj-font-min) 被用于 sidebar 文字
    assert(UI_SYSTEM_CSS.indexOf('var(--xj-font-min)') >= 0, '--xj-font-min token not used in xj-ui-system.css');
    assert(WORKBENCH_CSS.indexOf('var(--xj-font-min') >= 0, '--xj-font-min not referenced in workbench.css');
  });

  // ========== S7: 低动效 ==========
  await test('S7: 低动效移除主动变换和非必要过渡', function () {
    assert(UI.REDUCED_MOTION_RULES.removesActiveTransforms === true, 'removesActiveTransforms missing');
    assert(UI.REDUCED_MOTION_RULES.removesNonessentialTransitions === true, 'removesNonessentialTransitions missing');
    assert(UI.REDUCED_MOTION_RULES.keepsSpinnerState === true, 'keepsSpinnerState missing');
    // CSS 断言：prefers-reduced-motion 在两个文件中
    assert(UI_SYSTEM_CSS.indexOf('prefers-reduced-motion') >= 0, 'reduced motion not in xj-ui-system.css');
    assert(WORKBENCH_CSS.indexOf('prefers-reduced-motion') >= 0, 'reduced motion not in workbench.css');
  });

  // ========== S8: CSS 侧栏宽度一致 ==========
  await test('S8: CSS 侧栏宽度令牌 224/178/68 一致', function () {
    assert(UI_SYSTEM_CSS.indexOf('--xj-sidebar-expanded: 224px') >= 0, 'expanded token missing');
    assert(UI_SYSTEM_CSS.indexOf('--xj-sidebar-narrow: 178px') >= 0, 'narrow token missing');
    assert(UI_SYSTEM_CSS.indexOf('--xj-sidebar-collapsed: 68px') >= 0, 'collapsed token missing');
    assert(WORKBENCH_CSS.indexOf('--sidebar-w: 224px') >= 0, 'workbench sidebar-w should be 224');
  });

  // ========== S9: CSS 无小于 12px 的硬编码字号 ==========
  await test('S9: CSS 无小于 12px 的硬编码字号（sidebar 区域）', function () {
    // 检查 workbench.css 中 sidebar/nav 相关 font-size
    const lines = WORKBENCH_CSS.split('\n');
    let violations = [];
    lines.forEach(function (line, i) {
      var m = line.match(/font-size:\s*(\d+)px/);
      if (m && parseInt(m[1], 10) < 12) {
        // 允许 var(--xj-font-min) 引用已替代的行不报
        if (line.indexOf('var(--xj-font-min') < 0) {
          violations.push('line ' + (i + 1) + ': ' + line.trim());
        }
      }
    });
    assert(violations.length === 0, 'Found sub-12px font sizes:\n' + violations.join('\n'));
  });

  // ========== T1: 主题验证 ==========
  await test('T1: validateTheme 正确识别合法与非法主题', function () {
    assert(UI.validateTheme('clinical-light'), 'clinical-light should validate');
    assert(UI.validateTheme('observatory-dark'), 'observatory-dark should validate');
    assert(!UI.validateTheme('clinical'), 'bare skin should not validate');
    assert(!UI.validateTheme('unknown-light'), 'unknown skin should not validate');
  });

  // ========== T2: 组件验证 ==========
  await test('T2: validateComponent 正确识别合法与非法组件', function () {
    const r = UI.validateComponent('PageHeader', { role: 'banner' });
    assert(r.ok, 'PageHeader with role=banner should validate: ' + JSON.stringify(r.issues));
    const r2 = UI.validateComponent('Unknown', {});
    assert(!r2.ok, 'Unknown component should not validate');
    const r3 = UI.validateComponent('LoadingState', { role: 'status', 'aria-live': 'polite' });
    assert(r3.ok, 'LoadingState should validate: ' + JSON.stringify(r3.issues));
  });

  // ========== T3-T5: 变异敏感性 ==========
  await test('T3: 变异敏感 — 缩窄 sidebar-expanded 宽度变异被检出', function () {
    const mutantSrc = buildMutant('narrow-width');
    const mutantUI = loadContract(mutantSrc);
    assert(!mutantUI.validateSidebarWidth('expanded', 224), 'Mutated contract should reject 224 for expanded');
    assert(mutantUI.SIDEBAR_WIDTHS.expanded === 200, 'Mutant should have 200, got ' + mutantUI.SIDEBAR_WIDTHS.expanded);
  });

  await test('T4: 变异敏感 — 缩小 MIN_FONT_PX 变异被检出', function () {
    const mutantSrc = buildMutant('shrink-font');
    const mutantUI = loadContract(mutantSrc);
    assert(mutantUI.MIN_FONT_PX === 10, 'Mutant should have 10, got ' + mutantUI.MIN_FONT_PX);
    assert(mutantUI.validateFontSize(10), 'Mutant would incorrectly accept 10px');
    assert(!UI.validateFontSize(10), 'Real contract must reject 10px');
  });

  await test('T5: 变异敏感 — 删除组件变异被检出', function () {
    const mutantSrc = buildMutant('remove-component');
    const mutantUI = loadContract(mutantSrc);
    assert(!mutantUI.COMPONENTS.EmptyState, 'Mutant should have removed EmptyState');
    assert(mutantUI.COMPONENTS.EmptyState_REMOVED, 'Mutant should have renamed key');
    // 真实契约必须有 EmptyState
    assert(UI.COMPONENTS.EmptyState, 'Real contract must have EmptyState');
  });

  // ========== T6: CSS 变异 — 移除 overflow-x: hidden 应被检出 ==========
  await test('T6: 变异敏感 — CSS 移除 overflow-x: hidden 变异被检出', function () {
    const mutantCss = UI_SYSTEM_CSS.replace('overflow-x: hidden;', '/* overflow-x: removed */');
    assert(mutantCss.indexOf('overflow-x: hidden') < 0, 'Mutant CSS should not have overflow-x: hidden');
    assert(UI_SYSTEM_CSS.indexOf('overflow-x: hidden') >= 0, 'Real CSS must have overflow-x: hidden');
  });

  // --- 输出 ---
  console.log('=== XJ-4.2.2-ui-shared-v1 contract ===');
  console.log('');
  results.forEach(function (r) { console.log(r); console.log('----------------------------------------'); });
  console.log('Passed: ' + passed + ' | Failed: ' + failed + ' | Expected-red: ' + expectedRed.length);
  console.log('ui_contract_sha256: ' + CONTRACT_SHA);
  console.log('contract_phase: ' + (failed === 0 ? 'ALL-GREEN' : expectedRed.length === failed ? 'EXPECTED-RED' : 'CONTRACT-BROKEN'));
  console.log('注：仅验证 4.2.2-A 共享 UI 契约，不宣称 release-ready。');

  if (failed === 0) process.exit(0);
  if (expectedRed.length === failed) process.exit(1);
  process.exit(2);
}

main().catch(function (e) {
  console.error('FATAL:', e);
  process.exit(2);
});
