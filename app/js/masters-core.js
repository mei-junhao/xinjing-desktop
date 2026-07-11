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
      // 圆桌：找已有的圆桌对话（第一个），没有则创建
      let conv = (Store.getMasterConversations() || []).find((c) => c.mode === 'round');
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
  function buildMessages(conv, master, userText) {
    const summaryLine = conv.summary
      ? '\n\n以下是你与这位咨询师的【既往对话摘要（长时记忆）】，请在回应时保持脉络连贯，不必重复已讨论过的内容：\n' + conv.summary
      : '';
    const system = master.systemPrompt + summaryLine;

    const hist = conv.messages
      .filter((x) => x.role === 'user' || x.role === 'assistant')
      .slice(-MAX_HISTORY)
      .map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }));

    return [{ role: 'system', content: system }, ...hist, { role: 'user', content: userText }];
  }

  // 单大师发言（不操作 DOM）
  // 返回 Promise<{content?, error?}>
  function callMaster(conv, master, userText, options) {
    return new Promise((resolve) => {
      const messages = buildMessages(conv, master, userText);
      if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
      AI.send(messages, (res) => resolve(res), options || {});
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
    openOrCreateConv, buildMessages, callMaster, maybeSummarize,
  };
})();
