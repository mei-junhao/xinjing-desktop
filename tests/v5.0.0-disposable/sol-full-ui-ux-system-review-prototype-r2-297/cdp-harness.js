'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join('D:/xinjing-electron/node_modules/ws'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' })[ext] || 'application/octet-stream';
}
function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const raw = decodeURIComponent((request.url || '/').split('?')[0]);
      const relative = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
      const file = path.resolve(root, relative);
      if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(response);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForVersion(port) {
  let last;
  for (let i = 0; i < 80; i += 1) {
    try { return await fetchJson(`http://127.0.0.1:${port}/json/version`); }
    catch (error) { last = error; await delay(100); }
  }
  throw last || new Error('Edge remote debugging did not start');
}
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && this.pending.has(message.id)) {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else item.resolve(message.result || {});
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.ws.send(JSON.stringify(message));
    });
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.ws.close(); }
}
async function launch(options) {
  const debugPort = options.debugPort;
  const profile = options.profile;
  fs.mkdirSync(profile, { recursive: true });
  const browser = childProcess.spawn(EDGE, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter', '--no-proxy-server',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  browser.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const version = await waitForVersion(debugPort);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const cdp = new Cdp(ws);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  return {
    browser, cdp, sessionId, stderr: () => stderr,
    async close() {
      try { await cdp.send('Browser.close'); } catch (_) { browser.kill(); }
      await delay(100);
      if (!browser.killed) browser.kill();
      cdp.close();
    },
  };
}
async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  return result.result ? result.result.value : undefined;
}
async function waitReady(cdp, sessionId) {
  for (let i = 0; i < 80; i += 1) {
    const ready = await evaluate(cdp, sessionId, 'document.readyState');
    if (ready === 'complete') { await delay(80); return; }
    await delay(50);
  }
  throw new Error('Page load timeout');
}
async function setViewport(cdp, sessionId, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
}
async function navigate(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitReady(cdp, sessionId);
}
async function screenshot(cdp, sessionId, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
}
async function snapshot(cdp, sessionId, file) {
  const html = await evaluate(cdp, sessionId, 'document.documentElement.outerHTML');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html + '\n', 'utf8');
}
async function metrics(cdp, sessionId) {
  return evaluate(cdp, sessionId, `(() => {
    const visible = (el) => { const s=getComputedStyle(el), r=el.getBoundingClientRect(); return s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0; };
    const boxes = [...document.querySelectorAll('.panel,.metric-row,.page-header')].filter(visible).map((el) => { const r=el.getBoundingClientRect(); return {tag:el.tagName, cls:el.className, left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height}; });
    const overlap = [];
    for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) { const a=boxes[i],b=boxes[j]; const area=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); if(area>4 && !(a.left<=b.left&&a.right>=b.right&&a.top<=b.top&&a.bottom>=b.bottom) && !(b.left<=a.left&&b.right>=a.right&&b.top<=a.top&&b.bottom>=a.bottom)) overlap.push([i,j,area]); }
    const clipped = [...document.querySelectorAll('button,input,select,textarea,h1,h2,h3,p')].filter(visible).filter((el) => { const r=el.getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 1 || r.left < -1; }).length;
    return {
      title: document.title,
      route: window.XJ_PROTOTYPE && window.XJ_PROTOTYPE.state.route,
      bodyTextLength: (document.body.innerText || '').trim().length,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      overlapCount: overlap.length,
      clippedCount: clipped,
      blankCanvas: (document.body.innerText || '').trim().length < 40 || !document.querySelector('main'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      focusVisibleCss: [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => String(rule.cssText).includes(':focus-visible')); } catch (_) { return false; } }),
      activeElement: document.activeElement && document.activeElement.tagName,
    };
  })()`);
}
async function click(cdp, sessionId, selector) {
  return evaluate(cdp, sessionId, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.click(); return true; })()`);
}
async function typeValue(cdp, sessionId, selector, value) {
  return evaluate(cdp, sessionId, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.focus(); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
}
module.exports = { delay, startStaticServer, launch, evaluate, setViewport, navigate, screenshot, snapshot, metrics, click, typeValue };
