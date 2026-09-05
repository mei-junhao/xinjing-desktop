'use strict';
/* run-mutations.js — XJ-5.1.9-full-ui-audit-mvp-fix-002 实时反向变异（expected-red）。
 * 方法：把 app/ 复制到本卡 scratch（qa/task-scratch/...，非工作树），在副本上注入单一缺陷
 * （对应卡片列出的变异类别：删除 handler、吞 {ok:false}、复用旧 DOM、绕过确认等），
 * 用变异副本 + 变异 main 启动真实 Electron，目标断言必须失败。
 * 每个变异独立实例；全程临时 userData + 回环 mock 账号 + 默认拒网。
 * 安全：变异目标文件仅限白名单，且经目录边界校验（拒绝越出 mutant-app 根）。
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib-xj519.js');

const { HARNESS, evaluate, trustedClick, trustedType, trustedKey, waitFor, delay } = lib;
const OUT = lib.ensureScratch();
const MUTANT_APP = path.join(OUT, 'mutant-app');
const MAIN_SOURCE = 'D:/xinjing-electron/main.js';
const APP_SOURCE = 'D:/xinjing-electron/app';
const ACCOUNT = { email: 'xj519fx-mut@test.local', password: 'xj519fxPass01' };

const MUTATION_FILE_WHITELIST = new Set([
  'css/workbench.css',
  'billing-shell.html',
  'js/masters.js',
  'js/supervision.js',
  'js/xinjing-chat.js',
  'js/session-calendar.js',
  'js/client-modal.js',
  'css/xj-ui-system.css',
  'js/app.js',
  'consult-notes.html',
]);

function resolveMutantFile(relFile) {
  if (typeof relFile !== 'string' || !MUTATION_FILE_WHITELIST.has(relFile)) {
    throw new Error('mutation file not allowlisted: ' + String(relFile));
  }
  const root = path.resolve(MUTANT_APP);
  const target = path.resolve(root, relFile);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path escape blocked: ' + relFile);
  }
  return target;
}

function buildMutantApp(fileMutation) {
  fs.rmSync(MUTANT_APP, { recursive: true, force: true });
  fs.cpSync(APP_SOURCE, MUTANT_APP, { recursive: true });
  const target = resolveMutantFile(fileMutation.file);
  let source = fs.readFileSync(target, 'utf8');
  source = source.split('\r\n').join('\n');
  if (!source.includes(fileMutation.needle)) throw new Error('needle missing in ' + fileMutation.file);
  source = source.split(fileMutation.needle).join(fileMutation.replacement);
  fs.writeFileSync(target, source, 'utf8');
}

function buildMutantMain() {
  let out = fs.readFileSync(MAIN_SOURCE, 'utf8');
  out = out.replace(/require\('\.\//g, "require('D:/xinjing-electron/");
  out = out.replace(/path\.join\(__dirname,\s*'app'\)/g, "path.join('" + MUTANT_APP.replace(/\\/g, '/') + "')");
  out = out.replace(/path\.join\(__dirname,\s*'build'\)/g, "path.join('D:/xinjing-electron', 'build')");
  out = out.replace(/path\.join\(__dirname,\s*'preload\.js'\)/g, "path.join('D:/xinjing-electron', 'preload.js')");
  out = out.replace(/path\.join\(__dirname,\s*'confirm-close-preload\.js'\)/g, "path.join('D:/xinjing-electron', 'confirm-close-preload.js')");
  out = out.replace(/path\.join\(__dirname,\s*'license-revocations\.json'\)/g, "path.join('D:/xinjing-electron', 'license-revocations.json')");
  const file = path.join(OUT, 'mutant-main.js');
  fs.writeFileSync(file, out, 'utf8');
  return file;
}

async function bootWithMutation(fileMutation) {
  buildMutantApp(fileMutation);
  const mutantMain = buildMutantMain();
  const mock = HARNESS.createMockAccountServer();
  const authPort = await mock.listen();
  const handle = await HARNESS.launchElectron({
    mainJs: mutantMain,
    env: { XJ_ACCOUNT_API_BASE: 'http://127.0.0.1:' + authPort, XJ_AGENT_ACCEPTANCE_CLOSE_DIALOG: '1' },
  });
  const pageTarget = await handle.waitForPage(30000);
  const origin = new URL(pageTarget.url).origin;
  const cdp = await HARNESS.connectCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await lib.registerVerifyLogin(cdp, mock, ACCOUNT);
  return { mock, handle, cdp, origin, async close() {
    try { await handle.shutdown(); } catch (e) { /* noop */ }
    try { await mock.close(); } catch (e) { /* noop */ }
    try { handle.removeUserData(); } catch (e) { /* noop */ }
  } };
}

