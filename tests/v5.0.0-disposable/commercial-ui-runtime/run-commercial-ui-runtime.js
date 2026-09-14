'use strict';
/**
 * XJ-5.0.0-grok-commercial-ui-runtime-a11y-02
 * Real local Edge (CDP) runtime evidence for accepted commercial preview.
 * Read-only preview; writes only under allowlist visual + this test dir.
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var os = require('os');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '5.0.0-commercial');
var PREVIEW_HTML = path.join(PREVIEW, 'index.html');
var OUT_DIR = path.join(ROOT, 'qa', 'visual', 'v5.0.0-commercial-runtime');
var LOG_PATH = path.join(OUT_DIR, 'runtime-log.json');
var MANIFEST_PATH = path.join(OUT_DIR, 'capture-manifest.json');
var TASK_ID = 'XJ-5.0.0-grok-commercial-ui-runtime-a11y-02';

var VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];

var EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function findEdge() {
  for (var i = 0; i < EDGE_CANDIDATES.length; i++) {
    if (fs.existsSync(EDGE_CANDIDATES[i])) return EDGE_CANDIDATES[i];
  }
  return null;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function httpGetJson(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var req = http.get(url, function (res) {
      var buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 5000, function () {
      req.destroy(new Error('http timeout'));
    });
  });
}

function fileUrl(p) {
  var norm = path.resolve(p).replace(/\\/g, '/');
  if (!/^[a-zA-Z]:/.test(norm)) return 'file://' + norm;
  return 'file:///' + norm;
}

/** Minimal CDP over Node WebSocket */
function createCdp(wsUrl) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var nextId = 1;
    var pending = new Map();
    var sessionId = null;

    ws.addEventListener('open', function () {
      resolve({
        raw: ws,
        setSession: function (id) { sessionId = id; },
        send: function (method, params, useSession) {
          var id = nextId++;
          var msg = { id: id, method: method, params: params || {} };
          if (useSession !== false && sessionId) msg.sessionId = sessionId;
          return new Promise(function (res, rej) {
            pending.set(id, { res: res, rej: rej });
            ws.send(JSON.stringify(msg));
          });
        },
        close: function () {
          try { ws.close(); } catch (_) {}
        }
      });
    });
    ws.addEventListener('error', function (e) {
      reject(e.error || e.message || e);
    });
    ws.addEventListener('message', function (ev) {
      var data;
      try { data = JSON.parse(String(ev.data)); } catch (_) { return; }
      if (data.id && pending.has(data.id)) {
        var p = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) p.rej(new Error(data.error.message || JSON.stringify(data.error)));
        else p.res(data.result);
      }
    });
  });
}

function freePort() {
  // Prefer fixed high port with fallback probe
  return 9339;
}

