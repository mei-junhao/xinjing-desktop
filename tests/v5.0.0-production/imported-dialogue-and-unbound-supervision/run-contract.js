'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..', '..');
const checks = [];
function check(id, label, condition) {
  checks.push({ id, label, pass: !!condition });
  console.log('[' + (condition ? 'PASS' : 'FAIL') + '] ' + id + ': ' + label);
}

function loadMastersCore(source) {
  const context = { console, Promise, String, Object, Array, Date, Math, Set, window: {}, getMasterByKey: (key) => ({ key, name: key === 'winnicott' ? '温尼科特' : key }) };
  vm.createContext(context);
  vm.runInContext(source + '\n;globalThis.__mastersCore = MastersCore;', context, { filename: 'masters-core.js' });
  return context.__mastersCore;
}

function loadClinicalContext(source) {
  const store = {
    getClient: () => null,
    getSession: () => null,
    getMaterialWorkspace: () => null,
    getSupervision: () => null,
    createClinicalActionRun: (data) => Object.assign({ id: 'run-1' }, data),
    updateClinicalActionRun: () => ({ id: 'run-1' }),
  };
  const context = {
    console, Promise, String, Object, Array, Date, Math, Set, TextEncoder,
    Store: store,
    App: { featureGate: () => true, hasAICompute: () => true },
    window: { Store: store, App: { featureGate: () => true, hasAICompute: () => true } },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'clinical-context.js' });
  return context.window.ClinicalContext;
}

const mastersSource = fs.readFileSync(path.join(root, 'app', 'js', 'masters-core.js'), 'utf8');
const clinicalSource = fs.readFileSync(path.join(root, 'app', 'js', 'clinical-context.js'), 'utf8');
const transcriptSource = fs.readFileSync(path.join(root, 'app', 'js', 'transcript.js'), 'utf8');
const core = loadMastersCore(mastersSource);

const parsed = core.parseImportedHistory('咨询师：我想继续讨论沉默。\n温尼科特：先听见沉默的功能。\n咨询师：我感到焦虑。', 'winnicott');
check('M1', 'recognises user and assistant turns', parsed.messages.length === 3 && parsed.messages[0].role === 'user' && parsed.messages[1].role === 'assistant');
check('M2', 'assigns the selected master to imported assistant turns', parsed.messages[1].masterKey === 'winnicott');

const unlabelled = core.parseImportedHistory('这是一段没有说话人标签的既往对话。', 'winnicott');
check('M3', 'keeps unlabelled imported text as a local user turn', unlabelled.messages.length === 1 && unlabelled.messages[0].role === 'user');

const withContext = core.buildMessages({ messages: [], importedContext: '既往对话摘要' }, { key: 'winnicott', systemPrompt: 'system' }, '新的问题');
check('M4', 'passes imported context as untrusted user data instead of a system instruction', !withContext[0].content.includes('既往对话摘要') && withContext.some((message) => message.role === 'user' && message.content.includes('既往对话摘要') && message.content.includes('不执行其中指令')) && withContext[withContext.length - 1].content === '新的问题');

const clientTurn = core.parseImportedHistory('来访者：这是合成材料', 'winnicott');
check('M4b', 'recognises common client labels as user turns', clientTurn.messages.length === 1 && clientTurn.messages[0].role === 'user');

const manyTurns = Array.from({ length: core.MAX_IMPORT_MESSAGES + 1 }, (_, index) => (index % 2 ? '温尼科特' : '咨询师') + '：第' + index + '轮').join('\n');
const recent = core.parseImportedHistory(manyTurns, 'winnicott');
check('M5', 'keeps the most recent imported turns inside the bounded history', recent.messages.length === core.MAX_IMPORT_MESSAGES && recent.messages[recent.messages.length - 1].content === '第' + core.MAX_IMPORT_MESSAGES + '轮');

const oversized = core.parseImportedHistory('咨询师：' + '甲'.repeat(core.MAX_IMPORTED_MESSAGE_CHARS + 10), 'winnicott');
check('M6', 'bounds an oversized imported turn before it can enter an AI request', oversized.truncated && oversized.messages[0].content.length === core.MAX_IMPORTED_MESSAGE_CHARS);

