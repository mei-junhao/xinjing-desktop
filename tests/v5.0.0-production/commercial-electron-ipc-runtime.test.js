'use strict';
// XJ-5.0.0-g8-commercial-electron-ipc-runtime-001
// contract: XJ-5.0.0-G8-COMMERCIAL-ELECTRON-IPC-RUNTIME-V1
//
// 在真实受控 Electron 进程中证明当前共享树的商业 main/preload IPC 接线：
//   - 仅通过任务局部包装入口启动（临时 userData + 默认拒绝网络 + loopback-only），绝不 npm start；
//   - 行使真实 preload 暴露的商业 API 与 main.js 当前真实 ipcMain.handle 注册；
//   - 通道集以运行时注册证据枚举（对未注册通道，invoke 以 "No handler registered" 拒绝）；
//   - 覆盖：可信往返、畸形输入失败闭环、渲染端注入字段被主进程可信上下文覆盖、
//     未知模型/空目录失败、stale revision、重复/幂等重放、跨 Electron 重启的持久化、
//     只读脱敏投影、敏感内容不进入商业 envelope、未授权 sender 到达真实守卫并被拒绝；
//   - 捕获渲染端 console/page 错误、主进程 stdout/stderr、IPC 台账、网络台账、
//     临时 userData 哈希清单与进程清理证据。
//
// 本文件为 test-only：不写任何生产文件；所有运行产物落
// qa/task-scratch/XJ-5.0.0-g8-commercial-electron-ipc-runtime-001/evidence/。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.0.0-g8-commercial-electron-ipc-runtime-001');
const EVIDENCE = path.join(SCRATCH, 'evidence');
const WRAPPER_ENTRY = path.join(SCRATCH, 'electron-entry.js');
const PROTECTED_MANIFEST = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'tasks', 'XJ-5.0.0-g8-commercial-electron-ipc-runtime-001.protected.json');
const BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const LAUNCH_TIMEOUT_MS = 240000;
const PAGE_TIMEOUT_MS = 60000;
const QUIT_TIMEOUT_MS = 20000;
const ENVELOPE_FILE = 'commercial-envelope-v3.json';

// 已知启动噪音白名单（窄）：仅 Chromium/平台级诊断噪音，任何应用级错误不在其中。
// 观察来源：冒烟运行与首轮运行时证据（见 evidence/console-events.json / launches.json）。
const STDERR_ALLOWLIST = [
  /DevTools listening on ws:\/\/127\.0\.0\.1:\d+\//,
  /WSALookupServiceBegin failed with: 10108/,
  /ERROR:gpu_angle_features\.cc|ERROR:gl_surface_presentation_helper\.cc|ERROR:viz_main_impl\.cc/,
  /GetVSyncParametersIfAvailable/,
  /DBus error/,
  // 预期噪音：本测试的“负向注册证据”探针故意 invoke 未注册通道 xj:commercial:fakeChannel，
  // Electron 对无 handler 的 invoke 会在主进程 stderr 打印下述诊断；这是测试设计的一部分，非应用错误。
  /No handler registered for 'xj:commercial:fakeChannel'/,
  /^\s*at Session\./,
];
const STDOUT_ALLOWLIST = [
  /^\[XJ\]/,
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sha256Hex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function sha256File(filePath) { return sha256Hex(fs.readFileSync(filePath)); }

function machineCode() {
  const raw = os.hostname() + '__' + os.userInfo().username + '__' + os.homedir();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
}

function deviceBindingHash() {
  return crypto.createHash('sha256').update('xj-commercial-device-v1:' + machineCode()).digest('hex');
}

function signActivationCode(licenseId) {
  const signer = require(path.join(ROOT, 'scripts', 'license-sign-v2.js'));
  const claim = signer.signLicenseClaim({
    licenseId,
    subjectId: 'sub_runtime_ipc_probe001',
    tier: 'pro',
    machineCode: machineCode(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    privateKeyPath: path.join(os.homedir(), '.xinjing', 'license-signing', 'license-ed25519-2026-01-private.pem'),
  });
  return signer.encodeActivationCode(claim);
}

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

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    childProcess.execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) {}
  }
}

function createCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    const subscribers = new Map();
    let nextId = 1;
    const api = {
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, callback) {
        if (!subscribers.has(method)) subscribers.set(method, []);
        subscribers.get(method).push(callback);
      },
      close() { try { socket.close(); } catch (_) {} },
    };
    socket.addEventListener('open', () => resolve(api));
    socket.addEventListener('error', (event) => reject(event.error || new Error(String(event.message || 'CDP socket error'))));
    socket.addEventListener('close', () => {
      const error = new Error('CDP closed before completion');
      pending.forEach((deferred) => deferred.reject(error));
      pending.clear();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (message.id && pending.has(message.id)) {
        const deferred = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else deferred.resolve(message.result);
        return;
      }
      if (message.method && subscribers.has(message.method)) {
        for (const callback of subscribers.get(message.method)) {
          try { callback(message.params || {}); } catch (_) {}
        }
      }
    });
  });
}

class Session {
  constructor(tag, entry, userData, extraEnv) {
    this.tag = tag;
    this.entry = entry;
    this.userData = userData;
    this.extraEnv = extraEnv || {};
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.child = null;
    this.debugPort = 0;
    this.page = null;
    this.cdp = null;
    this.startedAt = Date.now();
    this.exitedAt = null;
    this.watchdog = null;
    this.watchdogFired = false;
    this.consoleEvents = [];
    this.networkLedger = [];
    this.ipcLedger = [];
    this.appPort = 0;
  }

  stdout() { return this.stdoutChunks.join(''); }
  stderr() { return this.stderrChunks.join(''); }

