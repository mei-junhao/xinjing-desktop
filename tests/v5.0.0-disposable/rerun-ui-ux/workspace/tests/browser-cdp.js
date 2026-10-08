'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findEdge() {
  return EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CDP_HTTP_${response.status}`);
  return response.json();
}

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await getJson(url); } catch (error) { lastError = error; await sleep(100); }
  }
  const error = new Error(`CDP_ENDPOINT_TIMEOUT: ${lastError ? lastError.message : 'unknown'}`);
  error.code = 'BROWSER_UNAVAILABLE';
  throw error;
}

class CdpConnection {
  constructor(url) {
    if (typeof WebSocket !== 'function') {
      const error = new Error('NODE_WEBSOCKET_UNAVAILABLE');
      error.code = 'BROWSER_UNAVAILABLE';
      throw error;
    }
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', reject);
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.code}:${message.error.message}`));
        else resolve(message.result);
        return;
      }
      if (message.method && this.events.has(message.method)) {
        this.events.get(message.method).forEach((listener) => listener(message.params || {}));
      }
    });
  }

  on(method, listener) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(listener);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

class EdgePage {
  constructor(process, profileDir, connection) {
    this.process = process;
    this.profileDir = profileDir;
    this.connection = connection;
    this.consoleErrors = [];
    connection.on('Runtime.exceptionThrown', (params) => {
      this.consoleErrors.push({ type: 'exception', text: params.exceptionDetails && params.exceptionDetails.text });
    });
    connection.on('Runtime.consoleAPICalled', (params) => {
      if (['error', 'assert'].includes(params.type)) this.consoleErrors.push({ type: params.type, text: params.args && params.args.map((arg) => arg.value).join(' ') });
    });
  }

  async initialize() {
    await this.connection.send('Page.enable');
    await this.connection.send('Runtime.enable');
    await this.connection.send('Log.enable');
    this.connection.on('Log.entryAdded', (params) => {
      if (['error', 'assert'].includes(params.entry.level)) this.consoleErrors.push({ type: 'log', text: params.entry.text });
    });
    return this;
  }

  async setViewport(width, height) {
    await this.connection.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
    });
  }

  async navigate(url) {
    await this.connection.send('Page.navigate', { url });
    await this.waitForReady();
  }

  async waitForReady() {
    for (let i = 0; i < 80; i += 1) {
      try {
        const state = await this.evaluate('document.readyState');
        if (state === 'complete' || state === 'interactive') { await sleep(80); return; }
      } catch {}
      await sleep(80);
    }
    throw new Error('PAGE_READY_TIMEOUT');
  }

  async evaluate(expression) {
    const result = await this.connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'RUNTIME_EVALUATION_FAILED');
    return result.result ? result.result.value : undefined;
  }

  async click(selector) {
    return this.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
  }

  async press(key) {
    const codeMap = { Tab: 'Tab', Escape: 'Escape', Enter: 'Enter' };
    const code = codeMap[key] || key;
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'Tab' ? 9 : undefined });
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'Tab' ? 9 : undefined });
  }

  async screenshot() {
    const result = await this.connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(result.data, 'base64');
  }

  drainConsole() {
    const errors = this.consoleErrors.slice();
    this.consoleErrors.length = 0;
    return errors;
  }

  async close() {
    this.connection.close();
    try { this.process.kill(); } catch {}
    await sleep(250);
    try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch {}
  }
}

async function launchEdge() {
  const edge = findEdge();
  if (!edge) {
    const error = new Error('REAL_BROWSER_UNAVAILABLE: Microsoft Edge executable not found');
    error.code = 'BROWSER_UNAVAILABLE';
    throw error;
  }
  const port = await getFreePort();
  const profileDir = path.join(os.tmpdir(), `xj-task-391-edge-${process.pid}-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const pageInfo = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
    if (!pageInfo) throw new Error('CDP_PAGE_TARGET_MISSING');
    const connection = new CdpConnection(pageInfo.webSocketDebuggerUrl);
    const page = await new EdgePage(child, profileDir, connection).initialize();
    page.browserInfo = { executable: edge, port, stderr: stderr.trim() };
    return page;
  } catch (error) {
    try { child.kill(); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    error.code = error.code || 'BROWSER_UNAVAILABLE';
    error.message = `${error.message}${stderr ? `; stderr=${stderr.trim()}` : ''}`;
    throw error;
  }
}

module.exports = { launchEdge, findEdge };
