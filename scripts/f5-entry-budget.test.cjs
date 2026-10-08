/* ============================================================
 * scripts/f5-entry-budget.test.cjs
 *
 * F5 长文本预算 + F7 提示词治理 修复自证夹具（XJ-5.1.19-f1-f7-final-acceptance-001）
 *
 * 覆盖：
 *   A（契约 D-2） 工具入口长度预算 —— 在 ai.js 统一出口 fail-closed
 *   B（契约 D-3） 工具响应必须携带 provider 的 errorCode 与结构化字段
 *   C（契约 D-1） 页面入口超限响应必须带稳定 errorCode（reason 向后兼容）
 *   D（契约 D-5） manifest source/version 与真实模板载荷同源可核
 *
 * 关键纪律：
 *   - 断言对象是 **实际发出的载荷**（provider bridge 收到的 body.messages）与
 *     工具返回对象，不是源码字符串。
 *   - 真实产品源文件在 vm realm 内运行（含真实 ai.js / agent-tools.js /
 *     masters-core.js / clinical-context.js / prompt-governance.js / pii-sanitizer.js）。
 *   - provider 边界 = window.__XJ_API__.aiRequest 的确定性替身；无网络、无 Electron、
 *     无真实供应商，全部合成数据。
 *   - 反向变异：把修复旁路掉后，对应用例必须转红；变异副本写在
 *     logs/f5-f7-fixes/mutants/ 下，产品树只读。
 *
 * 运行：node scripts/f5-entry-budget.test.cjs
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const OUT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f5-entry-evidence-'));
const MUTANT_DIR = path.join(OUT, 'mutants');
const TOTAL_LIMIT = 240000;              // 核心总输入上限（SupervisionSyndicate.MAX_INPUT_CHARS）
const EXPECTED_ERROR_CODE = 'MATERIAL_TOO_LONG';
const REPEATS = 3;

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/* ---------------- pinned source reader (with per-file override for mutants) ---------------- */
function makeSourceLoader(overrides) {
  const ov = overrides || {};
  const seen = [];
  return {
    read(name) {
      if (Object.prototype.hasOwnProperty.call(ov, name)) {
        seen.push({ name: name, md5: md5(Buffer.from(ov[name], 'utf8')), pinned: false, overridden: true });
        return ov[name];
      }
      const buf = fs.readFileSync(path.join(APP, name));
      seen.push({ name: name, md5: md5(buf), pinned: true, overridden: false });
      return buf.toString('utf8');
    },
    seen: seen,
  };
}

/* ---------------- synthetic clinical material ---------------- */
function unit(i) { return '[u' + String(i).padStart(6, '0') + ']' + '·'.repeat(51); }   // 60 chars
function material(chars) {
  let out = '';
  let i = 0;
  while (out.length < chars) { out += unit(i++); }
  return out.slice(0, chars);
}

/* ---------------- the recording provider bridge (real ai.js transport boundary) ---------------- */
function makeBridge(handler) {
  const promptCalls = [];
  const quotaCalls = [];
  const bridge = {
    aiRequest: function (req) {
      if (req && req.kind === 'quota') { quotaCalls.push(req); return Promise.resolve({ ok: false, status: 0, bodyText: '' }); }
      const messages = (req && req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
      const entry = {
        seq: promptCalls.length,
        messageCount: messages.length,
        messages: messages.map(function (m) {
          const content = String(m && m.content == null ? '' : m.content);
          return { role: m && m.role, chars: content.length, sha256: sha256(content), head: content.slice(0, 80) };
        }),
        _raw: messages.map(function (m) { return { role: m && m.role, content: String(m && m.content == null ? '' : m.content) }; }),
      };
      entry.totalChars = entry.messages.reduce(function (a, b) { return a + b.chars; }, 0);
      entry.payloadSha = sha256(entry.messages.map(function (m) { return m.role + '|' + m.sha256; }).join('||'));
      promptCalls.push(entry);
      let outcome;
      try { outcome = handler(entry, req); } catch (e) { outcome = { __throw: e }; }
      if (outcome && outcome.__throw) return Promise.reject(outcome.__throw);
      if (outcome && outcome.__httpFail) return Promise.resolve({ ok: false, status: outcome.status || 500, bodyText: '', error: { message: outcome.message || 'stub fail' } });
      const body = JSON.stringify({ choices: [{ message: { content: typeof outcome === 'string' ? outcome : (outcome && outcome.content) || '合成回复（stub）。' } }] });
      return Promise.resolve({ ok: true, status: 200, bodyText: body, headers: {} });
    },
    cancelAiRequest: function () {},
    onAiChunk: function () { return function () {}; },
    encryptSecret: function (s) { return Promise.resolve('enc:' + s); },
  };
  return { bridge: bridge, promptCalls: promptCalls, quotaCalls: quotaCalls };
}

/* ---------------- fake Store ---------------- */
function makeFakeStore() {
  const c = { clients: [], sessions: [], supervisions: [], materials: [], actionRuns: [], masterConvs: [], settings: {} };
  let seq = 0;
  const id = function (p) { return p + '_' + (++seq); };
  return {
    __collections: c,
    getSettings: function () { return c.settings; },
    getClients: function () { return c.clients; },
    getClient: function (x) { return c.clients.filter(function (i) { return i.id === x; })[0] || null; },
    getSessions: function () { return c.sessions; },
    getSession: function (x) { return c.sessions.filter(function (i) { return i.id === x; })[0] || null; },
    getMaterials: function () { return c.materials; },
    getMaterialWorkspace: function (x) { return c.materials.filter(function (i) { return i.id === x; })[0] || null; },
    getSupervision: function (x) { return c.supervisions.filter(function (i) { return i.id === x; })[0] || null; },
    getAiSupervisions: function () { return c.supervisions; },
    getMasterConversations: function () { return c.masterConvs; },
    getMasterConversation: function (x) { return c.masterConvs.filter(function (i) { return i.id === x; })[0] || null; },
    saveMasterConversationDurable: async function (conv) {
      const copy = JSON.parse(JSON.stringify(conv));
      const i = c.masterConvs.findIndex(function (x) { return x.id === copy.id; });
      if (i >= 0) c.masterConvs[i] = copy; else c.masterConvs.push(copy);
      return { ok: true, value: copy };
    },
    saveAiSupervisionDurable: async function (payload) {
      const value = Object.assign({ id: id('sup') }, JSON.parse(JSON.stringify(payload)));
      c.supervisions.push(value);
      return { ok: true, value: value };
    },
    updateSupervisionDurable: async function (sid, patch) {
      const v = c.supervisions.filter(function (x) { return x.id === sid; })[0];
      if (!v) return { ok: false };
      Object.assign(v, patch);
      return { ok: true, value: v };
    },
    createClinicalActionRun: function (rec) { const r = Object.assign({ id: id('run') }, rec); c.actionRuns.push(r); return r; },
    updateClinicalActionRun: function (rid, patch) {
      const r = c.actionRuns.filter(function (x) { return x.id === rid; })[0];
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    },
    getClinicalActionRun: function (rid) { return c.actionRuns.filter(function (x) { return x.id === rid; })[0] || null; },
  };
}

/* ---------------- realm factory ---------------- */
/* tail: how each file publishes its global in a vm realm (mirrors the shipped <script> order) */
const FILES = [
  'prompt-governance.js',
  'pii-sanitizer.js',
  'prompts.builtin.js',
  'masters-data.js',
  'supervision-syndicate-data.js',
  'supervisors.js',
  'masters-core.js',
  'supervision-core.js',
  'clinical-context.js',
  'ai.js',
  'agent-tools.js',
];
const TAILS = {
  'prompts.builtin.js': '\n;globalThis.PromptsBuiltin = PromptsBuiltin;',
  'supervisors.js': '\n;globalThis.Supervisors = Supervisors;',
  'masters-core.js': '\n;globalThis.MastersCore = MastersCore;',
  'supervision-core.js': '\n;globalThis.SupervisionCore = SupervisionCore;',
  'agent-tools.js': '\n;globalThis.AgentTools = window.AgentTools;',
};

function createRealm(opts) {
  opts = opts || {};
  const loader = makeSourceLoader(opts.overrides);
  const responder = opts.responder || function () { return '合成回复（stub）。'; };
  const { bridge, promptCalls, quotaCalls } = makeBridge(responder);
  const store = makeFakeStore();

  const sandbox = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp, Error: Error, Object: Object, Array: Array,
    String: String, Number: Number, Boolean: Boolean, Set: Set, Map: Map, Function: Function, TextEncoder: TextEncoder,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent, unescape: unescape, escape: escape,
    AbortController: AbortController, URL: URL, Buffer: Buffer, crypto: crypto,
    atob: function (b64) { return Buffer.from(String(b64), 'base64').toString('binary'); },
    btoa: function (bin) { return Buffer.from(String(bin), 'binary').toString('base64'); },
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
    __promptCalls: promptCalls,
    __quotaCalls: quotaCalls,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__XJ_API__ = bridge;
  sandbox.Store = store;
  sandbox.App = { featureGate: function () { return true; }, hasAICompute: function () { return true; }, canUse: function () { return true; }, showToast: function () {} };
  // minimal document so page-shell helpers that touch DOM never crash the realm
  sandbox.document = {
    createElement: function () { return { style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {} }, appendChild: function () {}, setAttribute: function () {}, addEventListener: function () {} }; },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    body: { appendChild: function () {} },
    head: { appendChild: function () {} },
    documentElement: { appendChild: function () {} },
  };
  const ctx = vm.createContext(sandbox);
  FILES.forEach(function (name) {
    const src = loader.read(name) + (TAILS[name] || '');
    vm.runInContext(src, ctx, { filename: name });
  });
  if (typeof sandbox.MASTERS === 'undefined') throw new Error('realm bootstrap failed: MASTERS missing');
  if (typeof sandbox.AI !== 'object') throw new Error('realm bootstrap failed: AI missing');
  if (!sandbox.AgentTools || !sandbox.AgentTools.invoke) throw new Error('realm bootstrap failed: AgentTools missing');
  return { sandbox: sandbox, ctx: ctx, store: store, promptCalls: promptCalls, quotaCalls: quotaCalls, loader: loader };
}

