/* ============================================================================
 * scripts/f5-budget-consistency.test.cjs
 *
 * F5-A / F5-B / F5-C / F5-D 收口自证（XJ-5.1.19 第 4 轮，按产品负责人裁决①）
 *
 * 需求来源：qa/task-scratch/XJ-5.1.19-f1-f7-final-acceptance-001/reviews-r1c/
 *   f4-f5-round3.md §1.3（F5-A/B/C/D 扣分账）+ §6.1 + §6.2；
 *   reports/decisions-20260924.md DEC-01（阶段预算与总预算**不得放宽**）；
 *   本卡裁决①（压低 clip(summary,24000) 与学派材料 clip(material,16000)，
 *   使组合后的阶段 prompt 必然 ≤ 30000；不许放宽闸门、不许超限后再静默截一刀）。
 *
 * 覆盖（每条都可能为假；未测不记通过）：
 *   A 三入口同一权威度量 / 同一码表 / 同一拒绝时机
 *     A0 码表与公布口径字段齐备（不新造同义码）
 *     A1 出口判定读的是**脱敏后的真实出站字符数**，且同时回报脱敏前数（F5-A）
 *     A2 对外公布的「原始材料等效上限」实测放行 + 粘贴 240,000 原始字符仍拒（同码）
 *     A3 核心入口超限：同一码、同一测量、0 出网、truncated:false；恰达上限不误拒
 *     A4 页面入口：回报字符数 === 唯一权威度量对同一份载荷的读数；三入口预算读数
 *     A5 重复调用（三入口 × 5 次）决策与 errorCode 完全一致
 *     A6 脱敏幂等（出站投影唯一化的前提）：wire(wire(x)) === wire(x)，五份语料
 *   B 正常材料不误拒：页面合法 12,000..24,000 realistic 材料 + 分段路径，
 *     以及契约内长摘要（1.0/1.4/1.7/2.0/3.0/4.0 字符每 token）全部跑通、无硬拒
 *   C F5-B 算术自证（真实 builder 实测，不抄常数）：
 *     C1 逐卡逐阶段量出固定开销；C2 组装后与真实出站两条不等式逐卡逐阶段成立；
 *     C3 阳性对照：旧常数（24000/16000）在同一把尺下必然越界；C4 摘要裁剪真的发生
 *   D F5-C：每阶段真实出站 ≤ 阶段预算（唯一权威度量复核）；阶段闸门仍然活着
 *     （模板超预算 → STAGE_BUDGET_EXCEEDED、该阶段 0 出网、truncated:false、
 *      文案写明量纲并同时报出真实出站字符数）
 *
 * 反向变异（--mutations，期望 MUTATIONS: total=9 survivors=0）：恢复旧 clip ×2、
 *   把出口闸门挪回脱敏前、放宽阶段预算、超限改静默截断、换码名、阶段另抄一份长度算法、
 *   阶段闸门改用出站口径（会误拒页面合法材料）、对外等效上限不做换算。
 *
 * 运行：node scripts/f5-budget-consistency.test.cjs [--mutations]
 * 落盘：logs/f5-consistency/{budget-consistency-evidence.json,budget-consistency.log,
 *       budget-mutation-evidence.json,budget-mutations.log,mutants/**,payloads/**}
 * 无网络、无 Electron、无真实供应商；材料全部合成。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const OUT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f5-consistency-evidence-'));
const MUTANT_DIR = path.join(OUT, 'mutants');
const PAYLOAD_DIR = path.join(OUT, 'payloads');
const MUTATION_MODE = process.argv.indexOf('--mutations') >= 0;
const REPEATS = 5;

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readProduct(name) { return fs.readFileSync(path.join(APP, name), 'utf8'); }

/* ---------------- 合成语料（与 reviews-r1c 探针同一形状，便于对账） ---------------- */
function rep(s, target) { let o = ''; while (o.length < target) o += s; return o.slice(0, target); }
const NAMES = ['张明远', '李秀华', '王建国', '赵雅琴', '陈立群', '刘伟东', '孙佳宁', '周慧敏'];
function realisticNote(i) {
  const n = NAMES[i % NAMES.length];
  return '第' + (i + 1) + '次会谈记录（合成数据，非真实病例）\n' +
    '姓名：' + n + '，性别：女，出生年月：1990年3月12日，个案号：XJ' + (100000 + i) + '\n' +
    '联系方式：' + n + ' 手机 138' + String(10000000 + i).slice(0, 8) + '，邮箱 case' + i + '@example.test\n' +
    '家庭住址：某市合成区示例路 128 号 3 单元 501 室\n' +
    '会谈日期：2026年' + ((i % 12) + 1) + '月' + ((i % 27) + 1) + '日，咨询师：' + NAMES[(i + 3) % NAMES.length] + '\n' +
    '主诉：来访者' + n + '近两个月入睡困难，工作中注意力下降，自述与配偶因育儿分工争执增多。' +
    rep('来访者描述在会议中担心被评价，回避发言，会后反复回想细节。咨询师使用反映性倾听，' +
      '并邀请其描述一次具体情境中的身体感受与自动想法。', 1500) + '\n';
}
function realisticCorpus(target) { let o = ''; let i = 0; while (o.length < target) o += realisticNote(i++); return o.slice(0, target); }
function midDenseCorpus(target) {
  let o = ''; let i = 0;
  while (o.length < target) {
    o += '咨询师' + NAMES[i % NAMES.length] + '：' +
      rep('这一段是逐字稿正文，记录来访者的叙述与咨询师的回应，用于合成测量。', 7) + '\n';
    i += 1;
  }
  return o.slice(0, target);
}
function adversarialCorpus(target) { return rep('来访者张三表示最近睡不好。', target); }
function shrinkingCorpus(target) { return rep('身份证号11010119900307561X结束', target); }
/* 长度可控、PII 无关的中性单元（与 scripts/f5-entry-budget.test.cjs 同一份形状） */
function unit(i) { return '[u' + String(i).padStart(6, '0') + ']' + '·'.repeat(51); }
function material(chars) { let out = ''; let i = 0; while (out.length < chars) out += unit(i++); return out.slice(0, chars); }
/* 摘要替身正文：与 realistic 语料同一密度（×1.3745，复审 §6.1 认定的「真实材料」密度）。
 * 刻意不用「将来访者描述在会议中…」背靠背重复的病理形状（实测 ×1.65~2.0）——
 * 那正是复审 §6.2-4 判为夹具 artifact、要求作废的那类替身形状。 */
function summaryText(chars) { return realisticCorpus(chars); }

/* ---------------- realm：真实产品模块 + 录制 provider 边界 ---------------- */
const FILES = [
  'prompt-governance.js', 'pii-sanitizer.js', 'prompts.builtin.js', 'masters-data.js',
  'supervision-syndicate-data.js', 'supervisors.js', 'masters-core.js', 'supervision-core.js',
  'clinical-context.js', 'ai.js', 'supervision-syndicate.js',
];
const TAILS = {
  'prompts.builtin.js': '\n;globalThis.PromptsBuiltin = PromptsBuiltin;',
  'supervisors.js': '\n;globalThis.Supervisors = Supervisors;',
  'masters-core.js': '\n;globalThis.MastersCore = MastersCore;',
  'supervision-core.js': '\n;globalThis.SupervisionCore = SupervisionCore;',
  'clinical-context.js': '\n;globalThis.ClinicalContext = ClinicalContext;',
};
/* 变异注入点：整套用例跑的是同一份「产品源码文本」，只是某一份被换掉 */
let ACTIVE_OVERRIDES = null;

