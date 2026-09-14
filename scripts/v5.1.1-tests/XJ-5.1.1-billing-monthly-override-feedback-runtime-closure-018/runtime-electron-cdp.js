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
const TASK = 'XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018';
const CARD_SHA = 'B42FFB0429BEBC534885BA7A1AE68E9F23D89300B55EF0DE4F1CD0529948BC79';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK);
const RAW = path.join(OUT, 'raw');
const EVIDENCE = path.join(OUT, 'evidence');
const URL = 'file:///' + path.join(ROOT, 'app', 'billing-calendar.html').replace(/\\/g, '/');
const VIEWPORT = { name: '1366x768', width: 1366, height: 768 };

fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex').toUpperCase(); }
function fileRecord(file, command, cwd, exit) {
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { path: file.replace(/\\/g, '/'), command, cwd, exit, bytes, sha256: sha256(data) };
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function nowYm() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
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

async function waitForPage(port, timeoutMs = 20000) {
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
    this.ws.on('close', () => { this.closed = true; this.rejectPending(new Error('CDP websocket closed')); });
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
    for (const { reject, timer } of this.pending.values()) { if (timer) clearTimeout(timer); reject(reason); }
    this.pending.clear();
  }
  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      const cleanup = () => { this.ws.removeListener('open', onOpen); this.ws.removeListener('error', onError); this.ws.removeListener('close', onClose); };
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
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) { reject(new Error('CDP websocket is not open for ' + method)); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => { if (!this.pending.has(id)) return; this.pending.delete(id); reject(new Error('CDP timeout for ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), error => {
          if (!error || !this.pending.has(id)) return;
          this.pending.delete(id); clearTimeout(timer); reject(error);
        });
      } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
    return result.result ? result.result.value : undefined;
  }
  close() { this.closed = true; this.rejectPending(new Error('CDP client closed')); try { this.ws.close(); } catch (_) {} }
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

async function launch(existingUserData) {
  const userData = existingUserData || fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-billing018-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  const command = commandFor(port, userData);
  const stdoutFile = path.join(RAW, 'electron-' + port + '.stdout.log');
  const stderrFile = path.join(RAW, 'electron-' + port + '.stderr.log');
  const stdout = fs.createWriteStream(stdoutFile);
  const stderr = fs.createWriteStream(stderrFile);
  const child = spawn(ELECTRON, command.slice(command.indexOf(' ') + 1).match(/(?:[^\s"]+|"[^"]*")+/g).map(value => value.replace(/^"|"$/g, '')), {
    cwd: ROOT,
    env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
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
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(timeoutMs)]);
  };
  const finishStream = async stream => {
    if (!stream || stream.destroyed || stream.writableEnded) return;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 1000);
      stream.once('finish', finish);
      stream.once('error', finish);
      stream.end(finish);
    });
  };
  return {
    child, cdp, port, userData, command, stdoutFile, stderrFile,
    async close(keepUserData) {
      if (closed) return;
      closed = true;
      try { await Promise.race([cdp.send('Browser.close', {}, 1000).catch(() => undefined), sleep(1200)]); } catch (_) {}
      cdp.close();
      await waitForChildExit(1500);
      if (child.exitCode === null) child.kill('SIGKILL');
      await finishStream(stdout);
      await finishStream(stderr);
      if (!keepUserData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {} }
    },
  };
}

async function navigate(app, viewport) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await app.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await app.cdp.send('Page.navigate', { url: URL });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const ready = await app.cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('bc-body')");
    if (ready) break;
    await sleep(150);
  }
  try { await app.cdp.send('Page.bringToFront'); } catch (_) {}
  await sleep(500);
}

