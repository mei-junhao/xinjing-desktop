'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const cp = require('child_process');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

const TASK_ID = 'XJ-5.1.2-calendar-billing-dialogue-fix-002';
const CARD_SHA = process.env.XJ_CARD_SHA || '1FC613C503C6076B89790CA12B54A9B3E83E3CC67F1AFF117F2E2EBD36504543';
const EVIDENCE_TASK_ID = process.env.XJ_EVIDENCE_TASK_ID || TASK_ID;
const ROOT = path.resolve(__dirname, '../../..');
const APP_ROOT = path.join(ROOT, 'app');
const SCRATCH = path.resolve(process.env.XJ_EVIDENCE_ROOT || path.join(ROOT, 'qa', 'task-scratch', TASK_ID));
const { createServer: createAccountAuthServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const RUN_ROOT = path.join(SCRATCH, 'runtime', RUN_ID);
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SESSION_DATE = '2026-08-30';
const VIEWPORT = { name: '1366x768', width: 1366, height: 768 };
const CLEANUP_GRACE_MS = 2500;
const CLEANUP_FORCE_WAIT_MS = 3500;
const CLEANUP_TOTAL_MS = 10000;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function writeBuffer(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function now() { return new Date().toISOString(); }

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function choosePort() {
  for (let port = 9660; port < 9720; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error('没有可用的本机 CDP 端口');
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('CDP 页面目标未出现');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
    });
    return this;
  }

  send(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP request timeout: ' + method));
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

async function evaluate(cdp, expression, awaitPromise) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: awaitPromise !== false,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error((details.exception && details.exception.description) || details.text || '渲染进程执行失败');
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, expression, true);
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('等待超时：' + label + (lastError ? '；' + lastError.message : ''));
}

async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(120);
}

async function capture(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bytes = Buffer.from(result.data || '', 'base64');
  if (bytes.length < 1024) throw new Error('截图过小，页面可能为空');
  writeBuffer(file, bytes);
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

function consoleErrorText(item) {
  if (!item) return '';
  const parts = [];
  if (typeof item.text === 'string') parts.push(item.text);
  if (typeof item.description === 'string') parts.push(item.description);
  if (item.entry) {
    if (typeof item.entry.text === 'string') parts.push(item.entry.text);
    if (typeof item.entry.url === 'string') parts.push(item.entry.url);
  }
  if (Array.isArray(item.args)) {
    item.args.forEach((arg) => {
      if (!arg) return;
      if (typeof arg.value === 'string') parts.push(arg.value);
      if (typeof arg.description === 'string') parts.push(arg.description);
    });
  }
  return parts.join(' ');
}

function isHarnessConsoleNoise(item) {
  const value = consoleErrorText(item);
  return /Electron sandboxed_renderer\.bundle\.js script failed to run/i.test(value)
    || /Cannot destructure property 'preloadScripts' of 'binding\.startupData' as it is null/i.test(value);
}

function processSnapshot() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout || '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch (_) {
    return null;
  }
}

function processTree(snapshot, rootPid) {
  if (!Array.isArray(snapshot)) return null;
  const byParent = new Map();
  for (const item of snapshot) {
    const parent = Number(item.ParentProcessId);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(item);
  }
  const result = [];
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length) {
    const pid = Number(queue.shift());
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const item = snapshot.find((candidate) => Number(candidate.ProcessId) === pid);
    if (item) result.push(item);
    for (const child of byParent.get(pid) || []) queue.push(Number(child.ProcessId));
  }
  return result;
}

function processInfo(snapshot, pid) {
  return Array.isArray(snapshot) ? snapshot.find((item) => Number(item.ProcessId) === Number(pid)) || null : null;
}

function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function normalizedCommandLine(value) {
  return String(value || '').replace(/\\/g, '/').replace(/"/g, '').toLowerCase();
}

function compactProcessInfo(item) {
  if (!item) return null;
  return {
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    name: String(item.Name || ''),
    commandLine: String(item.CommandLine || ''),
  };
}

function compactProcessTree(tree) {
  return Array.isArray(tree) ? tree.map(compactProcessInfo).filter(Boolean) : null;
}

function isConfirmedElectron(info, userData, port, processRoot) {
  if (!info) return false;
  const name = String(info.Name || '').toLowerCase();
  const commandLine = normalizedCommandLine(info.CommandLine);
  const dataPath = normalizedPath(userData);
  const rootPath = normalizedPath(processRoot || ROOT);
  return (name === 'electron.exe' || name.endsWith('\\electron.exe'))
    && commandLine.includes(dataPath)
    && commandLine.includes('--remote-debugging-port=' + String(port).toLowerCase())
    && commandLine.includes(rootPath);
}

function trackedProcessIds(tree) {
  return Array.isArray(tree)
    ? tree.map((item) => Number(item.pid == null ? item.ProcessId : item.pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
}

function trackedProcesses(snapshot, rootPid, trackedPids) {
  if (!Array.isArray(snapshot)) return { tree: null, tracked: null };
  const tree = processTree(snapshot, rootPid) || [];
  const trackedSet = new Set((trackedPids || []).map((pid) => Number(pid)));
  const tracked = snapshot.filter((item) => trackedSet.has(Number(item.ProcessId)));
  return { tree: compactProcessTree(tree), tracked: compactProcessTree(tracked) };
}

function waitForTrackedTreeGone(rootPid, trackedPids, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let last = { gone: false, inspectionAvailable: false, tree: null, tracked: null };
  return (async () => {
    while (Date.now() <= deadline) {
      const snapshot = processSnapshot();
      if (Array.isArray(snapshot)) {
        const current = trackedProcesses(snapshot, rootPid, trackedPids);
        last = {
          gone: Array.isArray(current.tree) && current.tree.length === 0 && Array.isArray(current.tracked) && current.tracked.length === 0,
          inspectionAvailable: true,
          tree: current.tree,
          tracked: current.tracked,
        };
        if (last.gone) return last;
      }
      await sleep(100);
    }
    const snapshot = processSnapshot();
    if (Array.isArray(snapshot)) {
      const current = trackedProcesses(snapshot, rootPid, trackedPids);
      last = {
        gone: Array.isArray(current.tree) && current.tree.length === 0 && Array.isArray(current.tracked) && current.tracked.length === 0,
        inspectionAvailable: true,
        tree: current.tree,
        tracked: current.tracked,
      };
    }
    return last;
  })();
}

function terminateConfirmedElectronTree(rootPid, userData, port, processRoot) {
  const beforeSnapshot = processSnapshot();
  const root = processInfo(beforeSnapshot, rootPid);
  const beforeTree = processTree(beforeSnapshot, rootPid);
  const result = {
    attempted: false,
    confirmed: isConfirmedElectron(root, userData, port, processRoot || ROOT),
    inspectionAvailable: Array.isArray(beforeSnapshot),
    root: compactProcessInfo(root),
    beforeTree: compactProcessTree(beforeTree),
    kill: null,
    afterTree: null,
  };
  if (!result.confirmed) return result;
  result.attempted = true;
  const kill = cp.spawnSync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  result.kill = {
    command: ['taskkill.exe', '/PID', String(rootPid), '/T', '/F'],
    exitCode: kill.status == null ? null : kill.status,
    stdout: String(kill.stdout || ''),
    stderr: String(kill.stderr || ''),
    error: kill.error ? String(kill.error.message || kill.error) : null,
  };
  result.afterTree = compactProcessTree(processTree(processSnapshot(), rootPid));
  return result;
}

function waitForProcessExit(child, timeoutMs) {
  if (!child) return Promise.resolve({ exited: false, code: null, signal: null, timedOut: true });
  if (child.exitCode !== null) return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode || null, timedOut: false });
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = (code, signal) => finish({ exited: true, code: code == null ? null : code, signal: signal || null, timedOut: false });
    timer = setTimeout(() => finish({ exited: false, code: child.exitCode == null ? null : child.exitCode, signal: child.signalCode || null, timedOut: true }), timeoutMs || 5000);
    child.once('exit', onExit);
  });
}

