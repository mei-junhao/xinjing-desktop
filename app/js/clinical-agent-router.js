(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./clinical-agent-tasks.js'));
  else root.ClinicalAgentRouter = factory(root.ClinicalAgentTasks);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ClinicalAgentTasks) {
  'use strict';
  if (!ClinicalAgentTasks || typeof ClinicalAgentTasks.validate !== 'function') throw new Error('clinical-agent-tasks dependency required');
  var DEFINITIONS = [
    ['countertransference-analysis', ['反移情分析', '反移情', 'countertransference analysis', 'countertransference'], ['反移情', 'countertransference']],
    ['session-review', ['会谈复盘', '会谈回顾', 'session review', 'session debrief'], ['会谈', 'session']],
    ['case-conceptualization', ['个案概念化', '案例概念化', 'case conceptualization', 'case formulation'], ['概念化', 'conceptualization', 'formulation']],
    ['next-session-hypotheses', ['下次会谈假设', '下一次会谈假设', 'next session hypotheses', 'next-session hypotheses'], ['下次会谈', 'next session']],
    ['supervision-question-builder', ['督导问题生成', '督导提问', 'supervision question', 'supervision questions'], ['督导问题', 'supervision question']],
    ['multi-school-comparison', ['多流派比较', '不同流派比较', 'multi-school comparison', 'theoretical orientation comparison'], ['多流派', 'multi-school', 'orientation comparison']],
    ['supervision-preview', ['生成整体印象', 'AI 督导', '督导整体印象', 'supervision preview', 'overall supervision impression'], ['整体印象', 'AI督导', '督导整体']]
  ];
  var TASKS = Object.create(null);
  DEFINITIONS.forEach(function (d) { var spec = ClinicalAgentTasks.project(d[0]); TASKS[d[0]] = Object.freeze({ taskId: d[0], phrases: Object.freeze(d[1].slice()), keywords: Object.freeze(d[2].slice()), effect: spec.effect, risk: spec.risk, sourceRequirements: spec.sourceRequirements, confirmationBoundary: spec.confirmationBoundary, previewFirst: true }); });
  var IDS = Object.freeze(DEFINITIONS.map(function (d) { return d[0]; }));
  function normalize(value) { return typeof value === 'string' ? value.trim().toLocaleLowerCase().replace(/[\s　]+/g, ' ') : ''; }
  function unclear(reason, candidates, matchedTerms, missingContext) { return Object.freeze({ ok: false, reason: reason || 'intent-unclear', candidates: Object.freeze((candidates || []).slice()), matchedTerms: Object.freeze((matchedTerms || []).slice()), missingContext: Object.freeze((missingContext || []).slice()) }); }
  function route(input, options) {
    if (typeof input !== 'string' || !input.trim()) return unclear('malformed-input');
    var text = normalize(input), scored = [];
    DEFINITIONS.forEach(function (d) { var phrases = d[1].filter(function (term) { return text.indexOf(normalize(term)) >= 0; }); var keywords = d[2].filter(function (term) { return text.indexOf(normalize(term)) >= 0; }); if (phrases.length || keywords.length) scored.push({ id: d[0], score: phrases.length * 3 + keywords.length, terms: phrases.concat(keywords) }); });
    if (!scored.length) return unclear('intent-unclear');
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored[0], ties = scored.filter(function (x) { return x.score === top.score; });
    if (ties.length > 1) return unclear('intent-unclear', ties.map(function (x) { return x.id; }), ties.reduce(function (a, x) { return a.concat(x.terms); }, []));
    var opts = options && typeof options === 'object' ? options : {}, missing = [], sources = Array.isArray(opts.sources) ? opts.sources : [];
    TASKS[top.id].sourceRequirements.requiredKinds.forEach(function (kind) { if (!sources.some(function (s) { return s && s.kind === kind; })) missing.push(kind); });
    return Object.freeze({ ok: true, taskId: top.id, candidates: Object.freeze([top.id]), matchedTerms: Object.freeze(top.terms.slice()), missingContext: Object.freeze(missing) });
  }
  function preview(taskId, input) {
    var spec = TASKS[taskId];
    if (!spec) return Object.freeze({ ok: false, reason: 'unknown-task' });
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.freeze({ ok: false, reason: 'malformed-request' });
    var result = ClinicalAgentTasks.validate(taskId, { effect: spec.effect, outputDisposition: 'preview', sources: input.sources, context: input.context });
    if (!result.ok) return Object.freeze({ ok: false, reason: result.reason, index: result.index, kind: result.kind });
    return Object.freeze({ ok: true, status: 'awaiting-confirmation', taskId: taskId, effect: spec.effect, risk: spec.risk, sources: Object.freeze(input.sources.map(function (s) { return Object.freeze({ kind: s.kind, id: s.id }); })), requiredKinds: Object.freeze(spec.sourceRequirements.requiredKinds.slice()), confirmationBoundary: spec.confirmationBoundary, previewFirst: true });
  }
  function listIntents() { return Object.freeze(IDS.map(function (id) { return { taskId: id, phrases: TASKS[id].phrases.slice(), keywords: TASKS[id].keywords.slice(), effect: TASKS[id].effect, risk: TASKS[id].risk, sourceRequirements: { allowedKinds: TASKS[id].sourceRequirements.allowedKinds.slice(), requiredKinds: TASKS[id].sourceRequirements.requiredKinds.slice() }, confirmationBoundary: TASKS[id].confirmationBoundary, previewFirst: true }; })); }
  return Object.freeze({ route: route, preview: preview, listIntents: listIntents });
}));
