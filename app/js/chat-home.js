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
  let lastWriteAction = null;

  const MEM_KEY = 'xj_xinjing_chat_v1';
  const MEM_MAX = 50;

  function el(tag, className, html) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
          renderSystem('↩ 已恢复跨页对话记忆（' + chat.length + ' 条）');
        }
      }
    } catch (e) {}
  }

  function renderMsg(role, content) {
    if (!msgsEl) return;
    const displayRole = role === 'assistant' ? 'assistant' : role;
    const msgEl = el('div', 'chat-msg ' + displayRole);
    const avatar = el('div', 'avatar', role === 'user' ? '我' : '心');
    const bubble = el('div', 'bubble', esc(content || ''));
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

  function renderFollowupCard(items) {
    if (!msgsEl || !Array.isArray(items) || !items.length) return;
    const msgEl = el('div', 'chat-msg assistant');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble');
    bubble.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px">💡 跟进提示</div>' +
      items.map(function (t) {
        return '<div class="followup-item" style="font-size:13px;padding:4px 0;cursor:pointer;color:var(--ink-2)">• ' + esc(t) + '</div>';
      }).join('');
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    bubble.querySelectorAll('.followup-item').forEach(function (item) {
      item.addEventListener('click', function () {
        if (inputEl) { inputEl.value = item.textContent.replace(/^[•\s]+/, ''); sendMsg(); }
      });
    });
  }

  function renderNavCard(card) {
    if (!msgsEl || !card) return;
    const msgEl = el('div', 'chat-msg assistant');
    const avatar = el('div', 'avatar', '心');
    const bubble = el('div', 'bubble');
    const reason = card.reason ? ('<div style="font-size:12px;color:var(--ink-3);margin-bottom:8px">' + esc(card.reason) + '</div>') : '';
    bubble.innerHTML = '<div style="font-weight:600;margin-bottom:4px">💡 建议前往「' + esc(card.label || '') + '」</div>' +
      reason +
      '<button class="nav-go-btn" style="margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:12px;cursor:pointer">去看看 →</button>';
    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgsEl.appendChild(msgEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    bubble.querySelector('.nav-go-btn').addEventListener('click', function () {
      if (card.href) location.href = card.href;
    });
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
          <button class="quick-btn" data-text="帮我记录今天的咨询">📝 记录咨询</button>
          <button class="quick-btn" data-text="查看这个月的收入">💰 收入统计</button>
          <button class="quick-btn" data-text="查看未收款">💵 ${hasPending ? pending.length + '笔未收' : '未收款'}</button>
          <button class="quick-btn" data-text="我有个案例需要督导">🎯 AI督导</button>
          <button class="quick-btn" data-text="帮张明记一笔账">📋 快速记账</button>
        `;
      }
    } catch (e) {
      quickBtns = `
        <button class="quick-btn" data-text="帮我记录今天的咨询">📝 记录咨询</button>
        <button class="quick-btn" data-text="查看这个月的收入">💰 收入统计</button>
      `;
    }

    welcome.innerHTML = `
      <div class="title">👋 你好，今天是 ${today}</div>
      <div class="desc">我是心镜，你的智能心理咨询助理。你可以直接用自然语言让我帮你完成各种工作：记录咨询、管理来访者、查看统计、AI督导等等。</div>
      <div class="quick-actions">${quickBtns}</div>
    `;
    msgsEl.appendChild(welcome);
    welcome.querySelectorAll('.quick-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-text');
        if (text) { inputEl.value = text; sendMsg(); }
      });
    });
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
      const msgEl = el('div', 'chat-msg assistant');
      const avatar = el('div', 'avatar', '心');
      const bubble = el('div', 'bubble');
      const toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
      let previewHtml = '';
      try {
        previewHtml = renderConfirmPreview(toolName, args);
      } catch (e) {
        previewHtml = '<div style="font-size:12px;color:#8a8a9e">参数：' + esc(JSON.stringify(args)) + '</div>';
      }
      bubble.innerHTML =
        '<div style="font-weight:600;margin-bottom:8px">⚠ 即将执行写入操作</div>' +
        '<div style="font-size:12px;color:#8a8a9e;margin-bottom:8px">工具：' + esc(toolName) + '</div>' +
        previewHtml +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="confirm-ok" style="font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer">确认执行</button>' +
          '<button class="confirm-cancel" style="font-size:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--paper);color:var(--ink-2);cursor:pointer">取消</button>' +
        '</div>';
      msgEl.appendChild(avatar);
      msgEl.appendChild(bubble);
      msgsEl.appendChild(msgEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      bubble.querySelector('.confirm-ok').addEventListener('click', function () {
        msgEl.remove();
        resolve({ ok: true });
      });
      bubble.querySelector('.confirm-cancel').addEventListener('click', function () {
        msgEl.remove();
        resolve({ ok: false });
      });
    });
  }

  function renderConfirmPreview(toolName, args) {
    var tn = toolName.replace(/_/g, '.');
    if ((toolName === 'billing_add_record' || tn === 'billing.add_record') && Array.isArray(args.records)) {
      const rows = args.records.map(function (r, i) {
        return '<div style="font-size:13px;margin:4px 0">' +
          (i + 1) + '. 来访者：<b>' + esc(r.clientName || r.clientId || '') + '</b> ' +
          '日期：<b>' + esc(r.date || '') + '</b> ' +
          '费用：<b>¥' + esc(String(r.fee || 0)) + '</b> ' +
          (r.settleType ? esc(r.settleType) + '·' : '') +
          (r.paid ? '已收' : '未收') +
        '</div>';
      }).join('');
      return rows;
    }
    if (toolName === 'billing_monthly_settle' || tn === 'billing.monthly_settle') {
      return '<div style="font-size:13px">来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b> 月份：<b>' + esc(args.month || '') + '</b> 金额：<b>¥' + esc(String(args.amount || 0)) + '</b></div>';
    }
    if (toolName === 'client_update' || tn === 'client.update') {
      const keys = Object.keys(args.patch || {}).join(', ');
      return '<div style="font-size:13px">来访者 ID：<b>' + esc(args.clientId || '') + '</b><br>修改字段：<b>' + esc(keys) + '</b></div>';
    }
    if (toolName === 'supervision_start' || tn === 'supervision.start') {
      const modeName = args.supervisorName === 'cangjie' ? '仓颉版' : '女娲版';
      const materialPreview = String(args.material || '').slice(0, 200) + (String(args.material || '').length > 200 ? '…' : '');
      return '<div style="font-size:13px">' +
        '督导模式：<b>' + esc(modeName) + '</b><br>' +
        '来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b><br>' +
        '材料预览：<span style="font-size:12px;color:#8a8a9e">' + esc(materialPreview) + '</span>' +
      '</div>';
    }
    return '<div style="font-size:12px;color:#8a8a9e">参数：' + esc(JSON.stringify(args)) + '</div>';
  }

  function recordWriteAction(toolName, args, result) {
    lastWriteAction = { toolName: toolName, args: args, result: result, ts: Date.now() };
  }

  function undoLastWrite() {
    if (!lastWriteAction) {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('没有可撤销的操作', 'info');
      return;
    }
    var w = lastWriteAction;
    if ((w.toolName === 'billing.add_record' || w.toolName === 'billing_add_record') && w.result && w.result.sessionIds) {
      try {
        w.result.sessionIds.forEach(function (sid) {
          if (typeof Store !== 'undefined' && Store.deleteSession) Store.deleteSession(sid);
        });
        if (typeof App !== 'undefined' && App.showToast) App.showToast('已撤销 ' + w.result.sessionIds.length + ' 条记账记录', 'success');
        lastWriteAction = null;
      } catch (e) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast('撤销失败：' + (e.message || ''), 'error');
      }
    } else {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('该操作不支持撤销', 'info');
    }
  }

  async function refreshAuthState() {
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.getState === 'function') {
        const s = await window.__XJ_API__.getState();
        if (s && typeof s === 'object' && window.__XJ__ && typeof window.__XJ__ === 'object') {
          Object.assign(window.__XJ__, s);
        }
      }
    } catch (e) {}
  }

  function isUnlocked() {
    // 优先从 window.__XJ__ 读（preload 桥接的实时快照），其次从 App 缓存
    if (window.__XJ__ && typeof window.__XJ__.aiUnlocked === 'boolean') return !!window.__XJ__.aiUnlocked;
    if (window.__XJ__ && window.__XJ__.mode === 'full') return true;
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') return App.aiUnlocked();
    } catch (e) {}
    return false;
  }

  async function sendMsg() {
    if (busy) return;
    // 第一次发送前确保授权状态已拉取
    await refreshAuthState();
    if (!isUnlocked()) {
      renderSystem('⚠ 小镜需激活后才能使用 AI 对话。请先在设置中配置 AI 密钥。');
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
      if (messages.length === 0 || messages[0].role !== 'system') {
        messages.unshift({ role: 'system', content: '' });
      }
      try {
        if (typeof AgentCore !== 'undefined' && AgentCore.buildSystemPrompt) {
          messages[0].content = AgentCore.buildSystemPrompt();
        }
      } catch (e) {}

      if (typeof AgentCore !== 'undefined' && typeof AgentCore.runRound === 'function' && typeof AgentTools !== 'undefined') {
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
            if (data && data.switchedTo === 'partial') {
              renderProgress(data.message || '已记录部分配置');
              return;
            }
            if (data && data.card && data.card.kind === 'navigate_hint') {
              renderNavCard(data.card);
              return;
            }
            if (data) {
              const summary = data.added !== undefined ? ('✓ 已新增 ' + data.added + ' 条记录' + (data.skipped ? '，跳过 ' + data.skipped + ' 条' : ''))
                : (data.receivable !== undefined ? ('✓ 应收 ¥' + data.receivable + ' / 已收 ¥' + data.received + ' / 余额 ¥' + data.balance)
                : '✓ 已完成');
              renderProgress(summary);
              if (data.added !== undefined && data.sessionIds && data.sessionIds.length) {
                recordWriteAction(name, {}, data);
              }
            }
          }
        }, function (evt) {
          if (evt && evt.type === 'followups' && Array.isArray(evt.items) && evt.items.length) {
            renderFollowupCard(evt.items);
          }
        });
        clearTyping();
        if (result.error) {
          renderMsg('assistant', '⚠ ' + result.error);
          // 错误分支：AgentCore 未写入消息，此处需记录到 history
          messages.push({ role: 'assistant', content: '⚠ ' + result.error });
        } else if (result.reply) {
          // 成功分支：AgentCore.runRound 已把模型消息写入 messages（同一数组引用），仅渲染不再 push
          renderMsg('assistant', result.reply);
        }
      } else {
        clearTyping();
        renderSystem('⚠ Agent 模块未就绪，请重启应用。');
      }
    } catch (e) {
      clearTyping();
      renderMsg('assistant', '⚠ 执行异常：' + (e.message || '未知错误'));
      messages.push({ role: 'assistant', content: '⚠ 执行异常：' + (e.message || '未知错误') });
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
  window.toggleVoice = toggleVoice;

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

  window.undoLastWrite = undoLastWrite;

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
    if (sendBtn) {
      sendBtn.addEventListener('click', sendMsg);
    }

    // 先拉一次授权状态（修复对话模式鉴权问题），再渲染 banner
    refreshAuthState().then(function () {
      if (msgsEl) {
        msgsEl.innerHTML = '';
        renderTierBanner();
        renderWelcome();
        restoreMemory();
      }
    });

    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(function () {
          if (msgsEl) {
            msgsEl.innerHTML = '';
            renderTierBanner();
            renderWelcome();
            restoreMemory();
          }
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
