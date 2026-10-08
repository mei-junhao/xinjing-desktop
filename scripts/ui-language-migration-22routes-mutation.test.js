'use strict';

/* XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002
 * Behavior-level reverse-mutation harness.
 *
 * Each mutation REALLY replaces bytes in the workspace (snapshot -> mutate ->
 * behavioral probe in live Electron -> restore -> hash-verify). A mutation is
 * KILLED only when the live behavioral probe detects the regression; string or
 * screenshot comparisons alone are never sufficient.
 *
 * Mutations:
 *   M1 route-removal              delete billing-calendar.html        -> route fetch/navigation must fail
 *   M2 wrong-route-masked-handler remove 记一笔 binding in billing-shell + unrelated change in index
 *                                                                 -> modal must NOT open (click probe)
 *   M3 swallowed-render-error     inject throwing script in feedback  -> page exception must be recorded
 *   M4 resize-handling-skip       inject 2200px fixed-width element   -> horizontal overflow must be detected
 *   M5 skin-token-collapse        alias theatre tokens to clinical    -> computed skin fingerprint collapses
 *   M6 reduced-motion-removal     drop global reduced-motion block    -> transition persists under reduce
 *
 * Safety: every file is restored byte-exactly in finally; the final section
 * re-hashes all 31 writable inputs and the 17 protected files. Any drift
 * aborts with a non-zero exit code.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TASK_ID = 'XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002';
const EVIDENCE_DIR = path.join(ROOT, 'qa', 'task-scratch', TASK_ID, 'evidence');
const MANIFEST = path.join(ROOT, 'docs/agent-coordination/v5.0.0/tasks/XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002.protected.json');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function findUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs || 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}
async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`, 1000);
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url || ''));
      if (page) return page;
    } catch (_) { /* retry */ }
    await delay(200);
  }
  throw new Error('Timed out waiting for a loopback Electron page target');
}
function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
    const ws = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    ws.on('open', () => resolve({
      send(method, params) {
        return new Promise((resolveCommand, rejectCommand) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, handler) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(handler);
      },
      close() { try { ws.close(); } catch (_) { /* ignore */ } },
    }));
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!message.id) {
        for (const handler of listeners.get(message.method) || []) {
          try { handler(message.params || {}); } catch (_) { /* ignore */ }
        }
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result || {});
    });
    ws.on('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('CDP WebSocket closed'));
      pending.clear();
    });
    ws.on('error', (error) => reject(error));
  });
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  /* Snapshot every writable input before touching anything. */
  const snapshot = new Map();
  for (const entry of manifest.baseline_writable_inputs) {
    snapshot.set(entry.path, fs.readFileSync(path.join(ROOT, entry.path)));
  }
  /* NOTE: baseline_writable_inputs hashes are the PRE-migration baseline; the
   * mutation harness snapshots the CURRENT (migrated) bytes, which is what it
   * must restore exactly. */

  const debugPort = await findUnusedPort();
  const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  const userData = fs.mkdtempSync(path.join(tempRoot, 'xj-ui22-mutation-'));
  const launcher = childProcess.spawn(ELECTRON, [
    '--disable-gpu',
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let launcherOutput = '';
  launcher.stdout.on('data', (chunk) => { launcherOutput += chunk; });
  launcher.stderr.on('data', (chunk) => { launcherOutput += chunk; });

  const results = { task_id: TASK_ID, timestamp: new Date().toISOString(), mutations: [], restore_drift: [], pass: false };
  let cdp = null;
  let exitCode = 1;

  /* mutation bookkeeping */
  const touch = (rel, bytes) => fs.writeFileSync(path.join(ROOT, rel), bytes);

  async function probe(expression) {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) return { __exception: (response.exceptionDetails.exception || {}).description || response.exceptionDetails.text };
    return response.result ? response.result.value : undefined;
  }
  async function navigate(origin, page) {
    await cdp.send('Page.navigate', { url: `${origin}/${page}` });
    for (let attempt = 0; attempt < 100; attempt++) {
      const reached = await probe(`document.readyState === 'complete' && location.pathname.endsWith(${JSON.stringify('/' + page)})`);
      if (reached) { await delay(150); return true; }
      await delay(100);
    }
    return false;
  }

  try {
    const target = await waitForPageTarget(debugPort, 30000);
    const origin = new URL(target.url).origin;
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const pageExceptions = [];
    cdp.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      pageExceptions.push((details.exception && details.exception.description) || details.text || 'exception');
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

    /* ---- Baseline probes (must be green before any mutation) ---- */
    await navigate(origin, 'billing-shell.html');
    const baselineBilling = await probe(`(() => {
      const btn = document.getElementById('bf-add-record');
      if (!btn) return { found: false };
      btn.click();
      return new Promise((resolve) => setTimeout(() => {
        const modal = document.getElementById('bf-modal-overlay');
        resolve({ found: true, modalOpen: !!modal });
      }, 350));
    })()`);
    await probe(`(() => { const overlay = document.getElementById('bf-modal-overlay'); if (overlay) overlay.remove(); return true; })()`);
    if (!baselineBilling || !baselineBilling.modalOpen) throw new Error('Baseline 记一笔 probe failed; refusing to mutate');

    await navigate(origin, 'index.html');
    const baselineStretch = await probe(`(() => { const r = document.documentElement; return r.scrollWidth <= r.clientWidth + 1; })()`);
    if (!baselineStretch) throw new Error('Baseline stretch probe failed; refusing to mutate');

    await navigate(origin, 'feedback.html');
    const baselineExceptions = pageExceptions.length;

    /* ---- M1: route removal ---- */
    {
      const rel = 'app/billing-calendar.html';
      const backupPath = path.join(tempRoot, 'mutation-backup-billing-calendar.html');
      fs.copyFileSync(path.join(ROOT, rel), backupPath);
      fs.unlinkSync(path.join(ROOT, rel));
      try {
        const fetchState = await probe(`fetch('/billing-calendar.html', { cache: 'no-store' }).then((res) => ({ status: res.status, ok: res.ok }))`);
        const navOk = await navigate(origin, 'billing-calendar.html');
        const textLen = navOk ? await probe(`(document.body.innerText || '').trim().length`) : 0;
        const detected = !!(fetchState && (fetchState.status === 404 || fetchState.ok === false)) || (!navOk) || textLen < 20;
        results.mutations.push({ id: 'M1-route-removal', file: rel, expected_detection: 'route fetch/navigation fails', detected, killed: detected, evidence: { fetchState, navOk, textLen } });
      } finally {
        fs.copyFileSync(backupPath, path.join(ROOT, rel));
        fs.unlinkSync(backupPath);
      }
    }

    /* ---- M2: handler removal masked by an unrelated wrong-route edit ---- */
    {
      const billingRel = 'app/billing-shell.html';
      const indexRel = 'app/index.html';
      const billingOriginal = snapshot.get(billingRel);
      const indexOriginal = snapshot.get(indexRel);
      const billingText = billingOriginal.toString('utf8');
      const target = "addRecord.addEventListener('click', function (event) {";
      if (!billingText.includes(target)) throw new Error('M2 mutation anchor not found');
      /* Expression-level kill: `false && fn(...)` keeps the file parseable but
       * never registers the click handler. */
      const balanced = billingText.replace(target, "false && addRecord.addEventListener('click', function (event) {");
      touch(billingRel, Buffer.from(balanced, 'utf8'));
      /* Unrelated change on the WRONG route: must not mask the billing failure. */
      touch(indexRel, Buffer.from(indexOriginal.toString('utf8').replace('<title>心镜 · 首页</title>', '<title>心镜 · 首页 · unrelated-mutation</title>'), 'utf8'));
      try {
        await navigate(origin, 'billing-shell.html');
        const clickResult = await probe(`(() => {
          const btn = document.getElementById('bf-add-record');
          if (!btn) return { found: false };
          btn.click();
          return new Promise((resolve) => setTimeout(() => resolve({ found: true, modalOpen: !!document.getElementById('bf-modal-overlay') }), 350));
        })()`);
        await probe(`(() => { const overlay = document.getElementById('bf-modal-overlay'); if (overlay) overlay.remove(); return true; })()`);
        const detected = !!(clickResult && clickResult.found && !clickResult.modalOpen);
        results.mutations.push({ id: 'M2-wrong-route-masked-handler', file: billingRel + ' + ' + indexRel, expected_detection: 'modal does not open after click; wrong-route edit does not mask', detected, killed: detected, evidence: clickResult });
      } finally {
        touch(billingRel, billingOriginal);
        touch(indexRel, indexOriginal);
      }
    }

    /* ---- M3: swallowed render error must surface ---- */
    {
      const rel = 'app/feedback.html';
      const original = snapshot.get(rel);
      const mutated = original.toString('utf8').replace('</head>', '<script>throw new Error("MUTATION_PROBE_RENDER_ERROR_M3");</script>\n</head>');
      touch(rel, Buffer.from(mutated, 'utf8'));
      try {
        pageExceptions.length = 0;
        await navigate(origin, 'feedback.html');
        await delay(300);
        const detected = pageExceptions.some((text) => /MUTATION_PROBE_RENDER_ERROR_M3/.test(text));
        results.mutations.push({ id: 'M3-swallowed-render-error', file: rel, expected_detection: 'page exception recorded (not swallowed)', detected, killed: detected, evidence: { exceptions: pageExceptions.slice(0, 3) } });
      } finally {
        touch(rel, original);
      }
    }

    /* ---- M4: resize/overflow handling removal must be caught ----
     * The workbench language keeps `html, body { overflow-x: hidden; }` plus
     * region wrapping. Removing that guard AND forcing a 2200px element must
     * make the harness stretch check (scrollWidth > clientWidth) fail. */
    {
      const indexRel = 'app/index.html';
      const cssRel = 'app/css/xj-ui-system.css';
      const indexOriginal = snapshot.get(indexRel);
      const cssOriginal = snapshot.get(cssRel);
      const cssText = cssOriginal.toString('utf8');
      const guardAnchor = /html, body \{ overflow-x: hidden; \}/;
      if (!guardAnchor.test(cssText)) throw new Error('M4 mutation anchor not found');
      touch(cssRel, Buffer.from(cssText.replace(guardAnchor, '/* overflow guard removed by mutation M4 */'), 'utf8'));
      const indexText = indexOriginal.toString('utf8');
      touch(indexRel, Buffer.from(indexText.replace('<div class="layout">', '<div style="width:2200px;height:10px" id="mut-stretch-probe"></div><div class="layout">'), 'utf8'));
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
        await navigate(origin, 'index.html');
        const metrics = await probe(`(() => { const r = document.documentElement; return { scrollWidth: r.scrollWidth, clientWidth: r.clientWidth, overflow: r.scrollWidth > r.clientWidth + 1 }; })()`);
        const detected = !!(metrics && metrics.overflow);
        results.mutations.push({ id: 'M4-resize-handling-skip', file: cssRel + ' + ' + indexRel, expected_detection: 'horizontal overflow detected at 1024x700 once the guard is removed', detected, killed: detected, evidence: metrics });
      } finally {
        touch(indexRel, indexOriginal);
        touch(cssRel, cssOriginal);
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    }

    /* ---- M5: theatre token collapse into clinical must be caught ---- */
    {
      const rel = 'app/css/xj-ui-system.css';
      const original = snapshot.get(rel);
      const text = original.toString('utf8');
      const canvasRe = /(\[data-skin="theatre"\]\s*\{\s*(?:\r?\n)\s*--xj-canvas:\s*)#eceae6;/;
      if (!canvasRe.test(text)) throw new Error('M5 mutation anchor not found');
      const mutated = text.replace(canvasRe, '$1#eef3f1;');
      touch(rel, Buffer.from(mutated, 'utf8'));
      try {
        await navigate(origin, 'index.html');
        const collapsed = await probe(`(() => {
          document.documentElement.setAttribute('data-skin', 'theatre');
          const theatre = getComputedStyle(document.documentElement).getPropertyValue('--xj-canvas').trim();
          document.documentElement.setAttribute('data-skin', 'clinical');
          const clinical = getComputedStyle(document.documentElement).getPropertyValue('--xj-canvas').trim();
          return { theatre, clinical, collapsed: theatre === clinical };
        })()`);
        const detected = !!(collapsed && collapsed.collapsed);
        results.mutations.push({ id: 'M5-skin-token-collapse', file: rel, expected_detection: 'theatre canvas collapses to clinical value', detected, killed: detected, evidence: collapsed });
      } finally {
        touch(rel, original);
      }
    }

    /* ---- M6: reduced-motion removal must be caught ----
     * Three shared sheets each carry a global reduced-motion kill block
     * (defense in depth). Removing the behavior means removing all three. */
    {
      const rmSheets = ['app/css/xj-ui-system.css', 'app/css/workbench.css', 'app/css/style.css'];
      const originals = new Map(rmSheets.map((rel) => [rel, snapshot.get(rel)]));
      const blockRe = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\r?\n\}/;
      for (const rel of rmSheets) {
        const text = originals.get(rel).toString('utf8');
        if (!blockRe.test(text)) throw new Error('M6 mutation anchor not found in ' + rel);
        touch(rel, Buffer.from(text.replace(blockRe, '/* reduced-motion block removed by mutation M6 */'), 'utf8'));
      }
      const rel = rmSheets.join(' + ');
      try {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await navigate(origin, 'index.html');
        const motion = await probe(`(() => {
          const el = document.querySelector('.mod') || document.querySelector('button');
          const cs = getComputedStyle(el);
          return { duration: parseFloat(cs.transitionDuration) || 0, mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches };
        })()`);
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });
        const detected = !!(motion && motion.mediaMatches && motion.duration > 0.01);
        results.mutations.push({ id: 'M6-reduced-motion-removal', file: rel, expected_detection: 'transition persists under prefers-reduced-motion', detected, killed: detected, evidence: motion });
      } finally {
        for (const [r, bytes] of originals.entries()) touch(r, bytes);
      }
    }

    /* ---- Restore verification: every writable input must be byte-exact again ---- */
    for (const [rel, bytes] of snapshot.entries()) {
      const now = fs.readFileSync(path.join(ROOT, rel));
      if (!now.equals(bytes)) {
        results.restore_drift.push({ path: rel, expected_sha256: sha256(bytes), actual_sha256: sha256(now) });
      }
    }
    /* Protected files must remain identical to the manifest baseline. */
    for (const entry of manifest.protected_files) {
      const now = fs.readFileSync(path.join(ROOT, entry.path));
      if (sha256(now) !== entry.sha256.toUpperCase()) {
        results.restore_drift.push({ path: entry.path, expected_sha256: entry.sha256, actual_sha256: sha256(now), kind: 'protected' });
      }
    }

    const allKilled = results.mutations.length === 6 && results.mutations.every((m) => m.killed);
    results.pass = allKilled && results.restore_drift.length === 0;
    results.page_exception_count_m3_baseline = baselineExceptions;
    exitCode = results.pass ? 0 : 1;
  } catch (error) {
    results.error = String((error && error.stack) || error);
    /* Best-effort restore of every snapshot file on catastrophic failure. */
    for (const [rel, bytes] of snapshot.entries()) {
      try {
        const now = fs.readFileSync(path.join(ROOT, rel));
        if (!now.equals(bytes)) touch(rel, bytes);
      } catch (_) { /* recorded below */ }
    }
    for (const [rel, bytes] of snapshot.entries()) {
      const now = fs.readFileSync(path.join(ROOT, rel));
      if (!now.equals(bytes)) results.restore_drift.push({ path: rel, expected_sha256: sha256(bytes), actual_sha256: sha256(now), kind: 'post-error' });
    }
    exitCode = 1;
  } finally {
    results.launcher_output_tail = launcherOutput.slice(-1500);
    try { if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); } } catch (_) { /* ignore */ }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      launcher.once('exit', () => { clearTimeout(timer); resolve(true); });
      try { launcher.kill(); } catch (_) { /* ignore */ }
    });
    let cleanedUserData = false;
    try { fs.rmSync(userData, { recursive: true, force: true }); cleanedUserData = !fs.existsSync(userData); } catch (_) { cleanedUserData = false; }
    results.cleanup = { launcher_exited: exited, user_data_removed: cleanedUserData };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'mutation-result.json'), JSON.stringify(results, null, 1));
    console.log(JSON.stringify({ pass: results.pass, killed: results.mutations.filter((m) => m.killed).length, total: results.mutations.length, drift: results.restore_drift.length }, null, 1));
  }
  process.exit(exitCode);
}

main().catch((error) => { console.error(error); process.exit(1); });
