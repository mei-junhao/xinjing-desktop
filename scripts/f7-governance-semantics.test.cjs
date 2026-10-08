/* ============================================================================
 * f7-governance-semantics.test.cjs — F7 提示词治理语义自证（5.1.19 返工轮）
 *
 * 目标（对应复审 reviews-r3 判出的 F7-P0-1 / F7-P1-2 / F7-P2）：
 *  S1 可达性：走**真实产品入口**（MastersCore.callMaster / buildOneToOneSystemPrompt /
 *      buildRoundSystemPrompt / 多学派三个 builder）篡改模板文本而**不升版本** →
 *      必须抛拒绝，且被拒文本一条都不许发给 provider（既不含篡改内容，也不含被
 *      静默替换的旧内容）。
 *  S2 版本来源：13 个 id 里 versionBasis === 'template-promptVersion' 的占比必须
 *      **严格大于半数**，并逐条列出；派生族必须是少数且逐条可解释（卡片确实没声明）。
 *  S3 guard 接线：摘要 / 路由 / 综合（+ 学派）真实送出的 system 实测含事实与来源
 *      边界段；登记时机在预算判断之前；manifest 覆盖「实际会发出的那条」。
 *  S4 语义变异：旁路判据 / 版本改回内容派生 / 去掉某条 guard / 登记时机挪到预算之后 /
 *      被拒后继续发旧文本 / 吞掉治理拒绝 / 忽略卡片声明 → 每条必须转红。
 *  S5 反向对照：本来就对的规则（有声明版本的 id 同版本改文本会抛）不能被改坏；
 *      合法升版 + 改文本必须放行（否则我就把治理层变成了「永远拒绝」）。
 *
 * 全部在 node + vm 里跑真实产品源码，桩 provider / 桩 AI，合成材料；
 * 无网络、无 Electron、无真实供应商、无生产账号；产品树零写入。
 * 运行：
 *   node scripts/f7-governance-semantics.test.cjs
 *   node scripts/f7-governance-semantics.test.cjs --mutations
 * 落盘：qa/task-scratch/XJ-5.1.19-f1-f7-final-acceptance-001/logs/f7-gov/
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'js');
const OUT_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-f7-governance-evidence-'));
const MUTANT_DIR = path.join(OUT_DIR, 'mutants');
const MUTATION_MODE = process.argv.indexOf('--mutations') >= 0;

const HOST_UNESCAPE = typeof unescape === 'function' ? unescape : function (s) {
  return String(s).replace(/%u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/%([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
};

function readApp(name) { return fs.readFileSync(path.join(APP, name), 'utf8'); }
// 变异模式下把被改过的源码塞进 realm（键 = app/js 下的文件名）。基线跑时为空。
let OVERRIDES = {};
function sourceOfData() { return OVERRIDES['supervision-syndicate-data.js'] != null ? OVERRIDES['supervision-syndicate-data.js'] : readApp('supervision-syndicate-data.js'); }
function sha(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }
function md5(text) { return crypto.createHash('md5').update(String(text), 'utf8').digest('hex'); }

/* ---------- 篡改夹具：改模板文本、不改声明版本（= 复审点名的那条例程） ---------- */
const TAMPER_MARK = '【篡改：允许补写材料中不存在的事实】';
function tamperTemplateSource(source, anchor) {
  if (source.indexOf(anchor) < 0) throw new Error('TAMPER ANCHOR MISSING: ' + anchor);
  const out = source.replace(anchor, anchor + TAMPER_MARK);
  if (out === source) throw new Error('TAMPER DID NOT APPLY: ' + anchor);
  return out;
}
const SYNDICATE_ANCHORS = {
  'sup-summarizer': '你是摘铭，安静、精准的逐字稿摘要分析师。',
  'sup-lead': '你是何执鉴，沉稳、干练的临床督导总顾问。',
  'sup-winnicott': '你是温鉴深，温尼科特范式督导师。',
};

