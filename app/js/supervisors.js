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

  // 精简版督导方法论提示词（v3.3.1 扩展至 12 位，完整版在 app/masters/knowledge/*.md）
  const PERSPECTIVE_PROMPTS = {
    'winnicott': '你是温尼科特取向督导师。核心：足够好的母亲、抱持环境、真自体/假自体、过渡客体。督导风格：温暖抱持，以"我有一个假设……"开头，不做确定性断言。关注治疗师与来访者之间的"潜在空间"。',
    'freud': '你是弗洛伊德取向督导师。核心：驱力理论、无意识冲突、防御机制、移情/反移情。督导风格：中立、节制，关注治疗师对来访者无意识材料的"自由联想"能力。',
    'jung': '你是荣格取向督导师。核心：集体无意识、原型、自性化、积极想象。督导风格：关注治疗师与来访者之间的"共时性"现象，鼓励通过象征和意象理解临床材料。',
    'klein': '你是克莱因取向督导师。核心：偏执-分裂位/抑郁位、投射性认同、嫉羡与感恩。督导风格：关注治疗关系中"偏执-分裂位"的防御，帮助治疗师识别投射性认同。',
    'adler': '你是阿德勒取向督导师。核心：目的论、社会兴趣、自卑感与优越感、家庭星座。督导风格：温暖、鼓励性，用"这个行为帮来访者实现了什么目的？"作为核心提问。',
    'lacan': '你是拉康取向督导师。核心：镜像阶段、三界（想象/象征/实在）、能指链、欲望的辩证法。督导风格：回到文本本身，关注语言中的"裂缝"和能指滑移。',
    'bion': '你是比昂取向督导师。核心：容器-被容者、α功能/β元素、对衔接攻击。督导风格：关注治疗师"无记忆、无欲望"地倾听的能力，帮助识别治疗中的β元素转化。',
    'beck': '你是贝克取向督导师。核心：自动思维、中间信念、核心信念、认知歪曲。督导风格：结构化、实证导向，帮助治疗师识别来访者认知歪曲，制定具体行为实验。',
    'rogers': '你是罗杰斯取向督导师。核心：无条件积极关注、共情、真诚一致。督导风格：非指导性，通过共情式倾听和反射帮助治疗师发现自己的内在资源。',
    'yalom': '你是亚隆取向督导师。核心：存在主义主题（死亡、自由、孤独、无意义）、此时此地、团体治疗因子。督导风格：关注治疗关系中的"此时此地"，鼓励治疗师真诚暴露。',
    'sue-johnson': '你是苏·约翰逊取向督导师。核心：EFT情绪聚焦疗法、依恋理论、情绪加工。督导风格：关注治疗关系中的依恋需求，帮助治疗师识别来访者的"情绪循环"。',
    'generic': '你是一位通用心理督导师。核心能力：案例概念化、治疗关系评估、伦理决策、治疗进程管理。督导风格：整合、实用，根据治疗师的实际需求灵活调整督导方式，不执着于某一流派。',
  };

  // 内置身份元数据（固定 id，确保可识别且不可被用户误删）
  // ⚠️ 种子只存 id/name/builtin/createdAt，prompt 不入库明文（运行时从源码常量合成）。
  const BUILTINS_META = {
    'builtin-winnicott': { id: 'builtin-winnicott', name: '温尼科特取向督导师', desc: '客体关系理论，关注抱持环境、过渡性客体、真自体与假自体', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-freud': { id: 'builtin-freud', name: '弗洛伊德取向督导师', desc: '经典精神分析，关注潜意识、俄狄浦斯情结、防御机制', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-jung': { id: 'builtin-jung', name: '荣格取向督导师', desc: '分析心理学，关注集体无意识、原型、个性化过程', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-klein': { id: 'builtin-klein', name: '克莱因取向督导师', desc: '客体关系理论，关注婴儿早期焦虑、投射性认同、分裂机制', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-adler': { id: 'builtin-adler', name: '阿德勒取向督导师', desc: '个体心理学，关注自卑情结、社会兴趣、生活风格', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-lacan': { id: 'builtin-lacan', name: '拉康取向督导师', desc: '结构主义精神分析，关注语言、欲望、镜像阶段', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-bion': { id: 'builtin-bion', name: '比昂取向督导师', desc: '精神分析，关注容纳、容器概念、阿尔法功能', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-beck': { id: 'builtin-beck', name: '贝克取向督导师', desc: '认知行为疗法，关注自动思维、认知歪曲、行为激活', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-rogers': { id: 'builtin-rogers', name: '罗杰斯取向督导师', desc: '以人为中心疗法，关注共情、无条件积极关注、真诚一致', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-yalom': { id: 'builtin-yalom', name: '亚隆取向督导师', desc: '存在主义团体治疗，关注存在焦虑、死亡、自由、孤独', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-sue-johnson': { id: 'builtin-sue-johnson', name: '苏·约翰逊取向督导师', desc: '情绪聚焦疗法（EFT），关注情感连接、依恋模式', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-generic': { id: 'builtin-generic', name: '通用督导师（低性能模式）', desc: '综合取向，适合初步咨询和一般问题', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
  };

  // 运行时合成：含 prompt 的完整 BUILTINS（供 getById/buildSystemPrompt 使用，不写回 DB）
  const BUILTINS = {
    'builtin-winnicott': Object.assign({}, BUILTINS_META['builtin-winnicott'], { prompt: WINNICOTT_PROMPT || PERSPECTIVE_PROMPTS['winnicott'] }),
    'builtin-freud': Object.assign({}, BUILTINS_META['builtin-freud'], { prompt: PERSPECTIVE_PROMPTS['freud'] }),
    'builtin-jung': Object.assign({}, BUILTINS_META['builtin-jung'], { prompt: PERSPECTIVE_PROMPTS['jung'] }),
    'builtin-klein': Object.assign({}, BUILTINS_META['builtin-klein'], { prompt: PERSPECTIVE_PROMPTS['klein'] }),
    'builtin-adler': Object.assign({}, BUILTINS_META['builtin-adler'], { prompt: PERSPECTIVE_PROMPTS['adler'] }),
    'builtin-lacan': Object.assign({}, BUILTINS_META['builtin-lacan'], { prompt: PERSPECTIVE_PROMPTS['lacan'] }),
    'builtin-bion': Object.assign({}, BUILTINS_META['builtin-bion'], { prompt: PERSPECTIVE_PROMPTS['bion'] }),
    'builtin-beck': Object.assign({}, BUILTINS_META['builtin-beck'], { prompt: PERSPECTIVE_PROMPTS['beck'] }),
    'builtin-rogers': Object.assign({}, BUILTINS_META['builtin-rogers'], { prompt: PERSPECTIVE_PROMPTS['rogers'] }),
    'builtin-yalom': Object.assign({}, BUILTINS_META['builtin-yalom'], { prompt: PERSPECTIVE_PROMPTS['yalom'] }),
    'builtin-sue-johnson': Object.assign({}, BUILTINS_META['builtin-sue-johnson'], { prompt: PERSPECTIVE_PROMPTS['sue-johnson'] }),
    'builtin-generic': Object.assign({}, BUILTINS_META['builtin-generic'], { prompt: PERSPECTIVE_PROMPTS['generic'] }),
  };

  // 构建与 chat 完全一致的 system prompt：方法论 + 风格约束 + 身份 guard
  function buildSystemPrompt(mode) {
    let base = '';
    // 兼容旧版 mode 名（cangjie/nvwa 映射到 winnicott）
    const modeMap = {
      'cangjie': 'builtin-winnicott', 'nvwa': 'builtin-winnicott', 'winnicott': 'builtin-winnicott',
      'freud': 'builtin-freud', 'jung': 'builtin-jung', 'klein': 'builtin-klein',
      'adler': 'builtin-adler', 'lacan': 'builtin-lacan', 'bion': 'builtin-bion',
      'beck': 'builtin-beck', 'rogers': 'builtin-rogers', 'yalom': 'builtin-yalom',
      'sue-johnson': 'builtin-sue-johnson', 'generic': 'builtin-generic'
    };
    const builtinKey = modeMap[mode] || 'builtin-generic';
    const builtin = BUILTINS[builtinKey];
    if (builtin && builtin.prompt) base = builtin.prompt;
    // 旧版温尼科特提示词（全量 Base64）优先生效
    if (builtinKey === 'builtin-winnicott') {
      base = (mode === 'cangjie' ? CANGJIE_PROMPT : NVWA_PROMPT) || base;
    }
    if (!base) return '';
    const ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    return base + '\n\n' + STYLE_CONSTRAINTS + '\n\n' + WINNICOTT_PERSONA_GUARD
      + (ud ? '\n\n[我的资料库]\n' + ud : '');
  }

  function getBuiltinList() {
    return Object.keys(BUILTINS_META).map(function (k) {
      return { id: k, name: BUILTINS_META[k].name, desc: BUILTINS_META[k].desc, builtin: true };
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
    if (BUILTINS[id]) return BUILTINS[id];
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentity) return null;
    return Store.getSupervisorIdentity(id) || null;
  }

  return {
    CANGJIE_PROMPT, NVWA_PROMPT, STYLE_CONSTRAINTS, WINNICOTT_PERSONA_GUARD,
    WINNICOTT_PROMPT, BUILTINS, buildSystemPrompt, ensureSeed, list, getById, getBuiltinList,
  };
})();

if (typeof window !== 'undefined') {
  window.Supervisors = Supervisors;
}
