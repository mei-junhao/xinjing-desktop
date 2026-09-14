/**
 * XinJing 5.0 Full UI System Prototype - Mutation Probes (REAL BROWSER)
 *
 * For each semantic/behavioral mutation:
 *   1. Copy prototype to a temp directory
 *   2. Apply the mutation (modify source code in temp copy)
 *   3. Start HTTP server on temp copy
 *   4. Launch Edge via puppeteer-core
 *   5. Run the relevant behavioral probe
 *   6. If probe PASSES (mutation survived) → KILLED=false → runner exits non-zero
 *   7. If probe FAILS (mutation killed) → KILLED=true → continue
 *
 * Exit codes:
 *   0  ALL mutations killed (tests correctly detect broken behavior)
 *   1  One or more mutations SURVIVED (tests are insufficient)
 *   2  Environment/setup error
 */
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROTOTYPE_DIR = path.resolve(__dirname, '..', '..', '..', 'design-previews', '5.0.0-trae-full-ui-system-prototype');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TMP_BASE = path.resolve(__dirname, 'evidence', 'mutation-tmp');
const EVIDENCE_DIR = path.resolve(__dirname, 'evidence', 'mutation');
fs.mkdirSync(TMP_BASE, { recursive: true });
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// --- Static file server ---
function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
    const connections = new Set();
    const srv = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
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

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await copyDir(sPath, dPath);
    } else {
      await fsp.copyFile(sPath, dPath);
    }
  }
}

