/**
 * XinJing 5.0 Full UI System Prototype - Contract Tests (REAL BROWSER)
 * Uses puppeteer-core + Microsoft Edge to validate real behavioral contracts.
 *
 * Exit codes:
 *   0  ALL contracts pass
 *   1  One or more contracts FAILED
 *   2  Environment/setup error (browser not found, server not started, etc.)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..', '..', 'design-previews', '5.0.0-trae-full-ui-system-prototype');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EVIDENCE_DIR = path.resolve(__dirname, 'evidence', 'contract');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const ROUTES = JSON.parse(fs.readFileSync(path.join(PROTOTYPE_DIR, 'route-manifest.json'), 'utf-8'));

// --- Minimal static file server ---
function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

// --- Results ---
const results = [];
let passCount = 0;
let failCount = 0;
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  if (pass) { passCount++; console.log(`  PASS  ${name}`); }
  else { failCount++; console.log(`  FAIL  ${name} :: ${detail || ''}`); }
}

async function assert(page, condition, name, detail) {
  record(name, !!condition, detail || '');
}

async function main() {
  if (!fs.existsSync(EDGE_PATH)) { console.error('Edge not found at', EDGE_PATH); process.exit(2); }
  if (!fs.existsSync(path.join(PROTOTYPE_DIR, 'index.html'))) { console.error('Prototype index.html not found'); process.exit(2); }

  const server = await startServer(PROTOTYPE_DIR, 0);
  const BASE = `http://127.0.0.1:${server._actualPort}/index.html`;
  console.log('Contract server started at', BASE);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--force-prefers-reduced-motion=0'],
      defaultViewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
    });

    // ========== CONTRACT 1: Default skin is Clinical ==========
    {
      const page = await browser.newPage();
      const consoleMsgs = [];
      page.on('console', msg => { if (msg.type() === 'error') consoleMsgs.push(msg.text()); });
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(800);
      const skin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
      record('C1-默认皮肤为Clinical', skin === 'clinical', `data-skin=${skin}`);
      const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      record('C1-默认字体包含系统无衬线栈', /Segoe UI|system-ui|Microsoft YaHei|-apple-system/.test(font), `font=${font}`);
      await page.close();
    }

    // ========== CONTRACT 2: Route switching works ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      // Navigate to each route
      for (const r of ROUTES.slice(0, 10)) {
        await page.evaluate(h => { location.hash = h; }, r.pattern);
        await sleep(200);
        const currentHash = await page.evaluate(() => location.hash.slice(1));
        const hasMain = await page.evaluate(() => !!document.querySelector('#main-content'));
        record(`C2-路由切换${r.id}`, currentHash === r.pattern && hasMain, `hash=${currentHash}, main=${hasMain}`);
      }
      await page.close();
    }

    // ========== CONTRACT 3: Tier-locked entries show lock for free tier ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      await page.evaluate(() => { XJTest.setTier('free'); location.hash = 'masters'; });
      await sleep(500);
      // Check for lock overlay or lock text on flagship/pro routes
      const mastersLock = await page.evaluate(() => {
        const body = document.body.innerText;
        // renderTierLock shows "查看方案" button and "需要 ... 方案" text
        return body.includes('查看方案') || (body.includes('需要') && body.includes('方案')) || !!document.querySelector('.btn-tier-locked');
      });
      record('C3-Free权益下Masters有锁定提示', mastersLock, '');

      // Check another flagship route: supervision
      await page.evaluate(() => { location.hash = 'supervision'; });
      await sleep(400);
      const supLock = await page.evaluate(() => {
        const body = document.body.innerText;
        return body.includes('查看方案') || (body.includes('需要') && body.includes('方案')) || !!document.querySelector('.btn-tier-locked');
      });
      record('C3-Free权益下Supervision有锁定提示', supLock, '');
      const unknownDenied = await page.evaluate(() => window.XJTest.canUse('unknown-feature-key') === false);
      record('C3-未知权益键fail-closed', unknownDenied, '');
      await page.close();
    }

    // ========== CONTRACT 4: Save action works ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      await page.evaluate(() => { location.hash = 'consult-notes'; XJTest.state.unsavedChanges = true; XJTest.renderShell(); XJTest.renderRoute(); });
      await sleep(300);
      // Click save via keyboard Ctrl+S
      await page.keyboard.down('Control');
      await page.keyboard.press('s');
      await page.keyboard.up('Control');
      await sleep(400);
      const saved = await page.evaluate(() => !XJTest.state.unsavedChanges);
      record('C4-Ctrl+S保存后unsavedChanges=false', saved, '');
      const hasToast = await page.evaluate(() => !!document.querySelector('.toast'));
      record('C4-保存后显示Toast提示', hasToast, '');
      await page.close();
    }

    // ========== CONTRACT 5: Dialog Escape closes it ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      // Open a dialog
      await page.evaluate(() => {
        XJTest.showDialog({ title: '测试对话框', body: '按Escape应关闭此对话框', actions: [{ label: '确定', primary: true }] });
      });
      await sleep(300);
      const dialogBefore = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      record('C5-对话框已打开', dialogBefore, `dialog=${dialogBefore}`);
      // Press Escape
      await page.keyboard.press('Escape');
      await sleep(300);
      const dialogAfter = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      record('C5-Escape关闭对话框', dialogBefore && !dialogAfter, `before=${dialogBefore}, after=${dialogAfter}`);
      await page.close();
    }

    // ========== CONTRACT 6: Keyboard file selection entry (Ctrl+O) ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      await page.evaluate(() => { location.hash = 'transcript'; });
      await sleep(500);
      // Check that Ctrl+O handler exists and there is a file input on transcript page
      const hasFileInput = await page.evaluate(() => {
        // Listen for click on file input to detect if .click() was called
        const fi = document.querySelector('input[type="file"]');
        if (fi) {
          window.__fileClickFired = false;
          fi.addEventListener('click', () => { window.__fileClickFired = true; }, { once: true });
        }
        return !!fi;
      });
      record('C6-Transcript页面存在文件选择input', hasFileInput, '');
      if (hasFileInput) {
        // Note: In headless Chrome, file dialog doesn't actually open (it's blocked),
        // but we can verify the click handler fires
        await page.keyboard.down('Control');
        await page.keyboard.press('o');
        await page.keyboard.up('Control');
        await sleep(300);
        const fired = await page.evaluate(() => !!window.__fileClickFired);
        record('C6-Ctrl+O触发文件选择器点击', fired, '');
      } else {
        record('C6-Ctrl+O触发文件选择器点击', false, 'no file input found');
      }
      await page.close();
    }

    // ========== CONTRACT 7: ARIA attributes present ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      const ariaResults = await page.evaluate(() => {
        const nav = document.querySelector('nav[role="navigation"]');
        const main = document.querySelector('#main-content');
        // Main should be programmatically focusable (tabindex=-1 is correct for main landmark)
        const mainFocusable = !!(main && (main.tabIndex >= -1 || main.hasAttribute('tabindex')));
        // Test actual focus
        if (main) { main.focus(); }
        const mainFocused = document.activeElement === main;
        const dialogWhenOpened = (() => {
          XJTest.showDialog({ title: 'ARIA Test', body: 'body', actions: [{ label: 'OK', primary: true }] });
          const d = document.querySelector('.dialog');
          const r = d ? d.getAttribute('role') : null;
          const m = d ? d.getAttribute('aria-modal') : null;
          XJTest.closeDialog();
          return { role: r, modal: m };
        })();
        return { hasNav: !!nav, mainFocusable, mainFocused, dialogRole: dialogWhenOpened.role, dialogModal: dialogWhenOpened.modal };
      });
      record('C7-导航栏有role=navigation', !!ariaResults.hasNav, '');
      record('C7-主内容区可编程聚焦', ariaResults.mainFocusable && ariaResults.mainFocused, `focusable=${ariaResults.mainFocusable}, focused=${ariaResults.mainFocused}`);
      record('C7-对话框有role=dialog', ariaResults.dialogRole === 'dialog', `role=${ariaResults.dialogRole}`);
      record('C7-对话框有aria-modal=true', ariaResults.dialogModal === 'true', `modal=${ariaResults.dialogModal}`);
      await page.close();
    }

    // ========== CONTRACT 8: No horizontal overflow on key pages ==========
    {
      const testRoutes = ['index', 'consult-notes', 'transcript', 'masters', 'supervision', 'doc-center', 'settings'];
      for (const hash of testRoutes) {
        const page = await browser.newPage();
        await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
        await sleep(500);
        await page.evaluate(h => { location.hash = h; }, hash);
        await sleep(500);
        const overflow = await page.evaluate(() => {
          const docW = document.documentElement.scrollWidth;
          const winW = window.innerWidth;
          return docW > winW + 2;
        });
        record(`C8-横向溢出检查${hash}`, !overflow, overflow ? 'scrollWidth > innerWidth' : 'ok');
        await page.close();
      }
    }

    // ========== CONTRACT 9: No console errors on normal navigation ==========
    {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      for (const r of ROUTES.slice(0, 10)) {
        await page.evaluate(h => { location.hash = h; }, r.pattern);
        await sleep(300);
      }
      // Filter out known non-issues (net::ERR for Google Fonts since we removed them)
      const realErrors = consoleErrors.filter(e => !/fonts\.googleapis|fonts\.gstatic|ERR_BLOCKED_BY_CLIENT|favicon/i.test(e));
      record('C9-无未处理console error', realErrors.length === 0 && pageErrors.length === 0,
        `consoleErrors=${realErrors.length}, pageErrors=${pageErrors.length}, first=${realErrors[0] || pageErrors[0] || ''}`);
      await page.close();
    }

    // ========== CONTRACT 10: Layout stability - main content present after each nav ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(500);
      let allStable = true;
      for (const r of ROUTES) {
        await page.evaluate(h => { location.hash = h; }, r.pattern);
        await sleep(200);
        const info = await page.evaluate(() => {
          const main = document.querySelector('#main-content');
          const pageTitle = document.querySelector('.page-title, h1, h2');
          return { mainExists: !!main, mainHasChildren: main && main.children.length > 0, titleExists: !!pageTitle };
        });
        if (!info.mainExists || !info.mainHasChildren || !info.titleExists) {
          allStable = false;
          record(`C10-布局稳定性${r.id}`, false, JSON.stringify(info));
          break;
        }
      }
      if (allStable) record('C10-全部22路由布局稳定', true, '');
      await page.close();
    }

    // ========== CONTRACT 11: Reduced motion is respected ==========
    {
      const page = await browser.newPage();
      // Set reduced motion via CDP
      const client = await page.target().createCDPSession();
      await client.send('Emulation.setEmulatedMedia', { media: 'prefers-reduced-motion', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      const reducedMotion = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      record('C11-reduced-motion媒体查询生效', reducedMotion, `matchMedia=${reducedMotion}`);
      // Check that CSS contains reduced-motion rules (indirect via computed styles)
      const transitionDur = await page.evaluate(() => {
        const btn = document.querySelector('button');
        return btn ? getComputedStyle(btn).transitionDuration : '0s';
      });
      // Under reduced-motion, transitions should be 0s per our CSS
      record('C11-reduced-motion下transition为0s', transitionDur === '0s', `duration=${transitionDur}`);
      await page.close();
    }

    // ========== CONTRACT 12: Long Chinese text doesn't break ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      // Inject a very long Chinese text into main content area
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('#main-content');
        const longText = '这是一段非常长的中文测试文字用来验证布局不会因为长中文内容而发生横向溢出或者文字重叠问题。'.repeat(20);
        const testDiv = document.createElement('div');
        testDiv.style.cssText = 'max-width:100%;word-wrap:break-word;overflow-wrap:break-word;';
        testDiv.textContent = longText;
        main.appendChild(testDiv);
        return document.documentElement.scrollWidth > window.innerWidth + 2;
      });
      record('C12-长中文内容无横向溢出', !overflow, overflow ? 'overflow detected' : 'ok');
      await page.close();
    }

    // ========== CONTRACT 13: Keyboard focus moves into dialog ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(600);
      await page.evaluate(() => {
        XJTest.showDialog({ title: '焦点测试', body: '打开后焦点应在对话框内', actions: [{ label: '取消' }, { label: '确定', primary: true }] });
      });
      await sleep(400);
      const focusedInDialog = await page.evaluate(() => {
        const active = document.activeElement;
        const dialog = document.querySelector('.dialog');
        return dialog && dialog.contains(active);
      });
      record('C13-对话框打开后焦点在对话框内', focusedInDialog, '');
      await page.keyboard.press('Escape');
      await sleep(200);
      await page.close();
    }

    // ========== CONTRACT 14: Radius tokens are 4/6/8px ==========
    {
      const page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
      await sleep(500);
      const radii = await page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        return {
          r1: styles.getPropertyValue('--r-1').trim(),
          r2: styles.getPropertyValue('--r-2').trim(),
          r3: styles.getPropertyValue('--r-3').trim(),
        };
      });
      record('C14-圆角token r-1=4px', radii.r1 === '4px', `r-1=${radii.r1}`);
      record('C14-圆角token r-2=6px', radii.r2 === '6px', `r-2=${radii.r2}`);
      record('C14-圆角token r-3=8px', radii.r3 === '8px', `r-3=${radii.r3}`);
      await page.close();
    }

  } catch (err) {
    console.error('Contract test runner error:', err.message);
    if (browser) await browser.close().catch(() => {});
    if (server && server._forceClose) await server._forceClose();
    else if (server) await new Promise(r => server.close(r));
    process.exit(2);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server._forceClose) await server._forceClose();
    else if (server) await new Promise(r => server.close(r));
  }

  // --- Summary ---
  console.log(`\n=== Contract Tests: ${passCount} passed, ${failCount} failed ===`);
  // Write results to file
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'contract-results.json'), JSON.stringify({ passCount, failCount, results, timestamp: new Date().toISOString() }, null, 2), 'utf-8');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
