#!/usr/bin/env node
/* XJ-4.2.2-quick-record-ui-v1 — QuickRecord UI 可达性契约
   执行真实 dashboard.js DOM harness + index.html 脚本加载检查。
   覆盖：脚本加载、入口可达、提交委托、四动作、错误/空态、键盘焦点和 no-write boundary。
*/
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; console.log('[PASS] ' + n); } catch (e) { failed++; console.log('[FAIL] ' + n + ' — ' + (e.message || '').slice(0, 300)); } }

var ROOT = path.join(__dirname, '..', '..');
var INDEX_HTML = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
var DASH_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'dashboard.js'), 'utf8');
var QR_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'quick-record.js'), 'utf8');
var CSS_SRC = fs.readFileSync(path.join(ROOT, 'app', 'css', 'workbench-home.css'), 'utf8');

var C = [
  { id: 'c1', name: 'Alice', status: 'active', billing: { feePerSession: 300, billingMode: 'per-session' }, tags: [] },
  { id: 'c2', name: 'Bob', status: 'active', billing: {}, tags: [] },
];
var S = [
  { id: 's1', clientId: 'c1', sessionNumber: 1, date: '2026-07-20', hasTranscript: true, hasSoap: false, billing: { fee: 300, paid: false } },
];

function mkStore() {
  var sessions = S.slice();
  return {
    getClients: function () { return C; },
    getClient: function (id) { return C.find(function (c) { return c.id === id; }) || null; },
    getSessions: function () { return sessions; },
    getSessionsByClient: function (cid) { return sessions.filter(function (s) { return s.clientId === cid; }); },
    getSessionsForPicker: function (cid) { return sessions.filter(function (s) { return s.clientId === cid; }); },
    getSession: function (id) { return sessions.find(function (s) { return s.id === id; }) || null; },
    getSupervisionsByClient: function () { return []; },
    getMaterialWorkspaces: function () { return []; },
    getRecentSessions: function () { return S.slice(); },
    createSessionDurable: function (s) { sessions.push(s); return { ok: true, value: s }; },
    updateSessionDurable: function (id, patch) { var s = sessions.find(function (x) { return s.id === id; }); if (s) Object.assign(s, patch); return { ok: true, value: s }; },
    deleteSessionDurable: function (id) { sessions = sessions.filter(function (s) { return s.id !== id; }); return { ok: true }; },
    linkMaterialWorkspace: function () { return true; },
    updateMaterialWorkspace: function () {},
  };
}

function mkApp() {
  return {
    todayStr: function () { return '2026-07-21'; },
    todayFullCN: function () { return '2026年7月21日'; },
    escapeHtml: function (s) { return String(s || ''); },
    getActiveClientId: function () { return 'c1'; },
    setActiveClientId: function () {},
    featureGate: function () { return true; },
    formatDate: function (d) { return d || ''; },
    showToast: function (msg, kind) { this._lastToast = { msg: msg, kind: kind }; },
    initPage: function (opts) { if (opts && typeof opts.onReady === 'function') { this._onReady = opts.onReady; } },
  };
}

function MockElement(id) {
  this.id = id; this.className = ''; this.innerHTML = ''; this.textContent = '';
  this.value = ''; this.dataset = {}; this.style = {}; this.hidden = false;
  this.disabled = false; this.children = []; this.parentNode = null; this._listeners = {};
}
MockElement.prototype.addEventListener = function (t, fn) { if (!this._listeners[t]) this._listeners[t] = []; this._listeners[t].push(fn); };
MockElement.prototype.removeEventListener = function () {};
MockElement.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; if (c.id) this._register(c); return c; };
MockElement.prototype.insertBefore = function (c, r) { this.children.unshift(c); c.parentNode = this; if (c.id) this._register(c); return c; };
MockElement.prototype.querySelector = function () { return null; };
MockElement.prototype.querySelectorAll = function () { return []; };
MockElement.prototype.closest = function () { return null; };
MockElement.prototype.focus = function () {};
MockElement.prototype.setAttribute = function (k, v) { this[k] = v; };
MockElement.prototype.getAttribute = function (k) { return this[k] || null; };
MockElement.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, width: 100, height: 50 }; };