async function cleanupTmp(dir) {
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (_) {}
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ========== MUTATION DEFINITIONS ==========
// Each mutation: { id, description, target (file), apply (function that modifies file content), probe (function that returns {pass: bool, detail: string}) }
// The probe MUST return pass=true when the behavior is CORRECT. After applying the mutation, probe SHOULD return pass=false.
// If probe returns pass=true after mutation, the mutation SURVIVED → FAIL.

const MUTATIONS = [
  {
    id: 'M01-default-skin-theatre',
    description: '默认皮肤被改为theatre',
    target: 'app.js',
    apply: (src) => src.replace(/skin:\s*'clinical'/, "skin: 'theatre'"),
    probe: async (page) => {
      const skin = await page.evaluate(() => document.documentElement.getAttribute('data-skin'));
      return { pass: skin === 'clinical', detail: `data-skin=${skin}` };
    }
  },
  {
    id: 'M02-escape-dialog-removed',
    description: '全局Escape关闭对话框逻辑被删除',
    target: 'app.js',
    apply: (src) => src.replace(/if \(state\.dialog\) \{ closeDialog\(\); e\.preventDefault\(\); return; \}/,
      "if (false) { closeDialog(); e.preventDefault(); return; } /* MUTATED: escape dialog close disabled */"),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'EscapeTest', body: 'body', actions: [{ label: 'OK', primary: true }] }); });
      await sleep(300);
      const before = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      await page.keyboard.press('Escape');
      await sleep(300);
      const after = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      return { pass: before && !after, detail: `before=${before}, after=${after}` };
    }
  },
  {
    id: 'M03-ctrl-s-no-save',
    description: 'Ctrl+S不再清除unsavedChanges',
    target: 'app.js',
    apply: (src) => src.replace(/if\s*\(state\.unsavedChanges\)\s*\{\s*state\.unsavedChanges\s*=\s*false;\s*\}/,
      'if (state.unsavedChanges) { /* save does NOT clear unsaved flag */ }'),
    probe: async (page) => {
      await page.evaluate(() => { location.hash = 'consult-notes'; XJTest.state.unsavedChanges = true; XJTest.renderShell(); XJTest.renderRoute(); });
      await sleep(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('s');
      await page.keyboard.up('Control');
      await sleep(400);
      const saved = await page.evaluate(() => !XJTest.state.unsavedChanges);
      return { pass: saved, detail: `unsavedChanges=${!saved}` };
    }
  },
  {
    id: 'M04-dialog-role-removed',
    description: '对话框role=dialog属性被删除',
    target: 'app.js',
    apply: (src) => src.replace(/role:\s*'dialog',\s*'aria-modal'/g, "'data-removed': 'role', 'aria-modal'"),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'ARIA', body: 'b', actions: [{ label: 'OK', primary: true }] }); });
      await sleep(300);
      const role = await page.evaluate(() => { const d = document.querySelector('.dialog'); return d ? d.getAttribute('role') : null; });
      await page.evaluate(() => XJTest.closeDialog());
      return { pass: role === 'dialog', detail: `role=${role}` };
    }
  },
  {
    id: 'M05-radius-32px',
    description: '圆角token被改为32px',
    target: 'styles.css',
    apply: (src) => src.replace(/--r-1:\s*4px/g, '--r-1: 32px').replace(/--r-2:\s*6px/g, '--r-2: 32px').replace(/--r-3:\s*8px/g, '--r-3: 32px'),
    probe: async (page) => {
      const r1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--r-1').trim());
      const r2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--r-2').trim());
      const r3 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--r-3').trim());
      const ok = r1 === '4px' && r2 === '6px' && r3 === '8px';
      return { pass: ok, detail: `r1=${r1}, r2=${r2}, r3=${r3}` };
    }
  },
  {
    id: 'M06-dialog-no-focus-trap',
    description: '对话框打开后不移动焦点',
    target: 'app.js',
    apply: (src) => src.replace(/setTimeout\(\(\)\s*=>\s*\{[^}]*let focusEl[\s\S]*?if\s*\(focusEl\)\s*focusEl\.focus\(\);[^}]*\},\s*50\);/,
      'setTimeout(() => { /* FOCUS TRAP REMOVED */ }, 50);'),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'Focus', body: 'f', actions: [{ label: 'Cancel' }, { label: 'OK', primary: true }] }); });
      await sleep(400);
      const inDialog = await page.evaluate(() => { const d = document.querySelector('.dialog'); return d && d.contains(document.activeElement); });
      await page.evaluate(() => XJTest.closeDialog());
      return { pass: inDialog, detail: `focusInDialog=${inDialog}` };
    }
  },
  {
    id: 'M07-hashchange-no-nav',
    description: 'hashchange不再触发路由切换',
    target: 'app.js',
    apply: (src) => src.replace(/window\.addEventListener\('hashchange',\s*handleHash\);/,
      "window.addEventListener('hashchange', () => { /* NAVIGATION DISABLED */ });"),
    probe: async (page) => {
      const startRoute = await page.evaluate(() => XJTest.state.route);
      await page.evaluate(() => { location.hash = 'masters'; });
      await sleep(400);
      const newRoute = await page.evaluate(() => XJTest.state.route);
      return { pass: newRoute === 'masters', detail: `start=${startRoute}, end=${newRoute}` };
    }
  },
  {
    id: 'M08-tier-gate-removed',
    description: 'canUse()始终返回true（权益校验被移除）',
    target: 'app.js',
    apply: (src) => src.replace(/function canUse\(featureKey\)\s*\{[\s\S]*?return order\.indexOf\(effectiveTier\)\s*>=\s*order\.indexOf\(gate\.minTier\);\s*\}/,
      'function canUse(featureKey) { return true; /* TIER GATE REMOVED */ }'),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.setTier('free'); location.hash = 'supervision'; });
      await sleep(500);
      // When tier gate works, free tier on supervision route should show lock/upgrade text or locked state
      const hasLockIndicator = await page.evaluate(() => {
        const body = document.body.innerText;
        return body.includes('查看方案') || (body.includes('需要') && body.includes('方案')) || !!document.querySelector('.btn-tier-locked');
      });
      const unknownDenied = await page.evaluate(() => XJTest.canUse('unknown-feature-key') === false);
      return { pass: hasLockIndicator && unknownDenied, detail: `lock=${hasLockIndicator}, unknownDenied=${unknownDenied}` };
    }
  },
  {
    id: 'M09-toast-not-shown',
    description: '保存后不显示toast',
    target: 'app.js',
    apply: (src) => src.replace(/toast\('已保存',\s*'success'\);/, "/* toast('已保存', 'success'); */"),
    probe: async (page) => {
      await page.evaluate(() => { location.hash = 'consult-notes'; });
      await sleep(200);
      await page.keyboard.down('Control');
      await page.keyboard.press('s');
      await page.keyboard.up('Control');
      await sleep(500);
      const hasToast = await page.evaluate(() => !!document.querySelector('.toast'));
      return { pass: hasToast, detail: 'no toast after Ctrl+S' };
    }
  },
  {
    id: 'M10-main-content-missing',
    description: '#main-content元素被删除',
    target: 'app.js',
    apply: (src) => src.replace(/id:\s*'main-content'/, "id: 'main-content-removed'"),
    probe: async (page) => {
      await sleep(400);
      const main = await page.evaluate(() => !!document.querySelector('#main-content'));
      return { pass: main, detail: '#main-content not found' };
    }
  },
  {
    id: 'M11-backdrop-click-no-close',
    description: '点击遮罩层不关闭对话框',
    target: 'app.js',
    apply: (src) => src.replace(/onclick:\s*\(e\)\s*=>\s*\{\s*if\s*\(e\.target\s*===\s*overlay\)\s*closeDialog\(\);\s*\}/,
      'onclick: (e) => { /* BACKDROP CLOSE REMOVED */ }'),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'Backdrop', body: 'b', actions: [{ label: 'OK' }] }); });
      await sleep(300);
      const before = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      // Click on the overlay (not on the dialog itself)
      await page.evaluate(() => {
        const overlay = document.querySelector('.dialog-overlay');
        if (overlay) { const rect = overlay.getBoundingClientRect(); const ev = new MouseEvent('click', { clientX: rect.left + 5, clientY: rect.top + 5, bubbles: true }); overlay.dispatchEvent(ev); }
      });
      await sleep(300);
      const after = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      // Close via Escape for cleanup
      await page.keyboard.press('Escape').catch(() => {});
      return { pass: before && !after, detail: `before=${before}, after=${after}` };
    }
  },
  {
    id: 'M12-reduced-motion-ignored',
    description: 'prefers-reduced-motion被忽略（transition始终不为0）',
    target: 'styles.css',
    apply: (src) => {
      // Remove the reduced-motion media block entirely by replacing the known block
      return src.replace(
        /\/\* ===== REDUCED MOTION ===== \*\/[\s\S]*?@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/m,
        '/* REDUCED MOTION BLOCK REMOVED BY MUTATION */'
      );
    },
    probe: async (page) => {
      // Set reduced motion via CDP
      const client = await page.target().createCDPSession();
      await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await page.reload({ waitUntil: 'networkidle0' });
      await sleep(500);
      const dur = await page.evaluate(() => { const b = document.querySelector('button'); return b ? getComputedStyle(b).transitionDuration : 'unknown'; });
      return { pass: dur === '0s', detail: `transitionDuration=${dur}` };
    }
  },
  {
    id: 'M13-default-mode-dark',
    description: '默认模式被改为dark',
    target: 'app.js',
    apply: (src) => src.replace(/mode:\s*'light'/, "mode: 'dark'"),
    probe: async (page) => {
      await sleep(500);
      const mode = await page.evaluate(() => document.documentElement.getAttribute('data-mode'));
      return { pass: mode === 'light', detail: `data-mode=${mode}` };
    }
  },
  {
    id: 'M14-default-font-serif',
    description: '默认字体被改为serif（Fraunces）',
    target: 'styles.css',
    apply: (src) => src.replace(/--font-sans:[^;]+;/, '--font-sans: ui-serif, Georgia, serif;'),
    probe: async (page) => {
      const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      return { pass: /Segoe UI|system-ui|Microsoft YaHei|-apple-system|Noto Sans/.test(font), detail: `font=${font}` };
    }
  },
  {
    id: 'M15-sidebar-no-role-navigation',
    description: '侧边栏nav缺少role=navigation',
    target: 'app.js',
    apply: (src) => src.replace(/class:\s*'sidebar',\s*role:\s*'navigation',\s*'aria-label':\s*'主导航'/,
      "class: 'sidebar', 'aria-label': '主导航'"),
    probe: async (page) => {
      await sleep(400);
      const nav = await page.evaluate(() => !!document.querySelector('nav[role="navigation"]'));
      return { pass: nav, detail: 'nav[role=navigation] not found' };
    }
  },
  {
    id: 'M16-main-not-focusable',
    description: '主内容区不可聚焦（移除tabindex）',
    target: 'app.js',
    apply: (src) => src.replace(/tabindex:\s*'-1'[^}]*id:\s*'main-content'/, "id: 'main-content'").replace(/id:\s*'main-content'[^}]*tabindex:\s*'-1'/, "id: 'main-content'"),
    probe: async (page) => {
      await sleep(400);
      const focusable = await page.evaluate(() => {
        const m = document.querySelector('#main-content');
        if (!m) return false;
        m.focus();
        return m.getAttribute('tabindex') === '-1' && document.activeElement === m;
      });
      return { pass: focusable, detail: 'main-content cannot receive focus' };
    }
  },
  {
    id: 'M17-dialog-no-aria-modal',
    description: '对话框缺少aria-modal=true',
    target: 'app.js',
    apply: (src) => src.replace(/'aria-modal':\s*'true'/g, "'data-modal': 'removed'"),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'Modal', body: 'b', actions: [{ label: 'OK', primary: true }] }); });
      await sleep(300);
      const modal = await page.evaluate(() => { const d = document.querySelector('.dialog'); return d ? d.getAttribute('aria-modal') : null; });
      await page.evaluate(() => XJTest.closeDialog());
      return { pass: modal === 'true', detail: `aria-modal=${modal}` };
    }
  },
  {
    id: 'M18-ctrl-s-no-preventDefault',
    description: 'Ctrl+S不调用preventDefault（会触发浏览器保存对话框）',
    target: 'app.js',
    apply: (src) => src.replace(/if\s*\(\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)\s*&&\s*e\.key\s*===\s*'s'\)\s*\{\s*e\.preventDefault\(\);/,
      "if ((e.ctrlKey || e.metaKey) && e.key === 's') { /* preventDefault REMOVED */"),
    probe: async (page) => {
      // We can't easily detect preventDefault in puppeteer, but we can check the handler exists by verifying Ctrl+S works
      await page.evaluate(() => { location.hash = 'consult-notes'; XJTest.state.unsavedChanges = true; XJTest.renderShell(); XJTest.renderRoute(); });
      await sleep(200);
      // Check that the keydown handler has preventDefault called by intercepting events
      const defaultPrevented = await page.evaluate(() => {
        let prevented = false;
        const handler = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') prevented = e.defaultPrevented; };
        document.addEventListener('keydown', handler, true);
        const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        document.removeEventListener('keydown', handler, true);
        return prevented;
      });
      return { pass: defaultPrevented, detail: 'Ctrl+S preventDefault not called' };
    }
  },
  {
    id: 'M19-ctrl-o-no-file-open',
    description: 'Ctrl+O不触发文件选择',
    target: 'app.js',
    apply: (src) => src.replace(
      "if (fileInput) { fileInput.click(); toast('已打开文件选择器','info'); }",
      "if (fileInput) { /* MUTATED: Ctrl+O fileInput.click removed */ toast('已打开文件选择器','info'); }"
    ),
    probe: async (page) => {
      await page.evaluate(() => { location.hash = 'transcript'; });
      await sleep(500);
      const fi = await page.evaluate(() => {
        const f = document.querySelector('input[type="file"]');
        if (f) { window.__fired = false; f.addEventListener('click', () => { window.__fired = true; }, { once: true }); }
        return !!f;
      });
      if (!fi) return { pass: false, detail: 'no file input on transcript page' };
      await page.keyboard.down('Control');
      await page.keyboard.press('o');
      await page.keyboard.up('Control');
      await sleep(300);
      const fired = await page.evaluate(() => !!window.__fired);
      return { pass: fired, detail: 'Ctrl+O did not trigger file input click' };
    }
  },
  {
    id: 'M20-debug-bar-visible-by-default',
    description: '调试栏默认可见',
    target: 'styles.css',
    apply: (src) => src
      .replace(/--devbar-h:\s*0px/, '--devbar-h: 44px')
      .replace(/\.dev-bar\s*\{[^}]*display:\s*none[^}]*\}/s, '.dev-bar { display: flex !important; /* DEBUG BAR FORCED VISIBLE */ }'),
    probe: async (page) => {
      await sleep(500);
      const visible = await page.evaluate(() => {
        const db = document.querySelector('.dev-bar');
        if (!db) return false;
        const cs = getComputedStyle(db);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && db.offsetHeight > 0;
      });
      return { pass: !visible, detail: 'debug bar visible by default' };
    }
  },
  {
    id: 'M21-dialog-destructive-not-styled',
    description: '危险操作按钮没有destructive样式',
    target: 'app.js',
    apply: (src) => src.replace(/class:\s*`btn\s*\$\{a\.primary\s*\?\s*'btn-primary'\s*:\s*a\.destructive\s*\?\s*'btn-destructive'\s*:\s*'btn-ghost'\}`/,
      "class: `btn ${a.primary ? 'btn-primary' : 'btn-ghost'}`"),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'Destr', body: 'b', actions: [{ label: '取消' }, { label: '删除', destructive: true }] }); });
      await sleep(300);
      const hasDestructive = await page.evaluate(() => !!document.querySelector('.btn-destructive'));
      await page.evaluate(() => XJTest.closeDialog());
      return { pass: hasDestructive, detail: 'no btn-destructive found' };
    }
  },
  {
    id: 'M22-route-pattern-broken',
    description: '路由pattern不匹配导致路由不渲染',
    target: 'app.js',
    apply: (src) => src.replace(/state\.route\s*===\s*item\.pattern/g, "state.route === item.pattern + '__BROKEN'"),
    probe: async (page) => {
      await sleep(400);
      // Dashboard (index) should have an active nav item
      const activeNav = await page.evaluate(() => !!document.querySelector('.sidebar-item.active'));
      return { pass: activeNav, detail: 'no active nav item on index' };
    }
  },
  {
    id: 'M23-toast-no-aria-live',
    description: 'Toast容器缺少aria-live',
    target: 'app.js',
    apply: (src) => src.replace(/'aria-live':\s*'polite'/g, "'data-live': 'removed'"),
    probe: async (page) => {
      await page.evaluate(() => XJTest.toast('aria test', 'info'));
      await sleep(300);
      const live = await page.evaluate(() => { const c = document.querySelector('#toast-container'); return c ? c.getAttribute('aria-live') : null; });
      return { pass: live === 'polite', detail: `aria-live=${live}` };
    }
  },
  {
    id: 'M24-dialog-title-not-labelled',
    description: '对话框缺少aria-labelledby',
    target: 'app.js',
    apply: (src) => src.replace(/'aria-labelledby':\s*'dialog-title-id'/g, "'data-labelledby': 'removed'"),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'LabelTest', body: 'b', actions: [{ label: 'OK', primary: true }] }); });
      await sleep(300);
      const labelled = await page.evaluate(() => { const d = document.querySelector('.dialog'); return d ? d.getAttribute('aria-labelledby') : null; });
      await page.evaluate(() => XJTest.closeDialog());
      return { pass: labelled === 'dialog-title-id', detail: `aria-labelledby=${labelled}` };
    }
  },
  {
    id: 'M25-closeDialog-no-remove',
    description: 'closeDialog不从DOM移除对话框',
    target: 'app.js',
    apply: (src) => src.replace(/if\s*\(state\.dialog\)\s*\{\s*state\.dialog\.remove\(\);\s*state\.dialog\s*=\s*null;\s*\}/,
      'if (state.dialog) { /* state.dialog.remove(); */ state.dialog = null; }'),
    probe: async (page) => {
      await page.evaluate(() => { XJTest.showDialog({ title: 'Close', body: 'b', actions: [{ label: 'OK' }] }); });
      await sleep(300);
      const before = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      await page.evaluate(() => XJTest.closeDialog());
      await sleep(300);
      const after = await page.evaluate(() => !!document.querySelector('.dialog-overlay'));
      return { pass: before && !after, detail: `before=${before}, after=${after}` };
    }
  },
  {
    id: 'M26-app-shell-class-missing',
    description: '#app缺少app-shell，固定侧栏网格未生效',
    target: 'app.js',
    apply: (src) => src.replace(/\n\s*app\.className\s*=\s*'app-shell';/, '\n    /* MUTATED: app-shell class not applied */'),
    probe: async (page) => {
      const checks = await page.evaluate(() => {
        const app = document.querySelector('#app');
        const sidebar = document.querySelector('.sidebar');
        const topbar = document.querySelector('.topbar');
        const main = document.querySelector('#main-content');
        const sidebarRect = sidebar && sidebar.getBoundingClientRect();
        const topbarRect = topbar && topbar.getBoundingClientRect();
        const mainRect = main && main.getBoundingClientRect();
        const expectedW = window.innerWidth <= 1024 && window.innerWidth > 768
          ? 60
          : (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 240);
        return {
          appShellApplied: !!app && app.classList.contains('app-shell') && getComputedStyle(app).display === 'grid',
          sidebarFixedWidth: !!sidebarRect && Math.abs(sidebarRect.width - expectedW) <= 2,
          topbarRightOfSidebar: !!topbarRect && topbarRect.left >= expectedW - 2 && topbarRect.top < 80,
          mainRightOfSidebar: !!mainRect && mainRect.left >= expectedW - 2 && mainRect.top >= 50 && mainRect.top < 120,
        };
      });
      return { pass: Object.values(checks).every(Boolean), detail: JSON.stringify(checks) };
    }
  },
];

