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
const TASK = 'XJ-5.1.1-masters-narrow-viewport-fold-runtime-stability-rework-013';
const CARD_SHA = 'EAFE5138BF34A3C57ED9B0664E1A96B4D6AE16A6A812EACE6C3E0792635154E6';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const RAW = path.join(OUT, 'runtime-raw');
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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function assertPass(condition, name, detail) {
  if (!condition) throw new Error(name + ': ' + detail);
}
function recordFile(file, command, cwd, exit) {
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { path: file.replace(/\\/g, '/'), command, cwd: cwd.replace(/\\/g, '/'), exit, bytes: data.length, sha256: sha256(data) };
}
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
async function waitForPage(port) {
  const end = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < end) {
    try {
      const pages = await getJson(port);
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await sleep(100);
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
    this.ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method) this.events.push(message);
    });
    this.ws.on('error', error => this.rejectPending(error));
    this.ws.on('close', () => {
      this.closed = true;
      this.rejectPending(new Error('CDP websocket closed'));
    });
  }
  rejectPending(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'CDP closed'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      const onOpen = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('CDP websocket closed before open')); };
      const cleanup = () => {
        this.ws.removeListener('open', onOpen);
        this.ws.removeListener('error', onError);
        this.ws.removeListener('close', onClose);
      };
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
    return result.result ? result.result.value : undefined;
  }
  close() { this.closed = true; this.rejectPending(new Error('CDP client closed')); try { this.ws.close(); } catch (_) {} }
}

function commandArgs(port, userData, pageRoot) {
  return [
    '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + userData, pageRoot,
  ];
}

async function launch(label, pageRoot) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-masters-013-' + label + '-'));
  const port = 9800 + Math.floor(Math.random() * 400);
  const args = commandArgs(port, userData, ROOT);
  const command = [ELECTRON, ...args].map(value => JSON.stringify(value)).join(' ');
  const stdoutFile = path.join(RAW, label + '-' + port + '.stdout.log');
  const stderrFile = path.join(RAW, label + '-' + port + '.stderr.log');
  const stdout = fs.createWriteStream(stdoutFile);
  const stderr = fs.createWriteStream(stderrFile);
  const child = spawn(ELECTRON, args, {
    cwd: ROOT,
    env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData },
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
  async function finishStream(stream) {
    if (!stream || stream.destroyed || stream.writableEnded) return;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 1000);
      stream.once('finish', finish);
      stream.once('error', finish);
      stream.end(finish);
    });
  }
  return {
    child, cdp, command, cwd: ROOT, stdoutFile, stderrFile, userData,
    async close() {
      if (closed) return;
      closed = true;
      try { await Promise.race([cdp.send('Browser.close', {}, 1000).catch(() => undefined), sleep(1200)]); } catch (_) {}
      cdp.close();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await finishStream(stdout);
      await finishStream(stderr);
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    },
    records() {
      return {
        command,
        cwd: ROOT.replace(/\\/g, '/'),
        exit: child.exitCode === null ? 0 : child.exitCode,
        stdout: recordFile(stdoutFile, command, ROOT, child.exitCode === null ? 0 : child.exitCode),
        stderr: recordFile(stderrFile, command, ROOT, child.exitCode === null ? 0 : child.exitCode),
      };
    },
  };
}

async function navigate(app, viewport, url = URL) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await app.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await app.cdp.send('Page.navigate', { url });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const ready = await app.cdp.evaluate("document.readyState === 'complete' && !!document.querySelector('.masters-workspace') && !!document.getElementById('masters-collapse-left') && !!document.getElementById('masters-collapse-right')");
    if (ready) break;
    await sleep(100);
  }
  await sleep(250);
  const bound = await app.cdp.evaluate("!!(window.toggleMasterPanel && document.getElementById('masters-collapse-left') && document.getElementById('masters-collapse-left').dataset.panelBound === '1' && document.getElementById('masters-collapse-right').dataset.panelBound === '1')");
  assertPass(bound, 'controls not ready', JSON.stringify({ viewport, url }));
  await app.cdp.evaluate(`(function(){
    if (window.__xj013TraceInstalled) return;
    window.__xj013TraceInstalled = true;
    window.__xj013LastClick = null;
    document.addEventListener('click', function(e){
      var el=e.target, owner=el&&el.closest?el.closest('.masters-collapse-btn'):null;
      window.__xj013LastClick = {isTrusted:!!e.isTrusted,target:{id:el&&el.id||'',tag:el&&el.tagName||'',className:String(el&&el.className||'')},ownerId:owner&&owner.id||'',ownerLabel:owner&&owner.getAttribute('aria-label')||''};
    }, true);
  })()`);
}

