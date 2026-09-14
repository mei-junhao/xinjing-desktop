'use strict';
/**
 * dark-cta-contrast.test.js — XinJing 5.0.0 G9 dark 主 CTA 对比度生产修复（方案 B）
 *
 * 契约: XJ-5.0.0-G9-DARK-CTA-CONTRAST-PRODUCTION-REMEDIATION-V1
 * 任务: XJ-5.0.0-g9-dark-cta-contrast-production-remediation-001
 *
 * Codex 冻结决定（方案 B）：
 *   - Clinical/Theatre/Observatory dark 各新增语义令牌
 *     --cta-bg: #123c34 / #5b2330 / #144047（白字对比 12.20 / 12.15 / 11.33，WCAG AA）
 *   - 浅色 --accent 保持不变，继续服务链接、图标、focus、active 前景（禁止方案 A）
 *   - 主 CTA 背景统一 var(--cta-bg, var(--accent))，hover 必须有 dark-safe --cta-bg-hover
 *   - 只映射真正的 primary/active CTA；secondary/ghost/链接/图标/状态文字不得被污染
 *   - control（修复前 dark accent 白字对比）= 2.47 / 3.58 / 2.24（全部 <4.5，expected-red）
 *
 * 覆盖：
 *   ER expected-red：修复前状态（删 token / 回退 accent）必须 FAIL；control 值 <4.5
 *   T2 normal/hover/focus 全部 >=4.5（三皮肤 dark）
 *   T3 生产选择器映射完整（style/components/workbench + 小镜 xinjing-chat/xiaojing-panel）
 *   T4 light 零回归（浅色 accent 原值、白字对比 >=4.5、light 不定义 --cta-bg）
 *   T5 dark accent 前景保留浅色（链接/图标/focus/active 前景不回归）
 *   T6 非 CTA 保护（chip/pill/brand/kv-card/msg.user 不被污染；禁止页面级硬编码补丁）
 *   T7 反向变异 12 例全部 KILLED（含伪造 ratio 守卫）
 *
 * 运行: node --test tests/v5.0.0-production/dark-cta-contrast.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- WCAG 相对亮度 / 对比度 ----------
function srgbChan(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function luminance(hex) {
  hex = String(hex).trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return 0.2126 * srgbChan((n >> 16) & 255) + 0.7152 * srgbChan((n >> 8) & 255) + 0.0722 * srgbChan(n & 255);
}
function contrastRatio(a, b) {
  const l1 = luminance(a); const l2 = luminance(b);
  const hi = Math.max(l1, l2); const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- 最小 CSS 规则提取（按选择器取声明块；无 @media 嵌套依赖） ----------
function extractBlocks(css) {
  // 返回 [{selectorText, body}]，跳过注释；不展开 @media（皮肤令牌块均在顶层）
  const out = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0; let selStart = 0; let bodyStart = -1; let currentSel = '';
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === '{') {
      if (depth === 0) { currentSel = noComments.slice(selStart, i).trim(); bodyStart = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && currentSel) {
        out.push({ selectorText: currentSel, body: noComments.slice(bodyStart, i) });
        currentSel = ''; selStart = i + 1;
      } else if (depth < 0) { depth = 0; }
    }
  }
  return out;
}
function parseDecls(body) {
  const decls = {};
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 1) continue;
    const prop = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (prop) decls[prop] = val; // 后声明覆盖（与 CSS 层叠一致，用于同块重复属性）
  }
  return decls;
}
function blockFor(css, selectorIncludes) {
  const blocks = extractBlocks(css);
  const hit = blocks.filter((b) => b.selectorText.split(',').map((s) => s.trim()).some((s) => s.includes(selectorIncludes)));
  return hit;
}
function tokenMap(css, selectorIncludes) {
  const maps = blockFor(css, selectorIncludes).map((b) => parseDecls(b.body));
  return Object.assign({}, ...maps);
}
// 精确选择器匹配（逗号分隔的每一段 trim 后全等）：皮肤令牌块 light/dark 必须严格分开
function tokenMapExact(css, selector) {
  const blocks = extractBlocks(css);
  const maps = blocks
    .filter((b) => b.selectorText.split(',').map((s) => s.trim()).some((s) => s === selector))
    .map((b) => parseDecls(b.body));
  return Object.assign({}, ...maps);
}

// ---------- var() 解析（支持嵌套回退） ----------
function resolveVar(expr, map, depth) {
  depth = depth || 0;
  if (depth > 8) return null;
  expr = String(expr || '').trim();
  const m = expr.match(/^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([\s\S]*))?\)$/);
  if (!m) return /^#[0-9a-fA-F]{3,8}$/.test(expr) ? expr.toLowerCase() : expr;
  const name = m[1];
  if (map[name] !== undefined) return resolveVar(map[name], map, depth + 1);
  if (m[2] !== undefined) return resolveVar(m[2].trim(), map, depth + 1);
  return null; // 未定义且无回退 → invalid at computed-value time
}

// ---------- 冻结常量（Codex 裁决方案 B） ----------
const SKINS = {
  clinical: {
    lightAccent: '#147d70', lightSurface: '#ffffff', lightAccentHover: '#0f685d',
    darkAccent: '#50b5a5', darkAccentHover: '#78c7bb', darkSurface: '#1d2724',
    ctaBg: '#123c34', ctaBgHover: '#185045', controlRatio: 2.47, targetRatio: 12.20,
    darkSel: '[data-skin="clinical"].dark', lightSel: '[data-skin="clinical"]',
  },
  theatre: {
    lightAccent: '#7a3945', lightSurface: '#fbfaf6', lightAccentHover: '#612b35',
    darkAccent: '#c96b78', darkAccentHover: '#df8793', darkSurface: '#241f1c',
    ctaBg: '#5b2330', ctaBgHover: '#722e3c', controlRatio: 3.58, targetRatio: 12.15,
    darkSel: '[data-skin="theatre"].dark', lightSel: '[data-skin="theatre"]',
  },
  observatory: {
    lightAccent: '#1f6166', lightSurface: '#ffffff', lightAccentHover: '#16504a',
    darkAccent: '#68bac1', darkAccentHover: '#84ced4', darkSurface: '#1a2225',
    ctaBg: '#144047', ctaBgHover: '#1d5761', controlRatio: 2.24, targetRatio: 11.33,
    darkSel: '[data-skin="observatory"].dark', lightSel: '[data-skin="observatory"]:not(.dark)',
  },
};
const MIN_AA = 4.5;

function loadSources(root) {
  root = root || ROOT;
  return {
    uiSystem: fs.readFileSync(path.join(root, 'app/css/xj-ui-system.css'), 'utf8'),
    style: fs.readFileSync(path.join(root, 'app/css/style.css'), 'utf8'),
    components: fs.readFileSync(path.join(root, 'app/css/components.css'), 'utf8'),
    workbench: fs.readFileSync(path.join(root, 'app/css/workbench.css'), 'utf8'),
    index: fs.readFileSync(path.join(root, 'app/index.html'), 'utf8'),
    chatJs: fs.readFileSync(path.join(root, 'app/js/xinjing-chat.js'), 'utf8'),
    panelJs: fs.readFileSync(path.join(root, 'app/js/xiaojing-panel.js'), 'utf8'),
  };
}

// 主 CTA 背景解析：模拟生产选择器 var(--cta-bg, var(--accent)) 在给定皮肤令牌图上的级联结果
function ctaBackgroundFor(skinMap) {
  return resolveVar('var(--cta-bg, var(--accent))', skinMap);
}
function ctaHoverBackgroundFor(skinMap) {
  // 生产 hover 选择器统一为 var(--cta-bg-hover, var(--accent-hover))
  return resolveVar('var(--cta-bg-hover, var(--accent-hover))', skinMap);
}

// 生产选择器映射契约：必须全部以 var(--cta-bg 作为背景（禁止硬编码/回退 accent）
const SELECTOR_CONTRACTS = [
  { file: 'style', selector: '.btn-primary', note: '全局主按钮' },
  { file: 'components', selector: '.actions button.primary', note: '记录操作组主按钮' },
  { file: 'components', selector: '.quick button.primary', note: '快捷动作主按钮' },
  { file: 'components', selector: '.ai-actions button.primary', note: 'AI 动作主按钮' },
  { file: 'components', selector: '.dock-actions button.primary', note: '记账坞主按钮' },
  { file: 'workbench', selector: '.btn-primary', note: '工作台主按钮（含 .foot-actions）' },
  { file: 'workbench', selector: '.xj-new-client', note: '新建来访者' },
  { file: 'workbench', selector: '.chat-send', note: '会谈聊天发送' },
  { file: 'workbench', selector: '.btn-new', note: '日历新建' },
  { file: 'workbench', selector: '.btn-p', note: '报告主按钮' },
  { file: 'workbench', selector: '.input-bar button', note: '转写输入条发送' },
  { file: 'workbench', selector: '.kb-btn.primary', note: '知识库主按钮' },
  { file: 'workbench', selector: '.chat-input button', note: '咨询聊天发送' },
  { file: 'index', selector: '.topbar .start-next', note: '首页“开始下一场”主 CTA' },
  { file: 'index', selector: '.xj-float-btn', note: '首页小镜浮动按钮' },
  { file: 'index', selector: '.xj-input-row button', note: '首页内嵌对话发送' },
  { file: 'index', selector: '.wb-primary', note: '双栏工作台主按钮' },
];
// 小镜（悬浮面板）主 CTA：两套实现都必须遵守契约
const MIRROR_CTA_RULES = ['.xj3-fab', '.xj3-activate-btn', '.xj3-input-row button', '.xj3-confirm-actions .xj3-ok', '.xj3-nav-go'];

// 页面级硬编码补丁黑名单：三个 dark CTA 表面色只允许出现在皮肤令牌文件
const HARDCODE_HEXES = ['#123c34', '#5b2330', '#144047'];

function selectorMatches(part, target) {
  part = part.trim();
  // 目标必须是最末复合选择器（允许前缀组合器），排除后代选择器如 ".btn-primary .trail"
  return part === target || part.endsWith(' ' + target) || part.endsWith('>' + target) || part.endsWith('+' + target) || part.endsWith('~' + target);
}
function backgroundOf(css, selectorIncludes, stateSuffix) {
  const blocks = extractBlocks(css);
  let bg = null;
  for (const b of blocks) {
    const sels = b.selectorText.split(',').map((s) => s.trim());
    for (const s of sels) {
      if (!selectorMatches(s, selectorIncludes)) continue;
      if (stateSuffix && !s.includes(stateSuffix)) continue;
      if (!stateSuffix && s.includes(':hover')) continue;
      const d = parseDecls(b.body);
      if (d.background !== undefined) bg = d.background;
      else if (d['background-color'] !== undefined) bg = d['background-color'];
    }
  }
  return bg;
}

/** 核心验证器：返回 { ok, failures: [...] }。只依据结构化规则推导，不信任任何注释/声称。 */
function validate(src) {
  const failures = [];
  const fail = (msg) => failures.push(msg);

  for (const [skinName, k] of Object.entries(SKINS)) {
    const darkMap = tokenMapExact(src.uiSystem, k.darkSel);
    const lightMapSafe = tokenMapExact(src.uiSystem, k.lightSel);

    // --- T2 normal: dark 主 CTA 背景必须是冻结表面色且 >=4.5 ---
    const ctaBgRaw = darkMap['--cta-bg'];
    if (ctaBgRaw === undefined) { fail(`${skinName} dark 缺少 --cta-bg 令牌`); }
    else {
      const ctaBg = resolveVar(ctaBgRaw, darkMap);
      if (ctaBg !== k.ctaBg) fail(`${skinName} --cta-bg=${ctaBg}，期望 ${k.ctaBg}`);
      if (ctaBg && contrastRatio('#ffffff', ctaBg) < MIN_AA) fail(`${skinName} dark CTA normal 对比 ${contrastRatio('#ffffff', ctaBg).toFixed(2)} <4.5`);
    }

    // --- T2 hover: 必须有 dark-safe --cta-bg-hover 且 >=4.5 ---
    const hoverRaw = darkMap['--cta-bg-hover'];
    if (hoverRaw === undefined) { fail(`${skinName} dark 缺少 --cta-bg-hover（hover 将回退浅色 accent-hover）`); }
    else {
      const hoverBg = resolveVar(hoverRaw, darkMap);
      if (!hoverBg || !/^#/.test(hoverBg)) fail(`${skinName} --cta-bg-hover 解析失败: ${hoverBg}`);
      else if (contrastRatio('#ffffff', hoverBg) < MIN_AA) fail(`${skinName} dark CTA hover 对比 ${contrastRatio('#ffffff', hoverBg).toFixed(2)} <4.5`);
    }

    // --- T2 focus: focus 状态背景与 normal 相同（outline 走 --xj-focus），对比 >=4.5 ---
    if (darkMap['--xj-focus'] === undefined) fail(`${skinName} dark 缺少 --xj-focus（focus-visible 外框令牌）`);

    // --- T4 light 零回归：浅色 accent 原值 + 白字 >=4.5 + light 不得定义 --cta-bg ---
    const lightAccent = resolveVar(lightMapSafe['--accent'] || lightMapSafe['--xj-accent'], lightMapSafe);
    if (lightAccent !== k.lightAccent) fail(`${skinName} light accent 变为 ${lightAccent}，期望 ${k.lightAccent}（误伤 light）`);
    if (lightAccent && contrastRatio('#ffffff', lightAccent) < MIN_AA) fail(`${skinName} light CTA 白字对比回归 <4.5`);
    if (lightMapSafe['--cta-bg'] !== undefined) fail(`${skinName} light 不应定义 --cta-bg（dark 专用语义）`);

    // --- T5 dark 前景保留浅色 accent（链接/图标/focus/active 前景语义） ---
    const darkAccent = resolveVar(darkMap['--xj-accent'], darkMap);
    if (darkAccent !== k.darkAccent) fail(`${skinName} dark --xj-accent 变为 ${darkAccent}，期望 ${k.darkAccent}（深色 accent 前景回归）`);
    if (darkAccent && contrastRatio(darkAccent, k.darkSurface) < MIN_AA) fail(`${skinName} dark accent 前景对表面对比 <4.5`);
  }

  // --- T3 生产选择器映射 ---
  for (const c of SELECTOR_CONTRACTS) {
    const css = src[c.file];
    const bg = backgroundOf(css, c.selector, null);
    if (bg === null) { fail(`选择器 ${c.selector}（${c.note}）未找到 background 声明`); continue; }
    if (!String(bg).includes('var(--cta-bg')) fail(`选择器 ${c.selector}（${c.note}）背景未走语义 --cta-bg: ${bg}`);
  }
  // hover 声明（style/.btn-primary 与 components 四个 primary）必须走 --cta-bg-hover
  const hoverChecks = [
    { file: 'style', selector: '.btn-primary:hover' },
    { file: 'components', selector: '.actions button.primary:hover' },
    { file: 'components', selector: '.quick button.primary:hover' },
    { file: 'components', selector: '.ai-actions button.primary:hover' },
    { file: 'components', selector: '.dock-actions button.primary:hover' },
    { file: 'index', selector: '.topbar .start-next:hover' },
    { file: 'index', selector: '.xj-float-btn:hover' },
    { file: 'index', selector: '.xj-input-row button:hover' },
  ];
  for (const h of hoverChecks) {
    const blocks = extractBlocks(src[h.file]);
    let found = null;
    for (const b of blocks) {
      if (b.selectorText.split(',').map((s) => s.trim()).some((s) => s.includes(h.selector))) {
        const d = parseDecls(b.body);
        if (d.background) found = d.background;
      }
    }
    if (!found || !String(found).includes('var(--cta-bg-hover')) fail(`hover 声明 ${h.selector} 未走 --cta-bg-hover: ${found}`);
  }

  // --- T3 小镜契约：两套实现都必须映射（防止只修首页 / 只修小镜） ---
  for (const [label, js] of [['xinjing-chat.js', src.chatJs], ['xiaojing-panel.js', src.panelJs]]) {
    for (const rule of MIRROR_CTA_RULES) {
      const esc = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 允许该规则在此文件中不存在（如 panel 无 nav-go），但存在的必须走 --cta-bg
      const re = new RegExp(esc.replace(/\\\./g, '\\.') + '\\{[^}]*background:(var\\(--accent\\)|#[0-9a-fA-F]{3,8})', 'g');
      const m = js.match(re);
      if (m && m.length > 0) fail(`${label} 的 ${rule} 仍用旧背景: ${m[0].slice(0, 80)}`);
      const present = new RegExp(esc + '\\{').test(js);
      if (present) {
        const ok = new RegExp(esc + '\\{[^}]*background:var\\(--cta-bg').test(js);
        if (!ok) fail(`${label} 的 ${rule} 存在但未走 --cta-bg`);
      }
    }
  }

  // --- T6 非 CTA 保护 + 禁止页面级硬编码补丁 ---
  const kbChip = backgroundOf(src.workbench, '.kb-chip.active', null);
  if (kbChip && String(kbChip).includes('--cta-bg')) fail('.kb-chip.active 被 CTA 深色背景污染');
  const pillActive = backgroundOf(src.components, '.pill.active', null);
  if (pillActive && String(pillActive).includes('--cta-bg')) fail('.pill.active 被 CTA 深色背景污染');
  const userMsg = /xj3-msg\.user\{[^}]*background:var\(--cta-bg/.test(src.chatJs);
  if (userMsg) fail('.xj3-msg.user 气泡被 CTA 深色背景污染（非 CTA）');
  for (const hex of HARDCODE_HEXES) {
    for (const [label, text] of [['style.css', src.style], ['components.css', src.components], ['workbench.css', src.workbench], ['index.html', src.index], ['xinjing-chat.js', src.chatJs], ['xiaojing-panel.js', src.panelJs]]) {
      if (text.toLowerCase().includes(hex)) fail(`页面级硬编码补丁：${label} 直接写入 ${hex}（必须经 xj-ui-system.css 语义令牌）`);
    }
  }

  return { ok: failures.length === 0, failures };
}

// ---------- 变异算子 ----------
const MUTATIONS = [
  {
    id: 'M1-delete-token-clinical', desc: '删除 clinical dark --cta-bg（回退浅色 accent）',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--cta-bg: #123c34;', '') }),
  },
  {
    id: 'M2-fallback-accent-cheat', desc: '把 clinical --cta-bg 改成 var(--xj-accent)（假分离）',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--cta-bg: #123c34;', '--cta-bg: var(--xj-accent);') }),
  },
  {
    id: 'M3-components-only-miss', desc: '只漏 components.css .actions button.primary',
    apply: (s) => ({ ...s, components: s.components.replace('.actions button.primary { background: var(--cta-bg, var(--accent));', '.actions button.primary { background: var(--accent);') }),
  },
  {
    id: 'M4-mirror-only-miss', desc: '只漏小镜 xinjing-chat.js .xj3-fab',
    apply: (s) => ({ ...s, chatJs: s.chatJs.replace(".xj3-fab{position:fixed;right:20px;bottom:24px;width:52px;height:52px;border-radius:50%;border:none;' +\n        'background:var(--cta-bg,var(--accent));", ".xj3-fab{position:fixed;right:20px;bottom:24px;width:52px;height:52px;border-radius:50%;border:none;' +\n        'background:var(--accent);") }),
  },
  {
    id: 'M5-hover-fallback-light', desc: 'clinical --cta-bg-hover 回退浅色 #78c7bb',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--cta-bg-hover: #185045;', '--cta-bg-hover: #78c7bb;') }),
  },
  {
    id: 'M6-light-collateral', desc: '误伤 light：clinical light accent 改成 dark 值',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--xj-accent: #147d70;', '--xj-accent: #50b5a5;') }),
  },
  {
    id: 'M7-dark-foreground-regression', desc: 'dark accent 前景回归：clinical dark --xj-accent 改深色',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--xj-accent: #50b5a5;', '--xj-accent: #123c34;') }),
  },
  {
    id: 'M9-hardcoded-page-patch', desc: '页面级硬编码补丁：workbench 直接写 #123c34',
    apply: (s) => ({ ...s, workbench: s.workbench.replace('background: var(--cta-bg, var(--accent)) !important; color: #fff !important;', 'background: #123c34 !important; color: #fff !important;') }),
  },
  {
    id: 'M10-homepage-only-miss', desc: '只漏 workbench.css .btn-primary（首页/工作台层）',
    apply: (s) => ({ ...s, workbench: s.workbench.replace('.btn-primary, .quick button.primary, .foot-actions .btn-primary { background: var(--cta-bg, var(--accent));', '.btn-primary, .quick button.primary, .foot-actions .btn-primary { background: var(--accent);') }),
  },
  {
    id: 'M11-delete-token-theatre', desc: '删除 theatre dark --cta-bg',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--cta-bg: #5b2330;', '') }),
  },
  {
    id: 'M12-delete-hover-token', desc: '删除 observatory dark --cta-bg-hover（hover 回退浅色 accent-hover）',
    apply: (s) => ({ ...s, uiSystem: s.uiSystem.replace('--cta-bg-hover: #1d5761;', '') }),
  },
  {
    id: 'M13-panel-mirror-miss', desc: '只漏 xiaojing-panel.js 镜像实现',
    apply: (s) => ({ ...s, panelJs: s.panelJs.replace("'.xj3-input-row button{background:var(--cta-bg,var(--accent));", "'.xj3-input-row button{background:var(--accent);") }),
  },
  {
    id: 'M14-index-homepage-cta-miss', desc: '只漏首页 .topbar .start-next（截图页面之外的主 CTA）',
    apply: (s) => ({ ...s, index: s.index.replace('background:var(--cta-bg,var(--accent));color:#fff;font:650 13px var(--sans);cursor:pointer}', 'background:var(--accent);color:#fff;font:650 13px var(--sans);cursor:pointer}') }),
  },
];

test('ER expected-red：control 三皮肤修复前 dark CTA 白字对比 <4.5（证明测试灵敏度）', () => {
  for (const [skinName, k] of Object.entries(SKINS)) {
    const r = contrastRatio('#ffffff', k.darkAccent);
    assert.ok(r < MIN_AA, `${skinName} control ${r.toFixed(2)} 应 <4.5`);
    assert.ok(Math.abs(r - k.controlRatio) < 0.005, `${skinName} control ratio ${r.toFixed(2)} 应等于冻结证据 ${k.controlRatio}`);
    const target = contrastRatio('#ffffff', k.ctaBg);
    assert.ok(target >= MIN_AA, `${skinName} 目标 ${target.toFixed(2)} 应 >=4.5`);
    assert.ok(Math.abs(target - k.targetRatio) < 0.005, `${skinName} 目标 ratio ${target.toFixed(2)} 应等于冻结证据 ${k.targetRatio}`);
  }
  // 伪造 ratio 守卫：公式本身必须可信（否则上面 <4.5 断言无意义）
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 1e-9, 'ratio(白,白) 必须 =1');
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01, 'ratio(白,黑) 必须 =21');
});