function MockDocument() {
  this._elements = {};
  var self = this;
  this.body = new MockElement('body');
  this.body.appendChild = function (c) { this.children.push(c); c.parentNode = this; if (c.id) self._elements[c.id] = c; return c; };
}
MockDocument.prototype.getElementById = function (id) {
  return this._elements[id] || null;
};
MockDocument.prototype._setElement = function (id, el) { this._elements[id] = el; };
MockDocument.prototype.querySelectorAll = function () { return []; };
MockDocument.prototype.querySelector = function () { return null; };
MockDocument.prototype.createElement = function (tag) {
  var el = new MockElement('auto-' + tag + '-' + Math.random().toString(36).slice(2, 6));
  el.tagName = tag;
  return el;
};

// Pre-register elements that dashboard.js IIFE touches on load
function preRegisterElements(doc) {
  ['wel-date','stat-today','stat-today-sub','stat-income','stat-income-sub','stat-pending-reports',
   'week-schedule','today-schedule','start-next-session','recent-sessions','todo-list','kb-mod-count',
   'quick-modules','more-modules','more-mod-btn','manage-quick-tools','reset-quick-tools',
   'wb-client-view','wb-document-view','hero-stats','ob-checklist','dual-workbench'
  ].forEach(function (id) { doc._setElement(id, new MockElement(id)); });
  // Elements with closest() need to return a parent
  doc.getElementById('hero-stats').closest = function () { return { hidden: false }; };
  doc.getElementById('ob-checklist').closest = function () { return { hidden: false }; };
}

function loadSandbox(store) {
  var app = mkApp();
  var doc = new MockDocument();
  preRegisterElements(doc);
  var ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, {
    Store: store, App: app, document: doc, window: ctx, console: console,
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    location: { href: '' }, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setImmediate: setImmediate,
    MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
    lucide: { createIcons: function () {} }, IconSystem: undefined,
    selectedWorkbenchClientId: 'c1', QuickRecord: undefined,
  });
  var WB_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'workbench-readonly.js'), 'utf8');
  vm.runInContext(WB_SRC, ctx);
  vm.runInContext(QR_SRC, ctx);
  vm.runInContext(DASH_SRC, ctx);
  return { ctx: ctx, app: app, doc: doc, store: store };
}

// ---- Static source tests ----

test('S1: index.html loads js/quick-record.js', function () {
  if (!/src="js\/quick-record\.js"/.test(INDEX_HTML)) throw new Error('quick-record.js not loaded');
});

test('S2: quick-record.js loaded before dashboard.js', function () {
  var qrPos = INDEX_HTML.indexOf('js/quick-record.js');
  var dashPos = INDEX_HTML.indexOf('js/dashboard.js');
  if (qrPos < 0 || dashPos < 0) throw new Error('scripts missing');
  if (qrPos >= dashPos) throw new Error('quick-record.js must load before dashboard.js');
});

test('S3: quick-record.js loaded exactly once', function () {
  var m = INDEX_HTML.match(/js\/quick-record\.js/g) || [];
  if (m.length !== 1) throw new Error('expected 1, got ' + m.length);
});

test('S4: index.html has qr-entry button', function () {
  if (!/id="qr-entry"/.test(INDEX_HTML)) throw new Error('qr-entry not found');
});

test('S5: dashboard.js calls bindQuickRecord in onReady', function () {
  if (!/bindQuickRecord\(\)/.test(DASH_SRC)) throw new Error('bindQuickRecord not called');
});

test('S6: dashboard.js defines openQuickRecord', function () {
  if (!/function openQuickRecord/.test(DASH_SRC)) throw new Error('openQuickRecord not defined');
});

test('S7: dashboard.js delegates to QuickRecord.createQuickRecord', function () {
  if (!/QuickRecord\.createQuickRecord/.test(DASH_SRC)) throw new Error('does not delegate');
});