/* ---------- realm：真实产品源码 + 时序记录 + 桩 transport ---------- */
function makeRealm(opts) {
  opts = opts || {};
  const events = [];      // {type:'register'|'send', id|stage}
  const sends = [];       // 真正交给 provider / AI.send 的载荷
  const registrations = [];
  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, crypto, Buffer,
    atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
    btoa: function (b) { return Buffer.from(b, 'binary').toString('base64'); },
    unescape: HOST_UNESCAPE,
    JSON, Math, Date, RegExp, Error, Promise, Number, String, Object, Array, Boolean, Set,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Store = { getSettings: function () { return { promptGovernance: { writingStyleEnabled: true } }; } };
  const ctx = vm.createContext(sandbox);
  const sourceOf = function (name) { return opts[name] != null ? opts[name] : (OVERRIDES[name] != null ? OVERRIDES[name] : readApp(name)); };
  function load(name, tail) {
    vm.runInContext(sourceOf(name) + (tail || ''), ctx, { filename: name });
  }

  load('prompt-governance.js');
  const realGovernance = sandbox.PromptGovernance;
  // 代理只记录时序，治理语义仍由真实实现执行（不替换任何判定）。
  sandbox.PromptGovernance = Object.assign({}, realGovernance, {
    registerPrompt: function (definition) {
      const content = String((definition && definition.content) || '');
      registrations.push({ id: String(definition && definition.id), declaredVersion: definition && definition.version, contentChars: content.length });
      events.push({ type: 'register', id: String(definition && definition.id) });
      return realGovernance.registerPrompt(definition);
    },
  });
  load('masters-data.js');
  load('supervision-syndicate-data.js');
  if (!opts.withoutMastersCore) {
    load('masters-core.js', '\n;globalThis.MastersCore = MastersCore;');
  } else {
    // 真实督导页（app/supervision.html）的脚本链里没有 masters-core.js —— 这条分支
    // 才是页面主路径，必须单独取证。
    sandbox.MastersCore = undefined;
  }
  load('supervision-syndicate.js');

  const responder = opts.responder || function (stage) {
    if (stage === 'route') return { content: '{"case_type":"综合性督导","schools":["sup-winnicott","sup-klein"],"focus":"合成关注点","workflow":"focused"}' };
    if (stage === 'summary' || stage === 'summary:segment') return { content: '一、情感脉络：合成摘要\n二、防御模式：合成摘要\n三、移情线索：合成摘要\n四、干预变化：合成摘要' };
    if (stage === 'school') return { content: '合成学派分析：只依据材料线索。' };
    if (stage === 'synthesis') return { content: '【对比表】合成对比\n【分歧点】合成分歧\n【整合建议】合成建议' };
    return { content: 'STUB-REPLY' };
  };
  function stageOf(messages) {
    const user = String((messages[1] && messages[1].content) || '');
    if (user.indexOf('请摘要以下临床材料分段') >= 0) return 'summary:segment';
    if (user.indexOf('请摘要以下临床材料') >= 0) return 'summary';
    if (user.indexOf('请判断案例类型并输出路由 JSON') >= 0) return 'route';
    if (user.indexOf('请从你的学派督导视角分析') >= 0) return 'school';
    if (user.indexOf('请输出三段式综合督导') >= 0) return 'synthesis';
    if (user.indexOf('请用 3-5 条要点') >= 0 || user.indexOf('概括以下心理咨询师生与大师的对话') >= 0) return 'conversation-summary';
    return 'other';
  }
  function record(kind, target, messages, extra) {
    const system = String((messages[0] && messages[0].content) || '');
    const user = String((messages[1] && messages[1].content) || '');
    const entry = Object.assign({
      kind: kind, stage: stageOf(messages), system: system, user: user,
      systemSha256: sha(system), stageChars: system.length + user.length,
    }, extra || {});
    sends.push(entry);
    events.push({ type: 'send', stage: entry.stage, kind: kind });
    return entry;
  }
  const provider = {
    send: function (messages, callback) {
      const entry = record('provider', provider, messages);
      const result = responder(entry.stage, messages);
      if (typeof callback === 'function') callback(result);
      return result;
    },
  };
  sandbox.AI = {
    send: function (messages, callback, options) {
      const entry = record('ai.send', sandbox.AI, messages, { temperature: options && options.temperature });
      const result = responder(entry.stage, messages);
      if (typeof callback === 'function') callback(result);
      return result;
    },
  };

  return {
    sandbox: sandbox,
    events: events, sends: sends, registrations: registrations, provider: provider,
    governance: realGovernance,
    manifest: function () { return realGovernance.getPromptManifest(); },
    entry: function (id) { return realGovernance.getPromptManifest().filter(function (r) { return r.id === id; })[0] || null; },
    mastersCore: function () { return sandbox.MastersCore; },
    masters: function () { return sandbox.MASTERS; },
    cards: function () { return sandbox.SUPERVISION_SYNDICATE; },
    card: function (key) { return sandbox.SUPERVISION_SYNDICATE.filter(function (c) { return c.key === key; })[0] || null; },
    syndicate: function () { return sandbox.SupervisionSyndicate; },
    runPipeline: function (material) {
      return sandbox.SupervisionSyndicate.runMultiSchoolSupervision({ material: material }, { provider: provider });
    },
    // 用改过的模板数据文件重新求值（= 真的有人编辑了模板文本），并重新装载读它的模块。
    applyTemplateEdit: function (newData, reloadSyndicateModule) {
      vm.runInContext(newData, ctx, { filename: 'supervision-syndicate-data.js' });
      if (reloadSyndicateModule) vm.runInContext(sourceOf('supervision-syndicate.js'), ctx, { filename: 'supervision-syndicate.js' });
    },
    reset: function () { events.length = 0; sends.length = 0; registrations.length = 0; },
  };
}

/* ---------- 断言登记 ---------- */
const RESULTS = [];
function check(name, fn) {
  let pass = false; let observed = '';
  try { observed = String(fn() || ''); pass = true; } catch (e) { observed = e && e.message ? e.message : String(e); pass = false; }
  RESULTS.push({ name: name, pass: pass, observed: observed });
  process.stdout.write((pass ? '  PASS  ' : '  RED   ') + name + (pass ? (observed ? ' -> ' + observed : '') : ' -> ' + observed) + '\n');
  return pass;
}
function must(condition, message) { if (!condition) throw new Error(message); return ''; }
function mustThrow(fn, re, label) {
  let threw = null;
  try { fn(); } catch (e) { threw = e && e.message ? e.message : String(e); }
  must(threw != null, label + '：期望抛出，实际无异常（判据没碰到）');
  must(re.test(threw), label + '：抛出的不是治理拒绝，实测 ' + threw);
  return threw;
}

/* ================= S1 可达性（真实产品入口） ================= */
const MASTER_KEYS = ['winnicott', 'lacan', 'freud', 'klein', 'jung', 'bion', 'rogers', 'beck', 'yalom', 'adler', 'susan_johnson', 'horney'];
const TAMPERED_MASTERS = ['winnicott', 'lacan', 'susan_johnson', 'horney', 'freud'];

