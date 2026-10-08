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
const TASK = 'XJ-5.1.1-masters-workspace-runtime-closure-011';
const CARD_SHA = '54C852085227797B403368C4A705928028A98F5BDE0EF97E30D7C391DD43E92A';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const RAW = path.join(OUT, 'raw');
const EVIDENCE = path.join(OUT, 'evidence');
const URL = 'file:///' + path.join(ROOT, 'app', 'masters.html').replace(/\\/g, '/');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
}

function fileRecord(file, command, cwd, exit) {
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { path: file.replace(/\\/g, '/'), command, cwd, exit, bytes, sha256: sha256(data) };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getJson(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(1500, () => req.destroy(new Error('CDP discovery timeout')));
    req.on('error', reject);
  });
}

async function waitForPage(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < end) {
    try {
      const pages = await getJson(port);
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl) || pages.find(item => item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await sleep(150);
  }
  throw new Error('CDP page unavailable: ' + (lastError ? lastError.message : 'timeout'));
}

class CdpClient {
  constructor(page) {
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.closed = false;
    this.ws.on('error', error => this.rejectPending(error));
    this.ws.on('close', () => {
      this.closed = true;
      this.rejectPending(new Error('CDP websocket closed'));
    });
    this.ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method) this.events.push(message);
    });
  }

  rejectPending(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'CDP websocket closed'));
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(reason);
    }
    this.pending.clear();
  }

  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const cleanup = () => {
        this.ws.removeListener('open', onOpen);
        this.ws.removeListener('error', onError);
        this.ws.removeListener('close', onClose);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('CDP websocket closed before open')); };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP websocket is not open for ' + method));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP timeout for ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), error => {
          if (!error || !this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    this.closed = true;
    this.rejectPending(new Error('CDP client closed'));
    try { this.ws.close(); } catch (_) {}
  }
}

function commandFor(port, userData) {
  return [
    ELECTRON,
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData,
    ROOT,
  ].map(value => JSON.stringify(value)).join(' ');
}

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-masters-userdata-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  const command = commandFor(port, userData);
  const stdoutFile = path.join(RAW, 'electron-' + port + '.stdout.log');
  const stderrFile = path.join(RAW, 'electron-' + port + '.stderr.log');
  const stdout = fs.createWriteStream(stdoutFile);
  const stderr = fs.createWriteStream(stderrFile);
  const child = spawn(ELECTRON, command.slice(command.indexOf(' ') + 1).match(/(?:[^\s"]+|"[^"]*")+/g).map(value => value.replace(/^"|"$/g, '')), {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      XJ_AGENT_ACCEPTANCE: '1',
      XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
    }),
    windowsHide: true,
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const page = await waitForPage(port);
  const cdp = new CdpClient(page);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  let closed = false;
  const waitForChildExit = async timeoutMs => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(timeoutMs),
    ]);
  };
  const finishStream = async stream => {
    if (!stream || stream.destroyed || stream.writableEnded) return;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      stream.once('finish', finish);
      stream.once('error', finish);
      stream.end(finish);
    });
  };
  return {
    child,
    cdp,
    port,
    userData,
    command,
    stdoutFile,
    stderrFile,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await Promise.race([
          cdp.send('Browser.close', {}, 1000).catch(() => undefined),
          sleep(1200),
        ]);
      } catch (_) {}
      cdp.close();
      await waitForChildExit(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
      await finishStream(stdout);
      await finishStream(stderr);
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

async function navigate(app, viewport) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await app.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await app.cdp.send('Page.navigate', { url: URL });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const ready = await app.cdp.evaluate("document.readyState === 'complete' && !!document.querySelector('.masters-workspace')");
    if (ready) break;
    await sleep(150);
  }
  await sleep(500);
}

async function clickSelector(cdp, selector) {
  const rect = await cdp.evaluate(`(function(){
    var el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return null;
    var r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,disabled:!!el.disabled};
  })()`);
  if (!rect || rect.disabled || rect.w <= 0 || rect.h <= 0) throw new Error('untrusted/unavailable click target: ' + selector + ' ' + JSON.stringify(rect));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(180);
  return rect;
}

