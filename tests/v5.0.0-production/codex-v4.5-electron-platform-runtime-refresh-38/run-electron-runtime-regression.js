'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MODE = process.env.XJ_ELECTRON_RUNTIME_MUTATION || 'normal';
const EXPECTED_ELECTRON = MODE === 'wrong-electron-version' ? '0.0.0' : '43.2.0';
const TEMP_PREFIX = MODE === 'missing-temp-sentinel' ? 'not-xinjing-runtime-' : 'xinjing-platform-runtime-';
const ACCEPTANCE_MODE = MODE === 'allow-nonacceptance-updater-call' ? '0' : '1';
const ARTIFACTS = path.join(__dirname, MODE === 'normal' ? 'artifacts' : path.join('mutation-artifacts', MODE));
const TASK_ID = process.env.XJ_ELECTRON_RUNTIME_TASK_ID || 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-refresh-38';
const MANIFEST = process.env.XJ_ELECTRON_RUNTIME_MANIFEST
  ? path.resolve(ROOT, process.env.XJ_ELECTRON_RUNTIME_MANIFEST)
  : path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-electron-platform-runtime-refresh-38', 'protected-files-manifest.json');
const checks = [];

function check(id, label, condition, detail) {
  const pass = !!condition;
  checks.push({ id, label, pass, detail: detail || '' });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (detail ? ' - ' + detail : ''));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function createCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.on('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} },
    }));
    socket.on('error', reject);
    socket.on('close', () => {
      const error = new Error('CDP closed before the runtime regression completed');
      pending.forEach((deferred) => deferred.reject(error));
      pending.clear();
    });
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else deferred.resolve(message.result);
    });
  });
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the controlled Electron page: ' + (lastError && lastError.message || 'unknown error'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown error'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buffer = Buffer.from(result.data || '', 'base64');
  if (buffer.length < 1024) throw new Error('Screenshot is unexpectedly small: ' + name);
  const target = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(target, buffer);
  return { file: target, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase() };
}

function readProtectedManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const sourceChecks = manifest.protected_files.map((entry) => ({
    path: entry.path,
    expected: entry.sha256,
    actual: sha256(path.join(ROOT, entry.path)),
  })).map((entry) => Object.assign(entry, { match: entry.expected === entry.actual }));
  return { manifest_sha256: sha256(MANIFEST), sourceChecks };
}

function isSafeTemporaryProfile(userData) {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolved = path.resolve(userData);
  return resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('xinjing-platform-runtime-');
}

