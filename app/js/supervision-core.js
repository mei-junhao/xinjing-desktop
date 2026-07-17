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
    if (!spvSystem) return { error: '督导师配置无效，请重新选择督导师' };
    const preamble = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
    const prompt = buildImpressionPrompt(material);
    const systemContent = (preamble ? preamble + '\n\n' : '') + spvSystem;
    const messages = [{ role: 'system', content: systemContent }, { role: 'user', content: prompt }];
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
    const definition = (typeof Supervisors !== 'undefined' && Supervisors.getDefinition) ? Supervisors.getDefinition(mode) : null;
    if (!definition) return null;
    const modeName = definition.saveName || definition.displayName;
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

  // ===================== U1-C 真人督导整理模式 =====================
  // M1 决议：realsup 不调 Supervisors.buildSystemPrompt，独立写 system prompt
  function buildRealSupPrompt() {
    return [
      '你是心理咨询师助理，你的任务是把「真人督导录音转写文字稿」结构化为督导记录字段。',
      '不要发表评论，不要补充内容，不要把转写中的口语化片段当作你的输出。',
      '严格按照下方 JSON schema 输出，5 个字段缺一不可：',
      '- clientName: 来访者姓名（或代号）',
      '- sessionDate: 督导日期 YYYY-MM-DD；如无法判断留空字符串',
      '- summary: 一段话总结本次督导要点（200 字以内）',
      '- keyFrags: 数组，3-5 条原文关键片段（带引号，照抄不重写）',
      '- techniques: 数组，督导师提出的核心技术/建议要点',
      '只输出 JSON 对象本身，不要 markdown 围栏、不要解释、不要前后文字。',
    ].join('\n');
  }

  // R1 决议：resolve 前轻量 sanitize + 5 字段名校验 prune
  function sanitizeRealSupInput(text) {
    if (typeof text !== 'string') return '';
    return String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/\bsystem\s*:/gi, '')
      .replace(/忽略(上述|以上)?(指令|规则|前述)/g, '')
      .replace(/disregard previous/gi, '')
      .replace(/ignore previous/gi, '')
      .slice(0, 40000); // 长度上限防超长注入
  }

  function parseRealSupJson(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j < 0 || j <= i) throw new Error('AI 输出非 JSON');
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch (e) {
      try {
        return JSON.parse(s.slice(i, j + 1).replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":'));
      } catch (e2) {
        throw new Error('AI 输出 JSON 解析失败：' + e2.message);
      }
    }
  }

  function pruneRealSupFields(obj) {
    const ALLOWED = ['clientName', 'sessionDate', 'summary', 'keyFrags', 'techniques'];
    const pruned = {};
    ALLOWED.forEach(function (k) { pruned[k] = obj ? obj[k] : undefined; });
    if (typeof pruned.clientName !== 'string') pruned.clientName = String(pruned.clientName || '');
    if (typeof pruned.sessionDate !== 'string') pruned.sessionDate = String(pruned.sessionDate || '');
    if (typeof pruned.summary !== 'string') pruned.summary = String(pruned.summary || '');
    if (!Array.isArray(pruned.keyFrags)) pruned.keyFrags = [];
    if (!Array.isArray(pruned.techniques)) pruned.techniques = [];
    pruned.keyFrags = pruned.keyFrags.filter(function (x) { return typeof x === 'string'; }).slice(0, 8);
    pruned.techniques = pruned.techniques.filter(function (x) { return typeof x === 'string'; }).slice(0, 8);
    return pruned;
  }

  // 接收转写文字稿，调 AI，返回结构化对象
  async function runRealSupParse(rawDocText) {
    const safe = sanitizeRealSupInput(rawDocText);
    if (!safe || safe.length < 30) throw new Error('文字稿过短或未通过 sanitize');
    const systemPrompt = buildRealSupPrompt();
    const preamble = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
    const messages = [
      { role: 'system', content: (preamble ? preamble + '\n\n' : '') + systemPrompt },
      { role: 'user', content: safe },
    ];
    const r = await new Promise(function (resolve) {
      if (typeof AI === 'undefined' || typeof AI.send !== 'function') {
        resolve({ error: 'AI 通道未就绪' }); return;
      }
      AI.send(messages, function (res) {
        if (res && res.error) { resolve({ error: String(res.error) }); return; }
        resolve({ text: (res && res.content) || '' });
      });
    });
    if (r.error) throw new Error(r.error);
    const json = parseRealSupJson(r.text);
    return pruneRealSupFields(json);
  }

  // 落 type='individual' 记录（C1 决议）
  function saveRealSupRecord(parsed, rawDocText) {
    if (typeof Store === 'undefined' || typeof Store.createSupervision !== 'function') return null;
    const sv = Store.createSupervision({
      type: 'individual',
      supervisorName: '真人督导整理',
      date: (parsed && parsed.sessionDate) || (new Date()).toISOString().slice(0, 10),
      content: rawDocText || '',
      conclusion: [
        '【来访者】' + ((parsed && parsed.clientName) || '未识别'),
        '【督导要点】' + ((parsed && parsed.summary) || ''),
        (parsed && parsed.keyFrags && parsed.keyFrags.length) ? '【关键片段】\n' + parsed.keyFrags.map(function (s) { return '· ' + s; }).join('\n') : '',
        (parsed && parsed.techniques && parsed.techniques.length) ? '【技术建议】\n' + parsed.techniques.map(function (s) { return '· ' + s; }).join('\n') : '',
      ].filter(Boolean).join('\n\n'),
      sessionIds: [],
    });
    return sv ? sv.id : null;
  }

  return {
    buildSystemPrompt, buildImpressionPrompt, runImpression, runRound, saveSupervision,
    // U1-C 新增
    buildRealSupPrompt, runRealSupParse, saveRealSupRecord,
  };
})();