function caseReachability() {
  const detail = { masters: [], supTemplateEdits: [], pipeline: {} };
  const realm = makeRealm({});
  const MC = realm.mastersCore();
  const conv = { messages: [], summary: '', importedContext: '' };

  /* 1) buildOneToOneSystemPrompt：12 个大师 id 全部要能真的拒 */
  MASTER_KEYS.forEach(function (key) {
    const id = 'masters.system.' + key;
    const rec = { id: id, cardFound: false, declared: '', version: '', basis: '', versionMatches: false, threw: null, hashUnchanged: false, restoreOk: true, firstRegisterOk: true };
    const card = realm.masters().filter(function (m) { return m.key === key; })[0];
    if (!card) { detail.masters.push(rec); return; }
    rec.cardFound = true;
    rec.declared = String(card.promptVersion || '');
    try { MC.buildOneToOneSystemPrompt(conv, card, { temperature: 60, includeUserDocs: false }); }   // 真实入口：先按上一版发布登记
    catch (e) { rec.firstRegisterOk = '干净文本首次登记就抛：' + e.message; }
    const before = realm.entry(id);
    if (!before) { detail.masters.push(rec); return; }
    rec.version = before.version; rec.basis = before.versionBasis;
    rec.versionMatches = before.version === card.promptVersion;
    const original = card.systemPrompt;
    card.systemPrompt = original + ' ' + TAMPER_MARK;   // 改文本、不升版
    try { MC.buildOneToOneSystemPrompt(conv, card, { temperature: 60, includeUserDocs: false }); }
    catch (e) { rec.threw = e && e.message ? e.message : String(e); }
    const after = realm.entry(id);
    rec.hashUnchanged = !!before && !!after && before.contentHash === after.contentHash;
    card.systemPrompt = original;
    // 还原后再走一次，证明「合法文本」仍能登记（不是无条件抛错）
    try { MC.buildOneToOneSystemPrompt(conv, card, { temperature: 60, includeUserDocs: false }); }
    catch (e) { rec.restoreOk = '还原后被无条件拒绝：' + e.message; }
    detail.masters.push(rec);
  });
  check('S1-a 12 个大师 id 走 buildOneToOneSystemPrompt 同版本改文本全部被拒（逐条，真实入口）', function () {
    must(detail.masters.length === 12, '只驱动了 ' + detail.masters.length + ' 个大师 id，样本不足');
    detail.masters.forEach(function (r) {
      must(r.cardFound, r.id + '：masters-data.js 里查不到该卡');
      must(!!r.declared, r.id + '：模板卡未声明 promptVersion（F7-P0-1 要求每张卡自己声明版本）');
      must(r.firstRegisterOk === true, r.id + '：' + r.firstRegisterOk);
      must(r.versionMatches, r.id + '：manifest version 未取模板自身声明，实测 ' + r.version + ' / 卡声明 ' + r.declared);
      must(r.basis === 'template-promptVersion', r.id + '：versionBasis=' + r.basis);
      must(!!r.threw && /without a version bump/.test(r.threw), r.id + '：同版本改文本没被拒（实测 threw=' + r.threw + '）');
      must(r.hashUnchanged, r.id + '：被拒后 manifest 仍被篡改版覆盖（等于静默接受）');
      must(r.restoreOk === true, r.id + '：' + r.restoreOk);
    });
    return 'killed=' + detail.masters.filter(function (r) { return !!r.threw; }).length + '/12；被拒后 manifest 未被覆盖=12/12；还原后可继续登记=12/12';
  });

  /* 2) callMaster（出网口）：被拒文本一条都不许进 provider，也不许换一条旧文本发 */
  const freud = realm.masters().filter(function (m) { return m.key === 'freud'; })[0];
  realm.reset();
  const sendsBefore = realm.sends.length;
  const originalFreud = freud.systemPrompt;
  freud.systemPrompt = originalFreud + ' ' + TAMPER_MARK;
  let callError = '';
  return new Promise(function (resolve) {
    Promise.resolve(MC.callMaster(conv, freud, '你好', { includeUserDocs: false })).then(function (r) {
      callError = 'resolved without error: ' + JSON.stringify(r).slice(0, 120);
    }, function (e) { callError = e && e.message ? String(e.message) : String(e); }).then(function () {
      freud.systemPrompt = originalFreud;
      check('S1-b callMaster 篡改后拒绝出网：provider 收到的载荷不含篡改内容也不含被替换的旧内容', function () {
        must(/without a version bump/.test(callError), 'callMaster 未抛出治理拒绝，实测 ' + callError);
        must(realm.sends.length === sendsBefore, '被拒之后仍有 ' + (realm.sends.length - sendsBefore) + ' 条载荷发给 provider');
        const leaked = realm.sends.filter(function (s) { return s.system.indexOf(TAMPER_MARK) >= 0; });
        must(leaked.length === 0, '篡改内容出现在发往 provider 的载荷里：' + JSON.stringify(leaked.map(function (s) { return s.stage; })));
        return 'sends=' + realm.sends.length + '（未增加），抛出=' + callError.slice(0, 60);
      });
      resolve(detail);
    });
  });
}

