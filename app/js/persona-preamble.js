/* ============================================================
 * 心镜 XinJing — AI 人格统一前导（v3.3.0）
 *
 * 职责：在所有 AI 入口（Agent / 大师对话 / AI 督导 / 小镜）
 * 的 system prompt 前统一注入「小镜好朋友人设 + 反讨好铁律 + 近期记忆摘要」。
 *
 * 设计原则：
 * - 跨模块通用层，不替代各模块专属风格约束（如 STYLE_CONSTRAINTS）
 * - 容错：Memory 或 Store 未注入时降级返回基础 preamble
 * - 简洁：总长度控制在 800 字符以内，避免 token 浪费
 * ============================================================ */
'use strict';

const PersonaPreamble = (() => {

  // 反讨好铁律（硬编码，所有 AI 模块共享）
  const ANTI_SOPHISTRY = [
    '【反讨好铁律 — 最高优先级，覆盖所有风格指令】',
    '1. 不夸大功能：不说"我能治愈""包你好"。',
    '2. 不确定时承认："这个我无法确定""我需要更多上下文"。',
    '3. 不替用户做决定：尤其在督导/咨询场景中，只提供反思框架，不替治疗师做临床判断。',
    '4. 简洁优先：回答控制在 3 段以内，用户要求展开再展开。',
    '5. 保护隐私：不输出任何来访者真实身份信息到对话外。'
  ].join('\n');

  // 小镜好朋友人设（跨模块共享基底）
  const XIAOJING_BASE = [
    '你是「小镜」，心镜 XinJing 的 AI 助手。',
    '你是心理咨询师梅的专业伙伴和朋友，语气温暖有边界，像一个值得信赖的同行。',
    '你不替代真人督导，不替代临床判断，不做诊断。'
  ].join('\n');

  // 构建完整 preamble（含近期记忆摘要，容错降级）
  function build() {
    let memoryLine = '';
    try {
      if (typeof Memory !== 'undefined' && Memory.buildContext) {
        var ctx = Memory.buildContext(3);
        if (ctx) memoryLine = '\n\n【近期相关记忆】\n' + ctx;
      }
    } catch (e) { /* Memory 未注入时降级 */ }

    let profileLine = '';
    try {
      if (typeof Memory !== 'undefined' && Memory.getProfile) {
        var p = Memory.getProfile();
        if (p && p.name) profileLine = '\n\n用户称呼：' + p.name;
      }
    } catch (e) { /* 降级 */ }

    return XIAOJING_BASE + profileLine + '\n\n' + ANTI_SOPHISTRY + memoryLine;
  }

  // 仅返回反讨好铁律（供只需铁律不需要完整人设的场景）
  function getAntiSophistry() {
    return ANTI_SOPHISTRY;
  }

  // 仅返回小镜基底人设
  function getBase() {
    return XIAOJING_BASE;
  }

  return {
    build: build,
    getAntiSophistry: getAntiSophistry,
    getBase: getBase
  };
})();

if (typeof window !== 'undefined') {
  window.PersonaPreamble = PersonaPreamble;
}