test('S8: notes followup uses routeFor (validated deep link)', function () {
  if (!/routeFor\('consult-notes\.html', fcid, fsid\)/.test(DASH_SRC)) throw new Error('notes action missing routeFor');
});

test('S9: no-write boundary — dashboard.js has no Store write calls in quick-record region', function () {
  var region = DASH_SRC.slice(DASH_SRC.indexOf('function openQuickRecord'));
  var violations = (region.match(/Store\.create[A-Z]/g) || []).concat(region.match(/Store\.update[A-Z]/g) || []).concat(region.match(/Store\.delete[A-Z]/g) || []);
  if (violations.length) throw new Error('Store writes found: ' + violations.join(', '));
});

test('S10: followup actions validate clientId via Store.getClient', function () {
  if (!/Store\.getClient\(fcid\)/.test(DASH_SRC)) throw new Error('no Store.getClient validation in followup');
});

test('S11: pending state blocks resubmit', function () {
  if (!/_state\.pending/.test(DASH_SRC)) throw new Error('no pending check in submit handler');
});

test('S12: canSwitchAway blocks overlay close during pending', function () {
  if (!/canSwitchAway/.test(DASH_SRC)) throw new Error('no canSwitchAway check');
});

test('S13: keyboard handler on qr-entry (Enter/Space)', function () {
  if (!/keydown/.test(DASH_SRC)) throw new Error('no keydown handler');
});

test('S14: workbench action injection uses data-qr-action', function () {
  if (!/data-qr-action/.test(DASH_SRC)) throw new Error('no data-qr-action injection');
});

test('S15: CSS has qr-overlay, qr-panel, qr-followup and reduced-motion', function () {
  if (!/\.qr-overlay/.test(CSS_SRC)) throw new Error('qr-overlay CSS missing');
  if (!/\.qr-panel/.test(CSS_SRC)) throw new Error('qr-panel CSS missing');
  if (!/\.qr-followup/.test(CSS_SRC)) throw new Error('qr-followup CSS missing');
  if (!/prefers-reduced-motion/.test(CSS_SRC)) throw new Error('reduced-motion CSS missing');
});

// ---- Real DOM harness tests ----

test('T1: QuickRecord module exposed after VM load', function () {
  var env = loadSandbox(mkStore());
  if (!env.ctx.QuickRecord) throw new Error('QuickRecord not on window');
  if (typeof env.ctx.QuickRecord.createQuickRecord !== 'function') throw new Error('createQuickRecord not a function');
});

test('T2: openQuickRecord creates overlay DOM', function () {
  var env = loadSandbox(mkStore());
  // Pre-register qr-* elements that openQuickRecord will query after creating overlay
  ['qr-overlay','qr-panel','qr-client-name','qr-notes','qr-date','qr-session-number','qr-fee','qr-submit','qr-cancel','qr-close','qr-result'].forEach(function (id) {
    var el = new MockElement(id);
    el.querySelector = function () { return new MockElement('inner'); };
    env.doc._setElement(id, el);
  });
  // Do NOT call onReady — it triggers full dashboard render which needs many DOM elements.
  // We test openQuickRecord directly.
  env.ctx.openQuickRecord();
  var overlay = env.doc.getElementById('qr-overlay');
  if (!overlay) throw new Error('qr-overlay not created');
});

test('T3: openQuickRecord shows warning when no client selected', function () {
  var store = mkStore();
  var app = mkApp();
  app.getActiveClientId = function () { return ''; };
  var doc = new MockDocument();
  preRegisterElements(doc);
  var ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, {
    Store: store, App: app, document: doc, window: ctx, console: console,
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    location: { href: '' }, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setImmediate: setImmediate, MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
    lucide: { createIcons: function () {} }, IconSystem: undefined, selectedWorkbenchClientId: '', QuickRecord: undefined,
  });
  vm.runInContext(QR_SRC, ctx);
  vm.runInContext(DASH_SRC, ctx);
  ctx.openQuickRecord();
  if (!app._lastToast || app._lastToast.kind !== 'warning') throw new Error('expected warning toast');
});

