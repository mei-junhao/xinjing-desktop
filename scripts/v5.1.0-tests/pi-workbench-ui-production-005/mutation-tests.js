'use strict';

/**
 * 005 UI 反向变异测试。
 *
 * 这里不把源码字符串匹配当成证据：每个变异只是在内存中生成一个变体，
 * 然后把同一份 Pi Workbench 模块装进最小 DOM/bridge 运行时，观察真实状态、
 * handler 调用、材料展示和证据校验结果。生产文件不会被改写。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'D:/xinjing-electron';
const SOURCE_FILE = path.join(ROOT, 'app/js/chat-home.js');
const EVIDENCE_FILE = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-ui-production-integration-005/evidence/runtime-matrix.json');
const source = fs.readFileSync(SOURCE_FILE, 'utf8');
const moduleStart = source.indexOf('var PiWorkbench = (function () {');
const moduleEnd = source.indexOf('// 生产路径自动挂载', moduleStart);
if (moduleStart < 0 || moduleEnd < 0) throw new Error('PiWorkbench module boundary missing');
const moduleSource = source.slice(moduleStart, moduleEnd);

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.style = Object.create(null);
    this.dataset = Object.create(null);
    this.className = '';
    this.disabled = false;
    this.tabIndex = 0;
    this._textContent = '';
    this._innerHTML = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.classList = {
      add: (...names) => names.forEach((name) => { this.className = (this.className + ' ' + name).trim(); }),
      remove: (...names) => names.forEach((name) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== name).join(' '); }),
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  set id(value) { this.setAttribute('id', value); }
  get id() { return this.attributes.id || ''; }

  set textContent(value) {
    this._textContent = String(value == null ? '' : value);
    this._innerHTML = '';
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(value) {
    this._innerHTML = String(value == null ? '' : value);
    this._textContent = '';
    this.children = [];
    const html = this._innerHTML;
    const idRe = /<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi;
    let match;
    while ((match = idRe.exec(html))) {
      const child = new FakeElement(this.ownerDocument, match[1]);
      child.setAttribute('id', match[2]);
      const tag = match[0];
      const tabindex = tag.match(/\btabindex="(-?\d+)"/i);
      if (tabindex) child.tabIndex = Number(tabindex[1]);
      const disabled = /\sdisabled(?:\s|=|>)/i.test(tag);
      child.disabled = disabled;
      this.appendChild(child);
    }
  }
  get innerHTML() { return this._innerHTML; }

  setAttribute(name, value) {
    const key = String(name);
    const val = String(value);
    this.attributes[key] = val;
    if (key === 'id') this.ownerDocument.elements.set(val, this);
    if (key === 'class') this.className = val;
    if (key === 'tabindex') this.tabIndex = Number(val);
    if (key === 'data-state') this.dataset.state = val;
  }
  getAttribute(name) { return this.attributes[String(name)] || null; }
  removeAttribute(name) { delete this.attributes[String(name)]; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) this.ownerDocument.elements.set(child.id, child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((x) => x !== child);
    child.parentNode = null;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  click() {
    for (const handler of this.listeners.click || []) handler({ target: this });
  }
  focus() {
    if (!this.disabled && this.tabIndex >= 0) this.ownerDocument.activeElement = this;
  }
  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') all.push(child);
        if (selector[0] === '#' && child.id === selector.slice(1)) all.push(child);
        if (selector[0] === '.' && child.classList.contains(selector.slice(1))) all.push(child);
        visit(child);
      }
    };
    visit(this);
    return all;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
    this.documentElement = new FakeElement(this, 'html');
    this.documentElement.scrollWidth = 1024;
    this.documentElement.clientWidth = 1024;
    this.documentElement.scrollHeight = 700;
    this.documentElement.clientHeight = 700;
  }
  createElement(tagName) { return new FakeElement(this, tagName); }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
}

function makeRuntime(sourceVariant, options) {
  const opts = options || {};
  const document = new FakeDocument();
  const root = document.createElement('div');
  root.id = 'pi-workbench-root';
  document.documentElement.appendChild(root);
  const calls = { commit: 0, directStore: 0, publish: 0 };
  const transport = {
    requestHandler: null,
    onRequest(handler) { this.requestHandler = handler; },
    publishState() { calls.publish += 1; },
    reply() {},
  };
  const bridge = {
    startTask: () => Promise.resolve({ ok: true }),
    contextCheck: () => Promise.resolve({ ok: true }),
    plan: () => Promise.resolve({ ok: true }),
    runToolStep: () => Promise.resolve(opts.runToolResult || { ok: true }),
    commitStep: () => {
      calls.commit += 1;
      return Promise.resolve(opts.commitResult || { awaiting: true, pendingApprovalId: 'approval_005' });
    },
    resolveApproval: () => Promise.resolve(opts.resolveResult || { ok: true }),
    pause: () => Promise.resolve({ ok: true }),
    resume: () => Promise.resolve({ ok: true }),
    cancel: () => Promise.resolve({ ok: true }),
  };
  const api = {
    piTransport: transport,
    selectClinicalMaterialFile: () => Promise.resolve({ ok: true, selectionId: 'selection_005' }),
    parseClinicalMaterialFile: () => Promise.resolve({ ok: true, displayName: '合成材料', path: 'C:\\secret\\clinical.txt' }),
  };
  const win = {
    __PI__: bridge,
    __XJ_API__: api,
    App: { canUse: () => opts.canUse === undefined ? true : opts.canUse },
  };
  const context = {
    window: win,
    App: win.App,
    document,
    console,
    Promise,
    Date,
    JSON,
    String,
    Number,
    Object,
    Array,
    Math,
    RegExp,
    Error,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(sourceVariant + '\nthis.__PiWorkbench = PiWorkbench;', context, { filename: SOURCE_FILE + '#005-mutation-runtime' });
  const instance = context.__PiWorkbench.create({});
  instance.mount(root);
  instance._setContextForTests({ clientId: 'client_005', sessionId: 'session_005', storeProjectionVersion: 3, membershipProjectionVersion: 2 });
  return { document, root, instance, bridge, api, transport, calls, context };
}

async function start(runtime) {
  await runtime.instance.startObserve({ clientId: 'client_005', sessionId: 'session_005', storeProjectionVersion: 3, membershipProjectionVersion: 2 });
}

function mutate(name, replacement) {
  const next = replacement(moduleSource);
  if (next === moduleSource) throw new Error(name + ': replacement did not apply');
  return next;
}

function replaceOnce(text, needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(label + ': needle not found');
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

function evidenceAccepts(value) {
  if (!value || value.schema !== 'v1-nested-fields' || !Array.isArray(value.cells) || value.cells.length !== 18) return false;
  return value.cells.every((cell) => cell && cell.overflow && typeof cell.overflow.hasHorizontalOverflow === 'boolean'
    && cell.vertical && typeof cell.vertical.hasVerticalOverflow === 'boolean'
    && cell.errors && cell.errors.page === 0 && cell.errors.console === 0
    && cell.reducedMotion && typeof cell.reducedMotion.mqMatches === 'boolean'
    && Number.isInteger(cell.reducedMotion.animationCount)
    && cell.keyboardFocus && typeof cell.keyboardFocus.hasFocus === 'boolean'
    && Object.prototype.hasOwnProperty.call(cell.keyboardFocus, 'activeTag')
    && Object.prototype.hasOwnProperty.call(cell.keyboardFocus, 'activeId')
    && Object.prototype.hasOwnProperty.call(cell.keyboardFocus, 'focusVisible'));
}

async function probeApprovalAwait(sourceVariant) {
  const r = makeRuntime(sourceVariant);
  await start(r);
  await r.instance.commitDraft({ note: 'synthetic' });
  const state = r.instance.getState();
  return state.taskStatus === 'awaiting_confirmation' && state.pendingApprovalId === 'approval_005';
}

async function probeDirectStore(sourceVariant) {
  const r = makeRuntime(sourceVariant);
  await start(r);
  await r.instance.commitDraft({ note: 'synthetic' });
  const state = r.instance.getState();
  return r.calls.commit === 1 && state.taskStatus === 'awaiting_confirmation' && r.calls.directStore === 0;
}

async function probeOkFalse(sourceVariant) {
  const r = makeRuntime(sourceVariant, { commitResult: { ok: false, code: 'XJ_PI_DURABLE_FAILED' } });
  await start(r);
  await r.instance.commitDraft({ note: 'synthetic' });
  const state = r.instance.getState();
  return state.taskStatus === 'failed' && state.lastSavedObjectId === null;
}

async function probeMembership(sourceVariant) {
  const r = makeRuntime(sourceVariant, { canUse: false });
  await start(r);
  const result = await r.instance.commitDraft({ note: 'synthetic' });
  return result && result.code === 'membership-unknown' && r.calls.commit === 0;
}

async function probeMaterialPath(sourceVariant) {
  const r = makeRuntime(sourceVariant);
  await r.instance.uploadMaterial();
  const text = r.document.getElementById('wb-materials').textContent;
  return text.indexOf('C:\\secret\\clinical.txt') < 0;
}

async function probeCancel(sourceVariant) {
  const r = makeRuntime(sourceVariant);
  await start(r);
  await r.instance.cancel();
  return r.instance.getState().taskStatus === 'cancelled';
}

async function probeFocus(sourceVariant) {
  const r = makeRuntime(sourceVariant);
  const startButton = r.document.getElementById('wb-start');
  startButton.focus();
  return startButton.tabIndex >= 0 && r.document.activeElement === startButton;
}

async function probeEvidenceField() {
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8'));
  const mutated = JSON.parse(JSON.stringify(evidence));
  delete mutated.cells[0].reducedMotion;
  return { base: evidenceAccepts(evidence), mutated: evidenceAccepts(mutated) };
}

const probes = [
  ['M1-remove-approval-await', (s) => mutate('M1', (x) => replaceOnce(x, 'if (r && r.awaiting) {', 'if (false && r && r.awaiting) {', 'M1')), probeApprovalAwait],
  ['M2-direct-store-write', (s) => mutate('M2', (x) => replaceOnce(x, 'return window.__PI__.commitStep(state.taskId, tgt, fields || {}).then(function (r) {', 'return Promise.resolve({ ok: true, savedObjectId: \'direct-store\' }).then(function (r) {', 'M2')), probeDirectStore],
  ['M3-swallow-ok-false', (s) => mutate('M3', (x) => replaceOnce(x, 'if (isOk(r)) {\n          setStatus(\'succeeded\'); showApprovalCard(null);', 'if (isOk(r) || (r && r.ok === false)) {\n          setStatus(\'succeeded\'); showApprovalCard(null);', 'M3')), probeOkFalse],
  ['M4-bypass-membership-gate', (s) => mutate('M4', (x) => replaceOnce(x, "if (!membershipAllows('ai-supervise') && !membershipAllows('manual-core')) {", 'if (false) {', 'M4')), probeMembership],
  ['M5-material-absolute-path-leak', (s) => mutate('M5', (x) => replaceOnce(x, "name: String(parsed.displayName || parsed.name || '材料').slice(0, 40),", "name: String(parsed.path || parsed.displayName || parsed.name || '材料').slice(0, 200),", 'M5')), probeMaterialPath],
  ['M6-cancel-reports-success', (s) => mutate('M6', (x) => replaceOnce(x, "function cancel() { return lifecycle('cancel', '已取消（不可恢复）', 'wb-cancel', 'cancelled'); }", "function cancel() { return lifecycle('cancel', '已取消（不可恢复）', 'wb-cancel', 'succeeded'); }", 'M6')), probeCancel],
  ['M7-remove-keyboard-focus', (s) => mutate('M7', (x) => replaceOnce(x, "'<button type=\"button\" class=\"btn\" id=\"wb-start\">", "'<button type=\"button\" class=\"btn\" tabindex=\"-1\" id=\"wb-start\">", 'M7')), probeFocus],
];

(async () => {
  const results = [];
  let killed = 0;
  let survived = 0;
  for (const [id, variant, probe] of probes) {
    let baseline = false;
    let mutated = false;
    try { baseline = await probe(moduleSource); } catch (error) { baseline = 'ERR:' + error.message; }
    try { mutated = await probe(variant(moduleSource)); } catch (error) { mutated = 'ERR:' + error.message; }
    const verdict = baseline === true && mutated === false ? 'KILLED' : 'SURVIVED';
    if (verdict === 'KILLED') killed += 1; else survived += 1;
    results.push({ id, baselineSafe: baseline, mutatedSafe: mutated, verdict });
    console.log(verdict + ' ' + id + ' :: baselineSafe=' + baseline + ' mutatedSafe=' + mutated);
  }

  const evidence = await probeEvidenceField();
  const evidenceVerdict = evidence.base === true && evidence.mutated === false ? 'KILLED' : 'SURVIVED';
  if (evidenceVerdict === 'KILLED') killed += 1; else survived += 1;
  results.push({ id: 'M8-remove-reduced-motion-field', baselineSafe: evidence.base, mutatedSafe: evidence.mutated, verdict: evidenceVerdict });
  console.log(evidenceVerdict + ' M8-remove-reduced-motion-field :: baselineSafe=' + evidence.base + ' mutatedSafe=' + evidence.mutated);

  const outDir = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-ui-production-integration-005/evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'expected-red-results.json'), JSON.stringify({
    schema: 'v1-runtime-mutation', taskId: 'XJ-5.1.0-pi-workbench-ui-production-integration-005',
    method: 'in-memory source variants + observable runtime probes; production files unchanged',
    probes: results, killed, survived,
  }, null, 2), 'utf8');
  console.log('SUMMARY ui-mutation killed=' + killed + ' survived=' + survived);
  process.exit(survived === 0 && killed === 8 ? 0 : 1);
})().catch((error) => { console.error('FATAL', error); process.exit(1); });