async function snapshot(cdp) {
  return cdp.evaluate(`(function(){
    var ws=document.querySelector('.masters-workspace');
    var dp=document.querySelector('.masters-dialogue-panel');
    var lp=document.getElementById('master-source-panel');
    var rp=document.getElementById('master-inspector-panel');
    var body=document.getElementById('chat-body');
    var rect=function(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,top:r.top,bottom:r.bottom};};
    var cs=ws?getComputedStyle(ws):null;
    var msgs=body?Array.from(body.querySelectorAll(':scope > .msg')).map(function(el){var r=el.getBoundingClientRect();return {className:el.className,top:r.top,bottom:r.bottom,left:r.left,right:r.right,w:r.width,h:r.height,text:(el.textContent||'').slice(0,80)};}):[];
    var focus=document.activeElement;
    return {
      url:location.href,
      viewport:{w:window.innerWidth,h:window.innerHeight},
      grid:cs?cs.gridTemplateColumns:'',
      gridTracks:cs?cs.gridTemplateColumns.split(/\\s+/).map(function(x){return parseFloat(x)||0;}):[],
      left:rect(lp),right:rect(rp),dialogue:rect(dp),
      body:body?{scrollWidth:body.scrollWidth,clientWidth:body.clientWidth,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}:null,
      page:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight},
      focus:focus?{id:focus.id,tag:focus.tagName,aria:focus.getAttribute('aria-label')}:null,
      buttons:{left:document.getElementById('masters-collapse-left')?{expanded:document.getElementById('masters-collapse-left').getAttribute('aria-expanded'),label:document.getElementById('masters-collapse-left').getAttribute('aria-label')}:null,right:document.getElementById('masters-collapse-right')?{expanded:document.getElementById('masters-collapse-right').getAttribute('aria-expanded'),label:document.getElementById('masters-collapse-right').getAttribute('aria-label')}:null},
      state:window.__xjMastersPanelState?{left:!!window.__xjMastersPanelState.left,right:!!window.__xjMastersPanelState.right}:null,
      messages:msgs,
      msgTops:msgs.map(function(m){return m.top;}),
      msgOverflow:msgs.some(function(m){return m.right>window.innerWidth+0.5||m.left<-.5||m.w>window.innerWidth+0.5;}),
      consoleErrors:0,
      pageErrors:0
    };
  })()`);
}

async function setupSyntheticRoundtable(cdp) {
  await cdp.evaluate(`(function(){
    window.__xjMastersSynthetic={calls:0};
    if(window.App){
      App.featureGate=function(){return true;};
      App.hasAICompute=function(){return true;};
      App.showToast=function(){};
    }
    if(window.Store){
      Store.getMasterConversations=function(){return [];};
      Store.saveMasterConversationDurable=function(){return Promise.resolve({ok:true});};
    }
    if(window.AI){
      AI.send=function(messages, callback){
        var n=++window.__xjMastersSynthetic.calls;
        callback({content:'合成大师第'+n+'条回应：这是用于运行验收的长中文内容，验证三位大师两轮消息沿纵向流严格排列，且不会产生横向溢出。'});
      };
    }
    var lock=document.getElementById('ai-lock');
    if(lock) lock.classList.add('hidden');
    var input=document.getElementById('msg-input');
    var send=document.getElementById('send-btn');
    if(input){input.disabled=false;input.removeAttribute('disabled');}
    if(send){send.disabled=false;send.removeAttribute('disabled');}
  })()`);
}

async function runRoundtable(cdp) {
  await setupSyntheticRoundtable(cdp);
  await clickSelector(cdp, '#mode-toggle button[data-mode="round"]');
  for (let i = 1; i <= 3; i += 1) await clickSelector(cdp, '#master-list .master-card:nth-of-type(' + i + ')');
  await cdp.evaluate("(function(){var i=document.getElementById('msg-input'); if(i){i.focus();i.value='请围绕来访者近期反复沉默的临床材料展开两轮合成讨论';}})()");
  await clickSelector(cdp, '#send-btn');
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const state = await cdp.evaluate("({calls:window.__xjMastersSynthetic&&window.__xjMastersSynthetic.calls||0,ai:document.querySelectorAll('#chat-body > .msg.ai').length,typing:document.querySelectorAll('#chat-body > .msg.typing').length})");
    if (state.calls >= 6 && state.ai >= 6 && state.typing === 0) break;
    await sleep(150);
  }
  return snapshot(cdp);
}

function requirePass(ok, name, detail) {
  if (!ok) throw new Error(name + ': ' + detail);
}

