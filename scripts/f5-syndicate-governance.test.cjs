/* ============================================================================
 * f5-syndicate-governance.test.cjs
 *
 * 自证两件事（node 层 vm realm + 本地 stub provider；无网络、无 Electron、
 * 无真实供应商；材料全部为合成数据）：
 *
 *  A. D-5 prompt 治理接线：summarizer / lead(route) / synthesis 三处
 *     PromptGovernance.registerPrompt 生效；manifest 增量、source/provenance/
 *     templateHash/contentHash 与**实际发出的载荷**同源可核；登记先于发送；
 *     round 分支（学派）仍只由 MastersCore 登记一次，本文件不重复登记。
 *     5.1.19 对账轮：本组原来的「prompt 文本与改动前基线逐字节一致」前提已被 F7-P1-2
 *     （摘要/路由/综合三条 system 必须接 fact+source guard）取消，A6/A7/A14 与 T1-T3
 *     已按「原期望 / 新期望 / 需求依据」重建，见各条上方注释与
 *     reports/governance-reconciliation.md §1；新增 T5 把本轮之后的绝对期望文本钉成字面量。
 *  B. DEC-01：分段摘要触发阈值降到页面准入预算（24000 字符）以内 —— 页面典型
 *     长材料真的走分段分支（totalSegments >= 2）；任一段失败仍 PARTIAL_SUMMARY
 *     短路，failedSegments 与注入段号精确一致；阶段预算 30000 与总输入 240000
 *     的检查一个都没放宽。
 *  C. 疑点裁决：用**改动前基线副本**实测 f5-budget P-3 与 f7-behavior §4 两组
 *     互相冲突的结论，判谁成立、另一条为什么会得出。
 *  D. D-1（真实 Electron 实测缺陷）：学派阶段 INVALID_PROMPT 必须零出网、不重试、
 *     一路带到终态 errorCode 并点名学派，同时不得吞掉另一派的真实结论（不得归档）。
 *  E. D-2（真实 Electron 实测缺陷）：分段摘要失败时核心必须发出带 failedSegments 的
 *     summary 进度事件（改前永不到达页面），且短路语义不变。
 *
 * 反向变异：--mutations（期望 survivors=0）
 *   M1 旁路登记 / M2 阈值改回 30000 / M3 放宽阶段预算 / M4 failedSegments 乱序
 *   M5 synthesis 去 templateKey / M6 改动 prompt 文本 / M7 失败段写成全量
 *   M8 综合版本退回内容派生族 / M9 登记退回 guard 之前 / M10 去掉路由 guard
 *   M11 旁路 D-1 致命提示词判定 / M12 稳定码映射被放宽 / M13 D-2 顺序回归
 *
 * 运行：
 *   node scripts/f5-syndicate-governance.test.cjs
 *   node scripts/f5-syndicate-governance.test.cjs --mutations
 * ==========================================================================*/
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const OUT_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f5-syndicate-evidence-'));
const MUTANT_DIR = path.join(OUT_DIR, 'mutants');
const BASELINE_COPY = path.join(ROOT, 'scripts', 'fixtures', 'f5-prechange-supervision-syndicate.js');
const EXPECTED_BASELINE_MD5 = 'f24d61186d570b8a832135148304c413'; // 改动前工作树版本（11:55 快照）

const MUTATION_MODE = process.argv.indexOf('--mutations') >= 0;
fs.mkdirSync(MUTANT_DIR, { recursive: true });

const LIVE_SOURCE = fs.readFileSync(path.join(APP, 'supervision-syndicate.js'), 'utf8');
const BASELINE_SOURCE = fs.readFileSync(BASELINE_COPY, 'utf8');

/* ---------- hashing helpers ---------- */
function nodeSha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
function md5OfText(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}
function md5File(file) {
  return md5OfText(fs.readFileSync(file, 'utf8'));
}
function readApp(name) {
  return fs.readFileSync(path.join(APP, name), 'utf8');
}

/* 治理层 sha256 依赖 `unescape(encodeURIComponent(x))` 取 UTF-8 字节。
 * realm 里必须用宿主（V8）自带的 unescape，否则哈希按被改形的字节计算，
 * manifest 里的 contentHash/templateHash 与真实渲染进程/ node crypto 不可比。
 * （本夹具的 A0 断言就是用来抓这件事的：先前流派的 harness 用了
 *  `Buffer.from(s,'binary').toString('utf8')` 作为 unescape 替身，哈希是错的。） */
