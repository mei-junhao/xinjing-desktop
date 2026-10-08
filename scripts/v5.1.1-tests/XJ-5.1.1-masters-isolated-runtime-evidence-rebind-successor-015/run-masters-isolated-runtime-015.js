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

const ROOT = path.resolve(__dirname, '../../..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_ROOT = path.join(ROOT, 'app');
const EVIDENCE_ROOT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-isolated-runtime-evidence-rebind-successor-015');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const RUN_ROOT = path.join(EVIDENCE_ROOT, 'runtime', RUN_ID);
const SCRIPT_PATH = path.resolve(__filename);
const FORBIDDEN_TOKEN = ['0', '1', '1'].join('');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeBuffer(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const port = 9510 + Math.floor(Math.random() * 420);
    if (await portAvailable(port)) return port;
  }
  throw new Error('no free CDP port');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method) {
        const handlers = this.listeners.get(message.method) || [];
        handlers.forEach((handler) => handler(message.params || {}));
      }
    });
    return this;
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  close() { try { this.ws.close(); } catch (_) {} }
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson('http://127.0.0.1:' + port + '/json/list');
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('CDP page target did not appear');
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
    throw new Error((details.exception && details.exception.description) || details.text || 'renderer evaluation failed');
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression, true)) return true;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

function normalizeGrid(value) {
  return String(value || '')
    .replace(/0px/g, '0')
    .replace(/minmax\(0px, 1fr\)/g, 'minmax(0, 1fr)')
    .replace(/\s+/g, ' ')
    .trim();
}

function gridNumbers(value) {
  return String(value || '').split(/\s+/).map((item) => Number.parseFloat(item)).filter((item) => Number.isFinite(item));
}

function gridTrackMatches(value, first, last) {
  const parts = gridNumbers(value);
  return parts.length === 3 && Math.abs(parts[0] - first) < 1 && Math.abs(parts[2] - last) < 1;
}

async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(120);
}

