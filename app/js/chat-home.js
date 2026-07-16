'use strict';

(function () {
  let msgsEl = null;
  let inputEl = null;
  let sendBtn = null;
  let voiceBtn = null;
  let messages = [];
  let busy = false;
  let recognition = null;
  let isRecording = false;
  const MEM_KEY = 'xj_chat_home_messages';
  const MEM_MAX = 50;

  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function saveMemory() {
    try {
      const chat = messages.filter(m => m.role !== 'system');
      const toSave = chat.length > MEM_MAX ? chat.slice(-MEM_MAX) : chat;
      localStorage.setItem(MEM_KEY, JSON.stringify(toSave));
    } catch (e) {}
  }

  function restoreMemory() {
    try {
      const saved = localStorage.getItem(MEM_KEY);
      if (saved) {
        const chat = JSON.parse(saved);
        if (Array.isArray(chat) && chat.length > 0) {
          chat.forEach(m => {
            messages.push(m);
            renderMsg(m.role, m.content);
          });
        }
      }
    } catch (e) {}
  }

  function renderMsg(role, content) {
    if (!msgsEl) return;
    const msgEl = el('div', 'chat-msg ' + role);
    const avatar = el('div', 'avatar', role === 'user' ? '我' : '心');
    const bubble = el('div', 'bubble', App.escapeHtml ? App.escapeHtml(content || '') : (content || ''));
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderTyping() {
    if (!msgsEl) return;
    const msgEl = el('div', 'chat-msg typing');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble', '<div class="typing-dots"><span></span><span></span><span></span></div>');
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgEl.id = 'chat-typing';
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return msgEl;
  }

  function clearTyping() {
    const t = msgsEl && msgsEl.querySelector('#chat-typing');
    if (t) t.remove();
  }

  function renderSystem(content) {
    if (!msgsEl) return;
    const msgEl = el('div', 'chat-msg system');
    const bubble = el('div', 'bubble', content);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderProgress(msg) {
    renderSystem('⏳ ' + (msg || '执行中...'));
  }

  function renderWelcome() {
    if (!msgsEl) return;
    const welcome = el('div', 'welcome-card');
    const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

    let quickBtns = '';
    try {
      if (typeof Store !== 'undefined') {
        const sessions = Store.getSessions();
        const pending = sessions.filter(s => {
          const fee = (s.billing && s.billing.fee) || 0;
          return fee > 0 && !(s.billing && s.billing.paid);
        });
        const hasPending = pending.length > 0;
        quickBtns = `
          <button class="quick-btn" onclick="sendQuick('帮我记录今天的咨询')">📝 记录咨询</button>
          <button class="quick-btn" onclick="sendQuick('查看这个月的收入')">💰 收入统计</button>
          <button class="quick-btn" onclick="sendQuick('查看未收款')">💵 ${hasPending ? pending.length + '笔未收' : '未收款'}</button>
          <button class="quick-btn" onclick="sendQuick('我有个案例需要督导')">🎯 AI督导</button>
          <button class="quick-btn" onclick="sendQuick('帮张明记一笔账')">📋 快速记账</button>
        `;
      } else {
        quickBtns = `
          <button class="quick-btn" onclick="sendQuick('帮我记录今天的咨询')">📝 记录咨询</button>
          <button class="quick-btn" onclick="sendQuick('查看这个月的收入')">💰 收入统计</button>
          <button class="quick-btn" onclick="sendQuick('我有个案例需要督导')">🎯 AI督导</button>
        `;
      }
    } catch (e) {
      quickBtns = `
        <button class="quick-btn" onclick="sendQuick('帮我记录今天的咨询')">📝 记录咨询</button>
        <button class="quick-btn" onclick="sendQuick('查看这个月的收入')">💰 收入统计</button>
      `;
    }

    welcome.innerHTML = `
      <div class="title">👋 你好，今天是 ${today}</div>
      <div class="desc">我是心镜，你的智能心理咨询助理。你可以直接用自然语言让我帮你完成各种工作：记录咨询、管理来访者、查看统计、AI督导等等。</div>
      <div class="quick-actions">${quickBtns}</div>
    `;
    msgsEl.appendChild(welcome);
  }

  function renderTierBanner() {
    if (!msgsEl) return;
    let tier = 'free';
    try {
      if (typeof AI !== 'undefined' && AI.getTier) tier = AI.getTier();
    } catch (e) {}
    const banner = el('div', 'tier-banner ' + tier);
    if (tier === 'user') {
      banner.textContent = '⚡ 已接入你的高性能模型（完全体）';
    } else {
      banner.textContent = '🌱 免费试用模式 · 可用基础功能（记账 / 统计 / 督导）';
    }
    msgsEl.appendChild(banner);
  }

  function requestConfirm(toolCall, args) {
    return new Promise(function (resolve) {
      if (!msgsEl) { resolve({ ok: false }); return; }
      const card = el('div', 'chat-msg assistant');
      const avatar = el('div', 'avatar', '心');
      const bubble = el('div', 'bubble');
      const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
      let previewHtml = '';
      try {
        previewHtml = renderConfirmPreview(toolName, args);
      } catch (e) {
        previewHtml = '<div style="font-size:12px;color:#8a8a9e">参数：' + App.escapeHtml(JSON.stringify(args)) + '</div>';
      }
      bubble.innerHTML =
        '<div style="font-weight:600;margin-bottom:8px">⚠ 即将执行写入操作</div>' +
        '<div style="font-size:12px;color:#8a8a9e;margin-bottom:8px">工具：' + App.escapeHtml(toolName) + '</div>' +
        previewHtml +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="btn pri" style="font-size:12px;padding:6px 14px" onclick="this.closest(\'.chat-msg\').remove();resolve({ok:true})">确认执行</button>' +
          '<button class="btn" style="font-size:12px;padding:6px 14px" onclick="this.closest(\'.chat-msg\').remove();resolve({ok:false})">取消</button>' +
        '</div>';
      card.appendChild(avatar);
      card.appendChild(bubble);
      msgsEl.appendChild(card);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    });
  }

  function renderConfirmPreview(toolName, args) {
    if (toolName === 'billing.add_record' && Array.isArray(args.records)) {
      const rows = args.records.map(function (r, i) {
        return '<div style="font-size:13px;margin:4px 0">' +
          (i + 1) + '. 来访者：<b>' + App.escapeHtml(r.clientName || r.clientId || '') + '</b> ' +
          '日期：<b>' + App.escapeHtml(r.date || '') + '</b> ' +
          '费用：<b>¥' + App.escapeHtml(String(r.fee || 0)) + '</b> ' +
          (r.settleType ? App.escapeHtml(r.settleType) + '·' : '') +
          (r.paid ? '已收' : '未收') +
        '</div>';
      }).join('');
      return rows;
    }
    if (toolName === 'billing.monthly_settle') {
      return '<div style="font-size:13px">来访者：<b>' + App.escapeHtml(args.clientName || args.clientId || '') + '</b> 月份：<b>' + App.escapeHtml(args.month || '') + '</b> 金额：<b>¥' + App.escapeHtml(String(args.amount || 0)) + '</b></div>';
    }
    if (toolName === 'client.update') {
      const keys = Object.keys(args.patch || {}).join(', ');
      return '<div style="font-size:13px">来访者 ID：<b>' + App.escapeHtml(args.clientId || '') + '</b><br>修改字段：<b>' + App.escapeHtml(keys) + '</b></div>';
    }
    if (toolName === 'supervision.start') {
      const modeName = args.supervisorName === 'cangjie' ? '仓颉版' : '女神版';
      const materialPreview = String(args.material || '').slice(0, 200) + (String(args.material || '').length > 200 ? '…' : '');
      return '<div style="font-size:13px">' +
        '督导模式：<b>' + App.escapeHtml(modeName) + '</b><br>' +
        '来访者：<b>' + App.escapeHtml(args.clientName || args.clientId || '') + '</b><br>' +
        '材料预览：<span style="font-size:12px;color:#8a8a9e">' + App.escapeHtml(materialPreview) + '</span>' +
      '</div>';
    }
    return '<div style="font-size:12px;color:#8a8a9e">参数：' + App.escapeHtml(JSON.stringify(args)) + '</div>';
  }

  async function sendMsg() {
    if (busy) return;
    let unlocked = true;
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') unlocked = App.aiUnlocked();
    } catch (e) {}
    if (!unlocked) {
      renderSystem('⚠ Agent 为付费功能，请先激活');
      return;
    }
    if (!inputEl) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = '';
    renderMsg('user', text);
    messages.push({ role: 'user', content: text });
    busy = true;
    const typingEl = renderTyping();
    try {
      if (messages.length === 1 || messages[0].role !== 'system') {
        messages.unshift({ role: 'system', content: '' });
        try {
          if (typeof AgentCore !== 'undefined' && AgentCore.buildSystemPrompt) {
            messages[0].content = AgentCore.buildSystemPrompt();
          }
        } catch (e) {}
      }
      const result = await AgentCore.runRound(messages, requestConfirm, function (name, status, data) {
        clearTyping();
        if (status === 'executing') renderProgress('正在执行：' + name + '…');
        else if (status === 'done') {
          if (data && data.switchedTo === 'user') {
            renderSystem('✅ 已切换到你的高性能模型，我现在是完全体');
            return;
          }
          if (data && data.switchedTo === 'builtin' && data.testError) {
            renderSystem('⚠ 接入测试未通过：' + data.testError + '，已降级到内置模型');
            return;
          }
          if (data && data.card && data.card.kind === 'navigate_hint') {
            renderSystem('💡 建议前往「' + App.escapeHtml(data.card.label) + '」页面完成此操作');
            return;
          }
          if (data) {
            const summary = data.added !== undefined ? ('✓ 已新增 ' + data.added + ' 条记录' + (data.skipped ? '，跳过 ' + data.skipped + ' 条' : ''))
              : (data.receivable !== undefined ? ('✓ 应收 ¥' + data.receivable + ' / 已收 ¥' + data.received + ' / 余额 ¥' + data.balance)
              : '✓ 已完成');
            renderProgress(summary);
          }
        }
      });
      clearTyping();
      if (result.error) {
        renderMsg('system', '⚠ ' + result.error);
      } else if (result.reply) {
        renderMsg('assistant', result.reply);
      }
    } catch (e) {
      clearTyping();
      renderMsg('system', '⚠ 执行异常：' + (e.message || '未知错误'));
    }
    busy = false;
    saveMemory();
  }

  window.sendQuick = function (text) {
    if (inputEl) inputEl.value = text;
    sendMsg();
  };

  function toggleVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      renderSystem('⚠ 当前浏览器不支持语音输入');
      return;
    }
    if (!recognition) {
      recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
      recognition.lang = 'zh-CN';
      recognition.interimResults = true;
      recognition.onresult = function (e) {
        let interim = '';
        let final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) final += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (inputEl) inputEl.value = final + interim;
      };
      recognition.onend = function () {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceBtn.textContent = '🎤';
      };
      recognition.onerror = function (e) {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceBtn.textContent = '🎤';
        renderSystem('⚠ 语音输入出错：' + (e.error || '未知错误'));
      };
    }
    if (isRecording) {
      recognition.stop();
    } else {
      recognition.start();
      isRecording = true;
      if (voiceBtn) {
        voiceBtn.classList.add('recording');
        voiceBtn.textContent = '⏹';
      }
    }
  }

  window.switchToExpert = function () {
    location.href = 'index.html';
  };

  window.openActivation = function () {
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.openActivation === 'function') {
        window.__XJ_API__.openActivation();
      }
    } catch (e) {}
  };

  function init() {
    msgsEl = document.getElementById('chat-msgs');
    inputEl = document.getElementById('chat-input');
    sendBtn = document.getElementById('chat-send');
    voiceBtn = document.getElementById('voice-btn');

    if (inputEl) {
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMsg();
        }
      });
      inputEl.addEventListener('input', function () {
        this.style.height = '';
        this.style.height = Math.min(160, this.scrollHeight) + 'px';
      });
    }

    renderTierBanner();
    renderWelcome();
    restoreMemory();

    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(function () {
          msgsEl.innerHTML = '';
          renderTierBanner();
          renderWelcome();
          restoreMemory();
        });
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