function machineCode() {
  let raw = '';
  try { raw = os.hostname() + '__' + os.userInfo().username + '__' + os.homedir(); }
  catch (_) { raw = 'xj-002-test-machine'; }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
}

function writeProLicense(userData, tier) {
  const signer = require(path.join(ROOT, 'scripts', 'license-sign-v2.js'));
  const claim = signer.signLicenseClaim({
    licenseId: 'lic_xj002_runtime_20260830',
    subjectId: 'sub_xj002_runtime',
    tier: tier || 'pro',
    machineCode: machineCode(),
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2027-08-29T00:00:00.000Z',
  });
  writeJson(path.join(userData, 'license.json'), {
    schemaVersion: 2,
    claim,
    source: 'offline',
    activatedAt: '2026-08-29T00:00:00.000Z',
  });
}

async function createSyntheticAccountFixture(userData) {
  const dataFile = path.join(userData, 'xj002-account-auth.sqlite');
  const slug = path.basename(userData).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'runtime';
  const email = 'xj002-' + slug.toLowerCase() + '@example.com';
  const password = 'Xj002-Calendar9';
  const accountServer = createAccountAuthServer({ dataFile });
  const port = await accountServer.listen();
  try {
    let account = accountServer.auth._userByEmail(email);
    if (!account) {
      const registration = accountServer.auth.register({ email, password });
      if (!registration || registration.ok !== true || !registration.verificationToken) {
        throw new Error('合成账号注册失败');
      }
      const verification = accountServer.auth.verify(registration.verificationToken);
      if (!verification || verification.ok !== true) throw new Error('合成账号验证失败');
      account = accountServer.auth._userByEmail(email);
    }
    if (!account || !account.emailVerified) throw new Error('合成账号未完成验证');
    return {
      server: accountServer,
      port,
      baseUrl: 'http://127.0.0.1:' + port,
      email,
      password,
      accountId: account.id,
    };
  } catch (error) {
    try { accountServer.server.close(); } catch (_) {}
    try { accountServer.auth.close(); } catch (_) {}
    throw error;
  }
}