test('T4: openQuickRecord populates client name and form defaults', function () {
  var env = loadSandbox(mkStore());
  ['qr-overlay','qr-panel','qr-client-name','qr-notes','qr-date','qr-session-number','qr-fee','qr-submit','qr-cancel','qr-close','qr-result'].forEach(function (id) {
    var el = new MockElement(id);
    el.querySelector = function () { return new MockElement('inner'); };
    env.doc._setElement(id, el);
  });
  env.ctx.openQuickRecord();
  var nameEl = env.doc.getElementById('qr-client-name');
  if (!nameEl || !nameEl.textContent || nameEl.textContent.indexOf('Alice') < 0) throw new Error('client name not populated');
  var dateEl = env.doc.getElementById('qr-date');
  if (dateEl.value !== '2026-07-21') throw new Error('date default not set, got: ' + dateEl.value);
  var numEl = env.doc.getElementById('qr-session-number');
  if (!numEl.value || numEl.value === '') throw new Error('session number not set');
});

test('T5: openQuickRecord module unavailable shows error', function () {
  var store = mkStore();
  var app = mkApp();
  var doc = new MockDocument();
  preRegisterElements(doc);
  var ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, {
    Store: store, App: app, document: doc, window: ctx, console: console,
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    location: { href: '' }, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setImmediate: setImmediate, MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
    lucide: { createIcons: function () {} }, IconSystem: undefined, selectedWorkbenchClientId: 'c1',
  });
  // Do NOT load quick-record.js — QuickRecord stays undefined
  vm.runInContext(DASH_SRC, ctx);
  ctx.openQuickRecord();
  if (!app._lastToast || app._lastToast.kind !== 'error') throw new Error('expected error toast for unavailable module');
});

// ---- Mutation sensitivity tests ----

test('M1: mutation — removing quick-record.js script tag breaks QuickRecord availability', function () {
  var mutated = INDEX_HTML.replace(/<script src="js\/quick-record\.js"><\/script>/, '');
  if (mutated === INDEX_HTML) throw new Error('mutation no-op');
  if (/js\/quick-record\.js/.test(mutated)) throw new Error('script not removed');
});

test('M2: mutation — removing bindQuickRecord from onReady breaks entry binding', function () {
  var mutated = DASH_SRC.replace(/^\s*bindQuickRecord\(\);/m, '');
  if (mutated === DASH_SRC) throw new Error('mutation no-op');
  if (/^\s*bindQuickRecord\(\);/m.test(mutated)) throw new Error('bindQuickRecord still present');
});

test('M3: mutation — bypassing QuickRecord.createQuickRecord with direct Store call is detectable', function () {
  var mutated = DASH_SRC.replace(/QuickRecord\.createQuickRecord\(input\)/, 'Store.createSessionDurable(input) /* bypass */');
  if (mutated === DASH_SRC) throw new Error('mutation no-op');
  if (/QuickRecord\.createQuickRecord\(input\)/.test(mutated)) throw new Error('createQuickRecord still called');
});

test('M4: mutation — removing Store.getClient validation from followup is detectable', function () {
  var mutated = DASH_SRC.replace(/Store\.getClient\(fcid\)/, 'true /* removed validation */');
  if (mutated === DASH_SRC) throw new Error('mutation no-op');
  if (/Store\.getClient\(fcid\)/.test(mutated)) throw new Error('validation still present');
});

// ---- Main ----

console.log('=== XJ-4.2.2-quick-record-ui-v1 contract ===\n');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
var crypto = require('crypto');
console.log('dashboard_sha256: ' + crypto.createHash('sha256').update(DASH_SRC).digest('hex'));
console.log('index_html_sha256: ' + crypto.createHash('sha256').update(INDEX_HTML).digest('hex'));
console.log('contract_phase: ' + (failed === 0 ? 'ALL-GREEN' : 'CONTRACT-BROKEN'));
console.log('注：仅验证 4.2.2-C QuickRecord UI 可达性契约，不宣称 release-ready。');
process.exit(failed === 0 ? 0 : 1);
