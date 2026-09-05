/* ============================================================
   心镜 XinJing — v4.2.2-A 共享 UI 契约运行时
   ------------------------------------------------------------
   职责：
   - 为八个可复用组件提供可测试的行为契约（非视觉实现）
   - PageHeader / IconButton / SegmentedControl / StatusChip /
     SourceRow / ContextDrawer / EmptyState / LoadingState
   - 六套主题：clinical / theatre / observatory × light / dark
   - 侧栏宽度预算：展开 224px、窄窗 178px、折叠 68px
   - 键盘、焦点、ARIA、错误态、加载态
   - 临床说明文字不低于 12px
   - 低动效：移除主动变换和非必要过渡
   - 不改变业务数据、不替换全产品视觉、不引入新框架
   ============================================================ */
'use strict';

const UIContract = (() => {
  const VERSION = '4.2.2-A';

  // --- 六套主题组合 ---
  const SKINS = ['clinical', 'theatre', 'observatory'];
  const MODES = ['light', 'dark'];
  const THEME_COMBINATIONS = SKINS.reduce((acc, skin) => {
    MODES.forEach((mode) => acc.push({ skin, mode, id: skin + '-' + mode }));
    return acc;
  }, []);

  // --- 侧栏宽度预算 ---
  const SIDEBAR_WIDTHS = { expanded: 224, narrow: 178, collapsed: 68 };

  // --- 最小临床文字尺寸 ---
  const MIN_FONT_PX = 12;

  // --- 八个组件及其文档化状态 ---
  const COMPONENTS = {
    PageHeader: {
      states: ['default', 'error', 'loading'],
      requiredAria: { role: 'banner' },
    },
    IconButton: {
      states: ['default', 'hover', 'focus', 'active', 'disabled'],
      requiredAria: { 'aria-label': 'string' },
    },
    SegmentedControl: {
      states: ['default', 'focus', 'selected'],
      requiredAria: { role: 'tablist' },
    },
    StatusChip: {
      states: ['default', 'success', 'warning', 'danger'],
      requiredAria: { role: 'status' },
    },
    SourceRow: {
      states: ['default', 'hover', 'focus', 'invalid'],
      requiredAria: { role: 'button', tabindex: '0' },
    },
    ContextDrawer: {
      states: ['open', 'closed'],
      requiredAria: { role: 'complementary', 'aria-hidden': 'boolean' },
    },
    EmptyState: {
      states: ['default'],
      requiredAria: { role: 'status' },
    },
    LoadingState: {
      states: ['default'],
      requiredAria: { role: 'status', 'aria-live': 'polite' },
    },
  };

  // --- 验证工具 ---
  function isString(v) { return typeof v === 'string' && v.length > 0; }
  function isBoolean(v) { return typeof v === 'boolean'; }

  function validateComponent(name, el) {
    if (!Object.prototype.hasOwnProperty.call(COMPONENTS, name)) {
      return { ok: false, error: 'Unknown component: ' + name };
    }
    const spec = COMPONENTS[name];
    const results = [];
    if (!el || typeof el !== 'object') {
      return { ok: false, error: 'Element must be an object' };
    }
    Object.keys(spec.requiredAria).forEach(function (attr) {
      const expected = spec.requiredAria[attr];
      const actual = el[attr] != null ? String(el[attr]) : '';
      if (expected === 'string' && !isString(actual)) {
        results.push({ attr, error: 'missing or empty string: ' + attr });
      } else if (expected === 'boolean' && !isBoolean(el[attr])) {
        results.push({ attr, error: 'missing boolean: ' + attr });
      }
    });
    return { ok: results.length === 0, issues: results, states: spec.states };
  }

  function validateTheme(id) {
    return THEME_COMBINATIONS.some(function (t) { return t.id === id; });
  }

  function validateSidebarWidth(mode, px) {
    if (!Object.prototype.hasOwnProperty.call(SIDEBAR_WIDTHS, mode)) return false;
    return SIDEBAR_WIDTHS[mode] === px;
  }

  function validateFontSize(px) {
    return typeof px === 'number' && px >= MIN_FONT_PX;
  }

  // --- 低动效规则 ---
  const REDUCED_MOTION_RULES = {
    removesActiveTransforms: true,
    removesNonessentialTransitions: true,
    keepsSpinnerState: true,
  };

  // --- 1024x700 宽度预算 ---
  const WIDTH_BUDGET = {
    minWidth: 1024,
    minHeight: 700,
    noHorizontalOverflow: true,
    sourceEntryReachable: true,
  };

  // --- 键盘 / 焦点契约 ---
  const KEYBOARD_CONTRACT = {
    focusVisible: true,
    focusRingColor: 'var(--xj-focus)',
    focusRingWidth: '2px',
    focusRingOffset: '2px',
    tabOrder: 'document-order',
    escapeClosesDrawer: true,
    enterActivatesButton: true,
    spaceActivatesButton: true,
  };

  // --- 导出 ---
  return {
    VERSION: VERSION,
    SKINS: SKINS,
    MODES: MODES,
    THEME_COMBINATIONS: THEME_COMBINATIONS,
    SIDEBAR_WIDTHS: SIDEBAR_WIDTHS,
    MIN_FONT_PX: MIN_FONT_PX,
    COMPONENTS: COMPONENTS,
    REDUCED_MOTION_RULES: REDUCED_MOTION_RULES,
    WIDTH_BUDGET: WIDTH_BUDGET,
    KEYBOARD_CONTRACT: KEYBOARD_CONTRACT,
    validateComponent: validateComponent,
    validateTheme: validateTheme,
    validateSidebarWidth: validateSidebarWidth,
    validateFontSize: validateFontSize,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UIContract;