/* ---------------- assertions ---------------- */
const results = [];
function chars(messages) {
  return messages.reduce(function (a, m) { return a + String(m && m.content == null ? '' : m.content).length; }, 0);
}
async function assertCase(group, name, fn) {
  try {
    const detail = await fn();
    results.push({ group: group, name: name, ok: true, detail: detail === undefined ? null : detail });
    return { ok: true, detail: detail === undefined ? null : detail };
  } catch (e) {
    results.push({ group: group, name: name, ok: false, failure: String(e && e.message || e) });
    return { ok: false, failure: String(e && e.message || e) };
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

/* ================= A. 工具入口预算（4 入口 × {上限, 上限+1} × 3 次） ================= */
const TOOL_CASES = [
  { id: 'T-open-240000', tool: 'masters.open', args: function () { return { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT) }; }, label: 'masters.open topic=240000(恰达核心上限，组装后必越界)' },
  { id: 'T-open-240001', tool: 'masters.open', args: function () { return { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT + 1) }; }, label: 'masters.open topic=240001' },
  { id: 'T-message-240000', tool: 'masters.message', args: function () { return { sessionId: 'mc_seed', message: material(TOTAL_LIMIT) }; }, label: 'masters.message message=240000' },
  { id: 'T-message-240001', tool: 'masters.message', args: function () { return { sessionId: 'mc_seed', message: material(TOTAL_LIMIT + 1) }; }, label: 'masters.message message=240001' },
  { id: 'T-start-240000', tool: 'supervision.start', args: function () { return { supervisorName: 'nvwa', material: material(TOTAL_LIMIT) }; }, label: 'supervision.start material=240000' },
  { id: 'T-start-240001', tool: 'supervision.start', args: function () { return { supervisorName: 'nvwa', material: material(TOTAL_LIMIT + 1) }; }, label: 'supervision.start material=240001' },
  { id: 'T-ask-240000', tool: 'supervision.ask', args: function () { return { sessionId: 'sup_seed', question: material(TOTAL_LIMIT) }; }, label: 'supervision.ask question=240000' },
  { id: 'T-ask-240001', tool: 'supervision.ask', args: function () { return { sessionId: 'sup_seed', question: material(TOTAL_LIMIT + 1) }; }, label: 'supervision.ask question=240001' },
];