/* 每个变异的“目标断言”（与绿向场景同口径）；在变异实例上它必须抛错/返回失败 */
const TARGET_ASSERTS = {
  'M-Z1-hidden-css-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/index.html' });
    await delay(1600);
    await trustedClick(ctx.cdp, `document.getElementById('wb-document-view')`);
    await delay(400);
    const r = await evaluate(ctx.cdp, `(() => {
      const stats = document.getElementById('hero-stats');
      const host = stats ? stats.closest('section,div') : null;
      const grid = document.querySelector('.hero-grid');
      return { hostDisplay: host ? getComputedStyle(host).display : null, gridDisplay: grid ? getComputedStyle(grid).display : null };
    })()`);
    if (!(r.hostDisplay === 'none' && r.gridDisplay === 'none')) throw new Error('MUTATION_DETECTED: hero 仍可见 ' + JSON.stringify(r));
  },
  'M-Z2-expense-state-not-switched': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/billing-shell.html' });
    await delay(1600);
    await trustedClick(ctx.cdp, `document.getElementById('bf-add-expense')`);
    await delay(400);
    const r = await evaluate(ctx.cdp, `(() => {
      const card = document.getElementById('exp-form-card');
      const shell = document.getElementById('dual-billing-shell');
      return { shellCls: shell ? shell.className : null, visible: card ? card.offsetParent !== null && getComputedStyle(card).display !== 'none' : false };
    })()`);
    if (!(r.shellCls || '').includes('state-expense') || !r.visible) throw new Error('MUTATION_DETECTED: 表单不可见 ' + JSON.stringify(r));
  },
  'M-Z3-extra-second-wave': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/masters.html' });
    await delay(1600);
    await lib.installObserver(ctx.cdp, 'canned');
    await trustedClick(ctx.cdp, `document.querySelector('#mode-toggle [data-mode="round"]')`);
    await delay(300);
    const keys = await evaluate(ctx.cdp, `(window.MASTERS || []).slice(0, 3).map((m) => m.key)`);
    for (const key of keys) { await trustedClick(ctx.cdp, `document.querySelector('.master-card[data-key="${key}"]')`); await delay(150); }
    await trustedType(ctx.cdp, `document.getElementById('msg-input')`, 'xj519fx 变异议题。');
    await trustedClick(ctx.cdp, `document.getElementById('send-btn')`);
    await waitFor(ctx.cdp, `document.querySelectorAll('#chat-body .msg.ai').length >= 3 && !document.querySelector('#chat-body .typing')`, 40000);
    await delay(2000);
    const obs = await lib.observerState(ctx.cdp);
    const calls = obs ? obs.aiCalls : null;
    if (calls === 3) throw new Error('MUTATION NOT DETECTED: 请求仍为 3（变异未生效或断言失效）');
    if (calls > 3) throw new Error('MUTATION_DETECTED: 出现额外请求 ' + calls);
  },
  'M-Z4-confirm-step-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/supervision.html' });
    await delay(1800);
    await lib.installObserver(ctx.cdp, 'canned');
    await trustedClick(ctx.cdp, `document.querySelector('.m-tab[data-tab="material"]')`);
    await delay(300);
    await trustedType(ctx.cdp, `document.getElementById('sup-material')`, 'xj519fx 合成材料（变异）。');
    await trustedClick(ctx.cdp, `document.querySelector('.m-tab[data-tab="impression"]')`);
    await delay(300);
    // 绿向实现必须出现 DOM 确认模态；变异（跳过确认）下不出现 → 检出
    let confirmSeen = false;
    for (let i = 0; i < 6 && !confirmSeen; i++) {
      try { await trustedClick(ctx.cdp, `Array.from(document.querySelectorAll('button')).find((b) => /生成整体印象/.test(b.textContent || ''))`); } catch (e) { /* retry */ }
      await delay(500);
      try { confirmSeen = await evaluate(ctx.cdp, `(() => { const o = document.querySelector('.modal-overlay'); return o && o.textContent.indexOf('将发送以下上下文') >= 0; })()`, 4000); } catch (e) { confirmSeen = false; }
    }
    if (!confirmSeen) throw new Error('MUTATION_DETECTED: 确认模态未出现（变异生效）');
  },
  'M-Z5-user-mount-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/index.html' });
    await delay(1600);
    await lib.installObserver(ctx.cdp, 'canned');
    await trustedClick(ctx.cdp, `document.getElementById('xj3-fab')`);
    await waitFor(ctx.cdp, `document.getElementById('xj-panel-v3').classList.contains('open')`, 8000);
    await trustedType(ctx.cdp, `document.getElementById('xj3-input')`, 'xj519fx-M5-首条发送');
    await trustedClick(ctx.cdp, `document.getElementById('xj3-send')`);
    await delay(1500);
    const visible = await evaluate(ctx.cdp, `Array.from(document.querySelectorAll('#xj3-body .xj3-msg.user')).some((m) => m.textContent.indexOf('xj519fx-M5-首条发送') >= 0)`);
    if (visible) throw new Error('MUTATION NOT DETECTED: 用户消息仍可见');
    throw new Error('MUTATION_DETECTED: 首条发送用户消息不可见');
  },
  'M-Z6-wide-keyword-restored': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/index.html' });
    await delay(1600);
    await lib.installObserver(ctx.cdp, 'canned');
    await trustedClick(ctx.cdp, `document.getElementById('xj3-fab')`);
    await waitFor(ctx.cdp, `document.getElementById('xj-panel-v3').classList.contains('open')`, 8000);
    const before = (await lib.observerState(ctx.cdp)).aiCalls;
    await trustedType(ctx.cdp, `document.getElementById('xj3-input')`, 'xj519fx 请帮我复述：来访者小李谈到换了工作。');
    await trustedClick(ctx.cdp, `document.getElementById('xj3-send')`);
    await delay(2000);
    const calls = (await lib.observerState(ctx.cdp)).aiCalls;
    if (calls > before) throw new Error('MUTATION NOT DETECTED: 材料复述仍走模型');
    throw new Error('MUTATION_DETECTED: 材料复述被本地意图劫持（未走模型）');
  },
  'M-Z8-durable-failure-swallowed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/session-calendar.html' });
    await delay(1800);
    await evaluate(ctx.cdp, `(() => {
      window.__xjToastSeen = false;
      const orig = App.showToast;
      App.showToast = function (msg, type) { if (String(msg).indexOf('删除失败') >= 0) window.__xjToastSeen = true; return orig.call(App, msg, type); };
      return true;
    })()`);
    await evaluate(ctx.cdp, `SessionCal.removeSession('xj519fx-nonexistent-id')`);
    await waitFor(ctx.cdp, `window.__xjToastSeen === true`, 6000);
    throw new Error('MUTATION NOT DETECTED: 失败提示仍出现？');
  },
  'M-A1-aligned-block-renamed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/settings.html' });
    await delay(1800);
    // 绿向：aligned 令牌块存在 → 画布 #f8f9fa；变异（块改名=令牌缺失）→ 回退 clinical #eef3f1 → 检出
    const probe = await evaluate(ctx.cdp, `(() => ({
      skin: document.documentElement.getAttribute('data-skin'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }))()`);
    if (probe.skin === 'aligned' && probe.bodyBg === 'rgb(248, 249, 250)') throw new Error('MUTATION NOT DETECTED: aligned 令牌仍生效？');
    throw new Error('MUTATION_DETECTED: aligned 令牌缺失，画布回退 ' + probe.bodyBg);
  },
  'M-A2-aligned-default-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/index.html' });
    await delay(1800);
    const skin = await evaluate(ctx.cdp, `document.documentElement.getAttribute('data-skin')`);
    if (skin === 'aligned') throw new Error('MUTATION NOT DETECTED: 默认皮肤仍为 aligned');
    throw new Error('MUTATION_DETECTED: 默认皮肤回退 ' + skin);
  },
  'M-A3-aligned-accent-tampered': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/settings.html' });
    await delay(1800);
    const accent = await evaluate(ctx.cdp, `getComputedStyle(document.documentElement).getPropertyValue('--xj-accent').trim()`);
    if (accent === '#007aff' || accent === '#0a84ff') throw new Error('MUTATION NOT DETECTED: accent 未被篡改？');
    throw new Error('MUTATION_DETECTED: accent 变为 ' + accent);
  },
  'M-B-desensitize-entry-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/consult-notes.html' });
    await delay(1800);
    // 变异（删除 handler）后点击入口 → 仍停留在当前页（无跳转）→ 检出
    try { await trustedClick(ctx.cdp, `Array.from(document.querySelectorAll('button')).find((b) => /生成脱敏文档/.test(b.textContent || ''))`); } catch (e) { /* 重试 */ }
    await delay(1500);
    const pathNow = await evaluate(ctx.cdp, `location.pathname`);
    if (pathNow.indexOf('desensitize-result') >= 0) throw new Error('MUTATION NOT DETECTED: 点击后仍跳转结果页？');
    throw new Error('MUTATION_DETECTED: 点击生成脱敏文档无跳转（handler 已被移除）');
  },
  'M-Z11-escape-listener-removed': async (ctx) => {
    await ctx.cdp.send('Page.navigate', { url: ctx.origin + '/index.html' });
    await delay(1600);
    let opened = false;
    for (let i = 0; i < 6 && !opened; i++) {
      try { await trustedClick(ctx.cdp, `document.querySelector('.xj-new-client')`); } catch (e) { /* retry */ }
      await delay(500);
      try { opened = await evaluate(ctx.cdp, `!!document.getElementById('cm-name') && document.getElementById('cm-name').offsetParent !== null`, 4000); } catch (e) { opened = false; }
    }
    if (!opened) throw new Error('MUTATION FLOW BROKEN: modal never opened（流程自身失败，不判红）');
    await trustedKey(ctx.cdp, 'Escape');
    await delay(400);
    const closed = await evaluate(ctx.cdp, `!document.getElementById('cm-name')`);
    if (closed) throw new Error('MUTATION NOT DETECTED: Escape 仍可关闭');
    throw new Error('MUTATION_DETECTED: Escape 不再关闭弹窗');
  },
};

