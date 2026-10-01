'use strict';
/* ============================================================
 * scripts/f3-payload-hygiene.test.cjs — DEC-03 载荷净化 + F3-P1-1 枚举派生 回归锁
 *
 * 锁住两件事（两者都必须「可能为假」）：
 *  (a) 逐位大师：**真实发往模型的 system 载荷**里零命中复审 r3 的人设标记
 *      （## 角色扮演规则 / 此Skill激活后，直接以X的身份回应 / 你不是在扮演X…被植入了X认知上下文的AI /
 *        而非跳出角色说 / 第一人称生平句 / 你必须遵守以下身份规则），
 *      同时临床方法论正文仍在（不是「全删了就绿了」），且 Knowledge.byTemp / slotsOf 各槽可用。
 *  (b) 工具入口枚举 == MASTERS.map(m => m.key)（集合相等，含 horney），
 *      并且 horney 真能通过 agent-core 的真实参数校验 + 真开出一个会话。
 *  (c) 反向变异 5 条（关掉净化 / 规则过宽吞方法论 / 派生结果剔掉 horney /
 *      枚举退回手写 11 项 / 关掉「禁止脏载荷写生产路径」的闸门）——每条必须转红。
 *
 * 取证纪律：载荷级断言打在 MastersCore 真正拼出来的 system 文本上（buildOneToOneSystemPrompt /
 * buildRoundSystemPrompt），不用「源码里存在该字符串」替代。全部合成数据、桩 transport，
 * 不触达任何真实供应商。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const LOGDIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f3-payload-evidence-'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------- 复审 r3 p4-f3-payload.cjs 的同一批人设标记（断言目标，逐字对齐） ---------- */
const PERSONA_MARKERS = {
  'roleplay-rules-heading': /##\s*角色扮演规则/,
  'adopt-identity-imperative': /直接以[^，。\n]{0,12}的身份回应|此Skill激活后/,
  'not-pretending-identity': /[你我]不是在扮演[^\n]{0,60}/,
  'implanted-context-AI': /被植入了?[^。\n]{0,24}认知上下文/,
  'first-person-bio': /我父亲是|我小时候|我在(19|20)\d\d|我看过很多这样的婴儿|我记得一个孩子/,
  'forbidden-to-step-out': /而非跳出角色说/,
  'must-obey-identity-rules': /你必须遵守以下身份规则/,
};
/* 临床方法论侧的「不许被误删」判据（与净化规则的保护名单同源，语义不同层） */
const METHODOLOGY_MARKERS = /核心心智模型|心智模型|方法单元|决策启发式|回答工作流|Agentic Protocol|诚实边界|价值观与反模式|核心概念清单|概念清单|表达\s*DNA|三重验证|整书骨架|督导特色|核心视角|思维架构/;

function makeAtob() {
  return function atob(b64) {
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64').toString('binary');
  };
}

/* opts.patch: { 'app/js/agent-tools.js': src => newSrc } —— 变异用
 * opts.knowledgeSource: 直接给定 knowledge.builtins.js 的**文本**（变异体用生成器重跑得到）
 * opts.governance: 'real' 用树内真 prompt-governance.js；'double' 用格式一致的替身
 *   （prompt-governance.js 正被另一代理并发修改，属其写集；本卡不依赖其语义，只借它的
 *    `[label | source=… | sha256=…]` 合并头，故两者都跑、以 double 为保底，实际用了哪个会打印。） */