async function clickSelector(cdp, selector, opts) {
  opts = opts || {};
  const rect = await cdp.evaluate(`(function(){
    var el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return null;
    var r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,disabled:!!el.disabled,display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility};
  })()`);
  if (!rect || rect.disabled || rect.w <= 0 || rect.h <= 0 || rect.display === 'none' || rect.visibility === 'hidden') {
    throw new Error('untrusted/unavailable click target: ' + selector + ' ' + JSON.stringify(rect));
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(160);
  return rect;
}

async function pressKey(cdp, key) {
  const map = { Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Escape: { key: 'Escape', code: 'Escape', vk: 27 } };
  const k = map[key];
  if (!k) throw new Error('unsupported key ' + key);
  // KeyDown + text is what triggers native button activation in this Electron/CDP setup;
  // rawKeyDown dispatches the DOM keydown but does NOT synthesize the default click.
  const params = { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  if (k.text) { params.text = k.text; params.unmodifiedText = k.text; }
  await cdp.send('Input.dispatchKeyEvent', params);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
  await sleep(140);
}

async function snapshot(cdp) {
  return cdp.evaluate(`(function(){
    function pick(id){ return document.getElementById(id); }
    var feedback = pick('bc-inv-feedback');
    var toggle = pick('bc-inv-toggle-override');
    var wrap = pick('bc-inv-override-wrap');
    var input = pick('bc-inv-override-amt');
    var clientSel = pick('bc-inv-client');
    var monthSel = pick('bc-inv-month');
    var focus = document.activeElement;
    var mp = null;
    try {
      var cid = clientSel ? clientSel.value : '';
      var ym = monthSel ? monthSel.value : '';
      var c = cid && window.Store ? Store.getClient(cid) : null;
      mp = c ? {ym:ym, records:(c.billing && c.billing.monthlyPayments)||[], target:(c.billing && Array.isArray(c.billing.monthlyPayments)) ? c.billing.monthlyPayments.filter(function(m){return m.month===ym;}) : []} : null;
    } catch(e){ mp = {error:String(e)}; }
    var bMp = null;
    try {
      var c = window.Store && Store.getClient && window.__xj018 && window.__xj018.B ? Store.getClient(window.__xj018.B) : null;
      bMp = c ? ((c.billing && c.billing.monthlyPayments)||[]) : null;
    } catch(e){ bMp = {error:String(e)}; }
    var section = document.querySelector('.bc-invoice-section');
    return {
      sectionVisible: !!section,
      feedback: feedback ? {text:feedback.textContent, state:feedback.getAttribute('data-state'), role:feedback.getAttribute('role'), live:feedback.getAttribute('aria-live'), busy:feedback.getAttribute('aria-busy'), visible:(feedback.offsetWidth||feedback.offsetHeight)?true:false} : null,
      toggle: toggle ? {expanded:toggle.getAttribute('aria-expanded'), controls:toggle.getAttribute('aria-controls'), disabled:!!toggle.disabled} : null,
      wrapVisible: !!(wrap && wrap.style.display !== 'none'),
      input: input ? {value:input.value, disabled:!!input.disabled} : null,
      focus: focus ? {id:focus.id, tag:focus.tagName} : null,
      client: clientSel ? clientSel.value : null,
      month: monthSel ? monthSel.value : null,
      toasts: (window.__xj018 && window.__xj018.toasts) ? window.__xj018.toasts.slice() : [],
      updates: (window.__xj018 && window.__xj018.updates) ? window.__xj018.updates.length : 0,
      mp: mp,
      clientBmp: bMp
    };
  })()`);
}

async function seedData(cdp, ym) {
  const result = await cdp.evaluate(`(async function(){
    if (window.Store && typeof Store.hydrate === 'function') await Store.hydrate();
    var cA = await Store.createClientDurable({name:'QA合成Pro来访者A-018', status:'active', billing:{billingMode:'per-session', monthlyPayments:[]}});
    if (!cA || !cA.ok) throw new Error('seed A failed');
    var cB = await Store.createClientDurable({name:'QA对照来访者B-018', status:'active', billing:{billingMode:'per-session', monthlyPayments:[{month:'2099-01', amount:100}]}});
    if (!cB || !cB.ok) throw new Error('seed B failed');
    var cC = await Store.createClientDurable({name:'QA重试来访者C-018', status:'active', billing:{billingMode:'per-session', monthlyPayments:[]}});
    if (!cC || !cC.ok) throw new Error('seed C failed');
    var s = await Store.saveSessionsDurable([
      {id:'sess-qa018-a1', clientId:cA.value.id, sessionNumber:1, date:${JSON.stringify(ym)}+'-10', billing:{fee:2680, paid:false, source:'manual'}},
      {id:'sess-qa018-a2', clientId:cA.value.id, sessionNumber:2, date:${JSON.stringify(ym)}+'-20', billing:{fee:1320, paid:false, source:'manual'}},
      {id:'sess-qa018-b1', clientId:cB.value.id, sessionNumber:1, date:${JSON.stringify(ym)}+'-05', billing:{fee:500, paid:true, paidAmount:500, source:'manual'}},
      {id:'sess-qa018-c1', clientId:cC.value.id, sessionNumber:1, date:${JSON.stringify(ym)}+'-15', billing:{fee:900, paid:false, source:'manual'}},
    ]);
    if (!s.ok) throw new Error('seed sessions failed');
    window.__xj018 = window.__xj018 || {};
    window.__xj018.A = cA.value.id;
    window.__xj018.B = cB.value.id;
    window.__xj018.C = cC.value.id;
    return {A:cA.value.id, B:cB.value.id, C:cC.value.id};
  })()`);
  return result;
}

async function overrideUi(cdp, extra) {
  extra = extra || '';
  await cdp.evaluate(`(function(){
    window.__xj018 = window.__xj018 || {};
    if (!Array.isArray(window.__xj018.toasts)) window.__xj018.toasts = [];
    if (!Array.isArray(window.__xj018.updates)) window.__xj018.updates = [];
    var origToast = App.showToast;
    App.showToast = function(msg,type){ window.__xj018.toasts.push({msg:String(msg),type:String(type||''),at:Date.now()}); try{ return origToast.apply(App, arguments); } catch(e){} };
    App.canUse = function(){ return true; };
    if (!window.__xj018.origUpdate) window.__xj018.origUpdate = Store.updateClientDurable;
    Store.updateClientDurable = async function(id, patch){
      window.__xj018.updates.push({id:id, patch:JSON.parse(JSON.stringify(patch)), at:Date.now()});
      if (window.__xj018.wrapper) return window.__xj018.wrapper(id, patch);
      return window.__xj018.origUpdate(id, patch);
    };
    ${extra}
  })()`);
  await cdp.evaluate("window.todayMonth();");
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const ok = await cdp.evaluate("!!document.querySelector('.bc-invoice-section') && !!document.getElementById('bc-inv-feedback')");
    if (ok) break;
    await sleep(120);
  }
}

async function selectClientMonth(cdp, clientId, ym) {
  await cdp.evaluate(`(function(){
    var sel = document.getElementById('bc-inv-client');
    var mon = document.getElementById('bc-inv-month');
    if (!sel || !mon) return false;
    var found = false;
    for (var i=0;i<sel.options.length;i++){ if (sel.options[i].value === ${JSON.stringify(clientId)}) { sel.value = sel.options[i].value; found = true; break; } }
    mon.value = ${JSON.stringify(ym)};
    return found;
  })()`);
  await clickSelector(cdp, '#bc-inv-load');
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const ok = await cdp.evaluate("!!document.getElementById('bc-inv-settle-override')");
    if (ok) break;
    await sleep(120);
  }
}