// ========== RUNNER ==========
async function runMutation(m) {
  const tmpDir = path.join(TMP_BASE, m.id);
  await cleanupTmp(tmpDir);
  await copyDir(PROTOTYPE_DIR, tmpDir);

  // Apply mutation
  const targetFile = path.join(tmpDir, m.target);
  let original = await fsp.readFile(targetFile, 'utf-8');
  let mutated = m.apply(original);
  if (mutated === original) {
    return { id: m.id, killed: false, survived: true, detail: 'mutation did not change source (apply() returned same content)', setupError: false };
  }
  await fsp.writeFile(targetFile, mutated, 'utf-8');

  // Verify mutation was applied (different hash)
  const origHash = sha256File(path.join(PROTOTYPE_DIR, m.target));
  const mutHash = sha256File(targetFile);
  if (origHash === mutHash) {
    await cleanupTmp(tmpDir);
    return { id: m.id, killed: false, survived: true, detail: 'source hash unchanged after mutation', setupError: false };
  }

  // Start server on temp dir (port 0 = dynamic allocation to avoid conflicts)
  const srv = await startServer(tmpDir, 0);
  const actualPort = srv._actualPort;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      defaultViewport: { width: 1366, height: 768, deviceScaleFactor: 1 },
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto(`http://127.0.0.1:${actualPort}/index.html`, { waitUntil: 'networkidle0', timeout: 15000 });
    await sleep(800);

    // Run probe - if probe returns pass=true, the mutation SURVIVED (bad)
    const result = await m.probe(page);
    await page.close();

    if (pageErrors.length > 0) {
      return {
        id: m.id,
        description: m.description,
        killed: false,
        survived: false,
        detail: `mutation caused page error instead of a semantic failure: ${pageErrors.join(' | ')}`,
        pageErrors: pageErrors.slice(0, 3),
        setupError: true,
      };
    }
    const survived = !!result.pass;
    const killed = !survived;
    return { id: m.id, description: m.description, killed, survived, detail: result.detail, pageErrors: pageErrors.slice(0, 3), setupError: false };
  } catch (err) {
    return { id: m.id, killed: false, survived: false, detail: `probe error: ${err.message}`, setupError: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv && srv._forceClose) await srv._forceClose();
    else if (srv) await new Promise(r => srv.close(r));
    await sleep(200);
    await cleanupTmp(tmpDir);
  }
}