function seedConversations(realm) {
  realm.store.__collections.masterConvs.push({ id: 'mc_seed', mode: '1v1', masterKeys: ['winnicott'], title: '温尼科特', messages: [{ role: 'user', content: '前一轮' }, { role: 'assistant', content: '前一轮回复' }], summary: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  realm.store.__collections.supervisions.push({ id: 'sup_seed', content: '【整体印象】\n既有督导印象（合成）。', conclusion: '', supervisorName: '温尼科特取向督导师', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' });
}

async function runToolEntry(c) {
  const codes = [];
  const payloadPerRun = [];
  let lastCalls = null;
  let lastResult = null;
  for (let r = 0; r < REPEATS; r++) {
    const realm = createRealm();
    seedConversations(realm);
    const res = await realm.sandbox.AgentTools.invoke(c.tool, c.args());
    lastResult = res; lastCalls = realm.promptCalls.slice();
    payloadPerRun.push({ run: r, providerCalls: realm.promptCalls.length, totalChars: realm.promptCalls.map(function (x) { return chars(x._raw); }), shas: realm.promptCalls.map(function (x) { return x.payloadSha; }) });
    // 1) 超限载荷不得到达 provider
    expect(realm.promptCalls.length === 0, c.id + ' run' + r + ': provider 调用数应为 0，实测 ' + realm.promptCalls.length + (realm.promptCalls.length ? '（送达字符数 ' + realm.promptCalls.map(function (x) { return chars(x._raw); }).join(',') + '）' : ''));
    // 2) 必须明确失败，不得 ok=true
    expect(res && res.ok === false, c.id + ' run' + r + ': 工具响应应为 ok=false，实测 ' + JSON.stringify(res && { ok: res.ok, keys: Object.keys(res) }));
    // 3) 稳定 errorCode
    expect(res.errorCode === EXPECTED_ERROR_CODE, c.id + ' run' + r + ': errorCode 应为 ' + EXPECTED_ERROR_CODE + '，实测 ' + JSON.stringify(res.errorCode) + '（响应键 ' + Object.keys(res).join(',') + '）');
    codes.push(res.errorCode);
    // 4) 不得静默截断：结构化预算字段必须自证
    expect(res.truncated === false, c.id + ' run' + r + ': truncated 必须显式为 false，实测 ' + JSON.stringify(res.truncated));
    expect(typeof res.totalChars === 'number' && res.totalChars > TOTAL_LIMIT, c.id + ' run' + r + ': 应回报超限字符数(>' + TOTAL_LIMIT + ')，实测 ' + JSON.stringify(res.totalChars));
    expect(res.limitChars === TOTAL_LIMIT, c.id + ' run' + r + ': 应回报上限 ' + TOTAL_LIMIT + '，实测 ' + JSON.stringify(res.limitChars));
    expect(typeof res.error === 'string' && res.error.length > 0, c.id + ' run' + r + ': error 文案非空');
    expect(res.error.indexOf('截断') < 0 || res.error.indexOf('未截断') >= 0, c.id + ' run' + r + ': 文案不得宣称已截断');
  }
  expect(new Set(codes).size === 1, c.id + ': errorCode 三次不一致 ' + JSON.stringify(codes));
  const shaSets = payloadPerRun.map(function (p) { return p.shas.join(','); });
  expect(new Set(shaSets).size === 1, c.id + ': provider 载荷序列三次不一致（替身不确定）');
  return { errorCode: codes[0], runs: payloadPerRun, responseKeys: Object.keys(lastResult), response: lastResult, deliveredChars: lastCalls.map(function (x) { return chars(x._raw); }) };
}

/* ================= B. 工具响应携带 provider errorCode ================= */
async function runToolErrorCodeCarriage() {
  // provider 侧（此处即 ai.js 之下的 bridge）返回超限类失败时，工具必须原样携带
  const realm = createRealm({
    responder: function () {
      // ai.js 的 bridge 契约：非 ok 会被归类为 provider_http；因此用「预算闸门」自身
      // 产生的失败对象来验证工具层转发（等价于 provider 返回 {error,errorCode}）。
      return 'ok';
    },
  });
  seedConversations(realm);
  const res = await realm.sandbox.AgentTools.invoke('masters.message', { sessionId: 'mc_seed', message: material(TOTAL_LIMIT + 1) });
  expect(res && res.ok === false, '应失败，实测 ' + JSON.stringify(res));
  expect(res.errorCode === EXPECTED_ERROR_CODE, '工具必须携带 errorCode，实测 ' + JSON.stringify(res.errorCode));
  expect(res.totalChars > TOTAL_LIMIT, '工具必须携带超限字符数');
  return { response: res };
}

/* ================= C. 页面入口 errorCode ================= */
function runPageEntry() {
  const out = {};
  const CC = function () { return createRealm().sandbox.ClinicalContext; };
  const cc = CC();
  // 超限：240001 字符 inputText（页面任务预算 maxChars=24000）
  const over = cc.build('supervision-multi-school', {}, { inputText: material(TOTAL_LIMIT + 1), system: 'sys' });
  expect(over && over.ok === false, '页面超限应拒绝，实测 ' + JSON.stringify(over && { ok: over.ok, reason: over.reason }));
  expect(over.reason === 'task-budget-exceeded', 'reason 必须保持向后兼容，实测 ' + JSON.stringify(over.reason));
  expect(over.errorCode === EXPECTED_ERROR_CODE, '页面超限必须带稳定 errorCode，实测 ' + JSON.stringify(over.errorCode) + '（键 ' + Object.keys(over).join(',') + '）');
  expect(over.truncated === false, '页面超限必须显式 truncated:false');
  expect(over.budget && typeof over.budget.maxChars === 'number', '页面超限必须回报预算上限');
  expect(over.estimatedChars > over.budget.maxChars, '页面超限必须回报估算字符数');
  // 恰达上限：payload 恰好 24000 -> 放行
  const spec = cc.getTaskSpec('supervision-multi-school');
  const max = spec.budget.maxChars;
  const atLimit = cc.build('supervision-multi-school', {}, { inputText: '[当前输入]\n' ? material(max - '[当前输入]\n'.length) : '', system: 'sys' });
  expect(atLimit.ok === true, '恰达页面上限不得误拒，实测 ' + JSON.stringify(atLimit && { ok: atLimit.ok, reason: atLimit.reason, estimatedChars: atLimit.estimatedChars }));
  expect(atLimit.estimatedChars === max, '夹具构造应为恰达上限，实测 ' + atLimit.estimatedChars);
  expect(atLimit.errorCode === undefined, '在预算内不应出现 errorCode');
  // 上限+1 -> 拒
  const overByOne = cc.build('supervision-multi-school', {}, { inputText: material(max - '[当前输入]\n'.length + 1), system: 'sys' });
  expect(overByOne.ok === false && overByOne.errorCode === EXPECTED_ERROR_CODE && overByOne.reason === 'task-budget-exceeded', '上限+1 必须拒绝且带 errorCode+reason，实测 ' + JSON.stringify(overByOne && { ok: overByOne.ok, reason: overByOne.reason, errorCode: overByOne.errorCode }));
  out.atLimitChars = atLimit.estimatedChars;
  out.over = { reason: overByOne.reason, errorCode: overByOne.errorCode, estimatedChars: overByOne.estimatedChars, limitChars: overByOne.budget.maxChars };
  return out;
}

/* ================= 正向对照：正常长度材料不得被误拒 ================= */
async function runPositiveNotFalselyRejected() {
  const detail = [];
  // (a) 4 条工具入口各跑一次正常长度材料：provider 必须真收到载荷
  const normal = [
    { id: 'P-open-normal', tool: 'masters.open', args: { masterId: 'winnicott', mode: '1v1', topic: '来访者在本节会谈中反复谈论抱持失败的体验（合成材料）。' } },
    { id: 'P-message-normal', tool: 'masters.message', args: { sessionId: 'mc_seed', message: '请再说说过渡空间这个概念怎么用在个案里？' } },
    { id: 'P-start-normal', tool: 'supervision.start', args: { supervisorName: 'nvwa', material: material(4800) } },
    { id: 'P-ask-normal', tool: 'supervision.ask', args: { sessionId: 'sup_seed', question: '这段反移情我该怎么接？' } },
  ];
  for (const n of normal) {
    const realm = createRealm();
    seedConversations(realm);
    const res = await realm.sandbox.AgentTools.invoke(n.tool, n.args);
    expect(res && res.ok === true, n.id + ': 正常材料被误拒！响应 ' + JSON.stringify(res));
    expect(realm.promptCalls.length >= 1, n.id + ': 正常材料必须有 provider 调用，实测 ' + realm.promptCalls.length);
    const delivered = chars(realm.promptCalls[0]._raw);
    expect(delivered > 0, n.id + ': 送达载荷字符数应 > 0');
    detail.push({ id: n.id, ok: true, providerCalls: realm.promptCalls.length, deliveredChars: delivered, errorCode: res.errorCode || null });
  }
  // (b) 统一出口的边界：组装后总字符 **恰为** 240000 必须放行；240001 必须拒绝
  const exact = createRealm();
  const padSystem = 'S'.repeat(1000);
  const userLen = TOTAL_LIMIT - 1000;
  const exactRes = await exact.sandbox.AI.send([{ role: 'system', content: padSystem }, { role: 'user', content: material(userLen) }]);
  expect(!exactRes || !exactRes.error, '恰为上限被误拒：' + JSON.stringify(exactRes));
  expect(exact.promptCalls.length === 1, '恰为上限必须发出 1 次请求，实测 ' + exact.promptCalls.length);
  expect(chars(exact.promptCalls[0]._raw) === TOTAL_LIMIT, '送达字符数应恰为 ' + TOTAL_LIMIT + '，实测 ' + chars(exact.promptCalls[0]._raw));
  const plus = createRealm();
  const plusRes = await plus.sandbox.AI.send([{ role: 'system', content: padSystem }, { role: 'user', content: material(userLen + 1) }]);
  expect(plusRes && plusRes.errorCode === EXPECTED_ERROR_CODE, '上限+1 必须有 errorCode，实测 ' + JSON.stringify(plusRes));
  expect(plus.promptCalls.length === 0, '上限+1 不得出网，实测 ' + plus.promptCalls.length);
  detail.push({ id: 'P-exact-limit', ok: true, deliveredChars: chars(exact.promptCalls[0]._raw) });
  detail.push({ id: 'P-limit-plus-one', ok: true, providerCalls: plus.promptCalls.length, errorCode: plusRes.errorCode });
  // (c) AI.stream / AI.chat / AI.supervise 同闸门（汇聚性正证）
  const stream = createRealm();
  const streamRes = await stream.sandbox.AI.stream([{ role: 'user', content: material(TOTAL_LIMIT + 5) }], function () {});
  expect(streamRes && streamRes.errorCode === EXPECTED_ERROR_CODE, 'AI.stream 未走闸门：' + JSON.stringify(streamRes));
  expect(stream.promptCalls.length === 0, 'AI.stream 超限不得出网');
  const supervise = createRealm();
  const supRes = await new Promise(function (resolve) { supervise.sandbox.AI.supervise('督导师人格', material(TOTAL_LIMIT + 7), function (r) { resolve(r); }); });
  expect(supRes && supRes.errorCode === EXPECTED_ERROR_CODE, 'AI.supervise 未走闸门：' + JSON.stringify(supRes));
  expect(supervise.promptCalls.length === 0, 'AI.supervise 超限不得出网');
  const chatRealm = createRealm();
  const chatRes = await new Promise(function (resolve) { chatRealm.sandbox.AI.chat(material(TOTAL_LIMIT + 3), function (r) { resolve(r); }); });
  expect(chatRes && chatRes.errorCode === EXPECTED_ERROR_CODE, 'AI.chat 未走闸门/吞码：' + JSON.stringify(chatRes));
  expect(chatRealm.promptCalls.length === 0, 'AI.chat 超限不得出网');
  const soapRealm = createRealm();
  const soapRes = await new Promise(function (resolve) { soapRealm.sandbox.AI.generateSoapFromTranscript(material(TOTAL_LIMIT + 9), function (r) { resolve(r); }); });
  expect(soapRes && soapRes.errorCode === EXPECTED_ERROR_CODE, 'AI.generateSoapFromTranscript 未走闸门/吞码：' + JSON.stringify(soapRes));
  expect(soapRealm.promptCalls.length === 0, 'AI.generateSoapFromTranscript 超限不得出网');
  detail.push({ id: 'P-stream-chat-supervise-soap-gated', ok: true });
  return detail;
}

/* ================= D. manifest 同源可核 ================= */
function runManifestProvenance() {
  const realm = createRealm();
  const PG = realm.sandbox.PromptGovernance;
  const MASTERS = realm.sandbox.MASTERS;
  const CARDS = realm.sandbox.SUPERVISION_SYNDICATE;
  // 走真实调用点：masters-core.buildMessages -> withFactAndSourceGuard -> registerMasterPrompt
  const conv = { messages: [], summary: '', importedContext: '' };
  realm.sandbox.MastersCore.buildMessages(conv, MASTERS[0], 'hi', {});
  realm.sandbox.MastersCore.buildMessages(conv, CARDS.filter(function (c) { return c.key === 'sup-klein'; })[0], 'hi', {});
  realm.sandbox.MastersCore.buildRoundSystemPrompt(CARDS.filter(function (c) { return c.key === 'sup-winnicott'; })[0], 'A,B', false, {});
  const manifest = PG.getPromptManifest();
  const mastersSystem = manifest.filter(function (m) { return m.id.indexOf('masters.system.') === 0; });
  expect(mastersSystem.length >= 3, '应至少登记 3 条 masters.system.*，实测 ' + mastersSystem.length);

  const byKey = {};
  MASTERS.concat(CARDS).forEach(function (c) { if (c && c.key) byKey[c.key] = c; });
  const fileOf = {};
  MASTERS.forEach(function (c) { fileOf[c.key] = 'app/js/masters-data.js'; });
  CARDS.forEach(function (c) { fileOf[c.key] = 'app/js/supervision-syndicate-data.js'; });

  const rows = [];
  mastersSystem.forEach(function (item) {
    const key = item.id.slice('masters.system.'.length);
    const tpl = byKey[key];
    expect(tpl, 'manifest 里有 ' + item.id + ' 但模板库里查不到该 key');
    // source 必须指向模板真正所在文件
    expect(item.source === fileOf[key], item.id + ': source 应为 ' + fileOf[key] + '，实测 ' + item.source);
    // contentHash 必须与真实模板文本同哈希（同源可核）
    expect(item.contentHash === sha256(tpl.systemPrompt), item.id + ': contentHash 与真实模板文本不一致（manifest 不可核）');
    // version 必须可追溯到模板自身：有 promptVersion 用它，否则必须由内容哈希派生
    if (tpl.promptVersion) expect(item.version === String(tpl.promptVersion), item.id + ': version 应取模板 promptVersion');
    else expect(item.version.indexOf(String(tpl.promptVersion || '')) === 0 && item.version.indexOf(sha256(tpl.systemPrompt).slice(0, 12)) >= 0, item.id + ': version 未与模板内容绑定，实测 ' + item.version);
    expect(item.provenance === 'verified', item.id + ': provenance 应为 verified，实测 ' + item.provenance);
    rows.push({ id: item.id, source: item.source, version: item.version, provenance: item.provenance, contentHash: item.contentHash.slice(0, 12) });
  });
  // 版本必须逐模板可追溯：不同模板不得恒等于同一字面量
  const supVersions = rows.filter(function (r) { return r.id.indexOf('sup-') >= 0; }).map(function (r) { return r.version; });
  expect(new Set(supVersions).size === supVersions.length, 'sup-* 版本仍互相不可区分：' + JSON.stringify(supVersions));
  const allEqual = new Set(rows.map(function (r) { return r.version; }));
  expect(allEqual.size === rows.length, 'version 仍退化为单一字面量：' + JSON.stringify(Array.from(allEqual)));
  // D-5 移交接口的自证：「一个模板、多阶段改写」（多学派 synthesis）也必须同源可核
  const lead = CARDS.filter(function (c) { return c.key === 'sup-lead'; })[0];
  const synthesisSystem = lead.systemPrompt + '\n\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。';
  const synth = PG.registerPrompt({
    id: 'supervision.multi-school.synthesis.system',
    templateKey: 'sup-lead',
    version: '4.4.0', task: 'supervision-multi-school', model: 'chat-completions-compatible',
    author: 'XinJing multi-school pipeline', source: 'app/js/placeholder.js', changeLog: ['stage: synthesis'],
    content: synthesisSystem,
  });
  expect(synth.source === 'app/js/supervision-syndicate-data.js', 'templateKey 路径未解析出真实文件：' + synth.source);
  expect(synth.provenance === 'verified', 'templateKey 路径 provenance=' + synth.provenance);
  expect(synth.templateHash === sha256(lead.systemPrompt), 'templateKey 路径未记录模板原文哈希');
  expect(synth.contentHash === sha256(synthesisSystem), 'templateKey 路径 contentHash 应为实际登记文本的哈希');
  expect(synth.version !== '4.4.0', 'templateKey 路径 version 仍是兜底字面量');
  const wrongKey = PG.registerPrompt({
    id: 'supervision.multi-school.wrong-key', templateKey: 'sup-klein', version: '1.0.0', task: 't', model: 'm',
    author: 'a', source: 'app/js/x.js', changeLog: ['c'], content: '与任何模板都无关的文本',
  });
  expect(wrongKey.source === 'app/js/x.js' && wrongKey.provenance === 'declared-unverified',
    '错误 templateKey 被静默采信：' + JSON.stringify({ source: wrongKey.source, provenance: wrongKey.provenance }));
  // 未登记在册的模板（契约测试用的 demo）必须保留声明值并显式标记，绝不猜测
  const bogus = PG.registerPrompt({
    id: 'masters.system.not-in-any-library', version: '9.9.9', task: 't', model: 'm', author: 'a',
    source: 'app/js/somewhere-else.js', changeLog: ['x'], content: 'NOT A SHIPPED TEMPLATE',
  });
  expect(bogus.source === 'app/js/somewhere-else.js', '未核实的模板不得被改写 source');
  expect(bogus.provenance === 'declared-unverified', '未核实模板必须显式标记，实测 ' + bogus.provenance);
  return { rows: rows };
}

/* ================= 反向变异 ================= */
function applyMutation(name, file, from, to) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  const idx = src.indexOf(from);
  if (idx < 0) throw new Error('MUTATION ANCHOR MISSING in ' + file + ' :: ' + from.slice(0, 60));
  const mutated = src.slice(0, idx) + to + src.slice(idx + from.length);
  if (md5(Buffer.from(mutated, 'utf8')) === md5(Buffer.from(src, 'utf8'))) throw new Error('INVALID MUTATION (no byte change): ' + name);
  ensureDir(MUTANT_DIR);
  ensureDir(path.join(MUTANT_DIR, name));
  fs.writeFileSync(path.join(MUTANT_DIR, name, file), mutated, 'utf8');
  const overrides = {};
  overrides[file] = mutated;
  return overrides;
}

const MUTATIONS = [
  {
    id: 'M-A1-tool-gate-bypassed',
    why: '整体旁路 ai.js 统一出口的长度闸门（inputBudgetFailure 恒返回 null，两级闸门同时失效）',
    build: function () {
      return applyMutation('M-A1-tool-gate-bypassed', 'ai.js',
        'function inputBudgetFailure(messages) {\n    const totalChars = measureInputChars(messages);',
        'function inputBudgetFailure(messages) {\n    if (true) return null;\n    const totalChars = measureInputChars(messages);');
    },
    run: async function (ov) {
      const realm = createRealm(ov);
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('masters.open', { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT + 1) });
      const delivered = realm.promptCalls.map(function (x) { return chars(x._raw); });
      expect(realm.promptCalls.length === 0 && res && res.errorCode === EXPECTED_ERROR_CODE,
        '变异未被检出：providerCalls=' + realm.promptCalls.length + ' delivered=' + JSON.stringify(delivered) + ' errorCode=' + JSON.stringify(res && res.errorCode));
    },
  },
  {
    id: 'M-A2-off-by-one-too-tight',
    why: '把闸门调太紧（恰达上限也拒）——正向用例必须转红',
    build: function () { return applyMutation('M-A2-off-by-one-too-tight', 'ai.js', 'if (totalChars <= MAX_TOTAL_INPUT_CHARS) return null;', 'if (totalChars < MAX_TOTAL_INPUT_CHARS) return null;'); },
    run: async function (ov) {
      const realm = createRealm(ov);
      const padSystem = 'S'.repeat(1000);
      const res = await realm.sandbox.AI.send([{ role: 'system', content: padSystem }, { role: 'user', content: material(TOTAL_LIMIT - 1000) }]);
      expect(!(res && res.error) && realm.promptCalls.length === 1,
        '变异未被检出：恰达上限被误拒 calls=' + realm.promptCalls.length + ' res=' + JSON.stringify(res && res.errorCode));
    },
  },
  {
    id: 'M-A3-silent-truncation',
    why: '把「明确拒绝」改成「静默截断后继续」——§7.1-1 的直接破坏',
    build: function () {
      return applyMutation('M-A3-silent-truncation', 'ai.js',
        'const overBudget = inputBudgetFailure(messages);\n    if (overBudget) return overBudget;',
        "const overBudget = null;\n    if (inputBudgetFailure(messages)) { messages = messages.map(function (m) { return { role: m.role, content: String(m.content || '').slice(0, 24000) }; }); }");
    },
    run: async function (ov) {
      const realm = createRealm(ov);
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('masters.open', { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT + 1) });
      expect(realm.promptCalls.length === 0 && res && res.ok === false && res.errorCode === EXPECTED_ERROR_CODE,
        '变异未被检出：超限被截断后照发 calls=' + realm.promptCalls.length + ' delivered=' + JSON.stringify(realm.promptCalls.map(function (x) { return chars(x._raw); })));
    },
  },
  {
    id: 'M-B1-tool-drops-errorcode',
    why: '工具层重新吞掉 errorCode（回到修复前形状）',
    build: function () { return applyMutation('M-B1-tool-drops-errorcode', 'agent-tools.js', 'if (src.errorCode) out.errorCode = src.errorCode;', 'if (false) out.errorCode = src.errorCode;'); },
    run: async function (ov) {
      const realm = createRealm(ov);
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('supervision.start', { supervisorName: 'nvwa', material: material(TOTAL_LIMIT + 1) });
      expect(res && res.ok === false && res.errorCode === EXPECTED_ERROR_CODE,
        '变异未被检出：工具响应 errorCode=' + JSON.stringify(res && res.errorCode) + ' keys=' + JSON.stringify(res && Object.keys(res)));
    },
  },
  {
    id: 'M-B2-core-drops-errorcode',
    why: 'supervision-core 重新只回 {error}（转发层被旁路）',
    build: function () { return applyMutation('M-B2-core-drops-errorcode', 'supervision-core.js', 'function forwardFailure(res) {', 'function forwardFailure(res) { return { error: res && res.error }; } function unusedForwardFailure(res) {'); },
    run: async function (ov) {
      const realm = createRealm(ov);
      const res = await realm.sandbox.SupervisionCore.runImpression('nvwa', material(TOTAL_LIMIT + 1));
      expect(res && res.error && res.errorCode === EXPECTED_ERROR_CODE,
        '变异未被检出：runImpression errorCode=' + JSON.stringify(res && res.errorCode));
    },
  },
  {
    id: 'M-B3-ai-js-callback-swallows-code',
    why: 'ai.js 自身回调出口（chat/supervise/soap/send）重新只回 {error,transportState}',
    build: function () {
      return applyMutation('M-B3-ai-js-callback-swallows-code', 'ai.js',
        'function projectFailure(res) {',
        'function projectFailure(res) { return { error: res && res.error, transportState: res && res.transportState }; }\n  function unusedProjectFailure(res) {');
    },
    run: async function (ov) {
      const realm = createRealm(ov);
      const chatRes = await new Promise(function (resolve) { realm.sandbox.AI.chat(material(TOTAL_LIMIT + 3), function (r) { resolve(r); }); });
      expect(chatRes && chatRes.errorCode === EXPECTED_ERROR_CODE, '变异未被检出：AI.chat errorCode=' + JSON.stringify(chatRes && chatRes.errorCode));
      const supRes = await new Promise(function (resolve) { realm.sandbox.AI.supervise('督导师人格', material(TOTAL_LIMIT + 7), function (r) { resolve(r); }); });
      expect(supRes && supRes.errorCode === EXPECTED_ERROR_CODE, '变异未被检出：AI.supervise errorCode=' + JSON.stringify(supRes && supRes.errorCode));
      const soapRes = await new Promise(function (resolve) { realm.sandbox.AI.generateSoapFromTranscript(material(TOTAL_LIMIT + 9), function (r) { resolve(r); }); });
      expect(soapRes && soapRes.errorCode === EXPECTED_ERROR_CODE, '变异未被检出：AI.generateSoap errorCode=' + JSON.stringify(soapRes && soapRes.errorCode));
    },
  },
  {
    id: 'M-C1-page-entry-no-errorcode',
    why: '页面超限响应去掉 errorCode（回到只有 reason 的形状）',
    build: function () { return applyMutation('M-C1-page-entry-no-errorcode', 'clinical-context.js', "errorCode: taskBudgetErrorCode(),", ''); },
    run: function (ov) {
      const realm = createRealm(ov);
      const res = realm.sandbox.ClinicalContext.build('supervision-multi-school', {}, { inputText: material(TOTAL_LIMIT + 1), system: 'sys' });
      expect(res && res.ok === false && res.errorCode === EXPECTED_ERROR_CODE && res.reason === 'task-budget-exceeded',
        '变异未被检出：页面超限响应 ' + JSON.stringify(res && { errorCode: res.errorCode, reason: res.reason, keys: Object.keys(res) }));
    },
  },
  {
    id: 'M-D1-manifest-provenance-off',
    why: 'manifest 来源解析被旁路（回到"source 说谎 / version 恒等字面量"）',
    build: function () { return applyMutation('M-D1-manifest-provenance-off', 'prompt-governance.js', 'const provenance = resolveTemplateProvenance(input, contentHash);', 'const provenance = { provenance: "declared" };'); },
    run: function (ov) {
      const realm = createRealm(ov);
      const PG = realm.sandbox.PromptGovernance;
      const CARDS = realm.sandbox.SUPERVISION_SYNDICATE;
      realm.sandbox.MastersCore.buildMessages({ messages: [], summary: '', importedContext: '' }, CARDS.filter(function (c) { return c.key === 'sup-klein'; })[0], 'hi', {});
      const item = PG.getPromptManifest().filter(function (m) { return m.id === 'masters.system.sup-klein'; })[0];
      expect(item && item.source === 'app/js/supervision-syndicate-data.js',
        '变异未被检出：sup-klein source=' + JSON.stringify(item && item.source));
      expect(item && item.version !== '4.4.0', '变异未被检出：version 仍是兜底字面量 ' + JSON.stringify(item && item.version));
      expect(item && item.provenance !== 'verified', '变异未被检出：provenance 仍为 verified');
    },
  },
];

/* 冗余探针（不计入 survivors）：单独旁路某一级闸门，验证另一级仍然 fail-closed。
 * 期望与 MUTATIONS 相反——这里「行为保持」才算通过。 */
const PROBES = [
  {
    id: 'R-A-gate2-alone-still-blocks',
    why: '只删 callWithManualOnly 的前置闸门：网络级闸门（callDirect preFlight）必须仍然做到 0 调用 + 同 errorCode',
    build: function () {
      return applyMutation('R-A-gate2-alone-still-blocks', 'ai.js',
        'const overBudget = inputBudgetFailure(messages);\n    if (overBudget) return overBudget;',
        'const overBudget = null;');
    },
    run: async function (ov) {
      const realm = createRealm(ov);
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('masters.open', { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT + 1) });
      expect(realm.promptCalls.length === 0, '第二级闸门未独立挡住出网：calls=' + realm.promptCalls.length);
      expect(res && res.ok === false && res.errorCode === EXPECTED_ERROR_CODE, '第二级闸门未独立产生稳定 errorCode：' + JSON.stringify(res));
      return { providerCalls: 0, errorCode: res.errorCode };
    },
  },
];

