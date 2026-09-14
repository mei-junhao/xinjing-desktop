'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'electron-runtime-artifacts');
const VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];

const checks = [];
function check(id, label, condition, detail) {
  const pass = !!condition;
  checks.push({ id, label, pass, detail: detail || '' });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (detail ? ' - ' + detail : ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url, timeoutMs) {
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
    request.setTimeout(timeoutMs || 2000, () => request.destroy(new Error('HTTP timeout')));
  });
}

function findFreePort() {
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
    const listeners = new Map();
    let nextId = 1;
    socket.addEventListener('open', () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, listener) {
        const list = listeners.get(method) || [];
        list.push(listener);
        listeners.set(method, list);
      },
      close() {
        try { socket.close(); } catch (_) {}
      }
    }));
    socket.addEventListener('error', (event) => reject(event.error || event.message || event));
    socket.addEventListener('close', () => {
      const error = new Error('CDP connection closed before the acceptance flow completed');
      pending.forEach((deferred) => deferred.reject(error));
      pending.clear();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (message.id && pending.has(message.id)) {
        const deferred = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) deferred.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else deferred.resolve(message.result);
        return;
      }
      const list = listeners.get(message.method) || [];
      list.forEach((listener) => listener(message.params || {}));
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
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the controlled Electron main window: ' + (lastError && lastError.message || 'unknown error'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown error'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(150);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function navigate(cdp, origin, page) {
  await cdp.send('Page.navigate', { url: origin + '/' + page });
  await waitFor(cdp, 'document.readyState === "complete"', page + ' ready state');
  await sleep(500);
}

async function setViewport(cdp, viewport) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(200);
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buffer = Buffer.from(result.data || '', 'base64');
  if (buffer.length < 1024) throw new Error('Screenshot is unexpectedly small: ' + name);
  const target = path.join(ARTIFACTS, name + '.png');
  fs.writeFileSync(target, buffer);
  return {
    file: target,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase()
  };
}

async function buildSyntheticDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>咨询师：合成历史开场</w:t></w:r></w:p><w:p><w:r><w:t>来访者：合成历史回应</w:t></w:r></w:p></w:body></w:document>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const parsed = await mammoth.extractRawText({ buffer });
  if (!parsed.value.includes('合成历史开场') || !parsed.value.includes('合成历史回应')) throw new Error('Synthetic DOCX parser preflight failed');
  return buffer.toString('base64');
}

async function stopElectron(cdp, child) {
  try { await evaluate(cdp, 'window.close(); true'); } catch (_) {}
  for (let attempt = 0; attempt < 20 && child && child.exitCode === null; attempt += 1) await sleep(100);
  if (child && child.exitCode === null) child.kill();
}