function caseSyndicateReachability(detail) {
  /* 3) 学派阶段（真实入口 buildRoundSystemPrompt）：改学派卡文本、不升版本 → 必须拒 */
  const realm = makeRealm({});
  let entryBefore = null; let threw = null; let tamperApplied = false; let tamperedCard = null;
  try {
    realm.mastersCore().buildRoundSystemPrompt(realm.card('sup-winnicott'), '甲、乙', false, { includeUserDocs: false });
    entryBefore = realm.entry('masters.system.sup-winnicott');
    realm.applyTemplateEdit(tamperTemplateSource(sourceOfData(), SYNDICATE_ANCHORS['sup-winnicott']), false);
    tamperedCard = realm.card('sup-winnicott');
    tamperApplied = !!tamperedCard && tamperedCard.systemPrompt.indexOf(TAMPER_MARK) >= 0;
    try { realm.mastersCore().buildRoundSystemPrompt(tamperedCard, '甲、乙', false, { includeUserDocs: false }); }
    catch (e) { threw = e && e.message ? e.message : String(e); }
  } catch (e) { threw = 'HARNESS: ' + e.message; }
  const entryAfter = realm.entry('masters.system.sup-winnicott');
  detail.supTemplateEdits.push({ id: 'masters.system.sup-winnicott', threw: threw, version: entryAfter && entryAfter.version });
  check('S1-c 学派卡（未声明 promptVersion 那一族）改文本不升版同样被拒：判据不再结构性失效', function () {
    must(entryBefore, '学派卡未经真实入口 buildRoundSystemPrompt 登记');
    must(tamperApplied, '学派卡文本篡改未生效（夹具失效，不能作为证据）');
    must(!!threw && /without a version bump/.test(threw), '同版本改文本没被拒，实测 threw=' + threw);
    must(entryAfter.contentHash === entryBefore.contentHash, '被拒后 manifest 被篡改版覆盖');
    return 'version=' + entryAfter.version + ' versionCore=' + entryAfter.versionCore + ' versionBasis=' + entryAfter.versionBasis;
  });

  /* 3b) roundSystem 不得把治理拒绝吞掉后改用「未登记、不带 guard 的本地文本」继续发 */
  let schoolPrompt = { system: 'HARNESS-NOT-RUN', governanceError: '' };
  try { schoolPrompt = realm.syndicate().buildSchoolPrompt(tamperedCard, '合成材料', '', '甲、乙', {}); } catch (e) { schoolPrompt = { system: '', governanceError: 'HARNESS: ' + e.message }; }
  check('S1-e roundSystem 遇治理拒绝 fail closed：本地兜底文本不得替换被拒文本，manifest 也不得被篡改版污染', function () {
    must(/without a version bump/.test(String(schoolPrompt.governanceError || '')), 'governanceError 缺失或不符：' + JSON.stringify(schoolPrompt.governanceError));
    must(schoolPrompt.system === '', '被拒后仍带回 system（会换一条未登记的本地文本继续发）：' + JSON.stringify(String(schoolPrompt.system).slice(0, 40)));
    const stillEntry = realm.entry('masters.system.sup-winnicott');
    must(stillEntry.contentHash === entryBefore.contentHash, '被拒后 manifest 又被别的登记改写了');
    return 'governanceError 已带出、system="" 、manifest 仍指向上一个好版本内容哈希';
  });

  /* 4) 整条管线：路由 / 摘要任一处文本被改 → PROMPT_GOVERNANCE_REJECTED 且零发送 */
  const stageIds = { 'sup-lead': { id: 'masters.system.sup-lead', stage: 'route' }, 'sup-summarizer': { id: 'masters.system.sup-summarizer', stage: 'summary' } };
  return Object.keys(stageIds).reduce(function (p, key) {
    return p.then(function () {
      const expect = stageIds[key];
      const r = makeRealm({ withoutMastersCore: true });
      // 4800+ 字材料：确保摘要阶段真的会跑（>SUMMARY_THRESHOLD），三个 builder 都被驱动到
      const tamperedMaterial = '合成逐字稿：' + '来访者说我很累，晚上睡不着。'.repeat(300);
      return r.runPipeline(tamperedMaterial).then(function (first) {
        r.reset();
        let editOk = false;
        try {
          r.applyTemplateEdit(tamperTemplateSource(sourceOfData(), SYNDICATE_ANCHORS[key]), true);
          editOk = String(r.card(key).systemPrompt).indexOf(TAMPER_MARK) >= 0;
        } catch (e) { editOk = false; }
        return r.runPipeline(tamperedMaterial).then(function (out) {
          const leaked = r.sends.filter(function (s) { return s.system.indexOf(TAMPER_MARK) >= 0; });
          check('S1-d 篡改 ' + key + ' 模板文本不升版：该阶段被拒且 0 条载荷出网（不发篡改文本，也不换旧文本偷发）', function () {
            must(first.ok === true, '基线管线（干净文本）就失败：' + first.errorCode + ' ' + first.error);
            must(!!r.entry(expect.id), '阶段 ' + expect.id + ' 未经真实 builder 登记');
            must(editOk === true, key + ' 的模板篡改未生效（夹具失效，不能作为证据）');
            must(out.ok === false, '管线仍返回 ok=true');
            must(out.errorCode === 'PROMPT_GOVERNANCE_REJECTED', 'errorCode=' + out.errorCode + ' error=' + out.error);
            const stageSends = r.sends.filter(function (s) { return s.stage === expect.stage; });
            must(stageSends.length === 0, '被拒阶段仍发出 ' + stageSends.length + ' 条载荷：' + JSON.stringify(r.sends.map(function (s) { return s.stage; })));
            must(leaked.length === 0, '含篡改内容的载荷出网');
            return 'stage=' + out.stage + ' 该阶段 sends=' + stageSends.length + ' 全阶段 sends=' + r.sends.length;
          });
          detail.pipeline[key] = { errorCode: out.errorCode, stage: out.stage, stageSends: r.sends.filter(function (s) { return s.stage === expect.stage; }).length };
        });
      });
    });
  }, Promise.resolve()).then(function () { return caseSchoolHardStop(detail); });
}

/* 4b) 学派阶段被治理层拒发时，整轮必须停止（不得降级成 absent 后继续综合并归档） */
function caseSchoolHardStop(detail) {
  const r = makeRealm({});
  const material = '合成逐字稿：' + '来访者说我很累，晚上睡不着。'.repeat(300);
  return r.runPipeline(material).then(function (first) {
    r.reset();
    let editOk = false;
    try {
      r.applyTemplateEdit(tamperTemplateSource(sourceOfData(), SYNDICATE_ANCHORS['sup-winnicott']), true);
      editOk = String(r.card('sup-winnicott').systemPrompt).indexOf(TAMPER_MARK) >= 0;
    } catch (e) { editOk = false; }
    return r.runPipeline(material).then(function (out) {
      check('S1-f 学派阶段被治理层拒发：整轮停止，综合阶段不得继续发送、不得归档', function () {
        must(first.ok === true, '基线管线（干净文本）就失败：' + first.errorCode + ' ' + first.error);
        must(!!first.synthesis && !!first.archive, '基线管线没走到综合/归档，夹具不足以判定');
        must(editOk === true, '学派卡篡改未生效（夹具失效）');
        must(out.ok === false, '学派被拒后管线仍 ok=true');
        must(out.errorCode === 'PROMPT_GOVERNANCE_REJECTED', 'errorCode=' + out.errorCode + ' / stage=' + out.stage);
        must(String(out.stage).indexOf('school') === 0, 'stage=' + out.stage);
        const synth = r.sends.filter(function (s) { return s.stage === 'synthesis'; });
        must(synth.length === 0, '综合阶段在学派被拒后仍发出 ' + synth.length + ' 条载荷');
        const leaked = r.sends.filter(function (s) { return s.system.indexOf(TAMPER_MARK) >= 0; });
        must(leaked.length === 0, '含篡改内容的载荷出网');
        return 'stage=' + out.stage + ' 全轮 sends=' + r.sends.length + '（0 条含篡改内容）';
      });
      detail.pipeline['sup-winnicott-round'] = { errorCode: out.errorCode, stage: out.stage, sends: r.sends.length };
      return detail;
    });
  });
}

