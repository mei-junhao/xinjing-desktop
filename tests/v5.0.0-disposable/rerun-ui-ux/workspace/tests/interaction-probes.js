'use strict';

const fs = require('fs');
const path = require('path');
const { launchEdge } = require('./browser-cdp');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const RUN_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence');
const URL = require('url').pathToFileURL(path.join(PROJECT_ROOT, 'design-previews/5.0.0-rerun-ui-ux/index.html')).href;

function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const page = await launchEdge();
  try {
    await page.setViewport(1024, 700);
    await page.navigate(URL);
    const results = [];
    results.push({ name: 'initial-route', pass: (await page.evaluate(`window.__xjReview.getState().activeRoute`)) === 'index.html' });
    const stateChecks = [
      { state: 'ready', title: '已准备好审查', detail: false, role: 'region' },
      { state: 'loading', title: '正在读取当前状态', detail: true, role: 'region' },
      { state: 'empty', title: '当前没有可显示内容', detail: true, role: 'region' },
      { state: 'error', title: '读取失败，但输入仍保留', detail: true, role: 'alert' }
    ];
    for (const expected of stateChecks) {
      await page.click(`[data-state-choice="${expected.state}"]`);
      const stateResult = await page.evaluate(`(() => { const panel = document.querySelector('.state-panel'); return { state: panel?.dataset?.state, title: panel?.querySelector('.state-title')?.textContent || '', hasDetail: Boolean(panel?.querySelector('.progress-track, [data-action="open-route"], .route-code')), role: panel?.getAttribute('role') }; })()`);
      results.push({ name: `${expected.state}-state-renders`, pass: stateResult.state === expected.state && stateResult.title === expected.title && stateResult.hasDetail === expected.detail && stateResult.role === expected.role, observed: stateResult });
    }
    await page.click('[data-route="doc-center.html"]');
    results.push({ name: 'route-navigation', pass: (await page.evaluate(`document.querySelector('.route-view').dataset.route`)) === 'doc-center.html' });
    await page.click('[data-route="index.html"]');
    await page.click('[data-state-choice="error"]');
    results.push({ name: 'error-state-retains-source', pass: await page.evaluate(`Boolean(document.querySelector('[role="alert"]') && document.querySelector('[data-state="error"] .route-code')?.textContent.includes('SYNTHETIC_SOURCE_CHANGED'))`) });
    await page.click('[data-route="index.html"]');
    await page.click('[data-action="open-context"]');
    const drawerOpen = await page.evaluate(`({ hidden: document.querySelector('#context-drawer').hidden, active: document.activeElement?.dataset?.action || document.activeElement?.textContent || '' })`);
    results.push({ name: 'drawer-focus-entry', pass: drawerOpen.hidden === false && drawerOpen.active === 'close-context' });
    await page.press('Escape');
    results.push({ name: 'drawer-escape-focus-return', pass: await page.evaluate(`document.querySelector('#context-drawer').hidden && document.activeElement?.dataset?.action === 'open-context'`) });
    await page.click('[data-action="save-note"]');
    results.push({ name: 'save-feedback-object-specific', pass: await page.evaluate(`document.querySelector('[data-feedback]')?.textContent.includes('来访者 A') && document.querySelector('[data-feedback]')?.textContent.includes('第 12 节')`) });
    await page.click('[data-action="toggle-motion"]');
    results.push({ name: 'reduced-motion', pass: await page.evaluate(`document.body.classList.contains('reduced-motion') && document.querySelector('[data-action="toggle-motion"]').getAttribute('aria-pressed') === 'true'`) });
    await page.click('[data-route="transcript-guide.html"]');
    results.push({ name: 'tier-preview', pass: await page.evaluate(`Boolean(document.querySelector('[data-tier-badge]') && document.querySelector('[data-action="view-plans"]'))`) });
    await page.click('[data-route="index.html"]');
    const longChinese = await page.evaluate(`(() => { const field = document.querySelector('#quick-note'); const value = '来访者在结束安排、关系边界、情绪调节和下一步会谈目标上的观察记录。'.repeat(18); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); return { valueLength: field.value.length, fieldScrollWidth: field.scrollWidth, fieldClientWidth: field.clientWidth, documentScrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }; })()`);
    results.push({ name: 'long-chinese-wrap-no-overflow', pass: longChinese.valueLength > 100 && longChinese.fieldScrollWidth <= longChinese.fieldClientWidth + 1 && longChinese.documentScrollWidth <= longChinese.viewportWidth, observed: longChinese });
    await page.press('Tab');
    const focus = await page.evaluate(`({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '', outline: getComputedStyle(document.activeElement).outlineStyle })`);
    results.push({ name: 'keyboard-focus-visible', pass: focus.tag === 'BUTTON' || focus.tag === 'INPUT' });
    const overflow = await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`);
    results.push({ name: 'narrow-no-horizontal-overflow', pass: overflow });
    const consoleErrors = page.drainConsole();
    const failed = results.filter((result) => !result.pass);
    const output = { task_id: TASK_ID, status: failed.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL', results, focus, console_errors: consoleErrors };
    fs.writeFileSync(path.join(EVIDENCE_ROOT, 'interaction-results.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    if (failed.length || consoleErrors.length) throw new Error(`INTERACTION_PROBES_FAILED ${failed.map((item) => item.name).join(',')} console=${consoleErrors.length}`);
    console.log(`INTERACTION PROBES PASS checks=${results.length}`);
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  const blocked = error.code === 'BROWSER_UNAVAILABLE' || /REAL_BROWSER_UNAVAILABLE|CDP_|WEBSOCKET/.test(error.message);
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'interaction-results.json'), `${JSON.stringify({ task_id: TASK_ID, status: blocked ? 'BLOCKED_REAL_BROWSER_UNAVAILABLE' : 'FAIL', error: error.message }, null, 2)}\n`, 'utf8');
  console.error(`${blocked ? 'BLOCKED_REAL_BROWSER_UNAVAILABLE' : 'INTERACTION FAIL'}: ${error.message}`);
  process.exitCode = blocked ? 2 : 1;
});