function makeSandbox(opts) {
  const o = opts || {};
  const patches = o.patch || {};
  const sent = [];
  const convs = [];
  const store = Object.create(null);
  const ctx = {
    console, Buffer, atob: makeAtob(), TextDecoder: require('util').TextDecoder,
    setTimeout, clearTimeout, queueMicrotask, setImmediate,
    Promise, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect, URL, Intl,
    Object, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError, SyntaxError,
    Math, JSON, Date, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, escape, unescape,
    sent,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  ctx.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
    head: { appendChild() {} }, documentElement: { style: {}, setAttribute() {} },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
    addEventListener() {}, removeEventListener() {}, createTextNode: () => ({}),
  };
  ctx.AI = {
    send(messages, cb, options) {
      sent.push({ messages, options: options === undefined ? null : options });
      if (typeof cb === 'function') cb({ content: 'STUB-REPLY', error: null });
    },
  };
  ctx.Store = {
    getSettings: () => ({}),
    getMasterConversations: () => convs,                       // 产品侧是同步读（masters-core.js:212）
    saveMasterConversationDurable: async (c) => {
      if (!c) return { ok: false };
      if (!convs.some((x) => x.id === c.id)) convs.push(c);
      return { ok: true };
    },
    getClients: async () => [], getSessions: async () => [],
  };
  ctx.PromptsBuiltin = { STYLE_CONSTRAINTS: '' };
  ctx.PersonaPreamble = { build: () => '' };
  ctx.UserDocs = { getContextBlock: () => 'USERDOC-MARKER' };

  vm.createContext(ctx);
  function load(rel, srcOverride) {
    let src = srcOverride !== undefined ? srcOverride : read(rel);
    const p = patches[rel];
    if (p) src = p(src);
    vm.runInContext(src, ctx, { filename: rel });
    return src;
  }
  let governanceMode = 'double';
  if (o.governance === 'real') {
    try {
      load('app/js/prompt-governance.js');
      vm.runInContext('globalThis.PromptGovernance = PromptGovernance;', ctx);
      ctx.PromptGovernance.mergeKnowledgeSources([{ label: 'x', source: 'y', content: 'z' }]);
      governanceMode = 'real';
    } catch (e) {
      governanceMode = 'double(实跑抛错: ' + String(e.message).split('\n')[0] + ')';
    }
  }
  if (governanceMode !== 'real') {
    ctx.PromptGovernance = {
      getWritingStyleBlock: (s) => s,
      isWritingStyleEnabled: () => false,
      registerPrompt: () => ({ ok: true }),
      appendFactAndSourceGuard: (p) => p + '\n[FACT-GUARD]',
      mergeKnowledgeSources: (sources) => ({
        ok: true,
        text: (sources || []).map((s) => '[' + s.label + ' | source=' + s.source + ' | sha256=' +
          crypto.createHash('sha256').update(s.content).digest('hex') + ']\n' + s.content).join('\n\n'),
      }),
    };
  }
  load('app/js/knowledge.builtins.js', o.knowledgeSource);
  load('app/js/masters-data.js');
  load('app/js/masters-core.js');
  load('app/js/agent-tools.js');
  vm.runInContext([
    'globalThis.Knowledge = Knowledge;',
    'globalThis.MASTERS = MASTERS;',
    'globalThis.getMasterByKey = getMasterByKey;',
    'globalThis.MastersCore = MastersCore;',
  ].join('\n'), ctx);
  ctx.__governance = governanceMode;
  ctx.__convs = convs;
  return ctx;
}

/* agent-core.js 的真实参数校验函数（未导出）：按大括号配对从产品源码里整函数取出来跑。
 * 与 scripts/f3-alias-temperature.test.cjs 从产品源码里抽表达式求值同一手法。 */
function extractValidateSchema() {
  const src = read('app/js/agent-core.js');
  const sig = 'function validateSchema(args, schema) {';
  const i = src.indexOf(sig);
  assert.ok(i >= 0, 'agent-core.js: 找不到 validateSchema —— 该断言无法证明枚举真的在把关');
  let depth = 0, j = i + sig.length - 1;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j += 1; break; } }
  }
  const body = src.slice(i, j);
  const c = { console, Array, Object, String, Number, Boolean, RegExp, isNaN, isFinite, JSON, Math };
  c.globalThis = c;
  vm.createContext(c);
  return vm.runInContext('(() => {\n' + body + '\nreturn validateSchema;\n})()', c);
}

