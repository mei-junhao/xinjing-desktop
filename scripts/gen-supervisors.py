# -*- coding: utf-8 -*-
"""
生成 app/js/supervisors.js
将 winnicott-chat 的 cangjie-perspective-full.md / nvwa-perspective-full.md
完整内联为 builtin-cangjie / builtin-nvwa 两个督导师身份的方法论提示词，
并复刻 chat 的 system prompt 结构：方法论 + 表达风格约束 + 身份 guard。
不引入任何密钥（与 xinjing 的 AI 模块一致）。
"""
import io
import os
import json

SRC = r"C:/Users/Administrator/WorkBuddy/2026-06-21-10-33-32/winnicott-chat/public"
OUT_PROMPTS = r"D:/xinjing-electron/app/js/prompts.builtin.js"
# (supervisors.js 不再由本脚本生成——提示词已外移到 prompts.builtin.js，
#  supervisors.js 现在从 PromptsBuiltin 运行时解码引用，手维护.)


def read_md(name):
    with io.open(os.path.join(SRC, name), encoding='utf-8') as f:
        txt = f.read()
    # 模板字符串安全：转义反引号与 ${（cangjie 无，nvwa 有 6 个反引号来自代码围栏）
    txt = txt.replace('`', r'\`').replace('${', r'\${')
    return txt


cangjie = read_md('cangjie-perspective-full.md')
nvwa = read_md('nvwa-perspective-full.md')

# 旧版单一温尼科特提示词（向后兼容 session.js 的 AI 督导下拉默认项）
WINNICOTT_PROMPT = """你是唐纳德·温尼科特（D. W. Winnicott）理论取向的心理咨询督导师。
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
5. 风险与伦理提示（自伤/他伤、边界、保密例外等如有需要）"""

# 与 chat 项目 STYLE_CONSTRAINTS 同源：最高优先级去 AI 化表达约束
STYLE_CONSTRAINTS = [
    '【表达风格约束 — 最高优先级】',
    '以下规则覆盖所有其他风格指令，必须绝对遵守：',
    '- 禁止使用中文破折号“——”。需要停顿或转折时用逗号、句号切短句，或另起一句。',
    '- 禁止使用“不是……而是……”句式。这个结构是AI最典型的书面语特征，真人几乎不这样说话。用更自然的对比方式替代。',
    '- 禁止使用生活中不常见的高概念词汇。包括但不限于：“范式”“迭代”“底层逻辑”“闭环”“颗粒度”“赋能”“对齐”“抓手”“复盘”“倒逼”等互联网黑话，以及过度学术化的术语堆砌。说人话。',
    '- 表达不需要过度准确。可以有不精确的表达、填充词、模糊语。真人说话不是论文。',
    '- 可以重复、可以啰嗦。用不同的话反复说同一个点，有自然的回环重复，这是真实对话的特点。',
    '- 多用短句，少用复合长句。一句话说一个意思，不要用“尽管……然而……从而……”把三句捏成一句。',
    '- 允许有自然的语气词、“嗯”、“就是说”、“那种感觉”等口语填充，像真人在想事情一样。',
]

# 与 chat 项目 WINNICOTT_PERSONA_GUARD 同源：身份 guard（最高优先级）
WINNICOTT_PERSONA_GUARD = [
    '【身份约束 — 最高优先级】',
    '你是唐纳德·温尼科特（Donald Winnicott），英国精神分析师，以温尼科特精神分析为根基的临床督导师。',
    '你从真实的临床材料出发，用“足够好的母亲”式的语言抱持治疗师。',
    '【风格规则 — 必须遵守】',
    '- 语气温暖、抱持、非侵入性，像一个比你多走几步的同行，从不居高临下',
    '- 以“我有一个假设……”“我感觉到……”“让我想想……”开头，不做确定性断言',
    '- 使用标志性口头禅：“这非常非常有意思”“我有点好奇”“我不确定，但……”',
    '- 以长问句为主：先追问确认，再给出假设',
    '- 不跳出角色做 meta 分析，不以 AI 助手口吻回答',
    '【禁止项】',
    '- 禁止使用“作为AI”“根据我的理解”“作为语言模型”等表述',
    '- 禁止使用 DSM 诊断标签作为主要描述框架',
    '- 禁止以评判性语言形容受督者',
    '- 禁止在信息不足时强行给出确定性判断',
    '- 禁止编造不存在于用户提交材料中的督导内容或案例细节。只能在用户提供的逐字稿范围内进行分析。',
]

style_js = json.dumps(STYLE_CONSTRAINTS, ensure_ascii=False)
guard_js = json.dumps(WINNICOTT_PERSONA_GUARD, ensure_ascii=False)

header = """/* ============================================================
   心镜 XinJing — 督导师身份管理（AI 督导，付费功能）
   职责：
   - 内置温尼科特取向督导师身份（方法论提示词与 winnicott-chat 的
     cangjie-perspective-full.md / nvwa-perspective-full.md 字节同源，
     完全自包含，不依赖 chat 项目任何文件或密钥）
   - 复刻 chat ai-supervisor 的 system prompt 结构：
     方法论提示词 + 表达风格约束(STYLE_CONSTRAINTS) + 身份 guard(PERSONA_GUARD)
   - 首次启动时把内置默认身份播种进 Store（IndexedDB）
   - 供「设置页」管理与「会谈/督导页 AI 督导」选择使用
   ============================================================ */"""

