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
const SCRATCH = path.resolve(process.env.XJ_EVIDENCE_ROOT || path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-masters-fold-fix-003'));
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-masters-fold-fix-003';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const RUN_ROOT = path.join(SCRATCH, 'runtime', RUN_ID);
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value), 'utf8'); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }
function writeBuffer(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function now() { return new Date().toISOString(); }

const CLEANUP_WAIT_MS = 1800;
const CLEANUP_KILL_WAIT_MS = 2500;

function processSnapshot() {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
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
  const found = [];
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length) {
    const pid = Number(queue.shift());
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const item = snapshot.find((candidate) => Number(candidate.ProcessId) === pid);
    if (item) found.push(item);
    for (const child of byParent.get(pid) || []) queue.push(Number(child.ProcessId));
  }
  return found;
}

function processInfo(snapshot, pid) {
  return snapshot.find((item) => Number(item.ProcessId) === Number(pid)) || null;
}

function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isConfirmedElectron(info, userData, port, processRoot) {
  if (!info) return false;
  const name = String(info.Name || '').toLowerCase();
  const commandLine = String(info.CommandLine || '').toLowerCase();
  const dataPath = normalizedPath(userData);
  return (name === 'electron.exe' || name.endsWith('\\electron.exe'))
    && commandLine.includes(dataPath)
    && commandLine.includes('--remote-debugging-port=' + String(port).toLowerCase())
    && commandLine.includes(normalizedPath(processRoot));
}

function killConfirmedTree(pid) {
  const result = cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  return {
    command: ['taskkill.exe', '/PID', String(pid), '/T', '/F'],
    exitCode: result.status == null ? null : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

async function waitForProcessExit(proc, timeoutMs) {
  if (!proc || proc.exitCode != null) return { exited: true, code: proc.exitCode, signal: proc.signalCode || null };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const onExit = (code, signal) => finish({ exited: true, code: code == null ? null : code, signal: signal || null });
    const timer = setTimeout(() => finish({ exited: false, code: null, signal: null }), timeoutMs);
    proc.once('exit', onExit);
  });
}

async function waitForTreeGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = processSnapshot();
  while (Date.now() < deadline) {
    const tree = processTree(snapshot, pid);
    if (Array.isArray(tree) && tree.length === 0) return { gone: true, tree: [] };
    await sleep(100);
    snapshot = processSnapshot();
  }
  const tree = processTree(snapshot, pid);
  return { gone: Array.isArray(tree) && tree.length === 0, tree };
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function choosePort() {
  for (let port = 9560; port < 9620; port += 1) if (await portAvailable(port)) return port;
  throw new Error('no free loopback CDP port');
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
  throw new Error('CDP page target did not appear');
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
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
        else pending.resolve(message.result || {});
      }
    });
    return this;
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
  const deadline = Date.now() + (timeoutMs || 20000);
  let lastError = null;
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, expression, true)) return true; } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

