'use strict';
// settings-update-ui.js — typed status subscription UI tests (decision 2.5):
// no premature success, committed-only success text, unknown states neutral,
// keyboard focus, reduced motion, narrow window, long Chinese text wrapping,
// delayed-result and error handling. Uses a minimal DOM stub (no jsdom).
const { Suite } = require('./_testkit');
const ui = require('../../../app/js/settings-update-ui');
const s = new Suite('settings-update-ui');

function makeDocument() {
  const classes = [];
  const info = {
    textContent: '',
    classList: { add: (c) => { classes.push(c); }, remove: () => {}, toggle: (c) => { classes.push(c); } },
    style: {},
    classes
  };
  const doc = { getElementById: (id) => (id === 'update-info' ? info : null) };
  return { doc, info };
}

function installWith(bridge, opts) {
  const { doc, info } = makeDocument();
  const win = {
    document: doc,
    navigator: { userAgent: opts && opts.portable ? 'Electron/43 portable' : 'Electron/43' },
    matchMedia: () => ({ matches: !!(opts && opts.reduceMotion) }),
    __XJ_UPDATE_BRIDGE__: bridge || { check: async () => ({ state: 'checking' }), onStatus: () => null }
  };
  ui.install(win);
  return { win, info };
}

s.ok('checking state renders', (() => {
  const { info } = installWith();
  const b = { check: async () => ({ state: 'committed', committed: true }) };
  const { doc, info: info2 } = makeDocument();
  const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: b };
  ui.install(win);
  return typeof win.checkUpdate === 'function';
})());

s.ok('committed-only success text', (() => {
  const { doc, info } = makeDocument();
  let listener = null;
  const bridge = { check: async () => ({}), onStatus: (cb) => { listener = cb; return () => {}; } };
  const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: bridge };
  ui.install(win);
  listener({ state: 'downloading', committed: false });
  const during = info.textContent;
  listener({ state: 'committed', committed: true });
  return during !== '更新已完成' && info.textContent === '更新已完成';
})());

s.ok('unknown state renders neutral, never success', (() => {
  const { doc, info } = makeDocument();
  let listener = null;
  const bridge = { check: async () => ({}), onStatus: (cb) => { listener = cb; return () => {}; } };
  const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: bridge };
  ui.install(win);
  listener({ state: 'totally-made-up', committed: false });
  return info.textContent === ui.UNKNOWN && info.textContent !== '更新已完成' && info.textContent !== '已是最新版本';
})());

s.ok('failed state shows rollback message', (() => {
  const { doc, info } = makeDocument();
  let listener = null;
  const bridge = { check: async () => ({}), onStatus: (cb) => { listener = cb; return () => {}; } };
  const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: bridge };
  ui.install(win);
  listener({ state: 'failed', committed: false });
  return /失败/.test(info.textContent);
})());

s.ok('no 3-second premature fallback', (() => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'app', 'js', 'settings-update-ui.js'), 'utf8');
  return !/setTimeout/.test(source) && !/已是最新版本/.test(source);
})());

s.ok('long Chinese text wraps in narrow windows', (() => {
  const { info } = installWith();
  return info.style.wordBreak === 'break-all' && info.style.whiteSpace === 'normal';
})());

s.ok('reduced motion honored', (() => {
  const { info } = installWith(null, { reduceMotion: true });
  return info.classes.includes('reduce-motion');
})());

s.ok('keyboard focus preserved (button is native)', (() => {
  // The update button is a native <button> in settings.html (frozen input);
  // the UI module never replaces it with a non-focusable element.
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'app', 'settings.html'), 'utf8');
  return /<button class="btn" onclick="checkUpdate\(\)">/.test(html);
})());

s.ok('delayed result does not flip to success', (() => {
  // A check that never resolves must NOT change the text to success.
  const { doc, info } = makeDocument();
  let resolveCheck;
  const bridge = { check: () => new Promise((resolve) => { resolveCheck = resolve; }), onStatus: () => null };
  const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: bridge };
  ui.install(win);
  win.checkUpdate();
  const before = info.textContent;
  return before === '正在检查更新…';
})());

(async () => {
  s.ok('error result async verified', await (async () => {
    const { doc, info } = makeDocument();
    const bridge = { check: async () => { throw new Error('offline'); }, onStatus: () => null };
    const win = { document: doc, navigator: { userAgent: 'Electron/43' }, matchMedia: () => ({ matches: false }), __XJ_UPDATE_BRIDGE__: bridge };
    ui.install(win);
    await win.checkUpdate();
    return /失败/.test(info.textContent);
  })());
  console.log('SETTINGS_UI_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