function makeFakeStore() {
  const c = { supervisions: [], settings: {} };
  return {
    getSettings: function () { return c.settings; },
    getClient: function () { return null; },
    getSessions: function () { return []; },
    getSession: function () { return null; },
    getMaterialWorkspace: function () { return null; },
    getSupervision: function () { return null; },
    getAiSupervisions: function () { return c.supervisions; },
    createClinicalActionRun: function (rec) { return rec; },
    updateClinicalActionRun: function () { return null; },
    saveAiSupervisionDurable: async function (payload) { c.supervisions.push(payload); return { ok: true, value: payload }; },
  };
}

function classifyStage(messages) {
  const user = String((messages && messages[1] && messages[1].content) || '');
  if (user.indexOf('请摘要以下临床材料分段') >= 0) return 'summary:segment';
  if (user.indexOf('请摘要以下临床材料') >= 0) return 'summary';
  if (user.indexOf('请判断案例类型并输出路由 JSON') >= 0) return 'route';
  if (user.indexOf('请从你的学派督导视角分析') >= 0) return 'school';
  if (user.indexOf('请输出三段式综合督导') >= 0) return 'synthesis';
  return 'other';
}

function createRealm(opts) {
  opts = opts || {};
  const overrides = opts.overrides || ACTIVE_OVERRIDES || null;
  const charsPerToken = opts.charsPerToken == null ? 1.4 : opts.charsPerToken;
  const sends = [];
  const bridge = {
    onAiChunk: function () { return function () {}; },
    cancelAiRequest: function () {},
    encryptSecret: function (s) { return Promise.resolve('enc:' + s); },
    aiRequest: function (req) {
      if (req && req.kind === 'quota') return Promise.resolve({ ok: false, status: 0, bodyText: '' });
      const messages = (req && req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
      const composed = messages.reduce(function (n, m) { return n + String(m && m.content == null ? '' : m.content).length; }, 0);
      const stage = classifyStage(messages);
      sends.push({
        seq: sends.length, stage: stage, composedChars: composed, messages: messages,
        maxTokens: req && req.body && req.body.max_tokens,
        systemChars: String((messages[0] && messages[0].content) || '').length,
        userChars: String((messages[1] && messages[1].content) || '').length,
      });
      let content;
      if (stage === 'route') content = '{"case_type":"依恋创伤","schools":["sup-winnicott","sup-klein","sup-bion"],"focus":"依恋与设置","workflow":"focused"}';
      else if (stage === 'synthesis') content = '【对比表】合成对比\n【分歧点】合成分歧\n【整合建议】合成建议';
      else if (stage === 'school') content = '学派分析：基于材料线索的合成判断与建议。';
      else content = summaryText(Math.floor((req && req.body && req.body.max_tokens ? req.body.max_tokens : 4000) * charsPerToken));
      if (typeof opts.responder === 'function') {
        const forced = opts.responder(stage, messages);
        if (forced != null) content = forced;
      }
      return Promise.resolve({ ok: true, status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: content } }] }) });
    },
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    setImmediate, queueMicrotask, Promise, JSON, Math, Date, RegExp, Error, Object, Array, String, Number,
    Boolean, Set, Map, Function, TextEncoder, TextDecoder, Buffer, crypto, AbortController, URL,
    encodeURIComponent, decodeURIComponent, unescape, escape, isNaN, parseInt, parseFloat,
    structuredClone,
    atob: function (b64) { return Buffer.from(String(b64), 'base64').toString('binary'); },
    btoa: function (bin) { return Buffer.from(String(bin), 'binary').toString('base64'); },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.__XJ_API__ = bridge;
  sandbox.Store = makeFakeStore();
  sandbox.App = { featureGate: function () { return true; }, hasAICompute: function () { return true; }, canUse: function () { return true; }, showToast: function () {} };
  sandbox.document = {
    createElement: function () { return { style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {} }, appendChild: function () {}, setAttribute: function () {}, addEventListener: function () {} }; },
    getElementById: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    addEventListener: function () {}, body: { appendChild: function () {} }, head: { appendChild: function () {} }, documentElement: { appendChild: function () {} },
  };
  const ctx = vm.createContext(sandbox);
  FILES.forEach(function (name) {
    const src = overrides && Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : readProduct(name);
    vm.runInContext(src + (TAILS[name] || ''), ctx, { filename: name });
  });
  if (!sandbox.AI || !sandbox.AI.budgetGuard) throw new Error('realm bootstrap failed: AI.budgetGuard missing');
  if (!sandbox.SupervisionSyndicate) throw new Error('realm bootstrap failed: SupervisionSyndicate missing');
  if (!sandbox.XJPIISanitizer) throw new Error('realm bootstrap failed: XJPIISanitizer missing（幂等与出站度量无从复核）');
  if (!sandbox.ClinicalContext) throw new Error('realm bootstrap failed: ClinicalContext missing');
  return { sandbox: sandbox, sends: sends };
}

function runWithOverrides(overrides, fn) {
  const previous = ACTIVE_OVERRIDES;
  ACTIVE_OVERRIDES = overrides || null;
  return Promise.resolve().then(fn).then(function (v) { ACTIVE_OVERRIDES = previous; return v; },
    function (e) { ACTIVE_OVERRIDES = previous; throw e; });
}

/* ---------------- 断言登记（无落盘 = 无取证） ---------------- */
const RESULTS = [];
const SUBS = [];           /* 每一次 expect 都落盘：粒度到单条不变量，不是「整组一条绿」 */
const OBSERVED = {};
function expect(cond, msg) {
  SUBS.push({ ok: !!cond, assert: String(msg) });
  if (!cond) throw new Error(msg);
}
async function assertCase(group, name, fn) {
  const from = SUBS.length;
  try {
    const detail = await fn();
    RESULTS.push({ group: group, name: name, ok: true, subChecks: SUBS.slice(from), detail: detail === undefined ? null : detail });
    return { ok: true, detail: detail };
  } catch (e) {
    RESULTS.push({ group: group, name: name, ok: false, failure: String((e && e.message) || e), subChecks: SUBS.slice(from) });
    return { ok: false, failure: String((e && e.message) || e) };
  }
}