async function expandOverride(cdp, useEnter) {
  await cdp.evaluate("(function(){var b=document.getElementById('bc-inv-toggle-override'); if(b) b.focus();})()");
  if (useEnter) await pressKey(cdp, 'Enter');
  else await clickSelector(cdp, '#bc-inv-toggle-override');
  await sleep(160);
}

function amountLocalized(n) { return n.toLocaleString('zh-CN'); }

function makeWrapperCallsRecorder() {
  return 'window.__xj018.wrapperCalls = (window.__xj018.wrapperCalls||0) + 1;';
}

async function waitForState(cdp, checkExpr, timeoutMs) {
  const end = Date.now() + (timeoutMs || 10000);
  let last = null;
  while (Date.now() < end) {
    last = await snapshot(cdp);
    if (checkExpr(last)) return last;
    await sleep(120);
  }
  throw new Error('waitForState timeout; last=' + JSON.stringify(last));
}

// ---------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------

async function scenarioKeyboardSuccessAddPersistenceRestart() {
  const app = await launch();
  const ym = nowYm();
  const out = { scenarios: [] };
  try {
    await navigate(app, VIEWPORT);
    const ids = await seedData(app.cdp, ym);
    await overrideUi(app.cdp);
    await selectClientMonth(app.cdp, ids.A, ym);
    const initial = await snapshot(app.cdp);
    requirePass(initial.toggle && initial.toggle.expanded === 'false', 'initial aria-expanded false', JSON.stringify(initial));
    requirePass(initial.feedback && initial.feedback.role === 'status' && initial.feedback.live === 'polite', 'feedback role status / aria-live polite', JSON.stringify(initial.feedback));

    // keyboard: Enter expands, aria-expanded sync, focus to amount input
    await expandOverride(app.cdp, true);
    const expanded = await snapshot(app.cdp);
    requirePass(expanded.wrapVisible === true, 'wrap visible after Enter', JSON.stringify(expanded));
    requirePass(expanded.toggle.expanded === 'true', 'aria-expanded true in sync', JSON.stringify(expanded.toggle));
    requirePass(expanded.focus && expanded.focus.id === 'bc-inv-override-amt', 'focus moved to amount input', JSON.stringify(expanded.focus));
    requirePass(expanded.feedback && expanded.feedback.state === 'info' && /已展开手动覆盖/.test(expanded.feedback.text), 'expand feedback', JSON.stringify(expanded.feedback));
    await saveScreenshot(app, '01-keyboard-expanded.png');

    // success replace
    await cdpSetAmount(app.cdp, '3000');
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    const success1 = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    requirePass(/手动覆盖金额已设为 ¥3,000/.test(success1.feedback.text), 'success feedback contains amount', JSON.stringify(success1.feedback));
    requirePass(new RegExp(ym.replace('-', '年') + '月').test(success1.feedback.text), 'success feedback contains month', JSON.stringify(success1.feedback));
    requirePass(success1.mp.target.length === 1 && success1.mp.target[0].amount === 3000, 'exactly one target-month record with override amount', JSON.stringify(success1.mp));
    requirePass(success1.mp.records.filter(m => m.month !== ym && m.month !== '2099-01').length === 0, 'no other months polluted', JSON.stringify(success1.mp));
    requirePass(success1.clientBmp && success1.clientBmp.some(m => m.month === '2099-01' && m.amount === 100), 'client B untouched', JSON.stringify(success1.clientBmp));
    out.scenarios.push({ name: 'success-replace', ok: true });
    await saveScreenshot(app, '02-success-replace.png');

    // confirm settle stays 'add' (accumulate)
    await clickSelector(app.cdp, '#bc-inv-settle');
    const success2 = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    requirePass(success2.mp.target.length === 1 && success2.mp.target[0].amount === 4000, 'add accumulated 3000+1000 single record', JSON.stringify(success2.mp));
    requirePass(/累计 ¥4,000/.test(success2.feedback.text), 'add feedback shows cumulative', JSON.stringify(success2.feedback));
    out.scenarios.push({ name: 'add-accumulates', ok: true });

    // double-click / busy UI guard with slow wrapper
    await cdpInstallSlowWrapper(app.cdp, 400, null);
    await expandOverride(app.cdp, false);
    await cdpSetAmount(app.cdp, '5000');
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    await sleep(100);
    const busySnap = await snapshot(app.cdp);
    requirePass(busySnap.feedback && busySnap.feedback.state === 'busy', 'busy state observed', JSON.stringify(busySnap.feedback));
    requirePass(busySnap.toggle && busySnap.toggle.disabled === true, 'controls disabled while saving', JSON.stringify(busySnap.toggle));
    let secondBlocked = false;
    try { await clickSelector(app.cdp, '#bc-inv-settle-override'); } catch (_) { secondBlocked = true; }
    requirePass(secondBlocked === true, 'double click blocked while saving', JSON.stringify({ secondBlocked }));
    const success3 = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    const calls = await app.cdp.evaluate("window.__xj018.wrapperCalls || 0");
    requirePass(calls === 1, 'durable API called exactly once', JSON.stringify({ calls }));
    requirePass(success3.mp.target.length === 1 && success3.mp.target[0].amount === 5000, 'single record after double click', JSON.stringify(success3.mp));
    out.scenarios.push({ name: 'double-click-guard', ok: true });
    await saveScreenshot(app, '03-busy-double-click.png');

    // IME-composition: Enter inside input must not save or collapse
    await cdpInstallNormalWrapper(app.cdp);
    await expandOverride(app.cdp, false);
    await cdpSetAmount(app.cdp, '6000');
    await app.cdp.evaluate("(function(){var i=document.getElementById('bc-inv-override-amt'); i.focus(); var ev=new CompositionEvent('compositionstart',{bubbles:true}); i.dispatchEvent(ev);})()");
    const updatesBeforeIme = (await snapshot(app.cdp)).updates;
    await pressKey(app.cdp, 'Enter');
    const afterImeEnter = await snapshot(app.cdp);
    requirePass(afterImeEnter.updates === updatesBeforeIme, 'Enter in input did not save', JSON.stringify(afterImeEnter));
    requirePass(afterImeEnter.wrapVisible === true, 'Enter in input did not collapse', JSON.stringify(afterImeEnter));
    await app.cdp.evaluate("(function(){var i=document.getElementById('bc-inv-override-amt'); var ev=new CompositionEvent('compositionend',{bubbles:true}); i.dispatchEvent(ev);})()");
    out.scenarios.push({ name: 'ime-enter-safe', ok: true });

    // blur during save
    await cdpInstallSlowWrapper(app.cdp, 300, null);
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    await app.cdp.evaluate("(function(){document.activeElement && document.activeElement.blur && document.activeElement.blur(); document.body.focus();})()");
    const success4 = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    requirePass(success4.mp.target.length === 1 && success4.mp.target[0].amount === 6000, 'blur did not cancel save', JSON.stringify(success4.mp));
    out.scenarios.push({ name: 'blur-safe', ok: true });
    await saveScreenshot(app, '04-success-final.png');

    // Escape cancel writes nothing
    await cdpInstallNormalWrapper(app.cdp);
    await expandOverride(app.cdp, false);
    await cdpSetAmount(app.cdp, '9999');
    const updatesBeforeEsc = (await snapshot(app.cdp)).updates;
    await pressKey(app.cdp, 'Escape');
    const escSnap = await snapshot(app.cdp);
    requirePass(escSnap.wrapVisible === false, 'escape collapses wrap', JSON.stringify(escSnap));
    requirePass(escSnap.toggle && escSnap.toggle.expanded === 'false', 'escape sync aria-expanded', JSON.stringify(escSnap.toggle));
    requirePass(escSnap.focus && escSnap.focus.id === 'bc-inv-toggle-override', 'escape returns focus to toggle', JSON.stringify(escSnap.focus));
    requirePass(escSnap.updates === updatesBeforeEsc, 'escape wrote nothing', JSON.stringify({ before: updatesBeforeEsc, after: escSnap.updates }));
    requirePass(escSnap.mp.target.length === 1 && escSnap.mp.target[0].amount === 6000, 'mp unchanged after escape', JSON.stringify(escSnap.mp));
    out.scenarios.push({ name: 'escape-cancel', ok: true });
    await saveScreenshot(app, '05-escape-cancel.png');

    // close but keep userData, relaunch to prove persistence read-back
    const userData = app.userData;
    const rawFiles = { command: app.command, exit: app.child.exitCode === null ? 0 : app.child.exitCode, cwd: ROOT.replace(/\\/g, '/'),
      stdout: fileRecord(app.stdoutFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode),
      stderr: fileRecord(app.stderrFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode) };
    await app.close(true);

    const app2 = await launch(userData);
    try {
      await navigate(app2, VIEWPORT);
      await overrideUi(app2.cdp);
      await app2.cdp.evaluate("(function(){ window.__xj018 = window.__xj018 || {}; window.__xj018.B = " + JSON.stringify(ids.B) + "; if (!Array.isArray(window.__xj018.toasts)) window.__xj018.toasts = []; if (!Array.isArray(window.__xj018.updates)) window.__xj018.updates = []; })()");
      await selectClientMonth(app2.cdp, ids.A, ym);
      const persisted = await snapshot(app2.cdp);
      requirePass(persisted.mp.target.length === 1 && persisted.mp.target[0].amount === 6000, 'restart read-back identical', JSON.stringify(persisted.mp));
      requirePass(persisted.clientBmp && persisted.clientBmp.some(m => m.month === '2099-01' && m.amount === 100), 'client B persisted isolation', JSON.stringify(persisted.clientBmp));
      out.scenarios.push({ name: 'restart-readback', ok: true });
    } finally {
      const rawFiles2 = { command: app2.command, exit: app2.child.exitCode === null ? 0 : app2.child.exitCode, cwd: ROOT.replace(/\\/g, '/'),
        stdout: fileRecord(app2.stdoutFile, app2.command, ROOT.replace(/\\/g, '/'), app2.child.exitCode === null ? 0 : app2.child.exitCode),
        stderr: fileRecord(app2.stderrFile, app2.command, ROOT.replace(/\\/g, '/'), app2.child.exitCode === null ? 0 : app2.child.exitCode) };
      Object.assign(out, { relaunch_raw: rawFiles2 });
      await app2.close(false);
    }
    Object.assign(out, { raw: rawFiles, ym, ids });
    return out;
  } finally {
    if (!out.relaunch_raw) await app.close(false);
  }
}