function snapshotExpression() {
  return `(function(){
    function rect(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right};}
    function describe(el){if(!el)return null;var s=getComputedStyle(el),owner=el.closest?el.closest('.masters-collapse-btn'):null;return {id:el.id||'',tag:el.tagName||'',className:String(el.className||''),ownerId:owner&&owner.id||'',rect:rect(el),pointerEvents:s.pointerEvents,zIndex:s.zIndex,display:s.display,visibility:s.visibility};}
    function target(selector){var el=document.querySelector(selector),r=el&&el.getBoundingClientRect(),x=r?r.left+r.width/2:0,y=r?r.top+r.height/2:0;return {rect:rect(el),point:{x:x,y:y},elementFromPoint:describe(document.elementFromPoint(x,y)),stack:Array.from(document.elementsFromPoint(x,y)).slice(0,8).map(describe)};}
    var ws=document.querySelector('.masters-workspace'),dp=document.querySelector('.masters-dialogue-panel'),lp=document.getElementById('master-source-panel'),rp=document.getElementById('master-inspector-panel'),body=document.getElementById('chat-body'),cs=ws&&getComputedStyle(ws),focus=document.activeElement;
    var msgs=body?Array.from(body.querySelectorAll(':scope > .msg')).map(function(el){var r=el.getBoundingClientRect();return {className:el.className,top:r.top,bottom:r.bottom,left:r.left,right:r.right,w:r.width,h:r.height,text:(el.textContent||'').slice(0,120)};}):[];
    return {url:location.href,viewport:{w:innerWidth,h:innerHeight},grid:cs&&cs.gridTemplateColumns||'',gridTracks:cs?cs.gridTemplateColumns.split(/\\s+/).map(function(x){return parseFloat(x)||0;}):[],left:rect(lp),right:rect(rp),dialogue:rect(dp),leftTarget:target('#masters-collapse-left'),rightTarget:target('#masters-collapse-right'),buttons:{left:{expanded:document.getElementById('masters-collapse-left')&&document.getElementById('masters-collapse-left').getAttribute('aria-expanded'),label:document.getElementById('masters-collapse-left')&&document.getElementById('masters-collapse-left').getAttribute('aria-label')},right:{expanded:document.getElementById('masters-collapse-right')&&document.getElementById('masters-collapse-right').getAttribute('aria-expanded'),label:document.getElementById('masters-collapse-right')&&document.getElementById('masters-collapse-right').getAttribute('aria-label')}},state:window.__xjMastersPanelState?{left:!!window.__xjMastersPanelState.left,right:!!window.__xjMastersPanelState.right}:null,focus:focus?{id:focus.id||'',tag:focus.tagName||'',aria:focus.getAttribute('aria-label')}:null,body:body?{scrollWidth:body.scrollWidth,clientWidth:body.clientWidth,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}:null,page:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight},messages:msgs,msgTops:msgs.map(function(m){return m.top;}),lastClick:window.__xj013LastClick||null};
  })()`;
}
async function snapshot(cdp) { return cdp.evaluate(snapshotExpression()); }
async function trustedClick(app, selector) {
  const before = await app.cdp.evaluate(`(function(){var el=document.querySelector(${JSON.stringify(selector)}),r=el&&el.getBoundingClientRect();if(!el||!r||r.width<=0||r.height<=0)throw new Error('untrusted target unavailable '+${JSON.stringify(selector)});window.__xj013LastClick=null;return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,selector:${JSON.stringify(selector)},hit:(function(x,y){var e=document.elementFromPoint(x,y);return {id:e&&e.id||'',tag:e&&e.tagName||'',ownerId:e&&e.closest?((e.closest('.masters-collapse-btn')||{}).id||''):''};})(r.left+r.width/2,r.top+r.height/2)};})()`);
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y, button: 'none' });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y, button: 'left', clickCount: 1 });
  await sleep(180);
  const after = await snapshot(app.cdp);
  return { before, event: after.lastClick, after };
}
function requireOwner(click, selector) {
  assertPass(click.before.hit && click.before.hit.ownerId === selector.slice(1), 'trusted hit owner', JSON.stringify(click));
  assertPass(click.event && click.event.isTrusted && click.event.ownerId === selector.slice(1), 'trusted click event owner', JSON.stringify(click.event));
}