/* ============================ A. 三入口同一度量、同一码 ============================ */
async function caseA() {
  const realm = createRealm();
  const AI = realm.sandbox.AI;
  const SY = realm.sandbox.SupervisionSyndicate;
  const CC = realm.sandbox.ClinicalContext;
  const guard = AI.budgetGuard;
  const CODE = guard.errorCode;
  const LIMIT = guard.limitChars;

  /* A0 码表与口径字段：不新造同义码 */
  expect(CODE === 'MATERIAL_TOO_LONG', 'A0 出口 errorCode 应复用既有 MATERIAL_TOO_LONG，实测 ' + CODE);
  expect(guard.transportCode === 'XJ_AI_INPUT_BUDGET_EXCEEDED', 'A0 传输码应保持，实测 ' + guard.transportCode);
  expect(LIMIT === 240000, 'A0 出口公布上限必须仍是 240000（DEC-01 不得放宽），实测 ' + LIMIT);
  expect(guard.metric === 'sanitised-outbound-chars', 'A0 出口必须公布自己量的口径，实测 metric=' + guard.metric);
  expect(SY.MAX_STAGE_INPUT_CHARS === 30000 && SY.MAX_INPUT_CHARS === 240000,
    'A0 阶段/核心预算未放宽：期望 30000/240000，实测 ' + SY.MAX_STAGE_INPUT_CHARS + '/' + SY.MAX_INPUT_CHARS);
  OBSERVED.codes = { errorCode: CODE, transportCode: guard.transportCode, limitChars: LIMIT, metric: guard.metric };

  /* A1 出口判定 = 脱敏后的真实出站字符数 */
  const rawAtLimit = realisticCorpus(LIMIT);
  const wireOfRaw = guard.outboundChars([{ role: 'user', content: rawAtLimit }]);
  expect(wireOfRaw > LIMIT, 'A1 前提：realistic ' + LIMIT + ' 字符脱敏后应扩写超上限，实测出站 ' + wireOfRaw);
  const r1 = createRealm();
  let err1 = null; let res1 = null;
  try { res1 = await r1.sandbox.AI.send([{ role: 'user', content: rawAtLimit }]); } catch (e) { err1 = e; }
  const code1 = (err1 && (err1.errorCode || err1.code)) || (res1 && (res1.errorCode || res1.code)) || null;
  const b1 = (err1 && err1.inputBudget) || (res1 && res1.inputBudget) || res1 || {};
  expect(code1 === CODE, 'A1 realistic 240,000 原始字符（出站会超限）必须被拒且带稳定 errorCode=' + CODE
    + '，实测 code=' + JSON.stringify(code1) + ' / provider 调用 ' + r1.sends.length + ' 次');
  expect(r1.sends.length === 0, 'A1 超限不得出网，实测 provider 调用 ' + r1.sends.length + ' 次');
  expect(b1.totalChars === wireOfRaw, 'A1 回报的 totalChars 必须就是真实出站字符数 ' + wireOfRaw + '，实测 ' + b1.totalChars);
  expect(b1.rawChars === LIMIT, 'A1 必须同时回报脱敏前字符数 ' + LIMIT + '，实测 ' + b1.rawChars);
  expect(b1.totalChars > b1.rawChars, 'A1 扩写方向必须如实（出站 > 脱敏前）：' + b1.totalChars + ' vs ' + b1.rawChars);
  expect(b1.truncated === false, 'A1 必须显式 truncated:false，实测 ' + JSON.stringify(b1.truncated));
  expect(b1.metric === guard.metric, 'A1 拒绝对象必须自报量纲，实测 ' + b1.metric);

  /* A2 对外承诺与判定同口径：公布的原始材料等效上限实测放行 */
  const rawEquiv = guard.rawMaterialBudgetChars;
  expect(rawEquiv > 0 && rawEquiv < LIMIT, 'A2 等效原始材料上限必须存在且小于出站上限：' + rawEquiv);
  expect(rawEquiv === Math.floor(LIMIT / guard.expansionFactor),
    'A2 等效上限必须可复算：floor(' + LIMIT + ' / ' + guard.expansionFactor + ') = ' + Math.floor(LIMIT / guard.expansionFactor) + '，实测 ' + rawEquiv);
  const equivCorpus = realisticCorpus(rawEquiv);
  const r2 = createRealm();
  const res2 = await r2.sandbox.AI.send([{ role: 'user', content: equivCorpus }]);
  expect(!res2 || !res2.error, 'A2 对外公布的等效上限被误拒（承诺仍偏紧）：' + JSON.stringify(res2 && res2.errorCode));
  expect(r2.sends.length === 1, 'A2 等效上限必须真的出网一次（防「永远放行」假绿），实测 ' + r2.sends.length);
  const sentWire = r2.sandbox.AI.budgetGuard.outboundChars([{ role: 'user', content: equivCorpus }]);
  expect(sentWire <= LIMIT, 'A2 放行时真实出站必须 ≤ 公布上限，实测 ' + sentWire);
  const r3 = createRealm();
  let err3 = null; let res3 = null;
  try { res3 = await r3.sandbox.AI.send([{ role: 'user', content: rawAtLimit }]); } catch (e) { err3 = e; }
  const code3 = (err3 && (err3.errorCode || err3.code)) || (res3 && (res3.errorCode || res3.code)) || null;
  const msg3 = String((err3 && err3.message) || (res3 && (res3.error || (res3.inputBudget || {}).error)) || '');
  expect(code3 === CODE, 'A2 阳性对照：粘贴 240,000 原始字符仍须被拒且同码，实测 ' + JSON.stringify(code3));
  expect(/出站/.test(msg3), 'A2 文案必须说明自己量的是出站口径，实测 ' + msg3.slice(0, 60));
  expect(r3.sends.length === 0, 'A2 阳性对照：超限时不得出网，实测 ' + r3.sends.length);

  /* A3 核心入口：同一码、同一测量、0 出网；恰达上限不误拒 */
  const r4 = createRealm();
  const coreOver = await r4.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({ material: material(240001) }, {});
  expect(coreOver.ok === false && coreOver.errorCode === CODE,
    'A3 核心入口 240,001 必须 MATERIAL_TOO_LONG，实测 ' + JSON.stringify({ ok: coreOver.ok, ec: coreOver.errorCode }));
  expect(r4.sends.length === 0, 'A3 核心入口超限不得有任何出网，实测 ' + r4.sends.length);
  expect(coreOver.materialChars === r4.sandbox.AI.budgetGuard.composedChars([{ role: 'user', content: material(240001) }]),
    'A3 核心入口回报的字符数必须等于唯一权威度量的组装后读数，实测 ' + coreOver.materialChars);
  expect(coreOver.truncated === false, 'A3 核心入口必须显式 truncated:false');
  expect(/量纲/.test(String(coreOver.error)), 'A3 核心入口文案必须写明量纲（F5-C 收口），实测 ' + String(coreOver.error).slice(0, 40));
  const coreExact = await r4.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({ material: material(240000), schools: ['sup-winnicott'] }, {});
  expect(coreExact.ok === true, 'A3 恰达核心上限不得误拒，实测 ' + JSON.stringify({ ok: coreExact.ok, ec: coreExact.errorCode }));
  expect(r4.sends.length > 0, 'A3 恰达上限必须真的走出口，实测 ' + r4.sends.length);

  /* A4 页面入口：数字来自同一份测量；三入口预算读数记录在案 */
  const input = material(30000);
  const pagePayload = '[当前输入]\n' + input;
  const pageOver = CC.build('supervision-multi-school', {}, { inputText: input, system: 'sys' });
  expect(pageOver.ok === false && pageOver.errorCode === CODE,
    'A4 页面超限必须带同一 errorCode，实测 ' + JSON.stringify({ ok: pageOver.ok, ec: pageOver.errorCode }));
  expect(pageOver.reason === 'task-budget-exceeded', 'A4 页面 reason 向后兼容不得改，实测 ' + pageOver.reason);
  expect(pageOver.estimatedChars === guard.composedChars([{ role: 'user', content: pagePayload }]),
    'A4 页面回报字符数应等于唯一权威度量的组装后读数 ' + guard.composedChars([{ role: 'user', content: pagePayload }]) + '，实测 ' + pageOver.estimatedChars);
  expect(pageOver.truncated === false, 'A4 页面超限必须显式 truncated:false');
  const spec = CC.getTaskSpec('supervision-multi-school');
  const legalAtPage = CC.build('supervision-multi-school', {}, { inputText: material(spec.budget.maxChars - '[当前输入]\n'.length), system: 'sys' });
  expect(legalAtPage.ok === true, 'A4 恰达页面上限不得误拒，实测 ' + JSON.stringify({ ok: legalAtPage.ok, ec: legalAtPage.errorCode }));
  OBSERVED.entries = {
    pageBudgetChars: spec.budget.maxChars, coreMaterialChars: SY.MAX_INPUT_CHARS, egressOutboundChars: LIMIT,
    pageReachesBoundFirstChars: spec.budget.maxChars - '[当前输入]\n'.length,
    sameCodeTableAtAllEntries: pageOver.errorCode === CODE && coreOver.errorCode === CODE && code1 === CODE,
    sameTimingZeroEgress: r4.sends.length > 0 && true,
  };
  expect(OBSERVED.entries.pageBudgetChars < OBSERVED.entries.coreMaterialChars,
    'A4 页面准入必须严格小于核心材料上限（否则「先到界」不成立）');

  /* A5 重复调用一致（三入口 × REPEATS） */
  const codes = { egress: [], core: [], page: [] };
  for (let i = 0; i < REPEATS; i += 1) {
    const rr = createRealm();
    let e = null; let s = null;
    try { s = await rr.sandbox.AI.send([{ role: 'user', content: rawAtLimit }]); } catch (x) { e = x; }
    const cs = (e && (e.errorCode || e.code)) || (s && (s.errorCode || s.code)) || 'ACCEPTED';
    const cb = (e && e.inputBudget) || (s && s.inputBudget) || {};
    codes.egress.push(String(cs) + '/' + String(cb.totalChars));
    expect(rr.sends.length === 0, 'A5 第 ' + i + ' 次出口超限却出网了');
    const c = await rr.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({ material: material(240001) }, {});
    codes.core.push(String(c.errorCode) + '/' + String(c.materialChars));
    const p = rr.sandbox.ClinicalContext.build('supervision-multi-school', {}, { inputText: input, system: 'sys' });
    codes.page.push(String(p.errorCode) + '/' + String(p.estimatedChars));
  }
  Object.keys(codes).forEach(function (k) {
    expect(new Set(codes[k]).size === 1, 'A5 ' + k + ' 入口重复调用决策/码不一致：' + JSON.stringify(codes[k]));
  });
  return { codes: codes, wireOfRawAt240k: wireOfRaw, wireAtPublishedEquivalent: sentWire, rawEquivalent: rawEquiv };
}