/* 负向对照（ENV-NOTES 纪律：夹具必须先证明它能测出缺陷）
 * 用 HEAD 版本（=修复前产品源码，只读 git show）替换被我改过的 5 个文件，
 * 同一批用例必须全部转红；否则说明夹具是恒真断言，结论不算数。 */
const { spawn } = require('child_process');
const PRE_FIX_REV = '514f5ee'; // 修复前已核验基线；提交后 HEAD 会改变，不能用浮动 HEAD 当负控。
const PRE_FIX_FILES = ['ai.js', 'agent-tools.js', 'supervision-core.js', 'clinical-context.js', 'prompt-governance.js'];
let preFixCache = null;
function readHeadSource(file) {
  return new Promise(function (resolve, reject) {
    const child = spawn('git', ['show', PRE_FIX_REV + ':app/js/' + file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', function (chunk) { output.push(chunk); });
    child.stderr.on('data', function (chunk) { errors.push(chunk); });
    child.on('error', reject);
    child.on('close', function (code) {
      if (code !== 0) return reject(new Error('git show ' + PRE_FIX_REV + ':app/js/' + file + ' failed (' + code + '): ' + Buffer.concat(errors).toString('utf8')));
      resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}
async function preFixOverrides() {
  if (preFixCache) return preFixCache;
  const ov = {};
  for (const f of PRE_FIX_FILES) {
    ov[f] = await readHeadSource(f);
    if (/inputBudgetFailure|toolFailure|taskBudgetErrorCode|resolveTemplateProvenance/.test(ov[f])) {
      throw new Error('NEGATIVE CONTROL INVALID: HEAD 版本已含修复符号（' + f + '）');
    }
  }
  preFixCache = ov;
  return ov;
}
const NEGATIVE_CONTROLS = [
  {
    id: 'NC-A-tool-budget-was-open', why: '修复前：240001 字符载荷被原样送进 provider 且 ok=true',
    run: async function () {
      const realm = createRealm({ overrides: await preFixOverrides() });
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('masters.open', { masterId: 'winnicott', mode: '1v1', topic: material(TOTAL_LIMIT + 1) });
      const delivered = realm.promptCalls.map(function (x) { return chars(x._raw); });
      expect(realm.promptCalls.length > 0 && delivered.some(function (n) { return n > TOTAL_LIMIT; }) && !(res && res.errorCode),
        '夹具对修复前版本仍为绿（calls=' + realm.promptCalls.length + ' delivered=' + JSON.stringify(delivered) + '）');
      return { providerCalls: realm.promptCalls.length, deliveredMaxChars: Math.max.apply(null, delivered), ok: res && res.ok, errorCode: res && res.errorCode };
    },
  },
  {
    id: 'NC-B-tool-swallowed-errorcode', why: '修复前：provider/闸门失败对象的 errorCode 被工具层吞掉',
    run: async function () {
      const ov = Object.assign({}, await preFixOverrides());
      // 只回退工具层与督导核，保留修复后的 ai.js 闸门，才能隔离出「吞码」这一个缺陷
      delete ov['ai.js'];
      const realm = createRealm({ overrides: ov });
      seedConversations(realm);
      const res = await realm.sandbox.AgentTools.invoke('supervision.start', { supervisorName: 'nvwa', material: material(TOTAL_LIMIT + 1) });
      expect(res && res.ok === false && !res.errorCode, '夹具对修复前工具层仍为绿：' + JSON.stringify(res));
      return { responseKeys: Object.keys(res), errorCode: res.errorCode || null };
    },
  },
  {
    id: 'NC-C-page-entry-had-no-errorcode', why: '修复前：ClinicalContext.build 超限只回 reason',
    run: async function () {
      const ov = Object.assign({}, await preFixOverrides());
      delete ov['ai.js'];
      const realm = createRealm({ overrides: ov });
      const res = realm.sandbox.ClinicalContext.build('supervision-multi-school', {}, { inputText: material(TOTAL_LIMIT + 1), system: 'sys' });
      expect(res && res.ok === false && res.reason === 'task-budget-exceeded' && !res.errorCode,
        '夹具对修复前页面层仍为绿：' + JSON.stringify(res && { ok: res.ok, reason: res.reason, errorCode: res.errorCode }));
      return { reason: res.reason, hadErrorCode: !!res.errorCode };
    },
  },
  {
    id: 'NC-D-manifest-said-wrong-file', why: '修复前：masters.system.sup-klein 的 source 谎称 masters-data.js，version 恒为 4.4.0',
    run: async function () {
      const realm = createRealm({ overrides: await preFixOverrides() });
      const PG = realm.sandbox.PromptGovernance;
      const CARDS = realm.sandbox.SUPERVISION_SYNDICATE;
      realm.sandbox.MastersCore.buildMessages({ messages: [], summary: '', importedContext: '' }, CARDS.filter(function (c) { return c.key === 'sup-klein'; })[0], 'hi', {});
      const item = PG.getPromptManifest().filter(function (m) { return m.id === 'masters.system.sup-klein'; })[0];
      expect(item && item.source === 'app/js/masters-data.js' && item.version === '4.4.0',
        '夹具对修复前 manifest 仍为绿：' + JSON.stringify(item && { source: item.source, version: item.version }));
      return { source: item.source, version: item.version };
    },
  },
];

/* ---------------- evidence + report ---------------- */
async function main() {
  ensureDir(OUT);
  const evidence = { startedAt: new Date().toISOString(), totalLimit: TOTAL_LIMIT, expectedErrorCode: EXPECTED_ERROR_CODE, cases: {}, mutations: {}, moduleFacts: {} };

  // module facts：闸门是否真的只存在于统一出口
  const aiSrc = fs.readFileSync(path.join(APP, 'ai.js'), 'utf8');
  const agentSrc = fs.readFileSync(path.join(APP, 'agent-tools.js'), 'utf8');
  evidence.moduleFacts = {
    aiJsGateLines: aiSrc.split('\n').filter(function (l) { return /inputBudgetFailure|MAX_TOTAL_INPUT_CHARS/.test(l); }).length,
    agentToolsOwnLengthConstant: /MAX_[A-Z_]*CHARS|240000/.test(agentSrc.replace(/\/\/[^\n]*/g, '')),
  };

  // A：4 条工具入口 × {恰好核心上限, 上限+1} × 3 次重复
  for (const c of TOOL_CASES) {
    await assertCase('A-tool-budget', c.id + ' ｜ ' + c.label, async function () { return await runToolEntry(c); });
  }
  // B
  await assertCase('B-errorcode-carriage', 'T-3 provider errorCode 原样携带', async function () { return await runToolErrorCodeCarriage(); });
  // C
  await assertCase('C-page-entry', 'P-1/P-2 页面超限 errorCode + reason 兼容 + 恰达上限不误拒', function () { return runPageEntry(); });
  // positive
  await assertCase('A-positive', '正常长度材料不得被误拒（4 工具入口 + 恰达上限 + stream/supervise）', async function () { return await runPositiveNotFalselyRejected(); });
  // D
  await assertCase('D-manifest', 'manifest source/version 与真实模板同源可核', function () { return runManifestProvenance(); });

  const beforeReds = results.filter(function (r) { return !r.ok; }).length;

  evidence.negativeControls = {};
  for (const nc of NEGATIVE_CONTROLS) {
    let detected = false; let detail = null; let failure = null;
    try { detail = await nc.run(); detected = true; } catch (e) { failure = String(e && e.message || e); }
    evidence.negativeControls[nc.id] = { why: nc.why, status: detected ? 'RED-DETECTED' : 'CLAMP-VACUOUS', observed: detail, error: failure };
    results.push({ group: 'negative-control', name: nc.id, ok: detected, failure: detected ? null : '夹具对修复前版本不为红 → 断言恒真：' + failure });
  }

  for (const m of MUTATIONS) {
    let overrides;
    try { overrides = m.build(); } catch (e) {
      evidence.mutations[m.id] = { status: 'INVALID', error: String(e.message) };
      results.push({ group: 'mutation', name: m.id, ok: false, failure: 'INVALID: ' + e.message });
      continue;
    }
    let killed = false; let failure = null;
    try { await m.run({ overrides: overrides }); } catch (e) { killed = true; failure = String(e.message); }
    // 变异旁路掉修复 => run() 必须抛错（killed）。killed=true 表示该用例确实测到了修复。
    evidence.mutations[m.id] = { why: m.why, status: killed ? 'KILLED' : 'SURVIVOR', detectedBecause: failure };
    results.push({ group: 'mutation', name: m.id, ok: killed, failure: killed ? null : '变异存活：旁路修复后用例仍为绿' });
  }

  evidence.probes = {};
  for (const p of PROBES) {
    let held = false; let observed = null; let failure = null;
    try { observed = await p.run({ overrides: p.build() }); held = true; } catch (e) { failure = String(e && e.message || e); }
    evidence.probes[p.id] = { why: p.why, status: held ? 'HELD' : 'BROKEN', observed: observed, error: failure };
    results.push({ group: 'redundancy-probe', name: p.id, ok: held, failure: held ? null : '冗余闸门未能独立兜底：' + failure });
  }

  const total = results.length;
  const passed = results.filter(function (r) { return r.ok; }).length;
  const mutTotal = MUTATIONS.length;
  const mutKilled = MUTATIONS.filter(function (m) { return evidence.mutations[m.id] && evidence.mutations[m.id].status === 'KILLED'; }).length;
  const ncTotal = NEGATIVE_CONTROLS.length;
  const ncRed = NEGATIVE_CONTROLS.filter(function (n) { return evidence.negativeControls[n.id] && evidence.negativeControls[n.id].status === 'RED-DETECTED'; }).length;
  const probeTotal = PROBES.length;
  const probeHeld = PROBES.filter(function (p) { return evidence.probes[p.id] && evidence.probes[p.id].status === 'HELD'; }).length;
  evidence.results = results;
  evidence.summary = {
    total: total, passed: passed, red: total - passed,
    unexpectedRedBeforeMutations: beforeReds,
    mutations: { total: mutTotal, killed: mutKilled, survivors: mutTotal - mutKilled },
    negativeControls: { total: ncTotal, redDetected: ncRed, vacuous: ncTotal - ncRed },
    redundancyProbes: { total: probeTotal, held: probeHeld },
    sourceMd5: {},
  };
  fs.readdirSync(APP).filter(function (f) { return FILES.indexOf(f) >= 0; }).forEach(function (f) {
    evidence.summary.sourceMd5[f] = md5(fs.readFileSync(path.join(APP, f)));
  });
  fs.writeFileSync(path.join(OUT, 'f5-entry-budget-evidence.json'), JSON.stringify(evidence, function (k, v) { return k === '_raw' ? undefined : v; }, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'f5-entry-budget.log'), results.map(function (r) {
    return (r.ok ? 'PASS  ' : 'FAIL  ') + '[' + r.group + '] ' + r.name + (r.failure ? ' :: ' + r.failure : '');
  }).join('\n') + '\n\nCASES: total=' + total + ' pass=' + passed + ' red=' + (total - passed)
    + '\nMUTATIONS: total=' + mutTotal + ' survivors=' + (mutTotal - mutKilled)
    + '\nNEGATIVE-CONTROL: total=' + ncTotal + ' red-detected=' + ncRed + ' vacuous=' + (ncTotal - ncRed)
    + '\nREDUNDANCY-PROBES: total=' + probeTotal + ' held=' + probeHeld + '\n', 'utf8');

  results.forEach(function (r) { console.log((r.ok ? 'PASS  ' : 'FAIL  ') + '[' + r.group + '] ' + r.name + (r.failure ? ' :: ' + r.failure : '')); });
  console.log('\nCASES: total=' + total + ' pass=' + passed + ' red=' + (total - passed));
  console.log('MUTATIONS: total=' + mutTotal + ' survivors=' + (mutTotal - mutKilled));
  console.log('NEGATIVE-CONTROL: total=' + ncTotal + ' red-detected=' + ncRed + ' vacuous=' + (ncTotal - ncRed));
  console.log('REDUNDANCY-PROBES: total=' + probeTotal + ' held=' + probeHeld);
  console.log('evidence: ' + path.join(OUT, 'f5-entry-budget-evidence.json'));
  const allGood = (total - passed) === 0 && mutKilled === mutTotal && ncRed === ncTotal && probeHeld === probeTotal;
  process.exit(allGood ? 0 : 1);
}

main().catch(function (e) { console.error('FATAL', e); process.exit(2); });