async function launch(options) {
  options = options || {};
  const userData = options.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'xj-512-calendar-002-'));
  ensureDir(userData);
  if (options.tier) writeProLicense(userData, options.tier);
  const accountFixture = options.account === false ? null : await createSyntheticAccountFixture(userData);
  const port = await choosePort();
  const args = [
    '--disable-gpu',
    '--user-data-dir=' + userData,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
    ROOT,
  ];
  const child = cp.spawn(ELECTRON, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      XJ_AGENT_ACCEPTANCE: '1',
      XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
      XJ_ACCOUNT_API_BASE: accountFixture ? accountFixture.baseUrl : '',
    }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await findPageTarget(port);
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
  const consoleErrors = [];
  const pageErrors = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  cdp.ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params && message.params.exceptionDetails || {});
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params && message.params.type)) consoleErrors.push(message.params);
    if (message.method === 'Log.entryAdded' && message.params && message.params.entry && message.params.entry.level === 'error') consoleErrors.push(message.params.entry);
  });
  // 只阻断外部 HTTPS/WebSocket；应用的 loopback 静态源必须允许加载页面脚本。
  // HTTP 外部请求仍由 acceptance 模式的主进程 request gate + host resolver rules 拒绝。
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*/*', 'ws://*/*', 'wss://*/*'] });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const staticOrigin = await waitFor(cdp, "(/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/).test(location.origin) ? location.origin : false", '应用静态回环源');
  const launchSnapshot = processSnapshot();
  const launchRoot = processInfo(launchSnapshot, child.pid);
  const launchTree = processTree(launchSnapshot, child.pid);
  const processEvidence = {
    rootPid: child.pid,
    port,
    userData,
    processRoot: ROOT,
    rootConfirmed: isConfirmedElectron(launchRoot, userData, port, ROOT),
    inspectionAvailable: Array.isArray(launchSnapshot),
    root: compactProcessInfo(launchRoot),
    tree: compactProcessTree(launchTree),
    trackedPids: trackedProcessIds(launchTree),
  };
  let closePromise = null;

  return {
    userData,
    port,
    args,
    child,
    cdp,
    staticOrigin,
    accountFixture,
    consoleErrors,
    pageErrors,
    processEvidence,
    stdout: () => stdout,
    stderr: () => stderr,
    async close(removeUserData) {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const startedAt = now();
        const startedMs = Date.now();
        const cleanup = {
          taskId: TASK_ID,
          runtimeRunId: RUN_ID,
          ok: false,
          userData,
          rootPid: child.pid,
          port,
          processRoot: ROOT,
          command: [ELECTRON].concat(args),
          cwd: ROOT,
          closeRequested: false,
          naturalExit: false,
          naturalExitWindowExpired: false,
          forcedKill: false,
          rootConfirmed: processEvidence.rootConfirmed === true,
          treeExited: false,
          childTreeExited: false,
          userDataRemovalRequested: removeUserData !== false,
          userDataRemoved: false,
          timedOut: false,
          startedAt,
          finishedAt: null,
          elapsedMs: null,
          trackedPids: processEvidence.trackedPids.slice(),
          launchProcess: processEvidence,
          beforeTree: processEvidence.tree,
          beforeKill: [],
          afterKill: [],
          afterTree: null,
          events: [],
          error: null,
        };
        try {
          let closeResult;
          try {
            closeResult = await Promise.race([
              evaluate(cdp, 'window.close(); true'),
              new Promise((resolve) => setTimeout(() => resolve({ closeRequestWindowExpired: true }), 1200)),
            ]);
            if (closeResult && closeResult.closeRequestWindowExpired) {
              cleanup.naturalExitWindowExpired = true;
              cleanup.events.push('window-close-request-window-expired');
            } else {
              cleanup.closeRequested = closeResult === true;
              cleanup.events.push(cleanup.closeRequested ? 'window-close-requested' : 'window-close-not-confirmed');
            }
          } catch (error) {
            cleanup.error = 'window close request failed: ' + String(error.message || error);
            cleanup.events.push('window-close-request-error');
          }
          try { cdp.close(); } catch (error) { cleanup.events.push('cdp-close-error:' + String(error.message || error)); }

          const natural = await waitForProcessExit(child, CLEANUP_GRACE_MS);
          cleanup.naturalExit = natural.exited === true;
          cleanup.naturalExitWindowExpired = cleanup.naturalExitWindowExpired || natural.timedOut === true;
          cleanup.events.push(cleanup.naturalExit ? 'electron-natural-exit' : 'electron-grace-window-expired');

          let snapshot = processSnapshot();
          let current = trackedProcesses(snapshot, child.pid, cleanup.trackedPids);
          cleanup.beforeTree = current.tree || cleanup.beforeTree;
          cleanup.rootConfirmed = cleanup.rootConfirmed || isConfirmedElectron(processInfo(snapshot, child.pid), userData, port, ROOT);
          const rootStillPresent = Array.isArray(current.tree) && current.tree.some((item) => Number(item.pid) === Number(child.pid));
          const trackedStillPresent = Array.isArray(current.tracked) && current.tracked.length > 0;
          if (Array.isArray(snapshot) && !rootStillPresent && !trackedStillPresent) {
            cleanup.treeExited = true;
            cleanup.afterTree = [];
          } else if (!Array.isArray(snapshot)) {
            cleanup.error = cleanup.error || 'unable to inspect Electron process tree';
            cleanup.events.push('process-tree-inspection-failed');
          } else if (cleanup.rootConfirmed && rootStillPresent) {
            cleanup.beforeKill = current.tree || [];
            cleanup.forcedKill = true;
            cleanup.events.push('electron-tree-reclaim-requested');
            cleanup.termination = terminateConfirmedElectronTree(child.pid, userData, port, ROOT);
            if (!cleanup.termination.confirmed) {
              cleanup.error = cleanup.error || 'refused to terminate unconfirmed Electron process tree';
              cleanup.events.push('unsafe-process-target');
            }
            const forced = await waitForProcessExit(child, 1200);
            cleanup.forcedExit = forced;
            const gone = await waitForTrackedTreeGone(child.pid, cleanup.trackedPids, CLEANUP_FORCE_WAIT_MS);
            cleanup.afterKill = gone.tree || [];
            cleanup.afterTree = gone.tree || null;
            cleanup.treeExited = gone.inspectionAvailable === true && gone.gone === true;
            if (!cleanup.treeExited) cleanup.events.push('electron-tree-reclaim-incomplete');
          } else {
            cleanup.error = cleanup.error || 'refused to terminate unconfirmed Electron process tree';
            cleanup.events.push('unsafe-process-target');
          }

          if (cleanup.treeExited) {
            const finalSnapshot = processSnapshot();
            const finalCurrent = trackedProcesses(finalSnapshot, child.pid, cleanup.trackedPids);
            cleanup.afterTree = finalCurrent.tree;
            cleanup.childTreeExited = Array.isArray(finalCurrent.tree) && finalCurrent.tree.length === 0
              && Array.isArray(finalCurrent.tracked) && finalCurrent.tracked.length === 0;
            cleanup.treeExited = cleanup.childTreeExited;
          }
          if (!cleanup.treeExited) {
            cleanup.error = cleanup.error || 'Electron process tree did not exit within bounded cleanup window';
            cleanup.events.push('cleanup-incomplete');
          }

          if (accountFixture) {
            try {
              await Promise.race([
                new Promise((resolve) => accountFixture.server.server.close(() => resolve(true))),
                new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
              ]);
            } catch (error) { cleanup.events.push('account-server-close-error:' + String(error.message || error)); }
            try { accountFixture.server.auth.close(); } catch (error) { cleanup.events.push('account-auth-close-error:' + String(error.message || error)); }
          }
          if (cleanup.treeExited && cleanup.userDataRemovalRequested) {
            try {
              fs.rmSync(userData, { recursive: true, force: true });
              cleanup.userDataRemoved = !fs.existsSync(userData);
            } catch (error) {
              cleanup.error = cleanup.error || 'userData removal failed: ' + String(error.message || error);
              cleanup.events.push('userData-remove-error');
            }
          } else if (!cleanup.treeExited) {
            cleanup.events.push('userData-retained-for-safety');
          }
          cleanup.exitCode = child.exitCode == null
            ? (cleanup.forcedExit && cleanup.forcedExit.exited ? cleanup.forcedExit.code : natural.code)
            : child.exitCode;
          cleanup.signal = child.signalCode || (cleanup.forcedExit && cleanup.forcedExit.signal) || natural.signal || null;
          cleanup.timedOut = Date.now() - startedMs > CLEANUP_TOTAL_MS;
          cleanup.finishedAt = now();
          cleanup.elapsedMs = Date.now() - startedMs;
          cleanup.ok = cleanup.treeExited && (!cleanup.userDataRemovalRequested || cleanup.userDataRemoved) && cleanup.timedOut === false;
          return cleanup;
        } catch (error) {
          cleanup.error = cleanup.error || { message: error.message, stack: error.stack };
          cleanup.events.push('cleanup-exception');
          cleanup.finishedAt = now();
          cleanup.elapsedMs = Date.now() - startedMs;
          cleanup.timedOut = cleanup.elapsedMs > CLEANUP_TOTAL_MS;
          cleanup.ok = false;
          return cleanup;
        }
      })();
      return closePromise;
    },
  };
}

