'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('D:/xinjing-electron/node_modules/pngjs');
const harness = require('./cdp-harness');

const TASK_ID = 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-r2-297';
const ROOT = 'D:/xinjing-electron';
const CANDIDATE = path.join(ROOT, 'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype-r2-297');
const WORKSPACE = path.join(ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace');
const EVIDENCE = path.join(WORKSPACE, 'evidence/browser-matrix');
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots');
const DOM = path.join(EVIDENCE, 'dom-snapshots');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'route-manifest.json'), 'utf8'));
const mode = process.argv.includes('--matrix') ? 'matrix' : 'smoke';
const cells = mode === 'smoke'
  ? MANIFEST.routes.map((route) => ({ kind: 'smoke', route: route.id, viewport: { id: 'standard', width: 1366, height: 768 }, skin: 'clinical', mode: 'light' }))
  : MANIFEST.representative_routes.flatMap((route) => MANIFEST.viewports.flatMap((viewport) => MANIFEST.skins.flatMap((skin) => MANIFEST.modes.map((colorMode) => ({ kind: 'matrix', route, viewport, skin, mode: colorMode })))));

(async () => {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  fs.mkdirSync(DOM, { recursive: true });
  const server = await harness.startStaticServer(CANDIDATE);
  const debugPort = mode === 'smoke' ? 9337 : 9338;
  const profile = path.join(WORKSPACE, 'scratch', `edge-profile-${mode}`);
  const browser = await harness.launch({ debugPort, profile });
  const events = { console: [], pageErrors: [], network: [] };
  const removeListener = browser.cdp.onEvent((message) => {
    if (message.sessionId !== browser.sessionId) return;
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') events.console.push(message.params);
    if (message.method === 'Runtime.exceptionThrown') events.pageErrors.push(message.params);
    if (message.method === 'Network.requestWillBeSent') events.network.push(message.params.request.url);
  });
  const results = [];
  let exitCode = 0;
  try {
    for (const cell of cells) {
      await harness.setViewport(browser.cdp, browser.sessionId, cell.viewport.width, cell.viewport.height);
      const fragment = `route=${encodeURIComponent(cell.route)}&skin=${cell.skin}&mode=${cell.mode}&fixture=ready`;
      const url = `http://127.0.0.1:${server.port}/index.html#${fragment}`;
      const beforeConsole = events.console.length;
      const beforeErrors = events.pageErrors.length;
      const beforeNetwork = events.network.length;
      await harness.navigate(browser.cdp, browser.sessionId, url);
      const fileBase = `${cell.kind}__${cell.route}__${cell.viewport.id}-${cell.viewport.width}x${cell.viewport.height}__${cell.skin}__${cell.mode}`;
      const pngPath = path.join(SCREENSHOTS, fileBase + '.png');
      const domPath = path.join(DOM, fileBase + '.html');
      await harness.screenshot(browser.cdp, browser.sessionId, pngPath);
      await harness.snapshot(browser.cdp, browser.sessionId, domPath);
      const png = PNG.sync.read(fs.readFileSync(pngPath));
      const layout = await harness.metrics(browser.cdp, browser.sessionId);
      const requests = events.network.slice(beforeNetwork);
      const external = requests.filter((requestUrl) => !requestUrl.startsWith(`http://127.0.0.1:${server.port}/`));
      const pass = png.width === cell.viewport.width && png.height === cell.viewport.height && !layout.horizontalOverflow && layout.overlapCount === 0 && layout.clippedCount === 0 && !layout.blankCanvas && events.console.length === beforeConsole && events.pageErrors.length === beforeErrors && external.length === 0;
      if (!pass) exitCode = 1;
      results.push({ ...cell, url, screenshot: pngPath.replace(/\\/g, '/'), dom_snapshot: domPath.replace(/\\/g, '/'), screenshot_width: png.width, screenshot_height: png.height, layout, console_errors: events.console.length - beforeConsole, page_errors: events.pageErrors.length - beforeErrors, network_requests: requests, external_network_requests: external, pass });
    }
  } finally {
    removeListener();
    await browser.close();
    await new Promise((resolve) => server.server.close(resolve));
  }
  const result = { task_id: TASK_ID, suite: `browser-${mode}`, runtime: 'Microsoft Edge headless via Chrome DevTools Protocol', expected_cells: mode === 'smoke' ? 22 : 126, cells: results.length, passed: results.filter((item) => item.pass).length, failed: results.filter((item) => !item.pass).length, browser_stderr: browser.stderr(), results };
  fs.writeFileSync(path.join(EVIDENCE, `${mode}-results.json`), JSON.stringify(result, null, 2) + '\n');
  if (mode === 'matrix') fs.writeFileSync(path.join(EVIDENCE, 'matrix-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ suite: result.suite, expected: result.expected_cells, cells: result.cells, passed: result.passed, failed: result.failed }, null, 2));
  process.exit(exitCode);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