async function stopElectron(cdp, child) {
  try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
  for (let attempt = 0; attempt < 30 && child && child.exitCode === null; attempt += 1) await sleep(100);
  if (child && child.exitCode === null) child.kill();
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const protectedEvidence = readProtectedManifest();
  check('P1', 'all protected inputs still match their manifest', protectedEvidence.sourceChecks.every((entry) => entry.match), JSON.stringify(protectedEvidence.sourceChecks));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const executableVersion = childProcess.execFileSync(ELECTRON, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  check('P2', 'Electron executable, root declaration and lock resolve 43.2.0', executableVersion === EXPECTED_ELECTRON && pkg.devDependencies.electron === '^43.2.0' && lock.packages['node_modules/electron'].version === EXPECTED_ELECTRON, JSON.stringify({ executableVersion, declaration: pkg.devDependencies.electron, lockVersion: lock.packages['node_modules/electron'].version, expected: EXPECTED_ELECTRON }));
  check('P3', 'controlled runner refuses to launch any non-acceptance updater path', ACCEPTANCE_MODE === '1', JSON.stringify({ acceptanceMode: ACCEPTANCE_MODE }));
  if (!checks.every((entry) => entry.pass)) throw new Error('Preflight failed; Electron was not started');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  check('P4', 'controlled run uses a newly created temporary profile', isSafeTemporaryProfile(userData), userData);
  if (!checks.every((entry) => entry.pass)) throw new Error('Preflight failed; Electron was not started');

  const port = await findFreePort();
  const testKey = '__xj_platform_runtime_' + crypto.randomBytes(8).toString('hex');
  const runtimeLogs = [];
  let child;
  let cdp;
  let screenshots = [];
  let idb = null;
  let invalidSelection = null;
  let updateResult = null;
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        XJ_AGENT_ACCEPTANCE: ACCEPTANCE_MODE,
        XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => runtimeLogs.push(String(chunk).trim()));
    child.stdout.on('data', (chunk) => runtimeLogs.push(String(chunk).trim()));

    const page = await waitForPage(port);
    const origin = new URL(page.url).origin;
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try {
      await waitFor(cdp, 'document.readyState === "complete" && typeof window.Store !== "undefined" && typeof window.__XJ_API__ !== "undefined"', 'Store and preload bridge initialization');
    } catch (error) {
      const diagnostic = await evaluate(cdp, '({url:location.href,readyState:document.readyState,storeType:typeof window.Store,apiType:typeof window.__XJ_API__,scripts:Array.from(document.scripts).map(function(script){return script.src||"inline";})})').catch((diagnosticError) => ({ diagnosticError: String(diagnosticError && diagnosticError.message || diagnosticError) }));
      throw new Error(error.message + '; diagnostic=' + JSON.stringify(diagnostic) + '; processLogs=' + JSON.stringify(runtimeLogs.filter(Boolean)));
    }
    check('R1', 'project main process serves a loopback page from the controlled Electron session', /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(page.url), page.url);

    const initial = await evaluate(cdp, '(async function(){var key=' + JSON.stringify(testKey) + '; var value={kind:"synthetic-platform-regression",nonce:"' + testKey + '"}; await Store._put(key,value,{allowFallback:false}); var raw=await new Promise(function(resolve,reject){var request=indexedDB.open("xinjing_db"); request.onerror=function(){reject(request.error);}; request.onsuccess=function(){var tx=request.result.transaction("kv","readonly"); var get=tx.objectStore("kv").get(key); get.onerror=function(){reject(get.error);}; get.onsuccess=function(){resolve(get.result&&get.result.value);};};}); return {key:key,stored:await Store._get(key),raw:raw,timeOrigin:performance.timeOrigin,hasBridge:typeof window.__XJ_API__.parseClinicalMaterialFile==="function"};})()');
    check('R2', 'real Store writes the synthetic value to IndexedDB before reload', initial && initial.raw && initial.raw.nonce === testKey && initial.stored && initial.stored.nonce === testKey && initial.hasBridge, JSON.stringify(initial));

    if (MODE !== 'skip-page-reload') {
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitFor(cdp, 'document.readyState === "complete" && typeof window.Store !== "undefined" && typeof window.__XJ_API__ !== "undefined"', 'page reload initialization');
    }
    const afterReload = await evaluate(cdp, '(async function(){var key=' + JSON.stringify(testKey) + '; var raw=await new Promise(function(resolve,reject){var request=indexedDB.open("xinjing_db"); request.onerror=function(){reject(request.error);}; request.onsuccess=function(){var tx=request.result.transaction("kv","readonly"); var get=tx.objectStore("kv").get(key); get.onerror=function(){reject(get.error);}; get.onsuccess=function(){resolve(get.result&&get.result.value);};};}); return {stored:await Store._get(key),raw:raw,timeOrigin:performance.timeOrigin};})()');
    idb = { initial, afterReload };
    check('R3', 'synthetic IndexedDB value survives a real page reload in the temporary profile', afterReload && afterReload.raw && afterReload.raw.nonce === testKey && afterReload.stored && afterReload.stored.nonce === testKey && afterReload.timeOrigin !== initial.timeOrigin, JSON.stringify(idb));

    const actualSelection = await evaluate(cdp, 'window.__XJ_API__.parseClinicalMaterialFile("forged-selection-id")');
    invalidSelection = MODE === 'accept-forged-selection' ? { ok: true, file: { name: 'forged.txt' } } : actualSelection;
    check('R4', 'real file-selection IPC rejects a forged or expired selection ID without a path', invalidSelection && invalidSelection.ok === false && typeof invalidSelection.error === 'string' && !Object.prototype.hasOwnProperty.call(invalidSelection, 'path'), JSON.stringify(invalidSelection));

    updateResult = await evaluate(cdp, 'window.__XJ_API__.update.check("stable", "installer")');
    check('R5', 'update bridge is callable in acceptance mode without invoking packaged updater behavior', updateResult && updateResult.ok === true && updateResult.state === 'checking' && updateResult.errorCode === 'acceptance-mode', JSON.stringify({ updateResult, origin }));

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    screenshots.push(await capture(cdp, 'index-1024x700'));

    await evaluate(cdp, '(async function(){var key=' + JSON.stringify(testKey) + '; await Store._del(key); return await Store._get(key);})()');
    const cleaned = await evaluate(cdp, '(async function(){var key=' + JSON.stringify(testKey) + '; return await new Promise(function(resolve,reject){var request=indexedDB.open("xinjing_db"); request.onerror=function(){reject(request.error);}; request.onsuccess=function(){var tx=request.result.transaction("kv","readonly"); var get=tx.objectStore("kv").get(key); get.onerror=function(){reject(get.error);}; get.onsuccess=function(){resolve(get.result||null);};};});})()');
    check('R6', 'synthetic IndexedDB value is removed before controlled-session cleanup', cleaned === null, JSON.stringify({ key: testKey, cleaned }));
  } finally {
    if (cdp && child) await stopElectron(cdp, child);
    if (cdp) cdp.close();
    if (isSafeTemporaryProfile(userData)) fs.rmSync(userData, { recursive: true, force: true });
  }

  const expectedRed = MODE === 'drop-installer-boundary' ? [] : ['packaged-updater', 'installer-upgrade-rollback'];
  check('R7', 'packaged updater and installer/rollback remain explicit expected-red boundaries', expectedRed.includes('packaged-updater') && expectedRed.includes('installer-upgrade-rollback'), JSON.stringify(expectedRed));

  const failed = checks.filter((entry) => !entry.pass);
  const summary = {
    task_id: TASK_ID,
    mode: MODE,
    electron_version: executableVersion,
    protected_evidence: protectedEvidence,
    profile: { temporary: isSafeTemporaryProfile(userData), cleaned: true },
    indexeddb: idb,
    forged_selection: invalidSelection,
    updater_bridge_result: updateResult,
    expected_red: expectedRed,
    manual_visual: {
      status: 'pending',
      required: ['tray-visible-in-controlled-session', 'file-picker-cancelled', 'print-dialog-cancelled', 'window-remains-usable-after-cancel'],
    },
    screenshots,
    runtime_logs: runtimeLogs.filter(Boolean),
    checks,
    failed: failed.length,
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'runtime-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('Passed: ' + (checks.length - failed.length) + ' | Failed: ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack || error));
  process.exit(1);
});