async function navigate(app, fileName, query) {
  const url = (app && app.staticOrigin ? app.staticOrigin : pathToFileURL(APP_ROOT).href).replace(/\/$/, '') + '/' + fileName + (query || '');
  await app.cdp.send('Page.navigate', { url });
  await waitFor(app.cdp, "document.readyState === 'complete'", fileName + ' 完成加载');
  return url;
}

async function ensureAuthenticated(app) {
  if (!app.accountFixture) return null;
  const status = await waitFor(app.cdp, `(async () => {
    const api = window.__XJ_API__ && window.__XJ_API__.account;
    if (!api || typeof api.status !== 'function') return false;
    try {
      const value = await api.status();
      return value && value.status !== 'restoring' ? value : false;
    } catch (_) { return false; }
  })()`, '合成账号状态', 20000);
  if (status.authenticated) return status;
  const result = await evaluate(app.cdp, `(async () => {
    const api = window.__XJ_API__ && window.__XJ_API__.account;
    if (!api || typeof api.login !== 'function') return { ok: false, error: { code: 'bridge-missing' } };
    return api.login(${JSON.stringify(app.accountFixture.email)}, ${JSON.stringify(app.accountFixture.password)});
  })()`);
  if (!result || result.authenticated !== true) throw new Error('合成账号登录失败');
  await waitFor(app.cdp, `(async () => {
    try { const value = await window.__XJ_API__.account.status(); return value && value.authenticated === true ? value : false; }
    catch (_) { return false; }
  })()`, '合成账号登录完成', 20000);
  return result;
}

async function navigateSession(app) {
  await ensureAuthenticated(app);
  await navigate(app, 'session-calendar.html', '?date=' + encodeURIComponent(SESSION_DATE));
  await waitFor(app.cdp, "!!document.getElementById('sc-body') && !!document.querySelector('.sc-cal') && typeof SessionCal === 'object'", '咨询日历');
  await setViewport(app.cdp, VIEWPORT);
}

async function navigateBillingShell(app) {
  await ensureAuthenticated(app);
  await navigate(app, 'billing-shell.html');
  await waitFor(app.cdp, "!!document.getElementById('bf-open-calendar') && typeof bfOpenCalendar === 'function'", '账务工作台');
  await setViewport(app.cdp, VIEWPORT);
}

async function installInteractionAudit(cdp) {
  return evaluate(cdp, `(() => {
    window.__xj002 = window.__xj002 || {};
    window.__xj002.clicks = [];
    window.__xj002.keys = [];
    document.addEventListener('click', (event) => {
      const target = event.target && event.target.closest ? event.target.closest('button, .day-event, [role="button"]') : event.target;
      window.__xj002.clicks.push({
        isTrusted: event.isTrusted === true,
        tag: target && target.tagName || '',
        id: target && target.id || '',
        className: target && String(target.className || ''),
        text: target && String(target.textContent || '').trim().slice(0, 80),
      });
    }, true);
    document.addEventListener('keydown', (event) => {
      window.__xj002.keys.push({ key: event.key, isTrusted: event.isTrusted === true });
    }, true);
    return true;
  })()`);
}

async function interactionAudit(cdp) {
  return evaluate(cdp, 'window.__xj002 || {}');
}

async function buttonPoint(cdp, selector) {
  const info = await evaluate(cdp, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height, disabled: !!button.disabled, display: style.display, visibility: style.visibility };
  })()`);
  if (!info || info.disabled || info.display === 'none' || info.visibility === 'hidden' || info.width <= 0 || info.height <= 0) {
    throw new Error('控件不可用：' + selector);
  }
  return info;
}

async function textPoint(cdp, selector, text) {
  const info = await evaluate(cdp, `(async () => {
    const wanted = ${JSON.stringify(text)};
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const node = nodes.find((item) => String(item.textContent || '').includes(wanted));
    if (!node) return null;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, text: String(node.textContent || '').trim() };
  })()`);
  if (!info || info.display === 'none' || info.visibility === 'hidden' || info.width <= 0 || info.height <= 0) {
    throw new Error('文字控件不可用：' + selector + ' / ' + text);
  }
  return info;
}

async function dispatchClick(cdp, point, label) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(180);
  return { type: 'trusted-click', label: label || '', x: point.x, y: point.y, at: now() };
}

async function trustedClick(cdp, selector, actions) {
  const point = await buttonPoint(cdp, selector);
  const action = await dispatchClick(cdp, point, selector);
  if (actions) actions.push(action);
  return action;
}

async function trustedTextClick(cdp, selector, text, actions) {
  const point = await textPoint(cdp, selector, text);
  const action = await dispatchClick(cdp, point, selector + ':' + text);
  if (actions) actions.push(action);
  return action;
}

async function focusSelector(cdp, selector) {
  return evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || typeof element.focus !== 'function') return false;
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  })()`);
}