async function main() {
  if (!fs.existsSync(ELECTRON)) throw new Error('Electron executable is absent');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xinjing-runtime-acceptance-'));
  const port = await findFreePort();
  const docxBase64 = await buildSyntheticDocx();
  const logs = [];
  let child;
  let cdp;

  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        XJ_AGENT_ACCEPTANCE: '1',
        XJ_AGENT_ACCEPTANCE_USER_DATA: userData
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (chunk) => logs.push(String(chunk).trim()));

    const page = await waitForPage(port);
    const origin = new URL(page.url).origin;
    cdp = await createCdp(page.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', (event) => logs.push('renderer exception: ' + JSON.stringify(event.exceptionDetails || {})));
    cdp.on('Log.entryAdded', (event) => {
      if (event.entry && event.entry.level === 'error') logs.push('renderer log: ' + event.entry.text);
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    check('E1', 'project main process served the initial page through loopback', /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(page.url), page.url);
    check('E2', 'acceptance page observes reduced-motion preference', await evaluate(cdp, 'matchMedia("(prefers-reduced-motion: reduce)").matches === true'));

    await navigate(cdp, origin, 'masters.html');
    await setViewport(cdp, VIEWPORTS[0]);
    await waitFor(cdp, 'document.querySelectorAll(".master-card").length > 0', 'masters list');
    const mastersResult = await evaluate(cdp, '(async function(){var card=document.querySelector(".master-card"); card.click(); await new Promise(function(resolve){setTimeout(resolve,350);}); var bytes=Uint8Array.from(atob(' + JSON.stringify(docxBase64) + '),function(ch){return ch.charCodeAt(0);}); var file=new File([bytes],"synthetic-history.docx",{type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}); var input=document.getElementById("masters-history-file"); var dt=new DataTransfer(); dt.items.add(file); Object.defineProperty(input,"files",{configurable:true,value:dt.files}); await window.onHistoryImport({target:input}); await new Promise(function(resolve){setTimeout(resolve,500);}); var imported=document.getElementById("chat-body").innerText; var bad=new File(["not-used"],"unsupported.pdf",{type:"application/pdf"}); var badDt=new DataTransfer(); badDt.items.add(bad); Object.defineProperty(input,"files",{configurable:true,value:badDt.files}); await window.onHistoryImport({target:input}); await new Promise(function(resolve){setTimeout(resolve,150);}); return {imported:imported, afterReject:document.getElementById("chat-body").innerText, localLabel:document.getElementById("source-scope").innerText};})()');
    check('E3', 'synthetic DOCX history imports into the active Masters conversation', mastersResult.imported.includes('合成历史开场') && mastersResult.imported.includes('合成历史回应'));
    check('E4', 'unsupported Masters import preserves the imported conversation', mastersResult.afterReject.includes('合成历史开场') && mastersResult.afterReject.includes('合成历史回应'));
    check('E5', 'Masters route labels the current local context', mastersResult.localLabel.includes('本次'));
    await capture(cdp, 'masters-docx-import-1024x700');

    await navigate(cdp, origin, 'supervision.html');
    await setViewport(cdp, VIEWPORTS[1]);
    await waitFor(cdp, 'document.getElementById("sup-client") && document.getElementById("sup-material")', 'supervision controls');
    const supervisionResult = await evaluate(cdp, '(async function(){App.canUse=function(){return true;}; App.hasAICompute=function(){return true;}; App.featureGate=function(){return true;}; if(window.ClinicalContextView){ClinicalContextView.confirmSend=function(){return true;};} AI.send=function(messages,done){setTimeout(function(){done({content:"【整体印象】\\n合成督导回应"});},0);}; var client=document.getElementById("sup-client"); client.value=""; window.onClientChange(); var material=document.getElementById("sup-material"); material.value="合成督导材料：用于本地验收。"; window.generateImpression(); for(var i=0;i<30&&!document.getElementById("sup-chat").innerText.includes("合成督导回应");i++){await new Promise(function(resolve){setTimeout(resolve,100);});} await window.saveSup(); await new Promise(function(resolve){setTimeout(resolve,250);}); var list=Store.getSupervisions?Store.getSupervisions():[]; var saved=list.slice(-1)[0]||{}; var runs=Store.getClinicalActionRuns?Store.getClinicalActionRuns():[]; var actionRun=runs.slice(-1)[0]||{}; var forged=Store.createClinicalActionRun({task:"report-ai-fill",status:"pending",origin:{},sources:[],snapshot:{}}); return {state:document.getElementById("sup-context-state").innerText, chat:document.getElementById("sup-chat").innerText, clientId:saved.clientId, sessionId:saved.sessionId, savedCount:list.length, savedType:saved.type||"", savedConclusion:saved.conclusion||"", actionTask:actionRun.task||"", actionStatus:actionRun.status||"", actionClientId:actionRun.origin&&actionRun.origin.clientId||"", actionSourceCount:(actionRun.sources||[]).length, forgedRejected:forged===null, pageText:document.body.innerText};})()');
    check('E6', 'unbound supervision visibly remains independent', supervisionResult.state.includes('独立督导'));
    check('E7', 'unbound supervision can save a synthetic local record with empty identifiers', supervisionResult.chat.includes('合成督导回应') && supervisionResult.savedConclusion.includes('合成督导回应') && supervisionResult.savedType === 'ai' && supervisionResult.clientId === '' && supervisionResult.sessionId === '' && supervisionResult.actionTask === 'supervision-ai' && supervisionResult.actionStatus === 'succeeded' && supervisionResult.actionClientId === '' && supervisionResult.actionSourceCount === 0 && supervisionResult.forgedRejected, JSON.stringify({ savedCount: supervisionResult.savedCount, savedType: supervisionResult.savedType, clientId: supervisionResult.clientId, sessionId: supervisionResult.sessionId, actionTask: supervisionResult.actionTask, actionStatus: supervisionResult.actionStatus, actionSourceCount: supervisionResult.actionSourceCount, forgedRejected: supervisionResult.forgedRejected, pageHasSuccess: supervisionResult.pageText.includes('已保存独立督导记录') }));
    await capture(cdp, 'supervision-unbound-save-1366x768');

    await navigate(cdp, origin, 'transcript.html');
    await setViewport(cdp, VIEWPORTS[2]);
    await waitFor(cdp, 'document.getElementById("tp-drop-zone") && document.getElementById("tp-input")', 'transcript drop zone');
    const transcriptResult = await evaluate(cdp, '(async function(){function drop(files){var dt=new DataTransfer();files.forEach(function(file){dt.items.add(file);});document.getElementById("tp-drop-zone").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));} var zone=document.getElementById("tp-drop-zone"); var input=document.getElementById("tp-input"); drop([new File(["咨询师：合成逐字稿"],"synthetic.txt",{type:"text/plain"})]); for(var i=0;i<20&&!input.value.includes("合成逐字稿");i++){await new Promise(function(resolve){setTimeout(resolve,50);});} var imported=input.value; drop([new File(["one"],"one.txt"),new File(["two"],"two.txt")]); await new Promise(function(resolve){setTimeout(resolve,100);}); var afterMany=input.value; drop([new File(["bad"],"bad.pdf",{type:"application/pdf"})]); await new Promise(function(resolve){setTimeout(resolve,100);}); var afterUnsupported=input.value; zone.focus(); return {imported:imported, afterMany:afterMany, afterUnsupported:afterUnsupported, focused:document.activeElement===zone, reduced:matchMedia("(prefers-reduced-motion: reduce)").matches};})()');
    check('E8', 'single-file transcript drop reaches the shared parser path', transcriptResult.imported.includes('合成逐字稿'));
    check('E9', 'multiple and unsupported transcript drops preserve the current draft', transcriptResult.afterMany === transcriptResult.imported && transcriptResult.afterUnsupported === transcriptResult.imported);
    check('E10', 'transcript drop target is keyboard-focusable with reduced motion enabled', transcriptResult.focused && transcriptResult.reduced);
    await capture(cdp, 'transcript-drop-1920x1080');
  } finally {
    if (cdp) {
      try { await stopElectron(cdp, child); } catch (_) {}
      cdp.close();
    } else if (child && child.exitCode === null) {
      child.kill();
    }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  const failed = checks.filter((item) => !item.pass);
  const summary = {
    task_id: 'XJ-5.0.0-codex-imported-dialogue-and-unbound-supervision-01',
    checks,
    failed: failed.length,
    screenshots: fs.readdirSync(ARTIFACTS).filter((name) => name.endsWith('.png')).map((name) => ({
      name,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ARTIFACTS, name))).digest('hex').toUpperCase()
    })),
    runtime_logs: logs.filter(Boolean)
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'runtime-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('Passed: ' + (checks.length - failed.length) + ' | Failed: ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[FATAL] ' + (error && error.stack || error));
  process.exit(1);
});