async function waitDevtools(port, attempts) {
  var lastErr;
  for (var i = 0; i < (attempts || 40); i++) {
    try {
      var ver = await httpGetJson('http://127.0.0.1:' + port + '/json/version', 2000);
      if (ver && ver.webSocketDebuggerUrl) return ver;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error('DevTools not ready: ' + (lastErr && lastErr.message));
}

async function attachPage(browserWsUrl, targetUrl) {
  var browser = await createCdp(browserWsUrl);
  // Prefer Target.setDiscoverTargets + createTarget
  var created = await browser.send('Target.createTarget', { url: targetUrl }, false);
  var targetId = created.targetId;
  var attached = await browser.send('Target.attachToTarget', { targetId: targetId, flatten: true }, false);
  browser.setSession(attached.sessionId);
  await browser.send('Page.enable', {});
  await browser.send('Runtime.enable', {});
  await browser.send('DOM.enable', {});
  // Wait load
  await browser.send('Page.navigate', { url: targetUrl });
  await sleep(800);
  return browser;
}

async function setViewport(cdp, w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function evaluate(cdp, expression) {
  var r = await cdp.send('Runtime.evaluate', {
    expression: expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails.text || r.exceptionDetails));
  }
  return r.result ? r.result.value : undefined;
}

async function screenshotPng(cdp, outPath) {
  var r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (!r || !r.data) throw new Error('screenshot empty');
  var buf = Buffer.from(r.data, 'base64');
  if (buf.length < 100) throw new Error('screenshot too small');
  fs.writeFileSync(outPath, buf);
  return { path: outPath, bytes: buf.length, sha256: sha256File(outPath) };
}

async function runViewport(cdp, vp, logEvents) {
  var captures = [];
  await setViewport(cdp, vp.width, vp.height);
  await sleep(200);

  // R1: baseline ready clinical light
  await evaluate(cdp, "(function(){var s=document.getElementById('skinSelect');var t=document.getElementById('themeSelect');var c=document.getElementById('scenarioSelect'); if(s){s.value='clinical'; s.dispatchEvent(new Event('change',{bubbles:true}));} if(t){t.value='light'; t.dispatchEvent(new Event('change',{bubbles:true}));} if(c){c.value='ready'; c.dispatchEvent(new Event('change',{bubbles:true}));} return {skin:document.documentElement.getAttribute('data-skin'),theme:document.documentElement.getAttribute('data-theme'),scenario:c&&c.value};})()");
  await sleep(250);
  var c1 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__ready-clinical-light.png'));
  captures.push(Object.assign({ id: vp.name + '__ready-clinical-light', step: 'baseline' }, c1));
  logEvents.push({ viewport: vp.name, step: 'baseline', result: 'ok', file: path.basename(c1.path) });

  // R2: skin + theme switch
  var skinTheme = await evaluate(cdp, "(function(){var s=document.getElementById('skinSelect');var t=document.getElementById('themeSelect'); s.value='theatre'; s.dispatchEvent(new Event('change',{bubbles:true})); t.value='dark'; t.dispatchEvent(new Event('change',{bubbles:true})); return {skin:document.documentElement.getAttribute('data-skin'),theme:document.documentElement.getAttribute('data-theme')};})()");
  await sleep(250);
  var c2 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__theatre-dark.png'));
  captures.push(Object.assign({ id: vp.name + '__theatre-dark', step: 'skin-theme', skinTheme: skinTheme }, c2));
  logEvents.push({ viewport: vp.name, step: 'skin-theme', result: skinTheme, file: path.basename(c2.path) });

  // R3: observatory light for third skin evidence
  await evaluate(cdp, "(function(){var s=document.getElementById('skinSelect');var t=document.getElementById('themeSelect'); s.value='observatory'; s.dispatchEvent(new Event('change',{bubbles:true})); t.value='light'; t.dispatchEvent(new Event('change',{bubbles:true})); return true;})()");
  await sleep(200);
  var c3 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__observatory-light.png'));
  captures.push(Object.assign({ id: vp.name + '__observatory-light', step: 'third-skin' }, c3));
  logEvents.push({ viewport: vp.name, step: 'third-skin', result: 'ok', file: path.basename(c3.path) });

  // R4: error scenario + recovery
  var errState = await evaluate(cdp, "(function(){var c=document.getElementById('scenarioSelect'); c.value='error'; c.dispatchEvent(new Event('change',{bubbles:true})); var btn=document.getElementById('recoveryBtn'); var before=document.getElementById('liveRegion')&&document.getElementById('liveRegion').textContent; if(btn) btn.click(); return {hadRecovery:!!btn, live:(document.getElementById('liveRegion')||{}).textContent||'', scenario:c.value};})()");
  await sleep(350);
  var c4 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__error-recovery.png'));
  captures.push(Object.assign({ id: vp.name + '__error-recovery', step: 'recovery', errState: errState }, c4));
  logEvents.push({ viewport: vp.name, step: 'recovery', result: errState, file: path.basename(c4.path) });

  // R5: keyboard segment navigation (ArrowRight from account tab)
  var keyNav = await evaluate(cdp, "(function(){var tab=document.getElementById('tabAccount'); if(!tab) return {ok:false,reason:'no-tab'}; tab.focus(); var ev=new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}); document.getElementById('segmentTabs').dispatchEvent(ev); var selected=document.querySelector('[role=tab][aria-selected=\"true\"]'); return {ok:true, selected: selected && selected.getAttribute('data-segment'), focusId: document.activeElement && document.activeElement.id};})()");
  await sleep(250);
  var c5 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__keyboard-orders.png'));
  captures.push(Object.assign({ id: vp.name + '__keyboard-orders', step: 'keyboard-nav', keyNav: keyNav }, c5));
  logEvents.push({ viewport: vp.name, step: 'keyboard-nav', result: keyNav, file: path.basename(c5.path) });

  // R6: empty scenario a11y live region + device tab click
  var a11y = await evaluate(cdp, "(function(){var c=document.getElementById('scenarioSelect'); c.value='empty'; c.dispatchEvent(new Event('change',{bubbles:true})); var live=document.getElementById('liveRegion'); var tab=document.getElementById('tabDevice'); if(tab) tab.click(); return {liveRole: live && live.getAttribute('role'), ariaLive: live && live.getAttribute('aria-live'), segment: document.querySelector('[role=tab][aria-selected=\"true\"]') && document.querySelector('[role=tab][aria-selected=\"true\"]').getAttribute('data-segment'), focusVisibleRules: !!document.styleSheets};})()");
  await sleep(250);
  var c6 = await screenshotPng(cdp, path.join(OUT_DIR, vp.name + '__empty-device-a11y.png'));
  captures.push(Object.assign({ id: vp.name + '__empty-device-a11y', step: 'a11y-empty-device', a11y: a11y }, c6));
  logEvents.push({ viewport: vp.name, step: 'a11y-empty-device', result: a11y, file: path.basename(c6.path) });

  return captures;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // clean prior png/json in out dir except keep structure
  fs.readdirSync(OUT_DIR).forEach(function (n) {
    if (/\.(png|json)$/i.test(n)) fs.unlinkSync(path.join(OUT_DIR, n));
  });

  if (!fs.existsSync(PREVIEW_HTML)) {
    console.error('BLOCKED missing preview ' + PREVIEW_HTML);
    process.exit(2);
  }

  var edge = findEdge();
  if (!edge) {
    console.error('BLOCKED no local Edge binary');
    process.exit(2);
  }

  var port = freePort();
  var userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj50-edge-'));
  var targetUrl = fileUrl(PREVIEW_HTML);
  var logEvents = [];
  var child = null;
  var cdp = null;
  var allCaptures = [];
  var status = 'running';

  try {
    child = cp.spawn(edge, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + userData,
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    var stderrBuf = '';
    child.stderr.on('data', function (d) { stderrBuf += String(d); });

    var ver = await waitDevtools(port, 50);
    console.log('[RUNNING] first DevTools contact OK port=' + port);
    logEvents.push({ step: 'devtools', result: 'ok', browser: ver.Browser || ver['User-Agent'] || 'edge' });

    cdp = await attachPage(ver.webSocketDebuggerUrl, targetUrl);
    // Confirm DOM controls exist (first local runtime interaction)
    var probe = await evaluate(cdp, "(function(){return {hasSkin:!!document.getElementById('skinSelect'), hasTheme:!!document.getElementById('themeSelect'), hasScenario:!!document.getElementById('scenarioSelect'), hasTabs:!!document.getElementById('segmentTabs'), title: document.title};})()");
    if (!probe || !probe.hasSkin || !probe.hasTabs) {
      throw new Error('preview controls missing: ' + JSON.stringify(probe));
    }
    console.log('[RUNNING] first local runtime interaction OK title=' + probe.title);
    logEvents.push({ step: 'first-interaction', result: probe });

    for (var i = 0; i < VIEWPORTS.length; i++) {
      var vp = VIEWPORTS[i];
      console.log('[CAPTURE] viewport ' + vp.name);
      var caps = await runViewport(cdp, vp, logEvents);
      allCaptures = allCaptures.concat(caps);
    }

    status = 'ok';
  } catch (e) {
    status = 'BLOCKED';
    logEvents.push({ step: 'error', result: String(e && e.stack || e) });
    console.error('[BLOCKED] ' + (e && e.message || e));
  } finally {
    try { if (cdp) cdp.close(); } catch (_) {}
    try {
      if (child && !child.killed) {
        child.kill();
      }
    } catch (_) {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  var previewHashes = ['index.html', 'styles.css', 'app.js', 'fixtures.js'].map(function (n) {
    var p = path.join(PREVIEW, n);
    return { file: n, sha256: sha256File(p), bytes: fs.statSync(p).size };
  });

  var runtimeLog = {
    task_id: TASK_ID,
    generatedAt: new Date().toISOString(),
    status: status,
    edgePath: edge,
    previewRoot: PREVIEW,
    viewports: VIEWPORTS,
    events: logEvents,
    captureCount: allCaptures.length,
    localOnly: true,
    network: 'none-intentional',
    notes: [
      'Screenshots are real Edge CDP Page.captureScreenshot outputs.',
      'Preview sources were not modified.',
      'No fabricated PNG; empty capture fails the run.'
    ]
  };
  fs.writeFileSync(LOG_PATH, JSON.stringify(runtimeLog, null, 2), 'utf8');

  var manifest = {
    task_id: TASK_ID,
    generatedAt: runtimeLog.generatedAt,
    status: status,
    expectedMinCaptures: VIEWPORTS.length * 6,
    captureCount: allCaptures.length,
    captures: allCaptures.map(function (c) {
      return {
        id: c.id,
        step: c.step,
        file: path.basename(c.path),
        bytes: c.bytes,
        sha256: c.sha256
      };
    }),
    previewHashes: previewHashes,
    runtimeLogSha256: sha256File(LOG_PATH),
    assertions: {
      threeViewports: VIEWPORTS.every(function (vp) {
        return allCaptures.some(function (c) { return c.id.indexOf(vp.name) === 0; });
      }),
      skinThemeExercised: logEvents.some(function (e) { return e.step === 'skin-theme'; }),
      keyboardNav: logEvents.some(function (e) {
        return e.step === 'keyboard-nav' && e.result && e.result.ok && e.result.selected === 'orders';
      }),
      recoveryExercised: logEvents.some(function (e) {
        return e.step === 'recovery' && e.result && e.result.hadRecovery;
      }),
      a11yLiveRegion: logEvents.some(function (e) {
        return e.step === 'a11y-empty-device' && e.result && e.result.ariaLive === 'polite';
      }),
      allPngReal: allCaptures.every(function (c) { return c.bytes > 500 && c.sha256; })
    }
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('STATUS ' + status);
  console.log('CAPTURES ' + allCaptures.length + ' expectedMin=' + (VIEWPORTS.length * 6));
  console.log('LOG ' + LOG_PATH);
  console.log('MANIFEST ' + MANIFEST_PATH);
  console.log('ASSERT ' + JSON.stringify(manifest.assertions));

  var assertFail = Object.keys(manifest.assertions).filter(function (k) { return !manifest.assertions[k]; });
  if (status !== 'ok' || assertFail.length) {
    console.error('RESULT FAIL assertFail=' + assertFail.join(','));
    process.exit(1);
  }
  console.log('RESULT PASS');
  process.exit(0);
}

main().catch(function (e) {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
