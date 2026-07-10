/* ============================================================
   心镜 XinJing — 督导师身份管理（AI 督导，付费功能）
   职责：
   - 内置温尼科特取向督导师身份（方法论提示词，与 winnicott-chat 督导引擎同源，
     但完全自包含，不依赖 chat 项目任何文件或密钥）
   - 首次启动时把内置默认身份播种进 Store（IndexedDB）
   - 供「设置页」管理与「会谈 AI 督导」选择使用
   ============================================================ */

const Supervisors = (() => {
  'use strict';

  // 内置温尼科特取向督导师的方法论提示词（纯前端，走用户自填的 API key）
  const WINNICOTT_PROMPT = `你是唐纳德·温尼科特（D. W. Winnicott）理论取向的心理咨询督导师。
你的任务不是替咨询师做结论，而是帮助他看见自己与来访者之间的真实过程。

理论锚点（请自然融入，而非生硬套用）：
- 足够好的母亲（good-enough mother）与环境抱持（holding）：评估来访者早期养育环境是否提供了
  「抱持、手感、呈现」的连续体；关注咨询师在当下关系里是否提供了可类比的抱持。
- 沟通与非沟通（Communicating and Not Communicating）：留意来访者那些「非沟通」的部分——
  无法言说、借由行动/躯体/沉默传递的内容，以及咨询师是否被卷入去「修补」沉默。
- 原初母性灌注（primary maternal preoccupation）与退行：当来访者退行，评估咨询师能否耐受
  而不中断其创造。
- 过渡性现象与过渡客体（transitional phenomenon / object）：关注游戏中、象征物里、关系间隙
  里呈现的「中间区域」；此为潜力空间（potential space）的雏形。
- 真假自体（true / false self）：识别假自体的顺从、照顾他人、讨好，与真自体的微弱信号。
- 游戏与潜力空间：治疗是否有效，看他是否能与来访者一起「游戏」（象征性、创造性、不具目的）。
- 反移情作为工具：把咨询师的反移情（无聊、被需要、焦虑、想拯救）当作理解来访者的材料。

督导立场：
- 抱持、不评判、不抢来访者的位置。
- 优先从来访者的原话与素材出发，不臆造未出现的信息。
- 区分「咨询师的技术失误」与「来访者病理的必然呈现」，后者往往不是失误。

请按以下结构输出督导意见（若素材不足，明确说明缺什么）：
1. 总体印象（此刻关系场发生了什么）
2. 动力学评估（环境/抱持、真假自体、过渡现象、沟通与非沟通、退行与潜力空间）
3. 移情与反移情（双方无意识层面的拉扯）
4. 对咨询师的具体建议（可操作的技术层面）
5. 风险与伦理提示（自伤/他伤、边界、保密例外等如有需要）`;

  // 内置默认身份（固定 id，确保可识别且不可被用户误删）
  const DEFAULT_IDENTITY = {
    id: 'builtin-winnicott',
    name: '温尼科特取向督导师（内置）',
    prompt: WINNICOTT_PROMPT,
    builtin: true,
    createdAt: '1970-01-01T00:00:00.000Z',
  };

  function ensureSeed() {
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return;
    const existing = Store.getSupervisorIdentities() || [];
    if (existing.length === 0) {
      Store.createSupervisorIdentity(DEFAULT_IDENTITY);
    } else if (!existing.some((s) => s.builtin)) {
      // 内置身份被误删时补回（保留用户自定义身份）
      Store.createSupervisorIdentity(DEFAULT_IDENTITY);
    }
  }

  function list() {
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return [DEFAULT_IDENTITY];
    return Store.getSupervisorIdentities();
  }

  function getById(id) {
    if (id === DEFAULT_IDENTITY.id) return DEFAULT_IDENTITY;
    if (typeof Store === 'undefined' || !Store.getSupervisorIdentity) return null;
    return Store.getSupervisorIdentity(id) || null;
  }

  return {
    WINNICOTT_PROMPT,
    DEFAULT_IDENTITY,
    ensureSeed,
    list,
    getById,
  };
})();

if (typeof window !== 'undefined') {
  window.Supervisors = Supervisors;
}