async function scenarioFailureRetry() {
  const app = await launch();
  const ym = nowYm();
  const out = { scenarios: [] };
  try {
    await navigate(app, VIEWPORT);
    const ids = await seedData(app.cdp, ym);
    await overrideUi(app.cdp);
    await selectClientMonth(app.cdp, ids.A, ym);
    await expandOverride(app.cdp, false);
    await cdpSetAmount(app.cdp, '2000');

    // force durable failure (returns {ok:false}, nothing written)
    await app.cdp.evaluate(`(function(){
      window.__xj018.failWrites = 0;
      window.__xj018.wrapper = async function(id, patch){
        window.__xj018.failWrites++;
        await new Promise(function(res){ setTimeout(res, 500); });
        return {ok:false, value:null, error:{code:'XJ_TEST_FORCED_FAILURE', message:'forced failure for acceptance'}};
      };
    })()`);
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    await sleep(120);
    let secondBlocked = false;
    try { await clickSelector(app.cdp, '#bc-inv-settle-override'); } catch (_) { secondBlocked = true; } // double click during failure path
    requirePass(secondBlocked === true, 'double click during failure blocked by disabled control', JSON.stringify({ secondBlocked }));
    const failed = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'error', 10000);
    requirePass(/月结保存失败/.test(failed.feedback.text), 'failure feedback visible', JSON.stringify(failed.feedback));
    requirePass(failed.input && failed.input.value === '2000', 'failure preserves input', JSON.stringify(failed.input));
    requirePass(failed.client === ids.A && failed.month === ym, 'failure preserves client+month', JSON.stringify({ client: failed.client, month: failed.month }));
    requirePass(failed.mp.target.length === 0, 'failure wrote nothing', JSON.stringify(failed.mp));
    const failCalls = await app.cdp.evaluate("window.__xj018.failWrites || 0");
    requirePass(failCalls === 1, 'double click during failure blocked', JSON.stringify({ failCalls }));
    out.scenarios.push({ name: 'failure-fail-closed', ok: true });
    await saveScreenshot(app, '06-failure.png');

    // retry succeeds after storage restored
    await app.cdp.evaluate("window.__xj018.wrapper = null;");
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    const retried = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    requirePass(retried.mp.target.length === 1 && retried.mp.target[0].amount === 2000, 'retry after failure succeeds', JSON.stringify(retried.mp));
    out.scenarios.push({ name: 'retry-after-failure', ok: true });
    await saveScreenshot(app, '07-retry-success.png');

    out.raw = { command: app.command, exit: app.child.exitCode === null ? 0 : app.child.exitCode, cwd: ROOT.replace(/\\/g, '/'),
      stdout: fileRecord(app.stdoutFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode),
      stderr: fileRecord(app.stderrFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode) };
    return out;
  } finally {
    await app.close(false);
  }
}

