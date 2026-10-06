'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACTS = path.join(__dirname, 'artifacts', 'chat-run-' + Date.now() + '-' + process.pid);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

function createCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    socket.on('open', () => resolve({
      send(method, params = {}) {
        return new Promise((ok, no) => {
          const requestId = ++id;
          pending.set(requestId, { ok, no });
          socket.send(JSON.stringify({ id: requestId, method, params }));
        });
      },
      close() { try { socket.close(); } catch (_) {} }
    }));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch (_) { return; }
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.no(new Error(message.error.message)) : request.ok(message.result);
      }
    });
    socket.on('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && (result.exceptionDetails.exception.description || result.exceptionDetails.exception.value);
    throw new Error((result.exceptionDetails.text || 'renderer evaluation failed') + (detail ? ' :: ' + detail : ''));
  }
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  for (let index = 0; index < 120; index += 1) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

function startAuthServer() {
  const { createServer } = require(path.join(ROOT, 'server', 'account-auth-routes.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-chat-auth-'));
  const service = createServer({ dataFile: path.join(dir, 'accounts.sqlite'), host: '127.0.0.1', port: 0 });
  return {
    dir,
    service,
    listen: () => service.listen(),
    close: () => new Promise((resolve) => service.server.close(resolve)),
    token: () => {
      const queue = service.mailer.peek();
      return queue.length ? queue[queue.length - 1].verificationToken : '';
    }
  };
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const auth = startAuthServer();
  const authPort = await auth.listen();
  const debugPort = await findFreePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-chat-userdata-'));
  let child = null;
  let cdp = null;
  const out = { task_id: 'XJ-5.2.1-CHAT-HOME-ELECTRON-001', artifacts: ARTIFACTS, status: 'FAIL' };

  try {
    child = childProcess.spawn(ELECTRON, ['--disable-gpu', '--user-data-dir=' + userData, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort, ROOT], {
      cwd: ROOT,
      env: { ...process.env, XJ_AGENT_ACCEPTANCE: '1', XJ_AGENT_ACCEPTANCE_USER_DATA: userData, XJ_NETWORK_POLICY: 'deny', XJ_ACCOUNT_API_BASE: 'http://127.0.0.1:' + authPort },
      stdio: 'ignore'
    });
    let page = null;
    for (let index = 0; index < 120 && !page; index += 1) {
      try { page = (await getJson('http://127.0.0.1:' + debugPort + '/json/list')).find((entry) => entry.type === 'page' && entry.url.includes('/account.html')); } catch (_) {}
      if (!page) await sleep(150);
    }
    if (!page) throw new Error('account page timeout');
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, 'document.readyState === "complete" && typeof window.__XJ_API__ !== "undefined"', 'account bridge');
    const email = 'chat-' + Date.now() + '@example.invalid';
    await evaluate(cdp, 'document.querySelector("#tab-register").click()');
    await evaluate(cdp, 'document.querySelector("#register-email").value = ' + JSON.stringify(email) + '; document.querySelector("#register-email").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#register-password").value = "SyntheticA1"; document.querySelector("#register-password").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#register-password2").value = "SyntheticA1"; document.querySelector("#register-password2").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#form-register").requestSubmit()');
    await waitFor(cdp, '!document.querySelector("#view-verify").hidden', 'verification pane');
    await evaluate(cdp, 'document.querySelector("#verify-token").value = ' + JSON.stringify(auth.token()) + '; document.querySelector("#verify-token").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#form-verify").requestSubmit()');
    await waitFor(cdp, 'document.querySelector("#tab-login").getAttribute("aria-selected") === "true"', 'login tab');
    await evaluate(cdp, 'document.querySelector("#login-email").value = ' + JSON.stringify(email) + '; document.querySelector("#login-email").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#login-password").value = "SyntheticA1"; document.querySelector("#login-password").dispatchEvent(new Event("input", { bubbles: true }));');
    await evaluate(cdp, 'document.querySelector("#form-login").requestSubmit()');
    await waitFor(cdp, 'location.pathname.endsWith("/index.html")', 'authenticated workbench');
    await cdp.send('Page.navigate', { url: page.url.replace('/account.html', '/chat-home.html') });
    await waitFor(cdp, 'document.readyState === "complete" && document.querySelector("#chat-input") && window.ClinicalAgentProductionBridge && window.XJClinicalAgentWorkbench', 'chat page');
    await waitFor(cdp, 'document.querySelector("#chat-msgs") && document.querySelector("#chat-msgs").children.length > 0', 'chat initialization');
    await sleep(300);
    out.loaded = await evaluate(cdp, '({ input: !!document.querySelector("#chat-input"), send: !!document.querySelector("#chat-send"), workbench: !!document.querySelector("#clinical-agent-workbench-root") })');

    await evaluate(cdp, '(function () {\n' +
      'var probe = window.__xjChatProbe = { actionRunCount: 0, aiCount: 0, executeCount: 0, events: [] };\n' +
      'var context = window.ClinicalContext;\n' +
      'if (context) { var wrapped = {}; Object.keys(context).forEach(function (key) { wrapped[key] = context[key]; }); ["createActionRun", "completeActionRun", "failActionRun"].forEach(function (key) { if (typeof context[key] !== "function") return; wrapped[key] = function () { var result = context[key].apply(context, arguments); if (key === "createActionRun") probe.actionRunCount += 1; probe.events.push({ step: key, ok: !!result }); return result; }; }); window.ClinicalContext = wrapped; }\n' +
      'var ai = window.AI; if (ai && typeof ai.send === "function") { var original = ai.send; ai.send = function () { probe.aiCount += 1; probe.events.push({ step: "AI.send" }); return original.apply(ai, arguments); }; }\n' +
      'var bridge = window.ClinicalAgentProductionBridge; if (bridge && typeof bridge.fromGlobals === "function") { var originalFromGlobals = bridge.fromGlobals; window.ClinicalAgentProductionBridge = Object.assign({}, bridge, { fromGlobals: function (options) { var instance = originalFromGlobals.call(bridge, options); if (!instance || typeof instance.execute !== "function") return instance; var originalExecute = instance.execute; return Object.assign({}, instance, { execute: function () { probe.executeCount += 1; probe.events.push({ step: "bridge.execute" }); return originalExecute.apply(instance, arguments); } }); } }); }\n' +
      '}())');

    await evaluate(cdp, 'document.querySelector("#chat-input").value = "生成督导整体印象"; document.querySelector("#chat-input").dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#chat-send").click()');
    out.afterSend = await evaluate(cdp, '({ path: location.pathname, input: document.querySelector("#chat-input").value, text: document.querySelector("#chat-msgs").innerText.slice(-1200), children: document.querySelector("#chat-msgs").children.length, route: window.ClinicalAgentRouter && window.ClinicalAgentRouter.route ? window.ClinicalAgentRouter.route("生成督导整体印象", { sources: [] }) : null })');
    await waitFor(cdp, 'document.querySelector(".clinical-agent-confirm") && document.querySelector(".clinical-agent-cancel")', 'chat confirmation card');
    out.beforeConfirm = await evaluate(cdp, '({ actionRunCount: __xjChatProbe.actionRunCount, aiCount: __xjChatProbe.aiCount, executeCount: __xjChatProbe.executeCount, previewText: document.querySelector("#chat-msgs").innerText.slice(-1000) })');
    await evaluate(cdp, 'document.querySelector(".clinical-agent-confirm").click()');
    await waitFor(cdp, 'document.querySelector("#chat-typing") || document.querySelector("#clinical-agent-workbench-root .xj-agent-run-card") || document.querySelector("#chat-msgs").innerText.includes("督导草稿生成失败")', 'post-confirm execution');
    await sleep(800);
    out.afterConfirm = await evaluate(cdp, '({ actionRunCount: __xjChatProbe.actionRunCount, aiCount: __xjChatProbe.aiCount, executeCount: __xjChatProbe.executeCount, workbench: document.querySelector("#clinical-agent-workbench-root").innerText.slice(0, 1200), chat: document.querySelector("#chat-msgs").innerText.slice(-1200), events: __xjChatProbe.events })');
    out.screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then((result) => {
      const buffer = Buffer.from(result.data || '', 'base64');
      fs.writeFileSync(path.join(ARTIFACTS, 'chat-home.png'), buffer);
      return { file: 'chat-home.png', bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase() };
    });
    const previewSafe = /确认后才会调用 AI/.test(out.beforeConfirm.previewText) && !/raw body|messages|executor|privateContext/i.test(out.beforeConfirm.previewText);
    const afterTerminal = /督导草稿生成失败|督导草稿|草稿|受控临床 Agent 任务/.test(out.afterConfirm.chat + out.afterConfirm.workbench);
    out.status = out.loaded.input && out.loaded.send && out.loaded.workbench && out.beforeConfirm.actionRunCount === 0 && out.beforeConfirm.aiCount === 0 && out.beforeConfirm.executeCount === 0 && out.afterConfirm.executeCount === 1 && out.afterConfirm.aiCount === 1 && previewSafe && afterTerminal ? 'PASS' : 'FAIL';
  } catch (error) {
    out.error = String(error.stack || error);
    try { if (cdp) out.debug = await evaluate(cdp, '({ path: location.pathname, body: (document.body && document.body.innerText || "").slice(-2000), probe: window.__xjChatProbe || null, children: document.querySelector("#chat-msgs") ? document.querySelector("#chat-msgs").children.length : -1 })'); } catch (_) {}
  } finally {
    try { if (cdp) cdp.close(); if (child && child.exitCode === null) child.kill(); } catch (_) {}
    try { await auth.close(); } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(auth.dir, { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(path.join(ARTIFACTS, 'chat-home-run.json'), JSON.stringify(out, null, 2));
  }
  console.log('CHAT_HOME_STATUS=' + out.status);
  console.log('CHAT_HOME_ARTIFACTS=' + ARTIFACTS);
  process.exitCode = out.status === 'PASS' ? 0 : 1;
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