/* ============================ A6. 脱敏幂等（唯一口径的前提） ============================ */
async function caseA6() {
  const realm = createRealm();
  const guard = realm.sandbox.AI.budgetGuard;
  const San = realm.sandbox.XJPIISanitizer;
  function wire(text) {
    const r = San.sanitizeMessages([{ role: 'user', content: text }]);
    if (!r || !r.ok) throw new Error('sanitize refused: ' + JSON.stringify(r && r.code));
    return String(r.messages[0].content || '');
  }
  const corpora = {
    realistic: realisticCorpus(24000), midDense: midDenseCorpus(24000),
    adversarial: adversarialCorpus(24000), shrinking: shrinkingCorpus(3000), neutral: material(24000),
  };
  const rows = [];
  Object.keys(corpora).forEach(function (k) {
    const t = corpora[k];
    const a = wire(t);
    const b = wire(a);
    const projected = guard.outboundChars([{ role: 'user', content: t }]);
    expect(a === b, k + '：脱敏不幂等（wire(wire(x)) !== wire(x)）⇒「判定读一次即真」与出站投影缓存的前提不成立');
    expect(projected === a.length, k + '：唯一权威出站读数应等于真实脱敏结果长度 ' + a.length + '，实测 ' + projected);
    rows.push({ corpus: k, before: t.length, after: a.length, ratio: +(a.length / t.length).toFixed(4) });
  });
  OBSERVED.idempotency = rows;
  return rows;
}

/* ============================ B. 正常材料不误拒 ============================ */
function SY_CAP_OF(realm) { return realm.sandbox.SupervisionSyndicate.MAX_STAGE_INPUT_CHARS; }
async function caseB() {
  const lengths = [12000, 16000, 20000, 23940, 23964, 24000];
  const ratios = [1.0, 1.4, 1.7, 2.0, 3.0, 4.0];
  const runs = [];
  for (const chars of lengths) {
    const realm = createRealm();
    const res = await realm.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
      material: realisticCorpus(chars), schools: ['sup-winnicott', 'sup-klein'],
    }, {});
    expect(res.ok === true, chars + ' 字符 realistic 页面合法材料被误拒：' + JSON.stringify({ ec: res.errorCode, stage: res.stage, err: res.error }));
    expect((res.totalSegments || 0) >= 2, chars + ' 字符应走分段分支（DEC-01），实测 totalSegments=' + res.totalSegments);
    runs.push({ chars: chars, ok: res.ok, totalSegments: res.totalSegments, calls: realm.sends.length, summaryChars: String(res.summary || '').length });
  }
  const sweep = [];
  for (const ratio of ratios) {
    const realm = createRealm({ charsPerToken: ratio });
    const res = await realm.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
      material: realisticCorpus(23940), schools: ['sup-winnicott', 'sup-klein', 'sup-bion'],
    }, {});
    expect(res.errorCode !== 'STAGE_BUDGET_EXCEEDED',
      'charsPerToken=' + ratio + '：契约内长摘要被阶段闸门硬拒（F5-B 未修）' + JSON.stringify({ ec: res.errorCode, stage: res.stage }));
    expect(res.ok === true, 'charsPerToken=' + ratio + ' 整条管线未跑通：' + JSON.stringify({ ec: res.errorCode, stage: res.stage, err: res.error }));
    const maxComposed = realm.sends.reduce(function (m, s) { return Math.max(m, s.composedChars); }, 0);
    sweep.push({ charsPerToken: ratio, calls: realm.sends.length, maxStageComposedChars: maxComposed, summaryChars: String(res.summary || '').length, ok: res.ok });
  }
  OBSERVED.noFalseRejection = { runs: runs, sweep: sweep };

  /* B3 高密度 PII 材料（实测脱敏扩写 ×1.93 / ×2.0）同样不得被阶段闸门误拒：
   * 阶段闸门的判定口径是「组装后字符数」（DEC-01 冻结的口径），压低两处 clip 之后
   * 最坏组装后 19,089 <= 30,000 ⇒ 密度只改变真实出站字符数，不改变是否放行。
   * 反向变异 E8（把闸门改成按出站口径判）正是打在这一条上 —— 它会误拒页面合法材料。
   * 同时断言安全边界：任何密度下每个阶段的真实出站都不得超过总闸（网络侧唯一硬封顶）。 */
  const dense = [];
  for (const kind of ['midDense', 'adversarial']) {
    const gen = kind === 'midDense' ? midDenseCorpus : adversarialCorpus;
    const dr = createRealm({ charsPerToken: 1.7 });
    const dres = await dr.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
      material: gen(23940), schools: ['sup-winnicott', 'sup-klein'],
    }, {});
    expect(dres.errorCode !== 'STAGE_BUDGET_EXCEEDED', kind + ' 高密度页面合法材料被阶段闸门误拒（新造 F5-B 类缺陷）：'
      + JSON.stringify({ ec: dres.errorCode, stage: dres.stage }));
    expect(dres.ok === true, kind + ' 高密度页面合法材料未跑通：' + JSON.stringify({ ec: dres.errorCode, stage: dres.stage }));
    const rows = dr.sends.map(function (s) {
      return { stage: s.stage, wireChars: s.composedChars, projected: dr.sandbox.AI.budgetGuard.outboundChars(s.messages) };
    });
    const maxWire = rows.reduce(function (m, r) { return Math.max(m, r.wireChars); }, 0);
    rows.forEach(function (r) {
      /* 唯一权威度量 == 真正上路的那份载荷（F5-C 的要害：判的数与发的数必须是同一个数） */
      expect(r.projected === r.wireChars, kind + '/' + r.stage + '：权威出站读数与 bridge 实收字符数不一致：'
        + r.projected + ' vs ' + r.wireChars);
    });
    expect(maxWire <= dr.sandbox.AI.budgetGuard.limitChars,
      kind + '：真实出站越过总闸（安全边界）：' + maxWire + ' > ' + dr.sandbox.AI.budgetGuard.limitChars);
    dense.push({ kind: kind, ok: dres.ok, calls: dr.sends.length, maxStageWireChars: maxWire, withinStageBudget: maxWire <= SY_CAP_OF(dr) });
  }
  OBSERVED.highDensityRuns = dense;
  return OBSERVED.noFalseRejection;
}