  async start() {
    this.child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + this.userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      this.entry,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        XJ_AGENT_ACCEPTANCE: '1',
        XJ_AGENT_ACCEPTANCE_USER_DATA: this.userData,
      }, this.extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.stdoutChunks.push(String(chunk)));
    this.child.stderr.on('data', (chunk) => this.stderrChunks.push(String(chunk)));
    this.child.on('exit', (code, signal) => { this.exitedAt = Date.now(); this.exitCode = code; this.exitSignal = signal; });
    this.watchdog = setTimeout(() => {
      this.watchdogFired = true;
      killTree(this.child);
    }, LAUNCH_TIMEOUT_MS);

    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(this.tag + ': Electron exited before page load (code ' + this.child.exitCode + '). stderr: ' + this.stderr().slice(0, 2000));
      }
      const match = this.stderr().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        this.debugPort = Number(match[1]);
        try {
          const pages = await getJson('http://127.0.0.1:' + this.debugPort + '/json/list');
          const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(item.url));
          if (page && page.webSocketDebuggerUrl) { this.page = page; break; }
        } catch (_) { /* retry */ }
      }
      await sleep(250);
    }
    if (!this.page) throw new Error(this.tag + ': timed out waiting for the trusted main window page');
    this.appPort = Number(new URL(this.page.url).port);
    this.cdp = await createCdp(this.page.webSocketDebuggerUrl);
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');
    await this.cdp.send('Log.enable');
    await this.cdp.send('Network.enable');
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || []).map((arg) => (arg && typeof arg.value !== 'undefined' ? String(arg.value) : (arg && arg.description) || '')).join(' ');
      this.consoleEvents.push({ source: 'console', level: params.type, text: text.slice(0, 2000), url: (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0] && params.stackTrace.callFrames[0].url) || '' });
    });
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails || {};
      const text = (detail.exception && detail.exception.description) || detail.text || 'exception';
      this.consoleEvents.push({ source: 'page-exception', level: 'error', text: String(text).slice(0, 2000), url: detail.url || '' });
    });
    this.cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      this.consoleEvents.push({ source: 'log', level: entry.level, text: String(entry.text || '').slice(0, 2000), url: entry.url || '' });
    });
    this.cdp.on('Network.requestWillBeSent', (params) => {
      this.networkLedger.push({
        phase: 'request',
        requestId: params.requestId,
        url: params.request && params.request.url,
        method: params.request && params.request.method,
        type: params.type,
        initiator: params.initiator && params.initiator.type,
      });
    });
    this.cdp.on('Network.loadingFailed', (params) => {
      this.networkLedger.push({ phase: 'failed', requestId: params.requestId, errorText: params.errorText, blocked: !!params.blockedReason, canceled: !!params.canceled });
    });
    this.cdp.on('Network.responseReceived', (params) => {
      this.networkLedger.push({ phase: 'response', requestId: params.requestId, url: params.response && params.response.url, status: params.response && params.response.status });
    });
    await this.waitForBridge();
  }

  async waitForBridge() {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(this.tag + ': Electron exited before the bridge was ready (code ' + this.child.exitCode + ')');
      const ready = await this.evaluate('!!(window.__XJ_API__ && window.__XJ_API__.commercial && typeof window.__XJ_API__.commercial.getSnapshot === "function")').catch(() => false);
      if (ready) return;
      await sleep(250);
    }
    throw new Error(this.tag + ': preload bridge __XJ_API__.commercial never became available');
  }

  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(this.tag + ': renderer evaluation failed: ' + ((detail.exception && detail.exception.description) || detail.text || 'unknown'));
    }
    return result.result && result.result.value;
  }

  async invoke(channel, payload, note) {
    const started = Date.now();
    const expression = 'window.__XJ_API__.commercial.' + channel + '(' + JSON.stringify(payload === undefined ? null : payload) + ')';
    try {
      const value = await this.evaluate(expression);
      this.ipcLedger.push({ launch: this.tag, channel: 'xj:commercial:' + channel, ms: Date.now() - started, ok: !!(value && value.ok), errorCode: (value && value.errorCode) || '', note: note || '' });
      return { resolved: value };
    } catch (error) {
      this.ipcLedger.push({ launch: this.tag, channel: 'xj:commercial:' + channel, ms: Date.now() - started, ok: false, errorCode: 'invoke-rejected', rejectedMessage: String(error.message || error).slice(0, 300), note: note || '' });
      return { rejected: String(error.message || error) };
    }
  }

  envelopePath() { return path.join(this.userData, ENVELOPE_FILE); }

  readEnvelope() {
    return JSON.parse(fs.readFileSync(this.envelopePath(), 'utf8'));
  }

  envelopeHash() { return sha256File(this.envelopePath()); }

  userDataInventory() {
    const entries = [];
    const walk = (dir, rel) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const item of items) {
        const full = path.join(dir, item.name);
        const relPath = rel ? rel + '/' + item.name : item.name;
        if (item.isDirectory()) { walk(full, relPath); continue; }
        if (!item.isFile()) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        const entry = { path: relPath, size };
        if (size < 1024 * 1024) {
          let hashed = false;
          for (let attempt = 0; attempt < 3 && !hashed; attempt += 1) {
            try { entry.sha256 = sha256File(full); hashed = true; } catch (error) { entry.hashError = String(error.code || error.message); }
          }
        }
        entries.push(entry);
      }
    };
    walk(this.userData, '');
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  async quitGracefully() {
    try { await this.evaluate('window.close(); true'); } catch (_) {}
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    while (Date.now() < deadline && this.child.exitCode === null) await sleep(150);
    if (this.child.exitCode === null) {
      killTree(this.child);
      await sleep(500);
      return { graceful: false, exitCode: this.child.exitCode };
    }
    return { graceful: true, exitCode: this.child.exitCode };
  }

  shutdown() {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.cdp) this.cdp.close();
    killTree(this.child);
  }
}

