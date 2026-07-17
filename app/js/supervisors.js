/* ============================================================
   心镜 XinJing — 督导师身份管理（AI 督导，付费功能）
   职责：
   - 内置温尼科特取向督导师身份（方法论提示词从 prompts.builtin.js 加载，
     不以明文写在本文件，也不写入 IndexedDB，保护方法论 IP）
   - 复刻 chat ai-supervisor 的 system prompt 结构：
     方法论提示词 + 表达风格约束(STYLE_CONSTRAINTS) + 身份 guard(PERSONA_GUARD)
   - 首次启动时把内置默认身份元数据种进 Store（仅 id/name/builtin，不含 prompt）
   - 供「设置页」管理与「会谈/督导页 AI 督导」选择使用
   ⚠️ 本模块须在 HTML 中先于 prompts.builtin.js 之后、但在本文件之前加载 prompts.builtin.js。
   ============================================================ */

const Supervisors = (() => {
  'use strict';

  // 内置提示词从 PromptsBuiltin（Base64 编码）运行时解码获取，不在此文件以明文存放常量。
  // 仓颉版方法论提示词
  const CANGJIE_PROMPT = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.getCangjiePrompt() : '';

  // 女娲版方法论提示词
  const NVWA_PROMPT = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.getNvwaPrompt() : '';

  // 表达风格约束与身份 guard（与 chat 同源，从 PromptsBuiltin 获取——非方法论 IP 但集中管理）
  const STYLE_CONSTRAINTS = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
  const WINNICOTT_PERSONA_GUARD = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.WINNICOTT_PERSONA_GUARD : '';

  // 旧版单一温尼科特提示词（向后兼容 session.js 的 AI 督导下拉默认项）
  const WINNICOTT_PROMPT = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.getWinnicottPrompt() : '';

  const PERSPECTIVE_PROMPTS = {
    freud: '采用经典精神分析督导取向：围绕无意识冲突、防御、移情与反移情形成可检验的临床假设；保持中立和节制，紧扣材料原句。',
    jung: '采用分析心理学督导取向：关注象征、意象、原型与自性化线索，并区分材料事实和象征性假设。',
    klein: '采用克莱因客体关系督导取向：关注分裂、投射性认同、偏执-分裂位与抑郁位在治疗关系中的表现。',
    adler: '采用个体心理学督导取向：关注行为目的、社会兴趣、自卑体验与生活风格，形成鼓励性且可行动的提问。',
    lacan: '采用结构主义精神分析督导取向：回到材料文本，关注能指链、重复、停顿和语言裂缝，不把概念代替临床证据。',
    bion: '采用容器理论督导取向：关注容器-被容者、α功能、β元素及治疗师承受和转化未被思考经验的能力。',
    beck: '采用认知行为疗法督导取向：识别自动思维、信念和认知偏差，并提出可验证的行为实验与会谈步骤。',
    rogers: '采用以人为中心督导取向：关注共情、无条件积极关注与真诚一致，帮助咨询师辨认关系中的不一致体验。',
    yalom: '采用存在主义督导取向：关注死亡、自由、孤独、意义及治疗关系的此时此地，避免脱离材料进行哲学泛化。',
    'sue-johnson': '采用情绪聚焦督导取向：关注依恋需要、情绪加工和互动循环，提出可观察的情绪线索与回应步骤。',
    generic: '采用整合督导取向：进行案例概念化、治疗关系评估、伦理检查与进程管理，优先选择最贴合当前材料的框架。',
  };

  const SUPERVISION_BOUNDARY = [
    '角色边界：你是心理治疗临床督导助手，不是任何历史人物本人，也不扮演或暗示自己是理论大师。',
    '只理解用户提供的临床材料；明确区分材料事实、咨询师体验和工作假设，不补写材料中不存在的事实。',
    '优先分析治疗关系、移情与反移情、设置、风险和可行动的下一步，并用开放问题保留不确定性。',
  ].join('\n');

  const SUPERVISOR_REGISTRY = Object.freeze([
    { id: 'cangjie', displayName: '仓颉版温尼科特督导师', methodKey: 'cangjie', isWinnicott: true, mark: '仓', desc: '结构更完整，逐层辨认设置、抱持、依赖与反移情线索。', legacyAliases: [] },
    { id: 'nvwa', displayName: '女娲版温尼科特督导师', methodKey: 'nvwa', isWinnicott: true, mark: '女', desc: '更温暖和关系导向，先容纳咨询师体验，再形成临床假设。', legacyAliases: ['builtin-winnicott', 'winnicott'] },
    { id: 'builtin-freud', displayName: '经典精神分析取向', methodKey: 'freud', mark: '精', desc: '无意识冲突、防御机制、移情与反移情。', legacyAliases: ['freud'] },
    { id: 'builtin-jung', displayName: '分析心理学取向', methodKey: 'jung', mark: '析', desc: '象征、意象、原型与自性化过程。', legacyAliases: ['jung'] },
    { id: 'builtin-klein', displayName: '克莱因客体关系取向', methodKey: 'klein', mark: '客', desc: '分裂、投射性认同与早期客体关系。', legacyAliases: ['klein'] },
    { id: 'builtin-adler', displayName: '个体心理学取向', methodKey: 'adler', mark: '个', desc: '行为目的、社会兴趣与生活风格。', legacyAliases: ['adler'] },
    { id: 'builtin-lacan', displayName: '结构主义精神分析取向', methodKey: 'lacan', mark: '构', desc: '能指链、欲望与语言中的裂缝。', legacyAliases: ['lacan'] },
    { id: 'builtin-bion', displayName: '容器理论取向', methodKey: 'bion', mark: '容', desc: '容器-被容者、α功能与未被思考的经验。', legacyAliases: ['bion'] },
    { id: 'builtin-beck', displayName: '认知行为疗法取向', methodKey: 'beck', mark: '认', desc: '自动思维、核心信念与行为实验。', legacyAliases: ['beck'] },
    { id: 'builtin-rogers', displayName: '以人为中心取向', methodKey: 'rogers', mark: '人', desc: '共情、无条件积极关注与真诚一致。', legacyAliases: ['rogers'] },
    { id: 'builtin-yalom', displayName: '存在主义取向', methodKey: 'yalom', mark: '存', desc: '死亡、自由、孤独、意义与此时此地。', legacyAliases: ['yalom'] },
    { id: 'builtin-sue-johnson', displayName: '情绪聚焦取向', methodKey: 'sue-johnson', mark: '情', desc: '依恋需要、情绪加工与互动循环。', legacyAliases: ['sue-johnson'] },
    { id: 'builtin-generic', displayName: '整合取向', methodKey: 'generic', mark: '整', desc: '案例概念化、治疗关系、伦理与进程管理。', legacyAliases: ['generic'] },
  ].map(function (item) {
    return Object.freeze(Object.assign({ isWinnicott: false, saveName: item.displayName, entitlement: 'ai-supervise' }, item));
  }));

  const ALIASES = {};
  SUPERVISOR_REGISTRY.forEach(function (item) {
    ALIASES[item.id] = item.id;
    ALIASES[item.methodKey] = item.id;
    item.legacyAliases.forEach(function (alias) { ALIASES[alias] = item.id; });
  });

  function normalizeId(value) { return ALIASES[String(value || '').trim()] || null; }
  function getDefinition(value) {
    const id = normalizeId(value);
    return id ? SUPERVISOR_REGISTRY.find(function (item) { return item.id === id; }) || null : null;
  }
  function getDisplayName(value) {
    const item = getDefinition(value);
    return item ? item.displayName : '';
  }

  const BUILTINS_META = {};
  const BUILTINS = {};
  SUPERVISOR_REGISTRY.forEach(function (item) {
    const meta = { id: item.id, name: item.displayName, desc: item.desc, builtin: true, createdAt: '1970-01-01T00:00:00.000Z' };
    BUILTINS_META[item.id] = meta;
    BUILTINS[item.id] = Object.assign({}, meta, { prompt: item.isWinnicott ? (item.id === 'cangjie' ? CANGJIE_PROMPT : NVWA_PROMPT) : PERSPECTIVE_PROMPTS[item.methodKey] });
  });

  function buildSystemPrompt(mode) {
    const definition = getDefinition(mode);
    if (!definition) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[Supervisors] Unknown supervisor id:', mode);
      return '';
    }
    let base = definition.isWinnicott
      ? (definition.id === 'cangjie' ? CANGJIE_PROMPT : NVWA_PROMPT)
      : PERSPECTIVE_PROMPTS[definition.methodKey];
    if (!base) return '';
    const ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    return base + '\n\n' + STYLE_CONSTRAINTS + '\n\n' + SUPERVISION_BOUNDARY
      + (ud ? '\n\n[我的资料库]\n' + ud : '');
  }

  function getBuiltinList() {
    return SUPERVISOR_REGISTRY.map(function (item) {
      return { id: item.id, name: item.displayName, displayName: item.displayName, desc: item.desc, mark: item.mark, isWinnicott: item.isWinnicott, builtin: true };
    });
  }

  function ensureSeed() {
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return;
    const existing = Store.getSupervisorIdentities() || [];
    const have = new Set(existing.filter((s) => s.builtin).map((s) => s.id));
    // 补齐缺失的内置身份（仅存元数据，不含 prompt 明文）
    Object.keys(BUILTINS_META).forEach((k) => {
      if (!have.has(k)) {
        Store.createSupervisorIdentity(Object.assign({}, BUILTINS_META[k], { prompt: '' }));
      }
    });
    // 一次性清洗：旧版会往 builtin 记录写明文 prompt，改版后须抹空（生成走源码常量，不受影响）
    existing.filter((s) => s.builtin && s.prompt).forEach((s) => {
      try { Store.updateSupervisorIdentity({ id: s.id, prompt: '' }); } catch (e) {}
    });
  }

  function list() {
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return Object.keys(BUILTINS).map((k) => BUILTINS[k]);
    return Store.getSupervisorIdentities();
  }

  function getById(id) {
    const normalized = normalizeId(id);
    if (normalized && BUILTINS[normalized]) return BUILTINS[normalized];
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentity) return null;
    return Store.getSupervisorIdentity(id) || null;
  }

  return {
    CANGJIE_PROMPT, NVWA_PROMPT, STYLE_CONSTRAINTS, WINNICOTT_PERSONA_GUARD,
    WINNICOTT_PROMPT, SUPERVISION_BOUNDARY, SUPERVISOR_REGISTRY, BUILTINS,
    normalizeId, getDefinition, getDisplayName, buildSystemPrompt, ensureSeed, list, getById, getBuiltinList,
  };
})();

if (typeof window !== 'undefined') {
  window.Supervisors = Supervisors;
}
