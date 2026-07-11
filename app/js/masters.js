/* ============================================================
   心镜 XinJing · 大师对话逻辑
   - 1v1 单独对话 / 多大师圆桌（@大师 可指定发言）
   - 全部对话存于本机 IndexedDB（Store.masterConversations），不联网
   - 长时记忆：对话过长时自动生成摘要，注入后续上下文，保留跨轮/跨会话脉络
   - AI 调用走 ai.js 四层降级 + 用户自有 key（与 chat 项目密钥无关）
   - 受 AI 试用闸门约束（安装 30 天内免费，之后需激活，与 AI 助手/督导同口径）
   ============================================================ */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const ACCENT_VAR = {
    accent: 'var(--accent)', purple: 'var(--purple)', blue: 'var(--blue)', green: 'var(--green)',
    orange: 'var(--orange)', indigo: 'var(--indigo)', red: 'var(--red)',
  };
  // MAX_HISTORY / SUMMARY_EVERY 常量已移至 MastersCore 纯核（masters-core.js）

  let mode = '1v1';             // '1v1' | 'round'
  let currentConv = null;       // 当前对话对象
  let roundKeys = [];           // 圆桌模式下选中的大师 key
  let busy = false;

  // ---------- 工具 ----------
  function genId() { return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowISO() { return new Date().toISOString(); }
  function accentOf(master) { return ACCENT_VAR[master.accent] || 'var(--accent)'; }
  function masterName(key) {
    const m = window.getMasterByKey && getMasterByKey(key);
    return m ? m.name : key;
  }

  // ---------- 大师列表渲染 ----------
  function renderMasterList() {
    const box = $('master-list');
    const list = (window.MASTERS || []);
    box.innerHTML = list.map((m) => {
      const sel = mode === '1v1' ? (currentConv && currentConv.mode === '1v1' && currentConv.masterKeys[0] === m.key) : roundKeys.includes(m.key);
      const cls = mode === '1v1' ? (sel ? 'sel' : '') : (sel ? 'round-on' : '');
      return `<div class="master-card ${cls}" data-key="${m.key}" onclick="onMasterClick('${m.key}')">
        <div class="m-avatar" style="background:${accentOf(m)}">${m.initial}</div>
        <div class="m-meta">
          <div class="m-name">${m.name}</div>
          <div class="m-school">${m.school}</div>
        </div>
        <div class="round-check">✓</div>
      </div>`;
    }).join('');
  }

  window.setMode = function (m) {
    mode = m;
    $('mode-1v1').classList.toggle('active', m === '1v1');
    $('mode-round').classList.toggle('active', m === 'round');
    document.querySelector('.master-list').classList.toggle('mode-round', m === 'round');
    // 圆桌模式打开历史中最近一次圆桌；1v1 不自动选
    currentConv = null;
    if (m === 'round') {
      const last = (Store.getMasterConversations() || []).find((c) => c.mode === 'round');
      if (last) { currentConv = last; roundKeys = last.masterKeys.slice(); }
    }
    renderMasterList();
    renderChat();
  };

  window.onMasterClick = function (key) {
    if (mode === '1v1') {
      // 打开/创建与该大师的 1v1 对话
      let conv = (Store.getMasterConversations() || []).find((c) => c.mode === '1v1' && c.masterKeys[0] === key);
      if (!conv) {
        const m = getMasterByKey(key);
        conv = { id: genId(), mode: '1v1', masterKeys: [key], title: m ? m.name : key, messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(conv);
      }
      currentConv = conv;
      renderMasterList();
      renderChat();
    } else {
      // 圆桌：切换选中
      if (roundKeys.includes(key)) roundKeys = roundKeys.filter((k) => k !== key);
      else roundKeys.push(key);
      // 维护/创建圆桌对话
      let conv = (Store.getMasterConversations() || []).find((c) => c.mode === 'round');
      if (!conv) {
        conv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(conv);
      }
      currentConv = conv;
      renderMasterList();
      renderChat();
    }
  };

  // ---------- 对话渲染 ----------
  function renderChat() {
    const titleEl = $('chat-title');
    const subEl = $('chat-sub');
    const body = $('chat-body');
    const empty = $('empty-hint');
    const input = $('msg-input');
    const sendBtn = $('send-btn');
    const btnNew = $('btn-new');
    const btnDel = $('btn-del');

    if (!currentConv) {
      titleEl.textContent = '未选择大师';
      subEl.textContent = mode === '1v1' ? '从左侧挑选一位开始' : '在左侧勾选两位及以上大师';
      empty.classList.remove('hidden');
      empty.innerHTML = mode === '1v1'
        ? '<div class="big">与思想者对话</div>所有对话都保存在本机 IndexedDB，不会上传任何服务器。<br>对话过长时，系统会自动生成摘要，让大师「记得」更早的脉络，形成长时记忆。'
        : '<div class="big">多大师圆桌</div>在左侧勾选两位及以上大师，向他们共同提问。<br>每位大师会依次以各自取向回应，形成跨流派的研讨。';
      body.innerHTML = '';
      input.disabled = true; sendBtn.disabled = true;
      btnNew.classList.add('hidden'); btnDel.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    btnNew.classList.remove('hidden'); btnDel.classList.remove('hidden');
    input.disabled = false; sendBtn.disabled = false;

    if (currentConv.mode === '1v1') {
      const m = getMasterByKey(currentConv.masterKeys[0]);
      titleEl.textContent = m ? m.name : currentConv.masterKeys[0];
      subEl.textContent = (m ? m.school : '') + ' · 一对一';
    } else {
      const names = currentConv.masterKeys.map(masterName).join('、');
      titleEl.textContent = '圆桌 · ' + (names || '未选大师');
      subEl.textContent = '多大师研讨 · 可 @大师 指定发言';
    }

    body.innerHTML = currentConv.messages.map(renderMsg).join('');
    body.scrollTop = body.scrollHeight;
  }

  function renderMsg(msg) {
    if (msg.role === 'sys') {
      return `<div class="msg sys"><div class="bubble">${App.escapeHtml(msg.content)}</div></div>`;
    }
    if (msg.role === 'user') {
      return `<div class="msg user"><div class="bubble">${App.escapeHtml(msg.content)}</div></div>`;
    }
    // assistant（某位大师）
    const m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
    const name = m ? m.name : (msg.masterKey || '大师');
    const color = m ? accentOf(m) : 'var(--accent)';
    const initial = m ? m.initial : '师';
    return `<div class="msg">
      <div class="av" style="background:${color}">${initial}</div>
      <div>
        <div style="font:700 12px/1.4 var(--sans);color:var(--muted);margin-bottom:4px;">${name}</div>
        <div class="bubble">${App.escapeHtml(msg.content)}</div>
      </div>
    </div>`;
  }

  // ---------- 发送 ----------
  window.sendMessage = function () {
    if (busy) return;
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 对话为付费功能，请先激活', 'error'); return; }

    const input = $('msg-input');
    const text = (input.value || '').trim();
    if (!text) return;

    // 圆桌：解析 @大师 指定发言（默认所有选中大师依次发言）
    let targetKeys = null;
    const atMatch = text.match(/@([A-Za-z\u4e00-\u9fa5]+)/);
    if (mode === 'round' && atMatch) {
      const hit = (window.MASTERS || []).find((m) => m.name === atMatch[1] || m.key === atMatch[1].toLowerCase());
      if (hit) targetKeys = [hit.key];
    }

    if (mode === '1v1') {
      if (!currentConv || currentConv.mode !== '1v1') { App.showToast('请先选择一位大师', 'error'); return; }
    } else {
      const keys = targetKeys || roundKeys;
      if (!keys.length) { App.showToast('请先在左侧勾选至少一位大师', 'error'); return; }
      // 圆桌确保 currentConv 存在
      if (!currentConv || currentConv.mode !== 'round') {
        currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(currentConv);
      }
      currentConv.masterKeys = Array.from(new Set([...currentConv.masterKeys, ...keys]));
    }

    // 用户消息入栈
    const cleanText = text.replace(/@[A-Za-z\u4e00-\u9fa5]+\s*/, '').trim() || text;
    currentConv.messages.push({ role: 'user', content: cleanText, ts: Date.now() });
    input.value = '';
    renderChat();
    Store.saveMasterConversation(currentConv);

    const keys = (mode === '1v1') ? currentConv.masterKeys : (targetKeys || roundKeys);
    runMasters(keys, cleanText);
  };

  // 依次让每位大师发言（圆桌是「依次」，1v1 只有一位）
  async function runMasters(keys, userText) {
    busy = true;
    setBusy(true);
    for (const key of keys) {
      const m = getMasterByKey(key);
      appendTyping(m);
      const reply = await callMaster(m, userText);
      removeTyping();
      if (reply && !reply.error) {
        currentConv.messages.push({ role: 'assistant', content: reply.content, masterKey: key, ts: Date.now() });
      } else {
        currentConv.messages.push({ role: 'assistant', content: '（生成失败：' + ((reply && reply.error) || '未知错误') + '）', masterKey: key, ts: Date.now() });
      }
      renderChat();
      Store.saveMasterConversation(currentConv);
    }
    // 长时记忆：达到阈值则刷新摘要
    maybeSummarize();
    busy = false;
    setBusy(false);
  }

  function setBusy(on) {
    $('send-btn').disabled = on;
    $('msg-input').disabled = on;
  }

  function appendTyping(m) {
    const body = $('chat-body');
    const name = m ? m.name : '大师';
    const color = m ? accentOf(m) : 'var(--accent)';
    const initial = m ? m.initial : '师';
    const div = document.createElement('div');
    div.className = 'msg typing-msg';
    div.innerHTML = `<div class="av" style="background:${color}">${initial}</div>
      <div><div style="font:700 12px/1.4 var(--sans);color:var(--muted);margin-bottom:4px;">${name}</div>
      <div class="bubble">正在思考…</div></div>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }
  function removeTyping() {
    const t = document.querySelector('.chat-body .typing-msg');
    if (t) t.remove();
  }

  // 构建发送给模型的消息——委托 MastersCore（纯核无 DOM 依赖）
  function buildMessages(master, userText) {
    return MastersCore.buildMessages(currentConv, master, userText);
  }

  function callMaster(master, userText) {
    return MastersCore.callMaster(currentConv, master, userText);
  }

  // 长时记忆：用既有对话生成/刷新摘要，存于 conv.summary
  // 委托 MastersCore.maybeSummarize（纯核无 DOM）+ 页面壳负责插 sys 消息 + renderChat
  async function maybeSummarize() {
    if (currentConv._summarizing) return;
    currentConv._summarizing = true;

    const summary = await MastersCore.maybeSummarize(currentConv);
    currentConv._summarizing = false;

    if (summary) {
      currentConv.summary = summary;
      Store.saveMasterConversation(currentConv);
      currentConv.messages.push({ role: 'sys', content: '🧠 已生成长时记忆摘要，后续对话将自动延续此前脉络。', ts: Date.now() });
      Store.saveMasterConversation(currentConv);
      renderChat();
    }
  }

  // ---------- 新对话 / 删除 ----------
  window.newConversation = function () {
    if (mode === '1v1') {
      currentConv = null;
      renderMasterList();
      renderChat();
      App.showToast('已清空当前选择，请重新选择大师', '');
    } else {
      roundKeys = [];
      currentConv = null;
      renderMasterList();
      renderChat();
    }
  };

  window.deleteCurrent = function () {
    if (!currentConv) return;
    App.confirmDialog('确定删除当前对话？此操作不可恢复。', () => {
      Store.deleteMasterConversation(currentConv.id);
      currentConv = null;
      renderMasterList();
      renderChat();
    }, true);
  };

  // ---------- AI 锁 ----------
  function applyAiLock() {
    const lock = $('ai-lock');
    if (!lock) return;
    const unlocked = App.aiUnlocked();
    if (unlocked) {
      lock.classList.add('hidden');
      // 防御：解锁后显式复位输入框/发送按钮为可用，避免任何残留路径（如 setBusy 异常、快照未同步）卡住输入
      const input = $('msg-input');
      const sendBtn = $('send-btn');
      if (input) input.disabled = false;
      if (sendBtn) sendBtn.disabled = !currentConv;
    } else {
      lock.classList.remove('hidden');
    }
  }
  // 页面加载时刷新；激活广播后由 App 统一回调刷新
  App.onLicenseStateChange(() => { try { applyAiLock(); } catch (e) {} });
  function openActivation() {
    if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation();
  }
  window.openActivation = openActivation;

  // ---------- 初始化 ----------
  App.initPage({
    title: '大师对话',
    subtitle: '与思想者对话 · 数据存于本机',
    onReady: function () {
      renderMasterList();
      renderChat();
      applyAiLock();
    },
  });
})();