/* ================= S2 版本来源占比 + 派生族可解释 ================= */
function caseVersionBasis() {
  const realm = makeRealm({});
  const conv = { messages: [], summary: '', importedContext: '' };
  // 复刻复审驱动出的那 13 个 id：7 位大师 + 长时记忆摘要 + 4 条学派 + 综合
  ['winnicott', 'lacan', 'horney', 'freud', 'susan_johnson', 'rogers', 'beck'].forEach(function (key) {
    const card = realm.masters().filter(function (m) { return m.key === key; })[0];
    realm.mastersCore().buildOneToOneSystemPrompt(conv, card, { temperature: 60, includeUserDocs: false });
    realm.mastersCore().buildRoundSystemPrompt(card, '甲、乙', false, { temperature: 90, includeUserDocs: false });
  });
  realm.mastersCore().maybeSummarize({ messages: Array.from({ length: 12 }, function (_, i) { return { role: i % 2 ? 'assistant' : 'user', content: 'm' + i }; }) });
  return realm.runPipeline('合成逐字稿：' + '来访者说我很累，晚上睡不着。'.repeat(300)).then(function (out) {
    const rows = realm.manifest().map(function (e) {
      return { id: e.id, version: e.version, versionCore: e.versionCore, versionBasis: e.versionBasis, provenance: e.provenance, source: e.source, templateKey: e.templateKey };
    }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    const total = rows.length;
    const declared = rows.filter(function (r) { return r.versionBasis === 'template-promptVersion'; });
    const derived = rows.filter(function (r) { return /content-metadata|content-hash/.test(r.versionBasis); });
    check('S2-a 13 个 id 中 versionBasis=template-promptVersion 严格大于半数，且派生族逐条可解释', function () {
      must(out.ok === true, '驱动管线的真实入口本身失败了：' + out.errorCode);
      must(total >= 13, 'manifest 只有 ' + total + ' 条，覆盖面不足以判定占比');
      must(declared.length * 2 > total, '声明族未过半：' + declared.length + '/' + total);
      must(derived.length * 2 < total, '内容派生族仍是多数：' + derived.length + '/' + total);
      derived.forEach(function (r) {
        const key = r.templateKey || (r.id.indexOf('masters.system.') === 0 ? r.id.slice('masters.system.'.length) : null);
        must(!!key, r.id + ' 落在派生族，却查不到对应模板卡，无法解释');
        const card = realm.cards().concat(realm.masters()).filter(function (c) { return c.key === key; })[0];
        must(!!card, r.id + ' 的模板卡 ' + key + ' 在两个模板库里都查不到');
        must(!card.promptVersion, r.id + ' 被判成派生族，但它的模板卡（' + key + '）其实声明了 promptVersion=' + card.promptVersion + ' —— 治理层谎报');
        must(r.provenance === 'verified' && r.source === 'app/js/supervision-syndicate-data.js', r.id + ' 派生族条目必须如实标出模板文件，实测 ' + r.provenance + ' / ' + r.source);
      });
      return 'total=' + total + ' template-promptVersion=' + declared.length + '（' + declared.map(function (r) { return r.id; }).join(',') + '） 派生族=' + derived.length + '（' + derived.map(function (r) { return r.id; }).join(',') + '）';
    });
    check('S2-b 每条 version 的版本核都是声明值，绝不等于内容哈希（版本与内容线性无关）', function () {
      rows.forEach(function (r) {
        const core = r.versionCore;
        must(!!core, r.id + ' 没有版本核');
        must(core.indexOf('+sha256.') < 0, r.id + ' 版本核里混进了构建元数据：' + core);
        must(sha('x').slice(0, 12) !== core, r.id + ' 版本核疑似内容派生：' + core);
      });
      return '逐条列出：' + rows.map(function (r) { return r.id + '=' + r.version + '[' + r.versionBasis + ']'; }).join(' ; ');
    });
    return rows;
  });
}

/* ================= S3 guard 接线与时序 ================= */
function caseGuardAndOrdering() {
  const guard = makeRealm({}).governance.FACT_AND_SOURCE_GUARD;
  const detail = { pages: {} };
  // (a) 真实督导页：不加载 masters-core.js（app/supervision.html 脚本链里确实没有它）
  const page = makeRealm({ withoutMastersCore: true });
  return page.runPipeline('合成逐字稿：' + '来访者说我很累，晚上睡不着。'.repeat(300)).then(function (out) {
    const systems = page.sends.map(function (s) { return s.system; });
    check('S3-a 督导页（无 MastersCore 主路径）每一条送出的 system 都以事实与来源边界结尾', function () {
      must(out.ok === true, '管线失败：' + out.errorCode + ' ' + out.error);
      must(systems.length >= 5, '只发出 ' + systems.length + ' 条 system，样本不足');
      systems.forEach(function (s, i) {
        must(s.trimEnd().endsWith(guard), '第 ' + (i + 1) + ' 条（' + page.sends[i].stage + '）不以 guard 结尾，尾部=' + JSON.stringify(s.slice(-24)));
      });
      detail.pages.page = { sends: systems.length, stages: page.sends.map(function (s) { return s.stage; }) };
      return 'stages=' + page.sends.map(function (s) { return s.stage; }).join(',') + '；摘要/路由/综合三条实测含边界段';
    });
    check('S3-b 三条关键阶段（摘要 / 路由 / 综合）实测含边界段，且 guard 兜底常量与治理层字节相同（防漂移）', function () {
      const byStage = {};
      page.sends.forEach(function (s) { if (!byStage[s.stage]) byStage[s.stage] = s.system; });
      ['summary', 'summary:segment', 'route', 'synthesis'].forEach(function (stage) {
        const sys = byStage[stage];
        if (!sys) return;
        must(sys.indexOf('事实与来源边界') >= 0, stage + ' 缺事实与来源边界段');
      });
      must(!!byStage.synthesis && byStage.synthesis.indexOf('事实与来源边界') >= 0, '综合阶段（将被归档的那段）缺边界段');
      const fallback = page.syndicate().FACT_AND_SOURCE_GUARD_FALLBACK;
      must(fallback === guard, '兜底 guard 与治理层 guard 不一致（漂移）：' + JSON.stringify(fallback.slice(-20)));
      return 'synthesis 尾部=' + JSON.stringify(byStage.synthesis.slice(-18));
    });
    check('S3-c manifest 覆盖「实际会发出的那条」：summarizer/lead/synthesis 登记内容哈希 == 发出 system 哈希', function () {
      const map = { 'masters.system.sup-summarizer': ['summary:segment', 'summary'], 'masters.system.sup-lead': ['route'], 'supervision.multi-school.synthesis.system': ['synthesis'] };
      Object.keys(map).forEach(function (id) {
        const entry = page.entry(id);
        const sent = page.sends.filter(function (s) { return map[id].indexOf(s.stage) >= 0; })[0];
        must(!!entry, id + ' 未登记');
        must(!!sent, '没抓到 ' + id + ' 对应阶段（' + map[id].join('/') + '）的真实载荷，页面阶段=' + JSON.stringify(page.sends.map(function (s) { return s.stage; })));
        must(entry.contentHash === sent.systemSha256, id + ' contentHash=' + entry.contentHash.slice(0, 12) + ' 实发=' + sent.systemSha256.slice(0, 12));
      });
      return '三条哈希一致（登记的就是发出去的那条，不是模板另一份文本）';
    });
    check('S3-d 阶段版本核按新语义升版（4.5.0），changeLog 如实写明文本被追加过', function () {
      ['masters.system.sup-summarizer', 'masters.system.sup-lead', 'supervision.multi-school.synthesis.system'].forEach(function (id) {
        const entry = page.entry(id);
        must(entry.versionCore === '4.5.0', id + ' 版本核=' + entry.versionCore + '，拼接 guard 改了文本却没升版');
        const log = entry.changeLog.join(' | ');
        must(!/prompt text unchanged/i.test(log), id + ' changeLog 仍写 "prompt text unchanged"（措辞不诚实）');
        must(/事实与来源边界/.test(log), id + ' changeLog 未写明追加了事实与来源边界段');
      });
      must(page.syndicate().STAGE_PROMPT_VERSIONS['masters.system.sup-lead'] === '4.5.0', '路由阶段版本核未声明为 4.5.0');
      return '三条 = 4.5.0，changeLog 记录 guard 追加';
    });

    /* (b) 登记时机 vs 预算判断 */
    const order = makeRealm({ withoutMastersCore: true });
    order.reset();
    return order.runPipeline('合成逐字稿：' + '来访者说我很累，晚上睡不着。'.repeat(300)).then(function () {
      // 把路由阶段顶过 30000 预算（复审 F7-P2-1② 的场景）：摘要回 24007 字符 + 材料 7205
      const longSummary = '一、情感脉络：' + '·'.repeat(24000);
      const over = makeRealm({
        withoutMastersCore: true,
        responder: function (stage) {
          if (stage === 'summary:segment' || stage === 'summary') return { content: longSummary };
          if (stage === 'route') return { content: '{"case_type":"综合性督导","schools":["sup-winnicott"],"focus":"x","workflow":"focused"}' };
          if (stage === 'school') return { content: '合成学派分析' };
          if (stage === 'synthesis') return { content: '【对比表】a\n【分歧点】b\n【整合建议】c' };
          return { content: 'STUB' };
        },
      });
      return over.runPipeline('合成材料：' + '来访者说我很累。'.repeat(900)).then(function (res) {
        check('S3-e 登记时机在预算判断之前：超预算阶段先登记、后拒发（over-coverage，不 under-report）', function () {
          const ri = over.events.findIndex(function (e) { return e.type === 'register' && e.id === 'masters.system.sup-lead'; });
          const si = over.events.findIndex(function (e) { return e.type === 'send' && e.stage === 'route'; });
          must(ri >= 0, '路由阶段从未登记（登记时机被挪走，或缺登记）');
          must(si === -1, '路由阶段竟然发出去了（预算没拦住）');
          must(res.ok === false && res.errorCode === 'STAGE_BUDGET_EXCEEDED', '期望 STAGE_BUDGET_EXCEEDED，实测 ' + res.errorCode + ' / ' + res.error);
          const entry = over.entry('masters.system.sup-lead');
          must(entry.versionCore === '4.5.0', '登记条目版本核异常：' + entry.version);
          const routeSend = over.sends.filter(function (s) { return s.stage === 'route'; });
          must(routeSend.length === 0, '预算挡下后仍有路由载荷');
          return 'register@' + ri + ' < route send(none)；超预算阶段留一条「本会发出但被预算挡下」的登记，详见报告 §4 的明确说明';
        });
        detail.ordering = { events: order.events.slice(0, 8), overBudget: res.errorCode };
        return detail;
      });
    });
  });
}

/* ================= S4 语义变异 ================= */
const MUTANTS = [
  {
    id: 'M1-rejection-judgement-bypassed', title: '把「同版本内容变更 → 拒绝」判据旁路',
    file: 'prompt-governance.js',
    find: 'if (previous && previous.versionCore === normalized.versionCore && previous.contentHash !== normalized.contentHash) {',
    replace: 'if (false) {',
  },
  {
    id: 'M2-version-back-to-content-derived', title: '判据退回成比较带内容哈希元数据的完整版本串（P0 原状）',
    file: 'prompt-governance.js',
    find: 'previous.versionCore === normalized.versionCore',
    replace: 'previous.version === normalized.version',
  },
  {
    id: 'M3-route-guard-dropped', title: '去掉路由阶段 guard 拼接（回到「只登记、不拼 guard」）',
    file: 'supervision-syndicate.js',
    find: "system: appendFactAndSourceGuard(card ? card.systemPrompt : '请为临床督导材料选择最多三个学派，并以 JSON 返回。'),",
    replace: "system: card ? card.systemPrompt : '请为临床督导材料选择最多三个学派，并以 JSON 返回。',",
  },
  {
    id: 'M4-synthesis-guard-dropped', title: '去掉综合阶段（被归档那段）的 guard 拼接',
    file: 'supervision-syndicate.js',
    find: "system: appendFactAndSourceGuard((lead ? lead.systemPrompt : '') + '\\n\\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。'),",
    replace: "system: (lead ? lead.systemPrompt : '') + '\\n\\n你现在执行综合阶段。只根据材料和各学派回传，不补写缺席学派的观点。',",
  },
  {
    id: 'M5-register-after-budget', title: '把路由阶段的登记时机挪到预算判断之后（超预算就不再登记）',
    file: 'supervision-syndicate.js',
    find: "    var rejected = registerStagePrompt({\n      id: 'masters.system.sup-lead',",
    replace: "    var rejected = (prompt.system.length + prompt.user.length > MAX_STAGE_INPUT_CHARS) ? '' : registerStagePrompt({\n      id: 'masters.system.sup-lead',",
  },
  {
    id: 'M6-send-anyway-after-rejection', title: '被拒后继续发旧文本（invokeCard 不再 fail closed）',
    file: 'supervision-syndicate.js',
    find: "    if (prompt && prompt.governanceError) {",
    replace: '    if (false) {',
  },
  {
    id: 'M7-swallow-governance-rejection-in-roundSystem', title: 'roundSystem 把治理拒绝吞掉（F7-P2-1③ 前半：换本地文本继续）',
    file: 'supervision-syndicate.js',
    find: '        if (isGovernanceRejection(e)) return { system: \'\', governanceError: messageOf(e) };',
    replace: '        /* MUTANT M7: swallow */',
  },
  {
    id: 'M8-send-unregistered-local-text-after-rejection', title: '被拒后改用未登记、不带 guard 的本地文本继续发（F7-P2-1③ 完整路径）',
    file: 'supervision-syndicate.js',
    find: [
      '        if (isGovernanceRejection(e)) return { system: \'\', governanceError: messageOf(e) };',
      "    var rejected = registerStagePrompt({\n      id: 'masters.system.' + card.key,",
      '    });\n    return { system: card.systemPrompt + ',
    ],
    replace: [
      '        /* MUTANT M8a: swallow */',
      '    var rejected = (0 && registerStagePrompt({\n      id: \'masters.system.\' + card.key,',
      '    }));\n    return { system: card.systemPrompt + ',
    ],
  },
  {
    id: 'M9-ignore-card-declaration', title: '忽略模板卡自己的 promptVersion 声明（退回内容派生族）',
    file: 'prompt-governance.js',
    find: '    if (tplVersion) {',
    replace: '    if (false) {',
  },
];

function applyMutant(mutant) {
  let mutated = readApp(mutant.file);
  const finds = Array.isArray(mutant.find) ? mutant.find : [mutant.find];
  const replaces = Array.isArray(mutant.replace) ? mutant.replace : [mutant.replace];
  finds.forEach(function (find, i) {
    const parts = mutated.split(find);
    if (parts.length !== 2) throw new Error('MUTATION ANCHOR NOT UNIQUE for ' + mutant.id + ' occurrences=' + (parts.length - 1));
    mutated = parts.join(replaces[i]);
  });
  if (mutated === readApp(mutant.file)) throw new Error('MUTATION DID NOT APPLY: ' + mutant.id);
  if (md5(mutated) === md5(readApp(mutant.file))) throw new Error('MUTATION NO BYTE CHANGE: ' + mutant.id);
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  // 变异后的源码必须先能通过语法检查，否则这条变异是「把文件改坏」而不是「改坏语义」
  try {
    new (require('vm').Script)(mutated, { filename: mutant.file });
  } catch (e) {
    throw new Error('MUTATION IS SYNTACTICALLY INVALID (不算语义证据): ' + mutant.id + ' :: ' + e.message);
  }
  fs.writeFileSync(path.join(MUTANT_DIR, mutant.id + '--' + mutant.file), mutated, 'utf8');
  const override = {}; override[mutant.file] = mutated;
  return override;
}

/* ================= S5 反向对照（没把好规则改坏） ================= */
function caseReverseControl() {
  const realm = makeRealm({});
  const PG = realm.governance;
  check('S5-a 反向对照：有声明版本的 id 同版本改文本仍会抛（这条本来就对，没被改坏）', function () {
    const mk = function (content) {
      return { id: 'masters.conversation-summary.system', version: '4.4.0', task: 't', model: 'm', author: 'a', source: 'app/js/masters-core.js', changeLog: ['x'], content: content };
    };
    PG.registerPrompt(mk('TEXT-A'));
    const threw = mustThrow(function () { PG.registerPrompt(mk('TEXT-B')); }, /without a version bump/, '非模板 id 同版本改文本');
    return threw.slice(0, 70);
  });
  check('S5-b 合法升版必须放行：同 id 版本核升级 + 文本变更 → 接受（否则治理层变成永远拒绝）', function () {
    PG.registerPrompt({ id: 'x.bump.probe', version: '4.4.0', task: 't', model: 'm', author: 'a', source: 's', changeLog: ['4.4.0 a'], content: 'OLD' });
    PG.registerPrompt({ id: 'x.bump.probe', version: '4.5.0', task: 't', model: 'm', author: 'a', source: 's', changeLog: ['4.5.0 b'], content: 'NEW' });
    const e = PG.getPromptManifest().filter(function (r) { return r.id === 'x.bump.probe'; })[0];
    must(e.version === '4.5.0' && e.contentHash === sha('NEW'), '升版后未被接受：' + JSON.stringify(e && e.version));
    return '4.4.0(OLD) → 4.5.0(NEW) 放行';
  });
  check('S5-c 同版本同内容重复登记仍幂等（产品每轮都会重登记同一模板）', function () {
    PG.registerPrompt({ id: 'x.idem.probe', version: '1.0.0', task: 't', model: 'm', author: 'a', source: 's', changeLog: ['c'], content: 'SAME' });
    PG.registerPrompt({ id: 'x.idem.probe', version: '1.0.0', task: 't', model: 'm', author: 'a', source: 's', changeLog: ['c'], content: 'SAME' });
    return 'ok';
  });
  check('S5-d 卡片声明升版后改文本必须放行（F7-P0-1 的正确用法：模板改文本→改 promptVersion）', function () {
    const card = realm.masters().filter(function (m) { return m.key === 'beck'; })[0];
    const original = card.systemPrompt;
    card.promptVersion = '4.5.1';
    card.systemPrompt = original + ' ' + TAMPER_MARK;
    let threw = null;
    try { realm.mastersCore().buildOneToOneSystemPrompt({ messages: [], summary: '' }, card, { temperature: 60, includeUserDocs: false }); }
    catch (e) { threw = e && e.message; }
    const entry = realm.entry('masters.system.beck');
    card.systemPrompt = original; card.promptVersion = '4.4.0';
    must(threw == null, '声明升版 + 改文本仍被拒（判据写死了）：' + threw);
    must(entry && entry.version === '4.5.1' && entry.contentHash === sha(original + ' ' + TAMPER_MARK), 'manifest 未反映升版后的新文本：' + JSON.stringify(entry && entry.version));
    return 'promptVersion 4.4.0→4.5.1 + 改文本 = 放行';
  });
  check('S5-e 治理层 sha256 与 node crypto 对真实模板一致（否则本套件所有哈希断言可能是假的）', function () {
    const tpl = realm.card('sup-lead').systemPrompt;
    must(realm.governance.sha256(tpl) === sha(tpl), '哈希实现不一致');
    return 'pg sha256 == node crypto（' + sha(tpl).slice(0, 12) + '）';
  });
}

/* ---------- 全量用例（基线 + 每个变异体都要跑同一套） ---------- */
function runAllCases(realmOpts) {
  RESULTS.length = 0;
  OVERRIDES = realmOpts || {};
  return Promise.resolve().then(function () { return caseReachability(); }).then(function (detail) {
    return caseSyndicateReachability(detail);
  }).then(function () {
    return caseVersionBasis();
  }).then(function () {
    return caseGuardAndOrdering();
  }).then(function () {
    caseReverseControl();
    const red = RESULTS.filter(function (r) { return !r.pass; });
    return { total: RESULTS.length, pass: RESULTS.length - red.length, red: red.map(function (r) { return { name: r.name, observed: r.observed }; }) };
  });
}

function runMutation(mutant) {
  const before = RESULTS.length;
  process.stdout.write('\n--- MUTANT ' + mutant.id + ' — ' + mutant.title + '\n');
  let override;
  try { override = applyMutant(mutant); } catch (e) {
    process.stdout.write('  ANCHOR-ERROR ' + e.message + '\n');
    return Promise.resolve({ id: mutant.id, killed: false, anchorError: e.message, red: [] });
  }
  return runAllCases(override).then(function (summary) {
    const red = summary.red.map(function (r) { return r.name; });
    process.stdout.write('  ' + (red.length ? 'KILLED' : 'SURVIVED') + ' — red=' + red.length + '/' + summary.total + (red.length ? ' first=' + red[0] : '') + '\n');
    return { id: mutant.id, title: mutant.title, killed: red.length > 0, redCount: red.length, total: summary.total, firstRed: red[0] || '', firstObserved: (summary.red[0] || {}).observed || '' };
  });
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const subjectMd5 = {};
  ['prompt-governance.js', 'masters-data.js', 'supervision-syndicate.js', 'masters-core.js', 'supervision-syndicate-data.js'].forEach(function (f) {
    subjectMd5['app/js/' + f] = md5(readApp(f));
  });
  if (!MUTATION_MODE) {
    return runAllCases({}).then(function (summary) {
      fs.writeFileSync(path.join(OUT_DIR, 'f7-governance-semantics-baseline.json'), JSON.stringify({
        at: new Date().toISOString(), level: 'node 实测（真实产品源码 + 桩 transport，无网络/无真实供应商）',
        subjectMd5: subjectMd5, cases: RESULTS, summary: summary,
      }, null, 1), 'utf8');
      process.stdout.write('\nCASES: total=' + summary.total + ' pass=' + summary.pass + ' red=' + summary.red.length + '\n');
      summary.red.forEach(function (r) { process.stdout.write('  RED ' + r.name + ' -> ' + r.observed + '\n'); });
      process.exitCode = summary.red.length === 0 ? 0 : 1;
    });
  }
  const rows = [];
  return runAllCases({}).then(function (base) {
    process.stdout.write('BASELINE: total=' + base.total + ' red=' + base.red.length + '\n');
    if (base.red.length) {
      base.red.forEach(function (r) { process.stdout.write('  BASELINE-RED ' + r.name + ' -> ' + r.observed + '\n'); });
      process.exitCode = 1;
      return;
    }
  }).then(function () {
    const chain = MUTANTS.reduce(function (p, m) {
      return p.then(function () { return runMutation(m).then(function (r) { rows.push(r); }); });
    }, Promise.resolve());
    return chain.then(function () {
      const survivors = rows.filter(function (r) { return !r.killed; });
      fs.writeFileSync(path.join(OUT_DIR, 'f7-governance-semantics-mutations.json'), JSON.stringify({
        at: new Date().toISOString(), subjectMd5: subjectMd5, mutants: rows,
        survivors: survivors.map(function (s) { return s.id; }),
      }, null, 1), 'utf8');
      process.stdout.write('\nMUTATIONS: total=' + rows.length + ' survivors=' + survivors.length + '\n');
      rows.forEach(function (r) {
        process.stdout.write('  ' + (r.killed ? 'KILLED   ' : 'SURVIVED ') + r.id + ' :: red=' + r.redCount + '/' + r.total + ' 红在「' + (r.firstRed || r.anchorError || '') + '」\n          观测：' + String(r.firstObserved).slice(0, 160) + '\n');
      });
      process.exitCode = survivors.length === 0 ? 0 : 1;
    });
  });
}

main().then(undefined, function (e) {
  process.stdout.write('HARNESS ERROR: ' + (e && e.stack || e) + '\n');
  process.exitCode = 1;
});
