'use strict';

/* 005: fresh real-Electron visual matrix.  This file is intentionally self-contained
 * and writes only the 005 evidence directory. */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const TASK_ID = 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005';
const EVIDENCE = path.join(ROOT, 'qa', 'task-scratch', TASK_ID, 'evidence');
const SHOTS = path.join(EVIDENCE, 'screenshots');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const VIEWPORTS = [[1024, 700], [1366, 768], [1920, 1080]];
const SKINS = ['clinical', 'theatre', 'observatory'];
const MODES = ['light', 'dark'];
const ROUTES = [
  { id: 'workbench', page: 'index.html' },
  { id: 'masters', page: 'masters.html' },
  { id: 'supervision', page: 'supervision.html' },
  { id: 'billing', page: 'billing-shell.html' },
  { id: 'calendar', page: 'billing-calendar.html' },
];

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex').toUpperCase(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function ensure(value, message) { if (!value) throw new Error(message); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function findPort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
async function waitTarget(port) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try {
      const xs = await getJson(`http://127.0.0.1:${port}/json/list`);
      const p = xs.find((x) => x.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(x.url || ''));
      if (p) return p;
    } catch (_) {}
    await delay(200);
  }
  throw new Error('Electron page target timeout');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
    const ws = new WebSocket(url); const pending = new Map(); const listeners = new Map(); let next = 1;
    const client = {
      send(method, params) { return new Promise((ok, bad) => { const id = next++; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params: params || {} })); }); },
      on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
      close() { try { ws.close(); } catch (_) {} },
    };
    ws.on('open', () => resolve(client));
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!m.id) { for (const fn of listeners.get(m.method) || []) { try { fn(m.params || {}); } catch (_) {} } return; }
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.bad(new Error(m.error.message || 'CDP error')) : p.ok(m.result || {});
    });
    ws.on('error', reject); ws.on('close', () => { for (const p of pending.values()) p.bad(new Error('CDP closed')); pending.clear(); });
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const started = new Date().toISOString();
  const port = await findPort();
  const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
  const userData = fs.mkdtempSync(path.join(tempRoot, 'xj511-005-'));
  const mockDataDir = fs.mkdtempSync(path.join(tempRoot, 'xj511-005-acct-'));
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const mock = createServer({ dataFile: path.join(mockDataDir, 'accounts.sqlite'), host: '127.0.0.1', port: 0 });
  const accountPort = await mock.listen();
  const argv = ['--disable-gpu', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, ROOT];
  const child = childProcess.spawn(ELECTRON, argv, { cwd: ROOT, env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData, XJ_ACCOUNT_API_BASE: `http://127.0.0.1:${accountPort}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let launcherStdout = ''; let launcherStderr = '';
  child.stdout.on('data', (c) => { launcherStdout += c.toString(); }); child.stderr.on('data', (c) => { launcherStderr += c.toString(); });
  const result = { task_id: TASK_ID, run_id: `run-${Date.now()}`, command: ELECTRON, argv, cwd: ROOT, user_data: userData, started_at: started, cells: [], source: {}, errors: [] };
  let cdp;
  try {
    const target = await waitTarget(port); result.target_url = target.url;
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    cdp.on('Runtime.exceptionThrown', (e) => result.errors.push({ kind: 'page', text: e.exceptionDetails?.text || 'exception' }));
    cdp.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error' || e.type === 'assert') result.errors.push({ kind: 'console', text: (e.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 400) }); });
    cdp.on('Log.entryAdded', (e) => { if (e.entry?.level === 'error' && !/ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE/.test(e.entry.text || '')) result.errors.push({ kind: 'log', text: e.entry.text || '' }); });
    const evaluate = async (expression) => { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'renderer evaluation failed'); return r.result?.value; };
    for (let i = 0; i < 80; i += 1) { if (await evaluate("typeof window.__XJ_API__ === 'object' && !!window.__XJ_API__.account")) break; await delay(100); }
    const email = `xj005-${Date.now()}@example.invalid`; const password = 'HermesPass005!';
    const registered = await evaluate(`window.__XJ_API__.account.register(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    ensure(registered && registered.ok === true, 'synthetic account registration failed');
    const mail = mock.mailer.peek(); const verificationToken = mail[mail.length - 1] && mail[mail.length - 1].verificationToken;
    ensure(typeof verificationToken === 'string' && verificationToken.length > 0, 'synthetic verification token missing');
    const verified = await evaluate(`window.__XJ_API__.account.verify(${JSON.stringify(verificationToken)})`);
    ensure(verified && verified.ok === true, 'synthetic account verification failed');
    const logged = await evaluate(`window.__XJ_API__.account.login(${JSON.stringify(email)}, ${JSON.stringify(password)})`);
    ensure(logged && logged.ok === true, 'synthetic account login failed');
    const navigate = async (page) => { await cdp.send('Page.navigate', { url: `${new URL(result.target_url).origin}/${page}` }); for (let i = 0; i < 120; i++) { if (await evaluate(`document.readyState === 'complete' && location.pathname.endsWith(${JSON.stringify('/' + page)})`)) { await delay(100); return; } await delay(100); } throw new Error(`navigation timeout: ${page}`); };
    const setTheme = async (skin, mode) => { await evaluate(`(() => { localStorage.setItem('xj_skin', ${JSON.stringify(skin)}); localStorage.setItem('xj_theme', ${JSON.stringify(mode)}); document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)}); document.documentElement.classList.toggle('dark', ${JSON.stringify(mode)} === 'dark'); return true; })()`); await delay(80); };
    const capture = async (name) => { const x = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); const b = Buffer.from(x.data, 'base64'); const file = path.join(SHOTS, name); fs.writeFileSync(file, b); return { path: file, relativePath: path.relative(EVIDENCE, file).replace(/\\/g, '/'), sha256: sha256(b), bytes: b.length }; };
    const metrics = async () => evaluate(`(() => { const root=document.documentElement; const vw=innerWidth,vh=innerHeight; const els=[...document.querySelectorAll('*')]; let clipped=0; for(const e of els){const r=e.getBoundingClientRect(); if(r.width>0&&r.height>0&&(r.right>vw+1||r.bottom>vh+1||r.left<-1||r.top<-1)) clipped++;} const a=document.activeElement; const ac=getComputedStyle(a||document.body); const allAnimations=document.getAnimations ? document.getAnimations() : []; const animations=allAnimations.filter(x=>x.playState==='running' && Number(x.effect?.getComputedTiming?.().duration||0)>1).length; const host=document.querySelector('main,.main,.workspace,.page-shell')||document.body; return { page: location.pathname.split('/').pop(), title: document.title, viewport:{width:vw,height:vh}, overflow:{horizontal:{scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,hasHorizontalOverflow:root.scrollWidth>root.clientWidth+1},vertical:{scrollHeight:root.scrollHeight,clientHeight:root.clientHeight,hasVerticalOverflow:root.scrollHeight>root.clientHeight+1},clippedCount:clipped}, reducedMotion:{mqMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,animationCount:animations,rawAnimationCount:allAnimations.length,method:'running animations with duration > 1ms after settle'}, keyboardFocus:{hasFocus:!!a&&a!==document.body,activeTag:a?.tagName||'BODY',activeId:a?.id||'',focusVisible:!!(a&& (a.matches(':focus-visible')||ac.outlineStyle!=='none'))}, skin:document.documentElement.getAttribute('data-skin'), dark:document.documentElement.classList.contains('dark'), textLength:(document.body.innerText||'').length, hostWidth:host.getBoundingClientRect().width }; })()`);
    const longProbe = async () => evaluate(`(() => { const host=document.querySelector('main,.main,.workspace,.page-shell')||document.body; const p=document.createElement('div'); p.id='xj-005-long-probe'; p.style.cssText='max-width:100%;overflow-wrap:anywhere;white-space:normal;padding:8px;'; p.textContent='用于 005 视觉验收的连续长中文文本'.repeat(80); host.appendChild(p); const r=p.getBoundingClientRect(), root=document.documentElement; const out={width:r.width,height:r.height,wrapped:r.height>50,pageOverflow:root.scrollWidth>root.clientWidth+1}; p.remove(); return out; })()`);
    const keyboard = async () => { const keys = ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Escape']; for (const key of keys) { const parts=key.split('+'); const k=parts.pop(); for(const p of parts) await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:p,code:p}); await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:k,code:k}); await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:k,code:k}); for(const p of parts.reverse()) await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:p,code:p}); await delay(30); } return evaluate(`(() => { const a=document.activeElement; const c=a?getComputedStyle(a):null; return {hasFocus:!!a&&a!==document.body,activeTag:a?.tagName||'BODY',activeId:a?.id||'',focusVisible:!!(a&&(a.matches(':focus-visible')||(c&&c.outlineStyle!=='none')))}; })()`); };
    const operationTrace = async (route) => { const trace=[{action:'navigate',route:route.page,ok:true}]; if(route.id==='masters'){ const before=await evaluate(`(() => { const els=[...document.querySelectorAll('button,[role=button]')].filter(e=>/视角|折叠|收起|展开|恢复|panel|fold|toggle/i.test((e.textContent||'')+' '+(e.id||'')+' '+(e.getAttribute('aria-label')||''))); return els.map(e=>({id:e.id||'',text:(e.textContent||'').trim().slice(0,40),visible:!!(e.offsetWidth||e.offsetHeight)})); })()`); trace.push({action:'masters-controls-discovered',count:before.length,ok:true}); } if(route.id==='supervision'){ const n=await evaluate(`(() => [...document.querySelectorAll('input[type=file],button,[role=button]')].filter(e=>/上传|材料|upload/i.test((e.textContent||'')+' '+(e.id||'')+' '+(e.getAttribute('aria-label')||''))).length)()`); trace.push({action:'upload-entry-visible',count:n,ok:n>0}); } if(route.id==='billing'){ const ids=await evaluate(`(() => ['bf-add-income','bf-add-expense','bc-inv-settle','bc-calendar-prev','bc-calendar-next'].map(id=>({id,found:!!document.getElementById(id),visible:!!document.getElementById(id)&&!!(document.getElementById(id).offsetWidth||document.getElementById(id).offsetHeight)})))()`); trace.push({action:'billing-entry-probe',ids,ok:true}); } return trace; };
    for (const [width, height] of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (const skin of SKINS) for (const mode of MODES) {
        const cellId = `${width}x${height}-${skin}-${mode}`; const cell = { schemaVersion:'v1-nested-fields', cellId, viewport:{width,height}, skin, mode, pageLabel:'ui-functional-closure', operationTrace:[], routes:[], overflow:{}, errors:{page:0,console:0}, reducedMotion:{}, keyboardFocus:{}, longChinese:{}, screenshots:[], pass:false };
        const errorStart = result.errors.length;
        for (const route of ROUTES) { await navigate(route.page); await setTheme(skin, mode); await delay(220); const op=await operationTrace(route); cell.operationTrace.push(...op); const m=await metrics(); const l=await longProbe(); const shot=await capture(`matrix-${cellId}-${route.id}.png`); cell.routes.push({ route:route.id, page:route.page, metrics:m, longChinese:l, screenshot:shot }); }
        await navigate('index.html'); await setTheme(skin, mode); await delay(220); const fm=await metrics(); cell.overflow=fm.overflow; cell.reducedMotion=fm.reducedMotion; cell.keyboardFocus=await keyboard(); cell.longChinese=await longProbe(); cell.screenshots=cell.routes.map((r)=>r.screenshot); const errs=result.errors.slice(errorStart); cell.errors={page:errs.filter(e=>e.kind==='page').length,console:errs.filter(e=>e.kind!=='page').length,details:errs}; cell.pass=cell.routes.length===ROUTES.length && cell.routes.every(r=>!r.metrics.overflow.horizontal.hasHorizontalOverflow && !r.metrics.overflow.vertical.hasVerticalOverflow && r.longChinese.wrapped && !r.longChinese.pageOverflow) && !cell.overflow.horizontal.hasHorizontalOverflow && !cell.overflow.vertical.hasVerticalOverflow && cell.reducedMotion.mqMatches===true && cell.reducedMotion.animationCount===0 && cell.longChinese.wrapped===true && cell.longChinese.pageOverflow===false && cell.errors.page===0 && cell.errors.console===0; result.cells.push(cell); }
    }
    result.matrix={count:result.cells.length,pass:result.cells.filter(c=>c.pass).length,allPass:result.cells.length===18&&result.cells.every(c=>c.pass)};
    result.source={electron:ELECTRON,mainSha256:sha256(fs.readFileSync(path.join(ROOT,'main.js'))),servedOrigin:new URL(result.target_url).origin};
    result.pass=result.matrix.allPass;
  } catch (error) { result.error=String(error.stack||error); result.pass=false; }
  finally {
    result.launcherStdoutTail=launcherStdout.slice(-2000); result.launcherStderrTail=launcherStderr.slice(-2000); result.ended_at=new Date().toISOString();
    writeJson(path.join(EVIDENCE,'matrix.json'), result);
    try { if(cdp){ await cdp.send('Browser.close').catch(()=>{}); cdp.close(); } } catch (_) {}
    try { child.kill(); } catch (_) {}
    try { fs.rmSync(userData,{recursive:true,force:true}); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(mockDataDir,{recursive:true,force:true}); } catch (_) {}
    console.log(JSON.stringify({ task_id:TASK_ID, cells:result.cells.length, pass:result.pass, matrix:result.matrix, error:result.error||null }, null, 2));
  }
  process.exitCode=result.pass?0:1;
}
main().catch((e)=>{ console.error(e.stack||e); process.exitCode=1; });
