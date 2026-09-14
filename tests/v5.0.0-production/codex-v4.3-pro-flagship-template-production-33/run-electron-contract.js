'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-pro-flagship-template-production-33';
const CLIENT_ID = 'XJ-F2-ELECTRON-CLIENT';
const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];
const SOURCE_FILES = [
  'app/js/session-template-view-model.js',
  'app/js/quick-record.js',
  'app/js/dashboard.js',
  'app/css/workbench-home.css',
  'app/consult-notes.html',
  'app/js/consult-notes.js',
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('CDP discovery timeout')));
  });
}

async function waitForPage(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pages = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /index\.html|consult-notes\.html/.test(item.url || '')) ||
        pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('Electron page unavailable: ' + (lastError && lastError.message || 'timeout'));
}

function createCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    let opened = false;
    const client = {
      send(method, params) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, callback) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(callback);
      },
      close() { try { socket.close(); } catch (_) {} },
    };
    socket.once('open', () => { opened = true; resolve(client); });
    socket.once('error', (error) => { if (!opened) reject(error); });
    socket.on('close', () => {
      pending.forEach((item) => item.reject(new Error('CDP closed')));
      pending.clear();
    });
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch (_) { return; }
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else item.resolve(message.result);
        return;
      }
      if (message.method && listeners.has(message.method)) {
        listeners.get(message.method).forEach((callback) => {
          try { callback(message.params || {}); } catch (_) {}
        });
      }
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed: ' + (result.exceptionDetails.text || 'unknown'));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

async function reload(cdp, label) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, 'document.readyState === "complete"', label + ' document');
  await waitFor(cdp, 'window.Store && typeof Store.isHydrated === "function" && Store.isHydrated()', label + ' Store hydration');
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const data = Buffer.from(result.data || '', 'base64');
  if (data.length < 1024) throw new Error('Blank screenshot: ' + name);
  const file = path.join(ARTIFACT_DIR, name + '.png');
  fs.writeFileSync(file, data);
  return { file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex').toUpperCase() };
}

async function skinCheck(cdp, skin) {
  return evaluate(cdp, `(function () {
    document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)});
    const style = getComputedStyle(document.documentElement);
    return {
      skin: document.documentElement.getAttribute('data-skin'),
      canvas: style.getPropertyValue('--xj-canvas').trim(),
      surface: style.getPropertyValue('--xj-surface').trim(),
      accent: style.getPropertyValue('--xj-accent').trim(),
      text: style.getPropertyValue('--xj-text').trim(),
    };
  })()`);
}