async function runViewport(viewport) {
  const app = await launch();
  try {
    await navigate(app, viewport);
    const before = await snapshot(app.cdp);
    requirePass(before.gridTracks.length === 3 && before.gridTracks[0] > 0 && before.gridTracks[2] > 0, 'baseline grid', JSON.stringify(before.grid));

    await clickSelector(app.cdp, '#masters-collapse-left');
    const leftFold = await snapshot(app.cdp);
    requirePass(leftFold.gridTracks[0] === 0, 'left zero track', JSON.stringify(leftFold.grid));
    requirePass(leftFold.dialogue.w > before.dialogue.w, 'left dialogue expands', JSON.stringify({ before: before.dialogue.w, after: leftFold.dialogue.w }));
    requirePass(leftFold.buttons.left.expanded === 'false' && leftFold.focus && leftFold.focus.id === 'masters-collapse-left', 'left focus/aria', JSON.stringify(leftFold));

    await clickSelector(app.cdp, '#masters-collapse-left');
    const leftRestore = await snapshot(app.cdp);
    requirePass(leftRestore.gridTracks[0] > 0, 'left restored', JSON.stringify(leftRestore.grid));

    await clickSelector(app.cdp, '#masters-collapse-right');
    const rightFold = await snapshot(app.cdp);
    requirePass(rightFold.gridTracks[2] === 0, 'right zero track', JSON.stringify(rightFold.grid));
    requirePass(rightFold.dialogue.w > before.dialogue.w, 'right dialogue expands', JSON.stringify({ before: before.dialogue.w, after: rightFold.dialogue.w }));
    requirePass(rightFold.buttons.right.expanded === 'false' && rightFold.focus && rightFold.focus.id === 'masters-collapse-right', 'right focus/aria', JSON.stringify(rightFold));

    await clickSelector(app.cdp, '#masters-collapse-right');
    const rightRestore = await snapshot(app.cdp);
    requirePass(rightRestore.gridTracks[2] > 0, 'right restored', JSON.stringify(rightRestore.grid));

    await clickSelector(app.cdp, '#masters-collapse-left');
    await clickSelector(app.cdp, '#masters-collapse-right');
    const bothFold = await snapshot(app.cdp);
    requirePass(bothFold.gridTracks[0] === 0 && bothFold.gridTracks[2] === 0, 'double zero tracks', JSON.stringify(bothFold.grid));
    requirePass(bothFold.dialogue.w > leftFold.dialogue.w && bothFold.dialogue.w > rightFold.dialogue.w, 'double dialogue maximizes', JSON.stringify({ left: leftFold.dialogue.w, right: rightFold.dialogue.w, both: bothFold.dialogue.w }));

    await clickSelector(app.cdp, '#masters-collapse-left');
    await clickSelector(app.cdp, '#masters-collapse-right');
    const bothRestore = await snapshot(app.cdp);
    requirePass(bothRestore.gridTracks[0] > 0 && bothRestore.gridTracks[2] > 0, 'double restored', JSON.stringify(bothRestore.grid));
    requirePass(bothRestore.page.scrollWidth <= bothRestore.page.clientWidth + 1, 'page no horizontal overflow', JSON.stringify(bothRestore.page));

    const roundtable = await runRoundtable(app.cdp);
    requirePass(roundtable.messages.filter(item => /\bai\b/.test(item.className)).length >= 6, 'roundtable six messages', JSON.stringify(roundtable.messages));
    const tops = roundtable.messages.filter(item => /\bai\b/.test(item.className)).map(item => item.top);
    requirePass(tops.every((top, index) => index === 0 || top > tops[index - 1]), 'roundtable strict vertical order', JSON.stringify(tops));
    requirePass(!roundtable.msgOverflow && roundtable.body && roundtable.body.scrollWidth <= roundtable.body.clientWidth + 1, 'roundtable no overflow', JSON.stringify(roundtable));

    const screenshot = await app.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const image = Buffer.from(screenshot.data, 'base64');
    const imagePath = path.join(EVIDENCE, viewport.name + '-reduced-motion.png');
    fs.writeFileSync(imagePath, image);
    const events = app.cdp.events.slice();
    const consoleErrors = events.filter(item => item.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(item.params && item.params.type)).length;
    const pageErrors = events.filter(item => item.method === 'Runtime.exceptionThrown').length;
    return { viewport, before, leftFold, leftRestore, rightFold, rightRestore, bothFold, bothRestore, roundtable, screenshot: { path: imagePath.replace(/\\/g, '/'), bytes: image.length, sha256: sha256(image) }, consoleErrors, pageErrors, events: events.filter(item => item.method === 'Runtime.exceptionThrown' || item.method === 'Runtime.consoleAPICalled').slice(-20) };
  } finally {
    await app.close();
  }
}

async function main() {
  const results = [];
  let exit = 0;
  const selectedViewports = process.env.XJ_MASTERS_VIEWPORT ? VIEWPORTS.filter(item => item.name === process.env.XJ_MASTERS_VIEWPORT) : VIEWPORTS;
  for (const viewport of selectedViewports) {
    try { results.push(await runViewport(viewport)); console.log('PASS', viewport.name); }
    catch (error) { exit = 1; console.error('FAIL', viewport.name, error.stack || error.message); results.push({ viewport, error: error.stack || error.message }); }
  }
  const output = { task: TASK, card_sha256: CARD_SHA, url: URL, command_cwd: ROOT.replace(/\\/g, '/'), reduced_motion: true, results };
  const outPath = path.join(EVIDENCE, 'runtime-closure-011.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), results: results.map(item => ({ viewport: item.viewport && item.viewport.name, ok: !item.error })) }, null, 2));
  process.exitCode = exit;
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else {
  module.exports = { ROOT, TASK, CARD_SHA, OUT, RAW, EVIDENCE, URL, VIEWPORTS, sha256, fileRecord, sleep, launch, navigate, clickSelector, snapshot, setupSyntheticRoundtable, runRoundtable };
}