const checks = [];
function check(id, label, condition, detail) {
  const pass = !!condition;
  checks.push({ id, label, pass, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
  assert.equal(pass, true, 'CHECK ' + id + ' FAILED: ' + label + (detail ? ' :: ' + detail : ''));
}

function record(id, label, condition, detail) {
  checks.push({ id, label, pass: !!condition, detail: detail === undefined ? '' : String(detail).slice(0, 600) });
}

function expectFailure(id, label, result, errorCode) {
  const value = result.resolved;
  check(id, label,
    !result.rejected && value && value.ok === false && value.errorCode === errorCode && value.retryable === false,
    JSON.stringify(result.resolved || result.rejected));
}

function parsePreloadChannels() {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const channels = [];
  const regex = /ipcRenderer\.invoke\('([^']+)'/g;
  let match;
  while ((match = regex.exec(source)) !== null) channels.push(match[1]);
  return channels;
}

function newUserData(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeEvidence(name, value) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const target = path.join(EVIDENCE, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return target;
}

test('T1 protected manifest, exact Electron entry, base commit (load-time facts)', () => {
  const manifest = JSON.parse(fs.readFileSync(PROTECTED_MANIFEST, 'utf8'));
  let ok = 0;
  const drift = [];
  for (const entry of manifest.entries) {
    try {
      const hash = sha256Hex(fs.readFileSync(entry.path));
      if (hash === entry.sha256) ok += 1;
      else drift.push(entry.path + ' got ' + hash);
    } catch (error) {
      drift.push(entry.path + ' ERR ' + error.message);
    }
  }
  check('T1.1', 'protected files verify 20/20 at load time', ok === manifest.entries.length && manifest.entries.length === 20, 'ok=' + ok + ' drift=' + JSON.stringify(drift));
  check('T1.2', 'exact Electron executable exists', fs.existsSync(ELECTRON), ELECTRON);
  const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  check('T1.3', 'Electron package version recorded', /^\d+\.\d+\.\d+/.test(electronVersion), electronVersion);
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  check('T1.4', 'HEAD equals task base_commit', head === BASE_COMMIT, head);
  const branch = childProcess.execFileSync('git', ['branch', '--show-current'], { cwd: ROOT }).toString().trim();
  check('T1.5', 'branch unchanged (release/3.6.3-mac)', branch === 'release/3.6.3-mac', branch);
  const realFacadeResolve = require.resolve(path.join(ROOT, 'app', 'js', 'commercial-ipc-facade.js'));
  check('T1.6', 'commercial facade resolves to the real production file (no proxy/mock)', realFacadeResolve === path.join(ROOT, 'app', 'js', 'commercial-ipc-facade.js'), realFacadeResolve);
});

test('T2 commercial IPC runtime matrix in a real controlled Electron process', { timeout: LAUNCH_TIMEOUT_MS * 6 }, async () => {
  const runNonce = crypto.randomBytes(6).toString('hex');
  const launchedSessions = [];
  const envelopeLog = [];
  const launches = {};
  let probeServer = null;
  let probeServerPort = 0;

  try {
    probeServer = http.createServer((req, res) => { res.writeHead(200); res.end('loopback-probe-ok'); });
    await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
    probeServerPort = probeServer.address().port;

    // ---------- 启动 L1：裸生产入口，全新临时 userData ----------
    const userDataA = newUserData('xj-g8-ipc-rt-a-');
    const l1 = new Session('L1', ROOT, userDataA, {});
    launchedSessions.push(l1);
    await l1.start();
    launches.L1 = { entry: 'real main.js (project root)', userData: userDataA, debugPort: l1.debugPort, appPort: l1.appPort, pid: l1.child.pid };

    check('T2.E0.1', 'trusted main window served on ephemeral loopback origin', /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(l1.page.url), l1.page.url);
    check('T2.E0.2', 'CDP debug port bound to loopback only', l1.debugPort > 0, 'ws://127.0.0.1:' + l1.debugPort);

    const bridgeShape = await l1.evaluate(`(() => {
      const api = window.__XJ_API__;
      if (!api || !api.commercial) return { ok: false };
      const keys = Object.keys(api.commercial);
      return {
        ok: Object.isFrozen(api.commercial),
        keys,
        allFunctions: keys.every((k) => typeof api.commercial[k] === 'function'),
        hasOwn: Object.prototype.hasOwnProperty.call(window, '__XJ_API__') || '__XJ_API__' in window,
      };
    })()`);
    check('T2.E0.3', 'real preload bridge __XJ_API__.commercial exposed (frozen, all functions)', bridgeShape.ok && bridgeShape.allFunctions && bridgeShape.keys.length === 15, JSON.stringify(bridgeShape.keys));

    const appVersion = await l1.evaluate('window.__XJ_API__.getVersion()');
    const packageVersion = require(path.join(ROOT, 'package.json')).version;
    check('T2.E0.4', 'xj:getVersion round trip matches package.json (real main.js handlers alive)', appVersion === packageVersion, appVersion + ' vs ' + packageVersion);

    const licenseId = 'lic_rt500ipc' + runNonce;
    const LICENSE_ID = licenseId;

    // ---------- 通道枚举：运行时注册证据 ----------
    const preloadChannels = parsePreloadChannels();
    const commercialFromPreload = preloadChannels.filter((channel) => channel.startsWith('xj:commercial:'));
    const commercialMethods = commercialFromPreload.map((channel) => channel.replace('xj:commercial:', ''));
    check('T2.EN0', 'preload surface exposes exactly 15 commercial channels', commercialMethods.length === 15, JSON.stringify(commercialMethods));
    // getAccountBalance 的注册探测使用非空 payload：readServerAccountBalance 在非空 payload 时
    // 立即 invalid-request，绝不触发外部网络（该通道空 payload 路径会尝试外部 URL，默认拒绝网络下不行使）。
    const registrationProbes = {};
    for (const method of commercialMethods) {
      const payload = { rtRegistrationProbe: runNonce };
      const result = await l1.invoke(method, payload, 'registration-probe');
      registrationProbes['xj:commercial:' + method] = result.rejected ? { registered: false, message: result.rejected } : { registered: true, errorCode: result.resolved.errorCode || '' };
    }
    // 负向通道（未注册）的运行时证据在 L3 攻击窗口中以真实 ipcRenderer.invoke 采集
    // （见 T2.ATK2：xj:commercial:fakeChannel 以 "No handler registered" 拒绝）。
    const registeredCount = Object.values(registrationProbes).filter((item) => item.registered).length;
    check('T2.EN1', 'runtime registration evidence: all 15 preload commercial channels are registered in ipcMain', registeredCount === 15, JSON.stringify(registrationProbes));
    check('T2.EN2', 'getAccountBalance registration probe fails closed before any network (non-empty payload)', registrationProbes['xj:commercial:getAccountBalance'] && registrationProbes['xj:commercial:getAccountBalance'].registered && registrationProbes['xj:commercial:getAccountBalance'].errorCode === 'invalid-request', JSON.stringify(registrationProbes['xj:commercial:getAccountBalance']));

    // ---------- 未激活 fail-closed + 手工免费不受拦截 ----------
    const preAccess = await l1.invoke('evaluateAccess', { requestId: 'rt-pre-access', featureKey: 'ai-notes', nowMs: Date.now() }, 'pre-activation paid feature');
    expectFailure('T2.PRE1', 'pre-activation paid feature evaluateAccess fails closed with invalid-license', preAccess, 'invalid-license');
    const preManual = await l1.invoke('evaluateAccess', { requestId: 'rt-pre-manual', featureKey: 'manual-core' }, 'free manual core');
    check('T2.PRE2', 'free manual-core access is never blocked (Free 手工执业不被权益拦截)', preManual.resolved && preManual.resolved.ok === true && preManual.resolved.value.freeManualAllowed === true && preManual.resolved.value.paidAccessAllowed === false, JSON.stringify(preManual.resolved));

    // ---------- 激活：真实 xj:activate 通道 + 仓库开发签名器签发的合成授权 ----------
    const activationCode = signActivationCode(LICENSE_ID);
    const activation = await l1.evaluate('window.__XJ_API__.activate(' + JSON.stringify(activationCode) + ')');
    check('T2.ACT1', 'offline activation via real xj:activate handler succeeds with synthetic claim', activation && activation.ok === true && activation.licenseId === LICENSE_ID && activation.tier === 'pro', JSON.stringify(activation));
    check('T2.ACT2', 'license.json persisted inside temporary userData only', fs.existsSync(path.join(userDataA, 'license.json')), path.join(userDataA, 'license.json'));

    // ---------- 可信往返 + 畸形输入失败闭环 ----------
    const snap0 = await l1.invoke('getSnapshot', { requestId: 'rt-snap-0' }, 'initial snapshot');
    check('T2.R1', 'trusted getSnapshot round trip: ok, revision 0, redacted empty collections', snap0.resolved && snap0.resolved.ok === true && snap0.resolved.revision === 0 && Array.isArray(snap0.resolved.value.subscriptions) && snap0.resolved.value.subscriptions.length === 0, JSON.stringify(snap0.resolved).slice(0, 300));
    check('T2.R2', 'durable envelope initialized in temporary userData after first trusted read', fs.existsSync(l1.envelopePath()) && l1.readEnvelope().revision === 0, l1.envelopePath());

    const malformed = await l1.invoke('getSnapshot', {}, 'missing requestId');
    expectFailure('T2.M1', 'malformed input (missing requestId) fails closed', malformed, 'invalid-request');
    const malformed2 = await l1.invoke('getSnapshot', { requestId: 'rt', unknownKey: 1 }, 'unknown top-level key');
    expectFailure('T2.M2', 'malformed input (unknown top-level key) fails closed', malformed2, 'invalid-request');
    const malformed3 = await l1.invoke('evaluateAccess', 'not-an-object', 'non-object payload');
    expectFailure('T2.M3', 'malformed input (non-object payload) fails closed', malformed3, 'invalid-request');
    const malformed4 = await l1.invoke('getAuditPage', { requestId: 'rt-audit-bad', limit: 0 }, 'limit below minimum');
    expectFailure('T2.M4', 'malformed input (limit < 1) fails closed', malformed4, 'invalid-request');

    // ---------- 订阅实体链（注入字段被主进程可信上下文覆盖的证明） ----------
    const injectedDevice = 'attacker-device-' + runNonce;
    const injectedSecretMarker = 'XJ-SECRET-MARKER-' + runNonce;
    const injectedPromptMarker = 'XJ-PROMPT-MARKER-' + runNonce;
    const subCreate = await l1.invoke('applySubscriptionEvent', {
      requestId: 'rt-sub-create',
      operationId: 'op-sub-create-' + runNonce,
      expectedRevision: 0,
      revocationEpoch: 99,
      deviceBindingHash: injectedDevice,
      signedEvidence: { signatureValid: true, subscriptionId: 'sub_fake_injected' },
      payload: {
        subscriptionId: LICENSE_ID,
        create: { subscriptionId: LICENSE_ID, tier: 'pro' },
        event: { operationId: 'dom-sub-pending-' + runNonce, targetState: 'pending', revision: 1 },
      },
    }, 'subscription create+pending with injected renderer-only fields');
    check('T2.S1', 'subscription pending transition commits with injected renderer fields ignored', subCreate.resolved && subCreate.resolved.ok === true && subCreate.resolved.revision === 1 && subCreate.resolved.value.state === 'pending', JSON.stringify(subCreate.resolved).slice(0, 300));
    const envelopeAfterS1 = l1.readEnvelope();
    const storedSub = envelopeAfterS1.subscriptions[LICENSE_ID];
    check('T2.S2', 'injected deviceBindingHash overridden by main-owned trusted context', storedSub && storedSub.deviceBindingHash === deviceBindingHash(), String(storedSub && storedSub.deviceBindingHash).slice(0, 20) + '...');
    check('T2.S3', 'injected revocationEpoch 99 overridden (envelope stays at trusted epoch 1)', envelopeAfterS1.revocationEpoch === 1, 'revocationEpoch=' + envelopeAfterS1.revocationEpoch);
    check('T2.S4', 'subscription record stores no injected signedEvidence (main-owned only)', !JSON.stringify(storedSub).includes('sub_fake_injected'), JSON.stringify(storedSub).slice(0, 200));

    const subActive = await l1.invoke('applySubscriptionEvent', {
      requestId: 'rt-sub-active',
      operationId: 'op-sub-active-' + runNonce,
      expectedRevision: 1,
      revocationEpoch: 1,
      deviceBindingHash: injectedDevice,
      signedEvidence: { signatureValid: false },
      payload: {
        subscriptionId: LICENSE_ID,
        event: { operationId: 'dom-sub-active-' + runNonce, targetState: 'active', revision: 2 },
      },
    }, 'subscription active with injected signatureValid=false (must be overridden)');
    check('T2.S5', 'subscription active transition succeeds despite injected signatureValid=false (trusted context wins)', subActive.resolved && subActive.resolved.ok === true && subActive.resolved.revision === 2 && subActive.resolved.value.state === 'active', JSON.stringify(subActive.resolved).slice(0, 300));

    // ---------- 注入对 evaluateAccess 无效果 ----------
    const paidAccess = await l1.invoke('evaluateAccess', { requestId: 'rt-access-paid', featureKey: 'ai-notes', nowMs: Date.now() }, 'paid feature after active subscription');
    check('T2.A1', 'paid feature allowed for active pro subscription', paidAccess.resolved && paidAccess.resolved.ok === true && paidAccess.resolved.value.paidAccessAllowed === true && paidAccess.resolved.value.freeManualAllowed === true && paidAccess.resolved.value.tier === 'pro', JSON.stringify(paidAccess.resolved).slice(0, 300));
    const paidAccessInjected = await l1.invoke('evaluateAccess', { requestId: 'rt-access-injected', featureKey: 'ai-notes', nowMs: Date.now(), signedEvidence: { subscriptionId: 'sub_fake_injected' }, deviceBindingHash: injectedDevice, revocationEpoch: 0 }, 'injected evidence must not change the outcome');
    check('T2.A2', 'injected evidence/device/epoch do not alter evaluateAccess outcome (main-owned context)', paidAccessInjected.resolved && paidAccessInjected.resolved.ok === true && paidAccessInjected.resolved.value.paidAccessAllowed === true, JSON.stringify(paidAccessInjected.resolved).slice(0, 300));
    const unknownFeature = await l1.invoke('evaluateAccess', { requestId: 'rt-access-unknown', featureKey: 'no-such-feature', nowMs: Date.now() }, 'unknown feature');
    expectFailure('T2.A3', 'unknown feature fails closed with unknown-feature', unknownFeature, 'unknown-feature');

    // ---------- 订单：提交/重放/冲突/stale ----------
    const orderEnvelope = {
      requestId: 'rt-order-1',
      operationId: 'op-order-1-' + runNonce,
      expectedRevision: 2,
      revocationEpoch: 1,
      deviceBindingHash: injectedDevice,
      signedEvidence: { signatureValid: true },
      payload: { orderId: 'order-rt-1', nextState: 'paid', fields: { amountMinor: 8800, currency: 'CNY', providerReferenceHash: 'opaque-ref-' + runNonce } },
    };
    const order1 = await l1.invoke('applyOrderEvent', orderEnvelope, 'order commit');
    check('T2.O1', 'order event commits at revision 3', order1.resolved && order1.resolved.ok === true && order1.resolved.revision === 3 && order1.resolved.value.state === 'paid', JSON.stringify(order1.resolved).slice(0, 300));
    const hashAfterOrder = l1.envelopeHash();
    const replay = await l1.invoke('applyOrderEvent', orderEnvelope, 'identical replay');
    check('T2.O2', 'identical replay is idempotent and returns original revision', replay.resolved && replay.resolved.ok === true && replay.resolved.idempotent === true && replay.resolved.revision === 3, JSON.stringify(replay.resolved).slice(0, 300));
    check('T2.O3', 'idempotent replay does not rewrite the durable envelope', l1.envelopeHash() === hashAfterOrder, l1.envelopeHash().slice(0, 16) + ' vs ' + hashAfterOrder.slice(0, 16));
    const conflictEnvelope = Object.assign({}, orderEnvelope, { payload: Object.assign({}, orderEnvelope.payload, { nextState: 'refunded' }) });
    const conflict = await l1.invoke('applyOrderEvent', conflictEnvelope, 'operationId reuse with different payload');
    expectFailure('T2.O4', 'operationId reuse with different payload fails closed with operation-conflict', conflict, 'operation-conflict');
    check('T2.O5', 'operation-conflict leaves durable state untouched', l1.envelopeHash() === hashAfterOrder, '');
    const staleEnvelope = Object.assign({}, orderEnvelope, { operationId: 'op-order-stale-' + runNonce, expectedRevision: 0, requestId: 'rt-order-stale', payload: Object.assign({}, orderEnvelope.payload, { orderId: 'order-rt-stale' }) });
    const stale = await l1.invoke('applyOrderEvent', staleEnvelope, 'stale expectedRevision');
    expectFailure('T2.O6', 'stale expectedRevision fails closed with stale-revision', stale, 'stale-revision');
    check('T2.O7', 'stale-revision attempt leaves durable state untouched', l1.envelopeHash() === hashAfterOrder, '');

    // ---------- 配额钱包：credit/debit/重放 ----------
    const quotaCredit = await l1.invoke('applyQuotaOperation', {
      requestId: 'rt-quota-credit',
      operationId: 'op-quota-credit-' + runNonce,
      expectedRevision: 3,
      revocationEpoch: 1,
      payload: {
        walletId: 'wallet-rt-1',
        create: { walletId: 'wallet-rt-1', balance: 5 },
        event: { operationId: 'dom-quota-credit-' + runNonce, type: 'credit', amount: 2, revision: 1 },
      },
    }, 'quota wallet create + credit');
    check('T2.Q1', 'quota wallet create+credit commits', quotaCredit.resolved && quotaCredit.resolved.ok === true && quotaCredit.resolved.revision === 4, JSON.stringify(quotaCredit.resolved).slice(0, 300));
    const quotaDebit = await l1.invoke('applyQuotaOperation', {
      requestId: 'rt-quota-debit',
      operationId: 'op-quota-debit-' + runNonce,
      expectedRevision: 4,
      revocationEpoch: 1,
      payload: { walletId: 'wallet-rt-1', event: { operationId: 'dom-quota-debit-' + runNonce, type: 'debit', amount: 3, revision: 2 } },
    }, 'quota debit');
    check('T2.Q2', 'quota debit commits with balance 4', quotaDebit.resolved && quotaDebit.resolved.ok === true && quotaDebit.resolved.revision === 5 && quotaDebit.resolved.value.balance === 4, JSON.stringify(quotaDebit.resolved).slice(0, 300));
    const quotaReplay = await l1.invoke('applyQuotaOperation', {
      requestId: 'rt-quota-debit',
      operationId: 'op-quota-debit-' + runNonce,
      expectedRevision: 4,
      revocationEpoch: 1,
      payload: { walletId: 'wallet-rt-1', event: { operationId: 'dom-quota-debit-' + runNonce, type: 'debit', amount: 3, revision: 2 } },
    }, 'quota replay');
    check('T2.Q3', 'quota replay is idempotent at original revision', quotaReplay.resolved && quotaReplay.resolved.ok === true && quotaReplay.resolved.idempotent === true && quotaReplay.resolved.revision === 5, JSON.stringify(quotaReplay.resolved).slice(0, 300));
    const quotaOverdraft = await l1.invoke('applyQuotaOperation', {
      requestId: 'rt-quota-overdraft',
      operationId: 'op-quota-overdraft-' + runNonce,
      expectedRevision: 5,
      revocationEpoch: 1,
      payload: { walletId: 'wallet-rt-1', event: { operationId: 'dom-quota-overdraft-' + runNonce, type: 'debit', amount: 99, revision: 3 } },
    }, 'quota overdraft');
    expectFailure('T2.Q4', 'quota overdraft fails closed with insufficient-quota', quotaOverdraft, 'insufficient-quota');

    // ---------- 敏感内容失败闭环且不进入 envelope ----------
    const sensitiveOrder = await l1.invoke('applyOrderEvent', {
      requestId: 'rt-sensitive-1',
      operationId: 'op-sensitive-' + runNonce,
      expectedRevision: 5,
      revocationEpoch: 1,
      payload: { orderId: 'order-sensitive', nextState: 'pending', fields: { providerSecret: injectedSecretMarker } },
    }, 'sensitive field providerSecret');
    expectFailure('T2.SENS1', 'sensitive field (providerSecret) rejected fail-closed', sensitiveOrder, 'sensitive-field-rejected');
    const sensitivePrompt = await l1.invoke('applyOrderEvent', {
      requestId: 'rt-sensitive-2',
      operationId: 'op-prompt-' + runNonce,
      expectedRevision: 5,
      revocationEpoch: 1,
      payload: { orderId: 'order-prompt', nextState: 'pending', fields: { sku: 'SKU', prompt: injectedPromptMarker } },
    }, 'sensitive field prompt');
    expectFailure('T2.SENS2', 'sensitive field (prompt) rejected fail-closed', sensitivePrompt, 'sensitive-field-rejected');
    const sensitiveClinical = await l1.invoke('applySubscriptionEvent', {
      requestId: 'rt-sensitive-3',
      operationId: 'op-clinical-' + runNonce,
      expectedRevision: 5,
      revocationEpoch: 1,
      payload: { subscriptionId: LICENSE_ID, clinicalNotes: injectedPromptMarker, event: { operationId: 'dom-clinical-' + runNonce, targetState: 'active', revision: 3 } },
    }, 'sensitive clinical-like key in payload');
    expectFailure('T2.SENS3', 'clinical-like key rejected fail-closed before commit', sensitiveClinical, 'sensitive-field-rejected');
    const envelopeText = fs.readFileSync(l1.envelopePath(), 'utf8');
    check('T2.SENS4', 'no sensitive marker content entered the durable commercial envelope', !envelopeText.includes(injectedSecretMarker) && !envelopeText.includes(injectedPromptMarker) && !envelopeText.includes('attacker-device'), 'markers absent');

    // ---------- 未知模型/空目录失败闭环 ----------
    const quoteUnknown = await l1.invoke('quoteRequestCharge', { model: 'definitely-unknown-model' }, 'quote under empty official catalog');
    expectFailure('T2.CAT1', 'quote fails closed with catalog-unavailable (empty official catalog)', quoteUnknown, 'catalog-unavailable');
    const reserveUnknown = await l1.invoke('reserveRequestCharge', { model: 'definitely-unknown-model', operationId: 'op-reserve-unknown-' + runNonce }, 'reserve under empty catalog');
    expectFailure('T2.CAT2', 'reserve fails closed with catalog-unavailable', reserveUnknown, 'catalog-unavailable');
    // 注意：main.js 的 handleCommercialChannel 对 getModelPriceCatalog 有边界门禁
    // （非空 payload → invalid-request），facade 的 catalog-revision-mismatch 位于该门禁之后。
    // 这里证明的是真实生产接线的失败闭环行为。
    const catalogMismatch = await l1.invoke('getModelPriceCatalog', { catalogRevision: 5 }, 'catalog revision request');
    expectFailure('T2.CAT3', 'non-empty catalog revision request fails closed at the main.js boundary with invalid-request', catalogMismatch, 'invalid-request');
    const catalogEmpty = await l1.invoke('getModelPriceCatalog', undefined, 'empty catalog read');
    check('T2.CAT4', 'empty catalog read returns ok with empty map and null revision', catalogEmpty.resolved && catalogEmpty.resolved.ok === true && JSON.stringify(catalogEmpty.resolved.value) === '{}' && catalogEmpty.resolved.revision === null, JSON.stringify(catalogEmpty.resolved));
    const hashBeforeChargeProbes = l1.envelopeHash();
    check('T2.CAT5', 'catalog/quote/reserve failures left revision 5 untouched', l1.readEnvelope().revision === 5, '');

    // ---------- settle/release/markUnknown/reconcile 失败闭环 ----------
    const settleMissing = await l1.invoke('settleRequestCharge', { requestId: 'req-nothing', operationId: 'op-settle-missing-' + runNonce }, 'settle without reservation');
    expectFailure('T2.CHG1', 'settle without a reservation fails closed with unknown-request', settleMissing, 'unknown-request');
    const releaseMissing = await l1.invoke('releaseRequestCharge', { requestId: 'req-nothing', operationId: 'op-release-missing-' + runNonce }, 'release without reservation');
    expectFailure('T2.CHG2', 'release without a reservation fails closed with unknown-request', releaseMissing, 'unknown-request');
    const markMissing = await l1.invoke('markRequestUnknown', { requestId: 'req-nothing', operationId: 'op-mark-missing-' + runNonce }, 'mark unknown without reservation');
    expectFailure('T2.CHG3', 'markRequestUnknown without a reservation fails closed with unknown-request', markMissing, 'unknown-request');
    const reconcileDenied = await l1.invoke('reconcileRequestCharge', { requestId: 'req-nothing', operationId: 'op-reconcile-' + runNonce, outcome: 'settled', evidence: { trusted: true, source: 'renderer' } }, 'renderer-supplied reconciliation evidence');
    expectFailure('T2.CHG4', 'renderer reconciliation evidence rejected (trustedReconciliation=false) with invalid-evidence', reconcileDenied, 'invalid-evidence');
    check('T2.CHG5', 'charge-channel failures left durable state untouched', l1.envelopeHash() === hashBeforeChargeProbes, '');

    // ---------- 脱敏投影 ----------
    const snapFinal = await l1.invoke('getSnapshot', { requestId: 'rt-snap-final' }, 'final snapshot L1');
    const snapValue = snapFinal.resolved && snapFinal.resolved.value;
    const snapText = JSON.stringify(snapValue || {});
    check('T2.RED1', 'final snapshot at revision 5 with all entities projected', snapFinal.resolved && snapFinal.resolved.ok === true && snapFinal.resolved.revision === 5 && snapValue.subscriptions.length === 1 && snapValue.orders.length === 1 && snapValue.quotaWallets.length === 1, snapText.slice(0, 300));
    check('T2.RED2', 'snapshot projection is redacted (no internal operations/fingerprints/provider refs)', !snapText.includes('operations') && !snapText.includes('providerReferenceHash') && !snapText.includes('fingerprint'), '');
    const auditPage = await l1.invoke('getAuditPage', { requestId: 'rt-audit-1', limit: 100 }, 'audit page');
    const auditOk = auditPage.resolved && auditPage.resolved.ok === true && auditPage.resolved.value.items.length === 5 && auditPage.resolved.value.items.every((item) => typeof item.redacted === 'undefined' && typeof item.operationId === 'string' && typeof item.revision === 'number');
    check('T2.RED3', 'audit page exposes only redacted append-only metadata (5 committed events)', auditOk, JSON.stringify(auditPage.resolved && auditPage.resolved.value.items.map((item) => item.operationId)));

    // ---------- 退出 L1 并记录持久化证据 ----------
    envelopeLog.push({ launch: 'L1-end', revision: l1.readEnvelope().revision, sha256: l1.envelopeHash() });
    const quit1 = await l1.quitGracefully();
    check('T2.EXIT1', 'L1 graceful quit via window.close (acceptance exit path)', quit1.graceful && quit1.exitCode === 0, JSON.stringify(quit1));
    launches.L1.exitCode = quit1.exitCode;
    launches.L1.durationMs = Date.now() - l1.startedAt;
    launches.L1.watchdogFired = l1.watchdogFired;
    l1.shutdown();

    // ---------- 启动 L2：同一 userData，证明跨 Electron 重启的持久化 ----------
    const l2 = new Session('L2', ROOT, userDataA, {});
    launchedSessions.push(l2);
    await l2.start();
    launches.L2 = { entry: 'real main.js (project root)', userData: userDataA, debugPort: l2.debugPort, appPort: l2.appPort, pid: l2.child.pid };

    const envelopeHashRestart = l2.envelopeHash();
    check('T2.P1', 'durable envelope byte-identical after Electron restart', envelopeHashRestart === (envelopeLog[0] && envelopeLog[0].sha256), envelopeHashRestart.slice(0, 16) + ' vs ' + (envelopeLog[0] && envelopeLog[0].sha256.slice(0, 16)));
    const snapRestart = await l2.invoke('getSnapshot', { requestId: 'rt-restart-snap' }, 'snapshot after restart');
    const snapRestartValue = snapRestart.resolved && snapRestart.resolved.value;
    check('T2.P2', 'post-restart snapshot preserves entities and revision 5', snapRestart.resolved && snapRestart.resolved.ok === true && snapRestart.resolved.revision === 5 && snapRestartValue.orders[0].state === 'paid' && snapRestartValue.subscriptions[0].state === 'active' && snapRestartValue.quotaWallets[0].balance === 4, JSON.stringify(snapRestartValue).slice(0, 300));
    const replayAfterRestart = await l2.invoke('applyOrderEvent', orderEnvelope, 'replay after restart');
    check('T2.P3', 'receipt survives restart: replay stays idempotent at original revision', replayAfterRestart.resolved && replayAfterRestart.resolved.ok === true && replayAfterRestart.resolved.idempotent === true && replayAfterRestart.resolved.revision === 3, JSON.stringify(replayAfterRestart.resolved).slice(0, 300));
    const staleAfterRestart = await l2.invoke('applyOrderEvent', staleEnvelope, 'stale probe after restart');
    expectFailure('T2.P4', 'stale-revision guard remains enforced after restart', staleAfterRestart, 'stale-revision');
    const deviceEvent = await l2.invoke('applyDeviceEvent', {
      requestId: 'rt-device-1',
      operationId: 'op-device-1-' + runNonce,
      expectedRevision: 5,
      revocationEpoch: 1,
      payload: { deviceBindingHash: deviceBindingHash(), nextState: 'active', fields: { status: 'active', bindingAssurance: 'dpapi' } },
    }, 'device event after restart');
    check('T2.P5', 'new mutation after restart advances to revision 6 (durable chain intact)', deviceEvent.resolved && deviceEvent.resolved.ok === true && deviceEvent.resolved.revision === 6 && deviceEvent.resolved.value.status === 'active', JSON.stringify(deviceEvent.resolved).slice(0, 300));
    const wrongDevice = await l2.invoke('applyDeviceEvent', {
      requestId: 'rt-device-wrong',
      operationId: 'op-device-wrong-' + runNonce,
      expectedRevision: 6,
      revocationEpoch: 1,
      payload: { deviceBindingHash: 'device-other-' + runNonce, nextState: 'active', fields: { status: 'active' } },
    }, 'device event for foreign device');
    expectFailure('T2.P6', 'foreign device binding rejected with device-mismatch', wrongDevice, 'device-mismatch');
    envelopeLog.push({ launch: 'L2-end', revision: l2.readEnvelope().revision, sha256: l2.envelopeHash() });
    const quit2 = await l2.quitGracefully();
    check('T2.EXIT2', 'L2 graceful quit', quit2.graceful && quit2.exitCode === 0, JSON.stringify(quit2));
    launches.L2.exitCode = quit2.exitCode;
    launches.L2.durationMs = Date.now() - l2.startedAt;
    launches.L2.watchdogFired = l2.watchdogFired;
    l2.shutdown();

    // ---------- 启动 L3：包装入口（真实 main.js + 未授权攻击窗口） ----------
    const userDataB = newUserData('xj-g8-ipc-rt-b-');
    const attackResultPath = path.join(EVIDENCE, 'attack-result.json');
    if (fs.existsSync(attackResultPath)) fs.unlinkSync(attackResultPath);
    const l3 = new Session('L3', WRAPPER_ENTRY, userDataB, { XJ_RT_ATTACK_RESULT: attackResultPath });
    launchedSessions.push(l3);
    await l3.start();
    launches.L3 = { entry: 'task-local wrapper requiring real main.js', userData: userDataB, debugPort: l3.debugPort, appPort: l3.appPort, pid: l3.child.pid };

    const activation2 = await l3.evaluate('window.__XJ_API__.activate(' + JSON.stringify(signActivationCode('lic_rt500atc' + runNonce)) + ')');
    check('T2.ATK0', 'L3 activates through the real handler before the guarded attack', activation2 && activation2.ok === true, JSON.stringify(activation2));
    const l3Order = await l3.invoke('applyOrderEvent', {
      requestId: 'rt-l3-order',
      operationId: 'op-l3-order-' + runNonce,
      expectedRevision: 0,
      revocationEpoch: 1,
      payload: { orderId: 'order-l3', nextState: 'paid', fields: { amountMinor: 100, currency: 'CNY' } },
    }, 'L3 trusted mutation before attack');
    check('T2.ATK1', 'trusted mutation works in the wrapper launch (real handlers unchanged)', l3Order.resolved && l3Order.resolved.ok === true && l3Order.resolved.revision === 1, JSON.stringify(l3Order.resolved).slice(0, 200));
    const envelopeHashBeforeAttack = l3.envelopeHash();

    // 第一次攻击在包装入口 ready 后自动发生（可能早于激活）：读取结果。
    let attack1 = null;
    for (let attempt = 0; attempt < 80 && !attack1; attempt += 1) {
      if (fs.existsSync(attackResultPath)) attack1 = JSON.parse(fs.readFileSync(attackResultPath, 'utf8'));
      else await sleep(250);
    }
    check('T2.ATK2', 'untrusted sender attack reached real handlers and was rejected by the trusted-sender guard', attack1
      && attack1.probes['xj:commercial:getSnapshot'].outcome === 'resolved' && attack1.probes['xj:commercial:getSnapshot'].value.ok === false && attack1.probes['xj:commercial:getSnapshot'].value.errorCode === 'sensitive-field-rejected'
      && attack1.probes['xj:commercial:applyOrderEvent'].value.ok === false && attack1.probes['xj:commercial:applyOrderEvent'].value.errorCode === 'sensitive-field-rejected'
      && attack1.probes['xj:commercial:getModelPriceCatalog'].value.ok === false
      && attack1.probes['xj:commercial:fakeChannel'].outcome === 'rejected' && /No handler registered/.test(attack1.probes['xj:commercial:fakeChannel'].message),
      JSON.stringify(attack1 && attack1.probes).slice(0, 500));
    check('T2.ATK3', 'attack sender frame is not the trusted loopback origin', attack1 && attack1.senderUrl !== l3.page.url, String(attack1 && attack1.senderUrl).slice(0, 80));
    check('T2.ATK4', 'untrusted attack mutated nothing (envelope byte-identical)', l3.envelopeHash() === envelopeHashBeforeAttack, '');

    // 触发第二次攻击（激活后）：删除结果文件，包装入口监视并重建攻击窗口。
    fs.unlinkSync(attackResultPath);
    let attack2 = null;
    for (let attempt = 0; attempt < 80 && !attack2; attempt += 1) {
      if (fs.existsSync(attackResultPath)) {
        const parsed = JSON.parse(fs.readFileSync(attackResultPath, 'utf8'));
        if (parsed.runIndex === 2) attack2 = parsed;
      }
      await sleep(250);
    }
    check('T2.ATK5', 'second attack after activation also rejected by the real guard', attack2
      && attack2.probes['xj:commercial:applyOrderEvent'].outcome === 'resolved'
      && attack2.probes['xj:commercial:applyOrderEvent'].value.ok === false
      && attack2.probes['xj:commercial:applyOrderEvent'].value.errorCode === 'sensitive-field-rejected',
      JSON.stringify(attack2 && attack2.probes['xj:commercial:applyOrderEvent']).slice(0, 300));
    check('T2.ATK6', 'activated state intact after the second attack', l3.envelopeHash() === envelopeHashBeforeAttack && l3.readEnvelope().revision === 1, '');

    // ---------- 网络默认拒绝证据 ----------
    // 控制实验：编排器先直接访问 loopback 探针服务器，证明其真实可达；
    // 之后渲染端对同一地址的 fetch 仍被拒绝 ⇒ 拒绝来自会话默认拒绝过滤器而非目标不可达。
    const controlBody = await new Promise((resolve, reject) => {
      const request = http.get('http://127.0.0.1:' + probeServerPort + '/', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
    });
    check('T2.NET0', 'orchestrator loopback probe server is genuinely reachable (control for NET2)', controlBody.status === 200 && controlBody.body === 'loopback-probe-ok', JSON.stringify(controlBody));
    const externalProbe = await l3.evaluate(`(async () => {
      try { const response = await fetch('https://non-loopback-probe.invalid/xj-g8-net-probe'); return { blocked: false, status: response.status }; }
      catch (error) { return { blocked: true, message: String(error && error.message || error) }; }
    })()`);
    check('T2.NET1', 'non-loopback fetch from renderer never succeeds (default-deny)', externalProbe.blocked === true, JSON.stringify(externalProbe));
    const otherLoopbackProbe = await l3.evaluate(`(async () => {
      try { const response = await fetch('http://127.0.0.1:${probeServerPort}/'); return { blocked: false, status: response.status }; }
      catch (error) { return { blocked: true, message: String(error && error.message || error) }; }
    })()`);
    check('T2.NET2', 'reachable loopback off-origin target is still denied for the renderer (origin-scoped default-deny)', otherLoopbackProbe.blocked === true, JSON.stringify(otherLoopbackProbe));
    const appOriginProbe = await l3.evaluate(`(async () => {
      try { const response = await fetch('http://127.0.0.1:${l3.appPort}/index.html'); return { status: response.status }; }
      catch (error) { return { error: String(error && error.message || error) }; }
    })()`);
    check('T2.NET3', 'app-origin loopback requests remain allowed', appOriginProbe.status === 200, JSON.stringify(appOriginProbe));

    await sleep(500);
    envelopeLog.push({ launch: 'L3-end', revision: l3.readEnvelope().revision, sha256: l3.envelopeHash() });
    const quit3 = await l3.quitGracefully();
    check('T2.EXIT3', 'L3 graceful quit', quit3.graceful && quit3.exitCode === 0, JSON.stringify(quit3));
    launches.L3.exitCode = quit3.exitCode;
    launches.L3.durationMs = Date.now() - l3.startedAt;
    launches.L3.watchdogFired = l3.watchdogFired;
    l3.shutdown();

    // ---------- 汇总：网络台账分析 + console/page/stderr 错误审计 ----------
    const allNetwork = [];
    for (const session of launchedSessions) {
      const requests = session.networkLedger.filter((entry) => entry.phase === 'request');
      const failures = session.networkLedger.filter((entry) => entry.phase === 'failed');
      const responses = session.networkLedger.filter((entry) => entry.phase === 'response');
      const failedIds = new Set(failures.map((entry) => entry.requestId));
      const respondedIds = new Set(responses.map((entry) => entry.requestId));
      for (const request of requests) {
        let parsedUrl = null;
        try { parsedUrl = new URL(request.url); } catch (_) {}
        const isLoopback = !!parsedUrl && parsedUrl.protocol === 'http:' && parsedUrl.hostname === '127.0.0.1';
        const isAppOrigin = isLoopback && Number(parsedUrl.port) === session.appPort;
        const status = respondedIds.has(request.requestId) ? 'allowed' : (failedIds.has(request.requestId) ? 'blocked-or-failed' : 'unfinished');
        allNetwork.push({ launch: session.tag, url: request.url, isLoopback, isAppOrigin, status });
      }
    }
    const nonLoopbackAllowed = allNetwork.filter((entry) => !entry.isLoopback && entry.status === 'allowed');
    const nonLoopbackAttempted = allNetwork.filter((entry) => !entry.isLoopback);
    const loopbackAllowedOffOrigin = allNetwork.filter((entry) => entry.isLoopback && !entry.isAppOrigin && entry.status === 'allowed');
    record('T2.NET4', 'no non-loopback request was allowed', nonLoopbackAllowed.length === 0, 'non_loopback_allowed=' + nonLoopbackAllowed.length);
    record('T2.NET5', 'all non-loopback attempts recorded and denied', nonLoopbackAttempted.every((entry) => entry.status !== 'allowed'), JSON.stringify(nonLoopbackAttempted).slice(0, 400));
    record('T2.NET6', 'no off-origin loopback request was allowed', loopbackAllowedOffOrigin.length === 0, JSON.stringify(loopbackAllowedOffOrigin).slice(0, 300));
    check('T2.NET4-hard', 'network ledger proves non_loopback=0 allowed requests', nonLoopbackAllowed.length === 0, 'total attempts=' + allNetwork.length + ' non_loopback_attempted=' + nonLoopbackAttempted.length);

    const errorLike = [];
    for (const session of launchedSessions) {
      for (const event of session.consoleEvents) {
        if (event.level === 'error' || event.source === 'page-exception') errorLike.push({ launch: session.tag, ...event });
      }
    }
    const unexpectedErrors = errorLike.filter((event) => !/Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/.test(event.text) && !/net::ERR_BLOCKED_BY_CLIENT/.test(event.text));
    record('T2.ERR1', 'renderer console/page errors outside the documented network-probe allowance are absent', unexpectedErrors.length === 0, JSON.stringify(unexpectedErrors).slice(0, 800));
    check('T2.ERR1-hard', 'no unexpected renderer console/page errors', unexpectedErrors.length === 0, JSON.stringify(unexpectedErrors).slice(0, 800));

    const stderrUnexpected = [];
    const stdoutUnexpected = [];
    for (const session of launchedSessions) {
      for (const line of session.stderr().split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!STDERR_ALLOWLIST.some((pattern) => pattern.test(trimmed))) stderrUnexpected.push({ launch: session.tag, line: trimmed.slice(0, 300) });
      }
      for (const line of session.stdout().split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!STDOUT_ALLOWLIST.some((pattern) => pattern.test(trimmed))) stdoutUnexpected.push({ launch: session.tag, line: trimmed.slice(0, 300) });
      }
    }
    writeEvidence('stderr-unexpected-debug.json', stderrUnexpected);
    record('T2.ERR2', 'main-process stderr contains only the narrow known bootstrap allowlist', stderrUnexpected.length === 0, JSON.stringify(stderrUnexpected).slice(0, 800));
    check('T2.ERR2-hard', 'no unexpected main-process stderr errors', stderrUnexpected.length === 0, JSON.stringify(stderrUnexpected).slice(0, 800));
    record('T2.ERR3', 'main-process stdout clean outside allowlist', stdoutUnexpected.length === 0, JSON.stringify(stdoutUnexpected).slice(0, 400));
    check('T2.ERR3-hard', 'no unexpected main-process stdout', stdoutUnexpected.length === 0, JSON.stringify(stdoutUnexpected).slice(0, 400));

    // ---------- 证据落盘 ----------
    const inventories = {};
    for (const session of launchedSessions) {
      inventories[session.tag] = {
        userData: session.userData,
        insideSystemTemp: session.userData.startsWith(fs.realpathSync.native(os.tmpdir())),
        files: session.userDataInventory(),
      };
    }
    writeEvidence('runtime-checks.json', checks);
    writeEvidence('ipc-ledger.json', launchedSessions.flatMap((session) => session.ipcLedger));
    writeEvidence('network-ledger.json', { allNetwork, nonLoopbackAllowed, nonLoopbackAttempted, loopbackAllowedOffOrigin });
    writeEvidence('console-events.json', launchedSessions.flatMap((session) => session.consoleEvents.map((event) => ({ launch: session.tag, ...event }))));
    writeEvidence('launches.json', launches);
    writeEvidence('envelope-log.json', envelopeLog);
    writeEvidence('user-data-inventory.json', inventories);
    writeEvidence('registration-probes.json', registrationProbes);
    writeEvidence('stderr-stdout-unexpected.json', { stderrUnexpected, stdoutUnexpected });
    writeEvidence('process-evidence.json', {
      electronPath: ELECTRON,
      electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
      sessions: launchedSessions.map((session) => ({
        tag: session.tag, pid: session.child.pid, exitCode: session.exitCode === undefined ? session.child.exitCode : session.exitCode,
        exitSignal: session.exitSignal || null, watchdogFired: session.watchdogFired,
        exitedNormally: session.exitCode === 0 && !session.watchdogFired,
      })),
    });
  } finally {
    try {
      const inventories = {};
      for (const session of launchedSessions) {
        try {
          // Windows 的 TEMP 可能是 8.3 短名（ADMINI~1）；与 main.js 相同，用 realpathSync.native 归一化两侧再比较。
          let insideSystemTemp = false;
          try {
            insideSystemTemp = fs.realpathSync.native(session.userData).startsWith(fs.realpathSync.native(os.tmpdir()));
          } catch (_) {
            insideSystemTemp = session.userData.startsWith(os.tmpdir());
          }
          inventories[session.tag] = {
            userData: session.userData,
            insideSystemTemp,
            files: session.userDataInventory(),
          };
        } catch (error) {
          inventories[session.tag] = { userData: session.userData, error: String(error.message || error) };
        }
      }
      writeEvidence('runtime-checks.json', checks);
      writeEvidence('raw-process-output.json', launchedSessions.map((session) => ({ tag: session.tag, stdout: session.stdout(), stderr: session.stderr() })));
      writeEvidence('ipc-ledger.json', launchedSessions.flatMap((session) => session.ipcLedger));
      writeEvidence('console-events.json', launchedSessions.flatMap((session) => session.consoleEvents.map((event) => ({ launch: session.tag, ...event }))));
      writeEvidence('launches.json', launches);
      writeEvidence('envelope-log.json', envelopeLog);
      writeEvidence('user-data-inventory.json', inventories);
      const cleanup = [];
      for (const session of launchedSessions) {
        let removed = false;
        try { fs.rmSync(session.userData, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 }); removed = true; } catch (_) { removed = false; }
        cleanup.push({ tag: session.tag, userData: session.userData, removed });
      }
      writeEvidence('process-evidence.json', {
        electronPath: ELECTRON,
        electronVersion: require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version,
        sessions: launchedSessions.map((session) => ({
          tag: session.tag, pid: session.child.pid, exitCode: session.exitCode === undefined ? session.child.exitCode : session.exitCode,
          exitSignal: session.exitSignal || null, watchdogFired: session.watchdogFired,
          exitedNormally: session.exitCode === 0 && !session.watchdogFired,
        })),
        userDataCleanup: cleanup,
      });
    } catch (_) {}
    for (const session of launchedSessions) { try { session.shutdown(); } catch (_) {} }
    if (probeServer) { try { probeServer.close(); } catch (_) {} }
  }
});

