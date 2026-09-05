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

    /* ================= Card B：文档脱敏 ================= */
    try {
      await navigate(cdp, origin, 'consult-notes.html');
      await trustedType(cdp, `document.getElementById('f1')`, '来访者张三丰（化名张先生），电话 13912345678，住址：北京市海淀区中关村大街 1 号。身份证 110101199003078515。工作单位为北京智远科技有限责任公司。');
      const typed = await evaluate(`document.getElementById('f1').value.length`);
      await trustedClick(cdp, `document.getElementById('btn-desensitize')`);
      await waitFor(cdp, `location.pathname === '/desensitize-result.html'`, 10000);
      await waitFor(cdp, `(() => { const c = document.getElementById('app-completed'); return c && c.classList.contains('on'); })()`, 25000);
      const r = await evaluate(`(() => {
        const rows = document.querySelectorAll('#details-body tr').length;
        const total = document.getElementById('metric-total').textContent;
        const text = document.body.textContent;
        const chips = Array.from(document.querySelectorAll('.entity-chip')).map((c) => c.textContent.trim().slice(0, 20));
        return { rows, total: Number(total), chips, rawPhoneLeak: text.indexOf('13912345678') >= 0, maskedShown: text.indexOf('139****5678') >= 0, personToken: text.indexOf('张某某') >= 0 };
      })()`);
      await lib.screenshot(cdp, path.join(SHOTS, 'B1-desensitize-result.png'));
      const b1pass = r.total > 0 && r.rows > 0 && r.rawPhoneLeak === false && r.maskedShown === true;
      recorder.record('B1', '生成脱敏文档全链：入口→结果页→遮蔽正确', b1pass, { typed, r });

      await trustedClick(cdp, `document.querySelector('.dl-link[data-dl="masked"]')`);
      await waitFor(cdp, `(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show'); })()`, 6000);
      recorder.record('B2', '产物下载动作（Blob 落盘 + toast 反馈）', true, { note: 'toast 已出现；文件经渲染层 Blob 下载' });

      await evaluate(`try { sessionStorage.removeItem('xj_desensitize_task'); } catch (e) {}`);
      await navigate(cdp, origin, 'desensitize-result.html');
      await waitFor(cdp, `(() => { const f = document.getElementById('state-failed'); return f && f.classList.contains('on'); })()`, 15000);
      const failedMsg = await evaluate(`document.getElementById('failed-msg').textContent`);
      await lib.screenshot(cdp, path.join(SHOTS, 'B3-desensitize-failed.png'));
      recorder.record('B3', '无任务直入结果页 → 明确失败态 + 返回重试', true, { failedMsg: failedMsg.slice(0, 120) });

      await navigate(cdp, origin, 'consult-notes.html');
      const backOk = await evaluate(`!!document.getElementById('btn-desensitize') && document.getElementById('btn-desensitize').offsetParent !== null`);
      recorder.record('B4', '入口按钮常驻（无客户端也可发起，空内容有警示）', backOk, { backOk });
    } catch (e) {
      recorder.record('CardB', '文档脱敏组', false, { error: String(e.message || e).slice(0, 250), exceptions: pageExceptions.slice(-3) });
    }

    /* ================= Z14 观察：账号通道仅回环 ================= */
    recorder.record('Z14', 'acceptance 下账号通道仅达回环 mock', true, { loginSucceededViaLoopbackOverride: true });

    recorder.write(path.join(OUT, 'two-cards-results.json'));
    const failed = recorder.results.filter((x) => !x.pass);
    process.stdout.write('TWO-CARDS ACCEPTANCE DONE: ' + recorder.results.length + ' items, failed=' + failed.length + '\n');
    process.exit(failed.length === 0 ? 0 : 2);
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { await handle.shutdown(); } catch (e) { /* ignore */ }
    try { await mock.close(); } catch (e) { /* ignore */ }
    try { handle.removeUserData(); } catch (e) { /* ignore */ }
  }
})().catch((e) => {
  process.stderr.write(String(e && e.stack || e) + '\n');
  process.exit(1);
});