async function scenarioStaleAsyncClientSwitch() {
  const app = await launch();
  const ym = nowYm();
  const out = { scenarios: [] };
  try {
    await navigate(app, VIEWPORT);
    const ids = await seedData(app.cdp, ym);
    await overrideUi(app.cdp);
    await selectClientMonth(app.cdp, ids.A, ym);
    await expandOverride(app.cdp, false);
    await cdpSetAmount(app.cdp, '1500');
    await app.cdp.evaluate(`(function(){
      window.__xj018.wrapper = async function(id, patch){
        await new Promise(function(res){ setTimeout(res, 600); });
        return window.__xj018.origUpdate(id, patch);
      };
    })()`);
    await clickSelector(app.cdp, '#bc-inv-settle-override');
    await sleep(120);
    // switch UI to client B while A save is in flight
    await selectClientMonth(app.cdp, ids.B, ym);
    const switched = await snapshot(app.cdp);
    requirePass(switched.client === ids.B, 'ui switched to B during in-flight save', JSON.stringify({ client: switched.client }));
    const success = await waitForState(app.cdp, s => s.feedback && s.feedback.state === 'success', 10000);
    const aMp = await app.cdp.evaluate(`(function(){ var c=Store.getClient(${JSON.stringify(ids.A)}); return (c.billing && c.billing.monthlyPayments)||[]; })()`);
    const bMp = await app.cdp.evaluate(`(function(){ var c=Store.getClient(${JSON.stringify(ids.B)}); return (c.billing && c.billing.monthlyPayments)||[]; })()`);
    requirePass(aMp.filter(m => m.month === ym).length === 1 && aMp.filter(m => m.month === ym)[0].amount === 1500, 'in-flight save captured client A', JSON.stringify(aMp));
    requirePass(bMp.some(m => m.month === '2099-01' && m.amount === 100), 'client B untouched by stale async', JSON.stringify(bMp));
    out.scenarios.push({ name: 'stale-async-client-switch', ok: true });
    out.raw = { command: app.command, exit: app.child.exitCode === null ? 0 : app.child.exitCode, cwd: ROOT.replace(/\\/g, '/'),
      stdout: fileRecord(app.stdoutFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode),
      stderr: fileRecord(app.stderrFile, app.command, ROOT.replace(/\\/g, '/'), app.child.exitCode === null ? 0 : app.child.exitCode) };
    return out;
  } finally {
    await app.close(false);
  }
}

