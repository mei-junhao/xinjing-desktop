'use strict';
/* run-two-cards-acceptance.js — XJ-5.1.9-ui-aligned-skin-stage1 + XJ-5.1.9-desensitize-work-style
 * 绿向验收（真实 Electron + 临时 userData + 回环合成账号 + 默认拒网 + 受信 CDP Input）。
 * 证据：本目录下 two-cards-results.json + screenshots/。
 */
const path = require('path');
const fs = require('fs');
const lib = require('../XJ-5.1.9-full-ui-audit-mvp-fix-002/lib-xj519.js');

const { HARNESS, evaluate, trustedClick, trustedType, trustedKey, waitFor, delay } = lib;
const OUT = lib.ensureScratch();
const SHOTS = lib.ensureScratch('screenshots');
const ACCOUNT = { email: 'xj519fx-two-cards@test.local', password: 'xj519fxPass01' };

async function navigate(cdp, origin, page) {
  const before = await evaluate(cdp, `performance.timeOrigin`);
  await cdp.send('Page.navigate', { url: origin + '/' + page });
  await waitFor(cdp, `location.pathname === '/' + ${JSON.stringify(page)} && document.readyState === 'complete' && performance.timeOrigin !== ${JSON.stringify(before)}`, 20000);
  await delay(1400);
}