async function foldSequence(app) {
  const before = await snapshot(app.cdp);
  assertPass(before.gridTracks.length === 3 && before.gridTracks[0] > 0 && before.gridTracks[2] > 0, 'baseline grid', before.grid);
  const leftFoldClick = await trustedClick(app, '#masters-collapse-left');
  requireOwner(leftFoldClick, '#masters-collapse-left');
  const leftFold = leftFoldClick.after;
  assertPass(leftFold.gridTracks[0] === 0, 'left zero track', leftFold.grid);
  assertPass(leftFold.dialogue.w > before.dialogue.w, 'left dialogue expands', JSON.stringify({ before: before.dialogue.w, after: leftFold.dialogue.w }));
  assertPass(leftFold.buttons.left.expanded === 'false' && leftFold.focus && leftFold.focus.id === 'masters-collapse-left', 'left focus/aria', JSON.stringify(leftFold));
  const leftRestoreClick = await trustedClick(app, '#masters-collapse-left');
  requireOwner(leftRestoreClick, '#masters-collapse-left');
  const leftRestore = leftRestoreClick.after;
  assertPass(leftRestore.gridTracks[0] > 0 && leftRestore.buttons.left.expanded === 'true', 'left restore', JSON.stringify(leftRestore));
  const rightFoldClick = await trustedClick(app, '#masters-collapse-right');
  requireOwner(rightFoldClick, '#masters-collapse-right');
  const rightFold = rightFoldClick.after;
  assertPass(rightFold.gridTracks[2] === 0, 'right zero track', rightFold.grid);
  assertPass(rightFold.dialogue.w > before.dialogue.w, 'right dialogue expands', JSON.stringify({ before: before.dialogue.w, after: rightFold.dialogue.w }));
  assertPass(rightFold.buttons.right.expanded === 'false' && rightFold.focus && rightFold.focus.id === 'masters-collapse-right', 'right focus/aria', JSON.stringify(rightFold));
  const rightRestoreClick = await trustedClick(app, '#masters-collapse-right');
  requireOwner(rightRestoreClick, '#masters-collapse-right');
  const rightRestore = rightRestoreClick.after;
  assertPass(rightRestore.gridTracks[2] > 0 && rightRestore.buttons.right.expanded === 'true', 'right restore', JSON.stringify(rightRestore));
  const bothLeftClick = await trustedClick(app, '#masters-collapse-left');
  const bothRightClick = await trustedClick(app, '#masters-collapse-right');
  requireOwner(bothLeftClick, '#masters-collapse-left');
  requireOwner(bothRightClick, '#masters-collapse-right');
  const bothFold = bothRightClick.after;
  assertPass(bothFold.gridTracks[0] === 0 && bothFold.gridTracks[2] === 0, 'double zero tracks', bothFold.grid);
  assertPass(bothFold.dialogue.w > leftFold.dialogue.w && bothFold.dialogue.w > rightFold.dialogue.w, 'double dialogue expands', JSON.stringify({ left: leftFold.dialogue.w, right: rightFold.dialogue.w, both: bothFold.dialogue.w }));
  const restoreLeftClick = await trustedClick(app, '#masters-collapse-left');
  const restoreRightClick = await trustedClick(app, '#masters-collapse-right');
  requireOwner(restoreLeftClick, '#masters-collapse-left');
  requireOwner(restoreRightClick, '#masters-collapse-right');
  const bothRestore = restoreRightClick.after;
  assertPass(bothRestore.gridTracks[0] > 0 && bothRestore.gridTracks[2] > 0, 'double restore', bothRestore.grid);
  assertPass(bothRestore.page.scrollWidth <= bothRestore.page.clientWidth + 1, 'page no horizontal overflow', JSON.stringify(bothRestore.page));
  return { before, leftFold, leftRestore, rightFold, rightRestore, bothFold, bothRestore, clicks: { leftFoldClick, leftRestoreClick, rightFoldClick, rightRestoreClick, bothLeftClick, bothRightClick, restoreLeftClick, restoreRightClick } };
}

