'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'electron-artifacts');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const THEMES = ['clinical', 'theatre', 'observatory'].flatMap((skin) => ['light', 'dark'].map((mode) => ({ skin, mode })));
const checks = [];

function check(id, label, condition, detail) {
  const pass = !!condition;
  checks.push({ id, label, pass, detail: detail || '' });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (detail ? ' - ' + detail : ''));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('HTTP timeout')));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function createCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} },
    }));
    socket.addEventListener('error', (event) => reject(event.error || event.message || event));
    socket.addEventListener('close', () => {
      const error = new Error('CDP closed before acceptance completed');
      pending.forEach((deferred) => deferred.reject(error));
      pending.clear();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else deferred.resolve(message.result);
    });
  });
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error('Timed out waiting for Electron page: ' + (lastError && lastError.message || 'unknown'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function navigate(cdp, origin, page) {
  await cdp.send('Page.navigate', { url: origin + '/' + page });
  await waitFor(cdp, 'document.readyState === "complete"', page + ' ready state');
  await waitFor(cdp, 'typeof window.LongitudinalSummary !== "undefined" && typeof window.loadTrajectory === "function" && document.getElementById("generate-preview")', page + ' application initialization');
}

async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await sleep(180);
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buffer = Buffer.from(result.data || '', 'base64');
  if (buffer.length < 1024) throw new Error('Screenshot unexpectedly small: ' + name);
  const file = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(file, buffer);
  return { name: path.basename(file), bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase() };
}

async function stopElectron(cdp, child) {
  try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
  for (let attempt = 0; child && child.exitCode === null && attempt < 30; attempt += 1) await sleep(100);
  if (child && child.exitCode === null) child.kill();
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron executable is absent');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xinjing-growth-acceptance-'));
  const port = await freePort();
  const runtimeErrors = [];
  let child;
  let cdp;
  const screenshots = [];

  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => runtimeErrors.push(String(chunk).trim()));

    const page = await waitForPage(port);
    const origin = new URL(page.url).origin;
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__XJ__={activated:true,tier:'pro',mode:'activated',aiUnlocked:true};window.__XJ_API__=Object.assign({},window.__XJ_API__||{},{getState:async function(){return window.__XJ__;}});",
    });

    check('E1', 'Electron main process exposes the app page through loopback', /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(page.url), page.url);
    await navigate(cdp, origin, 'doc-growth.html');
    check('E2', 'growth route observes reduced-motion preference', await evaluate(cdp, 'matchMedia("(prefers-reduced-motion: reduce)").matches === true'));

    const prepared = await evaluate(cdp, `(async function(){
      App.featureGate=function(){return true;}; App.hasAICompute=function(){return true;};
      Store.createClient({id:'growth-client',name:'Synthetic client'});
      Store.createSession({id:'growth-session-1',clientId:'growth-client',sessionNumber:1,date:'2026-01-01'});
      Store.createSession({id:'growth-session-2',clientId:'growth-client',sessionNumber:2,date:'2026-02-01'});
      Store.createMaterialWorkspace({id:'growth-material-1',title:'Synthetic material one',clientId:'growth-client',sessionId:'growth-session-1',parseStatus:'ready',extractedText:'SYNTHETIC_SOURCE_BODY_DO_NOT_RENDER'});
      Store.createMaterialWorkspace({id:'growth-material-2',title:'Synthetic material two',clientId:'growth-client',sessionId:'growth-session-2',parseStatus:'ready',extractedText:'SYNTHETIC_SOURCE_BODY_SECOND'});
      var sel=document.getElementById('sel-client'); var opt=document.createElement('option'); opt.value='growth-client'; opt.textContent='Synthetic client'; sel.appendChild(opt); sel.value='growth-client';
      App.featureGate=function(){return false;}; await window.loadTrajectory();
      var locked={disabled:document.getElementById('generate-preview').disabled,body:document.getElementById('trajectory-body').innerText};
      App.featureGate=function(){return true;}; App.hasAICompute=function(){return false;}; await window.loadTrajectory();
      var compute={disabled:document.getElementById('generate-preview').disabled,status:document.getElementById('growth-source-status').innerText};
      App.hasAICompute=function(){return true;}; await window.loadTrajectory();
      var projection=await CaseSpaceViewModel.refresh('growth-client',{currentContext:{clientId:'growth-client'}});
      var citations=projection.model.nodes.filter(function(node){return node.kind==='material'&&node.sourceStatus==='verified';}).map(function(node){return {nodeId:node.id,sourceId:node.sourceRef.id,sessionId:node.sessionId};});
      return {locked:locked,compute:compute,citations:citations,ready:!document.getElementById('generate-preview').disabled,body:document.getElementById('trajectory-body').innerText,sourceStatus:document.getElementById('growth-source-status').innerText};
    })()`);
    check('E3', 'locked state denies generation while retaining a useful preview', prepared.locked.disabled && prepared.locked.body.includes('需要 Pro 权益'));
    check('E4', 'compute-unavailable state stays distinct from entitlement denial', prepared.compute.disabled && prepared.compute.status.includes('AI 算力'));
    check('E5', 'two verified synthetic material sources make the primary action ready', prepared.ready && prepared.citations.length === 2 && prepared.sourceStatus.includes('已核对 2 个'));

    const success = await evaluate(cdp, `(async function(){
      var before={sessions:Store.getSessions().length,materials:Store.getMaterialWorkspaces().length,supervisions:Store.getSupervisions().length,runs:Store.getClinicalActionRuns().length};
      var citations=${JSON.stringify(prepared.citations)};
      AI.send=function(messages,done){window.__growthMessages=messages;setTimeout(function(){done({content:JSON.stringify({summary:'这是合成长中文预览，用于检查长文本与来源边界。'.repeat(8),changes:[{title:'合成变化线索',detail:'合成观察，不写入任何临床对象。'}],citations:citations})});},0);};
      document.getElementById('generate-preview').click();
      for(var i=0;i<80&&!document.getElementById('trajectory-body').innerText.includes('纵向摘要预览');i++){await new Promise(function(resolve){setTimeout(resolve,80);});}
      var after={sessions:Store.getSessions().length,materials:Store.getMaterialWorkspaces().length,supervisions:Store.getSupervisions().length,runs:Store.getClinicalActionRuns().length};
      var run=Store.getClinicalActionRuns().slice()[0]||{}; document.getElementById('generate-preview').focus();
      return {before:before,after:after,body:document.getElementById('trajectory-body').innerText,sourceInRequest:JSON.stringify(window.__growthMessages||[]).includes('SYNTHETIC_SOURCE_BODY_DO_NOT_RENDER'),focused:document.activeElement===document.getElementById('generate-preview'),run:run};
    })()`);
    check('E6', 'primary action renders only a validated preview with citations', success.body.includes('纵向摘要预览') && success.body.includes('引用来源') && !success.body.includes('SYNTHETIC_SOURCE_BODY_DO_NOT_RENDER'));
    check('E7', 'admitted source body reaches the AI request but never the DOM', success.sourceInRequest && !success.body.includes('SYNTHETIC_SOURCE_BODY_DO_NOT_RENDER'));
    check('E8', 'successful preview creates one metadata-only action run and no clinical object', success.after.runs === success.before.runs + 1 && success.after.sessions === success.before.sessions && success.after.materials === success.before.materials && success.after.supervisions === success.before.supervisions && success.run.task === 'growth-summary' && success.run.status === 'succeeded' && success.run.output && success.run.output.kind === 'growth-summary-preview' && !JSON.stringify(success.run).includes('合成长中文预览'), JSON.stringify(success));
    check('E9', 'primary action remains keyboard focusable after preview', success.focused);

    let visualIndex = 0;
    for (const viewport of VIEWPORTS) {
      await setViewport(cdp, viewport);
      for (const theme of THEMES) {
        visualIndex += 1;
        const visual = await evaluate(cdp, `(function(){var skin=${JSON.stringify(theme.skin)},mode=${JSON.stringify(theme.mode)};localStorage.setItem('xj_skin',skin);localStorage.setItem('xj_theme',mode);document.documentElement.setAttribute('data-skin',skin);document.documentElement.classList.toggle('dark',mode==='dark');var button=document.getElementById('generate-preview');return {overflow:document.documentElement.scrollWidth<=window.innerWidth&&document.body.scrollWidth<=window.innerWidth,visible:!!button&&button.getBoundingClientRect().width>0&&document.getElementById('trajectory-body').innerText.includes('纵向摘要预览'),skin:document.documentElement.getAttribute('data-skin'),mode:document.documentElement.classList.contains('dark')?'dark':'light'};})()`);
        check('V' + visualIndex, viewport.name + ' ' + theme.skin + ' ' + theme.mode + ' has no horizontal overflow or blank preview', visual.overflow && visual.visible && visual.skin === theme.skin && visual.mode === theme.mode);
        screenshots.push(await capture(cdp, 'doc-growth-' + viewport.name + '-' + theme.skin + '-' + theme.mode));
      }
    }

    const invalidCitation = await evaluate(cdp, `(async function(){
      AI.send=function(messages,done){setTimeout(function(){done({content:JSON.stringify({summary:'synthetic',citations:[{nodeId:'unknown',sourceId:'unknown',sessionId:'unknown'}]})});},0);};
      document.getElementById('generate-preview').click();
      for(var i=0;i<80&&!document.getElementById('trajectory-body').innerText.includes('AI 结果未通过来源校验');i++){await new Promise(function(resolve){setTimeout(resolve,80);});}
      return {body:document.getElementById('trajectory-body').innerText,retry:!document.getElementById('generate-preview').disabled};
    })()`);
    check('E10', 'unknown citation is rejected and the verified-source retry remains available', invalidCitation.body.includes('AI 结果未通过来源校验') && invalidCitation.retry);

    const stale = await evaluate(cdp, `(async function(){
      var projection=await CaseSpaceViewModel.refresh('growth-client',{currentContext:{clientId:'growth-client'}});
      var citations=projection.model.nodes.filter(function(node){return node.kind==='material'&&node.sourceStatus==='verified';}).map(function(node){return {nodeId:node.id,sourceId:node.sourceRef.id,sessionId:node.sessionId};});
      window.__growthStaleSend=false;
      AI.send=function(messages,done){window.__growthStaleSend=true;setTimeout(function(){done({content:JSON.stringify({summary:'synthetic',citations:citations})});},120);};
      document.getElementById('generate-preview').click();
      for(var sent=0;sent<40&&!window.__growthStaleSend;sent++){await new Promise(function(resolve){setTimeout(resolve,25);});}
      Store.updateMaterialWorkspace('growth-material-1',{extractedText:'SYNTHETIC_SOURCE_BODY_CHANGED'});
      for(var i=0;i<80&&!document.getElementById('trajectory-body').innerText.includes('预览已过期');i++){await new Promise(function(resolve){setTimeout(resolve,80);});}
      return {body:document.getElementById('trajectory-body').innerText,retry:!document.getElementById('generate-preview').disabled};
    })()`);
    check('E11', 'changed material invalidates the pending preview and permits a newly verified retry', stale.body.includes('预览已过期') && stale.retry, JSON.stringify(stale));
  } finally {
    if (cdp) {
      try { await stopElectron(cdp, child); } catch (_) {}
      cdp.close();
    } else if (child && child.exitCode === null) child.kill();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = checks.filter((item) => !item.pass);
  const summary = { task_id: 'XJ-5.0.0-codex-v4.4-longitudinal-summary-01', checks, failed: failed.length, screenshots, runtime_errors: runtimeErrors.filter(Boolean) };
  fs.writeFileSync(path.join(ARTIFACTS, 'runtime-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('Passed: ' + (checks.length - failed.length) + ' | Failed: ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack || error));
  process.exit(1);
});