async function keyActivate(cdp, selector, key, actions) {
  if (!(await focusSelector(cdp, selector))) throw new Error('无法聚焦键盘控件：' + selector);
  const domKey = key === 'Space' ? ' ' : key;
  const code = key === 'Space' ? 'Space' : key;
  const vk = key === 'Enter' ? 13 : 32;
  if (actions) actions.push({ type: 'key', selector, key, at: now() });
  // Electron/CDP 的原生 button 激活需要 keyDown 携带字符文本；
  // rawKeyDown + 独立 char 只会产生 DOM keydown，不会合成默认 click。
  const keyDown = { type: 'keyDown', key: domKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (key === 'Enter') {
    keyDown.text = '\r';
    keyDown.unmodifiedText = '\r';
  }
  await cdp.send('Input.dispatchKeyEvent', keyDown);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: domKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(220);
}

async function seedSynthetic(cdp, suffix) {
  const key = String(suffix || 'default');
  const clientId = 'xj002-client-' + key;
  const sessionId = 'xj002-session-' + key;
  return evaluate(cdp, `(async () => {
    await Store.hydrate();
    const existingClient = Store.getClient(${JSON.stringify(clientId)});
    const existingSession = Store.getSession(${JSON.stringify(sessionId)});
    if (existingSession) await Store.deleteSessionsDurable([${JSON.stringify(sessionId)}]);
    if (!existingClient) {
      const clientResult = await Store.createClientDurable({
        id: ${JSON.stringify(clientId)}, name: '李小明', alias: '', gender: 'unknown', status: 'active', tags: ['合成验收'], notes: ''
      });
      if (!clientResult || clientResult.ok !== true) return { ok: false, stage: 'client', result: clientResult };
    }
    const sessionResult = await Store.createSessionDurable({
      id: ${JSON.stringify(sessionId)}, clientId: ${JSON.stringify(clientId)}, sessionNumber: 1,
      date: ${JSON.stringify(SESSION_DATE)}, startTime: '10:00', endTime: '11:00', durationMinutes: 60,
      type: 'followup', status: 'confirmed', isConfirmed: true,
      billing: { fee: 100, paid: false, paidAmount: 0, source: 'manual' }, summary: ''
    });
    return { ok: !!(sessionResult && sessionResult.ok), clientId: ${JSON.stringify(clientId)}, sessionId: ${JSON.stringify(sessionId)}, client: Store.getClient(${JSON.stringify(clientId)}), session: Store.getSession(${JSON.stringify(sessionId)}), result: sessionResult };
  })()`);
}

async function renderSession(cdp) {
  await evaluate(cdp, 'SessionCal.render(); true');
  await waitFor(cdp, "Array.from(document.querySelectorAll('.day-event')).some((node) => node.textContent.includes('李小明'))", '合成会话出现在日历');
}

async function sessionSnapshot(cdp, sessionId) {
  return evaluate(cdp, `(() => {
    const details = document.querySelector('.sc-modal-overlay');
    const confirm = document.getElementById('confirm-modal');
    const body = document.getElementById('sc-body');
    const toast = document.querySelector('.toast-container');
    const event = Array.from(document.querySelectorAll('.day-event')).find((node) => node.textContent.includes('李小明'));
    return {
      url: location.href,
      detailVisible: !!details,
      detailText: details ? String(details.textContent || '').trim() : '',
      confirmVisible: !!(confirm && confirm.getAttribute('aria-hidden') === 'false' && confirm.classList.contains('show')),
      confirmAriaHidden: confirm ? confirm.getAttribute('aria-hidden') : null,
      confirmZ: confirm ? getComputedStyle(confirm).zIndex : '',
      detailZ: details ? getComputedStyle(details).zIndex : '',
      eventText: event ? String(event.textContent || '').trim() : '',
      session: Store.getSession(${JSON.stringify(sessionId)}),
      sessionCount: Store.getSessions().length,
      focusId: document.activeElement ? document.activeElement.id || '' : '',
      focusClass: document.activeElement ? String(document.activeElement.className || '') : '',
      focusText: document.activeElement ? String(document.activeElement.textContent || '').trim().slice(0, 80) : '',
      toastText: toast ? String(toast.textContent || '').trim() : '',
      bodyScrollWidth: body ? body.scrollWidth : 0,
      bodyClientWidth: body ? body.clientWidth : 0,
    };
  })()`);
}

async function patchDeleteFailure(cdp) {
  return evaluate(cdp, `(() => {
    window.__xj002 = window.__xj002 || {};
    window.__xj002.originalDeleteSessionsDurable = Store.deleteSessionsDurable;
    Store.deleteSessionsDurable = async function () { return { ok: false, error: { code: 'XJ002_FORCED_DELETE_FAILURE', message: '合成验收强制失败' } }; };
    return true;
  })()`);
}

async function restoreDelete(cdp) {
  return evaluate(cdp, `(() => {
    if (window.__xj002 && window.__xj002.originalDeleteSessionsDurable) Store.deleteSessionsDurable = window.__xj002.originalDeleteSessionsDurable;
    return true;
  })()`);
}

async function waitUntilNoDetail(cdp, sessionId) {
  await waitFor(cdp, `!document.querySelector('.sc-modal-overlay') && !Store.getSession(${JSON.stringify(sessionId)})`, '删除后的详情关闭与数据删除', 12000);
}

async function openDetail(cdp, actions) {
  await trustedTextClick(cdp, '.day-event', '李小明', actions);
  await waitFor(cdp, "!!document.querySelector('.sc-modal-overlay') && document.querySelector('.sc-modal-overlay').textContent.includes('李小明')", '会话详情');
}

async function openDeleteConfirmByClick(cdp, actions) {
  await trustedClick(cdp, '.sc-modal .danger', actions);
  await waitFor(cdp, "!!document.querySelector('#confirm-modal.show') && document.querySelector('#confirm-modal').getAttribute('aria-hidden') === 'false'", '删除确认框');
}

async function openDeleteConfirmByEnter(cdp, actions) {
  await keyActivate(cdp, '.sc-modal .danger', 'Enter', actions);
  await waitFor(cdp, "!!document.querySelector('#confirm-modal.show') && document.querySelector('#confirm-modal').getAttribute('aria-hidden') === 'false'", '键盘打开删除确认框');
}

async function closeConfirmByCancel(cdp, actions) {
  await trustedClick(cdp, '#confirm-modal [data-modal-cancel]', actions);
  await waitFor(cdp, "document.querySelector('#confirm-modal').getAttribute('aria-hidden') === 'true'", '取消确认框');
}

async function confirmByEnter(cdp, actions) {
  await keyActivate(cdp, '#confirm-ok', 'Enter', actions);
}

async function recordAppRaw(app, name, cleanupOrExit) {
  const cleanup = cleanupOrExit && typeof cleanupOrExit === 'object' ? cleanupOrExit : null;
  const suppliedExit = cleanupOrExit != null && typeof cleanupOrExit !== 'object' ? cleanupOrExit : null;
  const exitCode = cleanup && Object.prototype.hasOwnProperty.call(cleanup, 'exitCode')
    ? cleanup.exitCode
    : suppliedExit != null
      ? suppliedExit
      : (app.child.exitCode == null ? null : app.child.exitCode);
  const nonce = new Date().toISOString().replace(/[:.]/g, '-') + '-' + (app.child.pid || 'unknown');
  const base = String(name || 'app').replace(/[^A-Za-z0-9_-]/g, '_') + '-' + nonce;
  const stdoutText = app.stdout();
  const stderrText = app.stderr();
  const stdoutBuffer = Buffer.from(stdoutText, 'utf8');
  const stderrBuffer = Buffer.from(stderrText, 'utf8');
  const stdoutFile = path.join(RUN_ROOT, 'raw', base + '.stdout.txt');
  const stderrFile = path.join(RUN_ROOT, 'raw', base + '.stderr.txt');
  writeBuffer(stdoutFile, stdoutBuffer);
  writeBuffer(stderrFile, stderrBuffer);
  const command = [ELECTRON].concat(app.args);
  return {
    taskId: TASK_ID,
    evidenceTaskId: EVIDENCE_TASK_ID,
    evidenceCardSha256: CARD_SHA,
    runtimeRunId: RUN_ID,
    name,
    userData: app.userData,
    rootPid: app.child.pid,
    port: app.port,
    command,
    cwd: ROOT,
    exit: exitCode,
    exitCode,
    stdout: { file: stdoutFile, bytes: stdoutBuffer.length, sha256: sha256(stdoutBuffer) },
    stderr: { file: stderrFile, bytes: stderrBuffer.length, sha256: sha256(stderrBuffer) },
    cleanup: cleanup || null,
    binding: {
      taskId: TASK_ID,
      runtimeRunId: RUN_ID,
      userData: app.userData,
      rootPid: app.child.pid,
      port: app.port,
      command,
      cwd: ROOT,
      cleanupRootPid: cleanup && cleanup.rootPid,
      cleanupUserData: cleanup && cleanup.userData,
      cleanupPort: cleanup && cleanup.port,
      cleanupTreeExited: cleanup && cleanup.treeExited,
    },
  };
}

function check(checks, label, pass, details) {
  checks.push({ label, pass: !!pass, details: details == null ? null : details });
}

async function scenarioDeletionSuccess() {
  const app = await launch();
  const actions = [];
  const checks = [];
  const evidence = { scenario: 'deletion-trusted-click-cancel-enter-restart', startedAt: now(), viewport: VIEWPORT, checks, actions, screenshots: [] };
  let keepUserData = false;
  try {
    await navigateSession(app);
    const seeded = await seedSynthetic(app.cdp, 'success');
    evidence.seed = seeded;
    check(checks, '合成来访者与会话真实耐久写入', seeded && seeded.ok === true && seeded.clientId && seeded.sessionId && seeded.session && seeded.session.billing && seeded.session.billing.fee === 100, seeded);
    await installInteractionAudit(app.cdp);
    await renderSession(app.cdp);
    const initial = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.initial = initial;
    check(checks, '日历显示李小明 2026-08-30 ¥100 会话', initial.eventText.includes('李小明') && initial.session && initial.session.date === SESSION_DATE && Number(initial.session.billing.fee) === 100, initial);

    await openDetail(app.cdp, actions);
    const detail = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.detail = detail;
    check(checks, '详情层由真实入口打开', detail.detailVisible && detail.detailText.includes('李小明') && detail.detailText.includes('¥100'), detail);

    await openDeleteConfirmByClick(app.cdp, actions);
    const confirm = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.confirm = confirm;
    check(checks, 'trusted click 真实打开删除确认框', confirm.confirmVisible && Number(confirm.confirmZ) > Number(confirm.detailZ) && confirm.confirmZ !== 'auto', confirm);
    check(checks, 'trusted click 被浏览器标记为 isTrusted', (await interactionAudit(app.cdp)).clicks.some((item) => item.isTrusted && item.className.includes('danger')), await interactionAudit(app.cdp));

    await closeConfirmByCancel(app.cdp, actions);
    const cancelled = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.cancelled = cancelled;
    check(checks, 'trusted click 取消后详情仍在', cancelled.detailVisible && !cancelled.confirmVisible && cancelled.session && cancelled.session.id === seeded.sessionId, cancelled);
    check(checks, '取消后数据仍保留且焦点回到删除按钮', cancelled.session && cancelled.focusClass.includes('danger') && cancelled.focusText.includes('删除'), cancelled);

    await openDeleteConfirmByEnter(app.cdp, actions);
    const enterConfirm = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.enterConfirm = enterConfirm;
    check(checks, 'Enter 真实打开删除确认框', enterConfirm.confirmVisible && enterConfirm.detailVisible, enterConfirm);
    check(checks, '删除入口键盘事件为 trusted', (await interactionAudit(app.cdp)).keys.some((item) => item.key === 'Enter' && item.isTrusted), await interactionAudit(app.cdp));

    await confirmByEnter(app.cdp, actions);
    await waitUntilNoDetail(app.cdp, seeded.sessionId);
    const deleted = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.deleted = deleted;
    check(checks, 'Enter 确认后 durable 删除成功', !deleted.session && deleted.sessionCount >= 0, deleted);
    check(checks, '确认成功后详情关闭且日历刷新', !deleted.detailVisible && !deleted.eventText && deleted.confirmAriaHidden === 'true', deleted);
    check(checks, '确认成功反馈明确', deleted.toastText.includes('已删除会话'), deleted.toastText);
    check(checks, '成功后焦点落到稳定日历内容区', deleted.focusId === 'sc-body', deleted.focusId);
    evidence.screenshots.push(await capture(app.cdp, path.join(RUN_ROOT, 'deletion-success.png')));

    const userData = app.userData;
    const cleanup1 = await app.close(false);
    keepUserData = true;
    evidence.raw = await recordAppRaw(app, 'deletion-success-first', cleanup1);
    const app2 = await launch({ userData });
    try {
      await navigateSession(app2);
      const restart = await evaluate(app2.cdp, `(() => ({ session: Store.getSession(${JSON.stringify(seeded.sessionId)}), events: Array.from(document.querySelectorAll('.day-event')).filter((node) => node.textContent.includes('李小明')).length }))()`);
      evidence.restart = restart;
      check(checks, '重启同一临时 userData 后会话不存在', !restart.session && restart.events === 0, restart);
      const cleanup2 = await app2.close(true);
      evidence.restartRaw = await recordAppRaw(app2, 'deletion-success-restart', cleanup2);
    } finally {
      if (app2.child.exitCode === null) await app2.close(true);
    }
  } catch (error) {
    evidence.error = { message: error.message, stack: error.stack };
  } finally {
    if (app.child.exitCode === null) await app.close(!keepUserData);
    evidence.consoleErrors = app.consoleErrors.filter((item) => !isHarnessConsoleNoise(item)).map(consoleErrorText);
    evidence.pageErrors = app.pageErrors.map((item) => item.text || 'renderer exception');
    evidence.status = checks.every((item) => item.pass) && !evidence.error && evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    evidence.finishedAt = now();
  }
  return evidence;
}

async function scenarioDeletionFailure() {
  const app = await launch();
  const actions = [];
  const checks = [];
  const evidence = { scenario: 'deletion-durable-failure-fail-closed', startedAt: now(), viewport: VIEWPORT, checks, actions, screenshots: [] };
  try {
    await navigateSession(app);
    const seeded = await seedSynthetic(app.cdp, 'failure');
    evidence.seed = seeded;
    await installInteractionAudit(app.cdp);
    await renderSession(app.cdp);
    await openDetail(app.cdp, actions);
    await openDeleteConfirmByClick(app.cdp, actions);
    await patchDeleteFailure(app.cdp);
    await confirmByEnter(app.cdp, actions);
    await waitFor(app.cdp, "document.querySelector('.toast-container') && document.querySelector('.toast-container').textContent.includes('删除失败')", '删除失败反馈', 10000);
    const failed = await sessionSnapshot(app.cdp, seeded.sessionId);
    evidence.failed = failed;
    check(checks, 'durable 返回 {ok:false} 时确认框仍保留', failed.confirmVisible && failed.detailVisible, failed);
    check(checks, 'durable 返回 {ok:false} 时原会话仍保留', !!failed.session && failed.session.id === seeded.sessionId, failed.session);
    check(checks, '失败路径没有成功提示', failed.toastText.includes('删除失败') && !failed.toastText.includes('已删除会话'), failed.toastText);
    await restoreDelete(app.cdp);
    await closeConfirmByCancel(app.cdp, actions);
    const afterCancel = await sessionSnapshot(app.cdp, seeded.sessionId);
    check(checks, '失败后取消仍保持详情和数据', afterCancel.detailVisible && !!afterCancel.session, afterCancel);
    evidence.screenshots.push(await capture(app.cdp, path.join(RUN_ROOT, 'deletion-failure.png')));
  } catch (error) {
    evidence.error = { message: error.message, stack: error.stack };
  } finally {
    const cleanup = await app.close(true);
    evidence.raw = await recordAppRaw(app, 'deletion-failure', cleanup);
    evidence.consoleErrors = app.consoleErrors.filter((item) => !isHarnessConsoleNoise(item)).map(consoleErrorText);
    evidence.pageErrors = app.pageErrors.map((item) => item.text || 'renderer exception');
    evidence.status = checks.every((item) => item.pass) && !evidence.error && evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    evidence.finishedAt = now();
  }
  return evidence;
}

async function scenarioBillingFree() {
  const app = await launch();
  const checks = [];
  const actions = [];
  const evidence = { scenario: 'billing-calendar-free-preview', startedAt: now(), viewport: VIEWPORT, checks, actions, screenshots: [] };
  try {
    await navigateBillingShell(app);
    const state = await waitFor(app.cdp, "(() => { const s = App.getLicenseState(); return s && s.tier === 'free' && s.activated === false ? s : false; })()", '免费权益状态');
    evidence.licenseState = state;
    await installInteractionAudit(app.cdp);
    await trustedClick(app.cdp, '#bf-open-calendar', actions);
    await waitFor(app.cdp, "!!document.getElementById('bf-calendar-preview')", '免费月历权益预览');
    const preview = await evaluate(app.cdp, `(() => ({ url: location.href, title: document.querySelector('#bf-calendar-preview h2') ? document.querySelector('#bf-calendar-preview h2').textContent : '', text: document.querySelector('#bf-calendar-preview') ? document.querySelector('#bf-calendar-preview').textContent : '', busy: document.getElementById('bf-open-calendar') ? document.getElementById('bf-open-calendar').getAttribute('aria-busy') : null, calendar: !!document.querySelector('.bc-calendar') }))()`);
    evidence.preview = preview;
    check(checks, '免费状态点击月历有明确权益预览', preview.title.includes('月历') && preview.text.includes('会员') && preview.text.includes('查看方案'), preview);
    check(checks, '免费状态不静默跳转到账单月历', preview.url.includes('billing-shell.html') && preview.calendar === false, preview);
    check(checks, '免费入口点击期间 busy 结束并恢复可用', preview.busy === null, preview.busy);
    await trustedClick(app.cdp, '#bf-cal-close', actions);
    await waitFor(app.cdp, "!document.getElementById('bf-calendar-preview')", '关闭权益预览');
    evidence.screenshots.push(await capture(app.cdp, path.join(RUN_ROOT, 'billing-free-preview.png')));
  } catch (error) {
    evidence.error = { message: error.message, stack: error.stack };
  } finally {
    const cleanup = await app.close(true);
    evidence.raw = await recordAppRaw(app, 'billing-free', cleanup);
    evidence.consoleErrors = app.consoleErrors.filter((item) => !isHarnessConsoleNoise(item)).map(consoleErrorText);
    evidence.pageErrors = app.pageErrors.map((item) => item.text || 'renderer exception');
    evidence.status = checks.every((item) => item.pass) && !evidence.error && evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    evidence.finishedAt = now();
  }
  return evidence;
}

async function setBillingMonth(cdp, targetLabel) {
  await waitFor(cdp, "typeof prevMonth === 'function' && typeof nextMonth === 'function' && !!document.getElementById('month-label')", '账单月份控件');
  const reached = await evaluate(cdp, `(async () => {
    for (let i = 0; i < 30; i += 1) {
      const label = document.getElementById('month-label');
      if (label && label.textContent === ${JSON.stringify(targetLabel)}) return true;
      const value = label ? label.textContent : '';
      const match = /^(\\d{4})年(\\d{1,2})月$/.exec(value);
      const target = /^(\\d{4})年(\\d{1,2})月$/.exec(${JSON.stringify(targetLabel)});
      if (!match || !target) return false;
      const currentIndex = Number(match[1]) * 12 + Number(match[2]);
      const targetIndex = Number(target[1]) * 12 + Number(target[2]);
      if (currentIndex > targetIndex) prevMonth(); else nextMonth();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  })()`);
  if (!reached) throw new Error('无法定位账单月份：' + targetLabel);
}

async function scenarioBillingAuthorized() {
  const app = await launch({ tier: 'pro' });
  const checks = [];
  const actions = [];
  const evidence = { scenario: 'billing-calendar-authorized-navigation-render', startedAt: now(), viewport: VIEWPORT, checks, actions, screenshots: [] };
  try {
    await navigateBillingShell(app);
    const state = await waitFor(app.cdp, "(() => { const s = App.getLicenseState(); return s && s.tier === 'pro' && s.activated === true ? s : false; })()", '已授权权益状态');
    evidence.licenseState = state;
    const seeded = await seedSynthetic(app.cdp, 'billing');
    evidence.seed = seeded;
    check(checks, '已授权测试使用合成李小明与 ¥100 会话', seeded && seeded.ok === true && seeded.session && Number(seeded.session.billing.fee) === 100, seeded);
    await installInteractionAudit(app.cdp);
    await trustedClick(app.cdp, '#bf-open-calendar', actions);
    await waitFor(app.cdp, "location.href.includes('billing-calendar.html') && !!document.querySelector('.bc-calendar')", '已授权账单月历导航与渲染', 15000);
    await setBillingMonth(app.cdp, '2026年8月');
    await waitFor(app.cdp, "document.querySelector('.bc-calendar').textContent.includes('李小明')", '账单月历合成会话');
    const rendered = await evaluate(app.cdp, `(() => ({ url: location.href, label: document.getElementById('month-label') ? document.getElementById('month-label').textContent : '', calendar: !!document.querySelector('.bc-calendar'), eventText: document.querySelector('.bc-calendar') ? document.querySelector('.bc-calendar').textContent : '', bodyText: document.getElementById('bc-body') ? document.getElementById('bc-body').textContent : '', session: Store.getSession(${JSON.stringify(seeded.sessionId)}) }))()`);
    evidence.rendered = rendered;
    check(checks, '已授权月历入口真实导航', rendered.url.includes('billing-calendar.html') && !rendered.url.includes('billing-shell.html'), rendered.url);
    check(checks, '账单月历真实渲染 .bc-calendar 与合成数据', rendered.calendar && rendered.label === '2026年8月' && rendered.eventText.includes('李小明'), rendered);
    check(checks, '账务月历保留 ¥100 合成会话数据', rendered.session && Number(rendered.session.billing.fee) === 100 && rendered.bodyText.includes('100'), rendered);
    evidence.screenshots.push(await capture(app.cdp, path.join(RUN_ROOT, 'billing-authorized-calendar.png')));
  } catch (error) {
    evidence.error = { message: error.message, stack: error.stack };
  } finally {
    const cleanup = await app.close(true);
    evidence.raw = await recordAppRaw(app, 'billing-authorized', cleanup);
    evidence.consoleErrors = app.consoleErrors.filter((item) => !isHarnessConsoleNoise(item)).map(consoleErrorText);
    evidence.pageErrors = app.pageErrors.map((item) => item.text || 'renderer exception');
    evidence.status = checks.every((item) => item.pass) && !evidence.error && evidence.consoleErrors.length === 0 && evidence.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    evidence.finishedAt = now();
  }
  return evidence;
}

async function main() {
  ensureDir(RUN_ROOT);
  const results = [];
  for (const scenario of [scenarioDeletionSuccess, scenarioDeletionFailure, scenarioBillingFree, scenarioBillingAuthorized]) {
    const result = await scenario();
    results.push(result);
    console.log(result.status, result.scenario);
  }
  const productionHashes = {};
  for (const rel of ['app/session-calendar.html', 'app/js/session-calendar.js', 'app/billing-shell.html', 'app/js/billing-calendar.js']) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    productionHashes[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const summary = {
    taskId: TASK_ID,
    evidenceTaskId: EVIDENCE_TASK_ID,
    cardSha256: CARD_SHA,
    runId: RUN_ID,
    startedAt: now(),
    finishedAt: now(),
    status: results.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    networkPolicy: {
      hostResolverRules: 'MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
      cdpBlockedUrls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      tempUserData: true,
      syntheticDataOnly: true,
    },
    evidenceRoot: SCRATCH,
    productionHashes,
    results,
  };
  writeJson(path.join(RUN_ROOT, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, runRoot: RUN_ROOT, productionHashes, scenarios: results.map((item) => ({ scenario: item.scenario, status: item.status, failures: item.checks.filter((checkItem) => !checkItem.pass).map((checkItem) => checkItem.label) })) }, null, 2));
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

if (require.main === module) {
  main().catch((error) => {
    ensureDir(RUN_ROOT);
    writeJson(path.join(RUN_ROOT, 'fatal.json'), { status: 'FAIL', error: { message: error.message, stack: error.stack } });
    console.error(error.stack || error.message);
    process.exitCode = 2;
  });
}

module.exports = {
  TASK_ID,
  CARD_SHA,
  ROOT,
  APP_ROOT,
  SCRATCH,
  RUN_ID,
  RUN_ROOT,
  ELECTRON,
  SESSION_DATE,
  VIEWPORT,
  CLEANUP_GRACE_MS,
  CLEANUP_FORCE_WAIT_MS,
  CLEANUP_TOTAL_MS,
  ensureDir,
  writeText,
  writeJson,
  sha256,
  sleep,
  now,
  evaluate,
  waitFor,
  capture,
  launch,
  navigate,
  navigateSession,
  navigateBillingShell,
  installInteractionAudit,
  interactionAudit,
  buttonPoint,
  textPoint,
  trustedClick,
  trustedTextClick,
  focusSelector,
  keyActivate,
  seedSynthetic,
  renderSession,
  sessionSnapshot,
  patchDeleteFailure,
  restoreDelete,
  openDetail,
  openDeleteConfirmByClick,
  openDeleteConfirmByEnter,
  closeConfirmByCancel,
  confirmByEnter,
  recordAppRaw,
  processSnapshot,
  processTree,
  processInfo,
  compactProcessInfo,
  compactProcessTree,
  isConfirmedElectron,
  waitForTrackedTreeGone,
  terminateConfirmedElectronTree,
  setBillingMonth,
  scenarioDeletionSuccess,
  scenarioDeletionFailure,
  scenarioBillingFree,
  scenarioBillingAuthorized,
};