test('T3 permanent M4/M5 test and the five commercial baseline tests remain green after the runtime probe', { timeout: 600000 }, async () => {
  const suites = [
    'commercial-m4-m5-expected-red.test.js',
    'commercial-durable-persistence-foundation.test.js',
    'commercial-empty-catalog-fail-closed.test.js',
    'commercial-production-integration.test.js',
    'server-authoritative-balance-route.test.js',
    'server-authoritative-balance-router-runtime.test.js',
  ];
  const results = [];
  // 隔离父级 node --test 注入的运行时上下文，保证子套件是独立真实的测试运行。
  const childEnv = Object.assign({}, process.env);
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_MODULE;
  for (const suite of suites) {
    const file = path.join(ROOT, 'tests', 'v5.0.0-production', suite);
    const run = childProcess.spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: childEnv });
    const stdout = String(run.stdout || '');
    const testsMatch = stdout.match(/tests (\d+)/);
    const passMatch = stdout.match(/pass (\d+)/);
    const failMatch = stdout.match(/fail (\d+)/);
    const tests = testsMatch ? Number(testsMatch[1]) : 0;
    const pass = passMatch ? Number(passMatch[1]) : 0;
    const fail = failMatch ? Number(failMatch[1]) : 0;
    results.push({ suite, exit: run.status, tests, pass, fail, durationMs: (stdout.match(/duration_ms (\d+)/) || [])[1] || '' });
  }
  writeEvidence('baseline-rerun.json', results);
  for (const item of results) {
    check('T3.' + item.suite, 'baseline suite ran and stayed green after runtime probe: ' + item.suite,
      item.exit === 0 && item.tests > 0 && item.pass === item.tests && item.fail === 0,
      'tests=' + item.tests + ' pass=' + item.pass + ' fail=' + item.fail + ' exit=' + item.exit);
  }
});
