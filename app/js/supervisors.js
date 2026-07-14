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

  // ⚠️ 以下空间原本是内置提示词的明文模板字面量，已移至 prompts.builtin.js（Base64 编码）。
  //   下方仅保留运行时从 PromptsBuiltin 解码引用的常量定义。

  // 内置身份元数据（固定 id，确保可识别且不可被用户误删）
  // ⚠️ 种子只存 id/name/builtin/createdAt，prompt 不入库明文（运行时从源码常量合成）。
  const BUILTINS_META = {
    'builtin-winnicott': { id: 'builtin-winnicott', name: '温尼科特取向督导师（内置·经典版）', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-nvwa': { id: 'builtin-nvwa', name: '温尼科特取向督导师 · 女娲版', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
    'builtin-cangjie': { id: 'builtin-cangjie', name: '温尼科特取向督导师 · 仓颉版', builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },
  };

  // 运行时合成：含 prompt 的完整 BUILTINS（供 getById/buildSystemPrompt 使用，不写回 DB）
  const BUILTINS = {
    'builtin-winnicott': Object.assign({}, BUILTINS_META['builtin-winnicott'], { prompt: WINNICOTT_PROMPT }),
    'builtin-nvwa': Object.assign({}, BUILTINS_META['builtin-nvwa'], { prompt: NVWA_PROMPT }),
    'builtin-cangjie': Object.assign({}, BUILTINS_META['builtin-cangjie'], { prompt: CANGJIE_PROMPT }),
  };

  // 构建与 chat 完全一致的 system prompt：方法论 + 风格约束 + 身份 guard
  function buildSystemPrompt(mode) {
    // U2 #4：严格按模式取提示词，禁止跨模式静默回落（避免选 cangjie 却用 nvwa）
    const base = mode === 'cangjie' ? CANGJIE_PROMPT : NVWA_PROMPT;
    if (!base) return '';
    // v3.5.0：被动注入用户自建资料库（仅本机读取，零出网）
    const ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    return base + '\n\n' + STYLE_CONSTRAINTS + '\n\n' + WINNICOTT_PERSONA_GUARD
      + (ud ? '\n\n[我的资料库]\n' + ud : '');
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
    CANGJIE_PROMPT,
    NVWA_PROMPT,
    STYLE_CONSTRAINTS,
    WINNICOTT_PERSONA_GUARD,
    WINNICOTT_PROMPT,
    BUILTINS,
    buildSystemPrompt,
    ensureSeed,
    list,
    getById,
  };
})();

if (typeof window !== 'undefined') {
  window.Supervisors = Supervisors;
}