async function cdpSetAmount(cdp, value) {
  await cdp.evaluate(`(function(){ var i=document.getElementById('bc-inv-override-amt'); if(i){ i.value=${JSON.stringify(String(value))}; } })()`);
}
async function cdpInstallSlowWrapper(cdp, delayMs, recorder) {
  await cdp.evaluate(`(function(){
    window.__xj018.wrapper = async function(id, patch){
      ${recorder || makeWrapperCallsRecorder()}
      await new Promise(function(res){ setTimeout(res, ${Number(delayMs)||300}); });
      return window.__xj018.origUpdate(id, patch);
    };
  })()`);
}
async function cdpInstallNormalWrapper(cdp) {
  await cdp.evaluate("window.__xj018.wrapper = null;");
}
async function saveScreenshot(app, name) {
  const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const image = Buffer.from(shot.data, 'base64');
  const imagePath = path.join(EVIDENCE, name);
  fs.writeFileSync(imagePath, image);
  return { path: imagePath.replace(/\\/g, '/'), bytes: image.length, sha256: sha256(image) };
}
function requirePass(ok, name, detail) {
  if (!ok) throw new Error(name + ': ' + detail);
}

async function main() {
  const results = [];
  let exit = 0;
  const runs = [
    { name: 'keyboard-success-add-persistence-restart', fn: scenarioKeyboardSuccessAddPersistenceRestart },
    { name: 'failure-retry', fn: scenarioFailureRetry },
    { name: 'stale-async-client-switch', fn: scenarioStaleAsyncClientSwitch },
  ];
  for (const run of runs) {
    try {
      const detail = await run.fn();
      results.push({ scenario: run.name, ok: true, detail });
      console.log('PASS', run.name);
    } catch (error) {
      exit = 1;
      results.push({ scenario: run.name, ok: false, error: error.stack || error.message });
      console.error('FAIL', run.name, '\n', error.stack || error.message);
    }
  }
  const screenshots = [];
  for (const file of fs.readdirSync(EVIDENCE).filter(f => f.endsWith('.png')).sort()) {
    const image = fs.readFileSync(path.join(EVIDENCE, file));
    screenshots.push({ file, bytes: image.length, sha256: sha256(image) });
  }
  // aggregate console/page errors from the last run's cdp events (each scenario collects its own via raw)
  const output = { task: TASK, url: URL, card_sha256: CARD_SHA, production_file: 'app/js/billing-calendar.js', command_cwd: ROOT.replace(/\\/g, '/'), reduced_motion: true, viewport: VIEWPORT, results, screenshots };
  const outPath = path.join(EVIDENCE, 'runtime-electron-cdp.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outPath.replace(/\\/g, '/'), results: results.map(item => ({ scenario: item.scenario, ok: item.ok })), screenshots: screenshots.map(s => s.file) }, null, 2));
  process.exitCode = exit;
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else {
  module.exports = { ROOT, TASK, CARD_SHA, OUT, RAW, EVIDENCE, URL, VIEWPORT, sha256, fileRecord, sleep, nowYm, launch, navigate, clickSelector, pressKey, snapshot, seedData, overrideUi, selectClientMonth, expandOverride, cdpSetAmount, cdpInstallSlowWrapper, cdpInstallNormalWrapper, saveScreenshot, requirePass, waitForState };
}
