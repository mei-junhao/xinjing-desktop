/**
 * XinJing 5.0 Full UI System Prototype - Browser Matrix Tests (REAL BROWSER)
 * Uses puppeteer-core + Microsoft Edge.
 *
 * Phase 1: 22 routes × (1366x768 / Clinical / light) smoke: DOM + screenshot evidence
 * Phase 2: 7 key pages × 3 viewports × 3 skins × 2 modes = 18 cells per page = 126 matrix cells
 *
 * Key pages: Dashboard, Masters, Supervision, Transcript, Doc Center, Activation, Settings
 * Viewports: 1024x700, 1366x768, 1920x1080
 * Skins: Clinical, Theatre, Observatory
 * Modes: light, dark
 *
 * Also runs 13 interaction probes on each session.
 *
 * Exit codes: 0 = all pass, 1 = failures, 2 = setup error
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..', '..', 'design-previews', '5.0.0-trae-full-ui-system-prototype');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EVIDENCE_DIR = path.resolve(__dirname, 'evidence', 'browser-matrix');
const SHOTS_DIR = path.join(EVIDENCE_DIR, 'screenshots');
const DOM_DIR = path.join(EVIDENCE_DIR, 'dom-snapshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DOM_DIR, { recursive: true });

const ROUTES = JSON.parse(fs.readFileSync(path.join(PROTOTYPE_DIR, 'route-manifest.json'), 'utf-8'));

const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const SKINS = ['clinical', 'theatre', 'observatory'];
const MODES = ['light', 'dark'];
const KEY_PAGES = ['index', 'masters', 'supervision', 'transcript', 'doc-center', 'activation', 'settings'];

// --- Static server ---
function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };
    const connections = new Set();
    const srv = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const filePath = path.join(dir, urlPath);
      if (!filePath.startsWith(dir)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });
    srv._forceClose = () => {
      for (const sock of connections) sock.destroy();
      connections.clear();
      return new Promise(r => srv.close(r));
    };
    srv.listen(port, '127.0.0.1', () => {
      srv._actualPort = srv.address().port;
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

function safeFilename(s) { return s.replace(/[^a-z0-9_-]/gi, '_'); }

function getShellLayoutChecks() {
  const app = document.querySelector('#app');
  const sidebar = document.querySelector('.sidebar');
  const topbar = document.querySelector('.topbar');
  const main = document.querySelector('#main-content');
  const appRect = app && app.getBoundingClientRect();
  const sidebarRect = sidebar && sidebar.getBoundingClientRect();
  const topbarRect = topbar && topbar.getBoundingClientRect();
  const mainRect = main && main.getBoundingClientRect();
  const expectedW = window.innerWidth <= 1024 && window.innerWidth > 768
    ? 60
    : (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240);
  return {
    appShellApplied: !!app && app.classList.contains('app-shell') && getComputedStyle(app).display === 'grid',
    sidebarFixedWidth: !!sidebarRect && Math.abs(sidebarRect.width - expectedW) <= 2,
    sidebarSpansViewportHeight: !!sidebarRect && sidebarRect.height >= window.innerHeight - 2,
    topbarRightOfSidebar: !!topbarRect && topbarRect.left >= expectedW - 2 && topbarRect.top < 80,
    mainRightOfSidebar: !!mainRect && mainRect.left >= expectedW - 2 && mainRect.top >= 50 && mainRect.top < 120,
    mainVisibleInFirstViewport: !!mainRect && mainRect.top < Math.min(140, window.innerHeight * 0.25),
    appCoversViewport: !!appRect && appRect.width >= window.innerWidth - 2 && appRect.height >= window.innerHeight - 2,
  };
}

// --- Interaction probes (run on each page) ---
async function runInteractionProbes(page, routeId) {
  const probes = {};

  // I1: Route switch works
  probes.routeHash = await page.evaluate((expected) => location.hash.slice(1) === expected, routeId);

  // I2: Dialog opens + Escape closes
  try {
    await page.evaluate(() => {
      if (window.XJTest) XJTest.showDialog({ title: '探针测试', body: '探针对话框内容', actions: [{ label: '取消' }, { label: '确认', primary: true }] });
    });
    await sleep(200);
    const dialogOpen = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
    await page.keyboard.press('Escape');
    await sleep(200);
    const dialogClosed = await page.evaluate(() => !document.querySelector('.dialog-overlay'));
    probes.dialogEscape = dialogOpen && dialogClosed;
  } catch (e) { probes.dialogEscape = false; probes.dialogEscapeErr = e.message; }

  // I3: Ctrl+S save
  try {
    await page.evaluate(() => { if (window.XJTest) { XJTest.state.unsavedChanges = true; } });
    await sleep(100);
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await sleep(300);
    probes.ctrlSave = await page.evaluate(() => window.XJTest ? !window.XJTest.state.unsavedChanges : false);
  } catch (e) { probes.ctrlSave = false; }

  // I4: Focusability - main content is programmatically focusable
  try {
    probes.mainFocusable = await page.evaluate(() => {
      const m = document.querySelector('#main-content');
      if (!m) return false;
      m.focus();
      return document.activeElement === m;
    });
  } catch (e) { probes.mainFocusable = false; }

  // I5: No horizontal overflow
  try {
    probes.noHOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  } catch (e) { probes.noHOverflow = false; }

  // I6: ARIA navigation role
  try {
    probes.navRole = await page.evaluate(() => !!document.querySelector('nav[role="navigation"]'));
  } catch (e) { probes.navRole = false; }

  // I7: Toast appears on save
  try {
    const toastVisible = await page.evaluate(() => !!document.querySelector('.toast'));
    probes.toastOnSave = toastVisible;
  } catch (e) { probes.toastOnSave = false; }

  // I8: Debug bar hidden by default
  try {
    probes.debugBarHidden = await page.evaluate(() => {
      const db = document.querySelector('.dev-bar');
      if (!db) return true;
      const cs = getComputedStyle(db);
      return cs.display === 'none' || cs.visibility === 'hidden' || db.offsetHeight === 0;
    });
  } catch (e) { probes.debugBarHidden = false; }

  // I9: Sidebar renders with items
  try {
    probes.sidebarHasItems = await page.evaluate(() => document.querySelectorAll('.sidebar-item').length >= 10);
  } catch (e) { probes.sidebarHasItems = false; }

  // I9b: Fixed desktop shell grid is applied
  try {
    probes.shellLayout = await page.evaluate(() => {
      const app = document.querySelector('#app');
      const sidebar = document.querySelector('.sidebar');
      const topbar = document.querySelector('.topbar');
      const main = document.querySelector('#main-content');
      const appRect = app && app.getBoundingClientRect();
      const sidebarRect = sidebar && sidebar.getBoundingClientRect();
      const topbarRect = topbar && topbar.getBoundingClientRect();
      const mainRect = main && main.getBoundingClientRect();
      const expectedW = window.innerWidth <= 1024 && window.innerWidth > 768
        ? 60
        : (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240);
      const checks = {
        appShellApplied: !!app && app.classList.contains('app-shell') && getComputedStyle(app).display === 'grid',
        sidebarFixedWidth: !!sidebarRect && Math.abs(sidebarRect.width - expectedW) <= 2,
        sidebarSpansViewportHeight: !!sidebarRect && sidebarRect.height >= window.innerHeight - 2,
        topbarRightOfSidebar: !!topbarRect && topbarRect.left >= expectedW - 2 && topbarRect.top < 80,
        mainRightOfSidebar: !!mainRect && mainRect.left >= expectedW - 2 && mainRect.top >= 50 && mainRect.top < 120,
        mainVisibleInFirstViewport: !!mainRect && mainRect.top < Math.min(140, window.innerHeight * 0.25),
        appCoversViewport: !!appRect && appRect.width >= window.innerWidth - 2 && appRect.height >= window.innerHeight - 2,
      };
      return Object.values(checks).every(Boolean);
    });
  } catch (e) { probes.shellLayout = false; probes.shellLayoutErr = e.message; }

  // I10: Page title present
  try {
    probes.hasPageTitle = await page.evaluate(() => !!document.querySelector('.page-title, h1, h2'));
  } catch (e) { probes.hasPageTitle = false; }

  // I11: Tab key moves focus (first interactive element)
  try {
    await page.keyboard.press('Tab');
    await sleep(100);
    const activeIsInteractive = await page.evaluate(() => {
      const a = document.activeElement;
      return a && (a.tagName === 'BUTTON' || a.tagName === 'A' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.getAttribute('role') === 'button' || a.tabIndex >= 0);
    });
    probes.tabMovesFocus = activeIsInteractive;
  } catch (e) { probes.tabMovesFocus = false; }

  // I12: Console errors check
  // (collected at page level, not per probe)

  // I13: Dialog backdrop click closes
  try {
    await page.evaluate(() => {
      if (window.XJTest) XJTest.showDialog({ title: 'Backdrop', body: 'b', actions: [{ label: 'OK' }] });
    });
    await sleep(200);
    await page.evaluate(() => {
      const o = document.querySelector('.dialog-overlay');
      if (o) {
        const r = o.getBoundingClientRect();
        o.dispatchEvent(new MouseEvent('click', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
      }
    });
    await sleep(200);
    probes.backdropClose = await page.evaluate(() => !document.querySelector('.dialog-overlay'));
  } catch (e) { probes.backdropClose = false; }

  return probes;
}

async function capturePageEvidence(page, shotPath, domPath, label) {
  // Screenshot
  await page.screenshot({ path: shotPath, fullPage: false });
  // DOM snapshot (outerHTML of #app)
  const domHtml = await page.evaluate(() => {
    const app = document.querySelector('#app');
    return app ? app.outerHTML.slice(0, 200000) : '<div id="app">NOT FOUND</div>';
  });
  fs.writeFileSync(domPath, `<!-- ${label} -->\n` + domHtml, 'utf-8');
}

async function main() {
  if (!fs.existsSync(EDGE_PATH)) { console.error('Edge not found'); process.exit(2); }
  if (!fs.existsSync(path.join(PROTOTYPE_DIR, 'index.html'))) { console.error('Prototype not found'); process.exit(2); }

  const server = await startServer(PROTOTYPE_DIR, 0);
  const BASE = `http://127.0.0.1:${server._actualPort}/index.html`;
  console.log('Browser matrix server at', BASE);

  let browser;
  const allResults = { phase1: { total: 0, pass: 0, fail: 0, routes: [] }, phase2: { total: 0, pass: 0, fail: 0, cells: [] }, interactions: { total: 0, pass: 0, fail: 0 } };
  const consoleErrors = [];

  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      defaultViewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
    });

    // ========== PHASE 1: 22 routes smoke (1366x768 / Clinical / light) ==========
    console.log('\n=== Phase 1: 22-route smoke (1366x768 / Clinical / light) ===');
    const page = await browser.newPage();
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push({ route: 'nav', text: msg.text() }); });
    page.on('pageerror', err => consoleErrors.push({ route: 'pageerr', text: err.message }));

    await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
    await sleep(800);

    // Set defaults: Clinical + light
    await page.evaluate(() => { if (window.XJTest) { XJTest.setSkin('clinical'); XJTest.setMode('light'); } });
    await sleep(400);

    for (let i = 0; i < ROUTES.length; i++) {
      const route = ROUTES[i];
      const label = `phase1_${safeFilename(route.id)}`;
      process.stdout.write(`  [${i+1}/22] ${route.id} ... `);

      await page.evaluate(h => { location.hash = h; }, route.pattern);
      await sleep(500);

      // Capture evidence
      const shotPath = path.join(SHOTS_DIR, `${label}.png`);
      const domPath = path.join(DOM_DIR, `${label}.html`);
      await capturePageEvidence(page, shotPath, domPath, `${route.id} - 1366x768 Clinical light`);

      // Verify: main content exists, route matches, no h-overflow
      const checks = await page.evaluate((expected) => {
        const main = document.querySelector('#main-content');
        const docW = document.documentElement.scrollWidth;
        const winW = window.innerWidth;
        const title = document.querySelector('.page-title, h1, h2');
        const app = document.querySelector('#app');
        const sidebar = document.querySelector('.sidebar');
        const topbar = document.querySelector('.topbar');
        const appRect = app && app.getBoundingClientRect();
        const sidebarRect = sidebar && sidebar.getBoundingClientRect();
        const topbarRect = topbar && topbar.getBoundingClientRect();
        const mainRect = main && main.getBoundingClientRect();
        const expectedW = window.innerWidth <= 1024 && window.innerWidth > 768
          ? 60
          : (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240);
        const shellLayoutDetails = {
          appShellApplied: !!app && app.classList.contains('app-shell') && getComputedStyle(app).display === 'grid',
          sidebarFixedWidth: !!sidebarRect && Math.abs(sidebarRect.width - expectedW) <= 2,
          sidebarSpansViewportHeight: !!sidebarRect && sidebarRect.height >= window.innerHeight - 2,
          topbarRightOfSidebar: !!topbarRect && topbarRect.left >= expectedW - 2 && topbarRect.top < 80,
          mainRightOfSidebar: !!mainRect && mainRect.left >= expectedW - 2 && mainRect.top >= 50 && mainRect.top < 120,
          mainVisibleInFirstViewport: !!mainRect && mainRect.top < Math.min(140, window.innerHeight * 0.25),
          appCoversViewport: !!appRect && appRect.width >= window.innerWidth - 2 && appRect.height >= window.innerHeight - 2,
        };
        return {
          mainExists: !!main,
          mainHasChildren: main && main.children.length > 0,
          routeMatches: location.hash.slice(1) === expected,
          noOverflow: docW <= winW + 2,
          hasTitle: !!title,
          skinMatches: document.documentElement.getAttribute('data-skin') === 'clinical',
          modeMatches: document.documentElement.getAttribute('data-mode') === 'light',
          shellLayout: Object.values(shellLayoutDetails).every(Boolean),
          shellLayoutDetails,
        };
      }, route.pattern);

      const pass = checks.mainExists && checks.mainHasChildren && checks.routeMatches && checks.noOverflow && checks.hasTitle && checks.skinMatches && checks.modeMatches && checks.shellLayout;
      allResults.phase1.total++;
      if (pass) allResults.phase1.pass++; else allResults.phase1.fail++;
      allResults.phase1.routes.push({ id: route.id, pass, checks, shotPath, domPath });
      console.log(pass ? 'PASS' : `FAIL (${JSON.stringify(checks)})`);
    }
    await page.close();

    // ========== PHASE 2: 7 key pages × 3 viewports × 3 skins × 2 modes = 126 cells ==========
    console.log('\n=== Phase 2: 7 key pages × 3vp × 3skin × 2mode = 126 matrix cells ===');

    let cellIdx = 0;
    const totalCells = KEY_PAGES.length * VIEWPORTS.length * SKINS.length * MODES.length;

    for (const vp of VIEWPORTS) {
      for (const skin of SKINS) {
        for (const mode of MODES) {
          // One page per (vp, skin, mode) combo; navigate through 7 key pages
          const page2 = await browser.newPage();
          const pageErrs = [];
          page2.on('pageerror', err => pageErrs.push(err.message));
          await page2.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
          await page2.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
          await sleep(600);

          await page2.evaluate((s, m) => { if (window.XJTest) { XJTest.setSkin(s); XJTest.setMode(m); } }, skin, mode);
          await sleep(400);

          for (const pageId of KEY_PAGES) {
            cellIdx++;
            const route = ROUTES.find(r => r.id === pageId);
            if (!route) continue;
            const label = `matrix_${vp.name}_${skin}_${mode}_${safeFilename(pageId)}`;
            process.stdout.write(`  [${cellIdx}/${totalCells}] ${vp.width}x${vp.height} / ${skin} / ${mode} / ${pageId} ... `);

            await page2.evaluate(h => { location.hash = h; }, route.pattern);
            await sleep(500);

            const shotPath = path.join(SHOTS_DIR, `${label}.png`);
            const domPath = path.join(DOM_DIR, `${label}.html`);
            await capturePageEvidence(page2, shotPath, domPath, `${pageId} - ${vp.name} ${skin} ${mode}`);

            // Run interaction probes for key cells (1366x768 / clinical / light for all 7 pages)
            let probes = null;
            if (vp.name === '1366x768' && skin === 'clinical' && mode === 'light') {
              probes = await runInteractionProbes(page2, pageId);
              for (const [k, v] of Object.entries(probes)) {
                if (typeof v === 'boolean') {
                  allResults.interactions.total++;
                  if (v) allResults.interactions.pass++; else allResults.interactions.fail++;
                }
              }
            }

            const checks = await page2.evaluate(({ expectedRoute, expectedSkin, expectedMode }) => {
              const main = document.querySelector('#main-content');
              const docW = document.documentElement.scrollWidth;
              const winW = window.innerWidth;
              const db = document.querySelector('.dev-bar');
              const dbHidden = !db || getComputedStyle(db).display === 'none' || db.offsetHeight === 0;
              const skinOk = document.documentElement.getAttribute('data-skin');
              const modeOk = document.documentElement.getAttribute('data-mode');
              const app = document.querySelector('#app');
              const sidebar = document.querySelector('.sidebar');
              const topbar = document.querySelector('.topbar');
              const appRect = app && app.getBoundingClientRect();
              const sidebarRect = sidebar && sidebar.getBoundingClientRect();
              const topbarRect = topbar && topbar.getBoundingClientRect();
              const mainRect = main && main.getBoundingClientRect();
              const expectedW = window.innerWidth <= 1024 && window.innerWidth > 768
                ? 60
                : (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240);
              const shellLayoutDetails = {
                appShellApplied: !!app && app.classList.contains('app-shell') && getComputedStyle(app).display === 'grid',
                sidebarFixedWidth: !!sidebarRect && Math.abs(sidebarRect.width - expectedW) <= 2,
                sidebarSpansViewportHeight: !!sidebarRect && sidebarRect.height >= window.innerHeight - 2,
                topbarRightOfSidebar: !!topbarRect && topbarRect.left >= expectedW - 2 && topbarRect.top < 80,
                mainRightOfSidebar: !!mainRect && mainRect.left >= expectedW - 2 && mainRect.top >= 50 && mainRect.top < 120,
                mainVisibleInFirstViewport: !!mainRect && mainRect.top < Math.min(140, window.innerHeight * 0.25),
                appCoversViewport: !!appRect && appRect.width >= window.innerWidth - 2 && appRect.height >= window.innerHeight - 2,
              };
              return {
                mainExists: !!main,
                mainHasChildren: main && main.children.length > 0,
                routeMatches: location.hash.slice(1) === expectedRoute,
                noOverflow: docW <= winW + 2,
                devBarHidden: dbHidden,
                noPageErrors: true,
                skinMatches: skinOk === expectedSkin,
                modeMatches: modeOk === expectedMode,
                shellLayout: Object.values(shellLayoutDetails).every(Boolean),
                shellLayoutDetails,
              };
            }, { expectedRoute: route.pattern, expectedSkin: skin, expectedMode: mode });
            checks.noPageErrors = pageErrs.length === 0;

            const pass = checks.mainExists && checks.mainHasChildren && checks.routeMatches && checks.noOverflow && checks.devBarHidden && checks.skinMatches && checks.modeMatches && checks.shellLayout && checks.noPageErrors;
            allResults.phase2.total++;
            if (pass) allResults.phase2.pass++; else allResults.phase2.fail++;
            allResults.phase2.cells.push({ vp: vp.name, skin, mode, pageId, pass, checks, shotPath, domPath, probes, pageErrors: pageErrs.slice(0,2) });
            console.log(pass ? 'PASS' : `FAIL (${JSON.stringify(checks)})`);
          }
          await page2.close();
        }
      }
    }

  } catch (err) {
    console.error('Matrix runner error:', err.message);
    if (browser) await browser.close().catch(() => {});
    if (server && server._forceClose) await server._forceClose();
    else if (server) await new Promise(r => server.close(r));
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'matrix-results.json'), JSON.stringify({ error: err.message, phase1: allResults.phase1, phase2: allResults.phase2 }, null, 2), 'utf-8');
    process.exit(2);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server._forceClose) await server._forceClose();
    else if (server) await new Promise(r => server.close(r));
  }

  // --- Write results ---
  const summary = {
    timestamp: new Date().toISOString(),
    phase1: allResults.phase1,
    phase2: allResults.phase2,
    interactions: allResults.interactions,
    consoleErrors: consoleErrors.slice(0, 20),
    screenshotsDir: SHOTS_DIR,
    domDir: DOM_DIR,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'matrix-results.json'), JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n=== Browser Matrix Results ===`);
  console.log(`Phase 1 (22-route smoke): ${allResults.phase1.pass}/${allResults.phase1.total} passed`);
  console.log(`Phase 2 (126-cell matrix): ${allResults.phase2.pass}/${allResults.phase2.total} passed`);
  console.log(`Interaction probes: ${allResults.interactions.pass}/${allResults.interactions.total} passed`);

  const anyFail = allResults.phase1.fail > 0
    || allResults.phase2.fail > 0
    || allResults.interactions.fail > 0
    || consoleErrors.length > 0;
  process.exit(anyFail ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