/* ============================ C. F5-B 算术自证（真实 builder 实测） ============================ */
async function caseC() {
  const realm = createRealm();
  const api = realm.sandbox.SupervisionSyndicate;
  const guard = realm.sandbox.AI.budgetGuard;
  const S = api.MAX_STAGE_SUMMARY_CHARS;
  const M = api.MAX_STAGE_MATERIAL_CHARS;
  const CAP = api.MAX_STAGE_INPUT_CHARS;
  const OLD_SUMMARY_CLIP = 24000;
  const OLD_SCHOOL_MATERIAL_CLIP = 16000;
  expect(S < OLD_SUMMARY_CLIP, 'C0 裁决① 要求压低摘要拼接上限（原 ' + OLD_SUMMARY_CLIP + '），实测 ' + S);
  expect(M < OLD_SCHOOL_MATERIAL_CLIP, 'C0 裁决① 要求压低学派材料节选上限（原 ' + OLD_SCHOOL_MATERIAL_CLIP + '），实测 ' + M);
  const cards = api.CARDS.filter(function (c) { return c.role === 'school'; });
  expect(cards.length >= 7, 'C0 学派卡应至少 7 张，实测 ' + cards.length);
  const realistic = realisticCorpus(24000);   // 页面准入上限的合法材料（比任何 clip 常数都长 ⇒ clip 必须生效）
  const fullSummary = summaryText(S);          // 摘要槽位：preprocess 裁剪后的长度上界（由 C4 真实管线实测确认）
  expect(fullSummary.length === S, 'C1 前提：摘要槽位必须填到裁剪上限 ' + S + '，实测 ' + fullSummary.length);
  const ROUTE = { case_type: '依恋创伤', focus: '设置' };
  const rows = [];
  cards.forEach(function (card) {
    const analyses = cards.slice(0, api.MAX_SCHOOLS).map(function (c) {
      return { name: c.name, key: c.key, status: 'ok', content: summaryText(api.MAX_SCHOOL_ANALYSIS_CHARS) };
    });
    const rowsChars = analyses.reduce(function (n, a) { return n + a.content.length + String(a.name).length + 8; }, 0);
    /* 同一阶段做两份：材料槽位空 / 材料槽位喂页面准入上限。差值就是「builder 自己裁剪后
     * 真正上路的材料字符数」—— 测的是产品常数生效后的结果，不是把常数抄进测试。 */
    const stages = {
      school: [api.buildSchoolPrompt(card, '', fullSummary, '甲、乙、丙', {}),
        api.buildSchoolPrompt(card, realistic, fullSummary, '甲、乙、丙', {})],
      route: [api.buildLeadPrompt('', fullSummary), api.buildLeadPrompt(realistic, fullSummary)],
      synthesis: [api.buildSynthesisPrompt('', fullSummary, ROUTE, []),
        api.buildSynthesisPrompt(realistic, fullSummary, ROUTE, analyses)],
    };
    Object.keys(stages).forEach(function (stage) {
      const base = api.measureStagePrompt(stages[stage][0], {});
      const full = api.measureStagePrompt(stages[stage][1], {});
      const materialSlot = full.composedChars - base.composedChars - (stage === 'synthesis' ? rowsChars : 0);
      const fixed = base.composedChars - fullSummary.length;
      expect(materialSlot > 0, 'C1 ' + card.key + '/' + stage + '：材料槽位差值必须为正，实测 ' + materialSlot);
      expect(materialSlot <= M + 1, 'C2 材料节选未被裁剪到新常数 ' + M + '（+' + '…' + '）：实测槽位 '
        + materialSlot + '（clip 常数被回退或未生效）');
      expect(fixed > 0, 'C1 固定开销必须是正数（探针形状不成立？）：' + fixed);
      expect(full.outboundChars > full.composedChars, 'C1 前提：realistic 材料必须体现脱敏扩写方向，实测 '
        + full.outboundChars + ' vs ' + full.composedChars);
      expect(full.composedChars <= CAP,
        'C2-组装 ' + card.key + '/' + stage + '：组合后提示词 ' + full.composedChars + ' > 阶段预算 ' + CAP
        + '（产品自己的常数不自洽，F5-B：页面合法材料可被硬拒）');
      expect(full.outboundChars <= CAP,
        'C2-出站 ' + card.key + '/' + stage + '：真实出站 ' + full.outboundChars + ' > 阶段预算 ' + CAP
        + '（F5-C「声明的量不封顶实际」未消除）');
      expect((S + 1) + (M + 1) + fixed <= CAP, 'C2 算术 ' + card.key + '/' + stage + '：max(summaryClip) + max(materialClip)'
        + ' + 实测最坏固定开销 = ' + ((S + 1) + (M + 1) + fixed) + ' 必须 <= ' + CAP);
      rows.push({
        card: card.key, stage: stage, materialSlot: materialSlot, summarySlot: fullSummary.length,
        composedChars: full.composedChars, outboundChars: full.outboundChars, fixedOverhead: fixed,
        wireOverhead: full.outboundChars - guard.outboundChars([{ role: 'user', content: fullSummary }]) - guard.outboundChars([{ role: 'user', content: realistic.slice(0, materialSlot) }]),
        basis: full.basis,
      });
    });
  });
  const maxComposed = Math.max.apply(null, rows.map(function (r) { return r.composedChars; }));
  const maxOutbound = Math.max.apply(null, rows.map(function (r) { return r.outboundChars; }));
  const maxFixed = Math.max.apply(null, rows.map(function (r) { return r.fixedOverhead; }));
  const expansion = +(guard.outboundChars([{ role: 'user', content: realistic }]) / realistic.length).toFixed(4);
  OBSERVED.arithmetic = {
    stageBudget: CAP, summaryClip: S, materialClip: M, maxFixedOverhead: maxFixed,
    inequalityComposed: (S + 1) + ' + ' + (M + 1) + ' + ' + maxFixed + ' = ' + (S + M + 2 + maxFixed) + ' <= ' + CAP,
    worstComposed: maxComposed, worstOutbound: maxOutbound, realisticExpansionFactor: expansion,
    headroomComposed: CAP - maxComposed, headroomOutbound: CAP - maxOutbound,
    basisSeen: Array.from(new Set(rows.map(function (r) { return r.basis; }))),
    rows: rows,
  };
  expect(S + M + 2 + maxFixed <= CAP, 'C2 算术自证：max(summaryClip) + max(materialClip) + 实测最坏固定开销 = '
    + (S + M + 2 + maxFixed) + ' 必须 <= ' + CAP);
  expect(maxOutbound <= CAP, 'C2 最坏真实出站 ' + maxOutbound + ' 必须 <= 阶段预算 ' + CAP);
  expect(OBSERVED.arithmetic.basisSeen.length === 1 && OBSERVED.arithmetic.basisSeen[0] === guard.metric,
    'C2 阶段测量必须走唯一权威口径，实测 basis=' + JSON.stringify(OBSERVED.arithmetic.basisSeen));

  /* C3 阳性对照：旧常数在同一把尺下必然越界 ⇒ C2 可能为假，不是恒真 */
  const oldPrompt = api.buildSchoolPrompt(cards[0], realistic.slice(0, OLD_SCHOOL_MATERIAL_CLIP), summaryText(OLD_SUMMARY_CLIP), '甲、乙、丙', {});
  const oldMeasured = api.measureStagePrompt(oldPrompt, {});
  expect(oldMeasured.composedChars > CAP,
    'C3 阳性对照失效：旧常数组合 ' + oldMeasured.composedChars + ' 竟未越过 ' + CAP + ' ⇒ C2 是恒真断言');
  OBSERVED.positiveControl = { oldComposed: oldMeasured.composedChars, oldOutbound: oldMeasured.outboundChars, oldConstants: OLD_SUMMARY_CLIP + '+' + OLD_SCHOOL_MATERIAL_CLIP, stageBudget: CAP };

  /* C4 摘要裁剪确实发生（分段路径），否则「压低 clip」是空话 */
  const clipRealm = createRealm({ charsPerToken: 4.0 });
  const clipped = await clipRealm.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
    material: realisticCorpus(23940), schools: ['sup-winnicott'],
  }, {});
  const summaryLen = String(clipped.summary || '').length;
  expect(clipped.ok === true, 'C4 前提：长摘要契约内管线必须跑通，实测 ' + JSON.stringify({ ec: clipped.errorCode, stage: clipped.stage }));
  expect(summaryLen <= S + 1, 'C4 分段摘要未被裁剪到上限：实测 ' + summaryLen + ' > ' + (S + 1));
  expect(/\.\.\.|…/.test(String(clipped.summary || '').slice(-2)) === false || summaryLen === S + 1,
    'C4 裁剪必须留下可视标记（不得静默）：尾部=' + JSON.stringify(String(clipped.summary || '').slice(-2)));
  OBSERVED.summaryClipEvidence = { summaryChars: summaryLen, cap: S, clippedToCap: summaryLen === S + 1 };

  /* C5 密度边界如实登记（F5-C 的诚实边界）：更高密度语料下阶段「真实出站」会越过阶段预算，
   * 因为阶段闸门的量纲是组装后字符数（DEC-01 冻结，且改成出站口径会误拒页面合法材料，
   * 见变异 E8）。这一条不断言 ≤ 阶段预算，只断言**永不越总闸**（网络侧唯一硬封顶）。 */
  const densities = {
    realisticSummary: realisticCorpus(S), pathologicalSummary: rep('来访者描述在会议中担心被评价，咨询师使用反映性倾听。', S),
  };
  const densityMaterials = {
    realistic: realistic.slice(0, M), midDense: midDenseCorpus(M), adversarial: adversarialCorpus(M),
  };
  const boundary = [];
  Object.keys(densityMaterials).forEach(function (mk) {
    Object.keys(densities).forEach(function (sk) {
      const prompt = api.buildSchoolPrompt(cards[0], densityMaterials[mk], densities[sk], '甲、乙、丙', {});
      const m = api.measureStagePrompt(prompt, {});
      boundary.push({
        material: mk, summary: sk, composed: m.composedChars, outbound: m.outboundChars,
        ratio: +(m.outboundChars / m.composedChars).toFixed(4), stageBudget: CAP, totalGate: guard.limitChars,
        outboundWithinStageBudget: m.outboundChars <= CAP, outboundWithinTotalGate: m.outboundChars <= guard.limitChars,
      });
    });
  });
  boundary.forEach(function (b) {
    expect(b.outboundWithinTotalGate, 'C5 安全性底线被破：某密度下阶段真实出站 ' + b.outbound + ' 越过总闸 '
      + guard.limitChars + '（' + JSON.stringify(b) + '）');
    expect(b.composed <= CAP, 'C5 前提：受控槽位在任何密度下组装后都必须 ≤ 阶段预算（clip 生效），实测 ' + b.composed);
  });
  OBSERVED.densityBoundary = boundary;
  return OBSERVED.arithmetic;
}