async function main() {
  if (!fs.existsSync(EDGE_PATH)) { console.error('Edge not found'); process.exit(2); }
  if (!fs.existsSync(path.join(PROTOTYPE_DIR, 'index.html'))) { console.error('Prototype not found'); process.exit(2); }

  console.log(`Running ${MUTATIONS.length} mutation probes...\n`);
  const results = [];
  let killedCount = 0;
  let survivedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < MUTATIONS.length; i++) {
    const m = MUTATIONS[i];
    process.stdout.write(`  [${i+1}/${MUTATIONS.length}] ${m.id} - ${m.description} ... `);
    const result = await runMutation(m);
    results.push(result);
    if (result.setupError) {
      errorCount++;
      console.log(`ERROR  ${result.detail}`);
    } else if (result.killed) {
      killedCount++;
      console.log(`KILLED  ${result.detail || ''}`);
    } else {
      survivedCount++;
      console.log(`SURVIVED!  ${result.detail || ''}`);
    }
  }

  console.log(`\n=== Mutation Probes: ${killedCount} killed, ${survivedCount} survived, ${errorCount} errors ===`);
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'mutation-results.json'), JSON.stringify({ total: MUTATIONS.length, killed: killedCount, survived: survivedCount, errors: errorCount, results, timestamp: new Date().toISOString() }, null, 2), 'utf-8');

  if (survivedCount > 0) {
    console.log('\nFAIL: One or more mutations survived. Tests are insufficient.');
    process.exit(1);
  }
  if (errorCount > 0) {
    console.log('\nFAIL: Some probes errored.');
    process.exit(1);
  }
  console.log('\nAll mutations killed.');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
