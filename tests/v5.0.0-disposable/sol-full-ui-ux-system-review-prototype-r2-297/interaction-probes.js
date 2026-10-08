'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./cdp-harness');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE = path.join(ROOT, 'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297');
const WORKSPACE = path.join(ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE = path.join(WORKSPACE, 'evidence/interactions');

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await harness.startStaticServer(CANDIDATE);
  const browser = await harness.launch({ debugPort: 9339, profile: path.join(WORKSPACE, 'scratch/edge-profile-interactions') });
  const errors = { console: [], page: [] };
  const removeListener = browser.cdp.onEvent((message) => {
    if (message.sessionId !== browser.sessionId) return;
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.console.push(message.params);
    if (message.method === 'Runtime.exceptionThrown') errors.page.push(message.params);
  });
  await harness.setViewport(browser.cdp, browser.sessionId, 1366, 768);
  const checks = [];
  async function probe(id, route, run) {
    try {
      await harness.navigate(browser.cdp, browser.sessionId, `http://127.0.0.1:${server.port}/index.html#route=${route}&skin=clinical&mode=light&fixture=ready`);
      const detail = await run();
      const png = path.join(EVIDENCE, `${id}.png`);
      const dom = path.join(EVIDENCE, `${id}.html`);
      await harness.screenshot(browser.cdp, browser.sessionId, png);
      await harness.snapshot(browser.cdp, browser.sessionId, dom);
      checks.push({ id, route, status: 'PASS', detail, screenshot: png.replace(/\\/g, '/'), dom_snapshot: dom.replace(/\\/g, '/') });
    } catch (error) {
      checks.push({ id, route, status: 'FAIL', message: error.message });
    }
  }
  try {
    await probe('client-selection', 'index', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-client="client-b"]');
      const state = await harness.evaluate(browser.cdp, browser.sessionId, 'window.XJ_PROTOTYPE.state');
      if (state.clientId !== 'client-b' || state.sessionId !== 'session-b1') throw new Error('client/session context did not switch atomically');
      return state;
    });
    await probe('save-failure-retains-input', 'consult-notes', async () => {
      const value = '保存失败后必须原样保留的合成长中文记录。';
      await harness.typeValue(browser.cdp, browser.sessionId, '#note-draft', value);
      await harness.click(browser.cdp, browser.sessionId, '[data-action="save-fail"]');
      const retained = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("#note-draft").value');
      const alert = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[role=alert]")?.textContent || ""');
      if (retained !== value || !alert.includes('输入已保留')) throw new Error('failure did not retain input');
      return { retained, alert };
    });
    await probe('source-opening', 'doc-center', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-source="source-01"]');
      const dialog = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[role=dialog]")?.innerText || ""');
      if (!dialog.includes('只读投影') || !dialog.includes('client-a')) throw new Error('source detail missing provenance');
      return { dialog };
    });
    await probe('ai-draft-cancel', 'supervision', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-action="ai-draft"]');
      await harness.delay(180);
      let state = await harness.evaluate(browser.cdp, browser.sessionId, 'window.XJ_PROTOTYPE.state.aiStatus');
      if (state !== 'draft') throw new Error('AI did not return to draft state');
      await harness.click(browser.cdp, browser.sessionId, '[data-action="cancel-ai"]');
      state = await harness.evaluate(browser.cdp, browser.sessionId, 'window.XJ_PROTOTYPE.state.aiStatus');
      if (state !== 'cancelled') throw new Error('AI cancellation not explicit');
      return { aiStatus: state };
    });
    await probe('membership-lock', 'activation', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-action="membership-lock"]');
      const text = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[role=dialog]")?.innerText || ""');
      if (!text.includes('fail-closed') || !text.includes('BYOK')) throw new Error('membership boundary incomplete');
      return { text };
    });
    await probe('balance-sync-failure', 'billing-shell', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-action="balance-fail"]');
      const text = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[data-testid=server-balance]").textContent');
      if (text.includes('186') || !text.includes('同步失败')) throw new Error('stale balance still shown as authoritative');
      return { balance: text };
    });
    await probe('recovery-passphrase', 'settings', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-action="passphrase"]');
      const text = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[role=dialog]")?.innerText || ""');
      const value = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("#passphrase-input")?.value');
      if (value !== '' || !text.includes('不会预设口令')) throw new Error('passphrase was defaulted or explanation missing');
      return { emptyByDefault: value === '', text };
    });
    await probe('update-rollback', 'settings', async () => {
      await harness.click(browser.cdp, browser.sessionId, '[data-action="update-fail"]');
      const text = await harness.evaluate(browser.cdp, browser.sessionId, 'document.querySelector("[role=dialog]")?.innerText || ""');
      if (!text.includes('回滚') || !text.includes('保持不变')) throw new Error('update rollback not preserved');
      return { text };
    });
    await probe('keyboard-focus', 'consult-notes', async () => {
      const focused = await harness.evaluate(browser.cdp, browser.sessionId, `(() => { const el=document.querySelector('.skip-link'); el.focus(); return {tag:document.activeElement.tagName, text:document.activeElement.textContent, outline:getComputedStyle(el).outlineStyle}; })()`);
      if (focused.tag !== 'A' || focused.outline === 'none') throw new Error('focus-visible evidence missing');
      return focused;
    });
    await probe('narrow-drawer', 'index', async () => {
      await harness.setViewport(browser.cdp, browser.sessionId, 640, 700);
      await harness.click(browser.cdp, browser.sessionId, '[data-action="toggle-sidebar"]');
      const data = await harness.evaluate(browser.cdp, browser.sessionId, `(() => { const el=document.querySelector('.sidebar'); return {open:el.classList.contains('open'), transform:getComputedStyle(el).transform, overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}; })()`);
      if (!data.open || data.overflow) throw new Error('narrow drawer failed');
      await harness.setViewport(browser.cdp, browser.sessionId, 1366, 768);
      return data;
    });
    await probe('long-chinese', 'doc-center', async () => {
      await harness.evaluate(browser.cdp, browser.sessionId, 'window.XJ_PROTOTYPE.setFixture("long-chinese")');
      const data = await harness.evaluate(browser.cdp, browser.sessionId, `(() => { const el=document.querySelector('.state-block'); return {text:el.innerText, scrollWidth:el.scrollWidth, clientWidth:el.clientWidth}; })()`);
      if (data.text.length < 80 || data.scrollWidth > data.clientWidth + 1) throw new Error('long Chinese clipped');
      return data;
    });
    await probe('reduced-motion', 'index', async () => {
      await browser.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, browser.sessionId);
      const data = await harness.evaluate(browser.cdp, browser.sessionId, `(() => { const el=document.querySelector('.sidebar'); return {matches:matchMedia('(prefers-reduced-motion: reduce)').matches, transition:getComputedStyle(el).transitionDuration}; })()`);
      if (!data.matches || parseFloat(data.transition) > 0.01) throw new Error('reduced motion not honored');
      await browser.cdp.send('Emulation.setEmulatedMedia', { features: [] }, browser.sessionId);
      return data;
    });
  } finally {
    removeListener();
    await browser.close();
    await new Promise((resolve) => server.server.close(resolve));
  }
  const failed = checks.filter((item) => item.status === 'FAIL');
  const result = { task_id: TASK_ID, suite: 'interaction-probes', total: checks.length, passed: checks.length - failed.length, failed: failed.length, console_errors: errors.console.length, page_errors: errors.page.length, checks };
  fs.writeFileSync(path.join(EVIDENCE, 'interaction-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ total: result.total, passed: result.passed, failed: result.failed, consoleErrors: result.console_errors, pageErrors: result.page_errors }, null, 2));
  process.exit(failed.length === 0 && errors.console.length === 0 && errors.page.length === 0 ? 0 : 1);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