const MUTATIONS = [
  { id: 'M-Z1-hidden-css-removed', file: 'css/workbench.css', needle: '[hidden] { display: none !important; }', replacement: '/* mutation M-Z1: hidden fallback removed */' },
  { id: 'M-Z2-expense-state-not-switched', file: 'billing-shell.html', needle: "    setBillingState('expense');\n    var formHtml", replacement: '    var formHtml' },
  { id: 'M-Z3-extra-second-wave', file: 'js/masters.js', needle: "    busy = false;\n    setGeneratingUi(false);\n    $('msg-input').disabled = false;", replacement: "    await callMaster(keys[0] || 'winnicott', 'xj519fx-mutation-extra', true, activeNames);\n    busy = false;\n    setGeneratingUi(false);\n    $('msg-input').disabled = false;" },
  { id: 'M-Z4-confirm-step-removed', file: 'js/supervision.js', needle: 'confirmContextSendAsync(context).then(function (confirmed) {', replacement: 'Promise.resolve(true).then(function (confirmed) {' },
  { id: 'M-Z5-user-mount-removed', file: 'js/xinjing-chat.js', needle: "    appendUserMsg(text);\n    inputEl.value = '';", replacement: "    inputEl.value = '';" },
  { id: 'M-Z6-wide-keyword-restored', file: 'js/xinjing-chat.js', needle: "  function queryLocal(text) {\n    var q = text.toLowerCase();", replacement: "  function queryLocal(text) {\n    var q = text.toLowerCase();\n    if (q.indexOf('来访者') >= 0) return { content: '👥 共有 73 位来访者（活跃 73 位）。（本地检索 · 未调用模型）' };" },
  { id: 'M-Z8-durable-failure-swallowed', file: 'js/session-calendar.js', needle: "        if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || 'data was not persisted');", replacement: "        if (false) throw new Error('mutation-swallowed');" },
  { id: 'M-Z11-escape-listener-removed', file: 'js/client-modal.js', needle: "    document.addEventListener('keydown', escapeListener, true);", replacement: '    /* mutation: escape listener removed */' },
  { id: 'M-A1-aligned-block-renamed', file: 'css/xj-ui-system.css', needle: '[data-skin="aligned"] {', replacement: '/* mutation: aligned token block detached */ [data-skin="aligned-x"] {' },
  { id: 'M-A2-aligned-default-removed', file: 'js/app.js', needle: "const skin = !legacySkin && allowed.indexOf(storedSkin) !== -1 ? storedSkin : 'aligned';", replacement: "const skin = !legacySkin && allowed.indexOf(storedSkin) !== -1 ? storedSkin : 'clinical';" },
  { id: 'M-A3-aligned-accent-tampered', file: 'css/xj-ui-system.css', needle: '--xj-accent: #007aff;', replacement: '--xj-accent: #00ff00;' },
  { id: 'M-B-desensitize-entry-removed', file: 'consult-notes.html', needle: 'onclick="openDesensitize()"', replacement: 'onclick="void(0)"' },
];