async function setupSyntheticRoundtable(cdp) {
  await cdp.evaluate(`(function(){
    window.__xjMastersSynthetic={calls:0};
    if(window.App){App.featureGate=function(){return true;};App.hasAICompute=function(){return true;};App.showToast=function(){};}
    if(window.Store){Store.getMasterConversations=function(){return [];};Store.saveMasterConversationDurable=function(){return Promise.resolve({ok:true});};}
    if(window.AI){AI.send=function(messages,callback){var n=++window.__xjMastersSynthetic.calls;callback({content:'合成大师第'+n+'条回应：这是用于运行验收的长中文内容，验证三位大师两轮消息沿纵向流严格排列，且不会产生横向溢出。'});};}
    var lock=document.getElementById('ai-lock');if(lock)lock.classList.add('hidden');
    var input=document.getElementById('msg-input'),send=document.getElementById('send-btn');if(input){input.disabled=false;input.removeAttribute('disabled');}if(send){send.disabled=false;send.removeAttribute('disabled');}
  })()`);
}
async function roundtable(app) {
  await setupSyntheticRoundtable(app.cdp);
  await trustedClick(app, '#mode-toggle button[data-mode="round"]');
  const endCards = Date.now() + 5000;
  while (Date.now() < endCards) {
    const count = await app.cdp.evaluate("document.querySelectorAll('#master-list .master-card').length");
    if (count >= 3) break;
    await sleep(100);
  }
  for (let i = 1; i <= 3; i += 1) await trustedClick(app, '#master-list .master-card:nth-of-type(' + i + ')');
  await app.cdp.evaluate("(function(){var i=document.getElementById('msg-input');if(i){i.focus();i.value='请围绕来访者近期反复沉默的临床材料展开两轮合成讨论';}})()");
  await trustedClick(app, '#send-btn');
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const state = await app.cdp.evaluate("({calls:window.__xjMastersSynthetic&&window.__xjMastersSynthetic.calls||0,ai:document.querySelectorAll('#chat-body > .msg.ai').length,typing:document.querySelectorAll('#chat-body > .msg.typing').length})");
    if (state.calls >= 6 && state.ai >= 6 && state.typing === 0) break;
    await sleep(100);
  }
  const result = await snapshot(app.cdp);
  const ai = result.messages.filter(item => /\bai\b/.test(item.className));
  assertPass(ai.length >= 6, 'roundtable six messages', JSON.stringify(result.messages));
  assertPass(result.msgTops.every((top, index) => index === 0 || top > result.msgTops[index - 1]), 'roundtable strict vertical order', JSON.stringify(result.msgTops));
  assertPass(result.body && result.body.scrollWidth <= result.body.clientWidth + 1, 'roundtable no horizontal overflow', JSON.stringify(result.body));
  return result;
}

async function runViewport(viewport, runName, url = URL) {
  const app = await launch(runName, ROOT);
  let result;
  try {
    await navigate(app, viewport, url);
    const sequence = await foldSequence(app);
    const table = await roundtable(app);
    const screenshot = await app.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const image = Buffer.from(screenshot.data, 'base64');
    const imagePath = path.join(EVIDENCE, runName + '-reduced-motion.png');
    fs.writeFileSync(imagePath, image);
    result = { runName, viewport, url, sequence, roundtable: table, screenshot: { path: imagePath.replace(/\\/g, '/'), bytes: image.length, sha256: sha256(image) }, consoleEvents: app.cdp.events.filter(item => item.method === 'Runtime.consoleAPICalled').slice(-20), pageEvents: app.cdp.events.filter(item => item.method === 'Runtime.exceptionThrown').slice(-20) };
  } finally {
    await app.close();
  }
  result.process = app.records();
  return result;
}

async function main() {
  const runs = [];
  let exit = 0;
  const plan = [
    ['1024x700-run-1', VIEWPORTS[0]],
    ['1024x700-run-2', VIEWPORTS[0]],
    ['1024x700-run-3', VIEWPORTS[0]],
    ['1366x768', VIEWPORTS[1]],
    ['1920x1080', VIEWPORTS[2]],
  ];
  for (const [name, viewport] of plan) {
    try { runs.push(await runViewport(viewport, name)); console.log('PASS', name); }
    catch (error) { exit = 1; console.error('FAIL', name, error.stack || error.message); runs.push({ runName: name, viewport, error: error.stack || error.message }); }
  }
  const output = { task: TASK, card_sha256: CARD_SHA, command_cwd: ROOT.replace(/\\/g, '/'), network_policy: 'host-resolver-rules MAP * ~NOTFOUND EXCLUDE localhost; disable-background-networking', reduced_motion: true, runs };
  const outPath = path.join(EVIDENCE, 'runtime-stability-013.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), results: runs.map(item => ({ runName: item.runName, ok: !item.error })) }, null, 2));
  process.exitCode = exit;
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