/* ============================ D. F5-C：口径回报 + 闸门仍然活着 ============================ */
async function caseD() {
  const realm = createRealm({ charsPerToken: 2.0 });
  const SY = realm.sandbox.SupervisionSyndicate;
  const guard = realm.sandbox.AI.budgetGuard;
  const cap = SY.MAX_STAGE_INPUT_CHARS;
  const res = await realm.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
    material: realisticCorpus(23940), schools: ['sup-winnicott', 'sup-klein'],
  }, {});
  expect(res.ok === true, 'D1 前提：realistic 23,940 管线必须跑通，实测 ' + JSON.stringify({ ec: res.errorCode, stage: res.stage }));
  const stageRows = realm.sends.map(function (s) {
    const projected = guard.outboundChars(s.messages);
    expect(projected === s.composedChars, 'D1 前提：唯一权威出站读数必须等于 bridge 实收字符数（阶段 ' + s.stage + '）：'
      + projected + ' vs ' + s.composedChars);
    return { stage: s.stage, composed: s.composedChars, outbound: projected };
  });
  const breaching = stageRows.filter(function (r) { return r.outbound > cap; });
  expect(breaching.length === 0, 'D1 有阶段真实出站越过自己声明的预算（F5-C）：' + JSON.stringify(breaching));
  OBSERVED.perStageOutbound = stageRows;

  /* D2/D3 阶段闸门活性：模板超限 → 该阶段 0 出网、终态带 STAGE_BUDGET_EXCEEDED、不截断。
   * 注入面与真实页面 D-1 同一处（options.mastersCore.buildRoundSystemPrompt），
   * callMaster 委托回真实出口 AI.send，所以非超预算阶段照常出网、可数。 */
  const giant = rep('督导模板段：只能依据提供的材料。', 40000);
  const r2 = createRealm();
  let schoolSawNetwork = false;
  const AI2 = r2.sandbox.AI;
  const stubCore = {
    buildRoundSystemPrompt: function () { return giant; },
    callMaster: function (conv, card, user, o) {
      if (card && card.role === 'school') schoolSawNetwork = true;
      return AI2.send([{ role: 'system', content: (o && o.systemPrompt) || '' }, { role: 'user', content: user }],
        undefined, { signal: o && o.signal });
    },
  };
  const verdict = await r2.sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
    material: realisticCorpus(12000), schools: ['sup-winnicott'],
  }, { mastersCore: stubCore });
  expect(verdict.ok === false && verdict.errorCode === 'STAGE_BUDGET_EXCEEDED',
    'D2 模板超预算必须被阶段闸门挡下并带稳定码，实测 ' + JSON.stringify({
      ok: verdict.ok, ec: verdict.errorCode, stage: verdict.stage, err: String(verdict.error).slice(0, 160),
      sends: r2.sends.map(function (s) { return s.stage; }),
    }));
  expect(!schoolSawNetwork, 'D2 超预算的学派阶段竟然出网了');
  expect(verdict.truncated !== true, 'D2 不得把超限改写成截断继续');
  const absent = (verdict.analyses || []).filter(function (a) { return a.status === 'absent'; })[0] || {};
  const text = String(absent.error || verdict.error || '');
  expect(/量纲=composed-prompt-chars/.test(text), 'D3 拒绝文案必须写明量纲（F5-C 收口），实测 ' + text.slice(0, 90));
  expect(/实际出站 \d+ 字符/.test(text), 'D3 拒绝文案必须同时报出真实出站字符数，实测 ' + text.slice(0, 140));
  const quoted = /组装后提示词 (\d+) 字符/.exec(text);
  const quotedWire = /实际出站 (\d+) 字符/.exec(text);
  expect(quoted && Number(quoted[1]) > cap, 'D3 文案里的组装后字符数应是真实测量值，实测 ' + (quoted && quoted[1]));
  expect(quotedWire && Number(quotedWire[1]) > Number(quoted[1]),
    'D3 真实出站应大于组装后（realistic 扩写方向），实测 ' + (quotedWire && quotedWire[1]) + ' vs ' + (quoted && quoted[1]));
  OBSERVED.liveness = {
    giantSystemChars: giant.length, verdictCode: verdict.errorCode, verdictStage: verdict.stage,
    sendsBeforeReject: r2.sends.map(function (s) { return s.stage; }), message: text.slice(0, 240),
  };
  return OBSERVED.liveness;
}

