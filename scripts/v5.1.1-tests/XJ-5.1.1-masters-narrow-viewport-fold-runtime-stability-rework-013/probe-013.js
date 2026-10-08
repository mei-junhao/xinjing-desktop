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
const URL = process.env.XJ013_URL || ('file:///' + path.join(ROOT, 'app', 'masters.html').replace(/\\/g, '/'));
const MODE = process.env.XJ013_MODE || 'cover';
const RAW_DIR = process.env.XJ013_RAW_DIR || path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-narrow-viewport-fold-runtime-stability-rework-013', 'probe-raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
const assertPass = (ok, name, detail) => { if (!ok) throw new Error(name + ': ' + detail); };
function getJson(port) {
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
async function waitPage(port) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const pages = await getJson(port);
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
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
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
    this.ws.on('error', error => this.rejectPending(error));
    this.ws.on('close', () => { this.closed = true; this.rejectPending(new Error('CDP closed')); });
  }
  rejectPending(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  open() { return new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); }); }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('CDP unavailable for ' + method)); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
    return result.result && result.result.value;
  }
  close() { this.closed = true; this.rejectPending(new Error('CDP close')); try { this.ws.close(); } catch (_) {} }
}

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-masters-013-probe-'));
  const port = 10200 + Math.floor(Math.random() * 300);
  const args = ['--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + userData, ROOT];
  const command = [ELECTRON, ...args].map(v => JSON.stringify(v)).join(' ');
  const stdoutPath = path.join(RAW_DIR, 'electron-' + port + '.stdout.log');
  const stderrPath = path.join(RAW_DIR, 'electron-' + port + '.stderr.log');
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const child = spawn(ELECTRON, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData } });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const page = await waitPage(port);
  const cdp = new Cdp(page);
  await cdp.open();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
  return { child, cdp, command, stdoutPath, stderrPath, userData, async close() {
    try { await Promise.race([cdp.send('Browser.close', {}, 1000).catch(() => undefined), sleep(1200)]); } catch (_) {}
    cdp.close();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => { stdout.end(resolve); });
    await new Promise(resolve => { stderr.end(resolve); });
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  } };
}
async function navigate(app) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
  await app.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await app.cdp.send('Page.navigate', { url: URL });
  if (process.env.XJ013_NO_WAIT === '1') return;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await app.cdp.eval("document.readyState === 'complete' && !!document.querySelector('.masters-workspace')")) break;
    await sleep(100);
  }
  await sleep(250);
  const ready = await app.cdp.eval("!!window.toggleMasterPanel && document.getElementById('masters-collapse-left') && document.getElementById('masters-collapse-left').dataset.panelBound === '1'");
  assertPass(ready, 'controls ready', URL);
  await app.cdp.eval(`(function(){window.__xj013LastClick=null;document.addEventListener('click',function(e){var o=e.target&&e.target.closest?e.target.closest('.masters-collapse-btn'):null;window.__xj013LastClick={trusted:!!e.isTrusted,targetId:e.target&&e.target.id||'',ownerId:o&&o.id||''};},true);})()`);
}
async function snapshot(app) {
  return app.cdp.eval(`(function(){var ws=document.querySelector('.masters-workspace'),dp=document.querySelector('.masters-dialogue-panel'),b=document.getElementById('master-collapse-left'),left=document.getElementById('master-source-panel'),right=document.getElementById('master-inspector-panel'),body=document.getElementById('chat-body'),c=ws&&getComputedStyle(ws),m=body?Array.from(body.querySelectorAll(':scope > .msg')).map(function(e){var r=e.getBoundingClientRect();return {className:e.className,top:r.top,left:r.left,right:r.right,w:r.width};}):[];return {grid:c&&c.gridTemplateColumns||'',tracks:c?c.gridTemplateColumns.split(/\\s+/).map(function(x){return parseFloat(x)||0;}):[],dialogue:dp&&((function(r){return {x:r.x,y:r.y,w:r.width,h:r.height};})(dp.getBoundingClientRect())),left:left&&((function(r){return {x:r.x,y:r.y,w:r.width,h:r.height};})(left.getBoundingClientRect())),right:right&&((function(r){return {x:r.x,y:r.y,w:r.width,h:r.height};})(right.getBoundingClientRect())),leftAria:document.getElementById('masters-collapse-left')&&document.getElementById('masters-collapse-left').getAttribute('aria-expanded'),focus:document.activeElement&&document.activeElement.id||'',body:body&&{scrollWidth:body.scrollWidth,clientWidth:body.clientWidth},messages:m,lastClick:window.__xj013LastClick};})()`);
}
async function click(app, selector) {
  const p = await app.cdp.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)}),r=e&&e.getBoundingClientRect();if(!e||!r||r.width<=0||r.height<=0)throw new Error('target unavailable '+${JSON.stringify(selector)});window.__xj013LastClick=null;return {x:r.left+r.width/2,y:r.top+r.height/2,hit:(function(x,y){var h=document.elementFromPoint(x,y);return {id:h&&h.id||'',ownerId:h&&h.closest?((h.closest('.masters-collapse-btn')||{}).id||''):''};})(r.left+r.width/2,r.top+r.height/2)};})()`);
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(180);
  return { point: p, after: await snapshot(app) };
}
async function setupRoundtable(app) {
  await app.cdp.eval(`(function(){window.__xjMastersSynthetic={calls:0};if(window.App){App.featureGate=function(){return true;};App.hasAICompute=function(){return true;};App.showToast=function(){};}if(window.Store){Store.getMasterConversations=function(){return [];};Store.saveMasterConversationDurable=function(){return Promise.resolve({ok:true});};}if(window.AI){AI.send=function(m,cb){var n=++window.__xjMastersSynthetic.calls;cb({content:'合成大师第'+n+'条回应：用于验证三位大师两轮消息沿纵向流严格排列，且不会横向溢出。'});};}var l=document.getElementById('ai-lock'),i=document.getElementById('msg-input'),s=document.getElementById('send-btn');if(l)l.classList.add('hidden');if(i){i.disabled=false;i.removeAttribute('disabled');}if(s){s.disabled=false;s.removeAttribute('disabled');}})()`);
  await click(app, '#mode-toggle button[data-mode="round"]');
  for (let i = 1; i <= 3; i += 1) await click(app, '#master-list .master-card:nth-of-type(' + i + ')');
  await app.cdp.eval("(function(){var i=document.getElementById('msg-input');i.focus();i.value='合成圆桌长中文验收';})()");
  await click(app, '#send-btn');
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const state = await app.cdp.eval("({calls:window.__xjMastersSynthetic.calls,ai:document.querySelectorAll('#chat-body > .msg.ai').length,typing:document.querySelectorAll('#chat-body > .msg.typing').length})");
    if (state.calls >= 6 && state.ai >= 6 && state.typing === 0) break;
    await sleep(100);
  }
}
async function run() {
  const app = await launch();
  let result;
  try {
    await navigate(app);
    const before = await snapshot(app);
    if (MODE === 'round') {
      await setupRoundtable(app);
      const after = await snapshot(app);
      const ai = after.messages.filter(item => /\bai\b/.test(item.className));
      assertPass(ai.length >= 6, 'roundtable six messages', JSON.stringify(after.messages));
      assertPass(after.messages.every((item, i) => i === 0 || item.top > after.messages[i - 1].top), 'roundtable vertical', JSON.stringify(after.messages));
      assertPass(after.body.scrollWidth <= after.body.clientWidth + 1, 'roundtable overflow', JSON.stringify(after.body));
      result = { mode: MODE, before, after, pass: true };
    } else if (MODE === 'restore') {
      const fold = await click(app, '#masters-collapse-left');
      const restore = await click(app, '#masters-collapse-left');
      assertPass(fold.after.tracks[0] === 0, 'fold zero track', fold.after.grid);
      assertPass(restore.after.tracks[0] > 0, 'restore nonzero track', restore.after.grid);
      result = { mode: MODE, before, fold, restore, pass: true };
    } else {
      const fold = await click(app, '#masters-collapse-left');
      assertPass(fold.point.hit.ownerId === 'masters-collapse-left', 'trusted hit owner', JSON.stringify(fold.point));
      assertPass(fold.after.lastClick && fold.after.lastClick.trusted && fold.after.lastClick.ownerId === 'masters-collapse-left', 'trusted event owner', JSON.stringify(fold.after.lastClick));
      assertPass(fold.after.tracks[0] === 0, MODE === 'hidden' ? 'hidden content must zero track' : 'covered button zero track', fold.after.grid);
      result = { mode: MODE, before, fold, pass: true };
    }
  } finally {
    await app.close();
  }
  const electronExit = app.child.exitCode === null ? 0 : app.child.exitCode;
  const raw = { command: app.command, cwd: ROOT.replace(/\\/g, '/'), exit: electronExit, stdout: { path: app.stdoutPath.replace(/\\/g, '/'), bytes: fs.existsSync(app.stdoutPath) ? fs.statSync(app.stdoutPath).size : 0, sha256: fs.existsSync(app.stdoutPath) ? sha256(fs.readFileSync(app.stdoutPath)) : sha256(Buffer.alloc(0)) }, stderr: { path: app.stderrPath.replace(/\\/g, '/'), bytes: fs.existsSync(app.stderrPath) ? fs.statSync(app.stderrPath).size : 0, sha256: fs.existsSync(app.stderrPath) ? sha256(fs.readFileSync(app.stderrPath)) : sha256(Buffer.alloc(0)) } };
  console.log(JSON.stringify({ mode: MODE, url: URL, result, electron: raw }, null, 2));
}
run().catch(error => { console.error(JSON.stringify({ mode: MODE, url: URL, pass: false, error: error.stack || error.message }, null, 2)); process.exitCode = 1; });
