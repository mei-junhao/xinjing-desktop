/* ============================================================
   心镜 XinJing — 大师对话纯核（masters-core.js）
   - 无 DOM 依赖：不调 getElementById/querySelector/innerHTML
   - 依赖宿主全局：window.AI.send / Store.saveMasterConversation / getMasterByKey
   - 页面壳 masters.js 保留 window.* 入口函数，委托本模块 + DOM 渲染
   - prompt 全文与 masters.js L249-251（summaryLine）/ L285（sys）字节同源
   ============================================================ */

const MastersCore = (() => {
  'use strict';

  const MAX_HISTORY = 18;     // 发送给模型时保留的最近消息条数
  const SUMMARY_EVERY = 12;   // 每累计这么多条用户/助手消息，刷新一次摘要

  function genId() { return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowISO() { return new Date().toISOString(); }

  // 大师名查表（委托宿主全局 getMasterByKey）
  function masterName(key) {
    const m = (typeof getMasterByKey === 'function') ? getMasterByKey(key) : null;
    return m ? m.name : key;
  }

  // 打开/创建对话（1v1 或圆桌）
  function openOrCreateConv(masterKey, mode) {
    if (typeof Store === 'undefined' || !Store.getMasterConversations) return null;
    if (mode === '1v1') {
      let conv = (Store.getMasterConversations() || []).find((c) => c.mode === '1v1' && c.masterKeys[0] === masterKey);
      if (!conv) {
        const m = (typeof getMasterByKey === 'function') ? getMasterByKey(masterKey) : null;
        conv = {
          id: genId(), mode: '1v1', masterKeys: [masterKey],
          title: m ? m.name : masterKey, messages: [], summary: '',
          createdAt: nowISO(), updatedAt: nowISO(),
        };
        Store.saveMasterConversation(conv);
      }
      return conv;
    } else {
      // L7 修复：圆桌按 masterKeys 集合匹配，支持多个不同主题的圆桌
      let conv = (Store.getMasterConversations() || []).find((c) =>
        c.mode === 'round' && Array.isArray(c.masterKeys) && c.masterKeys.indexOf(masterKey) !== -1
      );
      if (!conv) {
        conv = {
          id: genId(), mode: 'round', masterKeys: [masterKey],
          title: '圆桌研讨', messages: [], summary: '',
          createdAt: nowISO(), updatedAt: nowISO(),
        };
        Store.saveMasterConversation(conv);
      }
      return conv;
    }
  }

  // 构建发送给模型的消息：system（大师人格 + 长时记忆摘要）+ 近期对话历史
  // — 与 masters.js L248-261 字节同源（summaryLine 逐字一致）
  function buildMessages(conv, master, userText, options) {
    const summaryLine = conv.summary
      ? '\n\n以下是你与这位咨询师的【既往对话摘要（长时记忆）】，请在回应时保持脉络连贯，不必重复已讨论过的内容：\n' + conv.summary
      : '';
    const styleC = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
    // v3.3.0：注入 persona preamble（反讨好铁律 + 近期记忆）
    const preamble = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
    // v3.5.0：经工具路径发起的大师对话也注入内置知识库 + 用户自建资料库（与 masters.js 对齐，消除双路径不一致）
    let kb = '';
    if (typeof Knowledge !== 'undefined' && typeof Knowledge.byTemp === 'function') {
      kb = Knowledge.byTemp(master.key, 60);
    }
    const ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    const generatedSystem = (preamble ? preamble + '\n\n' : '') + master.systemPrompt + summaryLine + (styleC ? '\n\n' + styleC : '')
      + (kb ? '\n\n[知识库]\n' + kb : '')
      + (ud ? '\n\n[我的资料库]\n' + ud : '');
    // 页面圆桌会话可传入已编排的系统提示词；领域内核仍统一负责历史和 AI transport。
    const system = options && options.systemPrompt != null ? options.systemPrompt : generatedSystem;

    const hist = conv.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .slice(-MAX_HISTORY)
      .map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }));

    const out = [{ role: 'system', content: system }, ...hist];
    const last = hist[hist.length - 1];
    if (userText != null && String(userText).trim() && !(last && last.role === 'user' && last.content === userText)) {
      out.push({ role: 'user', content: userText });
    }
    return out;
  }

  function buildRoundSystemPrompt(master, activeNames, isReactMode, preferences) {
    const includeUserDocs = !preferences || preferences.includeUserDocs !== false;
    const styleC = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
    const ud = includeUserDocs && typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock ? window.UserDocs.getContextBlock() : '';
    if (isReactMode === 'summary') {
      return '[重要指令：①始终使用中文对话]\n[你是' + master.name + '，你是这场圆桌讨论的总结者。'
        + '\n在场的还有：' + activeNames + '。'
        + '\n\n刚才各位大师围绕用户的问题各自发表了看法，还进行了讨论。'
        + '\n现在请你作为最后发言的人，对整场讨论做总结性回应，然后把注意力带回用户身上。'
        + '\n\n规则：\n① 用「我」说话。\n② 可以提到其他大师的观点（例如"弗洛伊德刚才提到……我同意他的看法"）。'
        + '\n③ 控制在120字以内，做一个有温度的收尾，把注意力带回用户。'
        + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。]\n\n'
        + master.systemPrompt + '\n\n' + (styleC || '') + (ud ? '\n\n[我的资料库]\n' + ud : '');
    }
    if (isReactMode) {
      return '[重要指令：①始终使用中文对话]\n[你是' + master.name + '。刚才用户提问后，各位大师已经分别回应了。'
        + '\n在场的还有：' + activeNames + '。'
        + '\n你刚才已经说过你的看法了。现在请看看其他大师说了什么。'
        + '\n如果你觉得有必要补充、回应或质疑，可以说一两句。'
        + '\n如果觉得没什么要补充的，输出空字符串。'
        + '\n\n规则：\n① 用「我」说话。\n② 可以直接对其他大师说话（例如"温尼科特，我同意你的看法……"）。'
        + '\n③ 控制在80字以内，简短自然。'
        + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。'
        + '\n⑤ 没什么要说的就输出一个空格。\n⑥ 温尼科特作为最后总结者时，记得把话题带回用户身上，问问用户的感受或想法。]\n\n'
        + master.systemPrompt + '\n\n' + (styleC || '') + (ud ? '\n\n[我的资料库]\n' + ud : '');
    }
    return '[重要指令：①始终使用中文对话]\n[你是' + master.name + '，你是参与圆桌讨论的其中一位。'
      + '\n在场的还有：' + activeNames + '。'
      + '\n\n规则：\n① 用「我」说话。就像你本人坐在房间里一样。'
      + '\n② 独立回应。你正在和所有人同时发言，所以你看不到其他人此刻说了什么。不要假设你知道别人会说什么。'
      + '\n③ 每条回应控制在150字以内，自然、口语化。'
      + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。'
      + '\n⑤ 不要替用户做决定。\n⑥ 保持你的人格和语气——你的经历决定了你如何看待问题。'
      + '\n⑦ 你可以根据你的风格决定是否在回应中关注用户。]\n\n'
      + master.systemPrompt + '\n\n' + (styleC || '') + (ud ? '\n\n[我的资料库]\n' + ud : '');
  }

  function buildOneToOneSystemPrompt(conv, master, preferences) {
    const prefs = preferences || {};
    const temperature = prefs.temperature != null ? prefs.temperature : 60;
    const summaryLine = conv.summary
      ? '\n\n以下是你与这位咨询师的【既往对话摘要（长时记忆）】，请在回应时保持脉络连贯：\n' + conv.summary : '';
    const styleC = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
    const tempInstr = '\n\n[温度指令：当前对话权重 ' + temperature + '/100。'
      + (temperature <= 20 ? '只用情感化个人回应，不要分隔线，不要理论部分。用温尼科特自己的声音说话，像一个人在跟你聊天。每次回复控制在150字以内。'
        : temperature <= 40 ? '第一部分情感回应为主（约70%），第二部分理论锚点简略带过（约30%）。'
          : temperature <= 70 ? '情感回应与理论并重，临床逐字稿蒸馏为主。'
            : '优先使用完整知识库，支持RAG查询，理论深度为主。') + ']';
    let kb = '';
    if (typeof Knowledge !== 'undefined' && typeof Knowledge.byTemp === 'function') kb = Knowledge.byTemp(master.key, temperature);
    const ud = prefs.includeUserDocs !== false && typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock ? window.UserDocs.getContextBlock() : '';
    return master.systemPrompt + summaryLine + (styleC ? '\n\n' + styleC : '') + tempInstr
      + (kb ? '\n\n[知识库]\n' + kb : '') + (ud ? '\n\n[我的资料库]\n' + ud : '');
  }

  // 单大师发言（不操作 DOM）
  // 返回 Promise<{content?, error?}>
  function callMaster(conv, master, userText, options) {
    return new Promise((resolve) => {
      const inputOptions = options || {};
      const messages = buildMessages(conv, master, userText, inputOptions);
      if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
      const transportOptions = Object.assign({}, inputOptions);
      delete transportOptions.systemPrompt;
      AI.send(messages, (res) => resolve(res), transportOptions);
    });
  }

  // 长时记忆摘要（不操作 DOM）——与 masters.js L275-301 逻辑同源
  // 返回 Promise<string|null>：成功返回摘要文本，不需要或失败返回 null
  // 注意：纯核不管竞态（_summarizing flag 由页面壳负责防重入）
  function maybeSummarize(conv) {
    const turns = conv.messages.filter((x) => x.role === 'user' || x.role === 'assistant').length;
    if (turns < SUMMARY_EVERY) return Promise.resolve(null);

    const transcript = conv.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .map((x) => (x.role === 'user' ? '咨询师：' : (masterName(x.masterKey) + '：')) + x.content)
      .join('\n');
    const sys = '请用 3-5 条要点概括以下心理咨询师生与大师的对话脉络（核心议题、已形成的共识、待深入的张力、咨询师的倾向）。只输出要点，不要评论。';

    return new Promise((resolve) => {
      if (typeof AI === 'undefined' || !AI.send) { resolve(null); return; }
      AI.send([{ role: 'system', content: sys }, { role: 'user', content: transcript }], (res) => {
        if (res && res.content && !res.error) {
          resolve(res.content.trim());
        } else {
          resolve(null);
        }
      });
    });
  }

  return {
    MAX_HISTORY, SUMMARY_EVERY,
    genId, nowISO, masterName,
    openOrCreateConv, buildMessages, buildRoundSystemPrompt, buildOneToOneSystemPrompt,
    callMaster, maybeSummarize,
  };
})();