/* 用真实生成器 + 变异开关重跑一份产物（写 tmp 目录，绝不碰 app/js/）。 */
function regenerate(mutEnv, outFile, root = ROOT) {
  const managedPython = path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'python',
    'versions', '3.13.12', 'python.exe');
  const python = process.env.XJ_PYTHON ||
    (process.platform === 'win32' && fs.existsSync(managedPython) ? managedPython : 'python');
  // 子进程文本编码必须钉成 UTF-8：Windows 上 Python 对管道 stderr 取 ANSI 代码页
  // （本机 cp936），LANG/LC_ALL=C.UTF-8 不参与判断。不钉死时，下面按 utf8 解码的
  // 中文断言（M-GUARD 的 `不得指向生产产物路径`）会稳定失配 ⇒ 保护明明生效也记成变异存活。
  const env = Object.assign({}, process.env, mutEnv || {},
    { XJ_KB_OUT: outFile, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'scripts', 'gen-knowledge-builtins.py')],
      { cwd: root, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (e) => reject(new Error('python 不可用（' + e.message + '）—— 本卡不允许因环境缺件而记通过')));
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const TMP = path.join(LOGDIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

let PASS = 0, FAIL = 0;
const failures = [];
const softFailures = [];           // 变异探针里「必须转红」的失败，不计入基线门禁
const perMasterReport = [];
function ok(name, cond, detail) {
  const soft = name.indexOf('变异:') === 0;
  if (cond) { PASS++; console.log('PASS  ' + name); }
  else {
    FAIL++;
    (soft ? softFailures : failures).push(name);
    console.log((soft ? 'RED(变异探针)  ' : 'FAIL  ') + name + (detail ? '  ::  ' + String(detail).slice(0, 400) : ''));
  }
  return !!cond;
}

/* ============================================================================
 * (a) 逐位大师：真实 system 载荷零人设标记 + 方法论仍在 + 各槽可用
 * ============================================================================ */
const TEMPS = [0, 20, 41, 60, 71, 90, 100];
function payloadHits(ctx) {
  const C = ctx.MastersCore;
  const hits = {};            // marker -> [key@temp]
  const perMaster = {};
  for (const m of ctx.MASTERS) {
    const key = m.key;
    perMaster[key] = { slots: {}, personas: 0, methodology: false, chars: 0 };
    for (const t of TEMPS) {
      const one = C.buildOneToOneSystemPrompt({ messages: [], summary: '' }, ctx.getMasterByKey(key),
        { temperature: t, includeUserDocs: true });
      const round = C.buildRoundSystemPrompt(ctx.getMasterByKey(key), '甲、乙', false,
        { temperature: t, includeUserDocs: true });
      const kb = ctx.Knowledge.byTemp(key, t);
      perMaster[key].slots[t] = kb.length;
      perMaster[key].chars = Math.max(perMaster[key].chars, kb.length);
      if (METHODOLOGY_MARKERS.test(one) || METHODOLOGY_MARKERS.test(round)) perMaster[key].methodology = true;
      for (const [name, re] of Object.entries(PERSONA_MARKERS)) {
        for (const [tag, payload] of [['1v1', one], ['round', round]]) {
          const hit = re.exec(payload);
          if (hit) {
            (hits[name] = hits[name] || []).push(key + '@' + t + '/' + tag + ' :: ' + hit[0].slice(0, 60));
            perMaster[key].personas++;
          }
        }
      }
    }
  }
  return { hits, perMaster };
}

function assertHygiene(ctx, sfx) {
  const { hits, perMaster } = payloadHits(ctx);
  const markerNames = Object.keys(PERSONA_MARKERS);
  let allZero = true;
  for (const m of ctx.MASTERS) {
    const p = perMaster[m.key];
    const clean = p.personas === 0;
    if (!clean) allZero = false;
    ok(sfx + '载荷零人设标记[' + m.key + ']', clean,
      '命中 ' + p.personas + ' 处: ' + markerNames.filter((n) => (hits[n] || []).some((s) => s.indexOf(m.key + '@') === 0)).join(','));
    perMasterReport.push({
      master: m.key, personaHits: p.personas, methodologyKept: p.methodology,
      maxKnowledgeChars: p.chars, byTemp: p.slots,
    });
  }
  ok(sfx + '人设标记总命中=0（' + ctx.MASTERS.length + ' 位 × ' + TEMPS.length + ' 档 × 2 调用点）',
    allZero && markerNames.every((n) => !hits[n]), JSON.stringify(Object.keys(hits)));
  // 反向对照：断言必须「能为假」——同一批标记若命中则上面转红，这里再钉一次「标记集非空跑」
  let ran = 0;
  for (const m of ctx.MASTERS) for (const t of TEMPS) ran += ctx.Knowledge.byTemp(m.key, t).length > 0 ? 1 : 0;
  ok(sfx + '断言确实在跑（' + ran + '/' + (ctx.MASTERS.length * TEMPS.length) + ' 槽非空，非空跑）',
    ran === ctx.MASTERS.length * TEMPS.length, 'ran=' + ran);

  // 方法论不得被误删
  for (const m of ctx.MASTERS) {
    const p = perMaster[m.key];
    ok(sfx + '临床方法论正文仍在[' + m.key + ']', p.methodology && p.chars >= 800,
      'methodology=' + p.methodology + ' maxChars=' + p.chars);
  }
  // 定点反查（过宽规则一吞就红）
  const K = ctx.Knowledge;
  ok(sfx + '未被过宽误删[霍妮 二、角色规则 证据纪律]',
    /不把任何异议自动解释为抗力/.test(K.byTemp('horney', 90)) && /不把童年原因当作最终答案/.test(K.byTemp('horney', 90)),
    K.byTemp('horney', 90).slice(0, 60));
  ok(sfx + '未被过宽误删[罗杰斯 无条件积极关注 临床命题]',
    /无条件积极关注是你能给一个人最贵重的东西/.test(K.byTemp('rogers', 0)) &&
    /他只需要被接纳/.test(K.byTemp('rogers', 0)), 'perspective 槽被吞了');
  ok(sfx + '未被过宽误删[温尼科特 回答工作流 + 抱持先于解释]',
    /回答工作流/.test(K.byTemp('winnicott', 90)) && /抱持先于解释/.test(K.byTemp('winnicott', 90)));
  ok(sfx + '未被过宽误删[Sue Johnson 心智模型 + 工作流]',
    /爱的依恋联结模型/.test(K.byTemp('susan_johnson', 90)) && /回答工作流/.test(K.byTemp('susan_johnson', 90)));
  ok(sfx + '未被过宽误删[贝克 认知三联征 + 决策启发式]',
    /认知三联征/.test(K.byTemp('beck', 90)) && /决策启发式/.test(K.byTemp('beck', 90)));
  ok(sfx + '未被过宽误删[比昂 容器与被容纳 + 诚实边界]',
    /容器与被容纳/.test(K.byTemp('bion', 90)) && /诚实边界/.test(K.byTemp('bion', 90)));
  ok(sfx + '生平句是「逐句剥离」而非「整条丢弃」[罗杰斯 perspective 仍 >3000 字符]',
    K.get('rogers', 'perspective').length > 3000, 'len=' + K.get('rogers', 'perspective').length);

  // byTemp / slotsOf 各槽可用
  const bundleKeys = K.allKeys();
  ok(sfx + 'Knowledge.allKeys() == 12 且无 consultant-a',
    bundleKeys.length === 12 && bundleKeys.indexOf('consultant-a') < 0, bundleKeys.join(','));
  let slotBad = [];
  for (const key of bundleKeys) {
    for (const slot of K.slotsOf(key)) {
      const t = K.get(key, slot);
      if (!t || t.length < 200 || /^\s*(TODO|占位|待补充|TBD|N\/A)/.test(t)) slotBad.push(key + '/' + slot + '=' + t.length);
    }
    for (const tt of [0, 41, 60, 90]) {
      const bt = K.byTemp(key, tt);
      if (!bt || bt.length < 200) slotBad.push(key + '@byTemp' + tt + '=' + bt.length);
    }
  }
  ok(sfx + '每槽可解码、非空、非占位（slots × byTemp）', slotBad.length === 0, slotBad.join('|'));
  ok(sfx + '溯源 tempFiles 与实际槽位一致（净化未打断 byTemp 分支）',
    /winnicott-emotional\.md$/.test(K.tempFiles('winnicott', 0)) &&
    /winnicott-perspective\.md$/.test(K.tempFiles('winnicott', 60)) &&
    /winnicott-knowledge\.md/.test(K.tempFiles('winnicott', 90)),
    [K.tempFiles('winnicott', 0), K.tempFiles('winnicott', 60), K.tempFiles('winnicott', 90)].join(' | '));
}

(function baseline() {
  const ctx = makeSandbox({ governance: 'real' });
  console.log('# governance = ' + ctx.__governance);
  assertHygiene(ctx, '基线:');
})();

/* ============================================================================
 * (b) 工具入口枚举 == MASTERS.map(key)，且 horney 真能开会话
 * ============================================================================ */
function enumChecks(ctx, sfx) {
  const AT = ctx.AgentTools || ctx.window.AgentTools;
  ok(sfx + 'AgentTools 已导出', !!AT);
  if (!AT) return;
  const spec = AT.TOOL_REGISTRY['masters.open'].schema.function.parameters.properties.masterId;
  const enumv = spec.enum;
  const want = ctx.MASTERS.map((m) => m.key);
  ok(sfx + 'masters.open masterId 枚举 == MASTERS.map(key)（集合相等，含 horney）',
    Array.isArray(enumv) && enumv.length === want.length &&
    want.every((k) => enumv.indexOf(k) !== -1) && enumv.every((k) => want.indexOf(k) !== -1),
    'enum=' + JSON.stringify(enumv) + ' keys=' + JSON.stringify(want));
  ok(sfx + '枚举含 horney（11/12 缺陷 F3-P1-1 的靶点）', Array.isArray(enumv) && enumv.indexOf('horney') !== -1,
    JSON.stringify(enumv));
  ok(sfx + '枚举无重复项', Array.isArray(enumv) && new Set(enumv).size === enumv.length, JSON.stringify(enumv));
  ok(sfx + '枚举在 JSON 线格式里仍然展开（getter 不被序列化吞掉）',
    JSON.stringify(AT.TOOL_REGISTRY['masters.open'].schema).indexOf('"horney"') >= 0);

  // 真实参数校验（agent-core.js 的 validateSchema 本体，非复刻；它收的是整个 tool.schema，
  // 与 agent-core.js:433 `validateSchema(args, tool.schema)` 同一入口）
  const validateSchema = extractValidateSchema();
  const openToolSchema = AT.TOOL_REGISTRY['masters.open'].schema;
  ok(sfx + 'validateSchema(horney) 放行', validateSchema({ masterId: 'horney' }, openToolSchema) === null,
    String(validateSchema({ masterId: 'horney' }, openToolSchema)));
  ok(sfx + 'validateSchema(野生 id) 仍拦得住（枚举没被放宽成无约束）',
    typeof validateSchema({ masterId: 'not-a-master' }, openToolSchema) === 'string',
    String(validateSchema({ masterId: 'not-a-master' }, openToolSchema)));

  // 行为级：horney 真开出会话
  return AT.invoke('masters.open', { masterId: 'horney' }).then((r) => {
    const conv = r && r.ok && r.data ? ctx.__convs.find((c) => c.id === r.data.sessionId) : null;
    ok(sfx + 'AgentTools.invoke(masters.open, horney) 真开启会话', !!(r && r.ok && conv && conv.masterKeys[0] === 'horney'),
      JSON.stringify(r).slice(0, 200));
    // 12 位逐个过一遍工具入口（不止 horney）
    return Promise.all(ctx.MASTERS.map((m) => AT.invoke('masters.open', { masterId: m.key })
      .then((x) => ({ k: m.key, okk: !!(x && x.ok && x.data && x.data.sessionId), err: x && x.error }))));
  }).then((rs) => {
    ok(sfx + '12/12 位大师都能经 masters.open 开启', rs.every((x) => x.okk),
      rs.filter((x) => !x.okk).map((x) => x.k + ':' + x.err).join(' | '));
  });
}

let enumBaselineDone = enumChecks(makeSandbox({ governance: 'double' }), '基线:');

/* ============================================================================
 * (c) 反向变异：每条都必须转红
 * ============================================================================ */
function runMutants() {
  const results = [];
  function record(id, red, detail) {
    results.push({ id, red, detail });
    console.log((red ? 'KILLED   ' : 'SURVIVED ') + id + ' :: ' + detail);
  }
  // 探针：把一次完整断言跑成「是否全绿」的布尔（red=true 表示该变异下有断言转红）
  function probeAll(ctx) {
    const before = softFailures.length;
    assertHygiene(ctx, '变异:');
    return softFailures.length > before;   // 有新失败 = 断言对变异敏感 = 变异被杀
  }
  function probeEnum(ctx) {
    const before = softFailures.length;
    return enumChecks(ctx, '变异:').then(() => softFailures.length > before);
  }

  const chain = Promise.resolve();
  const M = [];

  // M-SANOFF：把生成器的净化规则整体关掉，重跑产物 -> 载荷必须重新出现人设标记
  M.push(chain.then(async () => {
    const out = path.join(TMP, 'mut-sanoff-knowledge.builtins.js');
    const r = await regenerate({ XJ_KB_NO_SANITIZE: '1' }, out);
    assert.strictEqual(r.status, 0, 'NO_SANITIZE 生成器必须成功产出变异体: ' + r.stderr);
    const dirty = fs.readFileSync(out, 'utf8');
    const ctx = makeSandbox({ governance: 'double', knowledgeSource: dirty });
    const wentRed = probeAll(ctx);
    record('M-SANOFF(关掉净化规则 => 载荷重新出现人设标记)', wentRed,
      wentRed ? '断言转红，净化确实在决定载荷内容' : 'SURVIVED: 关掉净化后载荷断言仍全绿 => 断言是假的');
  }));

  // M-OVERBROAD：把净化规则放宽到「标题含 角色/工作流/模型 就整段吞」且取消保护名单 -> 方法论保真断言必须转红
  M.push(chain.then(async () => {
    const out = path.join(TMP, 'mut-overbroad-knowledge.builtins.js');
    const r = await regenerate({ XJ_KB_OVERBROAD: '1', XJ_KB_NO_SANITIZE: '' }, out);
    assert.strictEqual(r.status, 0, 'OVERBROAD 生成器必须成功产出变异体: ' + r.stderr);
    const wide = fs.readFileSync(out, 'utf8');
    const ctx = makeSandbox({ governance: 'double', knowledgeSource: wide });
    const wentRed = probeAll(ctx);
    record('M-OVERBROAD(净化规则过宽吞方法论)', wentRed,
      wentRed ? '方法论保真/槽非空断言转红' : 'SURVIVED: 过宽规则没被任何断言抓到');
  }));

  // M-NOHORNEY：从派生结果里剔掉 horney（模拟「派生但漏一项」）
  M.push(chain.then(() => {
    const ctx = makeSandbox({
      governance: 'double',
      patch: {
        'app/js/agent-tools.js': (src) => src.replace(
          'if (typeof k === \'string\' && k && ids.indexOf(k) < 0) ids.push(k);',
          'if (typeof k === \'string\' && k && k !== \'horney\' && ids.indexOf(k) < 0) ids.push(k);'),
      },
    });
    return probeEnum(ctx).then((wentRed) => {
      record('M-NOHORNEY(派生结果里剔掉 horney)', wentRed,
        wentRed ? '集合相等 + horney 放行/开会话断言转红' : 'SURVIVED: 少了 horney 也没人管');
    });
  }));

  // M-HANDWRITTEN：枚举退回 11 项手写常量（F3-P1-1 的原始缺陷形态）
  M.push(chain.then(() => {
    const ctx = makeSandbox({
      governance: 'double',
      patch: {
        'app/js/agent-tools.js': (src) => src.replace(
          'get enum() { return masterIdEnum(); },',
          'enum: [\'winnicott\', \'lacan\', \'freud\', \'klein\', \'jung\', \'bion\', \'rogers\', \'beck\', \'yalom\', \'adler\', \'susan_johnson\'],'),
      },
    });
    return probeEnum(ctx).then((wentRed) => {
      record('M-HANDWRITTEN(枚举改回手写 11 项)', wentRed,
        wentRed ? '派生契约与 horney 会话断言转红' : 'SURVIVED: 手写清单没被发现');
    });
  }));

  // M-GUARD：在 tmp 中复制真实生成器与所需输入，只对镜像的生产路径试写；真实生产产物永不作为 OUT。
  M.push(chain.then(async () => {
    const prod = path.join(ROOT, 'app', 'js', 'knowledge.builtins.js');
    const before = fs.readFileSync(prod);
    const mirror = path.join(TMP, 'guard-mirror');
    fs.mkdirSync(path.join(mirror, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(mirror, 'app', 'js'), { recursive: true });
    fs.mkdirSync(path.join(mirror, 'app', 'masters'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'gen-knowledge-builtins.py'),
      path.join(mirror, 'scripts', 'gen-knowledge-builtins.py'));
    fs.copyFileSync(path.join(ROOT, 'app', 'js', 'masters-data.js'),
      path.join(mirror, 'app', 'js', 'masters-data.js'));
    fs.cpSync(path.join(ROOT, 'app', 'masters', 'knowledge'),
      path.join(mirror, 'app', 'masters', 'knowledge'), { recursive: true, force: true });
    const mirrorProd = path.join(mirror, 'app', 'js', 'knowledge.builtins.js');
    fs.copyFileSync(prod, mirrorProd);
    const mirrorBefore = fs.readFileSync(mirrorProd);
    const r = await regenerate({ XJ_KB_NO_SANITIZE: '1' }, mirrorProd, mirror);
    const untouched = fs.readFileSync(mirrorProd).equals(mirrorBefore);
    ok('基线:M-GUARD 真实生产产物字节不变', fs.readFileSync(prod).equals(before));
    record('M-GUARD(关掉净化时禁止覆盖生产产物)',
      r.status === 2 && untouched && /XJ_KB_OUT.*不得指向生产产物路径/.test(r.stderr),
      'exit=' + r.status + ' 镜像产物未变=' + untouched + ' :: ' + r.stderr.split('\n')[0]);
  }));

  return Promise.all(M).then(() => {
    const total = results.length;
    const survivors = results.filter((x) => !x.red).length;
    console.log('MUTATIONS: total=' + total + ' survivors=' + survivors);
    fs.writeFileSync(path.join(LOGDIR, 'per-master-hygiene.json'),
      JSON.stringify({ governance: 'see stdout', perMaster: perMasterReport }, null, 1), 'utf8');
    return { total, survivors };
  });
}

enumBaselineDone.then(() => runMutants()).then((mut) => {
  console.log('\nRESULT  pass=' + PASS + ' baseline_fail=' + failures.length +
    ' mutant_probe_reds=' + softFailures.length +
    (failures.length ? '  failed=[' + failures.join(', ') + ']' : ''));
  assert.ok(failures.length === 0, 'There were ' + failures.length + ' failing baseline assertions');
  assert.ok(mut.survivors === 0, mut.survivors + ' mutant(s) survived — assertions are not sensitive');
  assert.ok(softFailures.length > 0, '没有任何一条变异探针转红 —— 断言可能整体失效');
  console.log('PASS  f3-payload-hygiene: 载荷净化 + 枚举派生 全部基线断言绿，0 个变异存活');
}).catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