const HOST_UNESCAPE = (function () {
  if (typeof unescape === 'function') return unescape;
  return function (s) {
    return String(s)
      .replace(/%u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/%([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
  };
})();

/* ---------- 合成材料：定长 60 字符单元，长度可控、覆盖可核对 ---------- */
const UNIT = 60;
function unit(i) { return '[u' + String(i).padStart(6, '0') + ']' + '·'.repeat(UNIT - 9); }
function materialOfUnits(units) {
  let out = '';
  for (let i = 0; i < units; i += 1) out += unit(i);
  return out;
}
function materialChars(n) {
  const whole = Math.floor(n / UNIT) * UNIT;
  return materialOfUnits(whole / UNIT) + '·'.repeat(n - whole);
}
function unitTokens(text) {
  const re = /\[u(\d{6})\]/g;
  const hits = [];
  let m;
  while ((m = re.exec(String(text)))) hits.push(Number(m[1]));
  return hits;
}

/* ---------- 阶段识别：只看真实载荷文本 ---------- */
function stageOf(messages) {
  const user = String((messages[1] && messages[1].content) || '');
  if (user.indexOf('请摘要以下临床材料分段') >= 0) return 'summary:segment';
  if (user.indexOf('请摘要以下临床材料') >= 0) return 'summary';
  if (user.indexOf('请判断案例类型并输出路由 JSON') >= 0) return 'route';
  if (user.indexOf('请从你的学派督导视角分析') >= 0) return 'school';
  if (user.indexOf('请输出三段式综合督导') >= 0) return 'synthesis';
  return 'other';
}
function segmentOf(messages) {
  const m = /第\s*(\d+)\s*\/\s*(\d+)\s*段/.exec(String((messages[1] && messages[1].content) || ''));
  return m ? { index: Number(m[1]), total: Number(m[2]) } : { index: -1, total: -1 };
}

/* ---------- realm ---------- */
function makeFakeStore() {
  return {
    getSettings: function () { return {}; },
    getClient: function () { return null; },
    getSessions: function () { return []; },
    getSession: function () { return null; },
    getMaterial: function () { return null; },
    getMaterialWorkspace: function () { return null; },
    getSupervision: function () { return null; },
    createClinicalActionRun: function () { return null; },
    updateClinicalActionRun: function () { return null; },
    saveAiSupervisionDurable: async function () { return { ok: false }; },
  };
}

/* opts: { syndicateSource, failSegments, summaryFail, segmentReplyChars, schoolCount } */
function createRealm(opts) {
  opts = opts || {};
  const events = [];        // register / send / progress 的统一时序流
  const sends = [];         // 实际发给 provider 的载荷
  const registrations = []; // 实际传给 registerPrompt 的入参
  const progressEvents = [];// 核心回调给页面的进度事件（D-2 的观测点）

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    AbortController, TextEncoder, TextDecoder, crypto,
    atob: function (b64) { return Buffer.from(b64, 'base64').toString('binary'); },
    btoa: function (bin) { return Buffer.from(bin, 'binary').toString('base64'); },
    unescape: HOST_UNESCAPE,
    JSON, Math, Date, RegExp, Error, Promise, Buffer, Number, String, Object, Array, Boolean, Set,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Store = makeFakeStore();
  const ctx = vm.createContext(sandbox);

  const syndicateSource = opts.syndicateSource == null ? LIVE_SOURCE : opts.syndicateSource;
  function load(name, source, tail) {
    vm.runInContext((source == null ? readApp(name) : source) + (tail || ''), ctx, { filename: name });
  }
  load('prompt-governance.js');
  load('prompts.builtin.js', null, '\n;globalThis.PromptsBuiltin = PromptsBuiltin;');
  load('masters-data.js');
  load('supervision-syndicate-data.js');
  load('supervision-syndicate.js', syndicateSource);
  load('masters-core.js', null, '\n;globalThis.MastersCore = MastersCore;');
  load('clinical-context.js', null, '\n;globalThis.ClinicalContext = ClinicalContext;');

  /* registerPrompt 代理：治理层照常工作，另记入参与时序 */
  const realGovernance = sandbox.PromptGovernance;
  const sha = realGovernance.sha256;
  sandbox.PromptGovernance = Object.assign({}, realGovernance, {
    registerPrompt: function (definition) {
      const content = String((definition && definition.content) || '');
      registrations.push({
        id: String(definition && definition.id),
        templateKey: definition && definition.templateKey,
        declaredVersion: definition && definition.version,
        declaredSource: definition && definition.source,
        contentChars: content.length,
      });
      events.push({ type: 'register', id: String(definition && definition.id) });
      return realGovernance.registerPrompt(definition);
    },
  });

  const policy = {
    failSegments: opts.failSegments || [],
    summaryFail: !!opts.summaryFail,
    segmentReplyChars: opts.segmentReplyChars || 0,
    schoolCount: opts.schoolCount == null ? 1 : opts.schoolCount,
  };
  const routeSchools = ['sup-winnicott', 'sup-klein', 'sup-bion'].slice(0, Math.max(1, policy.schoolCount));
  function respond(stage, messages) {
    if (stage === 'summary:segment') {
      const seg = segmentOf(messages);
      if (policy.failSegments.indexOf(seg.index) >= 0) return { error: '合成摘要失败（stub）', errorCode: 'STUB_SUMMARY_FAILURE' };
      const body = policy.segmentReplyChars > 0
        ? '一、情感脉络：' + '·'.repeat(policy.segmentReplyChars)
        : '一、情感脉络：合成摘要\n二、防御模式：合成摘要\n三、移情线索：合成摘要\n四、干预变化：合成摘要';
      return { content: body };
    }
    if (stage === 'summary') {
      if (policy.summaryFail) return { error: '合成摘要失败（stub）', errorCode: 'STUB_SUMMARY_FAILURE' };
      return { content: '一、情感脉络：合成摘要\n二、防御模式：合成摘要\n三、移情线索：合成摘要\n四、干预变化：合成摘要' };
    }
    if (stage === 'route') {
      return { content: '{"case_type":"综合性督导","schools":' + JSON.stringify(routeSchools) + ',"focus":"合成关注点","workflow":"focused"}' };
    }
    if (stage === 'school') return { content: '学派分析：基于材料线索的合成判断与建议。' };
    if (stage === 'synthesis') return { content: '【对比表】合成对比\n【分歧点】合成分歧\n【整合建议】合成建议' };
    return { content: '合成回复' };
  }
  const provider = {
    send: function (messages, callback) {
      const stage = stageOf(messages);
      const system = String(messages[0].content);
      const user = String(messages[1].content);
      const record = {
        seq: sends.length,
        stage: stage,
        segment: segmentOf(messages),
        systemChars: system.length,
        userChars: user.length,
        stageChars: system.length + user.length,
        systemSha256: sha(system),
        userSha256: sha(user),
        systemText: system,
        segmentBody: stage === 'summary:segment' ? user.slice(user.indexOf('【材料分段】\n') + 7) : '',
        userText: user,
      };
      sends.push(record);
      events.push({ type: 'send', stage: stage, seq: record.seq });
      const result = respond(stage, messages);
      if (typeof callback === 'function') callback(result);
      return result;
    },
  };

  return {
    sandbox, sends, events, registrations, progressEvents,
    api: sandbox.SupervisionSyndicate,
    governance: realGovernance,
    manifest: function () { return realGovernance.getPromptManifest(); },
    manifestIds: function () { return realGovernance.getPromptManifest().map(function (r) { return r.id; }); },
    reset: function () { sends.length = 0; events.length = 0; registrations.length = 0; progressEvents.length = 0; },
    run: function (materialValue) {
      const runOpts = { provider: provider };
      // D-1 的注入点：把内核圆桌 system 构造器换成空串 → 该派 prompt.system='' → invokeCard
      // 在出网**之前**判 INVALID_PROMPT（真实页面 D-1 用的就是这个注入面，产品文件一字未改）。
      if (opts.mastersCoreStub) runOpts.mastersCore = opts.mastersCoreStub;
      return sandbox.SupervisionSyndicate.runMultiSchoolSupervision({
        material: materialValue,
        onProgress: function (event) {
          progressEvents.push(event);
          events.push({ type: 'progress', name: String(event && event.type) });
        },
      }, runOpts);
    },
    admission: function (chars) {
      return sandbox.ClinicalContext.build('supervision-multi-school', { clientId: '', sessionId: '' }, {
        system: '多学派临床督导编排；输出仅为草稿。',
        inputText: materialChars(chars),
        instruction: '运行多学派督导并生成对比、分歧与整合建议',
      });
    },
  };
}

/* 逐条实际发给 provider 的载荷落盘（无落盘 = 无取证） */
const PAYLOAD_DIR = path.join(OUT_DIR, 'payloads');
function dumpPayloads(name, ctx, extra) {
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  const sha = ctx.governance.sha256;
  const body = {
    sample: name,
    at: new Date().toISOString(),
    subjectMd5: ctx.__source ? md5OfText(ctx.__source) : md5File(path.join(APP, 'supervision-syndicate.js')),
    manifest: ctx.manifest(),
    registrations: ctx.registrations,
    events: ctx.events,
    sends: ctx.sends.map(function (s) {
      const user = s.userText || '';
      return {
        seq: s.seq, stage: s.stage, segment: s.segment,
        systemChars: s.systemChars, userChars: s.userChars, stageChars: s.stageChars,
        systemSha256: s.systemSha256, userSha256: sha(user),
        systemText: s.systemText,
        userHead: user.slice(0, 300),
        userTail: user.slice(-300),
        segmentBodyChars: s.segmentBody.length,
        segmentBodySha256: s.segmentBody ? sha(s.segmentBody) : '',
      };
    }),
    extra: extra || {},
  };
  const file = path.join(PAYLOAD_DIR, name + '.json');
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return path.relative(ROOT, file);
}

/* 变异/基线场景下的 realm 工厂：把被测源码固定成同一份 */
function realmFactory(source) {
  const make = function (opts) {
    const r = createRealm(Object.assign({}, opts, { syndicateSource: source }));
    r.__source = source;
    return r;
  };
  return make;
}

/* ---------- 断言登记 ---------- */
const RESULTS = [];
function check(caseId, name, condition, observed) {
  let pass = false;
  let error = '';
  try { pass = !!condition; } catch (e) { error = e.message; pass = false; }
  RESULTS.push({ case: caseId, name: name, pass: pass, observed: error ? ('harness error: ' + error) : String(observed == null ? '' : observed) });
  process.stdout.write((pass ? '  PASS ' : '  RED  ') + caseId + ' / ' + name + (pass ? '' : ' -> ' + RESULTS[RESULTS.length - 1].observed) + '\n');
  return pass;
}

function templateTextOf(syndicate, idOrKey) {
  const raw = String(idOrKey);
  const key = raw.indexOf('masters.system.') === 0 ? raw.slice('masters.system.'.length) : raw;
  const card = syndicate.CARDS.filter(function (c) { return c.key === key; })[0];
  return card ? card.systemPrompt : '';
}

/* ---------- 用例 A：D-5 接线（验收件） ---------- */
async function caseA(ctx) {
  const id = 'A-governance-wiring';
  const api = ctx.api;
  const sha = ctx.governance.sha256;
  const lead = api.CARDS.filter(function (c) { return c.key === 'sup-lead'; })[0];
  const summarizer = api.CARDS.filter(function (c) { return c.key === 'sup-summarizer'; })[0];
  const winni = api.CARDS.filter(function (c) { return c.key === 'sup-winnicott'; })[0];

  check(id, 'A0 治理层 sha256 与 node crypto 对真实模板一致（否则哈希断言可能是假的）',
    sha(lead.systemPrompt) === nodeSha256(lead.systemPrompt) && sha(summarizer.systemPrompt) === nodeSha256(summarizer.systemPrompt),
    'pg=' + sha(lead.systemPrompt).slice(0, 12) + ' node=' + nodeSha256(lead.systemPrompt).slice(0, 12));

  const before = ctx.manifest().length;
  const result = await ctx.run(materialChars(12000)); // 页面典型长材料，provider 路径
  const pg = ctx.governance;
  const GUARD = pg.FACT_AND_SOURCE_GUARD;

  const wanted = ['masters.system.sup-summarizer', 'masters.system.sup-lead', 'masters.system.sup-winnicott',
    'supervision.multi-school.synthesis.system'];
  const added = ctx.manifest().filter(function (r) { return wanted.indexOf(r.id) >= 0; });
  const addedIds = added.map(function (r) { return r.id; }).sort();
  check(id, 'A1 provider 路径跑完后 manifest 新增 4 条（summarizer / lead / 学派 / synthesis）',
    before === 0 && added.length === 4 && JSON.stringify(addedIds) === JSON.stringify(wanted.slice().sort()),
    'before=' + before + ' total=' + ctx.manifest().length + ' added=' + JSON.stringify(addedIds) + ' runOk=' + result.ok);

  const syn = added.filter(function (r) { return r.id === 'supervision.multi-school.synthesis.system'; })[0] || {};
  check(id, 'A2 synthesis.source === app/js/supervision-syndicate-data.js',
    syn.source === 'app/js/supervision-syndicate-data.js', 'source=' + syn.source);
  check(id, 'A3 synthesis.provenance === verified（按真实载荷反查模板命中）',
    syn.provenance === 'verified', 'provenance=' + syn.provenance + ' versionBasis=' + syn.versionBasis);
  check(id, 'A4 synthesis.templateHash === sha256(sup-lead.systemPrompt)',
    !!syn.templateHash && syn.templateHash === nodeSha256(lead.systemPrompt),
    'got=' + String(syn.templateHash).slice(0, 16) + ' want=' + nodeSha256(lead.systemPrompt).slice(0, 16));

  const sum = added.filter(function (r) { return r.id === 'masters.system.sup-summarizer'; })[0] || {};
  const leadEntry = added.filter(function (r) { return r.id === 'masters.system.sup-lead'; })[0] || {};
  const segSent = ctx.sends.filter(function (s) { return s.stage === 'summary:segment'; })[0];
  const routeSent = ctx.sends.filter(function (s) { return s.stage === 'route'; })[0];
  const synSent = ctx.sends.filter(function (s) { return s.stage === 'synthesis'; })[0];
  check(id, 'A5 synthesis.contentHash === 实际发出的 system 哈希，且发出文本以 lead 模板开头',
    !!synSent && syn.contentHash === pg.sha256(synSent.systemText) && synSent.systemText.indexOf(lead.systemPrompt) === 0,
    'manifest=' + String(syn.contentHash).slice(0, 16) + ' payload=' + (synSent ? synSent.systemSha256.slice(0, 16) : 'no-send'));
  /* A6（对账轮 2026-09-24 改期望）
   * 原期望：synthesis.version === '4.4.0+sha256.' + contentHash.slice(0,12)
   *        —— 把「学派卡所在文件当时没声明 promptVersion」这一时点事实写成永久语义，
   *          等于把 F7-P0-1 判为 P0 的形态（版本 = 内容的函数）钉死成契约。
   * 新期望：综合阶段自声明版本 —— version 就是 api.SYNTHESIS_TEMPLATE_VERSION（4.5.0），
   *        versionCore === version，版本串里不得再出现 +sha256.<12>；逐字节可追溯性
   *        由 contentHash / templateHash 承担（A3/A4/A5 同时钉住它们仍在且非空）。
   * 需求依据：F7 目标 2（版本与内容线性无关，否则「同版本改文本」的拒绝判据前件恒假）
   *        + 目标 6；任务书 1-A6。 */
  const synDeclared = String(api.SYNTHESIS_TEMPLATE_VERSION || '');
  check(id, 'A6 synthesis 版本由该阶段自声明（不再是内容的函数），逐字节可追溯由 contentHash/templateHash 承担',
    !!synDeclared && syn.version === synDeclared && syn.versionCore === synDeclared
    && String(syn.version).indexOf('+sha256.') < 0
    && /self-declared/.test(String(syn.versionBasis))
    && syn.versionCore === '4.5.0'
    && syn.provenance === 'verified' && !!syn.templateHash && !!syn.contentHash,
    'version=' + syn.version + ' versionCore=' + syn.versionCore + ' basis=' + syn.versionBasis
    + ' declared=' + synDeclared + ' contentHash=' + String(syn.contentHash).slice(0, 12)
    + ' templateHash=' + String(syn.templateHash).slice(0, 12));

  /* A7（对账轮 2026-09-24 改期望）
   * 原期望：entry.contentHash === sha256(卡片模板原文) **且** === sha256(实发 system)
   *        —— 前半句在 F7-P1-2 之后与产品要求互斥（发出的就是「模板 + 边界段」）。
   * 实测：登记发生在 guard 拼完之后，contentHash 一直等于实发 system ⇒ 不是「manifest
   *        描述的不是真实载荷」那种真缺陷，而是断言写错了不变量
   *        （探针 logs/reconcile/probe/reconcile-probe-01.out.json：333/578/613 三条
   *         登记字符数 == 实发 system 字符数，哈希前 12 位逐条相等）。
   * 新期望：manifest 覆盖真实载荷 = entry.contentHash === sha256(实发 system)，
   *        **同时** entry.templateHash === sha256(模板原文) 两条一起成立；再加方向性：
   *        实发文本以模板原文开头、以 guard 结尾（既不许只等于模板，也不许丢模板）。
   * 需求依据：F7 目标 6 + 目标 4；任务书 1-A7。 */
  check(id, 'A7 summarizer/lead 条目 contentHash === 实发 system 且 templateHash === 模板原文（manifest 覆盖真实载荷）',
    !!segSent && !!routeSent
    && sum.contentHash === pg.sha256(segSent.systemText) && sum.templateHash === pg.sha256(summarizer.systemPrompt)
    && leadEntry.contentHash === pg.sha256(routeSent.systemText) && leadEntry.templateHash === pg.sha256(lead.systemPrompt)
    && segSent.systemText.indexOf(summarizer.systemPrompt) === 0 && segSent.systemText.slice(-GUARD.length) === GUARD
    && routeSent.systemText.indexOf(lead.systemPrompt) === 0 && routeSent.systemText.slice(-GUARD.length) === GUARD,
    'sum=' + String(sum.contentHash).slice(0, 10) + '/segSent=' + (segSent ? segSent.systemSha256.slice(0, 10) : '-')
    + ' sumTemplate=' + String(sum.templateHash).slice(0, 10) + '/want=' + pg.sha256(summarizer.systemPrompt).slice(0, 10)
    + ' lead=' + String(leadEntry.contentHash).slice(0, 10) + '/routeSent=' + (routeSent ? routeSent.systemSha256.slice(0, 10) : '-')
    + ' leadTemplate=' + String(leadEntry.templateHash).slice(0, 10) + '/want=' + pg.sha256(lead.systemPrompt).slice(0, 10));
  check(id, 'A8 三条登记 provenance/source/version/changeLog 齐备且逐模板版本互不相同',
    [sum, leadEntry, syn].every(function (r) {
      return r.provenance === 'verified' && r.source === 'app/js/supervision-syndicate-data.js'
        && !!r.version && Array.isArray(r.changeLog) && r.changeLog.length > 0;
    }) && new Set([sum.version, leadEntry.version, syn.version]).size === 3,
    JSON.stringify([sum.version, leadEntry.version, syn.version]));

  const regIdx = function (mid) {
    for (let i = 0; i < ctx.events.length; i += 1) if (ctx.events[i].type === 'register' && ctx.events[i].id === mid) return i;
    return -1;
  };
  const sendIdx = function (stage) {
    for (let i = 0; i < ctx.events.length; i += 1) if (ctx.events[i].type === 'send' && ctx.events[i].stage === stage) return i;
    return -1;
  };
  check(id, 'A9 登记先于对应阶段发送（summarizer / lead / synthesis 三条时序）',
    regIdx('masters.system.sup-summarizer') >= 0 && regIdx('masters.system.sup-summarizer') < sendIdx('summary:segment')
    && regIdx('masters.system.sup-lead') >= 0 && regIdx('masters.system.sup-lead') < sendIdx('route')
    && regIdx('supervision.multi-school.synthesis.system') >= 0 && regIdx('supervision.multi-school.synthesis.system') < sendIdx('synthesis'),
    'sum ' + regIdx('masters.system.sup-summarizer') + '<' + sendIdx('summary:segment')
    + ' | lead ' + regIdx('masters.system.sup-lead') + '<' + sendIdx('route')
    + ' | syn ' + regIdx('supervision.multi-school.synthesis.system') + '<' + sendIdx('synthesis'));

  const schoolRegs = ctx.registrations.filter(function (r) { return r.id === 'masters.system.sup-winnicott'; });
  const schoolSends = ctx.sends.filter(function (s) { return s.stage === 'school'; });
  check(id, 'A10 学派 id 仅登记 1 次（round 分支由 MastersCore 登记，未重复）',
    schoolRegs.length === 1 && schoolSends.length === 1,
    'registerCalls=' + schoolRegs.length + ' schoolSends=' + schoolSends.length);
  check(id, 'A11 学派发出的 system 含模板原文，且模板哈希在 manifest 可核（登记未丢文本）',
    schoolSends.length === 1 && schoolSends[0].systemText.indexOf(winni.systemPrompt) >= 0
    && ctx.manifest().some(function (r) { return r.id === 'masters.system.sup-winnicott' && r.contentHash === pg.sha256(winni.systemPrompt); }),
    'contains=' + (schoolSends[0] ? schoolSends[0].systemText.indexOf(winni.systemPrompt) : 'no-send'));

  const untraceable = ctx.sends.filter(function (s) {
    const hash = pg.sha256(s.systemText);
    if (ctx.manifest().some(function (r) { return r.contentHash === hash; })) return false;
    const viaTemplate = ctx.manifest().some(function (r) {
      const t = templateTextOf(api, r.templateKey || r.id);
      return !!t && r.templateHash === pg.sha256(t) && s.systemText.indexOf(t) >= 0;
    });
    return !viaTemplate;
  });
  check(id, 'A12 发出的每一条 system 都能在 manifest 溯源（无未登记模板出网）',
    untraceable.length === 0 && ctx.sends.length >= 5,
    'untraceable=' + JSON.stringify(untraceable.map(function (s) { return s.stage; })) + ' sends=' + ctx.sends.length);

  const sumRegs = ctx.registrations.filter(function (r) { return r.id === 'masters.system.sup-summarizer'; }).length;
  check(id, 'A13 分段数与登记次数一致且 manifest 只 1 条 summarizer（重复登记幂等，未产生歧义条目）',
    sumRegs === result.totalSegments && ctx.manifestIds().filter(function (x) { return x === 'masters.system.sup-summarizer'; }).length === 1
    && result.totalSegments >= 2,
    'registers=' + sumRegs + ' totalSegments=' + result.totalSegments);

  /* A14（对账轮 2026-09-24 换不变量）
   * 原期望：发出的 system 与卡片模板**字节相同**（F5 流「不改 prompt 文本」的前提）。
   *        该前提已被 F7-P1-2（复审定的产品要求：三条 system 必须接 fact+source guard）取消，
   *        继续留着等于把「少发一段边界段」当成正确行为。
   * 新期望（它本来该守的那条不变量）：**登记文本 === 实发文本** —— 逐阶段同时满足
   *        ①登记入参字符数 == 实发 system 字符数；②entry.contentHash == sha256(实发 system)；
   *        ③登记事件序号早于该阶段发送；④登记的不是裸模板（字符数正好等于
   *        「模板 + \n\n + guard」，证明 guard 在登记之前就已拼进去）。
   * 需求依据：F7 目标 4（guard 必须出现在实发文本上）+ 目标 6（manifest 覆盖真实载荷）；
   *        任务书 1-A14「A14 的断言改写为『登记文本 === 实发文本』」。 */
  const regChars = function (mid) {
    const hit = ctx.registrations.filter(function (r) { return r.id === mid; })[0];
    return hit ? hit.contentChars : -1;
  };
  const wantRegisteredChars = function (template) { return template.length + 2 + GUARD.length; };
  const a14Rows = [
    { id: 'masters.system.sup-summarizer', sent: segSent, entry: sum, template: summarizer.systemPrompt },
    { id: 'masters.system.sup-lead', sent: routeSent, entry: leadEntry, template: lead.systemPrompt },
    { id: 'supervision.multi-school.synthesis.system', sent: synSent, entry: syn, template: null },
  ];
  const a14Bad = a14Rows.map(function (row) {
    if (!row.sent || !row.entry || !row.entry.contentHash) return row.id + ': 没有实发载荷或没有登记条目';
    if (regChars(row.id) !== row.sent.systemChars) return row.id + ': 登记 ' + regChars(row.id) + ' 字符 != 实发 ' + row.sent.systemChars + ' 字符';
    if (row.entry.contentHash !== pg.sha256(row.sent.systemText)) return row.id + ': contentHash 不等于实发 system 哈希';
    if (regIdx(row.id) < 0 || !(regIdx(row.id) < sendIdx(row.sent.stage))) return row.id + ': 登记不在该阶段发送之前（' + regIdx(row.id) + ' / ' + sendIdx(row.sent.stage) + '）';
    if (row.template && regChars(row.id) !== wantRegisteredChars(row.template)) {
      return row.id + ': 登记的不是「模板 + guard」那条文本（期望 ' + wantRegisteredChars(row.template) + ' 字符，实测 ' + regChars(row.id) + '）';
    }
    if (!row.template && row.sent.systemText.slice(-GUARD.length) !== GUARD) return row.id + ': 综合阶段实发文本缺边界段';
    return '';
  }).filter(function (x) { return x; });
  check(id, 'A14 登记文本 === 实发文本（三阶段逐条：字符数 + contentHash + 时序 + guard 已在登记内）',
    a14Bad.length === 0 && !!segSent && !!routeSent && !!synSent,
    'bad=' + JSON.stringify(a14Bad) + ' registeredChars=' + JSON.stringify(a14Rows.map(function (r) { return regChars(r.id); }))
    + ' sentChars=' + JSON.stringify(a14Rows.map(function (r) { return r.sent ? r.sent.systemChars : -1; })));

  return { totalSegments: result.totalSegments, addedIds: addedIds, sends: ctx.sends.length };
}

/* ---------- 用例 A-text：与「修复前基线」的差分必须恰好是一段边界段的追加 ----------
 * 原期望（F5 流，§5 逐字节基线用例）：三阶段载荷与基线**逐字节一致** —— 它的前提是
 *   「D-5 接线不改 prompt 文本」。该前提已被 F7-P1-2（复审定的产品要求：摘要/路由/综合
 *   三条 system 必须接 fact+source guard）取消，逐字节相等在结构上再也无法成立。
 * 新期望（重建基线到「新期望文本」，不是放宽而是换成可判定的等价式）：以同一份 md5 钉住的
 *   基线副本为参照，逐阶段只允许两种结果 ——
 *     new === base                       该阶段本来就带 guard（学派阶段由内核拼，两次运行同源）
 *     new === base + '\n\n' + GUARD      本轮把边界段接到这条阶段上（追加，且只追加）
 *   并且：user 文本逐字节不变；剥掉尾部 guard 后必须逐字节回到基线（= 除 guard 外没动过任何字节）；
 *   阶段序列与条数不变；每条实发 system 都以 guard 结尾；路由/综合的语义段仍在。
 * 需求依据：任务书 1-T1/T2/T3「重建基线到新的期望文本，并新增断言证明变化是只有 guard 追加」。
 */
function traceRows(ctx, chars) {
  ctx.reset();
  return Promise.resolve(ctx.run(materialChars(chars))).then(function () {
    return ctx.sends.map(function (s) {
      return {
        stage: s.stage, seg: s.segment.index, system: s.systemText, user: s.userText,
        systemSha: s.systemSha256, userSha: s.userSha256, chars: s.systemChars,
      };
    });
  });
}
function templateOf(api, key) {
  const card = api.CARDS.filter(function (c) { return c.key === key; })[0];
  return card ? String(card.systemPrompt) : '';
}
function diffAgainstBaseline(rows, baseRows, guard, api) {
  const suffix = '\n\n' + guard;
  const out = {
    problems: [], appended: [], unchanged: [],
    sequenceOk: rows.length === baseRows.length && rows.every(function (r, i) {
      return !!baseRows[i] && baseRows[i].stage === r.stage && baseRows[i].seg === r.seg;
    }),
  };
  if (!out.sequenceOk) {
    out.problems.push('阶段序列/条数与基线不同：' + JSON.stringify(rows.map(function (r) { return r.stage + '#' + r.seg; }))
      + ' vs ' + JSON.stringify(baseRows.map(function (r) { return r.stage + '#' + r.seg; })));
    return out;
  }
  const SEMANTIC = {
    route: function (s) { return s.indexOf(templateOf(api, 'sup-lead')) === 0; },
    synthesis: function (s) { return s.indexOf(templateOf(api, 'sup-lead')) === 0 && s.indexOf('你现在执行综合阶段') >= 0; },
    summary: function (s) { return s.indexOf(templateOf(api, 'sup-summarizer')) === 0; },
  };
  rows.forEach(function (r, i) {
    const b = baseRows[i];
    const key = r.stage + '#' + r.seg;
    if (r.user !== b.user) out.problems.push(key + ': user 文本不再是基线字节（本轮只允许动 system）');
    if (r.system.slice(-guard.length) !== guard) out.problems.push(key + ': 实发 system 不以事实与来源边界段结尾');
    const sem = SEMANTIC[r.stage];
    if (sem && !sem(r.system)) out.problems.push(key + ': 语义段丢失（模板原文/阶段指令不在发出的 system 里）');
    if (r.system === b.system) {
      if (b.system.slice(-guard.length) !== guard) out.problems.push(key + ': 与基线逐字节相同，但两边都不含边界段');
      out.unchanged.push(key);
      return;
    }
    if (r.system === b.system + suffix) { out.appended.push(key); return; }
    if (r.system.slice(0, Math.max(0, r.system.length - suffix.length)) !== b.system) {
      out.problems.push(key + ': 差分不只是一段 guard 追加（剥掉尾部 guard 后仍与基线不等）');
      return;
    }
    out.problems.push(key + ': 差分不是「基线 + \\n\\n + guard」这一种形态（追加位置或分隔符变了）');
  });
  return out;
}

/* T5 的字面量基线（2026-09-24 对账轮重建）。取数方式：本套件自身的一次完整跑批
 * （observed 行逐条打印 [stage, sha256(system)[0..16], sha256(user)[0..16]]，
 *  原始件 logs/syndicate/governance-cases.log），并用**独立探针**交叉复算：
 *  qa/task-scratch/XJ-5.1.19-f1-f7-final-acceptance-001/logs/reconcile/probe/reconcile-probe-02-t5.cjs
 *  （另一份 realm 实现 + 同一份产品源文件 + 逐字相同的桩回文），输出
 *   reconcile-probe-02-t5.out.txt 里 7 行指纹与本处常量逐字相同。
 * 与 T1/T2/T3 的分工：那三条钉「相对修复前基线只追加了一段 guard」，本条钉
 * 「本轮之后的绝对期望文本」—— 日后任何人（含改 supervision-syndicate-data.js 的模板、
 * 改 prompt-governance.js 的 guard 文本）动了实发字节，都必须显式重建这份指纹。 */
const T5_ROUTE_SCHOOL_SYNTH = [
  ['route', '26a2f937ec2b1348', '40fc70f67ad741fc'],
  ['school', 'd3b0eaec2ba28d3b', 'a1b2d0f1d2fcf049'],
  ['synthesis', 'ea93d752a6a48001', '520466f026c7ec8c'],
];
const T5_SUMMARY_ROUTE_SCHOOL_SYNTH = [
  ['summary', '549a64050e1f0f06', '616e63de264f24ed'],
  ['route', '26a2f937ec2b1348', '598a6b01c1363319'],
  ['school', 'd3b0eaec2ba28d3b', '9dfe3069e86ceee0'],
  ['synthesis', 'ea93d752a6a48001', '7718f7ae664b27df'],
];
// 修复前基线里 route 的 system 哈希（探针同一份输出）；T5 用它反向确认「新基线不是旧基线的副本」。
const T5_OLD_PREV_SYSTEM_SHA = { route: 'e42e77d5a79ae077', synthesis: '8db0006a91f5004a' };

async function caseAtext(newCtx, baseCtx) {
  const id = 'A-text-unchanged';
  const guard = newCtx.governance.FACT_AND_SOURCE_GUARD;
  const api = newCtx.api;

  const t1New = await traceRows(newCtx, 3000);
  const t1Base = await traceRows(baseCtx, 3000);
  const t1 = diffAgainstBaseline(t1New, t1Base, guard, api);
  check(id, 'T1 短材料（无需摘要）三阶段：差分恰为末尾追加边界段，除 guard 外逐字节不变，语义段仍在',
    t1.sequenceOk && t1.problems.length === 0 && t1New.length === 3
    && ['route#-1', 'synthesis#-1'].every(function (k) { return t1.appended.indexOf(k) >= 0; }),
    'stages=' + JSON.stringify(t1New.map(function (r) { return r.stage; })) + ' appended=' + JSON.stringify(t1.appended)
    + ' unchanged=' + JSON.stringify(t1.unchanged) + ' problems=' + JSON.stringify(t1.problems.slice(0, 3)));

  const t2New = await traceRows(newCtx, 5000);
  const t2Base = await traceRows(baseCtx, 5000);
  const t2 = diffAgainstBaseline(t2New, t2Base, guard, api);
  check(id, 'T2 单段摘要带（4001..8000）：一次摘要调用 + 四阶段，差分恰为边界段追加',
    t2.sequenceOk && t2.problems.length === 0 && t2New.length === 4 && t2New[0].stage === 'summary'
    && t2New.filter(function (r) { return r.stage === 'summary'; }).length === 1
    && ['summary#-1', 'route#-1', 'synthesis#-1'].every(function (k) { return t2.appended.indexOf(k) >= 0; }),
    'stages=' + JSON.stringify(t2New.map(function (r) { return r.stage; })) + ' appended=' + JSON.stringify(t2.appended)
    + ' problems=' + JSON.stringify(t2.problems.slice(0, 3)));

  check(id, 'T3 发出的 system 全文（非哈希）：逐条 == 基线文本或基线文本 + 一段 guard，且每条都带边界段',
    t2New.length > 0 && t2.problems.length === 0
    && t2New.every(function (r, i) { return r.system === t2Base[i].system || r.system === t2Base[i].system + '\n\n' + guard; })
    && t2New.every(function (r) { return r.system.slice(-guard.length) === guard; })
    && t2New.some(function (r, i) { return r.system !== t2Base[i].system; }),
    'chars=' + t2New.map(function (r) { return r.chars; }).join(',') + ' baseChars=' + t2Base.map(function (r) { return r.chars; }).join(','));

  check(id, 'T5 新纪元基线：三阶段实发 system/user 的 sha256 逐条等于本轮重建的期望值（防止无意的文本漂移悄悄溜过「只允许追加 guard」这条规则）',
    JSON.stringify(t1New.map(function (r) { return [r.stage, r.systemSha.slice(0, 16), r.userSha.slice(0, 16)]; })) === JSON.stringify(T5_ROUTE_SCHOOL_SYNTH)
    && JSON.stringify(t2New.map(function (r) { return [r.stage, r.systemSha.slice(0, 16), r.userSha.slice(0, 16)]; })) === JSON.stringify(T5_SUMMARY_ROUTE_SCHOOL_SYNTH)
    && T5_ROUTE_SCHOOL_SYNTH[0][1] !== T5_OLD_PREV_SYSTEM_SHA.route,
    'new3000=' + JSON.stringify(t1New.map(function (r) { return [r.stage, r.systemSha.slice(0, 16), r.userSha.slice(0, 16)]; }))
    + ' new5000=' + JSON.stringify(t2New.map(function (r) { return [r.stage, r.systemSha.slice(0, 16), r.userSha.slice(0, 16)]; }))
    + ' expected3000=' + JSON.stringify(T5_ROUTE_SCHOOL_SYNTH)
    + ' expected5000=' + JSON.stringify(T5_SUMMARY_ROUTE_SCHOOL_SYNTH));

  check(id, 'T4 基线可测性守卫：基线副本内不含治理接线与 DEC-01 常量（否则负向对照无效）',
    BASELINE_SOURCE.indexOf('registerStagePrompt') < 0 && BASELINE_SOURCE.indexOf('SUMMARY_SEGMENT_THRESHOLD') < 0
    && LIVE_SOURCE.indexOf('registerStagePrompt') >= 0,
    'baselineMd5=' + md5OfText(BASELINE_SOURCE));
  return { t1: { appended: t1.appended, unchanged: t1.unchanged }, t2: { appended: t2.appended, unchanged: t2.unchanged } };
}

/* ---------- 用例 B：DEC-01 分段可达 ---------- */
async function caseB(ctx, make) {
  const id = 'B-dec01-segmentation';
  const api = ctx.api;

  check(id, 'B0 预算常量未放宽：MAX_STAGE_INPUT_CHARS=30000、MAX_INPUT_CHARS=240000',
    api.MAX_STAGE_INPUT_CHARS === 30000 && api.MAX_INPUT_CHARS === 240000,
    api.MAX_STAGE_INPUT_CHARS + ' / ' + api.MAX_INPUT_CHARS);
  check(id, 'B1 分段触发阈值落在 (SUMMARY_THRESHOLD, 页面准入 24000) 内',
    api.SUMMARY_SEGMENT_THRESHOLD > api.SUMMARY_THRESHOLD && api.SUMMARY_SEGMENT_THRESHOLD < 24000,
    'SUMMARY_THRESHOLD=' + api.SUMMARY_THRESHOLD + ' trigger=' + api.SUMMARY_SEGMENT_THRESHOLD
    + ' windowCap=' + api.MAX_SEGMENT_CHARS + ' overlap=' + api.SEGMENT_OVERLAP_CHARS);

  const adm12000 = ctx.admission(12000);
  const adm23940 = ctx.admission(23940);
  const adm23964 = ctx.admission(23964);
  const adm23965 = ctx.admission(23965);
  check(id, 'B2 页面准入实测：12000 / 23940 / 23964 字符材料 ok=true，23965 起 MATERIAL_TOO_LONG',
    adm12000.ok === true && adm23940.ok === true && adm23964.ok === true
    && adm23965.ok === false && adm23965.errorCode === 'MATERIAL_TOO_LONG',
    '12000=' + adm12000.ok + ' 23940=' + adm23940.ok + ' 23964=' + adm23964.ok + ' 23965=' + adm23965.ok + '/' + adm23965.errorCode);

  const observed = [];
  let allSegmented = true;
  for (const chars of [8001, 12000, 12001, 20000, 23940]) {
    ctx.reset();
    const r = await ctx.run(materialChars(chars));
    const segSends = ctx.sends.filter(function (s) { return s.stage === 'summary:segment'; });
    const singleSends = ctx.sends.filter(function (s) { return s.stage === 'summary'; }).length;
    const ok = r.ok === true && (r.totalSegments || 0) >= 2 && segSends.length === r.totalSegments && singleSends === 0;
    if (!ok) allSegmented = false;
    observed.push(chars + '->segments=' + r.totalSegments + ' segCalls=' + segSends.length + ' ok=' + r.ok);
  }
  check(id, 'B3 页面典型长材料（8001/12000/12001/20000/23940）全部走分段分支，totalSegments>=2',
    allSegmented, observed.join(' ; '));

  ctx.reset();
  const coverChars = 23940;
  const coverRun = await ctx.run(materialChars(coverChars));
  const segSends = ctx.sends.filter(function (s) { return s.stage === 'summary:segment'; });
  const covered = new Set();
  segSends.forEach(function (s) { unitTokens(s.segmentBody).forEach(function (i) { covered.add(i); }); });
  const totalUnits = Math.ceil(coverChars / UNIT);
  const missing = [];
  for (let i = 0; i < totalUnits; i += 1) if (!covered.has(i)) missing.push(i);
  check(id, 'B4 分段窗口完整覆盖材料（每个合成单元至少出现在一次分段载荷里，且不静默丢材料）',
    missing.length === 0 && segSends.length === coverRun.totalSegments,
    'segments=' + segSends.length + ' totalUnits=' + totalUnits + ' missing=' + JSON.stringify(missing.slice(0, 5)));
  check(id, 'B5 每段载荷带「第 N / M 段」且 M === totalSegments',
    segSends.every(function (s, i) { return s.segment.index === i + 1 && s.segment.total === coverRun.totalSegments; }),
    JSON.stringify(segSends.map(function (s) { return s.segment; })));
  check(id, 'B6 单个分段阶段 system+user 均在 30000 预算内，且窗口不超自设上限',
    ctx.sends.every(function (s) { return s.stageChars <= api.MAX_STAGE_INPUT_CHARS && s.userChars <= api.MAX_SEGMENT_CHARS + 200; }),
    'maxStageChars=' + Math.max.apply(null, ctx.sends.map(function (s) { return s.stageChars; })) + ' cap=' + api.MAX_STAGE_INPUT_CHARS);

  const failCtx = make({ failSegments: [2] });
  const failRun = await failCtx.run(materialChars(23940));
  check(id, 'B7 页面长度注入第 2 段失败：errorCode=PARTIAL_SUMMARY、failedSegments 精确=[2]、totalSegments>=2',
    failRun.ok === false && failRun.errorCode === 'PARTIAL_SUMMARY'
    && JSON.stringify(failRun.failedSegments) === '[2]' && (failRun.totalSegments || 0) >= 2,
    JSON.stringify({ ec: failRun.errorCode, f: failRun.failedSegments, t: failRun.totalSegments }));
  const downstream = failCtx.sends.filter(function (s) { return ['route', 'school', 'synthesis'].indexOf(s.stage) >= 0; });
  check(id, 'B8 失败段短路：第 2 段之后不得有 route/school/synthesis 出网',
    downstream.length === 0, 'stages=' + JSON.stringify(failCtx.sends.map(function (s) { return s.stage; })));
  check(id, 'B9 失败文案含「第 2 段」（页面据此显示段号）',
    String(failRun.error).indexOf('第 2 段') >= 0, failRun.error);
  const failedCalls = failCtx.sends.filter(function (s) { return s.stage === 'summary:segment' && s.segment.index === 2; });
  check(id, 'B10 失败段调用次数 = 既有重试上限 2（重试策略未改，且成功段只调 1 次）',
    failedCalls.length === 2 && failCtx.sends.filter(function (s) { return s.stage === 'summary:segment' && s.segment.index === 1; }).length === 1,
    'seg2Calls=' + failedCalls.length + ' seg1Calls=' + failCtx.sends.filter(function (s) { return s.stage === 'summary:segment' && s.segment.index === 1; }).length);

  const allCtx = make({ failSegments: [1, 2, 3] });
  const allRun = await allCtx.run(materialChars(60000));
  const expectAll = Array.from({ length: allRun.totalSegments || 0 }, function (_, i) { return i + 1; });
  check(id, 'B11 全部段失败：failedSegments 精确等于 [1..N] 且严格升序（N>=2）',
    allRun.errorCode === 'PARTIAL_SUMMARY' && expectAll.length >= 2
    && JSON.stringify(allRun.failedSegments) === JSON.stringify(expectAll),
    JSON.stringify({ f: allRun.failedSegments, expect: expectAll, t: allRun.totalSegments }));

  const firstCtx = make({ failSegments: [1] });
  const firstRun = await firstCtx.run(materialChars(23940));
  check(id, 'B12 注入第 1 段失败：failedSegments 精确=[1]（不得把失败扩散成全量）',
    firstRun.errorCode === 'PARTIAL_SUMMARY' && JSON.stringify(firstRun.failedSegments) === '[1]',
    JSON.stringify(firstRun.failedSegments));

  const budgetCtx = make({ segmentReplyChars: 12000 });
  const budgetRun = await budgetCtx.run(materialChars(23940));
  /* 裁决①（压低两处 clip 上限）让「route 阶段必然超限」变成结构上不可能 —— 旧 B13 断言的
   * 正是那个已不可能出现的状态。这里改为钉住**构造性满足**：两笔裁剪之和必须小于阶段闸门、
   * 实发的每个阶段 prompt 都不得越过 30000、且 route 不再被硬拒。
   * 杀伤力由变异 M14（把摘要裁剪上限恢复成 24000）负责验证。 */
  const overStages = budgetCtx.sends.filter(function (s) { return s.stageChars > api.MAX_STAGE_INPUT_CHARS; });
  check(id, 'B13 裁决①：段摘要与材料节选之和 < 阶段闸门，实发各阶段均 <= 30000 且 route 不被硬拒',
    api.MAX_STAGE_SUMMARY_CHARS + api.MAX_STAGE_MATERIAL_CHARS < api.MAX_STAGE_INPUT_CHARS
    && overStages.length === 0
    && budgetCtx.sends.some(function (s) { return s.stage === 'route'; })
    && !(budgetRun.ok === false && budgetRun.errorCode === 'STAGE_BUDGET_EXCEEDED' && budgetRun.stage === 'route'),
    JSON.stringify({ ok: budgetRun.ok, ec: budgetRun.errorCode, stage: budgetRun.stage,
      caps: api.MAX_STAGE_SUMMARY_CHARS + '+' + api.MAX_STAGE_MATERIAL_CHARS + '<' + api.MAX_STAGE_INPUT_CHARS,
      over: overStages.map(function (s) { return s.stage + ':' + s.stageChars; }) }));

  /* 段窗规划器的全域不变量（§3.2 取值理由的落盘证据，不是手算旁白）：
   * 对 len ∈ (trigger, 260000] 逐个数：实发窗口数 == 计划段数、窗口不超
   * MAX_SEGMENT_CHARS、每个窗口的**新增**字符 > SUMMARY_THRESHOLD（不产生
   * 退化「1/1 段」，也不产生只复制重叠的碎段）、相邻窗口因重叠而无缝覆盖。 */
  let planViolations = [];
  let minStride = Infinity;
  let maxWindow = 0;
  for (let len = api.SUMMARY_SEGMENT_THRESHOLD + 1; len <= 260000; len += 1) {
    const p = api.segmentPlan(len);
    if (p.window > api.MAX_SEGMENT_CHARS) planViolations.push('window>' + api.MAX_SEGMENT_CHARS + '@' + len);
    if (p.window > maxWindow) maxWindow = p.window;
    if (p.stride <= api.SUMMARY_THRESHOLD) planViolations.push('stride<=' + api.SUMMARY_THRESHOLD + '@' + len);
    if (p.stride < minStride) minStride = p.stride;
    let count = 0;
    let prevEnd = 0;
    for (let pos = 0; pos < len; pos += (p.window - api.SEGMENT_OVERLAP_CHARS)) {
      if (pos > prevEnd) planViolations.push('gap@' + len + '/' + count);
      prevEnd = pos + p.window;
      count += 1;
    }
    if (count !== p.count) planViolations.push('count!=' + p.count + '/' + count + '@' + len);
    if (count < 2) planViolations.push('degenerate@' + len);
    if (planViolations.length > 4) break;
  }
  check(id, 'B14 段窗规划全域不变量（8001..260000 逐字符）：窗口数==计划数、窗口<=21000、每窗新增>4000、无空洞',
    planViolations.length === 0 && minStride > api.SUMMARY_THRESHOLD && maxWindow <= api.MAX_STAGE_INPUT_CHARS,
    'violations=' + JSON.stringify(planViolations.slice(0, 5)) + ' minStride=' + minStride + ' maxWindow=' + maxWindow);

  const budgetHeadroom = api.MAX_STAGE_INPUT_CHARS - maxWindow - 226 - 68;
  check(id, 'B15 分段阶段预算余量可算：30000 - 最大窗口 - 模板 226 - 指令 68 > 0',
    budgetHeadroom === 8706, 'headroom=' + budgetHeadroom);

  const totalCtx = make({});
  const over = await totalCtx.run(materialChars(240001));
  check(id, 'B16 总输入 240001 字符仍 MATERIAL_TOO_LONG 且 provider 零调用',
    over.ok === false && over.errorCode === 'MATERIAL_TOO_LONG' && totalCtx.sends.length === 0,
    JSON.stringify({ ec: over.errorCode, sends: totalCtx.sends.length }));
  const exact = await totalCtx.run(materialChars(240000));
  const exactSegs = totalCtx.sends.filter(function (s) { return s.stage === 'summary:segment'; });
  check(id, 'B17 恰为 240000 字符时接受（不误拒），分段调用数 === totalSegments 且无阶段越界',
    exact.ok === true && exactSegs.length === exact.totalSegments
    && totalCtx.sends.every(function (s) { return s.stageChars <= 30000; }),
    JSON.stringify({ ok: exact.ok, totalSegments: exact.totalSegments, segCalls: exactSegs.length,
      maxStage: Math.max.apply(null, totalCtx.sends.map(function (s) { return s.stageChars; })) }));

  return { observed: observed, segments23940: coverRun.totalSegments };
}

/* ---------- 用例 C：疑点裁决（基线实测） ---------- */
async function caseC(makeBase, makeCurrent) {
  const id = 'C-dispute';

  const failBase = makeBase({ summaryFail: true });
  const p3 = await failBase.run(materialChars(23940));
  const p3Stages = failBase.sends.map(function (s) { return s.stage; });
  check(id, 'C1 基线复现 f5-budget P-3：页面长度 + 摘要失败 => totalSegments=1、阶段序列 ["summary","summary"]',
    p3.errorCode === 'PARTIAL_SUMMARY' && p3.totalSegments === 1
    && JSON.stringify(p3Stages) === JSON.stringify(['summary', 'summary'])
    && JSON.stringify(p3.failedSegments) === '[1]',
    JSON.stringify({ ec: p3.errorCode, t: p3.totalSegments, f: p3.failedSegments, stages: p3Stages }));

  const seg2Base = makeBase({ failSegments: [2] });
  const r7a = await seg2Base.run(materialChars(72000));
  const allBase = makeBase({ failSegments: [1, 2, 3, 4] });
  const r7b = await allBase.run(materialChars(72000));
  check(id, 'C2 基线复现 f7-behavior §4 的分段样本：72000 字符 => 4 段、[2] 与 [1,2,3,4] 精确一致',
    r7a.totalSegments === 4 && JSON.stringify(r7a.failedSegments) === '[2]'
    && r7b.totalSegments === 4 && JSON.stringify(r7b.failedSegments) === '[1,2,3,4]',
    JSON.stringify({ seg2: { t: r7a.totalSegments, f: r7a.failedSegments }, all: { t: r7b.totalSegments, f: r7b.failedSegments } }));

  const adm72000 = makeBase({}).admission(72000);
  check(id, 'C3 裁决依据：72000 字符在页面准入就被拒（MATERIAL_TOO_LONG）——它只能从内核入口进去，不是页面路径',
    adm72000.ok === false && adm72000.errorCode === 'MATERIAL_TOO_LONG' && adm72000.estimatedChars > 24000,
    JSON.stringify({ ok: adm72000.ok, ec: adm72000.errorCode, estimatedChars: adm72000.estimatedChars, limit: adm72000.limitChars }));

  const baseNever = [];
  for (const chars of [4001, 8000, 8001, 12000, 20000, 23940, 23964]) {
    const probe = makeBase({});
    const r = await probe.run(materialChars(chars));
    const segCalls = probe.sends.filter(function (s) { return s.stage === 'summary:segment'; }).length;
    baseNever.push(chars + ':totalSegments=' + (r.totalSegments || 0) + ',segCalls=' + segCalls);
  }
  check(id, 'C4 基线在页面可达全域（4001..23964）从不产生分段（segCalls 恒为 0）=> 「分段分支从页面不可达」成立',
    baseNever.every(function (x) { return /segCalls=0$/.test(x); }), baseNever.join(' ; '));

  const cur = [];
  for (const chars of [12000, 23940, 23964]) {
    const probe = makeCurrent({});
    const r = await probe.run(materialChars(chars));
    cur.push(chars + ':' + r.totalSegments);
  }
  check(id, 'C5 修复后同一页面区间全部分段（totalSegments>=2），错位已消除',
    cur.every(function (x) { return Number(x.split(':')[1]) >= 2; }), cur.join(' ; '));

  return { p3Stages: p3Stages, f7: { totalSegments: r7a.totalSegments, failedSegments: r7a.failedSegments }, baseNever: baseNever, current: cur };
}

/* ---------- 用例 D：D-1（学派 INVALID_PROMPT 必须一路带到终态） ----------
 * 需求依据：F1 §3.1-3 / §7.4「超限/无效响应必须带稳定 errorCode」+ 真实 Electron 实测缺陷
 * D-1（reports/f1-f6-decision-confirm.md §6）。任务书 2 的四条判据逐条对应下面四条断言：
 * 零出网 / 不重试 / 终态可辨认（含 INVALID_PROMPT）/ 局部情况不得升级成「整单失败但没有信息」。
 * 设计取舍：不把 INVALID_PROMPT 塞进学派阶段的「整轮立刻停止」名单 —— 那会把另一派尚未
 * 损坏的真实结论一起吃掉（analyses 与综合文本都会丢），正撞「误升级成整单失败」；
 * 改成「各派如实留档 + 综合照常产出 + 终态带首个致命码并且不归档」。 */
async function caseD(make) {
  const id = 'D-invalid-prompt-terminal';
  const winniText = templateOf(make({}).api, 'sup-winnicott');
  const bothBad = make({ schoolCount: 2, mastersCoreStub: { buildRoundSystemPrompt: function () { return ''; } } });
  const rBoth = await bothBad.run(materialChars(3000));
  const schoolSends = bothBad.sends.filter(function (s) { return s.stage === 'school'; });
  check(id, 'D1 两派提示词均无效：终态 ok=false 且 errorCode===INVALID_PROMPT，stage 指到具体学派，文案带学派名（可辨认 + 有信息）',
    rBoth.ok === false && rBoth.errorCode === 'INVALID_PROMPT' && String(rBoth.stage).indexOf('school:') === 0
    && String(rBoth.error).indexOf('INVALID_PROMPT') >= 0 && String(rBoth.error).indexOf('温鉴深') >= 0
    && bothBad.api.isFatalPromptFault('INVALID_PROMPT') === true,
    JSON.stringify({ ok: rBoth.ok, errorCode: rBoth.errorCode, stage: rBoth.stage, error: String(rBoth.error).slice(0, 60) }));
  check(id, 'D2 无效 prompt 阶段零出网（出网计数不增）：学派出网 0 次，只有 route 与 synthesis 出网',
    schoolSends.length === 0 && bothBad.sends.filter(function (s) { return s.stage === 'route'; }).length === 1
    && bothBad.sends.filter(function (s) { return s.stage === 'synthesis'; }).length === 1
    && rBoth.usage.calls === 2 && rBoth.usage.byStage['school:sup-winnicott'] === undefined
    && rBoth.usage.byStage['school:sup-klein'] === undefined,
    'stages=' + JSON.stringify(bothBad.sends.map(function (s) { return s.stage; })) + ' usageCalls=' + rBoth.usage.calls
    + ' byStage=' + JSON.stringify(Object.keys(rBoth.usage.byStage)));
  check(id, 'D3 不重试：学派阶段每条提示词只走一次判定（总出网 2 == route+synthesis，没有任何 2× 重试痕迹）',
    bothBad.sends.length === 2 && bothBad.sends.filter(function (s) { return s.stage === 'route'; }).length === 1
    && bothBad.sends.filter(function (s) { return s.stage === 'synthesis'; }).length === 1
    && (bothBad.sends || []).every(function (s) { return s.stage !== 'school'; }),
    'sends=' + JSON.stringify(bothBad.sends.map(function (s) { return s.stage; })) + ' MAX_RETRIES 生效时 route 会到 2 次');
  check(id, 'D4 局部事实保留 + 不得归档：两派各自状态如实（含正常那派不得被吞）、综合文本仍在，但 archive 被跳过',
    Array.isArray(rBoth.analyses) && rBoth.analyses.length === 2
    && rBoth.analyses.every(function (a) { return a.status === 'absent' && String(a.error).indexOf('提示词结构无效') >= 0; })
    && !!rBoth.synthesis && rBoth.archive && rBoth.archive.ok === false && rBoth.archive.skipped === true
    && rBoth.archive.errorCode === 'INVALID_PROMPT',
    JSON.stringify({ analyses: rBoth.analyses.map(function (a) { return a.key + ':' + a.status + ':' + a.error; }), synChars: String(rBoth.synthesis || '').length, archive: rBoth.archive }));

  // 只有一派提示词写错：整单必须失败（不能伪装成「综合完成，可归档」），但信息必须点名那一派，
  // 且另一派的真实结论要留在 analyses 里 —— 这正是「不得误升级成整单失败而没有信息」。
  const oneBad = make({
    schoolCount: 2,
    mastersCoreStub: {
      buildRoundSystemPrompt: function (card) {
        return card && card.key === 'sup-klein' ? '' : winniText + '\n\n你是独立发言的督导师。';
      },
    },
  });
  const rOne = await oneBad.run(materialChars(3000));
  check(id, 'D5 只有克莱因派提示词写错：终态仍是 INVALID_PROMPT 且点名「柯位析」，温尼科特那派的真实结论仍在 analyses 里',
    rOne.ok === false && rOne.errorCode === 'INVALID_PROMPT' && rOne.stage === 'school:sup-klein'
    && String(rOne.error).indexOf('柯位析') >= 0
    && rOne.analyses.length === 2
    && rOne.analyses.filter(function (a) { return a.key === 'sup-winnicott'; }).every(function (a) { return a.status === 'ok' && !!a.content; })
    && rOne.analyses.filter(function (a) { return a.key === 'sup-klein'; }).every(function (a) { return a.status === 'absent'; }),
    JSON.stringify({ ok: rOne.ok, ec: rOne.errorCode, stage: rOne.stage, analyses: rOne.analyses.map(function (a) { return a.key + ':' + a.status; }) }));

  // 阳性对照：把内核换成真实实现（同一场景、只换注入）→ 两派都出网、终态成功、errorCode 为空。
  const control = make({ schoolCount: 2 });
  const rCtl = await control.run(materialChars(3000));
  check(id, 'D6 阳性对照（证明 D1-D5 的红是注入造成的，不是夹具自证）：真实内核下同一场景 2 派各出网 1 次且 ok=true / errorCode 缺省',
    rCtl.ok === true && !rCtl.errorCode && control.sends.filter(function (s) { return s.stage === 'school'; }).length === 2
    && control.sends.length === 4,
    JSON.stringify({ ok: rCtl.ok, ec: rCtl.errorCode || null, stages: control.sends.map(function (s) { return s.stage; }) }));

  // 路由阶段的 INVALID_PROMPT 也不许被压成泛化码（同一判据的另一半：稳定码不得被映射吞掉）
  check(id, 'D7 稳定码映射：stageFatalCode 保住 INVALID_PROMPT / STAGE_BUDGET_EXCEEDED，其它码仍回落成泛化码',
    make({}).api.stageFatalCode('INVALID_PROMPT', 'LEAD_ROUTE_FAILED') === 'INVALID_PROMPT'
    && make({}).api.stageFatalCode('STAGE_BUDGET_EXCEEDED', 'LEAD_ROUTE_FAILED') === 'STAGE_BUDGET_EXCEEDED'
    && make({}).api.stageFatalCode('EMPTY_RESPONSE', 'LEAD_ROUTE_FAILED') === 'LEAD_ROUTE_FAILED'
    && make({}).api.stageFatalCode('AI_FAILED', 'LEAD_SYNTHESIS_FAILED') === 'LEAD_SYNTHESIS_FAILED',
    JSON.stringify(['INVALID_PROMPT', 'STAGE_BUDGET_EXCEEDED', 'EMPTY_RESPONSE', 'AI_FAILED'].map(function (c) {
      return c + '->' + make({}).api.stageFatalCode(c, 'LEAD_ROUTE_FAILED');
    })));

  return { bothBad: { ec: rBoth.errorCode, stage: rBoth.stage, sends: bothBad.sends.length }, oneBad: { ec: rOne.errorCode }, control: { ok: rCtl.ok } };
}

/* ---------- 用例 E：D-2（分段摘要失败时核心必须把段号发出去） ----------
 * 归因（探针实测）：改前核心在 PARTIAL_SUMMARY 早退分支之前不发 progress，
 * 页面 supervision.js 的 `event.type==='summary'` 分支在失败路径上永不可达
 * （progressTypes=[]）；字段名两侧一致，不是页面读错字段 ⇒ 锅在核心侧顺序。
 * 需求依据：F1 §3.4 + 任务书 3。 */
async function caseE(ctx, make) {
  const id = 'E-progress-failed-segments';
  ctx.reset();
  const ok = await ctx.run(materialChars(12000));
  const okSummary = ctx.progressEvents.filter(function (e) { return e && e.type === 'summary'; });
  check(id, 'E1 成功路径：一条 summary 进度事件，failedSegments 为空数组，totalSegments>=2（顺序调整未动成功路径）',
    ok.ok === true && okSummary.length === 1 && JSON.stringify(okSummary[0].failedSegments) === '[]'
    && okSummary[0].totalSegments === ok.totalSegments && ok.totalSegments >= 2,
    JSON.stringify({ types: ctx.progressEvents.map(function (e) { return e.type; }), failed: okSummary[0] && okSummary[0].failedSegments, total: ok.totalSegments }));

  const bad = make({ failSegments: [2] });
  const r = await bad.run(materialChars(23940));
  const summaryEvents = bad.progressEvents.filter(function (e) { return e && e.type === 'summary'; });
  const progIdx = (function () { for (let i = 0; i < bad.events.length; i += 1) if (bad.events[i].type === 'progress' && bad.events[i].name === 'summary') return i; return -1; })();
  const lastSegSendIdx = (function () { let k = -1; for (let i = 0; i < bad.events.length; i += 1) if (bad.events[i].type === 'send' && bad.events[i].stage === 'summary:segment') k = i; return k; })();
  const downstream = bad.sends.filter(function (s) { return ['route', 'school', 'synthesis'].indexOf(s.stage) >= 0; });
  check(id, 'E2 注入第 2 段失败：核心仍发出 summary 进度事件且 failedSegments 精确 === [2]（改前这条永不到达页面 ⇒ D-2 的根因）',
    r.errorCode === 'PARTIAL_SUMMARY' && summaryEvents.length === 1
    && JSON.stringify(summaryEvents[0].failedSegments) === '[2]'
    && summaryEvents[0].totalSegments === r.totalSegments && summaryEvents[0].totalSegments >= 2,
    JSON.stringify({ types: bad.progressEvents.map(function (e) { return e.type; }), failed: summaryEvents[0] && summaryEvents[0].failedSegments, ec: r.errorCode }));
  check(id, 'E3 事件在该阶段最后一次出网之后、任何下游阶段出网之前发出（短路语义未被顺序调整破坏）',
    progIdx >= 0 && lastSegSendIdx >= 0 && progIdx > lastSegSendIdx && downstream.length === 0,
    'progressIdx=' + progIdx + ' lastSegSendIdx=' + lastSegSendIdx + ' downstream=' + JSON.stringify(downstream.map(function (s) { return s.stage; })));

  const single = make({ summaryFail: true });
  const rs = await single.run(materialChars(5000));
  const oneEvent = single.progressEvents[0] || {};
  check(id, 'E4 非分段（单次摘要）失败路径也发一条进度事件，段号为 [1]（该路径 summarized=false ⇒ 类型是 preprocess，页面据终态文案显示段号）',
    rs.errorCode === 'PARTIAL_SUMMARY' && single.progressEvents.length === 1
    && oneEvent.type === 'preprocess' && JSON.stringify(oneEvent.failedSegments) === '[1]',
    JSON.stringify({ types: single.progressEvents.map(function (e) { return e.type; }), failed: oneEvent.failedSegments, ec: rs.errorCode }));
  return { ok: { types: ctx.progressEvents.map(function (e) { return e.type; }) }, fail: { types: bad.progressEvents.map(function (e) { return e.type; }), failed: summaryEvents[0] && summaryEvents[0].failedSegments } };
}

/* ---------- 反向变异 ---------- */
const MUTANTS = [
  {
    id: 'M1-bypass-registration',
    title: '旁路登记：registerStagePrompt 不再触达治理层',
    find: "    var governance = governanceApi();\n    if (!governance) return '';",
    replace: "    var governance = null; /* MUTANT M1 */\n    if (!governance) return '';",
    cases: ['A-governance-wiring', 'A-text-unchanged'],
  },
  {
    id: 'M2-threshold-back-to-30000',
    title: '分段触发阈值改回 30000（DEC-01 回退）',
    find: '  var SUMMARY_SEGMENT_THRESHOLD = 2 * SUMMARY_THRESHOLD;',
    replace: '  var SUMMARY_SEGMENT_THRESHOLD = 30000;',
    cases: ['B-dec01-segmentation'],
  },
  {
    id: 'M3-relax-stage-budget',
    title: '放宽阶段预算 MAX_STAGE_INPUT_CHARS 30000 -> 60000',
    find: '  var MAX_STAGE_INPUT_CHARS = 30000;',
    replace: '  var MAX_STAGE_INPUT_CHARS = 60000;',
    cases: ['B-dec01-segmentation'],
  },
  {
    id: 'M4-failed-segments-reversed',
    title: 'failedSegments 写成倒序段号（乱序）',
    find: '          failedSegments.push(si + 1);',
    replace: '          failedSegments.push(segments.length - si); /* MUTANT M4 */',
    cases: ['B-dec01-segmentation'],
  },
  {
    id: 'M5-synthesis-without-template-key',
    title: 'synthesis 登记去掉 templateKey（治理层无法反查模板）',
    find: "      id: 'supervision.multi-school.synthesis.system',\n      templateKey: 'sup-lead',",
    replace: "      id: 'supervision.multi-school.synthesis.system', /* MUTANT M5 */",
    cases: ['A-governance-wiring'],
  },
  {
    id: 'M6-prompt-text-tampered',
    title: '改动 synthesis 阶段 prompt 文本（D-5 前提是文本不变）',
    find: "'\\n\\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。'",
    replace: "'\\n\\n你现在执行综合阶段！只根据材料和各学派回传，不补写缺席学派的观点。'",
    cases: ['A-text-unchanged'],
  },
  {
    id: 'M7-failed-segments-fullset',
    title: '任一段失败就把 failedSegments 写成全量段号',
    find: '          failedSegments.push(si + 1);',
    replace: '          for (var fj = 0; fj < segments.length; fj += 1) failedSegments.push(fj + 1); /* MUTANT M7 */',
    cases: ['B-dec01-segmentation'],
  },
  /* 5.1.19 对账轮新增：本轮每改一条不变量都配一条「旁路它就会转红」的变异。 */
  {
    id: 'M8-synthesis-version-derived',
    title: '综合阶段退回「版本 = 声明核 + sha256(内容)」的派生族（去掉 ownTemplateVersion 透传）',
    find: "      ownTemplateVersion: SYNTHESIS_TEMPLATE_VERSION,\n",
    replace: '      /* MUTANT M8: 丢掉自声明，条目落回内容派生族 */\n',
    cases: ['A-governance-wiring'],
  },
  {
    id: 'M9-register-before-guard',
    title: '摘要阶段把登记退回 guard 拼接之前（登记裸模板 ⇒ manifest 不再覆盖实发文本）',
    find: "      changeLog: stageChangeLog('masters.system.sup-summarizer'),\n      content: prompt.system,",
    replace: "      changeLog: stageChangeLog('masters.system.sup-summarizer'),\n      content: (card ? card.systemPrompt : ''), /* MUTANT M9: 登记的是 guard 之前的裸模板 */",
    cases: ['A-governance-wiring'],
  },
  {
    id: 'M10-route-guard-dropped',
    title: '去掉路由阶段的 guard 拼接（实发 system 回到裸模板）',
    find: "      system: appendFactAndSourceGuard(card ? card.systemPrompt : '请为临床督导材料选择最多三个学派，并以 JSON 返回。'),",
    replace: "      system: card ? card.systemPrompt : '请为临床督导材料选择最多三个学派，并以 JSON 返回.', /* MUTANT M10 */",
    cases: ['A-governance-wiring', 'A-text-unchanged'],
  },
  {
    id: 'M11-invalid-prompt-swallowed',
    title: '旁路 D-1 的致命提示词判定（INVALID_PROMPT 又被折算成「缺席 + 成功」）',
    find: '    return FATAL_PROMPT_CODES.indexOf(errorCode) >= 0;',
    replace: '    return false; /* MUTANT M11 */',
    cases: ['D-invalid-prompt-terminal'],
  },
  {
    id: 'M12-fatal-code-flattened-in-route-map',
    title: '路由/综合的稳定码映射被放宽（INVALID_PROMPT 又被压成 LEAD_ROUTE_FAILED）',
    find: '    return STAGE_FATAL_CODES.indexOf(errorCode) >= 0 ? errorCode : fallback;',
    replace: '    return errorCode === "STAGE_BUDGET_EXCEEDED" ? errorCode : fallback; /* MUTANT M12 */',
    cases: ['D-invalid-prompt-terminal'],
  },
  {
    id: 'M13-progress-after-partial-return',
    title: 'D-2 回归：把 summary 进度事件挪回 PARTIAL_SUMMARY 早退之后（失败段号再也到不了页面）',
    find: "    progress({ type: prepared.summarized ? 'summary' : 'preprocess', summarized: prepared.summarized, summaryError: prepared.summaryError, failedSegments: prepared.failedSegments || [], totalSegments: prepared.totalSegments || 0 });\n    if ((prepared.failedSegments || []).length) {",
    replace: '    /* MUTANT M13: 早退回到 progress 之前 */\n    if ((prepared.failedSegments || []).length) {',
    cases: ['E-progress-failed-segments', 'B-dec01-segmentation'],
  },
  {
    id: 'M14-clip-caps-restored',
    title: '裁决①回归：把段摘要裁剪上限恢复成 24000（route 阶段又会结构性必然超限）',
    find: '  var MAX_STAGE_SUMMARY_CHARS = 8000;   // 裁决①：原 24000',
    replace: '  var MAX_STAGE_SUMMARY_CHARS = 24000; /* MUTANT M14 */',
    cases: ['B-dec01-segmentation'],
  },
];

function buildMutant(mutant) {
  const parts = LIVE_SOURCE.split(mutant.find);
  if (parts.length !== 2) {
    throw new Error('MUTATION ANCHOR NOT UNIQUE for ' + mutant.id + ' (occurrences=' + (parts.length - 1) + ')');
  }
  const src = parts.join(mutant.replace);
  if (src === LIVE_SOURCE) throw new Error('MUTATION DID NOT APPLY for ' + mutant.id);
  const file = path.join(MUTANT_DIR, mutant.id + '.js');
  fs.writeFileSync(file, src, 'utf8');
  return { file: file, source: src };
}

async function runMutation(mutant) {
  const built = buildMutant(mutant);
  const before = RESULTS.length;
  process.stdout.write('\n--- MUTANT ' + mutant.id + ' — ' + mutant.title + ' → ' + path.relative(ROOT, built.file) + '\n');
  const make = realmFactory(built.source);
  try {
    if (mutant.cases.indexOf('A-governance-wiring') >= 0) await caseA(createRealm({ syndicateSource: built.source }));
    if (mutant.cases.indexOf('A-text-unchanged') >= 0) {
      await caseAtext(createRealm({ syndicateSource: built.source }), createRealm({ syndicateSource: BASELINE_SOURCE }));
    }
    if (mutant.cases.indexOf('B-dec01-segmentation') >= 0) {
      await caseB(createRealm({ syndicateSource: built.source }), function (opts) {
        return createRealm(Object.assign({}, opts, { syndicateSource: built.source }));
      });
    }
    const makeMutant = function (opts) { return createRealm(Object.assign({}, opts, { syndicateSource: built.source })); };
    if (mutant.cases.indexOf('D-invalid-prompt-terminal') >= 0) await caseD(makeMutant);
    if (mutant.cases.indexOf('E-progress-failed-segments') >= 0) {
      await caseE(makeMutant({}), makeMutant);
    }
  } catch (error) {
    process.stdout.write('  RED  harness threw -> ' + error.message + '\n');
  }
  const rows = RESULTS.slice(before);
  const red = rows.filter(function (r) { return !r.pass; });
  const killed = red.length > 0;
  process.stdout.write('  ' + (killed ? 'KILLED' : 'SURVIVED') + ' — red=' + red.length + '/' + rows.length
    + (killed ? ' first=' + red[0].case + ' / ' + red[0].name : '') + '\n');
  return {
    id: mutant.id, title: mutant.title, cases: mutant.cases, file: path.relative(ROOT, built.file),
    killed: killed, redCount: red.length, assertionCount: rows.length,
    red: red.map(function (r) { return { case: r.case, name: r.name, observed: r.observed }; }),
  };
}

/* ---------- main ---------- */
async function main() {
  process.stdout.write('f5-syndicate-governance — ' + (MUTATION_MODE ? 'MUTATION MODE' : 'CASE MODE') + ' @ ' + new Date().toISOString() + '\n');
  const baselineMd5 = md5File(BASELINE_COPY);
  assert.equal(baselineMd5, EXPECTED_BASELINE_MD5,
    'NEGATIVE CONTROL INVALID: baseline copy md5 ' + baselineMd5 + ' != pinned ' + EXPECTED_BASELINE_MD5);
  assert.ok(BASELINE_SOURCE.indexOf('registerStagePrompt') < 0, 'NEGATIVE CONTROL INVALID: baseline already wires governance');
  assert.ok(BASELINE_SOURCE.indexOf('SUMMARY_SEGMENT_THRESHOLD') < 0, 'NEGATIVE CONTROL INVALID: baseline already has DEC-01');
  assert.ok(LIVE_SOURCE.indexOf('registerStagePrompt') >= 0, 'SUBJECT MISSING: live source has no governance wiring');

  let mutationRows = [];
  const dumps = [];
  if (MUTATION_MODE) {
    for (const mutant of MUTANTS) mutationRows.push(await runMutation(mutant));
  } else {
    await caseA(createRealm({}));
    await caseAtext(createRealm({}), createRealm({ syndicateSource: BASELINE_SOURCE }));
    await caseB(createRealm({}), realmFactory(LIVE_SOURCE));
    await caseC(realmFactory(BASELINE_SOURCE), realmFactory(LIVE_SOURCE));
    await caseD(realmFactory(LIVE_SOURCE));
    await caseE(createRealm({}), realmFactory(LIVE_SOURCE));

    /* 载荷落盘：四条关键样本各一份（含 manifest 与 register/send 时序） */
    const d1 = createRealm({});
    const r1 = await d1.run(materialChars(12000));
    dumps.push(dumpPayloads('A-provider-path-12000chars', d1, { ok: r1.ok, totalSegments: r1.totalSegments, schools: r1.schools }));
    const d2 = createRealm({ failSegments: [2] });
    const r2 = await d2.run(materialChars(23940));
    dumps.push(dumpPayloads('B-page-23940chars-segment2-fail', d2, {
      ok: r2.ok, errorCode: r2.errorCode, failedSegments: r2.failedSegments, totalSegments: r2.totalSegments, error: r2.error,
    }));
    const d3 = realmFactory(BASELINE_SOURCE)({ summaryFail: true });
    const r3 = await d3.run(materialChars(23940));
    dumps.push(dumpPayloads('C-baseline-page-23940chars-summary-fail-f5P3', d3, {
      ok: r3.ok, errorCode: r3.errorCode, failedSegments: r3.failedSegments, totalSegments: r3.totalSegments,
      stages: d3.sends.map(function (s) { return s.stage; }),
    }));
    const d4 = realmFactory(BASELINE_SOURCE)({ failSegments: [2] });
    const r4 = await d4.run(materialChars(72000));
    dumps.push(dumpPayloads('C-baseline-core-72000chars-segment2-fail-f7-4', d4, {
      ok: r4.ok, errorCode: r4.errorCode, failedSegments: r4.failedSegments, totalSegments: r4.totalSegments,
      stages: d4.sends.map(function (s) { return s.stage; }),
    }));
    /* 对账轮新增落盘件：D-1（无效提示词的终态与出网计数）+ D-2（失败段号的进度事件） */
    const d5 = createRealm({ schoolCount: 2, mastersCoreStub: { buildRoundSystemPrompt: function () { return ''; } } });
    const r5 = await d5.run(materialChars(3000));
    dumps.push(dumpPayloads('D-invalid-prompt-terminal-2schools', d5, {
      ok: r5.ok, errorCode: r5.errorCode, stage: r5.stage, error: r5.error,
      analyses: r5.analyses, archive: r5.archive, usageCalls: r5.usage.calls, byStage: r5.usage.byStage,
      sends: d5.sends.map(function (s) { return s.stage; }),
    }));
    const d6 = createRealm({ failSegments: [2] });
    const r6 = await d6.run(materialChars(23940));
    dumps.push(dumpPayloads('D2-progress-events-segment2-fail', d6, {
      ok: r6.ok, errorCode: r6.errorCode, failedSegments: r6.failedSegments, totalSegments: r6.totalSegments,
      progressEvents: d6.progressEvents, timeline: d6.events,
    }));
  }

  const red = RESULTS.filter(function (r) { return !r.pass; });
  process.stdout.write('\nCASES: total=' + RESULTS.length + ' pass=' + (RESULTS.length - red.length) + ' red=' + red.length + '\n');
  const survivors = mutationRows.filter(function (r) { return !r.killed; });
  if (MUTATION_MODE) process.stdout.write('MUTATIONS: total=' + mutationRows.length + ' survivors=' + survivors.length + '\n');

  const tag = MUTATION_MODE ? 'governance-mutations' : 'governance-cases';
  fs.writeFileSync(path.join(OUT_DIR, tag + '.log'), RESULTS.map(function (r) {
    return (r.pass ? 'PASS' : 'RED ') + ' | ' + r.case + ' | ' + r.name + ' | ' + r.observed;
  }).join('\n') + '\n\n' + (MUTATION_MODE ? JSON.stringify(mutationRows, null, 2) : '') + '\n', 'utf8');

  const probe = createRealm({});
  fs.writeFileSync(path.join(OUT_DIR, (MUTATION_MODE ? 'governance-mutation-evidence' : 'governance-case-evidence') + '.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: MUTATION_MODE ? 'mutations' : 'cases',
      node: process.version,
      subjectMd5: {
        'app/js/supervision-syndicate.js': md5File(path.join(APP, 'supervision-syndicate.js')),
        'logs/syndicate/baseline-prechange-supervision-syndicate.js': baselineMd5,
        'app/js/prompt-governance.js': md5File(path.join(APP, 'prompt-governance.js')),
        'app/js/supervision-syndicate-data.js': md5File(path.join(APP, 'supervision-syndicate-data.js')),
        'app/js/masters-core.js': md5File(path.join(APP, 'masters-core.js')),
        'app/js/clinical-context.js': md5File(path.join(APP, 'clinical-context.js')),
        'app/js/prompts.builtin.js': md5File(path.join(APP, 'prompts.builtin.js')),
        'app/js/masters-data.js': md5File(path.join(APP, 'masters-data.js')),
      },
      budgetConstants: {
        MAX_INPUT_CHARS: probe.api.MAX_INPUT_CHARS,
        MAX_STAGE_INPUT_CHARS: probe.api.MAX_STAGE_INPUT_CHARS,
        SUMMARY_THRESHOLD: probe.api.SUMMARY_THRESHOLD,
        SUMMARY_SEGMENT_THRESHOLD: probe.api.SUMMARY_SEGMENT_THRESHOLD,
        MAX_SEGMENT_CHARS: probe.api.MAX_SEGMENT_CHARS,
        SEGMENT_OVERLAP_CHARS: probe.api.SEGMENT_OVERLAP_CHARS,
      },
      segmentPlan: [4000, 8000, 8001, 12000, 23940, 32004, 240000].map(function (len) {
        return Object.assign({ length: len }, probe.api.segmentPlan(len));
      }),
      checks: RESULTS,
      payloadDumps: dumps,
      mutations: mutationRows,
    }, null, 2), 'utf8');

  if (!MUTATION_MODE && red.length) process.exitCode = 1;
  if (MUTATION_MODE && survivors.length) process.exitCode = 1;
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
