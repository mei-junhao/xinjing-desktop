/* ============================================================
   心镜 XinJing — 督导管线纯核（supervision-core.js）
   - 无 DOM 依赖：不调 getElementById/querySelector/innerHTML
   - 依赖宿主全局：window.AI.send / Supervisors.buildSystemPrompt / Store.saveAiSupervision
   - 页面壳 supervision.js 保留 window.* 入口函数，委托本模块 + DOM 渲染
   - prompt 全文与 supervision.js L263-281 字节同源（守护提示词不偏移）
   ============================================================ */

const SupervisionCore = (() => {
  'use strict';

  // 督导模式 → 系统提示合成（委托宿主全局 Supervisors）
  function buildSystemPrompt(mode) {
    return (typeof Supervisors !== 'undefined' && Supervisors.buildSystemPrompt) ? Supervisors.buildSystemPrompt(mode) : '';
  }

  // 整体印象提示词——与 supervision.js L263-281 逐字同源
  function buildImpressionPrompt(material) {
    return '你是一位资深临床督导师。请严格遵循你在系统提示中设定的督导风格与方法论框架，按照以下流程分析这份临床材料，输出一份"整体印象"。\n\n' +
      '【第一步：材料识别】\n' +
      '先判断材料类型（可同时属于多种）：\n' +
      '- 逐字稿：含"T:"/"P:"等对话标记、引号内对话片段 → 策略：逐行精读\n' +
      '- 案例报告：含"背景""诊断""治疗进程""主诉"等结构化描述 → 策略：案例概念化\n' +
      '- 反移情困惑：含"我感觉""我不知道该怎么办""我很焦虑/无力/愤怒"等 → 策略：从反移情切入\n' +
      '- 混合材料：同时出现多种特征 → 策略：反移情线索优先\n' +
      '在开头用一句话声明你识别到的材料类型。\n\n' +
      '【第二步：针对性输出】\n' +
      '根据材料类型和你在系统提示中设定的方法论，选择合适的输出结构。做到具体、有针对性，不要套用通用模板。\n\n' +
      '【第三步：风格】\n' +
      '严格遵循系统提示中设定的督导风格和语调。\n\n' +
      '【结尾要求】\n' +
      '整体印象末尾必须包含：\n' +
      '1. 一个向治疗师提出的开放性问题，促进其自主思考\n' +
      '2. 一个简短的"可向真人督导澄清的问题清单"（2-3 条，用于治疗师在真实督导中提出）\n\n' +
      '最终以这句话收尾："如果你愿意，我们可以就其中任何一点继续深入讨论。"\n\n' +
      '临床材料：\n' + material;
  }

  // 启动整体印象（不操作 DOM）
  // 返回 Promise<{impression, chatMessages, error?}>
  async function runImpression(mode, material, options) {
    const spvSystem = buildSystemPrompt(mode);
    const prompt = buildImpressionPrompt(material);
    const messages = [{ role: 'system', content: spvSystem }, { role: 'user', content: prompt }];
    return new Promise((resolve) => {
      if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
      AI.send(messages, (res) => {
        if (res && res.error) { resolve({ error: res.error }); return; }
        const impression = (res && res.content) || '（未获得回复）';
        resolve({
          impression,
          chatMessages: [
            { role: 'system', content: spvSystem },
            { role: 'assistant', content: impression },
          ],
        });
      }, options || {});
    });
  }

  // 多轮督导交互（不操作 DOM）
  // 返回 Promise<{reply, chatMessages, error?}>
  async function runRound(chatMessages, userText, options) {
    const msgs = chatMessages.concat([{ role: 'user', content: userText }]);
    return new Promise((resolve) => {
      if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
      AI.send(msgs.slice(), (res) => {
        if (res && res.error) { resolve({ error: res.error }); return; }
        const reply = (res && res.content) || '（未获得回复）';
        resolve({
          reply,
          chatMessages: msgs.concat([{ role: 'assistant', content: reply }]),
        });
      }, options || {});
    });
  }

  // 保存督导记录（不操作 DOM）——与 supervision.js L366-392 字节同源
  // 返回 full 文本（页面壳可用于 showToast），纯核内部已完成 Store 保存
  function saveSupervision(mode, chatMessages, material, loadedSession) {
    if (!chatMessages.length || chatMessages[0].role !== 'system') return null;
    const impression = chatMessages[1] && chatMessages[1].role === 'assistant' ? chatMessages[1].content : '';
    const chat = chatMessages.slice(2).map((m) =>
      (m.role === 'user' ? '咨询师：' : '督导师：') + m.content
    ).join('\n\n');
    const modeName = mode === 'cangjie' ? '温尼科特取向督导师 · 仓颉版' : '温尼科特取向督导师 · 女娲版';
    const full = '【整体印象】\n' + impression + (chat ? '\n\n【督导对话】\n' + chat : '');
    if (typeof Store !== 'undefined' && typeof Store.saveAiSupervision === 'function') {
      Store.saveAiSupervision({
        supervisorName: modeName,
        clientId: loadedSession ? loadedSession.clientId : '',
        sessionId: loadedSession ? loadedSession.id : '',
        context: material,
        content: full,
      });
    }
    return full;
  }

  return { buildSystemPrompt, buildImpressionPrompt, runImpression, runRound, saveSupervision };
})();
