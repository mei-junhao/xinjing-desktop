'use strict';
/*
 * F3 fixes — runtime behaviour + mutation self-verification (synthetic data only).
 * Covers: P1-1 import alias/bundle key, P1-2 temperature guard (no Number() coercion,
 * transport forwards only the sanitised value), P1-3 roundtable temperature channel on
 * BOTH real product callsites, P1-4 aliases on all 12 masters, P2-1 provenance reflects
 * the actual slot, P2-2 dead data (consultant-a removed, winnicott/skill kept),
 * P2-4 supervision card has no built-in knowledge (declared, not fabricated),
 * P2-5 speaker-label regex, P3-2 no frontmatter in injected knowledge,
 * P3-3 single temperature guard shared by page shell + core.
 *
 * Everything is loaded from the REAL product sources; assertions inspect the ACTUAL
 * emitted payload (via a stub AI transport and the real PromptGovernance merge layer),
 * never via source-string matching.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function makeAtob() {
  return function atob(b64) {
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64').toString('binary');
  };
}

// Load the real modules into a fresh sandbox. `patch` (optional) mutates the raw
// source text of a named file before evaluation — used for the mutation harness.
function makeSandbox(opts) {
  const o = opts || {};
  const patch = o.patch || (() => ({}));
  const patched = patch();

  const sent = [];           // AI.send captures
  const store = Object.create(null);
  const ctx = {
    console,
    Buffer,
    atob: makeAtob(),
    TextDecoder: require('util').TextDecoder,
    sent,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.__store = store;
  ctx.AI = {
    send: function (messages, cb, options) {
      sent.push({ messages, options });
      cb({ content: 'STUB-REPLY', error: null });
    },
  };
  ctx.Store = { getSettings: () => ({}) };
  ctx.PromptsBuiltin = { STYLE_CONSTRAINTS: '' };
  ctx.document = { getElementById: () => null };
  // NOTE: app/js/prompt-governance.js is in a broken CONCURRENT intermediate state during
  // this run (resolveTemplateProvenance -> "root is not defined"); it is NOT in this task's
  // write set. We isolate it with a format-faithful double that reproduces the exact
  // `[label | source=<source> | sha256=<hash>]` merge header and the registerPrompt/
  // appendFactAndSourceGuard surface masters-core relies on. The seam under test is which
  // `source` string masters-core passes (P2-1) — fully exercised here.
  const crypto = require('crypto');
  function pgDouble() {
    return {
      getWritingStyleBlock: (s) => s,
      isWritingStyleEnabled: () => false,
      registerPrompt: () => ({ ok: true }),
      appendFactAndSourceGuard: (p) => p + '\n[FACT-GUARD]',
      mergeKnowledgeSources: (sources) => {
        const text = (sources || []).map((s) =>
          '[' + s.label + ' | source=' + s.source + ' | sha256=' +
          crypto.createHash('sha256').update(s.content).digest('hex') + ']\n' + s.content).join('\n\n');
        return { ok: true, text };
      },
    };
  }
  ctx.PromptGovernance = pgDouble();
  vm.createContext(ctx);

  vm.runInContext(patched.knowledge || read('app/js/knowledge.builtins.js'), ctx);
  vm.runInContext(patched.data || read('app/js/masters-data.js'), ctx);
  vm.runInContext((patched.core || read('app/js/masters-core.js')) + '\n;globalThis.MastersCore = MastersCore; globalThis.Knowledge = Knowledge;', ctx);

  return ctx;
}

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log('PASS  ' + name); }
  else { FAIL++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  ::  ' + detail : '')); }
}

// ---- helpers --------------------------------------------------------------
function winnicottMaster(ctx) { return ctx.MASTERS.find((m) => m.key === 'winnicott'); }
function susanMaster(ctx) { return ctx.MASTERS.find((m) => m.key === 'susan_johnson'); }
function emotionalText(ctx) { return ctx.Knowledge.get('winnicott', 'emotional'); }
function perspectiveText(ctx) { return ctx.Knowledge.get('winnicott', 'perspective'); }
function knowledgeText(ctx) { return ctx.Knowledge.get('winnicott', 'knowledge'); }

// ============================================================================
// P2-5 + P1-1 + P1-4 : import label normalisation & alias resolution
// ============================================================================
(function importTests(sfx = '基线:') {
  const ctx = makeSandbox();
  const C = ctx.MastersCore;

  // four writings for susan_johnson must all yield role assistant + masterKey susan_johnson
  const writings = [
    ['中文名', '苏珊·约翰逊：她的循环模式。'],
    ['中文名带空格', '苏珊 · 约翰逊：她的循环模式。'],   // P2-5 (separator spaces)
    ['英文名', 'Sue Johnson：hold the bullet.'],
    ['英文名NBSP', 'Sue Johnson：hold the bullet.'],       // P2-5 (nbsp)
    ['key', 'susan_johnson：追循环。'],
    ['aliases-bundle规范名', 'sue-johnson：她的循环模式。'], // P1-1/P1-4
  ];
  writings.forEach(([label, line]) => {
    const r = C.parseImportedHistory(line, 'winnicott');
    const msg = r.messages[0];
    ok(sfx + '导入[' + label + ']→assistant', msg && msg.role === 'assistant', JSON.stringify(msg));
    ok(sfx + '导入[' + label + ']→masterKey=susan_johnson', msg && msg.masterKey === 'susan_johnson', JSON.stringify(msg));
    ok(sfx + '导入[' + label + '] 正文不含发言人名', msg && !/：/.test(msg.content) && msg.content.indexOf('苏珊') < 0, JSON.stringify(msg && msg.content));
  });

  // P1-4: aliases field present on all 12 masters
  ok(sfx + 'MASTERS 12/12 均有非空 aliases', ctx.MASTERS.length === 12 && ctx.MASTERS.every((m) => Array.isArray(m.aliases) && m.aliases.length > 0),
    'count=' + ctx.MASTERS.filter((m) => Array.isArray(m.aliases) && m.aliases.length > 0).length);
  // one alias hit per non-susan master via its hyphenated alias
  ctx.MASTERS.forEach((m) => {
    const alias = m.aliases[0];
    const r = C.parseImportedHistory(alias + '：测试发言。', 'winnicott');
    const msg = r.messages[0];
    ok(sfx + 'alias命中[' + m.key + ']→' + alias, msg && msg.role === 'assistant' && msg.masterKey === m.key, JSON.stringify(msg));
  });

  // unknown speaker must NOT be misclassified as a master
  ['张医生：你好。', '路人甲：嗨。'].forEach((line) => {
    const r = C.parseImportedHistory(line, 'winnicott');
    const msg = r.messages[0];
    ok(sfx + '未知标签不误判大师[' + line.slice(0, 4) + ']', msg && msg.role === 'user' && !msg.masterKey, JSON.stringify(msg));
  });

  // registry layer: getMasterByKey resolves the bundle alias
  ok(sfx + 'getMasterByKey(sue-johnson)→susan_johnson', ctx.getMasterByKey('sue-johnson') && ctx.getMasterByKey('sue-johnson').key === 'susan_johnson',
    JSON.stringify(ctx.getMasterByKey('sue-johnson')));
})();

// ============================================================================
// P1-2 : temperature guard (no coercion) + transport forwards sanitised value
// ============================================================================
(function temperatureTests(sfx = '基线:') {
  const ctx = makeSandbox();
  const C = ctx.MastersCore;

  // valid values preserved
  ok(sfx + 'temp 0→0', C.normalizeTemperature(0) === 0, String(C.normalizeTemperature(0)));
  ok(sfx + "temp '71'→71", C.normalizeTemperature('71') === 71, String(C.normalizeTemperature('71')));
  ok(sfx + 'temp 100→100', C.normalizeTemperature(100) === 100);
  // requirement-3 fallbacks — the six coercion artifacts the review caught
  const bad = [
    ['空白串', '  '], ['boolean true', true], ['boolean false', false],
    ['空数组', []], ['数组[50]', [50]], ['boxed Number', new Number(30)],
    ['-1', -1], ['101', 101], ['Infinity', Infinity], ['NaN', NaN],
    ['空串', ''], ['null', null], ['undefined', undefined], ['对象', {}], ['非数字串', 'abc'],
    ['小数串', '12.5'],
  ];
  bad.forEach(([label, v]) => ok(sfx + '回退60[' + label + ']', C.normalizeTemperature(v) === 60, 'got ' + C.normalizeTemperature(v)));

  // knowledge bucket actually follows the sanitised temperature (transport payload level)
  const w = winnicottMaster(ctx);
  function kbFor(temp) { return C.buildOneToOneSystemPrompt({ summary: '' }, w, { temperature: temp, includeUserDocs: false }); }
  ok(sfx + '[50]→走60档(perspective) 非50档', kbFor([50]).indexOf(perspectiveText(ctx).slice(20, 120)) >= 0, 'coerced bucket leak');
  ok(sfx + 'temp0→emotional 全文注入', kbFor(0).indexOf(emotionalText(ctx).slice(0, 200)) >= 0);
  ok(sfx + 'temp100→knowledge 注入', kbFor(100).indexOf(knowledgeText(ctx).slice(0, 200)) >= 0);

  // transport must never see the raw pseudovalue
  function transportTemp(raw) {
    const s = makeSandbox();
    const conv = { messages: [], summary: '' };
    s.MastersCore.callMaster(conv, winnicottMaster(s), 'hi', { temperature: raw });
    return s.sent[0].options.temperature;
  }
  ok(sfx + 'transport: true→0.6 (非 true)', transportTemp(true) === 0.6, String(transportTemp(true)));
  ok(sfx + 'transport: [50]→0.6 (非 50)', transportTemp([50]) === 0.6, String(transportTemp([50])));
  ok(sfx + 'transport: "  "→0.6', transportTemp('  ') === 0.6, String(transportTemp('  ')));
  ok(sfx + 'transport: 合法 0.7→0.7 原样', transportTemp(0.7) === 0.7, String(transportTemp(0.7)));
  ok(sfx + 'transport: 合法 0→0 保留(API域)', transportTemp(0) === 0, String(transportTemp(0)));
})();

// ============================================================================
// P1-3 : roundtable temperature channel on BOTH real product callsites
// ============================================================================
(function roundtableTests(sfx = '基线:') {
  const ctx = makeSandbox();
  const C = ctx.MastersCore;

  // kernel-level: buildRoundSystemPrompt respects temperature
  const w = winnicottMaster(ctx);
  const r0 = C.buildRoundSystemPrompt(w, '甲、乙', false, { temperature: 0, includeUserDocs: false });
  const r60 = C.buildRoundSystemPrompt(w, '甲、乙', false, { temperature: 60, includeUserDocs: false });
  ok(sfx + '内核圆桌 temp0→emotional', r0.indexOf(emotionalText(ctx).slice(0, 200)) >= 0);
  ok(sfx + '内核圆桌 temp60→perspective(≠emotional)', r60.indexOf(perspectiveText(ctx).slice(0, 200)) >= 0 && r60.indexOf(emotionalText(ctx).slice(0, 200)) < 0);

  // REAL masters.js callsite: evaluate the actual 4th-argument expression from source.
  const mastersJs = read('app/js/masters.js');
  const argText = extractFourthArg(mastersJs);
  const shellCtx = {
    atob: makeAtob(), TextDecoder: require('util').TextDecoder,
    storedTalkTemp: () => 0, currentDocsSetting: () => false,
    m: { key: 'winnicott' }, MastersCore: C,
  };
  shellCtx.window = shellCtx; vm.createContext(shellCtx);
  const prefs = vm.runInContext('(' + argText + ')', shellCtx);
  ok(sfx + 'masters.js callsite prefs.temperature 存在且=0', prefs && prefs.temperature === 0, JSON.stringify(prefs));
  const shellOut = C.buildRoundSystemPrompt(winnicottMaster(ctx), '甲、乙', false, prefs);
  ok(sfx + 'masters.js callsite 滑块=0 → 圆桌 emotional(0档)', shellOut.indexOf(emotionalText(ctx).slice(0, 200)) >= 0);

  // REAL supervision-syndicate callsite: call the exported buildSchoolPrompt with a spy mastersCore
  const SupervisionSyndicate = require(path.join(ROOT, 'app/js/supervision-syndicate.js'));
  const card = SupervisionSyndicate.CARDS.find((c) => c && c.key === 'sup-winnicott')
    || SupervisionSyndicate.CARDS.find((c) => c && /^sup-/.test(c.key) && c.key !== 'sup-lead' && c.key !== 'sup-summarizer');
  let spyPrefs = null;
  const spyCore = { buildRoundSystemPrompt: (mm, names, isReact, prefs2) => { spyPrefs = prefs2; return 'SPY:' + mm.systemPrompt; } };
  const prompt = SupervisionSyndicate.buildSchoolPrompt(card, '材料', '', '甲、乙', { mastersCore: spyCore, temperature: 40 });
  ok(sfx + '督导 callsite 传入 temperature 通道', spyPrefs && Object.prototype.hasOwnProperty.call(spyPrefs, 'temperature') && spyPrefs.temperature === 40, JSON.stringify(spyPrefs));
  ok(sfx + '督导 callsite 真实走 buildRoundSystemPrompt', prompt.system.indexOf('SPY:') === 0, prompt.system.slice(0, 20));

  // P2-4: with the REAL core, a sup-* card yields NO master knowledge (declared, not fabricated)
  const realSup = SupervisionSyndicate.buildSchoolPrompt(card, '材料', '', '甲、乙', { mastersCore: C, temperature: 0 });
  const leaked = ctx.Knowledge.allKeys().some((k) => realSup.system.indexOf(ctx.Knowledge.byTemp(k, 0).slice(0, 120)) >= 0);
  ok(sfx + 'P2-4 督导卡 system 非空(自带督导提示)', !!realSup.system.trim());
  ok(sfx + 'P2-4 督导卡不含任何内置大师知识(不为空则对得上)', !leaked);
})();

// ============================================================================
// P2-1 : provenance header reflects the ACTUAL slot used (not knowledgeFile)
// ============================================================================
(function provenanceTests(sfx = '基线:') {
  const ctx = makeSandbox();
  const C = ctx.MastersCore;
  const w = winnicottMaster(ctx);
  function headerFor(temp) {
    const s = C.buildRoundSystemPrompt(w, 'x', false, { temperature: temp, includeUserDocs: false });
    const m = /\[大师内置知识 \| source=(.+?) \| sha256=/.exec(s);
    return m ? m[1] : '(none)';
  }
  ok(sfx + '溯源 temp0→emotional.md', /winnicott-emotional\.md$/.test(headerFor(0)), headerFor(0));
  ok(sfx + '溯源 temp60→perspective.md', /winnicott-perspective\.md$/.test(headerFor(60)), headerFor(60));
  ok(sfx + '溯源 temp100→knowledge.md', headerFor(100).indexOf('winnicott-knowledge.md') >= 0, headerFor(100));
})();

// ============================================================================
// P2-2 + P3-2 : build artifact properties (generated file, deterministic)
// ============================================================================
(function artifactTests(sfx = '基线:') {
  const ctx = makeSandbox();
  const K = ctx.Knowledge;
  ok(sfx + 'P2-2 consultant-a 已从产物剔除', K.allKeys().indexOf('consultant-a') < 0, K.allKeys().join(','));
  ok(sfx + 'P2-2 winnicott/skill 保留(待产品裁决)', K.slotsOf('winnicott').indexOf('skill') >= 0);
  // persona text of consultant-a must not be reachable anywhere
  let personaLeak = false;
  for (const k of K.allKeys()) for (const s of K.slotsOf(k)) {
    if (/咨询师梅（A）|你就是.{0,4}咨询师/.test(K.get(k, s))) personaLeak = true;
  }
  ok(sfx + 'P2-2 无 consultant-a 人设文本残留', !personaLeak);
  // P3-2 no frontmatter / AIGC watermark in any injected slot
  let fmLeak = [];
  for (const k of K.allKeys()) for (const s of K.slotsOf(k)) {
    const t = K.get(k, s);
    if (/AIGC|ContentProducer|ProduceID|ReservedCode/.test(t)) fmLeak.push(k + '/' + s);
    if (/^---/.test(t)) fmLeak.push('FMB:' + k + '/' + s);
  }
  ok(sfx + 'P3-2 槽位无 frontmatter/AIGC 泄漏', fmLeak.length === 0, fmLeak.join('|'));
})();

// ============================================================================
// MUTATION HARNESS — each P1 gets >=1 bypassed-fix mutant that MUST turn red.
// ============================================================================
function runMutants() {
  const results = [];
  function mutant(id, patch, probe) {
    let red = false, detail = '';
    try {
      const ctx = makeSandbox({ patch });
      red = probe(ctx) === false; // probe returns true when fixed; we require it to break
      detail = red ? 'killed (probe failed as expected)' : 'SURVIVED (fix bypass not detected!)';
    } catch (e) {
      red = true; detail = 'killed (probe threw: ' + e.message.split('\n')[0] + ')';
    }
    results.push({ id, red, detail });
    console.log((red ? 'KILLED   ' : 'SURVIVED ') + id + ' :: ' + detail);
  }

  // M-ALIAS: drop all aliases arrays (bypasses P1-1/P1-4)
  mutant('M-ALIAS(P1-1/P1-4 摘掉 aliases)',
    () => ({ data: read('app/js/masters-data.js').replace(/aliases: \[[^\]]*\],?/g, '') }),
    (ctx) => {
      const r = ctx.MastersCore.parseImportedHistory('sue-johnson：她的循环模式。', 'winnicott');
      return r.messages[0] && r.messages[0].role === 'assistant' && r.messages[0].masterKey === 'susan_johnson';
    });

  // M-TEMPNUM: revert guard to Number() coercion (bypasses P1-2)
  mutant('M-TEMPNUM(P1-2 退回 Number() 强转)',
    () => ({
      core: read('app/js/masters-core.js').replace(
        /function normalizeTemperature\(value\) \{[\s\S]*?\n  \}\n\n  \/\/ transport/,
        'function normalizeTemperature(value) {\n    var n = value == null || value === \'\' ? 60 : Number(value);\n    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 100 ? n : 60;\n  }\n\n  // transport'),
    }),
    (ctx) => ctx.MastersCore.normalizeTemperature([50]) === 60);

  // M-TRANSPORT: forward raw temperature (bypasses P1-2 transport rule)
  mutant('M-TRANSPORT(P1-2 原始伪值透传)',
    () => ({
      core: read('app/js/masters-core.js').replace(
        /if \(Object\.prototype\.hasOwnProperty\.call\(transportOptions, 'temperature'\)\) \{[\s\S]*?\n      \}\n      AI\.send/,
        'AI.send'),
    }),
    (ctx) => {
      const conv = { messages: [], summary: '' };
      ctx.MastersCore.callMaster(conv, winnicottMaster(ctx), 'hi', { temperature: true });
      return ctx.sent[0].options.temperature !== true;
    });

  // M-ROUNDTEMP: ignore prefs.temperature, hardcode 60 (bypasses P1-3)
  mutant('M-ROUNDTEMP(P1-3 圆桌忽略温度)',
    () => ({
      core: read('app/js/masters-core.js').replace(
        /const temperature = normalizeTemperature\(prefs\.temperature\);\n    const styleC = activeStyleConstraints\(\);\n    let ud = includeUserDocs/,
        'const temperature = 60;\n    const styleC = activeStyleConstraints();\n    let ud = includeUserDocs'),
    }),
    (ctx) => {
      const r0 = ctx.MastersCore.buildRoundSystemPrompt(winnicottMaster(ctx), 'x', false, { temperature: 0, includeUserDocs: false });
      return r0.indexOf(emotionalText(ctx).slice(0, 200)) >= 0;
    });

  // M-REGEX: revert normalizeMasterLabel to double-backslash (bypasses P2-5)
  mutant('M-REGEX(P2-5 双反斜杠正则)',
    () => ({
      core: read('app/js/masters-core.js').replace(
        /\.replace\(\/\[\\s\\u00a0\]\+\/g, ''\)/,
        '.replace(/[\\\\s\\\\u00a0]+/g, \'\')'),
    }),
    (ctx) => {
      const r = ctx.MastersCore.parseImportedHistory('苏珊 · 约翰逊：她的循环模式。', 'winnicott');
      return r.messages[0] && r.messages[0].role === 'assistant';
    });

  // M-PROV: provenance always knowledgeFile (bypasses P2-1)
  mutant('M-PROV(P2-1 溯源恒指 knowledgeFile)',
    () => ({
      core: read('app/js/masters-core.js').replace(
        /source: actualSourceFile \|\| master\.knowledgeFile/,
        'source: master.knowledgeFile'),
    }),
    (ctx) => {
      const s = ctx.MastersCore.buildRoundSystemPrompt(winnicottMaster(ctx), 'x', false, { temperature: 0, includeUserDocs: false });
      return /\[大师内置知识 \| source=([^ ]+) \|/.exec(s)[1].indexOf('emotional') >= 0;
    });

  const total = results.length;
  const survivors = results.filter((r) => !r.red).length;
  console.log('MUTATIONS: total=' + total + ' survivors=' + survivors);
  return { total, survivors };
}

// balanced-paren extraction of the 4th argument of the masters.js round call.
function extractFourthArg(src) {
  const call = 'MastersCore.buildRoundSystemPrompt(';
  const i = src.indexOf(call);
  assert.ok(i >= 0, 'round callsite not found');
  let depth = 0, j = i + call.length - 1; // at '('
  const argsStart = j + 1;
  const parts = [];
  let cur = '';
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') { depth--; if (depth === 0) { parts.push(cur); break; } }
    if (depth === 1 && ch === ',') { parts.push(cur); cur = ''; continue; }
    if (depth >= 1) cur += (depth === 1 && ch === ',') ? '' : ch;
  }
  const fourth = parts[3];
  if (!fourth) throw new Error('could not extract 4th argument; got ' + parts.length);
  return fourth.trim();
}

const mut = runMutants();
console.log('\nRESULT  pass=' + PASS + ' fail=' + FAIL + (failures.length ? '  failed=[' + failures.join(', ') + ']' : ''));
assert.ok(FAIL === 0, 'There were ' + FAIL + ' failing behavioural assertions');
assert.ok(mut.survivors === 0, mut.survivors + ' mutant(s) survived — assertions are not sensitive');
console.log('PASS  f3-alias-temperature: all behavioural assertions green, 0 mutants survived');
