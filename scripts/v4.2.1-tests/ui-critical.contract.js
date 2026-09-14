#!/usr/bin/env node
'use strict';

// XinJing v4.2.1 — ui-critical contract (codebuddy remediation)
//
// This contract verifies critical UI invariants (shared modal stack, focus
// restore, scroll lock, Escape-to-close, six theme token maps) against the
// REAL production source. The original 14 static source-string assertions are
// preserved, PLUS a dynamic section that loads the REAL modal implementation
// from app/js/app.js into a trusted real-DOM boundary (no simplified copy of
// the modal logic is tested) and asserts real runtime behavior, PLUS mutation
// gates that prove the dynamic assertions are sensitive to behavior removal.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const source = {
  app: fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8'),
  calendar: fs.readFileSync(path.join(ROOT, 'app', 'js', 'session-calendar.js'), 'utf8'),
  billing: fs.readFileSync(path.join(ROOT, 'app', 'billing-shell.html'), 'utf8'),
  workbench: fs.readFileSync(path.join(ROOT, 'app', 'css', 'workbench.css'), 'utf8'),
  ui: fs.readFileSync(path.join(ROOT, 'app', 'css', 'xj-ui-system.css'), 'utf8'),
};

let passed = 0;
let failed = 0;
let staticPassed = 0;
let staticFailed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('[PASS] ' + name);
  } catch (error) {
    failed += 1;
    console.error('[FAIL] ' + name + ': ' + error.message);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------
// ORIGINAL STATIC SOURCE ASSERTIONS (preserved verbatim)
// --------------------------------------------------------------------------
test('U1 billing clear cancel closes the real confirm modal', () => {
  expect(!/closeModal\(\\?'clear-modal\\?'\)/.test(source.billing), 'clear-modal stale target remains');
  expect(/data-modal-cancel[^>]*onclick="App\.closeModal\('confirm-modal'\)"/.test(source.billing), 'safe cancel does not target confirm-modal');
});

test('U2 shared modal maintains a stack and restores triggering focus', () => {
  expect(/modalStack/.test(source.app), 'modal stack missing');
  expect(/returnFocus/.test(source.app), 'trigger focus is not recorded');
  expect(/\.focus\(\)/.test(source.app), 'focus restoration missing');
});

test('U3 shared modal supports Escape and traps Tab in the active dialog', () => {
  expect(/e\.key === 'Escape'[\s\S]*?closeModalElement/.test(source.app), 'Escape does not close top dialog');
  expect(/e\.key === 'Tab'[\s\S]*?focusableElements/.test(source.app), 'Tab focus trap missing');
  expect(/aria-modal/.test(source.app) && /role.*dialog/.test(source.app), 'dialog semantics missing');
});

test('U4 confirmDialog exists on pages without static confirm markup and awaits pending work', () => {
  expect(/function ensureConfirmModal/.test(source.app), 'confirm modal is not created on demand');
  expect(/await onConfirm/.test(source.app), 'confirm callback is not awaited');
  expect(/处理中/.test(source.app), 'pending feedback missing');
});

test('U5 calendar single deletion uses shared confirmation and no native confirm', () => {
  expect(!/\bconfirm\s*\(/.test(source.calendar), 'native confirm remains');
  expect(/App\.confirmDialog\([\s\S]*?deleteAndFinish/.test(source.calendar), 'shared confirmation is not connected to durable delete');
});

test('U6 dynamic series deletion dialog has safe focus, Escape and focus return', () => {
  expect(/App\.openModalElement\(overlay/.test(source.calendar), 'series dialog does not use shared modal lifecycle');
  expect(/App\.closeModalElement\(overlay/.test(source.calendar), 'series dialog bypasses shared close/focus return');
  expect(/removeOnClose:\s*true/.test(source.calendar), 'series dialog is not removed after Escape closes it');
});

test('U7 modal open locks background scrolling and disabled controls are explicit', () => {
  expect(/body\.classList\.add\('xj-modal-open'\)/.test(source.app), 'modal does not lock page scroll');
  expect(/body\.xj-modal-open\s*\{[^}]*overflow:\s*hidden/.test(source.workbench), 'modal-open CSS missing');
  expect(/button:disabled[\s\S]*?cursor:\s*not-allowed/.test(source.workbench), 'shared disabled state missing');
});

test('U8 reduced motion disables active transforms', () => {
  const block = (source.workbench.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) || []).join('\n');
  expect(/transform:\s*none\s*!important/.test(block), 'reduced motion does not disable transforms');
});

test('U9 Theatre Dark has an independent warm token map', () => {
  expect(/\[data-skin="theatre"\]\.dark\s*\{/.test(source.ui), 'Theatre Dark selector missing');
  const block = source.ui.match(/\[data-skin="theatre"\]\.dark\s*\{[\s\S]*?\n\}/);
  expect(block && /--xj-canvas:\s*#1a1614/.test(block[0]) && /--xj-accent:\s*#c96b78/.test(block[0]), 'Theatre Dark does not preserve approved warm tokens');
});

test('U10 Observatory Light and Dark use distinct token maps', () => {
  expect(/\[data-skin="observatory"\]:not\(\.dark\)\s*\{/.test(source.ui), 'Observatory Light selector missing');
  expect(/\[data-skin="observatory"\]\.dark\s*\{/.test(source.ui), 'Observatory Dark selector missing');
  const light = source.ui.match(/\[data-skin="observatory"\]:not\(\.dark\)\s*\{[\s\S]*?\n\}/);
  const dark = source.ui.match(/\[data-skin="observatory"\]\.dark\s*\{[\s\S]*?\n\}/);
  expect(light && /color-scheme:\s*light/.test(light[0]) && /--xj-canvas:\s*#f1f5f7/.test(light[0]), 'Observatory Light map is not independent');
  expect(dark && /color-scheme:\s*dark/.test(dark[0]) && /--xj-canvas:\s*#111719/.test(dark[0]), 'Observatory Dark map regressed');
});

test('U11 Observatory Light does not inherit dark-only flagship badge colors', () => {
  expect(!/\[data-skin="observatory"\]\s+\.xj-tier-badge\.custom/.test(source.ui), 'Observatory badge selector still applies dark colors in Light mode');
  expect(/\[data-skin="observatory"\]\.dark\s+\.xj-tier-badge\.custom/.test(source.ui), 'Observatory dark badge selector missing');
});

test('U12 Clinical Dark defines shared component tokens instead of inheriting Light', () => {
  const dark = source.ui.match(/\[data-skin="clinical"\]\.dark\s*\{[\s\S]*?\n\}/);
  expect(dark && /color-scheme:\s*dark/.test(dark[0]), 'Clinical Dark selector missing');
  expect(/--xj-canvas:\s*#151c1a/.test(dark[0]) && /--xj-accent:\s*#50b5a5/.test(dark[0]), 'Clinical Dark shared tokens are incomplete');
});

test('U13 dynamic modal lifecycle removes transient overlays on close', () => {
  expect(/removeOnClose:\s*options\.removeOnClose === true/.test(source.app), 'modal entry does not record removeOnClose');
  expect(/entry\.removeOnClose[\s\S]*?overlay\.remove\(\)/.test(source.app), 'shared close does not remove transient overlay');
});

test('U14 custom billing clear content hides and restores the generic footer', () => {
  expect(/modalFooter\.style\.display = 'none'/.test(source.billing), 'generic confirm footer remains visible behind billing clear controls');
  expect(/onClose:[\s\S]*?modalFooter\.style\.display = ''/.test(source.billing), 'generic confirm footer is not restored after billing clear closes');
  expect(/initialFocus:\s*'#clear-cancel-btn'/.test(source.billing), 'billing clear does not focus its safe cancel action');
});

// Capture the static-source-check tally. The original 14 static assertions are
// preserved and still reported verbatim as `UI_CRITICAL: 14 passed / 0 failed`
// so the existing self-test.js v4.2.1-15 coupling keeps passing; the dynamic
// real-execution + mutation-gate results are reported in the TOTAL line below.
staticPassed = passed;
staticFailed = failed;

// --------------------------------------------------------------------------
// DYNAMIC REAL-DOM EXECUTION (loads the REAL modal code from app.js)
// --------------------------------------------------------------------------

// Minimal but faithful DOM boundary used ONLY to execute the production modal
// code. This is an environment shim, NOT a re-implementation of the modal
// logic: openModalElement / closeModalElement / returnFocus / modalStack are
// the unchanged functions sliced from app.js and run via vm.
function buildDomShim() {
  function descendants(el, acc) {
    for (const c of el._children) { acc.push(c); descendants(c, acc); }
    return acc;
  }

  function matchSimple(el, sel) {
    let s = sel.trim();
    const notMatch = s.match(/^:not\(([^)]*)\)$/);
    if (notMatch) return !matchSimple(el, notMatch[1]);
    let m;
    if ((m = s.match(/^([a-zA-Z][a-zA-Z0-9]*)/))) {
      if (el.tagName !== m[1].toUpperCase()) return false;
      s = s.slice(m[1].length);
    }
    if ((m = s.match(/^#([\w-]+)/))) {
      if (el.id !== m[1]) return false;
      s = s.slice(m[0].length);
    }
    while ((m = s.match(/^\.([\w-]+)/))) {
      if (!el._classes.has(m[1])) return false;
      s = s.slice(m[0].length);
    }
    while ((m = s.match(/^\[([\w-]+)(?:\s*!?=\s*"([^"]*)")?\]/))) {
      const attr = m[1];
      const val = m[2];
      if (val === undefined) { if (!(attr in el._attrs)) return false; }
      else { if (el._attrs[attr] !== val) return false; }
      s = s.slice(m[0].length);
    }
    return s.length === 0;
  }

  function query(root, selector, all) {
    const groups = selector.split(',').map((x) => x.trim()).filter(Boolean);
    const results = [];
    for (const group of groups) {
      const chain = group.split(/\s+/).filter(Boolean);
      const last = chain[chain.length - 1];
      const prefix = chain.slice(0, -1);
      const allEls = descendants(root, []);
      for (const el of allEls) {
        if (!matchSimple(el, last)) continue;
        let ok = true;
        let p = el.parentNode;
        for (let i = prefix.length - 1; i >= 0; i -= 1) {
          while (p && p !== root && !matchSimple(p, prefix[i])) p = p.parentNode;
          if (!p || !matchSimple(p, prefix[i])) { ok = false; break; }
          p = p.parentNode;
        }
        if (ok) results.push(el);
      }
    }
    return all ? results : (results[0] || null);
  }

  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      nodeType: 1,
      _attrs: {},
      _classes: new Set(),
      _children: [],
      parentNode: null,
      _listeners: {},
      style: {},
      dataset: {},
      _text: '',
      id: '',
      isConnected: false,
      hidden: false,
      _html: '',
      get className() { return Array.from(this._classes).join(' '); },
      set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
      setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      hasAttribute(k) { return k in this._attrs; },
      removeAttribute(k) { delete this._attrs[k]; },
      appendChild(c) { c.parentNode = this; c.isConnected = this.isConnected; this._children.push(c); return c; },
      removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); c.parentNode = null; c.isConnected = false; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      replaceChild(n, o) {
        const i = this._children.indexOf(o);
        if (i >= 0) { this._children[i] = n; n.parentNode = this; n.isConnected = this.isConnected; o.parentNode = null; o.isConnected = false; }
        return o;
      },
      cloneNode() {
        const c = makeEl(this.tagName);
        c._attrs = Object.assign({}, this._attrs);
        c._classes = new Set(this._classes);
        c.id = this.id; c._text = this._text; c.hidden = this.hidden;
        c.style = Object.assign({}, this.style);
        c.ownerDocument = this.ownerDocument;
        c._children = this._children.map((ch) => { const cc = ch.cloneNode(); cc.parentNode = c; cc.isConnected = c.isConnected; return cc; });
        return c;
      },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); },
      dispatchEvent(ev) { (this._listeners[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; },
      focus() { if (this.ownerDocument) this.ownerDocument.__active = this; },
      getClientRects() { return [{}]; },
      querySelector(sel) { return query(this, sel, false); },
      querySelectorAll(sel) { return query(this, sel, true); },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
      contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parentNode; } return false; },
    };
    el.classList = {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (x) => el._classes.has(x),
      toggle: (x, f) => { if (f === undefined) f = !el._classes.has(x); if (f) el._classes.add(x); else el._classes.delete(x); return f; },
    };
    return el;
  }

  const doc = makeEl('#document');
  doc.nodeType = 9;
  doc.ownerDocument = doc;
  const documentElement = makeEl('html'); doc._children.push(documentElement); documentElement.parentNode = doc; documentElement.isConnected = true; documentElement.ownerDocument = doc;
  const head = makeEl('head'); documentElement._children.push(head); head.parentNode = documentElement; head.isConnected = true; head.ownerDocument = doc;
  const body = makeEl('body'); documentElement._children.push(body); body.parentNode = documentElement; body.isConnected = true; body.ownerDocument = doc;
  doc.documentElement = documentElement; doc.head = head; doc.body = body;
  doc.__active = body;
  Object.defineProperty(doc, 'activeElement', { get() { return doc.__active; } });
  doc.createElement = (t) => { const e = makeEl(t); e.ownerDocument = doc; return e; };
  doc.getElementById = (id) => descendants(doc, []).find((e) => e.id === id) || null;
  doc.querySelector = (s) => query(doc, s, false);
  doc.querySelectorAll = (s) => query(doc, s, true);
  doc.addEventListener = (t, fn) => { doc._listeners[t] = doc._listeners[t] || []; doc._listeners[t].push(fn); };
  doc.removeEventListener = (t, fn) => { if (doc._listeners[t]) doc._listeners[t] = doc._listeners[t].filter((f) => f !== fn); };
  doc.contains = (node) => { if (!node) return false; let n = node; while (n) { if (n === doc) return true; n = n.parentNode; } return false; };
  doc.dispatchKey = (key, shiftKey) => {
    (doc._listeners['keydown'] || []).slice().forEach((fn) => fn({ key: key, shiftKey: !!shiftKey, preventDefault() {}, stopPropagation() {} }));
  };
  return doc;
}

function extractModalBlock(appSrc) {
  const start = appSrc.indexOf('// ---------- 模态框 ----------');
  const end = appSrc.indexOf('// ---------- 下载 ----------');
  if (start < 0 || end < 0) throw new Error('modal block markers not found in app.js');
  return appSrc.slice(start, end);
}

function loadRealModal(appSrc) {
  const block = extractModalBlock(appSrc);
  const doc = buildDomShim();
  let rafQueue = [];
  const sandbox = {
    document: doc,
    requestAnimationFrame: function (cb) { rafQueue.push(cb); },
    window: { matchMedia: function () { return { matches: false }; } },
    console: console,
    showToast: function () {},
    URL: URL,
  };
  // Run the REAL modal block in a context that provides document / requestAnimationFrame
  // / window / console as globals (the production code references them as free variables).
  // The trailing expression exposes the real internal functions for behavior assertions.
  const runnerSrc = block + '\n; ({ getStack: function(){ return modalStack; }, openModalElement: openModalElement, closeModalElement: closeModalElement, confirmDialog: confirmDialog });';
  const api = vm.runInNewContext(runnerSrc, sandbox, { filename: 'app.js@modal' });
  function flushRAF() { const q = rafQueue; rafQueue = []; q.forEach(function (cb) { try { cb(); } catch (e) {} }); }
  return { api: api, doc: doc, flushRAF: flushRAF };
}

// ---- Dynamic behavior assertions (REAL production modal code) ----
test('DYN-U2 modal stack grows on open and shrinks on close (real code)', () => {
  const { api, doc, flushRAF } = loadRealModal(source.app);
  const overlay = doc.createElement('div'); overlay.id = 'm1'; doc.body.appendChild(overlay);
  const trigger = doc.createElement('button'); doc.body.appendChild(trigger); trigger.focus();
  api.openModalElement(overlay, {}); flushRAF();
  expect(api.getStack().length === 1, 'modal stack should have 1 entry after open');
  api.closeModalElement(overlay); flushRAF();
  expect(api.getStack().length === 0, 'modal stack should be empty after close');
});

test('DYN-U2b focus is restored to the triggering element on close (real code)', () => {
  const { api, doc, flushRAF } = loadRealModal(source.app);
  const overlay = doc.createElement('div'); overlay.id = 'm2'; doc.body.appendChild(overlay);
  const trigger = doc.createElement('button'); doc.body.appendChild(trigger); trigger.focus();
  api.openModalElement(overlay, {}); flushRAF();
  api.closeModalElement(overlay); flushRAF();
  expect(doc.activeElement === trigger, 'focus must return to the triggering element after close');
});

test('DYN-U7 modal open locks background scroll via body.xj-modal-open (real code)', () => {
  const { api, doc, flushRAF } = loadRealModal(source.app);
  const overlay = doc.createElement('div'); overlay.id = 'm3'; doc.body.appendChild(overlay);
  expect(!doc.body.classList.contains('xj-modal-open'), 'body must not be locked before open');
  api.openModalElement(overlay, {}); flushRAF();
  expect(doc.body.classList.contains('xj-modal-open'), 'body must be locked (xj-modal-open) while modal open');
  api.closeModalElement(overlay); flushRAF();
  expect(!doc.body.classList.contains('xj-modal-open'), 'body lock must be released after close');
});

test('DYN-U3 Escape closes the top dialog (real keydown handler)', () => {
  const { api, doc, flushRAF } = loadRealModal(source.app);
  const overlay = doc.createElement('div'); overlay.id = 'm4'; doc.body.appendChild(overlay);
  api.openModalElement(overlay, {}); flushRAF();
  expect(api.getStack().length === 1, 'modal open before Escape');
  doc.dispatchKey('Escape'); flushRAF();
  expect(api.getStack().length === 0, 'Escape must close the top dialog');
});

// ---- Mutation gates: prove the dynamic assertions are sensitive ----
test('MUT-U2-focus: removing focus-restore behavior breaks DYN-U2b (gate)', () => {
  const mutated = source.app
    .replace(/returnFocus: active && active !== document\.body && typeof active\.focus === 'function' \? active : null,/, 'returnFocus: null,')
    .replace(/try \{ returnFocus\.focus\(\); \} catch \(error\) \{\}/, '/* focus restore disabled */');
  const { api, doc, flushRAF } = loadRealModal(mutated);
  const overlay = doc.createElement('div'); overlay.id = 'mm'; doc.body.appendChild(overlay);
  const trigger = doc.createElement('button'); doc.body.appendChild(trigger); trigger.focus();
  api.openModalElement(overlay, {}); flushRAF();
  api.closeModalElement(overlay); flushRAF();
  expect(doc.activeElement !== trigger, 'MUT gate: focus restore removed -> trigger must NOT be restored (proves DYN-U2b is sensitive)');
});

test('MUT-U7-stack: replacing modalStack push with no-op breaks DYN-U2 (gate)', () => {
  const mutated = source.app.replace(/modalStack\.push\(entry\);/, '/* modalStack.push disabled */');
  const { api, doc, flushRAF } = loadRealModal(mutated);
  const overlay = doc.createElement('div'); overlay.id = 'ms'; doc.body.appendChild(overlay);
  const trigger = doc.createElement('button'); doc.body.appendChild(trigger); trigger.focus();
  api.openModalElement(overlay, {}); flushRAF();
  expect(api.getStack().length === 0, 'MUT gate: modalStack push disabled -> stack empty (proves DYN-U2 is sensitive)');
});

// Static-source-check summary (kept verbatim for self-test.js v4.2.1-15 coupling).
console.log('UI_CRITICAL: ' + staticPassed + ' passed / ' + staticFailed + ' failed');
// Full summary including real-DOM execution and mutation gates.
console.log('UI_CRITICAL_TOTAL: ' + passed + ' passed / ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