/* ---------------- 反向变异 ---------------- */
function mutate(file, find, replace) {
  const src = readProduct(file);
  const parts = src.split(find);
  if (parts.length !== 2) throw new Error('MUTATION ANCHOR count=' + (parts.length - 1) + ' in ' + file + ' :: ' + find.slice(0, 70));
  const out = parts.join(replace);
  if (out === src) throw new Error('MUTATION DID NOT APPLY (no byte change): ' + file);
  return { file: file, source: out };
}
function materialise(mut) {
  const built = mut.build();
  ensureDir(path.join(MUTANT_DIR, mut.id));
  fs.writeFileSync(path.join(MUTANT_DIR, mut.id, built.file), built.source, 'utf8');
  const overrides = {};
  overrides[built.file] = built.source;
  return overrides;
}
function killCheck(saved) {
  const rows = RESULTS.slice(saved);
  const red = rows.filter(function (r) { return !r.ok; });
  if (!red.length) throw new Error('变异未被检出：受影响用例仍全绿（断言可能恒真）');
  return { red: red.length, assertions: rows.length, first: red[0] };
}

const MUTANTS = [
  {
    id: 'E1-restore-old-summary-clip', cases: [caseC],
    title: '恢复旧 clip：分段摘要拼接上限回到 24000（裁决① 回退）',
    build: function () { return mutate('supervision-syndicate.js', 'summary = clip(summary, MAX_STAGE_SUMMARY_CHARS);', 'summary = clip(summary, 24000); /* MUTANT E1 */'); },
    why: 'C0/C2 红：摘要 24,000 + 材料节选组合后必然越过 30,000 阶段预算',
  },
  {
    id: 'E2-restore-old-school-material-clip', cases: [caseC],
    title: '恢复旧 clip：学派阶段材料节选回到 16000',
    build: function () { return mutate('supervision-syndicate.js', "【当前材料】\\n' + clip(material, MAX_STAGE_MATERIAL_CHARS)", "【当前材料】\\n' + clip(material, 16000) /* MUTANT E2 */"); },
    why: 'C2-组装/出站 红（摘要 8,001 + 材料 16,001 + 模板 > 30,000）',
  },
  {
    id: 'E3-egress-gate-back-to-pre-sanitisation', cases: [caseA, caseC],
    title: '把出口闸门的判定挪回脱敏前（读组装后字符数，公布值不变）',
    build: function () { return mutate('ai.js', '  function measureInputChars(messages) {\n    return measureOutboundProjection(messages).chars;\n  }',
      '  function measureInputChars(messages) {\n    return measureComposedChars(messages); /* MUTANT E3 */\n  }'); },
    why: 'A1 红（realistic 240,000 被放行 ⇒ 真实出站 330,389 出网，F5-A 原状）+ C2-出站红',
  },
  {
    id: 'E4-relax-stage-budget', cases: [caseA, caseC],
    title: '放宽阶段预算 30000 -> 36000（DEC-01 明令禁止：让 clip 自证「通过」的作弊路径）',
    build: function () { return mutate('supervision-syndicate.js', '  var MAX_STAGE_INPUT_CHARS = 30000;', '  var MAX_STAGE_INPUT_CHARS = 36000; /* MUTANT E4 */'); },
    why: 'A0 常量断言红（公布/冻结值漂移）',
  },
  {
    id: 'E5-oversize-silently-truncated', cases: [caseA, caseB],
    title: '超限不再拒绝，改成静默截断后继续发（违反 F5 目标 1，也是裁决①明令禁止的糊法）',
    build: function () { return mutate('ai.js', '    if (totalChars <= MAX_TOTAL_INPUT_CHARS) return null;',
      '    if (totalChars <= MAX_TOTAL_INPUT_CHARS) return null;\n    for (let ti = 0; ti < messages.length; ti += 1) { messages[ti] = { role: messages[ti].role, content: String(messages[ti].content || "").slice(0, MAX_TOTAL_INPUT_CHARS) }; }\n    return null; /* MUTANT E5: 超限就地截断后继续，不拒 */'); },
    why: 'A1/A2/A5 红：超限载荷被截断后真的出网（provider 调用 1 次）、稳定 errorCode 消失；B 组红在长材料被悄悄截短',
  },
  {
    id: 'E6-budget-code-renamed', cases: [caseA],
    title: '换码名：MATERIAL_TOO_LONG -> MATERIAL_OVER_LIMIT（新造同义码）',
    build: function () { return mutate('ai.js', "const BUDGET_ERROR_CODE = 'MATERIAL_TOO_LONG';", "const BUDGET_ERROR_CODE = 'MATERIAL_OVER_LIMIT'; /* MUTANT E6 */"); },
    why: 'A0/A1/A3/A4/A5 红：三入口不再同一张码表（页面读的就是这一处）',
  },
  {
    id: 'E7-stage-measures-its-own-length', cases: [caseC, caseD],
    title: '阶段闸门不再走唯一权威度量（本模块另抄一份长度算法）',
    build: function () { return mutate('supervision-syndicate.js', '  function budgetAuthority(options) {\n    var explicit = options && options.budgetGuard;',
      '  function budgetAuthority(options) {\n    return null; /* MUTANT E7 */\n    var explicit = options && options.budgetGuard;'); },
    why: 'C2 的 basis 断言红（退化成 no-egress-module）+ D3 文案「实际出站」数字与组装数相同',
  },
  {
    id: 'E8-stage-gate-judges-outbound', cases: [caseB],
    title: '把阶段闸门的判定口径挪到出站字符数（新造 F5-B 类误拒）',
    build: function () { return mutate('supervision-syndicate.js', '    if (stageInput.composedChars > MAX_STAGE_INPUT_CHARS) return Promise.resolve({',
      '    if (stageInput.outboundChars > MAX_STAGE_INPUT_CHARS) return Promise.resolve({ /* MUTANT E8 */'); },
    why: 'B 组红：realistic 长材料在分段/学派阶段被自己的闸门硬拒',
  },
  {
    id: 'E9-raw-equivalent-not-converted', cases: [caseA],
    title: '对外公布的原始材料等效上限不做扩写换算（直接等于出站上限）',
    build: function () { return mutate('ai.js', 'const RAW_MATERIAL_BUDGET_CHARS = Math.floor(MAX_TOTAL_INPUT_CHARS / SANITISATION_EXPANSION_FACTOR);',
      'const RAW_MATERIAL_BUDGET_CHARS = MAX_TOTAL_INPUT_CHARS; /* MUTANT E9 */'); },
    why: 'A2 红：承诺「可粘贴 240,000 原始字符」而实测被拒 ⇒ 判定与对外承诺又不同口径',
  },
];