async function screenshot(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bytes = Buffer.from(result.data || '', 'base64');
  if (bytes.length < 1024) throw new Error('screenshot too small: ' + bytes.length);
  writeBuffer(file, bytes);
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

async function probeLayout(cdp, stage) {
  const data = await evaluate(cdp, `(() => {
    const workspace = document.querySelector('.masters-workspace');
    const dialogue = document.getElementById('chat-panel');
    const leftPanel = document.getElementById('master-source-panel');
    const rightPanel = document.getElementById('master-inspector-panel');
    const leftButton = document.getElementById('masters-collapse-left');
    const rightButton = document.getElementById('masters-collapse-right');
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const hit = (el) => {
      const r = rect(el);
      if (!r || r.width <= 0 || r.height <= 0) return null;
      const node = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return node ? { tag: node.tagName, id: node.id || '', className: String(node.className || '') } : null;
    };
    const grid = workspace ? getComputedStyle(workspace).gridTemplateColumns : '';
    const authorRules = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          if (rule.selectorText && (rule.selectorText === '.masters-workspace' || rule.selectorText.indexOf('masters-left-collapsed') >= 0 || rule.selectorText.indexOf('masters-right-collapsed') >= 0)) {
            authorRules.push({ selector: rule.selectorText, gridTemplateColumns: rule.style && rule.style.gridTemplateColumns || '' });
          }
        }
      } catch (_) {}
    }
    return {
      stage: ${JSON.stringify(stage)},
      grid,
      authorRules,
      normalizedGrid: String(grid).replace(/0px/g, '0').replace(/minmax\\(0px, 1fr\\)/g, 'minmax(0, 1fr)').replace(/\\s+/g, ' ').trim(),
      dialogue: rect(dialogue),
      leftPanel: rect(leftPanel),
      rightPanel: rect(rightPanel),
      leftPanelClass: leftPanel ? leftPanel.className : '',
      rightPanelClass: rightPanel ? rightPanel.className : '',
      bodyClass: document.body.className,
      left: { expanded: leftButton && leftButton.getAttribute('aria-expanded'), label: leftButton && leftButton.getAttribute('aria-label'), hit: hit(leftButton) },
      right: { expanded: rightButton && rightButton.getAttribute('aria-expanded'), label: rightButton && rightButton.getAttribute('aria-label'), hit: hit(rightButton) },
      activeElement: document.activeElement ? { id: document.activeElement.id || '', tag: document.activeElement.tagName } : null,
    };
  })()`);
  return data;
}

async function clickButton(cdp, selector, clickLog) {
  const info = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const node = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      target: node ? { tag: node.tagName, id: node.id || '', className: String(node.className || '') } : null,
      disabled: !!el.disabled,
      hidden: getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden',
      text: String(el.textContent || '').trim(),
    };
  })()`);
  if (!info) throw new Error('missing clickable selector: ' + selector);
  if (info.disabled || info.hidden || !info.rect || info.rect.width <= 0 || info.rect.height <= 0) throw new Error('not clickable: ' + selector);
  const x = info.rect.left + info.rect.width / 2;
  const y = info.rect.top + info.rect.height / 2;
  clickLog.push({ selector, x, y, target: info.target, text: info.text, at: now() });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(120);
  return info;
}

async function dispatchEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(120);
}

async function injectRoundtable(cdp) {
  return evaluate(cdp, `(() => {
    const body = document.getElementById('chat-body');
    if (!body) return { ok: false, reason: 'chat-body-missing' };
    const names = ['温尼科特', '欧文·亚隆', '卡尔·罗杰斯'];
    const longText = '合成圆桌消息：这是用于窄窗纵向排列、长中文换行、低动效与焦点验收的内容。'.repeat(8);
    body.innerHTML = '';
    names.concat(names).forEach((name, index) => {
      const row = document.createElement('div');
      row.className = 'msg ai';
      row.dataset.syntheticRound = String(index + 1);
      row.innerHTML = '<div class="av" style="background:#5d8c83">师</div><div class="body"><div class="sender"></div><div class="bubble"></div></div>';
      row.querySelector('.sender').textContent = name + ' · 第' + (index < 3 ? '一' : '二') + '轮';
      row.querySelector('.bubble').textContent = longText;
      body.appendChild(row);
    });
    return { ok: true, count: body.querySelectorAll('.msg').length };
  })()`);
}

async function probeRoundtable(cdp) {
  return evaluate(cdp, `(() => {
    const body = document.getElementById('chat-body');
    const rows = Array.from(document.querySelectorAll('#chat-body .msg'));
    const tops = rows.map((row) => row.getBoundingClientRect().top);
    const bubbles = rows.map((row) => { const b = row.querySelector('.bubble'); return b ? { scrollWidth: b.scrollWidth, clientWidth: b.clientWidth } : null; });
    return {
      count: rows.length,
      tops,
      strictVertical: tops.length === 6 && tops.every((top, index) => index === 0 || top > tops[index - 1]),
      bodyOverflowX: body ? body.scrollWidth > body.clientWidth + 1 : true,
      bubbleOverflow: bubbles.some((item) => !item || item.scrollWidth > item.clientWidth + 1),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      bodyClientWidth: body ? body.clientWidth : 0,
      bodyScrollWidth: body ? body.scrollWidth : 0,
      bubbles,
    };
  })()`);
}

function expectedGrid(track) {
  return normalizeGrid(track);
}

function check(condition, label, details, checks) {
  const item = { label, pass: !!condition, details: details || null };
  checks.push(item);
  return item.pass;
}

async function createSession(label, sourceApp) {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron launcher missing: ' + ELECTRON);
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-masters-015-'));
  const port = await choosePort();
  const args = [
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--user-data-dir=' + tempUserData,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
    ROOT,
  ];
  const proc = cp.spawn(ELECTRON, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      XJ_AGENT_ACCEPTANCE: '1',
      XJ_AGENT_ACCEPTANCE_USER_DATA: tempUserData,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await findPageTarget(port);
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
  const pageErrors = [];
  const consoleErrors = [];
  const requestLog = [];
  cdp.on('Runtime.exceptionThrown', (event) => pageErrors.push(event.exceptionDetails || {}));
  cdp.on('Runtime.consoleAPICalled', (event) => {
    const level = event.type || 'log';
    if (level === 'error' || level === 'assert') consoleErrors.push({ level, values: (event.args || []).map((arg) => arg.value !== undefined ? arg.value : arg.description) });
  });
  cdp.on('Log.entryAdded', (event) => {
    if (event.entry && event.entry.level === 'error') consoleErrors.push({ level: 'log', values: [event.entry.text] });
  });
  cdp.on('Network.requestWillBeSent', (event) => requestLog.push({ url: event.request.url, type: event.type, documentURL: event.documentURL }));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const pagePath = path.join(sourceApp || APP_ROOT, 'masters.html');
  await cdp.send('Page.navigate', { url: pathToFileURL(pagePath).href });
  await waitFor(cdp, "document.readyState === 'complete' && !!document.querySelector('.masters-workspace') && typeof window.toggleMasterPanel === 'function'", label + ' masters page');
  await sleep(250);
  return {
    label,
    proc,
    cdp,
    tempUserData,
    port,
    args,
    sourceApp: sourceApp || APP_ROOT,
    stdout: () => stdout,
    stderr: () => stderr,
    pageErrors,
    consoleErrors,
    requestLog,
    async close() {
      try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
      try { cdp.close(); } catch (_) {}
      try { proc.kill(); } catch (_) {}
      await sleep(200);
      try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

async function runFoldCase(caseName, runRoot) {
  const session = await createSession(caseName, APP_ROOT);
  const checks = [];
  const clickLog = [];
  const record = { caseName, viewport: VIEWPORTS[0], checks, clickLog, screenshots: [], requestLog: session.requestLog, pageErrors: session.pageErrors, consoleErrors: session.consoleErrors, command: [ELECTRON].concat(session.args), startedAt: now() };
  try {
    await setViewport(session.cdp, VIEWPORTS[0]);
    const initial = await probeLayout(session.cdp, 'initial');
    record.initial = initial;
    record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-initial.png')));
    check(gridTrackMatches(initial.grid, 244, 300), 'initial grid track', { resolved: initial.grid, authorRules: initial.authorRules }, checks);
    check(initial.dialogue && initial.dialogue.width > 0, 'initial dialogue visible', initial.dialogue, checks);

    if (caseName === 'left-fold-1024') {
      await clickButton(session.cdp, '#masters-collapse-left', clickLog);
      const folded = await probeLayout(session.cdp, 'left-folded');
      record.folded = folded;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-folded.png')));
      check(gridTrackMatches(folded.grid, 0, 300), 'left folded grid track', { resolved: folded.grid, authorRules: folded.authorRules }, checks);
      check(folded.dialogue.width > initial.dialogue.width + 10, 'left fold expands dialogue', { before: initial.dialogue.width, after: folded.dialogue.width }, checks);
      check(folded.left.expanded === 'false', 'left aria collapsed', folded.left, checks);
      check(folded.activeElement && folded.activeElement.id === 'masters-collapse-left', 'left focus retained', folded.activeElement, checks);
      await clickButton(session.cdp, '#masters-collapse-left', clickLog);
      const restored = await probeLayout(session.cdp, 'left-restored');
      record.restored = restored;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-restored.png')));
      check(gridTrackMatches(restored.grid, 244, 300), 'left restored grid track', { resolved: restored.grid, authorRules: restored.authorRules }, checks);
      check(restored.dialogue.width === initial.dialogue.width, 'left restore dialogue width', { before: initial.dialogue.width, after: restored.dialogue.width }, checks);
      check(restored.left.expanded === 'true', 'left aria restored', restored.left, checks);
    } else if (caseName === 'right-fold-1024') {
      await clickButton(session.cdp, '#masters-collapse-right', clickLog);
      const folded = await probeLayout(session.cdp, 'right-folded');
      record.folded = folded;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-folded.png')));
      check(gridTrackMatches(folded.grid, 244, 0), 'right folded grid track', { resolved: folded.grid, authorRules: folded.authorRules }, checks);
      check(folded.dialogue.width > initial.dialogue.width + 10, 'right fold expands dialogue', { before: initial.dialogue.width, after: folded.dialogue.width }, checks);
      check(folded.right.expanded === 'false', 'right aria collapsed', folded.right, checks);
      check(folded.activeElement && folded.activeElement.id === 'masters-collapse-right', 'right focus retained', folded.activeElement, checks);
      await clickButton(session.cdp, '#masters-collapse-right', clickLog);
      const restored = await probeLayout(session.cdp, 'right-restored');
      record.restored = restored;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-restored.png')));
      check(gridTrackMatches(restored.grid, 244, 300), 'right restored grid track', { resolved: restored.grid, authorRules: restored.authorRules }, checks);
      check(restored.dialogue.width === initial.dialogue.width, 'right restore dialogue width', { before: initial.dialogue.width, after: restored.dialogue.width }, checks);
      check(restored.right.expanded === 'true', 'right aria restored', restored.right, checks);
    } else {
      await clickButton(session.cdp, '#masters-collapse-left', clickLog);
      await clickButton(session.cdp, '#masters-collapse-right', clickLog);
      const folded = await probeLayout(session.cdp, 'both-folded');
      record.folded = folded;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-folded.png')));
      check(gridTrackMatches(folded.grid, 0, 0), 'both folded grid track', { resolved: folded.grid, authorRules: folded.authorRules }, checks);
      check(folded.dialogue.width > initial.dialogue.width + 10, 'both fold expands dialogue', { before: initial.dialogue.width, after: folded.dialogue.width }, checks);
      check(folded.left.expanded === 'false' && folded.right.expanded === 'false', 'both aria collapsed', { left: folded.left, right: folded.right }, checks);
      await clickButton(session.cdp, '#masters-collapse-right', clickLog);
      await clickButton(session.cdp, '#masters-collapse-left', clickLog);
      const restored = await probeLayout(session.cdp, 'both-restored');
      record.restored = restored;
      record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-restored.png')));
      check(gridTrackMatches(restored.grid, 244, 300), 'both restored grid track', { resolved: restored.grid, authorRules: restored.authorRules }, checks);
      check(restored.left.expanded === 'true' && restored.right.expanded === 'true', 'both aria restored', { left: restored.left, right: restored.right }, checks);
    }
    record.status = checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
  } catch (error) {
    record.status = 'ERROR';
    record.error = { message: error.message, stack: error.stack };
  } finally {
    record.finishedAt = now();
    await session.close();
    record.stdoutFile = path.join(runRoot, caseName + '-electron.stdout.txt');
    record.stderrFile = path.join(runRoot, caseName + '-electron.stderr.txt');
    writeText(record.stdoutFile, session.stdout());
    writeText(record.stderrFile, session.stderr());
    writeJson(path.join(runRoot, caseName + '.json'), record);
  }
  return record;
}

async function runViewportCase(viewport, runRoot) {
  const caseName = 'roundtable-' + viewport.name;
  const session = await createSession(caseName, APP_ROOT);
  const checks = [];
  const clickLog = [];
  const record = { caseName, viewport, checks, clickLog, screenshots: [], requestLog: session.requestLog, pageErrors: session.pageErrors, consoleErrors: session.consoleErrors, command: [ELECTRON].concat(session.args), startedAt: now() };
  try {
    await setViewport(session.cdp, viewport);
    const initial = await probeLayout(session.cdp, 'viewport-initial');
    record.initial = initial;
    record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-initial.png')));
    const injected = await injectRoundtable(session.cdp);
    record.injected = injected;
    const roundtable = await probeRoundtable(session.cdp);
    record.roundtable = roundtable;
    record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-roundtable.png')));
    check(injected && injected.ok && injected.count === 6, 'synthetic roundtable has six messages', injected, checks);
    check(roundtable.strictVertical, 'roundtable strict vertical order', roundtable.tops, checks);
    check(!roundtable.bodyOverflowX && !roundtable.bubbleOverflow, 'long Chinese has no horizontal overflow', roundtable, checks);
    check(roundtable.reducedMotion === true, 'reduced motion active', roundtable.reducedMotion, checks);
    await clickButton(session.cdp, '#masters-collapse-left', clickLog);
    const folded = await probeLayout(session.cdp, 'viewport-left-folded');
    record.folded = folded;
    record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-folded.png')));
    check(folded.dialogue.width > initial.dialogue.width + 10, 'viewport fold expands dialogue', { before: initial.dialogue.width, after: folded.dialogue.width }, checks);
    check(folded.activeElement && folded.activeElement.id === 'masters-collapse-left', 'keyboard focus lands on fold control', folded.activeElement, checks);
    await dispatchEscape(session.cdp);
    const escaped = await probeLayout(session.cdp, 'after-escape');
    record.escaped = escaped;
    record.screenshots.push(await screenshot(session.cdp, path.join(runRoot, caseName + '-after-escape.png')));
    check(gridTrackMatches(escaped.grid, gridNumbers(initial.grid)[0], gridNumbers(initial.grid)[2]), 'Escape restores initial grid', { before: initial.grid, after: escaped.grid }, checks);
    check(escaped.left.expanded === 'true', 'Escape restores aria state', escaped.left, checks);
    record.status = checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
  } catch (error) {
    record.status = 'ERROR';
    record.error = { message: error.message, stack: error.stack };
  } finally {
    record.finishedAt = now();
    await session.close();
    record.stdoutFile = path.join(runRoot, caseName + '-electron.stdout.txt');
    record.stderrFile = path.join(runRoot, caseName + '-electron.stderr.txt');
    writeText(record.stdoutFile, session.stdout());
    writeText(record.stderrFile, session.stderr());
    writeJson(path.join(runRoot, caseName + '.json'), record);
  }
  return record;
}

function makeSelfCheck() {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const command = process.execPath + ' ' + process.argv.map((value) => JSON.stringify(value)).join(' ');
  return {
    at: now(),
    cwd: process.cwd(),
    sourcePath: SCRIPT_PATH,
    sourceBytes: Buffer.byteLength(source, 'utf8'),
    sourceSha256: sha256(source),
    command,
    sourceContainsForbiddenToken: source.includes(FORBIDDEN_TOKEN),
    commandContainsForbiddenToken: command.includes(FORBIDDEN_TOKEN),
    pass: !source.includes(FORBIDDEN_TOKEN) && !command.includes(FORBIDDEN_TOKEN),
  };
}

async function main() {
  ensureDir(RUN_ROOT);
  const selfCheck = makeSelfCheck();
  writeText(path.join(RUN_ROOT, 'runner-self-check.raw.txt'), [
    'cwd=' + selfCheck.cwd,
    'source=' + selfCheck.sourcePath,
    'sourceBytes=' + selfCheck.sourceBytes,
    'sourceSha256=' + selfCheck.sourceSha256,
    'command=' + selfCheck.command,
    'sourceContainsForbiddenToken=' + selfCheck.sourceContainsForbiddenToken,
    'commandContainsForbiddenToken=' + selfCheck.commandContainsForbiddenToken,
    'pass=' + selfCheck.pass,
    '',
  ].join('\n'));
  if (!selfCheck.pass) throw new Error('runner or command line contains forbidden token');

  const results = [];
  results.push(await runFoldCase('left-fold-1024', RUN_ROOT));
  results.push(await runFoldCase('right-fold-1024', RUN_ROOT));
  results.push(await runFoldCase('both-fold-1024', RUN_ROOT));
  results.push(await runViewportCase(VIEWPORTS[1], RUN_ROOT));
  results.push(await runViewportCase(VIEWPORTS[2], RUN_ROOT));

  const productionHashes = {};
  for (const file of ['app/masters.html', 'app/js/masters.js', 'app/css/masters-clinical.css']) {
    const full = path.join(ROOT, file);
    const bytes = fs.readFileSync(full);
    productionHashes[file] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const summary = {
    taskId: 'XJ-5.1.1-masters-isolated-runtime-evidence-rebind-successor-015',
    runId: RUN_ID,
    startedAt: selfCheck.at,
    finishedAt: now(),
    selfCheck,
    networkPolicy: {
      hostResolverRules: 'MAP all hosts to 0.0.0.0 except loopback',
      cdpBlockedUrls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      userData: 'fresh temporary userData per process',
    },
    productionHashes,
    results,
    status: results.every((item) => item.status === 'PASS') ? 'PASS' : 'BLOCKED',
    next: 'A production baseline failure requires Codex review before any CSS decision.',
  };
  writeJson(path.join(RUN_ROOT, 'summary.json'), summary);
  console.log(JSON.stringify({ status: summary.status, runRoot: RUN_ROOT, productionHashes, cases: results.map((item) => ({ caseName: item.caseName, status: item.status, failedChecks: item.checks.filter((checkItem) => !checkItem.pass).map((checkItem) => checkItem.label) })) }, null, 2));
  process.exitCode = summary.status === 'PASS' ? 0 : 2;
}

main().catch((error) => {
  const fatal = { status: 'BLOCKED', error: { message: error.message, stack: error.stack }, runRoot: RUN_ROOT };
  ensureDir(RUN_ROOT);
  writeJson(path.join(RUN_ROOT, 'fatal.json'), fatal);
  console.error(JSON.stringify(fatal, null, 2));
  process.exitCode = 2;
});