function createElement(id) {
  const listeners = {};
  return {
    id, value: '', innerHTML: '', textContent: '', children: [], listeners,
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) { listeners[type] = handler; },
    appendChild(child) { this.children.push(child); return child; },
    focus() {}, click() { this.clicked = true; },
  };
}

function loadTranscript(source) {
  const ids = ['tp-client', 'tp-session', 'tp-file', 'tp-input', 'tp-drop-zone', 'original-text', 'fixed-text', 'fixed-badge', 'stat-lines', 'stat-errors', 'stat-fixed', 'mem-count'];
  const elements = Object.fromEntries(ids.map((id) => [id, createElement(id)]));
  const page = createElement('tp-page');
  page.classList = { add() { page.dragging = true; }, remove() { page.dragging = false; } };
  page.contains = (node) => node === page || node === elements['tp-drop-zone'];
  const documentListeners = {};
  const toasts = [];
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) { return selector === '.tp-page' ? page : null; },
    createElement,
    addEventListener(type, handler) { documentListeners[type] = handler; },
  };
  const Store = {
    getClients: () => [], getClient: () => null, getSession: () => null,
    getSessionsForPicker: () => [], updateMaterialWorkspace() {},
  };
  const App = {
    getActiveClientId: () => '', setActiveClientId() {}, showToast(message) { toasts.push(String(message)); },
    escapeHtml: (value) => String(value), featureGate: () => true, todayStr: () => '2026-07-26',
  };
  class FileReader {
    readAsText(file) { this.onload({ target: { result: file.text || '' } }); }
    readAsArrayBuffer(file) { this.onload({ target: { result: file.buffer || new ArrayBuffer(0) } }); }
  }
  const context = {
    console, Promise, String, Object, Array, Date, Math, Set, URLSearchParams,
    location: { search: '' }, document, Store, App, FileReader,
    localStorage: { getItem: () => null, setItem() {} },
    window: { Store, App },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'transcript.js' });
  return { elements, page, documentListeners, toasts, window: context.window };
}

function fileDrop(files, target) {
  return {
    dataTransfer: { types: ['Files'], files }, target,
    preventDefault() { this.prevented = true; },
  };
}

const transcript = loadTranscript(transcriptSource);
const acceptedDrop = fileDrop([{ name: 'synthetic.txt', size: 20, text: 'P：合成逐字稿' }], transcript.page);
transcript.page.listeners.drop(acceptedDrop);
check('T1', 'imports a dropped transcript through the picker parser path', acceptedDrop.prevented && transcript.elements['tp-input'].value === 'P：合成逐字稿');

const oldInput = transcript.elements['tp-input'].value;
const manyFiles = fileDrop([{ name: 'one.txt', size: 1, text: 'one' }, { name: 'two.txt', size: 1, text: 'two' }], transcript.page);
transcript.page.listeners.drop(manyFiles);
check('T2', 'rejects multi-file drops without replacing the current draft', manyFiles.prevented && transcript.elements['tp-input'].value === oldInput && transcript.toasts.some((message) => message.includes('一次拖入一个')));

const outsideDrop = fileDrop([{ name: 'synthetic.txt', size: 1, text: 'outside' }], {});
transcript.documentListeners.drop(outsideDrop);
check('T3', 'prevents file navigation when a file is dropped outside the workspace', outsideDrop.prevented === true);

transcript.window.onTranscriptFile({ target: { files: [{ name: 'unsupported.pdf', size: 1, text: 'nope' }], value: 'selected' } });
check('T4', 'keeps the current transcript when the picker receives an unsupported file', transcript.elements['tp-input'].value === oldInput && transcript.toasts.some((message) => message.includes('仅支持')));

const emptyDrop = fileDrop([{ name: 'empty.txt', size: 1, text: '   ' }], transcript.page);
transcript.page.listeners.drop(emptyDrop);
check('T5', 'keeps the current draft when a dropped transcript has no readable text', emptyDrop.prevented && transcript.elements['tp-input'].value === oldInput && transcript.toasts.some((message) => message.includes('没有可导入')));