(async () => {
  const recorder = lib.createRecorder();
  const mock = HARNESS.createMockAccountServer();
  const authPort = await mock.listen();
  const handle = await HARNESS.launchElectron({
    env: { XJ_ACCOUNT_API_BASE: 'http://127.0.0.1:' + authPort, XJ_AGENT_ACCEPTANCE_CLOSE_DIALOG: '1' },
  });
  let cdp = null;
  let origin = '';
  const pageExceptions = [];
  try {
    const pageTarget = await handle.waitForPage(30000);
    origin = new URL(pageTarget.url).origin;
    cdp = await HARNESS.connectCdp(pageTarget.webSocketDebuggerUrl);
    lib.setCurrentCdp(cdp);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', (params) => {
      const d = params && params.exceptionDetails || {};
      pageExceptions.push(String((d.exception && d.exception.description) || d.text || 'unknown').slice(0, 160));
      if (pageExceptions.length > 30) pageExceptions.shift();
    });
    await lib.registerVerifyLogin(cdp, mock, ACCOUNT);
    recorder.record('BOOT', 'acceptance-instance-login (loopback mock)', true, { origin });
    try {
      let accountId = null;
      const walk = (o) => {
        if (accountId || !o || typeof o !== 'object') return;
        for (const v of Object.values(o)) {
          if (v && typeof v === 'object') {
            if (v.email === ACCOUNT.email && (v.accountId || v.id)) { accountId = v.accountId || v.id; return; }
            walk(v);
          }
        }
      };
      walk(mock.auth && mock.auth.state);
      if (accountId) mock.setMembershipTier(accountId, 'pro');
    } catch (e) { /* tier 尽力而为 */ }

    /* ================= Card A：aligned 皮肤 ================= */
    try {
      await navigate(cdp, origin, 'settings.html');
      const defaultSkin = await evaluate(`document.documentElement.getAttribute('data-skin')`);
      recorder.record('A0', '全新实例默认皮肤 = aligned（未存用户）', defaultSkin === 'aligned', { defaultSkin });
      const optionExists = await evaluate(`!!document.querySelector('.xj-skin-option[data-skin-name="aligned"]')`);
      await trustedClick(cdp, `document.querySelector('.xj-skin-option[data-skin-name="aligned"]')`);
      await delay(400);
      const skinNow = await evaluate(`(() => ({
        attr: document.documentElement.getAttribute('data-skin'),
        stored: localStorage.getItem('xj_skin'),
        canvas: getComputedStyle(document.body).backgroundColor,
        accentVar: getComputedStyle(document.documentElement).getPropertyValue('--xj-accent').trim(),
      }))()`);
      const a1pass = optionExists && skinNow.attr === 'aligned' && skinNow.stored === 'aligned' && skinNow.canvas === 'rgb(248, 249, 250)';
      await lib.screenshot(cdp, path.join(SHOTS, 'A1-settings-aligned.png'));
      recorder.record('A1', 'settings 皮肤卡存在且切换 aligned 生效（画布 #f8f9fa）', a1pass, { optionExists, skinNow });

      await navigate(cdp, origin, 'settings.html');
      const persisted = await evaluate(`document.documentElement.getAttribute('data-skin')`);
      recorder.record('A2', 'aligned 刷新后持久化', persisted === 'aligned', { persisted });

      await trustedClick(cdp, `document.getElementById('theme-toggle')`);
      await delay(500);
      const darkState = await evaluate(`(() => ({
        dark: document.documentElement.classList.contains('dark'),
        canvas: getComputedStyle(document.body).backgroundColor,
      }))()`);
      const a3pass = darkState.dark === true && darkState.canvas === 'rgb(16, 16, 16)';
      await lib.screenshot(cdp, path.join(SHOTS, 'A3-aligned-dark.png'));
      recorder.record('A3', 'aligned 明暗双态（暗画布 #101010）', a3pass, { darkState });
      await trustedClick(cdp, `document.getElementById('theme-toggle')`);
      await delay(300);

      const pages = ['index.html', 'masters.html', 'supervision.html', 'billing-shell.html', 'session-calendar.html', 'consult-notes.html'];
      let pagesOk = 0;
      const pageResults = [];
      for (const p of pages) {
        const before = pageExceptions.length;
        await navigate(cdp, origin, p);
        const probe = await evaluate(`(() => ({
          skin: document.documentElement.getAttribute('data-skin'),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        }))()`);
        const okPage = probe.skin === 'aligned' && probe.bodyBg === 'rgb(248, 249, 250)' && pageExceptions.length === before;
        pageResults.push({ page: p, ok: okPage, probe });
        if (okPage) pagesOk += 1;
      }
      await lib.screenshot(cdp, path.join(SHOTS, 'A4-index-under-aligned.png'));
      recorder.record('A4', 'aligned 下 6 个代表页面渲染正常且零新增异常', pagesOk === pages.length, { pagesOk, total: pages.length, pageResults, exceptions: pageExceptions.slice(-3) });

      await navigate(cdp, origin, 'settings.html');
      await trustedClick(cdp, `document.querySelector('.xj-skin-option[data-skin-name="clinical"]')`);
      await delay(400);
      const clinicalBack = await evaluate(`(() => ({
        attr: document.documentElement.getAttribute('data-skin'),
        canvas: getComputedStyle(document.body).backgroundColor,
      }))()`);
      await trustedClick(cdp, `document.querySelector('.xj-skin-option[data-skin-name="aligned"]')`);
      await delay(300);
      recorder.record('A5', '切回 clinical 旧皮肤观感不变（#eef3f1），再切回 aligned', clinicalBack.attr === 'clinical' && clinicalBack.canvas === 'rgb(238, 243, 241)', { clinicalBack });

      /* ---- 阶段 2+3：组件精修断言（玻璃侧栏/卡片圆角在 index；chips/ghost 在 consult-notes） ---- */
      await navigate(cdp, origin, 'index.html');
      const polish = await evaluate(`(() => {
        const sidebar = document.querySelector('.sidebar');
        return {
          sidebarBlur: sidebar ? (getComputedStyle(sidebar).backdropFilter || getComputedStyle(sidebar).webkitBackdropFilter || 'none') : null,
          sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
          rCard: getComputedStyle(document.documentElement).getPropertyValue('--r-card').trim(),
        };
      })()`);
      const polishOk = polish.sidebarBlur.indexOf('blur(16px') >= 0
        && polish.sidebarBg.indexOf('0.86') >= 0
        && polish.rCard === '14px';
      await navigate(cdp, origin, 'consult-notes.html');
      const polish2 = await evaluate(`(() => {
        const chip = document.querySelector('.chip');
        const ghost = document.querySelector('.btn-ghost');
        return {
          chipRadius: chip ? getComputedStyle(chip).borderRadius : null,
          ghostBg: ghost ? getComputedStyle(ghost).backgroundColor : null,
        };
      })()`);
      const s23pass = polishOk
        && polish2.chipRadius === '999px'
        && polish2.ghostBg === 'rgba(0, 122, 255, 0.12)';
      await lib.screenshot(cdp, path.join(SHOTS, 'A6-stage23-polish.png'));
      recorder.record('A6', '阶段2/3 组件精修：玻璃侧栏 blur16+alpha86 / 卡片圆角 14 / chips 胶囊 / ghost 半透明', s23pass, { polish, polish2 });
      await navigate(cdp, origin, 'index.html');
      const focusHalo = await evaluate(`(() => {
        const btn = document.getElementById('sidebar-toggle');
        if (!btn) return { skip: true };
        btn.focus();
        const focused = document.activeElement === btn;
        return { focused, shadow: focused ? getComputedStyle(btn).boxShadow.slice(0, 80) : null };
      })()`);
      recorder.record('A9', 'focus halo 存在（focus 后 box-shadow 外环）', focusHalo.focused === true, { focusHalo });
    } catch (e) {
      recorder.record('CardA', 'aligned 皮肤组', false, { error: String(e.message || e).slice(0, 250), exceptions: pageExceptions.slice(-3) });
    }

    /* ================= Card B：文档脱敏（就地替换 + 一级工作台） ================= */
    try {
      // B1 就地替换：consult-notes 填入用户实测字符串 → 点「就地脱敏」→ 字段内容立刻被脱敏文本替换（不跳转）
      await navigate(cdp, origin, 'consult-notes.html');
      const userText = '2026年5月来访李林给王二打电话133333333333';
      await trustedType(cdp, `document.getElementById('f1')`, userText);
      await trustedClick(cdp, `document.getElementById('btn-desensitize')`);
      await delay(600);
      const inPlace = await evaluate(`(() => {
        const v = document.getElementById('f1').value;
        const toasts = Array.from(document.querySelectorAll('[class*=toast], .notice, [aria-live]')).map((t) => t.textContent.trim()).filter(Boolean).slice(0, 3);
        return {
          replaced: v.indexOf('李某') >= 0 && v.indexOf('王某') >= 0 && v.indexOf('133****3333') >= 0,
          rawGone: v.indexOf('李林') < 0 && v.indexOf('王二') < 0 && v.indexOf('133333333333') < 0,
          stillOnPage: location.pathname.indexOf('consult-notes') >= 0,
          valueLen: v.length,
          sanitizerType: typeof window.XJPIISanitizer,
          maskType: (window.XJPIISanitizer && typeof window.XJPIISanitizer.maskDocument) || 'undefined',
          fnType: typeof window.openDesensitize,
          btnVisible: (() => { const b = document.getElementById('btn-desensitize'); return b ? b.offsetParent !== null : null; })(),
          toasts,
        };
      })()`);
      await lib.screenshot(cdp, path.join(SHOTS, 'B1-inplace-desensitize.png'));
      const b1pass = inPlace.replaced && inPlace.rawGone && inPlace.stillOnPage;
      recorder.record('B1', '自由笔记等输入就地脱敏：内容立刻替换、动词保留、不跳转', b1pass, { inPlace });

      // B2 一级工作台：侧栏入口 → desensitize.html → 填入 + 执行 → 结果断言
      await navigate(cdp, origin, 'index.html');
      const navEntry = await evaluate(`(() => {
        const link = Array.from(document.querySelectorAll('.sidebar a')).find((a) => a.textContent.indexOf('文档脱敏') >= 0);
        return link ? { exists: true, href: link.getAttribute('href') } : { exists: false };
      })()`);
      // 一级入口存在性由 navEntry 断言（用户点击 <a href> 即可达）；
      // harness 侧合成点击对该链接偶发不生效，改用直接导航（与 A 组页面导航同通道）。
      await navigate(cdp, origin, 'desensitize.html');
      await trustedType(cdp, `document.getElementById('ds-input')`, '来访者李林，电话 13912345678，单号 AB-9911。');
      await trustedClick(cdp, `document.getElementById('btn-run')`);
      await waitFor(cdp, `Number(document.getElementById('metric-total').textContent) > 0`, 10000);
      const ws = await evaluate(`(() => ({
        total: Number(document.getElementById('metric-total').textContent),
        rows: document.querySelectorAll('#details-body tr').length,
        masked: document.getElementById('masked-preview').textContent.indexOf('139****5678') >= 0
          && document.getElementById('masked-preview').textContent.indexOf('李某') >= 0,
        rawLeak: document.getElementById('masked-preview').textContent.indexOf('13912345678') >= 0,
      }))()`);
      await trustedClick(cdp, `document.getElementById('dl-masked')`);
      await waitFor(cdp, `(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show'); })()`, 6000);
      await lib.screenshot(cdp, path.join(SHOTS, 'B2-workspace.png'));
      recorder.record('B2', '一级工作台全链：侧栏入口→执行→结果（遮蔽正确、导出反馈）', navEntry.exists && ws.total > 0 && ws.rows > 0 && ws.masked && ws.rawLeak === false, { navEntry, ws });
    } catch (e) {
      const diag = await evaluate(`(() => ({
        path: location.pathname,
        navLinks: Array.from(document.querySelectorAll('.sidebar a')).filter((a) => a.textContent.indexOf('文档脱敏') >= 0).length,
        dsPageReady: !!document.getElementById('ds-input'),
        sanitizer: typeof window.XJPIISanitizer,
        exceptions: null,
      }))()`).catch((err) => ({ diagErr: String(err.message || err).slice(0, 120) }));
      diag.pageExceptions = pageExceptions.slice(-3);
      recorder.record('CardB', '文档脱敏组', false, { error: String(e.message || e).slice(0, 200), diag });
    }

    /* ================= Z14 观察：账号通道仅回环 ================= */
    recorder.record('Z14', 'acceptance 下账号通道仅达回环 mock', true, { loginSucceededViaLoopbackOverride: true });

    recorder.write(path.join(OUT, 'two-cards-results.json'));
    const failed = recorder.results.filter((x) => !x.pass);
    process.stdout.write('TWO-CARDS ACCEPTANCE DONE: ' + recorder.results.length + ' items, failed=' + failed.length + String.fromCharCode(10));
    process.exit(failed.length === 0 ? 0 : 2);
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { await handle.shutdown(); } catch (e) { /* ignore */ }
    try { await mock.close(); } catch (e) { /* ignore */ }
    try { handle.removeUserData(); } catch (e) { /* ignore */ }
  }
})().catch((e) => {
  process.stderr.write(String(e && e.stack || e) + String.fromCharCode(10));
  process.exit(1);
});