function normalizeGrid(value) {
  return String(value || '').replace(/0px/g, '0').replace(/minmax\(0px, 1fr\)/g, 'minmax(0, 1fr)').replace(/\s+/g, ' ').trim();
}
function tracks(value) {
  return String(value || '').split(/\s+/).map((item) => Number.parseFloat(item)).filter(Number.isFinite);
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
  const text = consoleErrorText(item);
  return /Electron sandboxed_renderer\.bundle\.js script failed to run/i.test(text)
    || /Cannot destructure property 'preloadScripts' of 'binding\.startupData' as it is null/i.test(text);
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
  if (bytes.length < 1024) throw new Error('screenshot too small');
  writeBuffer(file, bytes);
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

async function probe(cdp, stage) {
  return evaluate(cdp, `(() => {
    const el = (id) => document.getElementById(id);
    const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    const workspace = document.querySelector('.masters-workspace');
    const chat = el('chat-panel');
    const left = el('master-source-panel');
    const right = el('master-inspector-panel');
    const leftButton = el('masters-collapse-left');
    const rightButton = el('masters-collapse-right');
    const hit = (node) => { const r = rect(node); if (!r || r.width <= 0 || r.height <= 0) return null; const hitNode = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hitNode ? { id: hitNode.id || '', tag: hitNode.tagName, className: String(hitNode.className || '') } : null; };
    const body = el('chat-body');
    return {
      stage: ${JSON.stringify(stage)},
      url: location.href,
      readyState: document.readyState,
      grid: workspace ? getComputedStyle(workspace).gridTemplateColumns : '',
      normalizedGrid: workspace ? getComputedStyle(workspace).gridTemplateColumns.replace(/0px/g, '0').replace(/minmax\\(0px, 1fr\\)/g, 'minmax(0, 1fr)').replace(/\\s+/g, ' ').trim() : '',
      dialogue: rect(chat), left: rect(left), right: rect(right),
      leftClass: left ? left.className : '', rightClass: right ? right.className : '', bodyClass: document.body.className,
      leftButton: leftButton ? { expanded:leftButton.getAttribute('aria-expanded'), label:leftButton.getAttribute('aria-label'), title:leftButton.title, disabled:!!leftButton.disabled, hit:hit(leftButton) } : null,
      rightButton: rightButton ? { expanded:rightButton.getAttribute('aria-expanded'), label:rightButton.getAttribute('aria-label'), title:rightButton.title, disabled:!!rightButton.disabled, hit:hit(rightButton) } : null,
      activeElement: document.activeElement ? { id: document.activeElement.id || '', tag: document.activeElement.tagName, focusVisible: document.activeElement.matches ? document.activeElement.matches(':focus-visible') : false } : null,
      longText: body ? { clientWidth:body.clientWidth, scrollWidth:body.scrollWidth, overflow:body.scrollWidth > body.clientWidth + 1 } : null,
      animationCount: document.getAnimations ? document.getAnimations().length : -1,
      animations: document.getAnimations ? document.getAnimations().map((item) => {
        const effect = item.effect;
        const target = effect && effect.target;
        const timing = effect && effect.getComputedTiming ? effect.getComputedTiming() : {};
        return {
          playState: item.playState,
          animationName: target ? getComputedStyle(target).animationName : '',
          animationDuration: target ? getComputedStyle(target).animationDuration : '',
          duration: timing.duration,
          targetClass: target ? String(target.className || '') : '',
        };
      }) : [],
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);
}

async function buttonPoint(cdp, selector) {
  const info = await evaluate(cdp, `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; const r=b.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2, width:r.width, height:r.height, disabled:!!b.disabled, display:getComputedStyle(b).display, visibility:getComputedStyle(b).visibility }; })()`);
  if (!info || info.disabled || info.display === 'none' || info.visibility === 'hidden' || info.width <= 0 || info.height <= 0) throw new Error('button unavailable: ' + selector);
  return info;
}

async function trustedClick(cdp, selector, log) {
  const info = await buttonPoint(cdp, selector);
  log.push({ type:'trusted-click', selector, x:info.x, y:info.y, at:now() });
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:info.x, y:info.y });
  await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:info.x, y:info.y, button:'left', clickCount:1 });
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:info.x, y:info.y, button:'left', clickCount:1 });
  await sleep(150);
}

async function focusButton(cdp, selector) {
  await evaluate(cdp, `(() => { const b=document.querySelector(${JSON.stringify(selector)}); if(!b) return false; b.focus({ preventScroll:true }); return document.activeElement === b; })()`);
}

async function keyActivate(cdp, selector, key, log) {
  await focusButton(cdp, selector);
  log.push({ type:'key', selector, key, at:now() });
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const domKey = key === 'Enter' ? 'Enter' : ' ';
  const vk = key === 'Enter' ? 13 : 32;
  await cdp.send('Input.dispatchKeyEvent', { type:'rawKeyDown', key:domKey, code, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk });
  await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:domKey, code, windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk });
  await sleep(150);
}

async function keyEscape(cdp, log) {
  log.push({ type:'key', key:'Escape', at:now() });
  await cdp.send('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
  await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27, nativeVirtualKeyCode:27 });
  await sleep(150);
}

async function injectLongChinese(cdp) {
  return evaluate(cdp, `(() => {
    const body=document.getElementById('chat-body'); if(!body) return false;
    body.innerHTML='';
    for(let i=0;i<6;i++){
      const row=document.createElement('div'); row.className='msg ai';
      row.innerHTML='<div class="av">师</div><div class="body"><div class="sender"></div><div class="bubble"></div></div>';
      row.querySelector('.sender').textContent='合成大师'+(i+1);
      row.querySelector('.bubble').textContent='长中文验收内容：这是用于验证折叠布局、上下排列与换行的合成消息。'.repeat(12);
      body.appendChild(row);
    }
    return body.querySelectorAll('.msg').length === 6;
  })()`);
}

async function createSession(viewport, options) {
  options = options || {};
  const processRoot = options.root || ROOT;
  const appRoot = options.appRoot || APP_ROOT;
  const electron = options.electron || ELECTRON;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-512-masters-003-'));
  const port = await choosePort();
  const args = [
    '--disable-gpu',
    '--user-data-dir=' + userData,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
    processRoot,
  ];
  const proc = cp.spawn(electron, args, { cwd:processRoot, windowsHide:true, stdio:['ignore','pipe','pipe'], env:Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE:'1', XJ_AGENT_ACCEPTANCE_USER_DATA:userData }) });
  let stdout=''; let stderr='';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await findPageTarget(port);
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
  const consoleErrors=[]; const pageErrors=[];
  cdp.send('Runtime.enable'); cdp.send('Page.enable'); cdp.send('Network.enable'); cdp.send('Log.enable');
  cdp.ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params && msg.params.exceptionDetails || {});
    if (msg.method === 'Runtime.consoleAPICalled' && ['error','assert'].includes(msg.params && msg.params.type)) consoleErrors.push(msg.params);
    if (msg.method === 'Log.entryAdded' && msg.params && msg.params.entry && msg.params.entry.level === 'error') consoleErrors.push(msg.params.entry);
  });
  await cdp.send('Network.setBlockedURLs', { urls:['http://*/*','https://*/*','ws://*/*','wss://*/*'] });
  await cdp.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
  await cdp.send('Page.navigate', { url:pathToFileURL(path.join(appRoot, 'masters.html')).href });
  await waitFor(cdp, "document.readyState === 'complete' && !!document.querySelector('.masters-workspace') && !!document.getElementById('masters-collapse-left') && typeof window.toggleMasterPanel === 'function'", 'masters page');
  await setViewport(cdp, viewport);
  await sleep(300);
  let closed = false;
  return {
    userData, port, args, proc, cdp, stdout:() => stdout, stderr:() => stderr, consoleErrors, pageErrors,
    async close() {
      if (closed) return { ok:true, alreadyClosed:true, rootExited:true, treeExited:true, userDataRemoved:true };
      closed = true;
      const cleanup = {
        ok:false, userData, rootPid:proc.pid, port,
        closeRequested:false, naturalExit:false, forcedKill:false,
        rootConfirmed:false, treeExited:false, userDataRemoved:false,
        events:[], beforeKill:[], afterKill:[], error:null,
      };
      try {
        await Promise.race([evaluate(cdp, 'window.close(); true'), sleep(1200)]);
        cleanup.closeRequested = true;
        cleanup.events.push('window-close-requested');
      } catch (error) {
        cleanup.events.push('window-close-error:' + String(error.message || error));
      }
      try { cdp.close(); } catch (error) { cleanup.events.push('cdp-close-error:' + String(error.message || error)); }
      const natural = await waitForProcessExit(proc, CLEANUP_WAIT_MS);
      cleanup.naturalExit = natural.exited;
      cleanup.events.push(natural.exited ? 'electron-natural-exit' : 'electron-natural-exit-timeout');
      let snapshot = processSnapshot();
      let tree = processTree(snapshot, proc.pid);
      if (Array.isArray(tree) && tree.length === 0) {
        cleanup.rootConfirmed = true;
        cleanup.treeExited = true;
      } else if (!Array.isArray(tree)) {
        cleanup.error = 'unable to inspect Electron process tree';
        cleanup.events.push('process-tree-inspection-failed');
      } else {
        cleanup.beforeKill = tree.map((item) => ({ pid:Number(item.ProcessId), parentPid:Number(item.ParentProcessId), name:String(item.Name || ''), commandLine:String(item.CommandLine || '') }));
        const root = processInfo(snapshot, proc.pid);
        const confirmed = isConfirmedElectron(root, userData, port, processRoot);
        cleanup.rootConfirmed = confirmed;
        if (confirmed) {
          cleanup.forcedKill = true;
          const kill = killConfirmedTree(proc.pid);
          cleanup.events.push('taskkill-tree-exit-' + String(kill.exitCode));
          cleanup.kill = kill;
          const after = await waitForTreeGone(proc.pid, CLEANUP_KILL_WAIT_MS);
          snapshot = processSnapshot();
          tree = processTree(snapshot, proc.pid);
          cleanup.afterKill = Array.isArray(tree) ? tree.map((item) => ({ pid:Number(item.ProcessId), parentPid:Number(item.ParentProcessId), name:String(item.Name || ''), commandLine:String(item.CommandLine || '') })) : [];
          cleanup.treeExited = after.gone && Array.isArray(tree) && tree.length === 0;
        } else {
          cleanup.error = 'refused to terminate unconfirmed Electron process tree';
          cleanup.events.push('unsafe-process-target');
        }
      }
      if (!cleanup.treeExited) {
        cleanup.error = cleanup.error || 'Electron process tree did not exit within bounded cleanup window';
        cleanup.events.push('cleanup-incomplete');
      }
      if (cleanup.treeExited) {
        try {
          fs.rmSync(userData, { recursive:true, force:true });
          cleanup.userDataRemoved = !fs.existsSync(userData);
        } catch (error) {
          cleanup.error = 'userData removal failed: ' + String(error.message || error);
          cleanup.events.push('userData-remove-error');
        }
      } else {
        cleanup.events.push('userData-retained-for-safety');
      }
      cleanup.ok = cleanup.treeExited && cleanup.userDataRemoved;
      return cleanup;
    },
  };
}

function check(checks, label, pass, details) { checks.push({ label, pass:!!pass, details:details || null }); }

async function runViewport(viewport) {
  const session = await createSession(viewport);
  const checks=[]; const actions=[]; const evidence={ viewport, checks, actions, screenshots:[], startedAt:now(), command:[ELECTRON].concat(session.args), userData:session.userData };
  try {
    const initial = await probe(session.cdp, 'initial'); evidence.initial=initial;
    evidence.screenshots.push(await capture(session.cdp, path.join(RUN_ROOT, viewport.name + '-initial.png')));
    const initialTracks = tracks(initial.grid);
    check(checks, '初始中央工作区可见', initial.dialogue && initial.dialogue.width > 0, initial.dialogue);
    check(checks, '初始三栏轨道存在', initialTracks.length === 3 && initialTracks[1] > 0, initial.grid);
    check(checks, '低动效媒体查询生效', initial.reducedMotion === true, initial.reducedMotion);

    await trustedClick(session.cdp, '#masters-collapse-left', actions);
    const folded = await probe(session.cdp, 'left-folded'); evidence.folded=folded;
    evidence.screenshots.push(await capture(session.cdp, path.join(RUN_ROOT, viewport.name + '-left-folded.png')));
    const foldedTracks = tracks(folded.grid);
    check(checks, 'trusted click 折叠左栏', folded.leftButton && folded.leftButton.expanded === 'false' && folded.leftClass.includes('collapsed'), folded.leftButton);
    check(checks, '折叠后左轨道归零', foldedTracks.length === 3 && foldedTracks[0] === 0, folded.grid);
    check(checks, '折叠后中央工作区严格增宽', folded.dialogue.width > initial.dialogue.width + 10, { before:initial.dialogue.width, after:folded.dialogue.width });
    check(checks, '折叠按钮保留焦点且可见命中', folded.activeElement && folded.activeElement.id === 'masters-collapse-left' && folded.leftButton && folded.leftButton.hit, { active:folded.activeElement, hit:folded.leftButton && folded.leftButton.hit });

    await trustedClick(session.cdp, '#masters-collapse-left', actions);
    const restored = await probe(session.cdp, 'left-restored'); evidence.restored=restored;
    check(checks, '再次点击恢复左栏', restored.leftButton && restored.leftButton.expanded === 'true' && restored.leftClass.indexOf('collapsed') < 0, restored.leftButton);
    check(checks, '恢复后中央宽度回到基线', Math.abs(restored.dialogue.width - initial.dialogue.width) < 2, { before:initial.dialogue.width, after:restored.dialogue.width });

    await keyActivate(session.cdp, '#masters-collapse-left', 'Enter', actions);
    const enterFold = await probe(session.cdp, 'enter-folded'); evidence.enterFold=enterFold;
    check(checks, 'Enter 真切换折叠', enterFold.leftButton && enterFold.leftButton.expanded === 'false' && enterFold.dialogue.width > initial.dialogue.width + 10, enterFold);
    await keyActivate(session.cdp, '#masters-collapse-left', 'Space', actions);
    const spaceRestored = await probe(session.cdp, 'space-restored'); evidence.spaceRestored=spaceRestored;
    check(checks, 'Space 真切换恢复', spaceRestored.leftButton && spaceRestored.leftButton.expanded === 'true' && Math.abs(spaceRestored.dialogue.width - initial.dialogue.width) < 2, spaceRestored);

    await trustedClick(session.cdp, '#masters-collapse-left', actions);
    await keyEscape(session.cdp, actions);
    const escapeRestored = await probe(session.cdp, 'escape-restored'); evidence.escapeRestored=escapeRestored;
    check(checks, 'Escape 后折叠状态一致恢复', escapeRestored.leftButton && escapeRestored.leftButton.expanded === 'true' && !escapeRestored.leftClass.includes('collapsed') && Math.abs(escapeRestored.dialogue.width - initial.dialogue.width) < 2, escapeRestored);

    await injectLongChinese(session.cdp);
    const long = await probe(session.cdp, 'long-cn'); evidence.long=long;
    check(checks, '长中文无横向溢出', long.longText && long.longText.overflow === false, long.longText);
    check(checks, 'CSS 低动效无动画', long.animationCount === 0, long.animationCount);
    check(checks, '圆桌消息保持纵向排列', await evaluate(session.cdp, "(() => { const rows=[...document.querySelectorAll('#chat-body .msg')]; const tops=rows.map(r=>r.getBoundingClientRect().top); return rows.length===6 && tops.every((v,i)=>i===0||v>tops[i-1]); })()"), null);
    const actionableConsoleErrors = session.consoleErrors.filter((item) => !isHarnessConsoleNoise(item));
    check(checks, '无页面/控制台错误', session.pageErrors.length === 0 && actionableConsoleErrors.length === 0, { page:session.pageErrors.length, console:actionableConsoleErrors.length, harnessNoise:session.consoleErrors.length - actionableConsoleErrors.length });
    evidence.status = checks.every((item) => item.pass) ? 'PASS' : 'FAIL';
    evidence.actionableConsoleErrors = actionableConsoleErrors.map(consoleErrorText);
    evidence.consoleErrors = session.consoleErrors.map((item) => ({ type:item.type || '', text:item.text || '', args:item.args || [], entry:item.entry || null }));
    evidence.pageErrors = session.pageErrors.map((item) => ({ text:item.text || '', url:item.url || '', lineNumber:item.lineNumber || 0, columnNumber:item.columnNumber || 0 }));
  } catch (error) {
    evidence.status='ERROR'; evidence.error={ message:error.message, stack:error.stack };
    evidence.consoleErrors = session.consoleErrors;
    evidence.pageErrors = session.pageErrors;
  } finally {
    evidence.finishedAt=now();
    try {
      evidence.cleanup = await session.close();
      if (!evidence.cleanup || evidence.cleanup.ok !== true) evidence.status='ERROR';
    } catch (error) {
      evidence.cleanup = { ok:false, error:{ message:error.message, stack:error.stack } };
      evidence.status='ERROR';
    }
    evidence.stdoutFile=path.join(RUN_ROOT, viewport.name + '.stdout.txt');
    evidence.stderrFile=path.join(RUN_ROOT, viewport.name + '.stderr.txt');
    writeText(evidence.stdoutFile, session.stdout()); writeText(evidence.stderrFile, session.stderr());
    writeJson(path.join(RUN_ROOT, viewport.name + '.json'), evidence);
  }
  return evidence;
}

async function main() {
  ensureDir(RUN_ROOT);
  const results=[];
  for (const viewport of VIEWPORTS) results.push(await runViewport(viewport));
  const productionHashes={};
  for (const rel of ['app/masters.html','app/js/masters.js','app/css/masters-clinical.css']) {
    const bytes=fs.readFileSync(path.join(ROOT, rel)); productionHashes[rel]={ sha256:sha256(bytes), bytes:bytes.length };
  }
  const summary={ taskId:'XJ-5.1.2-masters-fold-fix-003', runId:RUN_ID, startedAt:now(), finishedAt:now(), networkPolicy:{ defaultDeny:true, loopbackOnly:true }, productionHashes, results, status:results.every((item)=>item.status==='PASS')?'PASS':'BLOCKED' };
  writeJson(path.join(RUN_ROOT, 'summary.json'), summary);
  console.log(JSON.stringify({ status:summary.status, runRoot:RUN_ROOT, productionHashes, results:results.map((item)=>({ viewport:item.viewport.name, status:item.status, failed:item.checks.filter((checkItem)=>!checkItem.pass).map((checkItem)=>checkItem.label) })) }, null, 2));
  process.exitCode=summary.status==='PASS'?0:2;
}

if (require.main === module) {
  main().catch((error)=>{ ensureDir(RUN_ROOT); writeJson(path.join(RUN_ROOT,'fatal.json'),{status:'BLOCKED',error:{message:error.message,stack:error.stack}}); console.error(error.stack || error.message); process.exitCode=2; });
}

module.exports = {
  ROOT, APP_ROOT, ELECTRON, RUN_ROOT, ensureDir, writeText, writeJson, sha256, sleep, now,
  evaluate, waitFor, setViewport, capture, probe, trustedClick, focusButton, keyActivate,
  injectLongChinese, createSession, keyEscape, isHarnessConsoleNoise, consoleErrorText,
};