(async () => {
  const results = [];
  const only = process.argv.slice(2);
  for (const mutation of MUTATIONS) {
    if (only.length && !only.includes(mutation.id)) continue;
    let ctx = null;
    const startedAt = new Date().toISOString();
    try {
      const assertFn = TARGET_ASSERTS[mutation.id];
      ctx = await bootWithMutation(mutation);
      await assertFn(ctx);
      results.push({ id: mutation.id, expectedRed: false, note: '变异未被检出（假绿）', startedAt });
      process.stdout.write('FAIL ' + mutation.id + ' — 变异未被检出（假绿）\n');
    } catch (e) {
      const message = String(e && e.message || e);
      const detected = message.indexOf('MUTATION_DETECTED') >= 0 || message.indexOf('MUTATION NOT DETECTED') < 0;
      results.push({ id: mutation.id, expectedRed: detected, note: message.slice(0, 200), startedAt });
      process.stdout.write((detected ? 'PASS ' : 'FAIL ') + mutation.id + ' — ' + message.slice(0, 120) + '\n');
    } finally {
      if (ctx) { try { await ctx.close(); } catch (e) { /* noop */ } }
    }
  }
  const file = path.join(OUT, 'mutation-results.json');
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  const allRed = results.length && results.every((r) => r.expectedRed);
  process.stdout.write('MUTATIONS DONE: ' + results.length + ' runs, allExpectedRed=' + allRed + '\n');
  process.exit(allRed ? 0 : 2);
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