async function main() {
  assert.ok(fs.existsSync(ELECTRON), 'Electron executable missing: ' + ELECTRON);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-f2-electron-'));
  const port = await findFreePort();
  let child = null;
  let cdp = null;
  const screenshots = [];
  const consoleErrors = [];
  const exceptions = [];
  try {
    child = childProcess.spawn(ELECTRON, [
      '--disable-gpu',
      '--disable-background-networking',
      '--user-data-dir=' + userData,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      ROOT,
    ], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        XJ_AGENT_ACCEPTANCE: '1',
        XJ_AGENT_ACCEPTANCE_USER_DATA: userData,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const logs = [];
    child.stdout.on('data', (chunk) => logs.push(String(chunk).trim()));
    child.stderr.on('data', (chunk) => logs.push(String(chunk).trim()));

    const page = await waitForPage(port);
    cdp = await createCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') consoleErrors.push((event.args || []).map((item) => item.value || item.description || '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (event) => {
      const details = event.exceptionDetails || {};
      exceptions.push(details.text || (details.exception && details.exception.description) || 'renderer exception');
    });
    await waitFor(cdp, 'document.readyState === "complete" && window.Store && typeof Store.isHydrated === "function" && Store.isHydrated()', 'initial Store hydration');

    const seeded = await evaluate(cdp, `(async function () {
      const existing = Store.getClient(${JSON.stringify(CLIENT_ID)});
      if (!existing) {
        const created = await Store.createClientDurable({ id: ${JSON.stringify(CLIENT_ID)}, name: '合成来访者 F2' });
        if (!created || !created.ok) return { ok: false, stage: 'client', created };
      }
      if (App.setActiveClientId) App.setActiveClientId(${JSON.stringify(CLIENT_ID)});
      return { ok: true, hydrated: Store.isHydrated(), client: !!Store.getClient(${JSON.stringify(CLIENT_ID)}) };
    })()`);
    assert.ok(seeded && seeded.ok && seeded.client, 'synthetic seed failed: ' + JSON.stringify(seeded));

    const trialPreview = await evaluate(cdp, `(function () {
      App.getLicenseState = function () { return { activated: false, mode: 'trial', aiUnlocked: true }; };
      QuickRecord.reset();
      openQuickRecord();
      const select = document.getElementById('qr-template');
      const ai = select && select.querySelector('option[value="ai-session-v1"]');
      const flagship = select && select.querySelector('option[value="flagship-session-v1"]');
      return {
        ok: !!(select && ai && flagship),
        aiLocked: !!(ai && ai.disabled),
        flagshipLocked: !!(flagship && flagship.disabled),
        help: (document.getElementById('qr-template-help') || {}).textContent || '',
      };
    })()`);
    assert.ok(trialPreview.ok && trialPreview.aiLocked && trialPreview.flagshipLocked && /试用预览|试用/.test(trialPreview.help), 'trial preview failed: ' + JSON.stringify(trialPreview));

    const customState = { activated: true, tier: 'custom' };
    const customReady = await evaluate(cdp, `(function () {
      App.getLicenseState = function () { return ${JSON.stringify(customState)}; };
      QuickRecord.reset();
      openQuickRecord();
      const select = document.getElementById('qr-template');
      const options = Array.from(select ? select.options : []).map((item) => ({ id: item.value, disabled: item.disabled, text: item.textContent }));
      const ai = select && select.querySelector('option[value="ai-session-v1"]');
      const flagship = select && select.querySelector('option[value="flagship-session-v1"]');
      const active = document.activeElement;
      const activeStyle = active ? getComputedStyle(active) : null;
      return {
        options,
        aiEligible: !!(ai && !ai.disabled),
        flagshipEligible: !!(flagship && !flagship.disabled),
        focusId: active && active.id,
        focusStyle: activeStyle && { matchesFocus: !!(active.matches && active.matches(':focus')), outlineStyle: activeStyle.outlineStyle, outlineWidth: activeStyle.outlineWidth, boxShadow: activeStyle.boxShadow, borderColor: activeStyle.borderColor, accentSoft: activeStyle.getPropertyValue('--accent-soft'), sheets: document.styleSheets.length },
        focusVisible: !!(active && ((active.matches && active.matches(':focus-visible')) ||
          (activeStyle && ((activeStyle.outlineStyle !== 'none' && activeStyle.outlineWidth !== '0px') || activeStyle.boxShadow !== 'none')))),
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    })()`);
    assert.ok(customReady.aiEligible && customReady.flagshipEligible && customReady.focusId === 'qr-notes' && customReady.focusVisible && customReady.noHorizontalOverflow, 'custom selector/focus failed: ' + JSON.stringify(customReady));

    const customFlow = await evaluate(cdp, `(async function () {
      const select = document.getElementById('qr-template');
      const customInput = document.getElementById('qr-custom-template-id');
      const notes = document.getElementById('qr-notes');
      const tasksInput = document.getElementById('qr-task-titles');
      select.value = 'flagship-session-v1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      customInput.value = 'brand-acme-001';
      notes.value = '合成会谈备注，不含真实临床数据。';
      tasksInput.value = '合成后续任务'.repeat(12) + '\\n第二条合成任务';
      document.getElementById('qr-submit').click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('#qr-result .qr-success')) await new Promise((resolve) => setTimeout(resolve, 25));
      const sessions = Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)});
      const session = sessions[sessions.length - 1];
      const selection = session && Store.getSessionTemplateSelection(session.id);
      const tasks = Store.getClinicalTasksByClient(${JSON.stringify(CLIENT_ID)}).filter((item) => item.originSessionId === (session && session.id));
      return {
        ok: !!document.querySelector('#qr-result .qr-success'),
        sessionId: session && session.id,
        selection,
        taskCount: tasks.length,
        taskTitles: tasks.map((item) => item.title),
        noBody: !!(selection && !Object.prototype.hasOwnProperty.call(selection, 'body')),
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        canSwitchAway: QuickRecord.canSwitchAway(),
      };
    })()`);
    assert.ok(customFlow.ok && customFlow.sessionId && customFlow.selection && customFlow.selection.templateId === 'flagship-session-v1' && customFlow.selection.tierAtSelection === 'Flagship' && customFlow.selection.customTemplateId === 'brand-acme-001' && customFlow.taskCount === 2 && customFlow.noBody && customFlow.noHorizontalOverflow && customFlow.canSwitchAway.allowed, 'custom QuickRecord flow failed: ' + JSON.stringify(customFlow));

    const quickVisual = [];
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      const visual = await evaluate(cdp, `(function () {
        const panel = document.querySelector('.qr-panel');
        const select = document.getElementById('qr-template');
        const custom = document.getElementById('qr-custom-template-id');
        const panelRect = panel && panel.getBoundingClientRect();
        const customRect = custom && custom.getBoundingClientRect();
        return {
          ok: !!(panel && select && custom),
          visible: !!(panelRect && panelRect.width > 0 && panelRect.height > 0),
          panelInViewport: !!(panelRect && panelRect.left >= 0 && panelRect.right <= innerWidth && panelRect.top >= 0 && panelRect.bottom <= innerHeight),
          customVisible: !!(customRect && customRect.width > 0 && customRect.height > 0),
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          longTaskWraps: (document.getElementById('qr-task-titles') || {}).scrollWidth <= ((document.getElementById('qr-task-titles') || {}).clientWidth || 0) + 2,
        };
      })()`);
      assert.ok(visual.ok && visual.visible && visual.panelInViewport && visual.customVisible && visual.noHorizontalOverflow && visual.longTaskWraps, 'QuickRecord visual failed at ' + viewport.width + 'x' + viewport.height + ': ' + JSON.stringify(visual));
      quickVisual.push(Object.assign({ viewport: viewport.width + 'x' + viewport.height }, visual));
      screenshots.push(Object.assign({ viewport: viewport.width + 'x' + viewport.height, surface: 'quick-record' }, await capture(cdp, 'quick-record-' + viewport.width + 'x' + viewport.height)));
    }

    const failureRetry = await evaluate(cdp, `(async function () {
      QuickRecord.reset();
      openQuickRecord();
      const select = document.getElementById('qr-template');
      select.value = 'ai-session-v1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('qr-task-titles').value = '失败后保留的合成任务';
      const beforeCount = Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)}).length;
      const original = Store.saveSessionTemplateSelectionDurable;
      let failOnce = true;
      Store.saveSessionTemplateSelectionDurable = async function () {
        if (failOnce) { failOnce = false; return { ok: false, error: { code: 'SYNTHETIC_TEMPLATE_FAILURE', message: 'synthetic selection failure' } }; }
        return original.apply(Store, arguments);
      };
      document.getElementById('qr-submit').click();
      let deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('#qr-result .qr-error')) await new Promise((resolve) => setTimeout(resolve, 25));
      const firstSessionId = QuickRecord._state.lockedSessionId;
      const retained = document.getElementById('qr-task-titles').value;
      const draft = QuickRecord.recoverDraft();
      const overlay = document.getElementById('qr-overlay');
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const blockedEscape = overlay.style.display !== 'none';
      document.getElementById('qr-submit').click();
      deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('#qr-result .qr-success')) await new Promise((resolve) => setTimeout(resolve, 25));
      const secondSessionId = QuickRecord._state.lockedSessionId;
      const afterCount = Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)}).length;
      const matchingTasks = Store.getClinicalTasksByClient(${JSON.stringify(CLIENT_ID)}).filter((item) => item.title === '失败后保留的合成任务').length;
      Store.saveSessionTemplateSelectionDurable = original;
      return {
        ok: !!document.querySelector('#qr-result .qr-success'),
        retained,
        draftTitles: draft && draft.taskTitles,
        blockedEscape,
        sameSession: firstSessionId === secondSessionId,
        sameSessionCount: afterCount === beforeCount + 1,
        matchingTasks,
      };
    })()`);
    assert.ok(failureRetry.ok && failureRetry.retained === '失败后保留的合成任务' && failureRetry.draftTitles && failureRetry.blockedEscape && failureRetry.sameSession && failureRetry.sameSessionCount && failureRetry.matchingTasks === 1, 'QuickRecord failure/retry failed: ' + JSON.stringify(failureRetry));

    await reload(cdp, 'index reload');
    const persistedAfterReload = await evaluate(cdp, `(function () {
      const session = Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)}).find((item) => item.id === ${JSON.stringify(customFlow.sessionId)});
      const selection = session && Store.getSessionTemplateSelection(${JSON.stringify(customFlow.sessionId)});
      return { session: !!session, selection, templateId: selection && selection.templateId, customTemplateId: selection && selection.customTemplateId };
    })()`);
    assert.ok(persistedAfterReload.session && persistedAfterReload.selection && persistedAfterReload.templateId === 'flagship-session-v1' && persistedAfterReload.customTemplateId === 'brand-acme-001', 'selection did not survive reload: ' + JSON.stringify(persistedAfterReload));

    await evaluate(cdp, `location.href = 'consult-notes.html?clientId=' + encodeURIComponent(${JSON.stringify(CLIENT_ID)}) + '&sessionId=' + encodeURIComponent(${JSON.stringify(customFlow.sessionId)})`);
    await waitFor(cdp, 'location.pathname.endsWith("/consult-notes.html") && document.readyState === "complete"', 'consultation route');
    await waitFor(cdp, 'document.querySelector("#session-template-select") && document.querySelector("#sel-session") && document.querySelector("#sel-session").value === ' + JSON.stringify(customFlow.sessionId), 'consultation session selection');

    const historical = await evaluate(cdp, `(function () {
      const select = document.getElementById('session-template-select');
      const option = select && select.querySelector('option[value="flagship-session-v1"]');
      const custom = document.getElementById('session-custom-template-id');
      const status = document.getElementById('session-template-status');
      return {
        selected: select && select.value,
        label: option && option.textContent,
        historical: !!(option && /历史锁定/.test(option.textContent)),
        optionDisabled: !!(option && option.disabled),
        customDisabled: !!(custom && custom.disabled),
        status: status && status.textContent,
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    })()`);
    assert.ok(historical.selected === 'flagship-session-v1' && historical.historical && historical.customDisabled && /历史模板当前不可用/.test(historical.status || '') && historical.noHorizontalOverflow, 'historical lock state failed: ' + JSON.stringify(historical));

    const consultationRetry = await evaluate(cdp, `(async function () {
      const select = document.getElementById('session-template-select');
      const note = document.getElementById('f-free');
      select.value = 'manual-session-v1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const beforeSaveState = {
        value: select.value,
        disabled: !!select.disabled,
        status: (document.getElementById('session-template-status') || {}).textContent || '',
        options: Array.from(select.options).map(function (item) { return { id: item.value, disabled: item.disabled }; }),
      };
      note.value = '合成记录内容，保留输入用于失败恢复验收。';
      note.dispatchEvent(new Event('input', { bubbles: true }));
      const beforeCount = Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)}).length;
      const original = Store.saveSessionTemplateSelectionDurable;
      let templateSaveCalls = 0;
      Store.saveSessionTemplateSelectionDurable = async function () { templateSaveCalls += 1; return { ok: false, error: { code: 'SYNTHETIC_CONSULT_TEMPLATE_FAILURE', message: 'synthetic consultation selection failure' } }; };
      const first = await saveNotes(false);
      const afterFailure = {
        result: first,
        retained: note.value,
        status: (document.getElementById('session-template-status') || {}).textContent || '',
        selection: Store.getSessionTemplateSelection(${JSON.stringify(customFlow.sessionId)}),
        count: Store.getSessionsByClient(${JSON.stringify(CLIENT_ID)}).length,
      };
      Store.saveSessionTemplateSelectionDurable = original;
      const second = await saveNotes(false);
      const finalSelection = Store.getSessionTemplateSelection(${JSON.stringify(customFlow.sessionId)});
      return {
        firstFailed: first === false,
        inputRetained: afterFailure.retained === '合成记录内容，保留输入用于失败恢复验收。',
        failureVisible: /模板选择保存失败/.test(afterFailure.status),
        oldSelectionRetainedOnFailure: !!(afterFailure.selection && afterFailure.selection.templateId === 'flagship-session-v1'),
        sameSessionCount: afterFailure.count === beforeCount,
        retrySucceeded: second === true,
        finalTemplateId: finalSelection && finalSelection.templateId,
        selectedValueAfterChange: select.value,
        selectDisabled: !!select.disabled,
        manualOptionDisabled: !!(select.querySelector('option[value="manual-session-v1"]') || {}).disabled,
        templateSaveCalls,
        beforeSaveState,
      };
    })()`);
    assert.ok(consultationRetry.firstFailed && consultationRetry.inputRetained && consultationRetry.failureVisible && consultationRetry.oldSelectionRetainedOnFailure && consultationRetry.sameSessionCount && consultationRetry.retrySucceeded && consultationRetry.finalTemplateId === 'manual-session-v1', 'consultation failure/retry failed: ' + JSON.stringify(consultationRetry));

    const skins = {};
    for (const skin of ['clinical', 'theatre', 'observatory']) {
      skins[skin] = await skinCheck(cdp, skin);
      assert.ok(skins[skin].canvas && skins[skin].surface && skins[skin].accent && skins[skin].text, 'skin tokens missing for ' + skin);
    }

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reducedMotion = await evaluate(cdp, `(function () {
      const elements = ['#session-template-bar', '#session-template-select', '#session-template-plans'].map((id) => document.querySelector(id)).filter(Boolean);
      const durations = elements.map((item) => getComputedStyle(item).transitionDuration);
      const nearZero = durations.every((value) => value.split(',').every((part) => Number.parseFloat(part) <= 0.01));
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        durations,
        zeroTransitions: nearZero,
      };
    })()`);
    assert.ok(reducedMotion.matches && reducedMotion.zeroTransitions, 'reduced-motion check failed: ' + JSON.stringify(reducedMotion));

    const consultVisual = [];
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      const visual = await evaluate(cdp, `(function () {
        const bar = document.getElementById('session-template-bar');
        const select = document.getElementById('session-template-select');
        const status = document.getElementById('session-template-status');
        const rect = bar && bar.getBoundingClientRect();
        select && select.focus();
        const activeStyle = select ? getComputedStyle(select) : null;
        return {
          ok: !!(bar && select && status),
          visible: !!(rect && rect.width > 0 && rect.height > 0),
          inViewport: !!(rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0),
          focusStyle: activeStyle && { matchesFocus: !!(select.matches && select.matches(':focus')), outlineStyle: activeStyle.outlineStyle, outlineWidth: activeStyle.outlineWidth, boxShadow: activeStyle.boxShadow, borderColor: activeStyle.borderColor, accentSoft: activeStyle.getPropertyValue('--accent-soft'), sheets: document.styleSheets.length },
          focusVisible: !!(document.activeElement === select && ((select.matches && select.matches(':focus-visible')) ||
            (activeStyle && ((activeStyle.outlineStyle !== 'none' && activeStyle.outlineWidth !== '0px') || activeStyle.boxShadow !== 'none')))),
          statusVisible: !!(status && status.getBoundingClientRect().width > 0),
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          longChineseWraps: (document.getElementById('f-free') || {}).scrollWidth <= ((document.getElementById('f-free') || {}).clientWidth || 0) + 2,
        };
      })()`);
      assert.ok(visual.ok && visual.visible && visual.inViewport && visual.focusVisible && visual.statusVisible && visual.noHorizontalOverflow && visual.longChineseWraps, 'consultation visual failed at ' + viewport.width + 'x' + viewport.height + ': ' + JSON.stringify(visual));
      consultVisual.push(Object.assign({ viewport: viewport.width + 'x' + viewport.height }, visual));
      screenshots.push(Object.assign({ viewport: viewport.width + 'x' + viewport.height, surface: 'consult-notes' }, await capture(cdp, 'consult-notes-' + viewport.width + 'x' + viewport.height)));
    }

    const networkDenied = await evaluate(cdp, `(async function () {
      try { await fetch('https://example.com/xj-f2-network-probe'); return false; }
      catch (_) { return true; }
    })()`);
    assert.strictEqual(networkDenied, true, 'network must be denied in real Electron evidence');
    assert.deepStrictEqual(consoleErrors, [], 'renderer console errors: ' + JSON.stringify(consoleErrors));
    assert.deepStrictEqual(exceptions, [], 'renderer exceptions: ' + JSON.stringify(exceptions));

    const result = {
      schema_version: 1,
      task_id: TASK_ID,
      pass: true,
      synthetic_data_only: true,
      network_denied: networkDenied,
      viewports: VIEWPORTS.map((item) => item.width + 'x' + item.height),
      trial_preview: trialPreview,
      custom_ready: customReady,
      custom_flow: customFlow,
      quick_visual: quickVisual,
      failure_retry: failureRetry,
      persisted_after_reload: persistedAfterReload,
      historical,
      consultation_retry: consultationRetry,
      skins,
      reduced_motion: reducedMotion,
      consult_visual: consultVisual,
      console_errors: consoleErrors,
      renderer_exceptions: exceptions,
      screenshots,
      source_hashes: Object.fromEntries(SOURCE_FILES.map((relative) => [relative, sha256(path.join(ROOT, relative))])),
      child_logs_tail: logs.filter(Boolean).slice(-12),
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'electron-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    process.stdout.write('ELECTRON_RESULT=' + JSON.stringify(result) + '\n');
  } finally {
    try { if (cdp) await evaluate(cdp, 'window.close(); true'); } catch (_) {}
    if (cdp) cdp.close();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    const resolved = path.resolve(userData);
    const tempRoot = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(tempRoot + path.sep), 'cleanup target must remain in the temporary directory');
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});
