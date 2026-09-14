'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require(path.join(process.cwd(), 'node_modules', 'ws'));

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-narrow-viewport-fold-runtime-stability-rework-013');
const RAW = path.join(OUT, 'diagnose-raw');
const RESULT = path.join(OUT, 'diagnose-013.json');
fs.mkdirSync(RAW, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
function discover(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.setTimeout(1500, () => req.destroy(new Error('CDP discovery timeout')));
    req.on('error', reject);
  });
}
async function pageFor(port) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const pages = await discover(port);
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('CDP page unavailable');
}
class Cdp {
  constructor(page) {
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.next = 0;
    this.pending = new Map();
    this.ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
    });
    this.ws.on('error', error => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then(result => {
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      return result.result && result.result.value;
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-masters-013-diagnose-'));
  const port = 9550 + Math.floor(Math.random() * 250);
  const stdoutPath = path.join(RAW, 'electron-' + port + '.stdout.log');
  const stderrPath = path.join(RAW, 'electron-' + port + '.stderr.log');
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const args = [
    '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData, ROOT,
  ];
  const child = spawn(ELECTRON, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData } });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let cdp;
  let result;
  try {
    const page = await pageFor(port);
    cdp = new Cdp(page);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.navigate', { url: 'file:///' + path.join(ROOT, 'app', 'masters.html').replace(/\\/g, '/') });
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const ready = await cdp.evaluate("document.readyState === 'complete' && !!document.querySelector('.masters-workspace')");
      if (ready) break;
      await sleep(100);
    }
    await sleep(300);
    const before = await cdp.evaluate(`(function(){
      var b=document.getElementById('masters-collapse-left');
      var r=b.getBoundingClientRect();
      var p=b.parentElement;
      var ws=document.querySelector('.masters-workspace');
      var hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      var stack=document.elementsFromPoint(r.left+r.width/2,r.top+r.height/2).slice(0,10).map(function(el){var s=getComputedStyle(el);return {id:el.id,tag:el.tagName,cls:el.className,rect:(function(x){return {x:x.x,y:x.y,w:x.width,h:x.height};})(el.getBoundingClientRect()),pointer:s.pointerEvents,z:s.zIndex,display:s.display,visibility:s.visibility};});
      var w=getComputedStyle(ws);
      return {viewport:{w:innerWidth,h:innerHeight},button:{x:r.x,y:r.y,w:r.width,h:r.height},buttonParent:{id:p&&p.id,cls:p&&p.className,rect:p&&((function(x){return {x:x.x,y:x.y,w:x.width,h:x.height};})(p.getBoundingClientRect()))},grid:w.gridTemplateColumns,hit:{id:hit&&hit.id,tag:hit&&hit.tagName,cls:hit&&hit.className},stack:stack,bodyClass:document.body.className,aria:b.getAttribute('aria-expanded'),panelBound:b.dataset.panelBound||null,listenerProbe:typeof window.toggleMasterPanel,focus:document.activeElement&&{id:document.activeElement.id,tag:document.activeElement.tagName}};
    })()`);
    const rect = before.button;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, button: 'none' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, button: 'left', clickCount: 1 });
    await sleep(250);
    const after = await cdp.evaluate(`(function(){var b=document.getElementById('masters-collapse-left'),ws=document.querySelector('.masters-workspace'),r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2),w=getComputedStyle(ws);return {grid:w.gridTemplateColumns,bodyClass:document.body.className,aria:b.getAttribute('aria-expanded'),focus:document.activeElement&&{id:document.activeElement.id,tag:document.activeElement.tagName},button:{x:r.x,y:r.y,w:r.width,h:r.height},hit:{id:hit&&hit.id,tag:hit&&hit.tagName,cls:hit&&hit.className}};})()`);
    result = { command: [ELECTRON, ...args].join(' '), cwd: ROOT, viewport: { width: 1024, height: 700 }, before, after };
    fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (_) {}
    if (cdp) cdp.close();
    await new Promise(resolve => { const timer = setTimeout(resolve, 1200); child.once('exit', resolve); timer.unref(); });
    if (child.exitCode === null) child.kill('SIGKILL');
    stdout.end();
    stderr.end();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