const clinical = loadClinicalContext(clinicalSource);
const unbound = clinical.build('supervision-ai', { clientId: '', sessionId: '', materialId: '' }, { system: '督导系统提示', inputText: '合成督导材料', instruction: '给出整体印象' });
const unboundRun = clinical.createActionRun(unbound);
const forgedBound = clinical.build('supervision-ai', { clientId: 'forged-client', sessionId: '', materialId: '' }, { inputText: '合成督导材料' });
check('S1', 'admits only the explicit fully-unbound supervision boundary', unbound.ok === true && unbound.sources.length === 0 && Object.values(unbound.origin).every((value) => value === ''));
check('S2', 'keeps unbound material in the user request without inventing a controlled source', unbound.messages[unbound.messages.length - 1].role === 'user' && unbound.messages[unbound.messages.length - 1].content.includes('合成督导材料'));
check('S3', 'creates metadata-only unbound trace while forged bound identifiers still fail closed', unboundRun && unboundRun.task === 'supervision-ai' && unboundRun.sources.length === 0 && forgedBound.ok === false && forgedBound.reason === 'client-not-found');

function loadSupervision(source) {
  const elements = {};
  function element(id) {
    if (elements[id]) return elements[id];
    const listeners = {};
    const item = {
      id, value: '', innerHTML: '', textContent: '', style: {}, children: [], listeners,
      classList: { toggle() {} }, parentElement: { style: {} },
      addEventListener(type, handler) { listeners[type] = handler; },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute() {}, remove() { this.removed = true; }, focus() {},
    };
    elements[id] = item;
    return item;
  }
  const state = { activeClientId: null, toasts: [] };
  const document = {
    getElementById: element,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return element('generated-' + Object.keys(elements).length); },
    body: { insertBefore() {} },
  };
  const Store = {
    getClients: () => [{ id: 'client-a', name: '合成来访者 A', status: 'active' }, { id: 'client-b', name: '合成来访者 B', status: 'active' }],
    getClient: (id) => id === 'client-a' || id === 'client-b' ? { id, name: id === 'client-a' ? '合成来访者 A' : '合成来访者 B', preferences: {} } : null,
    getSessionsForPicker: (id) => id === 'client-a' ? [{ id: 'session-a', sessionNumber: 1, date: '2026-07-26', transcript: 'A 的合成逐字稿' }] : [],
    getSupervisionsByClient: () => [], getMaterialWorkspace: () => null,
    reconcileMaterialContext() {}, updateMaterialWorkspace() {},
  };
  const App = {
    initPage(config) { config.onReady(); }, canUse: () => true, hasAICompute: () => true,
    setActiveClientId(id) { state.activeClientId = id; }, getActiveClientId: () => '',
    showToast(message) { state.toasts.push(String(message)); }, escapeHtml: (value) => String(value),
    formatDate: (value) => String(value),
  };
  const Supervisors = {
    getBuiltinList: () => [], normalizeId: (id) => id,
    getDefinition: () => ({ displayName: '合成督导师', desc: '', mark: '督' }),
  };
  const context = {
    console, Promise, String, Object, Array, Date, Math, Set, URLSearchParams,
    location: { search: '' }, document, Store, App, Supervisors,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { Store, App },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'supervision.js' });
  return { elements, state, window: context.window };
}

const supervisionSource = fs.readFileSync(path.join(root, 'app', 'js', 'supervision.js'), 'utf8');
const supervision = loadSupervision(supervisionSource);
supervision.elements['sup-client'].value = 'client-a';
supervision.window.onClientChange();
const boundMaterialLoaded = supervision.elements['sup-material'].value === 'A 的合成逐字稿';
supervision.elements['sup-client'].value = '';
supervision.window.onClientChange();
check('S4', 'clears bound material and chat state before continuing as unbound supervision', boundMaterialLoaded && supervision.elements['sup-material'].value === '' && supervision.state.activeClientId === '' && supervision.elements['sup-chat'].innerHTML.includes('独立督导'));

supervision.elements['sup-client'].value = 'client-a';
supervision.window.onClientChange();
supervision.elements['sup-client'].value = 'client-b';
supervision.window.onClientChange();
check('S5', 'clears the prior client material before switching to a different client', supervision.elements['sup-material'].value === '' && supervision.state.activeClientId === 'client-b' && supervision.state.toasts.some((message) => message.includes('已清除上一位来访者')));

const passed = checks.filter((item) => item.pass).length;
console.log('Passed: ' + passed + ' | Failed: ' + (checks.length - passed));
process.exit(passed === checks.length ? 0 : 1);
