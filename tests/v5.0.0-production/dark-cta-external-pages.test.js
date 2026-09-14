'use strict';
/**
 * dark-cta-external-pages.test.js — XinJing 5.0.0 G9 allowlist 外页面 dark 主 CTA 收口
 *
 * 契约: XJ-5.0.0-G9-DARK-CTA-EXTERNAL-PAGES-REMEDIATION-V1
 * 任务: XJ-5.0.0-g9-dark-cta-external-pages-remediation-001
 *
 * 背景：前一任务（006 dark-cta-contrast，方案 B）在共享 CSS + index + 小镜建立了
 *   --cta-bg/--cta-bg-hover dark 主 CTA 语义（clinical #123c34 / theatre #5b2330 /
 *   observatory #144047，白字 12.20/12.15/11.33）。其 P2-1 遗留：~15 个 allowlist 外
 *   页面仍有各自页面内联 `background:var(--accent);color:#fff` 的主 CTA，dark 下 2.24–3.58。
 * 本卡修复策略（统一复用既有语义，禁止页面级硬编码色值补丁）：
 *   - 真主 CTA（白字 primary 动作按钮，含 JS 注入模板与内联 style 属性）：
 *       background/border-color → var(--cta-bg, var(--accent))
 *       已有 hover 规则 background → var(--cta-bg-hover, var(--accent-hover))
 *   - 不得误伤：聊天气泡(.bubble/.rmsg.me/.msg.me/.xj-cd-user)、状态点(.typing-dots/
 *     ::before dots/.xj-dot)、头像(.avatar/.ava/.rav/.logo-icon)、链接/图标、
 *     secondary/ghost(.ghost/.ai-btn/.se-btn/dashed)、pill/chip/tab/toggle/view-switch
 *     等 active 状态指示器 —— 这些保持 var(--accent) 原样。
 *   - control（修复前 dark 白字对比）= accent 2.47/3.58/2.24；accent-hover 2.04/2.55/2.26（均 <4.5，expected-red）
 *
 * 覆盖：
 *   ER expected-red：control 灵敏度 + 公式守卫 + 「修复前状态」（逆向还原 50 处编辑）验证器必须 FAIL
 *   T2 三皮肤 dark normal/hover 全部 >=4.5（级联解析真实页面 CSS/属性/JS 模板）
 *   T3 生产选择器契约完整（CSS 规则 + JS 注入按钮 + index qr-actions 覆盖规则）
 *   T4 light 零回归（浅色 accent 原值逐位不变；light 不定义 --cta-bg；light CTA=accent >=4.5）
 *   T5 非 CTA 保护（10 类受保护选择器不得出现 cta-bg，且仍保留直接 var(--accent)）
 *   T6 禁止页面级硬编码：六个 CTA 令牌 hex 仅允许出现在 xj-ui-system.css
 *   T7 反向变异 13 例全部 KILLED（含硬编码注入 M12 与误伤气泡 M13）
 *
 * 运行: node --test tests/v5.0.0-production/dark-cta-external-pages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = ['activation', 'billing-calendar', 'billing-shell', 'chat-home', 'consult-notes',
  'doc-center', 'doc-growth', 'index', 'real-supervision-ai', 'real-supervision',
  'report-writing', 'session-calendar', 'settings', 'supervision-mindmap', 'supervision',
  'transcript-guide', 'transcript'];
const UI_CSS = ['app/css/xj-ui-system.css', 'app/css/style.css', 'app/css/components.css', 'app/css/workbench.css'];
const TOKEN_FILE = 'app/css/xj-ui-system.css';
const MIN_AA = 4.5;

// ---------- WCAG ----------
function srgbChan(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function luminanceHex(hex) {
  hex = String(hex).trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return 0.2126 * srgbChan((n >> 16) & 255) + 0.7152 * srgbChan((n >> 8) & 255) + 0.0722 * srgbChan(n & 255);
}
function ratio(a, b) {
  const l1 = luminanceHex(a); const l2 = luminanceHex(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------- CSS 提取 ----------
function extractBlocks(css) {
  const out = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, selStart = 0, bodyStart = -1, currentSel = '';
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === '{') { if (depth === 0) { currentSel = noComments.slice(selStart, i).trim(); bodyStart = i + 1; } depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && currentSel) { out.push({ selectorText: currentSel, body: noComments.slice(bodyStart, i) }); currentSel = ''; selStart = i + 1; }
      else if (depth < 0) depth = 0;
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
    if (prop) decls[prop] = val;
  }
  return decls;
}
function styleBlocksOf(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}
function ruleFor(html, selector) {
  // 精确选择器段匹配（逗号分隔每段 trim 全等）；返回最后一个命中块（与层叠一致：页面内联后声明覆盖）
  let hit = null;
  for (const css of styleBlocksOf(html)) {
    for (const b of extractBlocks(css)) {
      if (b.selectorText.split(',').map((s) => s.trim()).some((s) => s === selector)) hit = b;
    }
  }
  return hit;
}

// ---------- var() 级联解析 ----------
function resolveVar(expr, map, depth) {
  depth = depth || 0;
  if (depth > 12) return null;
  expr = String(expr).trim();
  const m = expr.match(/^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([\s\S]*))?\)$/);
  if (!m) return /^#[0-9a-fA-F]{3,8}$/.test(expr) ? expr : null;
  const name = m[1]; const fallback = m[2];
  if (map[name] !== undefined) {
    const v = resolveVar(map[name], map, depth + 1);
    if (v) return v;
  }
  if (fallback !== undefined) {
    const fb = fallback.trim();
    // 回退本身可以是 var() 链或字面量
    if (/^var\(/.test(fb)) return resolveVar(fb, map, depth + 1);
    if (/^#[0-9a-fA-F]{3,8}$/.test(fb)) return fb;
    return null;
  }
  return null;
}
function resolveColorValue(val, map) {
  val = String(val || '').trim();
  if (/^#/.test(val)) return val;
  if (/^var\(/.test(val)) return resolveVar(val, map, 0);
  return null;
}

// ---------- 皮肤令牌 ----------
function skinMaps() {
  const css = fs.readFileSync(path.join(ROOT, TOKEN_FILE), 'utf8');
  const blocks = extractBlocks(css);
  function mapWhere(segPred) {
    const maps = blocks
      .filter((b) => b.selectorText.split(',').map((s) => s.trim()).some(segPred))
      .map((b) => parseDecls(b.body));
    return Object.assign({}, ...maps);
  }
  const skins = {};
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    const lightSel = [`[data-skin="${skin}"]`, `[data-skin="${skin}"]:not(.dark)`];
    const light = mapWhere((s) => lightSel.includes(s) || (skin === 'clinical' && s === ':root'));
    const dark = mapWhere((s) => s === `[data-skin="${skin}"].dark`);
    skins[skin] = { light, dark: Object.assign({}, light, dark) };
  }
  return skins;
}

// ---------- 映射登记表（本任务真实修复的 CTA；hover=null 表示无 hover 声明） ----------
const CSS_CTAS = {
  'activation.html': [
    { sel: 'button.primary', hover: 'button.primary:hover' },
  ],
  'billing-calendar.html': [
    { sel: '.bc-inv-form button', hover: null },
    { sel: '.bc-inv-actions .btn-settle', hover: null },
  ],
  'billing-shell.html': [
    { sel: '.quick button.primary', hover: 'inherited-filter' }, // hover=filter:brightness(1.07)，背景不变
    { sel: '.dock-actions button.primary', hover: 'inherited-filter' },
    { sel: '.dual-billing .col-head button.primary', hover: null },
  ],
  'chat-home.html': [
    { sel: '.chat-header .btn.pri', hover: '.chat-header .btn.pri:hover' },
    { sel: '.chat-send', hover: '.chat-send:hover' },
  ],
  'consult-notes.html': [
    { sel: '.note-complete button.primary', hover: null },
    { sel: '.rdock-input button', hover: null },
    { sel: '.btn-primary', hover: '.btn-primary:hover' },
  ],
  'doc-center.html': [
    { sel: '.atlas-primary', hover: 'filter-only' }, // hover=filter:brightness(.96)
  ],
  'doc-growth.html': [
    { sel: '.growth-primary', hover: null }, // 原 color:var(--paper-2) → dark 下为深色表面，已改为 #fff；验证器按规则真实 color 解析
  ],
  'index.html': [
    { sel: '.qr-actions .wb-primary', hover: '.qr-actions .wb-primary:hover' },
  ],
  'real-supervision-ai.html': [
    { sel: '.rs-right .rr-action button', hover: null },
  ],
  'real-supervision.html': [
    { sel: '.rs-form .btn-row button.pri', hover: null },
    { sel: '.rs-form .submit-row .btn-save', hover: null },
  ],
  'report-writing.html': [
    { sel: '.rpt-top .btn-p', hover: null },
    { sel: '.ai-suggest .accept', hover: null },
    { sel: '.step-foot .next', hover: null },
  ],
  'session-calendar.html': [
    { sel: '.sc-top .btn-new', hover: '.sc-top .btn-new:hover' },
    { sel: '.sc-modal .sm-actions button.primary', hover: '.sc-modal .sm-actions button.primary:hover' },
    { sel: '.sc-form .sf-actions .save', hover: '.sc-form .sf-actions .save:hover' },
  ],
  'settings.html': [
    { sel: '.row .btn.pri', hover: null },
  ],
  'supervision-mindmap.html': [
    { sel: '.sup-right .sr-action button', hover: null },
  ],
  'supervision.html': [
    { sel: '.quick-strip button.primary', hover: '.quick-strip button.primary:hover' },
    { sel: '.col-right .cr-input button', hover: null },
    { sel: '.sup-package-actions button.primary', hover: null },
  ],
  'transcript-guide.html': [
    { sel: '.tp-col-head .tch-btn.pri', hover: null },
    { sel: '.guide-input button', hover: null },
  ],
  'transcript.html': [
    { sel: '.input-bar button', hover: 'inherited-opacity' }, // hover=opacity:.9，背景不变
  ],
};

// JS 注入 / 内联 style 属性按钮（标记 → 期望 background 解析 >=4.5）
const ATTR_CTAS = {
  'billing-shell.html': [
    { marker: 'onclick="legacyAiBookkeep()"' },
    { marker: 'id="am-save"' },
    { marker: 'id="am-exp-save"' },
    { marker: 'id="am-ai-send"' },
    { marker: 'id="am-ai-commit"' },
    { marker: 'id="monthly-invoice-open"' },
    { marker: 'onclick="window.print()"' },
    { marker: 'id="bf-cal-plans"' },
  ],
  'real-supervision-ai.html': [{ marker: 'id="btn-reanalyze"' }],
  'report-writing.html': [{ marker: 'id="btn-start-sup"' }],
  'supervision-mindmap.html': [{ marker: 'id="btn-generate"' }],
};

// 受保护非 CTA（必须保持直接 var(--accent)，禁止出现 cta-bg）
const PROTECTED = {
  'chat-home.html': ['.chat-msg.user .bubble', '.chat-msg.assistant .avatar', '.typing-dots span', '.chat-header .logo-icon'],
  'settings.html': ['.xj-cd-msg.xj-cd-user', '.xj-tab-pill.xj-tab-active', '.toggle.on'],
  'consult-notes.html': ['.rmsg.me', '.prompt-strip .chip.active', '.clinical-task-state::before'],
  'billing-shell.html': ['.pills .pill.active', '.bin-item .ava'],
  'session-calendar.html': ['.sc-top .view-switch button.active', '.sc-day.today'],
  'index.html': ['.topbar .xj-dot', '.xj-msg.ai', '.rav'],
  'supervision.html': ['.col-right .cr-chat .msg.me', '.supervisor-current-mark'],
  'report-writing.html': ['.step.active .dot'],
  'doc-center.html': ['.trajectory .tj-item::before'],
  'doc-growth.html': ['.tl-dot.active'],
};

const CTA_HEXES = ['#123c34', '#185045', '#5b2330', '#722e3c', '#144047', '#1d5761'];

function pageSource(p) { return fs.readFileSync(path.join(ROOT, 'app', p), 'utf8'); }

// ---------- 验证器：对一组页面源码做 dark/light CTA 对比验证（行为级） ----------
function validate(sources, skin, mode) {
  const skins = skinMaps();
  const map = mode === 'dark' ? skins[skin].dark : skins[skin].light;
  const reasons = [];
  for (const [page, ctas] of Object.entries(CSS_CTAS)) {
    const html = sources[page];
    for (const cta of ctas) {
      const block = ruleFor(html, cta.sel);
      if (!block) { reasons.push(`${page} :: ${cta.sel} 规则缺失`); continue; }
      const decls = parseDecls(block.body);
      const bg = resolveColorValue(decls['background'] || decls['background-color'], map);
      if (!bg) { reasons.push(`${page} :: ${cta.sel} 背景不可解析 (${decls['background'] || decls['background-color']})`); continue; }
      const fgRaw = decls['color'] || '#fff';
      const fg = resolveColorValue(fgRaw, map) || fgRaw;
      if (!/^#/.test(fg)) { reasons.push(`${page} :: ${cta.sel} 前景不可解析 (${fgRaw})`); continue; }
      const r = ratio(fg, bg);
      if (r < MIN_AA) reasons.push(`${page} :: ${cta.sel} ${mode} 对比 ${r.toFixed(2)} <4.5 (fg=${fg} bg=${bg})`);
      // hover（仅对显式 hover 规则做对比验证；filter/opacity 型 hover 背景不变，天然继承 normal 合规）
      if (cta.hover && cta.hover !== 'inherited-filter' && cta.hover !== 'filter-only' && cta.hover !== 'inherited-opacity') {
        const hb = ruleFor(html, cta.hover);
        if (!hb) { reasons.push(`${page} :: ${cta.hover} hover 规则缺失`); continue; }
        const hdecls = parseDecls(hb.body);
        if (hdecls['background']) {
          const hbg = resolveColorValue(hdecls['background'], map);
          if (!hbg) { reasons.push(`${page} :: ${cta.hover} hover 背景不可解析`); continue; }
          const hr = ratio('#ffffff', hbg);
          if (hr < MIN_AA) reasons.push(`${page} :: ${cta.hover} ${mode} hover 对比 ${hr.toFixed(2)} <4.5 (bg=${hbg})`);
        }
      }
    }
  }
  // JS/属性按钮
  for (const [page, list] of Object.entries(ATTR_CTAS)) {
    const html = sources[page];
    for (const item of list) {
      const idx = html.indexOf(item.marker);
      if (idx < 0) { reasons.push(`${page} :: 标记 ${item.marker} 缺失`); continue; }
      const windowTxt = html.slice(idx, idx + 700);
      const m = windowTxt.match(/background:\s*([^;"']+)/);
      if (!m) { reasons.push(`${page} :: ${item.marker} 无 background 声明`); continue; }
      const bg = resolveColorValue(m[1].trim(), map);
      if (!bg) { reasons.push(`${page} :: ${item.marker} background 不可解析 (${m[1].trim()})`); continue; }
      const r = ratio('#ffffff', bg);
      if (r < MIN_AA) reasons.push(`${page} :: ${item.marker} ${mode} 对比 ${r.toFixed(2)} <4.5 (bg=${bg})`);
    }
  }
  return reasons;
}

function allSources() {
  const s = {};
  for (const p of PAGES) s[p + '.html'] = pageSource(p + '.html');
  return s;
}

// ---------- 修复前状态还原（ER：与生产修复的 50 处编辑逐位互逆） ----------
function preFixSources() {
  const s = allSources();
  const generic = [
    ['var(--cta-bg,var(--accent))', 'var(--accent)'],
    ['var(--cta-bg-hover,var(--accent-hover))', 'var(--accent-hover)'],
    ['var(--cta-bg, var(--accent, #9E5A3C))', 'var(--accent, #9E5A3C)'],
    ['var(--cta-bg, var(--accent))', 'var(--accent)'],
    ['var(--cta-bg-hover, var(--accent-hover))', 'var(--accent-hover)'],
  ];
  for (const k of Object.keys(s)) {
    for (const [from, to] of generic) s[k] = s[k].split(from).join(to);
  }
  // 特例 1：doc-growth 文本色还原（dark 下 --paper-2 为深色表面，白字 CTA 变深字深底）
  s['doc-growth.html'] = s['doc-growth.html'].replace(
    'background:var(--accent);color:#fff;font:600 13px var(--sans)',
    'background:var(--accent);color:var(--paper-2);font:600 13px var(--sans)');
  // 特例 2：index.html qr-actions 覆盖规则整体移除（还原为 workbench-home.css 的 accent 规则生效）
  s['index.html'] = s['index.html'].replace('.qr-actions .wb-primary{background:var(--accent);border-color:var(--accent)}.qr-actions .wb-primary:hover{background:var(--accent-hover)}', '');
  // 特例 3：consult-notes 原 hover 为未定义令牌 --a-hover 的硬编码回退 #777FBC（白字 4.03）
  s['consult-notes.html'] = s['consult-notes.html'].replace('.btn-primary:hover{background:var(--accent-hover)}', '.btn-primary:hover{background:var(--a-hover,#777FBC)}');
  return s;
}

// =====================================================================
test('ER expected-red：control 灵敏度 + 公式守卫 + 修复前状态验证器必须 FAIL', () => {
  // 公式守卫（防伪造 ratio）
  assert.ok(Math.abs(ratio('#ffffff', '#ffffff') - 1) < 1e-9, 'ratio(白,白) 必须 =1');
  assert.ok(Math.abs(ratio('#ffffff', '#000000') - 21) < 1e-6, 'ratio(白,黑) 必须 =21');

  const skins = skinMaps();
  // control：修复前页面 CTA = 白字 + dark accent 背景（--cta-bg 未参与）
  const controls = [];
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    const acc = resolveVar(skins[skin].dark['--accent'], skins[skin].dark, 0);
    const accHover = resolveVar(skins[skin].dark['--accent-hover'], skins[skin].dark, 0);
    const rN = ratio('#ffffff', acc);
    const rH = ratio('#ffffff', accHover);
    controls.push({ skin, accent: acc, normal: rN, accentHover: accHover, hover: rH });
    assert.ok(rN < MIN_AA, `${skin} control normal ${rN.toFixed(2)} 必须 <4.5（否则本修复无意义）`);
    assert.ok(rH < MIN_AA, `${skin} control hover ${rH.toFixed(2)} 必须 <4.5`);
  }
  // 与 006 冻结证据逐位一致
  assert.deepStrictEqual(controls.map((c) => c.normal.toFixed(2)), ['2.47', '3.58', '2.24']);
  // dark --paper-2 为深色表面：growth-primary 旧文本色在 dark 下必然失效
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    const p2 = resolveVar(skins[skin].dark['--paper-2'], skins[skin].dark, 0);
    const cta = resolveVar(skins[skin].dark['--cta-bg'], skins[skin].dark, 0);
    assert.ok(ratio(p2, cta) < 2, `${skin} dark paper-2(${p2}) 对 cta-bg(${cta}) 必须低对比，证明旧 color:var(--paper-2) 失效`);
  }

  // 修复前状态：同一验证器必须 FAIL（非恒 PASS）
  const pre = preFixSources();
  let totalReasons = 0;
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    const reasons = validate(pre, skin, 'dark');
    totalReasons += reasons.length;
    assert.ok(reasons.length >= 30, `${skin} 修复前 FAIL 理由数 ${reasons.length} 过少（预期大量 CTA <4.5/映射缺失）`);
    assert.ok(reasons.some((r) => /对比 .* <4\.5/.test(r)), `${skin} 修复前必须出现 <4.5 对比 FAIL`);
  }
  assert.ok(totalReasons >= 120, `三皮肤修复前 FAIL 总数 ${totalReasons} 过少`);
});

test('T2 生产状态：三皮肤 dark/light normal+hover 全部 >=4.5（真实级联解析）', () => {
  const src = allSources();
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    for (const mode of ['dark', 'light']) {
      const reasons = validate(src, skin, mode);
      assert.deepStrictEqual(reasons, [], `${skin} ${mode} 存在不合规: ${reasons.slice(0, 5).join(' | ')}`);
    }
  }
});

test('T3 选择器契约：全部修复点真实使用 --cta-bg/--cta-bg-hover 语义', () => {
  const src = allSources();
  let cssCtas = 0, hovers = 0, attrCtas = 0;
  for (const [page, ctas] of Object.entries(CSS_CTAS)) {
    for (const cta of ctas) {
      const block = ruleFor(src[page], cta.sel);
      assert.ok(block, `${page} ${cta.sel} 缺失`);
      const body = block.body;
      assert.ok(/background:\s*var\(--cta-bg\s*,/.test(body), `${page} ${cta.sel} 背景未使用 var(--cta-bg,…)`);
      cssCtas++;
      if (cta.hover && !String(cta.hover).includes('inherited') && cta.hover !== 'filter-only') {
        const hb = ruleFor(src[page], cta.hover);
        assert.ok(hb, `${page} ${cta.hover} 缺失`);
        assert.ok(/background:\s*var\(--cta-bg-hover\s*,/.test(hb.body), `${page} ${cta.hover} 未使用 var(--cta-bg-hover,…)`);
        hovers++;
      }
    }
  }
  for (const [page, list] of Object.entries(ATTR_CTAS)) {
    for (const item of list) {
      const idx = src[page].indexOf(item.marker);
      assert.ok(idx >= 0, `${page} ${item.marker} 缺失`);
      const win = src[page].slice(idx, idx + 700);
      assert.ok(/background:\s*var\(--cta-bg\s*,\s*var\(--accent\)\)/.test(win), `${page} ${item.marker} 未使用 cta-bg 语义`);
      attrCtas++;
    }
  }
  // index.html 必须存在 qr-actions 覆盖（workbench-home.css 不在 allowlist，语义覆盖只能落在 index 内联）
  assert.ok(src['index.html'].includes('.qr-actions .wb-primary{background:var(--cta-bg,var(--accent))'), 'index.html 缺少 qr-actions 覆盖规则');
  assert.ok(src['index.html'].includes('.qr-actions .wb-primary:hover{background:var(--cta-bg-hover,var(--accent-hover))'), 'index.html 缺少 qr-actions hover 覆盖');
  // 规模锚（防登记表缩水）：CSS CTA >=31、hover 映射 >=9、JS/属性 CTA ==11
  assert.ok(cssCtas >= 31, `CSS CTA 数 ${cssCtas} <31`);
  assert.ok(hovers >= 9, `hover 映射数 ${hovers} <9`);
  assert.strictEqual(attrCtas, 11, `JS/属性 CTA 数 ${attrCtas} != 11`);
});

test('T4 light 零回归：浅色 accent 原值逐位不变、light 不定义 --cta-bg、light CTA=accent', () => {
  const skins = skinMaps();
  assert.strictEqual(resolveVar(skins.clinical.light['--accent'], skins.clinical.light, 0), '#147d70');
  assert.strictEqual(resolveVar(skins.theatre.light['--accent'], skins.theatre.light, 0), '#7a3945');
  assert.strictEqual(resolveVar(skins.observatory.light['--accent'], skins.observatory.light, 0), '#1f6166');
  for (const skin of ['clinical', 'theatre', 'observatory']) {
    assert.ok(!skins[skin].light['--cta-bg'], `${skin} light 不得定义 --cta-bg`);
    assert.ok(!skins[skin].light['--cta-bg-hover'], `${skin} light 不得定义 --cta-bg-hover`);
    const acc = resolveVar(skins[skin].light['--accent'], skins[skin].light, 0);
    assert.ok(ratio('#ffffff', acc) >= MIN_AA, `${skin} light accent 白字对比必须 >=4.5`);
    const ah = resolveVar(skins[skin].light['--accent-hover'], skins[skin].light, 0);
    assert.ok(ratio('#ffffff', ah) >= MIN_AA, `${skin} light accent-hover 白字对比必须 >=4.5`);
  }
});

test('T5 非 CTA 保护：气泡/状态点/头像/链接图标/pill-tab-toggle 未被污染', () => {
  const src = allSources();
  for (const [page, sels] of Object.entries(PROTECTED)) {
    for (const sel of sels) {
      const block = ruleFor(src[page], sel);
      assert.ok(block, `${page} ${sel} 受保护规则缺失（可能被误删）`);
      assert.ok(!/cta-bg/.test(block.body), `${page} ${sel} 被 cta 语义污染: ${block.body.slice(0, 120)}`);
      assert.ok(/var\(--accent/.test(block.body) || /linear-gradient/.test(block.body), `${page} ${sel} 未保留原 accent 视觉`);
    }
  }
  // 关键负样本：修复后仍必须存在直接 var(--accent) 的非 CTA 背景（清点残留在允许类别内）
  assert.ok(ruleFor(src['chat-home.html'], '.chat-msg.user .bubble').body.includes('background:var(--accent)'));
  assert.ok(ruleFor(src['settings.html'], '.toggle.on').body.includes('background:var(--accent)'));
});

test('T6 禁止页面级硬编码：六个 CTA 令牌 hex 仅出现在 xj-ui-system.css', () => {
  const files = PAGES.map((p) => 'app/' + p + '.html').concat(UI_CSS);
  for (const f of files) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8').toLowerCase();
    for (const hex of CTA_HEXES) {
      const hit = txt.includes(hex);
      if (f === TOKEN_FILE) { assert.ok(hit, `${f} 应包含令牌 ${hex}`); }
      else { assert.ok(!hit, `${f} 出现硬编码 CTA hex ${hex}（页面级补丁禁令）`); }
    }
  }
});

test('T7 反向变异：13 例全部 KILLED', () => {
  const base = allSources();
  const darkSkins = ['clinical', 'theatre', 'observatory'];
  function assertKilled(mutate, label) {
    const mut = Object.assign({}, base);
    mutate(mut);
    let failed = false; let reasons = [];
    for (const skin of darkSkins) { reasons = reasons.concat(validate(mut, skin, 'dark')); }
    // T5/T6 守卫也参与变异检测
    for (const [page, sels] of Object.entries(PROTECTED)) {
      for (const sel of sels) {
        const block = ruleFor(mut[page], sel);
        if (block && /cta-bg/.test(block.body)) reasons.push(`保护违规 ${page} ${sel}`);
      }
    }
    for (const f of PAGES.map((p) => 'app/' + p + '.html').concat(UI_CSS)) {
      const txt = (mut[path.basename(f)] !== undefined ? mut[path.basename(f)] : fs.readFileSync(path.join(ROOT, f), 'utf8')).toLowerCase();
      for (const hex of CTA_HEXES) {
        if (f !== TOKEN_FILE && txt.includes(hex)) reasons.push(`硬编码违规 ${f} ${hex}`);
      }
    }
    failed = reasons.length > 0;
    assert.ok(failed, `变异 ${label} 未被 KILLED`);
    return reasons;
  }

  assertKilled((m) => { m['activation.html'] = m['activation.html'].replace('button.primary { border-color: var(--cta-bg, var(--accent)); background: var(--cta-bg, var(--accent)); color: #fff; }', 'button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }'); }, 'M1 activation 主 CTA 回退 accent');
  assertKilled((m) => { m['settings.html'] = m['settings.html'].replace('.row .btn.pri{background:var(--cta-bg,var(--accent));color:#fff;border:none}', '.row .btn.pri{background:var(--accent);color:#fff;border:none}'); }, 'M2 settings .row .btn.pri 回退');
  assertKilled((m) => { m['billing-shell.html'] = m['billing-shell.html'].replace('<button id="am-save" style="border:none;border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:var(--cta-bg,var(--accent));color:#fff;font-weight:600">', '<button id="am-save" style="border:none;border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:var(--accent);color:#fff;font-weight:600">'); }, 'M3 billing-shell am-save JS 按钮回退');
  assertKilled((m) => { m['chat-home.html'] = m['chat-home.html'].replace('.chat-send:hover{background:var(--cta-bg-hover,var(--accent-hover))}', '.chat-send:hover{background:var(--accent-hover)}'); }, 'M4 chat-send hover 回退浅色 accent-hover');
  assertKilled((m) => { m['doc-growth.html'] = m['doc-growth.html'].replace('background:var(--cta-bg,var(--accent));color:#fff;font:600 13px var(--sans)', 'background:var(--cta-bg,var(--accent));color:var(--paper-2);font:600 13px var(--sans)'); }, 'M5 growth-primary 文本色回退 paper-2');
  assertKilled((m) => { m['index.html'] = m['index.html'].replace('.qr-actions .wb-primary{background:var(--cta-bg,var(--accent));border-color:var(--cta-bg,var(--accent))}.qr-actions .wb-primary:hover{background:var(--cta-bg-hover,var(--accent-hover))}', ''); }, 'M6 index qr-actions 覆盖缺失（workbench-home accent 生效）');
  assertKilled((m) => { m['consult-notes.html'] = m['consult-notes.html'].replace('.btn-primary:hover{background:var(--cta-bg-hover,var(--accent-hover))}', '.btn-primary:hover{background:var(--a-hover,#777FBC)}'); }, 'M7 consult-notes hover 回退 #777FBC(4.03)');
  assertKilled((m) => { m['session-calendar.html'] = m['session-calendar.html'].replace('.sc-form .sf-actions .save{border:none;background:var(--cta-bg,var(--accent));color:#fff;font-weight:600}', '.sc-form .sf-actions .save{border:none;background:var(--accent);color:#fff;font-weight:600}'); }, 'M8 session-calendar save 回退');
  assertKilled((m) => { m['transcript-guide.html'] = m['transcript-guide.html'].replace('.guide-input button{border:none;background:var(--cta-bg,var(--accent));color:#fff;border-radius:8px;padding:8px 16px;font:13px var(--sans);cursor:pointer}', '.guide-input button{border:none;background:var(--accent);color:#fff;border-radius:8px;padding:8px 16px;font:13px var(--sans);cursor:pointer}'); }, 'M9 transcript-guide 发送按钮回退');
  assertKilled((m) => { m['supervision.html'] = m['supervision.html'].replace('.sup-package-actions button.primary{border-color:var(--cta-bg,var(--accent));background:var(--cta-bg,var(--accent));color:#fff}', '.sup-package-actions button.primary{border-color:var(--accent);background:var(--accent);color:#fff}'); }, 'M10 supervision 套餐主按钮回退');
  assertKilled((m) => { m['real-supervision-ai.html'] = m['real-supervision-ai.html'].replace('style="border:1px solid var(--cta-bg,var(--accent));background:var(--cta-bg,var(--accent));color:#fff;border-radius:7px;padding:4px 12px;font:11px var(--sans)" disabled onclick="analyzeCurrent()"', 'style="border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:7px;padding:4px 12px;font:11px var(--sans)" disabled onclick="analyzeCurrent()"'); }, 'M11 btn-reanalyze 属性回退');
  assertKilled((m) => { m['session-calendar.html'] = m['session-calendar.html'].replace('</head>', '<style>.hack{background:#123c34}</style></head>'); }, 'M12 页面级硬编码 #123c34 注入');
  assertKilled((m) => { m['consult-notes.html'] = m['consult-notes.html'].replace('.rmsg.me{background:var(--accent);color:#fff', '.rmsg.me{background:var(--cta-bg,var(--accent));color:#fff'); }, 'M13 误伤聊天气泡 .rmsg.me');
});