test('ER expected-red：修复前状态（删除 --cta-bg 令牌）验证器必须 FAIL', () => {
  const src = loadSources();
  const preFix = { ...src, uiSystem: src.uiSystem.replace(/--cta-bg: #[0-9a-f]{6};\r?\n/g, '').replace(/--cta-bg-hover: #[0-9a-f]{6};\r?\n/g, '') };
  const v = validate(preFix);
  assert.strictEqual(v.ok, false, '修复前状态必须 FAIL（dark CTA 回退浅色 accent = 2.47/3.58/2.24 <4.5）');
  assert.ok(v.failures.some((f) => f.includes('缺少 --cta-bg')), 'FAIL 原因必须包含令牌缺失/对比不足');
});

test('T2 生产状态：三皮肤 dark 主 CTA normal/hover/focus 全部 >=4.5', () => {
  const src = loadSources();
  const v = validate(src);
  assert.deepStrictEqual(v.failures, [], '生产 CSS 验证失败: ' + v.failures.join(' | '));
  // 独立复核：不经 validate，直接从令牌图解析级联背景
  for (const [skinName, k] of Object.entries(SKINS)) {
    const darkMap = tokenMapExact(src.uiSystem, k.darkSel);
    const normal = ctaBackgroundFor(darkMap);
    const hover = ctaHoverBackgroundFor(darkMap);
    assert.strictEqual(normal, k.ctaBg, `${skinName} normal 级联背景应为 ${k.ctaBg}，实为 ${normal}`);
    assert.ok(contrastRatio('#ffffff', normal) >= MIN_AA, `${skinName} normal ${contrastRatio('#ffffff', normal).toFixed(2)}`);
    assert.ok(hover && /^#/.test(hover), `${skinName} hover 必须解析为确定色值，实为 ${hover}`);
    assert.ok(contrastRatio('#ffffff', hover) >= MIN_AA, `${skinName} hover ${contrastRatio('#ffffff', hover).toFixed(2)}`);
    // focus 状态：背景不变（:focus-visible 仅改 outline），对比沿用 normal，仍 >=4.5
    assert.ok(contrastRatio('#ffffff', normal) >= MIN_AA, `${skinName} focus 背景对比同 normal`);
    assert.ok(darkMap['--xj-focus'], `${skinName} focus 外框令牌存在`);
  }
});

test('T3 选择器映射：全部主 CTA 走 var(--cta-bg)，小镜两套实现契约一致', () => {
  const src = loadSources();
  for (const c of SELECTOR_CONTRACTS) {
    const bg = backgroundOf(src[c.file], c.selector, null);
    assert.ok(bg && String(bg).includes('var(--cta-bg'), `${c.selector}（${c.note}）背景必须走 --cta-bg，实为 ${bg}`);
    assert.ok(String(bg).includes('var(--accent)'), `${c.selector} 必须保留 light 回退 var(--accent)`);
  }
  for (const [label, js] of [['xinjing-chat.js', src.chatJs], ['xiaojing-panel.js', src.panelJs]]) {
    assert.ok(/xj3-fab\{[^}]*background:var\(--cta-bg/.test(js), `${label} .xj3-fab 必须走 --cta-bg`);
    assert.ok(/xj3-input-row button\{background:var\(--cta-bg/.test(js), `${label} .xj3-input-row button 必须走 --cta-bg`);
    assert.ok(/xj3-confirm-actions \.xj3-ok\{background:var\(--cta-bg/.test(js), `${label} .xj3-ok 必须走 --cta-bg`);
  }
});

test('T4 light 零回归：浅色 accent 原值、light CTA 白字 >=4.5、light 无 --cta-bg', () => {
  const src = loadSources();
  for (const [skinName, k] of Object.entries(SKINS)) {
    const lightMap = tokenMapExact(src.uiSystem, k.lightSel);
    const accent = resolveVar(lightMap['--xj-accent'], lightMap);
    assert.strictEqual(accent, k.lightAccent, `${skinName} light accent 必须保持 ${k.lightAccent}`);
    assert.ok(contrastRatio('#ffffff', accent) >= MIN_AA, `${skinName} light 白字对比 ${contrastRatio('#ffffff', accent).toFixed(2)}`);
    assert.strictEqual(lightMap['--cta-bg'], undefined, `${skinName} light 不得定义 --cta-bg`);
    // light hover（回退 --accent-hover）同样必须合规
    const hover = resolveVar(lightMap['--xj-accent-hover'], lightMap);
    assert.ok(hover && contrastRatio('#ffffff', hover) >= MIN_AA, `${skinName} light hover ${hover} 对比必须 >=4.5`);
  }
});

test('T5 dark accent 前景保留浅色（链接/图标/focus/active 前景语义不回归）', () => {
  const src = loadSources();
  for (const [skinName, k] of Object.entries(SKINS)) {
    const darkMap = tokenMapExact(src.uiSystem, k.darkSel);
    const accent = resolveVar(darkMap['--xj-accent'], darkMap);
    assert.strictEqual(accent, k.darkAccent, `${skinName} dark accent 必须保持浅色 ${k.darkAccent}`);
    assert.ok(contrastRatio(accent, k.darkSurface) >= MIN_AA, `${skinName} dark accent 前景对表面 ${contrastRatio(accent, k.darkSurface).toFixed(2)} >=4.5`);
  }
});

test('T6 非 CTA 不被污染 + 禁止页面级硬编码补丁', () => {
  const src = loadSources();
  const kbChip = backgroundOf(src.workbench, '.kb-chip.active', null);
  assert.ok(kbChip && String(kbChip).includes('var(--accent)') && !String(kbChip).includes('--cta-bg'), '.kb-chip.active 保持 accent');
  const pill = backgroundOf(src.components, '.pill.active', null);
  assert.ok(pill && String(pill).includes('var(--accent)') && !String(pill).includes('--cta-bg'), '.pill.active 保持 accent');
  assert.ok(/xj3-msg\.user\{background:var\(--accent\);/.test(src.chatJs), '.xj3-msg.user 气泡保持 accent（非 CTA）');
  for (const hex of HARDCODE_HEXES) {
    for (const [label, text] of [['style.css', src.style], ['components.css', src.components], ['workbench.css', src.workbench], ['index.html', src.index], ['xinjing-chat.js', src.chatJs], ['xiaojing-panel.js', src.panelJs]]) {
      assert.ok(!text.toLowerCase().includes(hex), `${label} 不得硬编码 ${hex}`);
    }
  }
});

test('T7 反向变异 12 例全部 KILLED', () => {
  const src = loadSources();
  assert.strictEqual(validate(src).ok, true, '变异前置：生产状态必须 PASS');
  assert.ok(MUTATIONS.length >= 10, '至少 10 个反向变异');
  const survivors = [];
  const killed = [];
  for (const m of MUTATIONS) {
    const mutated = m.apply({ ...src });
    const changed = ['uiSystem', 'style', 'components', 'workbench', 'index', 'chatJs', 'panelJs'].some((f) => mutated[f] !== src[f]);
    if (!changed) { survivors.push({ id: m.id, reason: '变异算子未生效（noop）' }); continue; }
    const v = validate(mutated);
    if (v.ok) survivors.push({ id: m.id, reason: '验证器未捕获该变异' });
    else killed.push({ id: m.id, sample: v.failures[0] });
  }
  assert.deepStrictEqual(survivors, [], `存在存活变异: ${JSON.stringify(survivors)}`);
  assert.ok(killed.length >= 10, `KILLED 数量 ${killed.length} >=10`);
});