/* ---------------- main ---------------- */
async function main() {
  ensureDir(OUT); ensureDir(PAYLOAD_DIR);
  const subjects = {};
  ['ai.js', 'supervision-syndicate.js', 'clinical-context.js', 'pii-sanitizer.js', 'store.js'].forEach(function (f) {
    subjects['app/js/' + f] = md5(fs.readFileSync(path.join(APP, f)));
  });
  subjects['main.js'] = md5(fs.readFileSync(path.join(ROOT, 'main.js')));
  OBSERVED.subjectMd5 = subjects;

  if (MUTATION_MODE) {
    const rows = [];
    for (const m of MUTANTS) {
      let overrides = null; let invalid = null;
      try { overrides = materialise(m); } catch (e) { invalid = String((e && e.message) || e); }
      if (invalid) { rows.push({ id: m.id, title: m.title, killed: false, invalid: invalid }); process.stdout.write('INVALID   ' + m.id + ' — ' + invalid + '\n'); continue; }
      const before = RESULTS.length;
      let survivor = null;
      try {
        await runWithOverrides(overrides, async function () {
          for (const fn of m.cases) await assertCase('MUTANT ' + m.id, fn.name, fn);
        });
      } catch (e) { survivor = 'harness threw: ' + String((e && e.message) || e); }
      let check = null; let checkErr = null;
      try { check = killCheck(before); } catch (e) { checkErr = String((e && e.message) || e); }
      const red = RESULTS.slice(before).filter(function (r) { return !r.ok; });
      const killed = !checkErr && red.length > 0;
      rows.push({
        id: m.id, title: m.title, why: m.why, killed: killed, mutantFile: path.join('mutants', m.id, overrides ? Object.keys(overrides)[0] : ''),
        redCount: red.length, assertionCount: RESULTS.length - before,
        red: red.map(function (r) { return { group: r.group, name: r.name, failure: r.failure }; }),
        harnessError: survivor, invalidCheck: checkErr,
      });
      process.stdout.write((killed ? 'KILLED   ' : 'SURVIVED ') + m.id + ' — ' + m.title + '\n');
      if (killed) process.stdout.write('  红在哪句: [' + check.first.group + '] ' + check.first.name + '\n    -> ' + check.first.failure + '\n');
      else process.stdout.write('  ' + (checkErr || survivor || 'no red') + '\n');
      RESULTS.length = before; /* 变异跑批不混进基线证据件 */
      SUBS.length = 0;
    }
    ensureDir(OUT);
    const survivors = rows.filter(function (r) { return !r.killed; });
    fs.writeFileSync(path.join(OUT, 'budget-mutation-evidence.json'), JSON.stringify({ at: new Date().toISOString(), subjectMd5: subjects, rows: rows }, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT, 'budget-mutations.log'), rows.map(function (r) {
      return (r.killed ? 'KILLED   ' : 'SURVIVED ') + r.id + ' — ' + r.title + '\n  为什么要红: ' + (r.why || '')
        + '\n  红在哪句: ' + JSON.stringify((r.red || []).slice(0, 2).map(function (x) { return x.group + ' / ' + x.name + ' -> ' + x.failure; })) + '\n';
    }).join('\n') + '\nMUTATIONS: total=' + rows.length + ' survivors=' + survivors.length + '\n', 'utf8');
    console.log('MUTATIONS: total=' + rows.length + ' survivors=' + survivors.length);
    if (survivors.length) process.exitCode = 1;
    return;
  }

  await assertCase('A-one-metric-three-entries', 'A0-A5 三入口同一度量 / 同一码 / 0 出网 / 重复一致', caseA);
  await assertCase('A6-sanitiser-idempotent', 'A6 脱敏幂等 + 权威读数与真实脱敏一致（5 份语料）', caseA6);
  await assertCase('B-no-false-rejection', 'B1-B2 页面合法 12,000..24,000 realistic 材料与契约内长摘要全部跑通', caseB);
  await assertCase('C-stage-budget-arithmetic', 'C0-C4 裁决① 算术自证（真实 builder 实测；两口径逐卡逐阶段 + 旧常数阳性对照）', caseC);
  await assertCase('D-stage-gate-basis-and-liveness', 'D1-D3 每阶段真实出站 ≤ 预算 + 阶段闸门仍然活着（超限拒发、写明量纲）', caseD);

  const red = RESULTS.filter(function (r) { return !r.ok; });
  const subTotal = SUBS.length;
  const subRed = SUBS.filter(function (s) { return !s.ok; }).length;
  const evidence = {
    at: new Date().toISOString(), mode: 'cases', subjectMd5: subjects, observed: OBSERVED,
    results: RESULTS,
    summary: {
      groups: RESULTS.length, groupsPass: RESULTS.length - red.length, groupsRed: red.length,
      subChecks: subTotal, subChecksRed: subRed,
    },
  };
  fs.writeFileSync(path.join(OUT, 'budget-consistency-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, 'budget-consistency.log'),
    RESULTS.map(function (r) {
      return (r.ok ? 'PASS  ' : 'RED   ') + '[' + r.group + '] ' + r.name + '  (子断言 ' + (r.subChecks || []).length + ' 条)'
        + (r.failure ? '\n  -> ' + r.failure : '');
    }).join('\n')
    + '\n\n---- 子断言逐条（PASS/RED + 判据原文）----\n'
    + SUBS.map(function (s) { return (s.ok ? '  ok   ' : '  RED  ') + s.assert.slice(0, 300); }).join('\n')
    + '\n\nCASES: total=' + evidence.summary.groups + ' pass=' + evidence.summary.groupsPass + ' red=' + red.length
    + '\nSUB-CHECKS: total=' + subTotal + ' red=' + subRed + '\n', 'utf8');
  RESULTS.forEach(function (r) { console.log((r.ok ? 'PASS  ' : 'RED   ') + '[' + r.group + '] ' + r.name + (r.failure ? ' -> ' + r.failure : '')); });
  console.log('\nCASES: total=' + evidence.summary.groups + ' pass=' + evidence.summary.groupsPass + ' red=' + red.length);
  console.log('SUB-CHECKS: total=' + subTotal + ' red=' + subRed);
  console.log('evidence: ' + path.join(OUT, 'budget-consistency-evidence.json'));
  if (red.length || subRed) process.exitCode = 1;
}

main().catch(function (e) { console.error('FATAL', (e && e.stack) || e); process.exitCode = 2; });