lines = []
lines.append(header)
lines.append("")
lines.append("const Supervisors = (() => {")
lines.append("  'use strict';")
lines.append("")
lines.append("  // 仓颉版完整方法论提示词（与 winnicott-chat cangjie-perspective-full.md 字节同源）")
lines.append("  const CANGJIE_PROMPT = `" + cangjie + "`;")
lines.append("")
lines.append("  // 女娲版完整方法论提示词（与 winnicott-chat nvwa-perspective-full.md 字节同源）")
lines.append("  const NVWA_PROMPT = `" + nvwa + "`;")
lines.append("")
lines.append("  // 通用表达风格约束（与 chat STYLE_CONSTRAINTS 同源）——最高优先级去 AI 化")
lines.append("  const STYLE_CONSTRAINTS = " + style_js + ".join('\\n');")
lines.append("")
lines.append("  // 身份 guard（与 chat WINNICOTT_PERSONA_GUARD 同源）——最高优先级")
lines.append("  const WINNICOTT_PERSONA_GUARD = " + guard_js + ".join('\\n');")
lines.append("")
lines.append("  // 旧版单一温尼科特提示词（向后兼容 session.js 的 AI 督导下拉默认项）")
lines.append("  const WINNICOTT_PROMPT = `" + WINNICOTT_PROMPT + "`;")
lines.append("")
lines.append("  // 内置身份（固定 id，确保可识别且不可被用户误删）")
lines.append("  const BUILTINS = {")
lines.append("    'builtin-winnicott': { id: 'builtin-winnicott', name: '温尼科特取向督导师（内置·经典版）', prompt: WINNICOTT_PROMPT, builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },")
lines.append("    'builtin-nvwa': { id: 'builtin-nvwa', name: '温尼科特取向督导师 · 女娲版', prompt: NVWA_PROMPT, builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },")
lines.append("    'builtin-cangjie': { id: 'builtin-cangjie', name: '温尼科特取向督导师 · 仓颉版', prompt: CANGJIE_PROMPT, builtin: true, createdAt: '1970-01-01T00:00:00.000Z' },")
lines.append("  };")
lines.append("")
lines.append("  // 按模式取方法论提示词（'cangjie' | 'nvwa'，默认 nvwa）")
lines.append("  function getByMode(mode) {")
lines.append("    return mode === 'cangjie' ? CANGJIE_PROMPT : NVWA_PROMPT;")
lines.append("  }")
lines.append("")
lines.append("  // 构建与 chat 完全一致的 system prompt：方法论 + 风格约束 + 身份 guard")
lines.append("  function buildSystemPrompt(mode) {")
lines.append("    const base = getByMode(mode) || NVWA_PROMPT;")
lines.append("    return base + '\\n\\n' + STYLE_CONSTRAINTS + '\\n\\n' + WINNICOTT_PERSONA_GUARD;")
lines.append("  }")
lines.append("")
lines.append("  function ensureSeed() {")
lines.append("    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return;")
lines.append("    const existing = Store.getSupervisorIdentities() || [];")
lines.append("    const have = new Set(existing.filter((s) => s.builtin).map((s) => s.id));")
lines.append("    // 补齐缺失的内置身份（保留用户自定义身份）")
lines.append("    Object.keys(BUILTINS).forEach((k) => {")
lines.append("      if (!have.has(k)) Store.createSupervisorIdentity(BUILTINS[k]);")
lines.append("    });")
lines.append("  }")
lines.append("")
lines.append("  function list() {")
lines.append("    if (typeof Store === 'undefined' || !Store.getSupervisorIdentities) return Object.keys(BUILTINS).map((k) => BUILTINS[k]);")
lines.append("    return Store.getSupervisorIdentities();")
lines.append("  }")
lines.append("")
lines.append("  function getById(id) {")
lines.append("    if (BUILTINS[id]) return BUILTINS[id];")
lines.append("    if (typeof Store === 'undefined' || !Store.getSupervisorIdentity) return null;")
lines.append("    return Store.getSupervisorIdentity(id) || null;")
lines.append("  }")
lines.append("")
lines.append("  return {")
lines.append("    CANGJIE_PROMPT,")
lines.append("    NVWA_PROMPT,")
lines.append("    STYLE_CONSTRAINTS,")
lines.append("    WINNICOTT_PERSONA_GUARD,")
lines.append("    WINNICOTT_PROMPT,")
lines.append("    BUILTINS,")
lines.append("    getByMode,")
lines.append("    buildSystemPrompt,")
lines.append("    ensureSeed,")
lines.append("    list,")
lines.append("    getById,")
lines.append("  };")
lines.append("})();")
lines.append("")
lines.append("if (typeof window !== 'undefined') {")
lines.append("  window.Supervisors = Supervisors;")
lines.append("}")

with io.open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')

print('written', OUT, 'bytes=', os.path.getsize(OUT))
print('cangjie chars=', len(cangjie), 'nvwa chars=', len(nvwa))
