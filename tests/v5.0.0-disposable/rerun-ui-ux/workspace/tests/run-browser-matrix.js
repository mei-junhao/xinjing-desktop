'use strict';

const fs = require('fs');
const path = require('path');
const { launchEdge } = require('./browser-cdp');
const { ROUTES, VIEWPORTS, SKINS, THEMES } = require('./fixture');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const RUN_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence');
const SCREENSHOT_ROOT = path.join(EVIDENCE_ROOT, 'visual-matrix');
const PROTOTYPE = path.join(PROJECT_ROOT, 'design-previews/5.0.0-rerun-ui-ux/index.html');
const URL = require('url').pathToFileURL(PROTOTYPE).href;

function escapeSelector(value) { return value.replaceAll('"', '\\"'); }
function metricsExpression() {
  return `(() => { const width = window.innerWidth; const height = window.innerHeight; const horizontalOverflow = [...document.querySelectorAll('*')].filter((node) => { const r = node.getBoundingClientRect(); return r.right > width + 1 || r.left < -1; }).slice(0, 12).map((node) => node.className || node.id || node.tagName); const main = document.querySelector('.route-view')?.getBoundingClientRect(); const inspector = document.querySelector('.inspector')?.getBoundingClientRect(); return { width, height, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, horizontalOverflow, verticalScrollExpected: document.documentElement.scrollHeight > height, mainVisible: Boolean(main && main.width > 0), inspectorOverlap: Boolean(main && inspector && inspector.width > 0 && main.right > inspector.left && main.left < inspector.right) }; })()`;
}

async function main() {
  fs.mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  const page = await launchEdge();
  const visual = [];
  const routeSmoke = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const skin of SKINS) {
        for (const theme of THEMES) {
          await page.setViewport(viewport.width, viewport.height);
          await page.navigate(URL);
          await page.click(`[data-skin-choice="${skin}"]`);
          await page.click(`[data-theme-choice="${theme}"]`);
          await page.click('[data-action="toggle-motion"]');
          const state = await page.evaluate(`window.__xjReview.getState()`);
          const metrics = await page.evaluate(metricsExpression());
          if (metrics.horizontalOverflow.length || metrics.scrollWidth > metrics.clientWidth) throw new Error(`HORIZONTAL_OVERFLOW ${viewport.name}-${skin}-${theme}`);
          const screenshotPath = path.join(SCREENSHOT_ROOT, `${viewport.name}-${skin}-${theme}.png`);
          fs.writeFileSync(screenshotPath, await page.screenshot());
          visual.push({ viewport: viewport.name, skin, theme, reducedMotion: state.reducedMotion, metrics, screenshot: path.relative(RUN_ROOT, screenshotPath).replaceAll(path.sep, '/') });
        }
      }
    }

    await page.setViewport(1366, 768);
    await page.navigate(URL);
    for (const route of ROUTES) {
      const clicked = await page.click(`[data-route="${escapeSelector(route)}"]`);
      const record = await page.evaluate(`(() => ({ route: document.querySelector('.route-view')?.dataset.route, heading: document.querySelector('.route-view h2')?.textContent || '', clicked: ${clicked ? 'true' : 'false'}, actionCount: document.querySelectorAll('.route-view [data-action]').length, bodyWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }))()`);
      routeSmoke.push(record);
    }
    const result = { task_id: TASK_ID, status: 'PASS', browser: page.browserInfo, visual_matrix: visual, route_smoke: routeSmoke, console_errors: page.drainConsole() };
    fs.writeFileSync(path.join(EVIDENCE_ROOT, 'browser-matrix-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`BROWSER MATRIX PASS visual=${visual.length} route_smoke=${routeSmoke.length} console_errors=${result.console_errors.length}`);
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  const blocked = error.code === 'BROWSER_UNAVAILABLE' || /REAL_BROWSER_UNAVAILABLE|CDP_|WEBSOCKET/.test(error.message);
  const result = { task_id: TASK_ID, status: blocked ? 'BLOCKED_REAL_BROWSER_UNAVAILABLE' : 'FAIL', error: error.message, browser_executable: require('./browser-cdp').findEdge() || null };
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'browser-matrix-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.error(`${result.status}: ${error.message}`);
  process.exitCode = blocked ? 2 : 1;
});
