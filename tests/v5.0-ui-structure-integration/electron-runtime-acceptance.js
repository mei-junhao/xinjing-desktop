'use strict';

/* Controlled Electron acceptance for the 5.0.0 clinical structure surfaces. */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WRAPPER = path.join(ROOT, 'scripts', 'agent-electron-acceptance.ps1');
const EVIDENCE = path.join(__dirname, 'evidence');
const VIEWPORTS = [{ name: '1024x700', width: 1024, height: 700 }, { name: '1366x768', width: 1366, height: 768 }, { name: '1920x1080', width: 1920, height: 1080 }];
const SKINS = ['clinical', 'theatre', 'observatory'];
const checks = [];
function check(id, label, pass, detail) { checks.push({ id, label, pass: !!pass, detail: detail || '' }); console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label + (detail ? ' - ' + detail : '')); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.unref(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function getJson(url) { return new Promise((resolve, reject) => { const req = http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }); req.setTimeout(2500, () => req.destroy(new Error('HTTP timeout'))); req.on('error', reject); }); }
function createCdp(wsUrl) { return new Promise((resolve, reject) => { const socket = new WebSocket(wsUrl); const pending = new Map(); let id = 0; socket.addEventListener('open', () => resolve({ send(method, params) { const commandId = ++id; return new Promise((res, rej) => { pending.set(commandId, { res, rej }); socket.send(JSON.stringify({ id: commandId, method, params: params || {} })); }); }, close() { try { socket.close(); } catch (_) {} } })); socket.addEventListener('message', (event) => { let message; try { message = JSON.parse(String(event.data)); } catch (_) { return; } if (!message.id || !pending.has(message.id)) return; const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry.rej(new Error(message.error.message || 'CDP error')) : entry.res(message.result || {}); }); socket.addEventListener('error', (error) => reject(error)); socket.addEventListener('close', () => pending.forEach((entry) => entry.rej(new Error('CDP closed')))); }); }
async function evaluate(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) { const details = result.exceptionDetails; throw new Error((details.exception && details.exception.description) || details.text || 'renderer evaluation failed'); } return result.result && result.result.value; }
async function waitFor(cdp, expression, label, attempts) { for (let i = 0; i < (attempts || 80); i += 1) { if (await evaluate(cdp, expression)) return true; await sleep(150); } throw new Error('Timed out waiting for ' + label); }
async function waitForOptional(cdp, expression, attempts) { for (let i = 0; i < (attempts || 40); i += 1) { if (await evaluate(cdp, expression)) return true; await sleep(150); } return false; }
async function navigate(cdp, origin, page) { await cdp.send('Page.navigate', { url: origin + '/' + page }); await waitFor(cdp, 'document.readyState === "complete"', page + ' ready'); await sleep(450); }
async function setViewport(cdp, viewport) { await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }); await sleep(120); }
async function screenshot(cdp, filename) { const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); const bytes = Buffer.from(result.data || '', 'base64'); if (bytes.length < 1024) throw new Error('Screenshot too small'); const file = path.join(EVIDENCE, filename); fs.writeFileSync(file, bytes); return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() }; }
const CLOCK_START_ISO = '2026-08-09T12:00:00+08:00';
const CLOCK_START_MS = Date.parse(CLOCK_START_ISO);
const CLOCK_SCRIPT = `(function(){
  if (window.__xjSyntheticClock && window.__xjSyntheticClock.installed) return;
  var NativeDate = Date;
  var start = ${CLOCK_START_MS};
  var installedAt = NativeDate.now();
  function SyntheticDate(){
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof SyntheticDate)) return new NativeDate(start + (NativeDate.now() - installedAt)).toString();
    if (!args.length) return new NativeDate(start + (NativeDate.now() - installedAt));
    return new (Function.prototype.bind.apply(NativeDate, [null].concat(args)))();
  }
  SyntheticDate.now = function(){ return start + (NativeDate.now() - installedAt); };
  SyntheticDate.parse = NativeDate.parse;
  SyntheticDate.UTC = NativeDate.UTC;
  SyntheticDate.prototype = NativeDate.prototype;
  Object.defineProperty(SyntheticDate, 'name', { value: 'Date' });
  window.Date = SyntheticDate;
  window.__xjSyntheticClock = { installed: true, mode: 'synthetic-progressing', startIso: '${CLOCK_START_ISO}', startMs: start, timezone: 'Asia/Shanghai', offsetMinutes: 480, injection: 'Page.addScriptToEvaluateOnNewDocument' };
})();`;
function closeProcess(child) { if (child && child.exitCode === null) child.kill(); }

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  if (!fs.existsSync(ELECTRON)) { check('E0', 'Electron executable is installed', false, ELECTRON); return finish(2); }
  // The wrapper owns the random temporary userData directory and removes it
  // after the Electron process exits; this runner never touches user data.
  const userData = null;
  const port = await freePort();
  let child; let cdp;
  const consoleErrors = [];
  try {
    if (!fs.existsSync(WRAPPER)) throw new Error('controlled acceptance wrapper is absent: ' + WRAPPER);
    child = childProcess.spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER, '-RemoteDebuggingPort', String(port)], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => { const text = String(chunk); if (/error|uncaught|exception/i.test(text)) consoleErrors.push(text.slice(0, 500)); });
    let page; let last;
    for (let i = 0; i < 90; i += 1) { try { const pages = await getJson('http://127.0.0.1:' + port + '/json/list'); page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) break; } catch (error) { last = error; } await sleep(200); }
    if (!page) throw new Error('controlled Electron page unavailable: ' + (last && last.message || 'unknown'));
    const origin = new URL(page.url).origin;
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
    const clockInjection = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SCRIPT });
    check('E1', 'controlled Electron serves loopback page', /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url), page.url);
    check('E2', 'reduced motion is active', await evaluate(cdp, 'matchMedia("(prefers-reduced-motion: reduce)").matches === true'));
    await waitFor(cdp, 'typeof Store !== "undefined" && Store.isHydrated && Store.isHydrated()', 'Store hydration');
    const seed = await evaluate(cdp, '(async function(){var c=Store.createClient({name:"合成长中文来访者，键盘与来源图谱验收用例",status:"active"});var s=Store.createSession({clientId:c.id,date:"2026-08-08",sessionNumber:1,title:"合成会谈：长中文上下文"});var m=Store.createMaterialWorkspace({clientId:c.id,sessionId:s.id,title:"合成已验证材料",source:{name:"synthetic.txt",ext:"txt"},extractedText:"SYNTHETIC_BODY_MUST_NOT_RENDER",parseStatus:"ready"});return {clientId:c.id,sessionId:s.id,materialId:m&&m.id||""};})()');
    check('E3', 'synthetic client/session/material seed succeeds in temporary profile', !!(seed && seed.clientId && seed.sessionId && seed.materialId));
    await sleep(700);

    const noErrorProbe = () => evaluate(cdp, 'window.__xjRuntimeConsoleErrors || []');
    const evidence = [];
    await setViewport(cdp, VIEWPORTS[1]);
    await navigate(cdp, origin, 'chat-home.html?clientId=' + encodeURIComponent(seed.clientId) + '&sessionId=' + encodeURIComponent(seed.sessionId));
    await waitFor(cdp, 'document.querySelector(".chat-history-panel") && document.querySelector("#chat-history-search")', 'chat workspace');
    const clockProbe = await evaluate(cdp, `(function(){
      var meta = window.__xjSyntheticClock || {};
      var first = new Date();
      var firstNow = Date.now();
      var parsed = Date.parse('2026-08-09T12:00:00+08:00');
      var utc = Date.UTC(2026, 7, 9, 4, 0, 0);
      return { installed: meta.installed === true, mode: meta.mode, startIso: meta.startIso, timezone: meta.timezone, offsetMinutes: meta.offsetMinutes, injection: meta.injection, localDate: first.toISOString().slice(0, 10), dateNow: firstNow, parsed: parsed, utc: utc, dateCall: Date().indexOf('2026') >= 0, instance: first instanceof Date, nativePrototype: Object.prototype.toString.call(first), greeting: document.body.innerText.indexOf('2026年8月9日星期日') >= 0 };
    })()`);
    check('E12-CLOCK', 'chat uses the installed progressing synthetic clock with Asia/Shanghai provenance', clockProbe.installed && clockProbe.mode === 'synthetic-progressing' && clockProbe.startIso === CLOCK_START_ISO && clockProbe.timezone === 'Asia/Shanghai' && clockProbe.offsetMinutes === 480 && clockProbe.injection === 'Page.addScriptToEvaluateOnNewDocument' && clockProbe.localDate === '2026-08-09' && clockProbe.dateNow >= CLOCK_START_MS && clockProbe.parsed === CLOCK_START_MS && clockProbe.utc === CLOCK_START_MS && clockProbe.dateCall && clockProbe.instance && clockProbe.nativePrototype === '[object Date]' && clockProbe.greeting, JSON.stringify(clockProbe));
    const clockBefore = await evaluate(cdp, 'Date.now()');
    await sleep(40);
    const clockAfter = await evaluate(cdp, 'Date.now()');
    check('E12-CLOCK-PROGRESS', 'synthetic clock advances with real elapsed milliseconds', Number.isFinite(clockBefore) && Number.isFinite(clockAfter) && clockAfter >= clockBefore + 20, JSON.stringify({ before: clockBefore, after: clockAfter }));
    await evaluate(cdp, 'window.dispatchEvent(new Event("xj:clinical-context-changed")); true');
    const chatState = await evaluate(cdp, '(function(){var input=document.querySelector("#chat-history-search");return {history:!!document.querySelector("#chat-history-list"),context:!!document.querySelector("#chat-context-strip"),search:!!input,focusable:!!input&&getComputedStyle(input).display!=="none"};})()');
    check('E4', 'chat workspace exposes history, search and clinical context', chatState.history && chatState.context && chatState.search && chatState.focusable, JSON.stringify(chatState));
    const chatSourceProjected = await waitForOptional(cdp, 'document.querySelector("#chat-source-list").innerText.includes("合成已验证材料")', 40);
    const chatSource = await evaluate(cdp, '(function(){var list=document.querySelector("#chat-source-list");return {projected:' + String(chatSourceProjected) + ',title:list.innerText.includes("合成已验证材料"),bodyHidden:!list.innerText.includes("SYNTHETIC_BODY_MUST_NOT_RENDER")};})()');
    check('E4A', 'chat renders a real CaseSpace-admitted source without original body text', chatSource.projected && chatSource.title && chatSource.bodyHidden, JSON.stringify(chatSource));
    const fakeAdmission = await evaluate(cdp, `(async function(){
      var original = window.CaseSpaceViewModel;
      var calls = 0;
      if (!original || typeof original.refresh !== 'function') return { installed: false, reason: 'missing-production-case-space' };
      var fakeRefresh = function(){
        calls += 1;
        return Promise.resolve({ ok: true, model: { clientId: ${JSON.stringify(seed.clientId)}, nodes: [{
          id: 'fake-status-only', kind: 'material', clientId: ${JSON.stringify(seed.clientId)}, sessionId: ${JSON.stringify(seed.sessionId)}, sourceStatus: 'verified',
          sourceRef: { id: 'sr:fake', anchor: { locator: ${JSON.stringify('material:' + seed.materialId)} } }
        }] } });
      };
      var replacement = Object.assign({}, original, { refresh: fakeRefresh });
      window.CaseSpaceViewModel = replacement;
      var installed = window.CaseSpaceViewModel === replacement && window.CaseSpaceViewModel.refresh === fakeRefresh;
      window.dispatchEvent(new Event('xj:clinical-context-changed'));
      var text = '';
      for (var attempt = 0; attempt < 40; attempt += 1) {
        await new Promise(function(resolve){ setTimeout(resolve, 100); });
        var list = document.querySelector('#chat-source-list');
        text = list ? list.innerText : '';
        if (calls > 0 && (text.includes('当前会谈没有通过来源校验的材料') || text.includes('来源投影不可用'))) break;
      }
      var rejected = calls > 0 && (text.includes('当前会谈没有通过来源校验的材料') || text.includes('来源投影不可用'));
      var deniedCalls = 0;
      replacement.refresh = function(){ deniedCalls += 1; return Promise.resolve({ ok: false, reason: 'synthetic-refresh-rejected' }); };
      window.dispatchEvent(new Event('xj:clinical-context-changed'));
      var deniedText = '';
      for (var deniedAttempt = 0; deniedAttempt < 40; deniedAttempt += 1) {
        await new Promise(function(resolve){ setTimeout(resolve, 100); });
        var deniedList = document.querySelector('#chat-source-list');
        deniedText = deniedList ? deniedList.innerText : '';
        if (deniedCalls > 0 && deniedText.includes('来源投影不可用')) break;
      }
      var denied = deniedCalls > 0 && deniedText.includes('来源投影不可用');
      window.CaseSpaceViewModel = original;
      window.dispatchEvent(new Event('xj:clinical-context-changed'));
      var restoredText = '';
      for (var restoreAttempt = 0; restoreAttempt < 40; restoreAttempt += 1) {
        await new Promise(function(resolve){ setTimeout(resolve, 100); });
        var restoredList = document.querySelector('#chat-source-list');
        restoredText = restoredList ? restoredList.innerText : '';
        if (restoredText.includes('合成已验证材料')) break;
      }
      return { originalFrozen: Object.isFrozen(original), installed: installed, calls: calls, rejected: rejected, text: text, deniedCalls: deniedCalls, denied: denied, deniedText: deniedText, restored: restoredText.includes('合成已验证材料'), restoredText: restoredText };
    })()`);
    check('E4B', 'chat rejects a status-only fake source only after a whole-object CaseSpace wrapper is installed, then restores the real source',
      fakeAdmission.originalFrozen && fakeAdmission.installed && fakeAdmission.calls > 0 && fakeAdmission.rejected && fakeAdmission.restored, JSON.stringify(fakeAdmission));
    check('E4C', 'chat preserves the fail-closed error state when CaseSpace returns ok:false instead of swallowing it',
      fakeAdmission.installed && fakeAdmission.deniedCalls > 0 && fakeAdmission.denied && fakeAdmission.restored, JSON.stringify(fakeAdmission));
    const composerProbe = `(async function(){
      await new Promise(function(resolve){ setTimeout(resolve, 220); });
      function rect(node){ if (!node) return null; var value = node.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height }; }
      function visible(node, value){ var style=node&&getComputedStyle(node); return !!node && !!value && style.display !== 'none' && style.visibility !== 'hidden' && value.top >= 0 && value.bottom <= innerHeight + 1; }
      var body = document.body;
      var layoutSelector = 'body[data-xj-page="workbench"] > .layout.xj-auto-layout:has(> .xj-auto-main > .chat-structure-shell)';
      var mainSelector = layoutSelector + ' > .xj-auto-main';
      var layout = document.querySelector('body > .layout.xj-auto-layout');
      var main = layout && layout.querySelector(':scope > .xj-auto-main');
      var row = document.querySelector('.chat-input-row');
      var input = document.querySelector('#chat-input');
      var send = document.querySelector('#chat-send');
      var source = document.querySelector('#chat-source-list');
      if (input) input.focus();
      await new Promise(function(resolve){ requestAnimationFrame(resolve); });
      var rowRect = rect(row), inputRect = rect(input), sendRect = rect(send);
      function overflow(node){ if (!node) return null; var style=getComputedStyle(node); return { visible: style.display !== 'none' && style.visibility !== 'hidden', clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: style.overflowX }; }
      var overflowNodes = { html: overflow(document.documentElement), layout: overflow(layout), main: overflow(main), history: overflow(document.querySelector('.chat-history-panel')), context: overflow(document.querySelector('.chat-context-panel')) };
      var overflowPass = Object.keys(overflowNodes).every(function(key){ var item=overflowNodes[key]; return !item || !item.visible || item.scrollWidth <= item.clientWidth + 1; });
      return {
        bodyPage: body && body.getAttribute('data-xj-page'),
        layoutSelector: layoutSelector,
        mainSelector: mainSelector,
        layoutMatches: !!layout && document.querySelector(layoutSelector) === layout,
        mainMatches: !!main && document.querySelector(mainSelector) === main,
        layoutMinHeight: layout ? getComputedStyle(layout).minHeight : null,
        mainMinHeight: main ? getComputedStyle(main).minHeight : null,
        sourceRestored: !!source && source.innerText.includes('合成已验证材料'),
        clientId: new URLSearchParams(location.search).get('clientId'),
        sessionId: new URLSearchParams(location.search).get('sessionId'),
        innerHeight: innerHeight,
        scrollY: scrollY,
        row: rowRect,
        input: inputRect,
        send: sendRect,
        overflow: overflowNodes,
        overflowPass: overflowPass,
        focused: document.activeElement === input,
        visible: { row: visible(row, rowRect), input: visible(input, inputRect), send: visible(send, sendRect) }
      };
    })()`;
    function composerPass(state) {
      return state.bodyPage === 'workbench' && state.layoutMatches && state.mainMatches && state.layoutMinHeight === '0px' && state.mainMinHeight === '0px' && state.sourceRestored && state.clientId === seed.clientId && state.sessionId === seed.sessionId && state.scrollY === 0 && state.focused && state.overflowPass && [state.row, state.input, state.send].every((rect) => rect && rect.top >= 0 && rect.bottom <= state.innerHeight + 1) && state.visible.row && state.visible.input && state.visible.send;
    }
    const restoredComposers = [];
    for (const viewport of VIEWPORTS) {
      await setViewport(cdp, viewport);
      const restoredComposer = await evaluate(cdp, composerProbe);
      restoredComposers.push({ viewport: viewport.name, state: restoredComposer });
      check('E4D-' + viewport.name, 'chat composer remains visible at ' + viewport.name + ' in the same restored E4A source state', composerPass(restoredComposer), JSON.stringify(restoredComposer));
      evidence.push(await screenshot(cdp, 'chat-e4d-restored-' + viewport.name + '.png'));
    }
    await setViewport(cdp, VIEWPORTS[1]);
    const mutationInstalled = await evaluate(cdp, `(function(){
      var id = 'xj-e4d-100vh-mutant';
      var previous = document.getElementById(id);
      if (previous) previous.remove();
      var style = document.createElement('style');
      style.id = id;
      style.textContent = 'body[data-xj-page="workbench"] > .layout.xj-auto-layout:has(> .xj-auto-main > .chat-structure-shell), body[data-xj-page="workbench"] > .layout.xj-auto-layout:has(> .xj-auto-main > .chat-structure-shell) > .xj-auto-main { min-height: 100vh !important; }';
      document.head.appendChild(style);
      return !!document.getElementById(id);
    })()`);
    const mutantComposer = await evaluate(cdp, composerProbe);
    evidence.push(await screenshot(cdp, 'chat-e4d-mutant-100vh-1366x768.png'));
    const mutationRemoved = await evaluate(cdp, `(async function(){ var style=document.getElementById('xj-e4d-100vh-mutant'); if (style) style.remove(); await new Promise(function(resolve){ requestAnimationFrame(resolve); }); return !document.getElementById('xj-e4d-100vh-mutant'); })()`);
    const recoveredComposer = await evaluate(cdp, composerProbe);
    const mutantOverflow = [mutantComposer.row, mutantComposer.input, mutantComposer.send].some((rect) => rect && rect.bottom > mutantComposer.innerHeight + 1);
    check('M-E4D-100VH', 'runtime 100vh mutation reintroduces composer overflow and removal restores the real route selector layout',
      mutationInstalled && mutationRemoved && mutantComposer.sourceRestored && mutantComposer.clientId === seed.clientId && mutantComposer.sessionId === seed.sessionId && mutantComposer.layoutMatches && mutantComposer.mainMatches && mutantComposer.layoutMinHeight !== '0px' && mutantComposer.mainMinHeight !== '0px' && mutantOverflow && composerPass(recoveredComposer), JSON.stringify({ mutant: mutantComposer, recovered: recoveredComposer }));
    await evaluate(cdp, '(function(){var s=document.querySelector("#chat-history-search");s.value="不存在的长中文搜索词";s.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await sleep(80);
    check('E5', 'chat history search renders an explicit empty state', await evaluate(cdp, 'document.querySelector("#chat-history-list").innerText.includes("没有匹配")'));
    const focusChecks = [];
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[1]]) {
      await setViewport(cdp, viewport);
      await navigate(cdp, origin, 'chat-home.html');
      await waitFor(cdp, 'document.querySelector("#chat-input") && document.querySelector(".chat-history-brand")', 'chat focus viewport');
      focusChecks.push(await evaluate(cdp, '(function(){var input=document.querySelector("#chat-input"),brand=document.querySelector(".chat-history-brand"),shell=document.querySelector(".chat-structure-shell");input.focus();var b=brand.getBoundingClientRect(),s=shell.getBoundingClientRect(),i=input.getBoundingClientRect();return {scrollY:scrollY,brandVisible:b.top>=0&&b.bottom>0,shellVisible:s.top>=0&&s.bottom>0,inputVisible:i.top>=0&&i.bottom<=innerHeight+1,focused:document.activeElement===input};})()'));
    }
    check('E6', 'chat composer focus keeps the clinical shell and history brand in view at 1024 and 1366', focusChecks.length === 2 && focusChecks.every((item) => item.scrollY === 0 && item.brandVisible && item.shellVisible && item.inputVisible && item.focused), JSON.stringify(focusChecks));
    evidence.push(await screenshot(cdp, 'chat-focus-clinical-light-1366x768.png'));

    await navigate(cdp, origin, 'doc-center.html?clientId=' + encodeURIComponent(seed.clientId) + '&view=atlas');
    const atlasProjected = await waitForOptional(cdp, 'document.querySelectorAll(".atlas-node").length >= 1', 40);
    const atlas = await evaluate(cdp, '(function(){var body=document.body.innerText;var nodes=document.querySelectorAll(".atlas-node");var inspector=document.querySelector(".atlas-source");return {projected:' + String(atlasProjected) + ',nodeCount:nodes.length,selected:document.querySelectorAll(".atlas-node.selected").length,inspector:!!inspector&&inspector.innerText.includes("合成已验证材料"),hidden:!body.includes("SYNTHETIC_BODY_MUST_NOT_RENDER"),refresh:typeof window.refreshAtlasProjection==="function",filter:typeof window.selectAtlasSession==="function"};})()');
    check('E7', 'Atlas projects a real ready material into a selected node and inspector without source body', atlas.projected && atlas.nodeCount >= 1 && atlas.selected >= 1 && atlas.inspector && atlas.hidden && atlas.refresh && atlas.filter, JSON.stringify(atlas));
    const escape = await evaluate(cdp, '(async function(){var node=document.querySelector(".atlas-node");if(!node)return {ready:false};node.focus();node.click();await new Promise(function(resolve){setTimeout(resolve,40);});var inspector=document.querySelector(".atlas-source"),opened=inspector.classList.contains("drawer-open")&&!inspector.hasAttribute("inert");document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));await new Promise(function(resolve){setTimeout(resolve,40);});inspector=document.querySelector(".atlas-source");return {ready:true,opened:opened,closed:!!inspector&&!inspector.classList.contains("drawer-open")&&inspector.hasAttribute("inert"),focus:document.activeElement&&document.activeElement.id||""};})()');
    check('E8', 'Atlas drawer removes inert when opened, restores it on Escape, and returns focus to the source node', escape.ready && escape.opened && escape.closed && escape.focus.indexOf('atlas-node-') === 0, JSON.stringify(escape));
    evidence.push(await screenshot(cdp, 'atlas-clinical-light-1366x768.png'));

    await navigate(cdp, origin, 'doc-growth.html');
    await waitFor(cdp, 'document.querySelector("#sel-client") && document.querySelector("#generate-preview")', 'growth page');
    const growth = await evaluate(cdp, '(function(){return {boundary:document.body.innerText.includes("不会自动写入个案、会谈、督导或报告"), gate:document.body.innerText.includes("AI 成长洞察")};})()');
    check('E9', 'growth page states the preview-only human-confirmation boundary', growth.boundary && growth.gate, JSON.stringify(growth));
    const growthGate = await evaluate(cdp, '(async function(){var feature=App.featureGate,compute=App.hasAICompute;App.featureGate=function(){return false;};var free=await LongitudinalSummary.prepare(' + JSON.stringify(seed.clientId) + ');App.featureGate=function(){return true;};App.hasAICompute=function(){return false;};var unavailable=await LongitudinalSummary.prepare(' + JSON.stringify(seed.clientId) + ');App.featureGate=feature;App.hasAICompute=compute;return {free:free&&free.reason,compute:unavailable&&unavailable.reason};})()');
    check('E10', 'growth feature entitlement and AI compute remain independently fail-closed', growthGate.free === 'feature-locked' && growthGate.compute === 'compute-unavailable', JSON.stringify(growthGate));

    for (const skin of SKINS) {
      for (const mode of ['light', 'dark']) {
        for (const viewport of VIEWPORTS) {
        await setViewport(cdp, viewport);
        const metrics = await evaluate(cdp, '(function(){document.documentElement.setAttribute("data-skin",' + JSON.stringify(skin) + ');document.documentElement.classList.toggle("dark",' + JSON.stringify(mode === "dark") + ');var root=document.documentElement;var now=new Date();var dateText=Date();return {skin:root.getAttribute("data-skin"),mode:' + JSON.stringify(mode) + ',width:innerWidth,height:innerHeight,overflow:root.scrollWidth<=innerWidth+1&&root.scrollHeight<=innerHeight+2,longChinese:document.body.innerText.indexOf("合成长中文来访者")>=0,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,clockLocalDate:now.toISOString().slice(0,10),clockDateText:dateText,clockDateTextHasYear:dateText.indexOf("2026")>=0};})()');
        check('V-' + skin + '-' + mode + '-' + viewport.name, 'growth structure has no overflow and deterministic clock in ' + skin + ' ' + mode + ' ' + viewport.name, metrics.overflow && metrics.reduced && metrics.clockLocalDate === '2026-08-09' && metrics.clockDateTextHasYear, JSON.stringify(metrics));
        evidence.push(await screenshot(cdp, 'growth-' + skin + '-' + mode + '-' + viewport.name + '.png'));
        }
      }
    }
    const pageErrors = await noErrorProbe();
      check('E11', 'renderer console error list is empty', !consoleErrors.length && (!Array.isArray(pageErrors) || pageErrors.length === 0), JSON.stringify(consoleErrors.slice(0, 3)));
    const actualPngNames = fs.readdirSync(EVIDENCE).filter((name) => name.toLowerCase().endsWith('.png')).sort();
    const boundPngNames = evidence.map((item) => path.basename(item.file)).sort();
    const missingPngNames = boundPngNames.filter((name) => !actualPngNames.includes(name));
    const extraPngNames = actualPngNames.filter((name) => !boundPngNames.includes(name));
    const inventory = { actualCount: actualPngNames.length, boundCount: boundPngNames.length, actualNames: actualPngNames, boundNames: boundPngNames, missing: missingPngNames, extra: extraPngNames };
    check('E12-PNG-INVENTORY', 'runtime evidence PNG basenames exactly match bound screenshot inventory', inventory.actualCount === 24 && inventory.boundCount === 24 && !missingPngNames.length && !extraPngNames.length, JSON.stringify(inventory));
    const clock = { mode: 'synthetic-progressing', startIso: CLOCK_START_ISO, timezone: 'Asia/Shanghai', offsetMinutes: 480, injection: 'Page.addScriptToEvaluateOnNewDocument', registrationId: clockInjection.identifier || null };
    fs.writeFileSync(path.join(EVIDENCE, 'runtime-summary.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-vechooool-structure-production-integration-01', checks, screenshots: evidence, inventory, clock, consoleErrors }, null, 2), 'utf8');
    return finish(checks.some((item) => !item.pass) ? 1 : 0);
  } catch (error) {
    check('E-FATAL', 'controlled Electron runtime completes', false, error && error.stack || String(error));
    fs.writeFileSync(path.join(EVIDENCE, 'runtime-summary.json'), JSON.stringify({ task_id: 'XJ-5.0.0-codex-vechooool-structure-production-integration-01', checks, clock: { mode: 'synthetic-progressing', startIso: CLOCK_START_ISO, timezone: 'Asia/Shanghai', offsetMinutes: 480, injection: 'Page.addScriptToEvaluateOnNewDocument', registrationId: clockInjection && clockInjection.identifier || null }, consoleErrors }, null, 2), 'utf8');
    return finish(2);
  } finally {
    try { if (cdp) { await evaluate(cdp, 'window.close(); true'); cdp.close(); } } catch (_) {}
    closeProcess(child);
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {} }
  }
}
function finish(code) { process.exitCode = code; return code; }
main();
