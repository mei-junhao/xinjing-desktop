/* ============================================================
 * 心镜 XinJing — 统一对话面板（v4.0.0）
 * 整合 AgentShell + XiaojingPanel 全部能力
 *   - 侧滑面板 + FAB 悬浮球（XiaojingPanel 风格 UI）
 *   - AgentCore function-calling 完整工具链
 *   - 档位横幅 / 授权门控 / 撤销 / 导航卡 / API 配置对话
 *   - 语音输入 / 页面上下文 / 快捷操作 / 每日提醒
 *   - 统一跨页多轮对话记忆
 *
 * 兼容旧 API：
 *   window.AgentOpen() / AgentSend() / AgentClose() / AgentUndo
 *   window.XiaojingPanel.* / window.toggleXiaojing
 *
 * 推荐新 API：
 *   window.XinJingChat.open() / close() / send(text) / undo()
 * ============================================================ */
'use strict';

const XinJingChat = (() => {
  var panelEl = null;
  var bodyEl = null;
  var inputEl = null;
  var isOpen = false;
  var hasNewHint = false;
  var hintDotEl = null;
  var busy = false;

  var messages = [];
  var MEM_KEY = 'xj_xinjing_chat_v1';
  var MEM_MAX = 30;

  var lastWriteAction = null;

  var XIAOJING_IDENTITY = '你是心镜（XinJing）的助手「小镜」，身份设定：\n' +
    '- 你是心理咨询师的专业助理，不是AI督导，也不是大师。\n' +
    '- 你的职责是帮助管理日常工作：查看来访者信息、记账、提醒待办、回答关于app功能的问题。\n' +
    '- 你绝对不能说没有来源的话。如果用户问数据问题，你必须先查实时数据再回答，不能编造。\n' +
    '- 如果用户问的专业问题超出你的知识范围，诚实地说"这个需要请教AI督导或真人督导"。\n' +
    '- 回复简洁专业，用中文，语气温暖有边界。\n' +
    '- 你可以引导用户去各个页面：咨询记录、逐字稿整理、撰写报告、AI督导、真人督导、文档中心、账单、大师对话、设置、咨询日历、资料库。';

  function money(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); }

  function esc(s) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 记忆 ----------
  function saveMemory() {
    try {
      var chat = messages.filter(function (m) { return m.role !== 'system'; });
      if (chat.length > MEM_MAX) chat = chat.slice(-MEM_MAX);
      localStorage.setItem(MEM_KEY, JSON.stringify(chat));
    } catch (e) { /* ignore */ }
  }

  function restoreMemory() {
    try {
      var saved = localStorage.getItem(MEM_KEY);
      if (saved) {
        var chat = JSON.parse(saved);
        if (Array.isArray(chat) && chat.length > 0) {
          for (var i = 0; i < chat.length; i++) {
            messages.push(chat[i]);
            if (chat[i].role === 'user') appendUserMsgRaw(chat[i].content);
            else if (chat[i].role === 'assistant') appendAiMsgRaw(chat[i].content);
          }
          var note = document.createElement('div');
          note.className = 'xj3-msg system';
          note.textContent = '↩ 已恢复跨页对话记忆（' + chat.length + ' 条）';
          if (bodyEl) bodyEl.appendChild(note);
        }
      }
    } catch (e) { /* ignore */ }
  }

  function ensureSystemPrompt() {
    if (!messages.length || messages[0].role !== 'system') {
      var sys = buildSystemPrompt();
      messages.unshift({ role: 'system', content: sys });
    } else {
      messages[0].content = buildSystemPrompt();
    }
  }

  // ---------- 本地快速查询 ----------
  function queryLocal(text) {
    var q = text.toLowerCase();
    var clients, sessions;
    try {
      if (typeof Store === 'undefined') return null;
      clients = Store.getClients();
      sessions = Store.getSessions();
    } catch (e) { return null; }
    var results = [];

    if (q.indexOf('欠费') >= 0 || q.indexOf('没付') >= 0 || q.indexOf('未收') >= 0) {
      clients.forEach(function (c) {
        var ss = Store.getSessionsByClient(c.id);
        var unpaid = ss.filter(function (s) { return s.billing && s.billing.fee > 0 && !s.billing.paid; });
        if (unpaid.length) {
          var total = unpaid.reduce(function (s, x) { return s + (x.billing.fee || 0); }, 0);
          results.push(c.name + '：' + unpaid.length + '节未付，共' + money(total));
        }
      });
      if (results.length) return { content: '📊 欠费明细：\n' + results.join('\n') };
      return { content: '✅ 目前没有来访者有欠费。' };
    }

    if (q.indexOf('来访者') >= 0 || q.indexOf('客户') >= 0 || q.indexOf('人数') >= 0) {
      var active = clients.filter(function (c) { return c.status !== 'ended'; });
      return { content: '👥 共有 ' + clients.length + ' 位来访者（活跃 ' + active.length + ' 位）。' };
    }

    if ((q.indexOf('收入') >= 0 || q.indexOf('本月') >= 0) && q.indexOf('收') >= 0) {
      var todayStr = (typeof App !== 'undefined' && App.todayStr) ? App.todayStr() : new Date().toISOString().slice(0, 10);
      var ym = todayStr.slice(0, 7);
      var total = 0, paid = 0;
      sessions.forEach(function (s) {
        if (s.date && s.date.slice(0, 7) === ym && s.billing && s.billing.fee > 0) {
          total += s.billing.fee;
          if (s.billing.paid) paid += s.billing.fee;
        }
      });
      return { content: '💰 本月收入：' + money(total) + '（已收 ' + money(paid) + '，待收 ' + money(total - paid) + '）' };
    }

    if (q.indexOf('今天') >= 0 || q.indexOf('今日') >= 0) {
      var today = (typeof App !== 'undefined' && App.todayStr) ? App.todayStr() : new Date().toISOString().slice(0, 10);
      var todayS = sessions.filter(function (s) { return s.date === today; });
      return { content: '📅 今天有 ' + todayS.length + ' 节咨询。' + (todayS.length ? todayS.map(function (s) {
        var c = Store.getClient(s.clientId);
        return '  · ' + (c ? c.name : '?') + ' 第' + (s.sessionNumber || '?') + '节' + (s.billing && s.billing.fee ? ' ¥' + s.billing.fee : '');
      }).join('\n') : '') };
    }

    return null;
  }

  // ---------- 档位 / 授权 ----------
  function tierInfo() {
    try {
      if (typeof AI !== 'undefined' && AI.getTier) return AI.getTier();
    } catch (e) { /* ignore */ }
    return 'builtin';
  }

  function isUnlocked() {
    try {
      if (typeof App !== 'undefined' && typeof App.aiUnlocked === 'function') return App.aiUnlocked();
    } catch (e) { /* ignore */ }
    return true;
  }

  function refreshLock() {
    if (!panelEl) return;
    var unlocked = isUnlocked();
    var inputRow = panelEl.querySelector('.xj3-input-row');
    var lockBanner = panelEl.querySelector('.xj3-lock-banner');
    if (unlocked) {
      if (lockBanner) lockBanner.remove();
      if (inputRow) inputRow.style.display = '';
      refreshTierUI();
    } else {
      var tierBanner = panelEl.querySelector('.xj3-tier-banner');
      if (tierBanner) tierBanner.remove();
      if (inputRow) inputRow.style.display = 'none';
      if (!lockBanner && bodyEl) {
        lockBanner = document.createElement('div');
        lockBanner.className = 'xj3-lock-banner';
        lockBanner.innerHTML = '<div class="xj3-lock-inner">⚠ 小镜需激活后才能使用 AI 对话。<br><button class="xj3-activate-btn">输入激活码</button></div>';
        bodyEl.insertBefore(lockBanner, bodyEl.firstChild);
        lockBanner.querySelector('.xj3-activate-btn').addEventListener('click', function () {
          if (window.__XJ_API__ && typeof window.__XJ_API__.openActivation === 'function') {
            window.__XJ_API__.openActivation();
          }
        });
      }
    }
  }

  function refreshTierUI() {
    if (!panelEl || !bodyEl) return;
    var tier = tierInfo();
    var banner = panelEl.querySelector('.xj3-tier-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'xj3-tier-banner';
      bodyEl.insertBefore(banner, bodyEl.firstChild);
    }
    banner.className = 'xj3-tier-banner ' + (tier === 'user' ? 'tier-user' : 'tier-builtin');
    if (tier === 'user') {
      banner.textContent = '⚡ 已接入你的高性能模型（完全体）';
    } else {
      banner.innerHTML = '🌱 免费试用 · <span class="xj3-quota-name">v4-flash</span>（额度用尽降级基础模型）' +
        '<span class="xj3-quota-pct"></span>';
    }
    updateQuotaBadge();
  }

  function updateQuotaBadge() {
    if (!panelEl) return;
    var pctEl = panelEl.querySelector('.xj3-quota-pct');
    var qEl = panelEl.querySelector('.xj3-quota-name');
    if (!pctEl && !qEl) return;
    var tier = 'builtin';
    try { if (typeof AI !== 'undefined' && AI.getTier) tier = AI.getTier(); } catch (e) {}
    if (tier === 'user') return;
    var q = (typeof AI !== 'undefined' && AI.getQuota) ? AI.getQuota() : null;
    if (pctEl) pctEl.textContent = (q && q.percent != null) ? ('剩余 ' + q.percent + '%') : '';
    if (qEl) qEl.textContent = (q && q.tier === 'basic') ? '基础模型（已降级）' : 'v4-flash';
  }

  // ---------- UI 构建 ----------
  function buildPanelHtml() {
    return '<div class="xj-panel-v3" id="xj-panel-v3">' +
        '<div class="xj3-overlay" id="xj3-overlay"></div>' +
        '<div class="xj3-drawer">' +
          '<div class="xj3-head">' +
            '<div class="xj3-avatar">小</div>' +
            '<div class="xj3-head-info">' +
              '<div class="xj3-name">小镜 <span class="xj3-badge">AI 助手</span></div>' +
              '<div class="xj3-sub" id="xj3-sub">工作台助手</div>' +
            '</div>' +
            '<div style="display:flex;gap:2px;align-items:center">' +
              '<button class="xj3-undo" title="撤销" style="border:none;background:transparent;color:var(--ink-3);font-size:14px;cursor:pointer;padding:4px 8px;border-radius:6px">↶</button>' +
              '<button class="xj3-close" id="xj3-close" title="收起">×</button>' +
            '</div>' +
          '</div>' +
          '<div class="xj3-body" id="xj3-body"></div>' +
          '<div class="xj3-input-row">' +
            '<input id="xj3-input" placeholder="问点什么……" autocomplete="off">' +
            '<button id="xj3-voice" title="语音输入">🎤</button>' +
            '<button id="xj3-send">发送</button>' +
          '</div>' +
        '</div>' +
        '<button class="xj3-fab docked" id="xj3-fab" title="小镜">' +
          '<span class="xj3-fab-icon">小</span>' +
          '<span class="xj3-fab-dot" id="xj3-fab-dot"></span>' +
        '</button>' +
      '</div>';
  }

  function injectStyles() {
    var style = document.createElement('style');
    style.textContent = '' +
      '.xj-panel-v3{position:fixed;top:0;right:0;width:0;height:100vh;z-index:9999;pointer-events:none}' +
      '.xj3-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;' +
        'background:rgba(0,0,0,.35);opacity:0;pointer-events:none;' +
        'will-change:opacity;transition:opacity .3s cubic-bezier(.4,0,.2,1)}' +
      '.xj-panel-v3.open .xj3-overlay{opacity:1;pointer-events:auto}' +
      '.xj3-fab{position:fixed;right:20px;bottom:24px;width:52px;height:52px;border-radius:50%;border:none;' +
        'background:var(--accent);color:#fff;font-size:20px;font-weight:700;font-family:var(--serif);' +
        'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.15);pointer-events:auto;' +
        'will-change:transform,opacity;transition:transform .25s cubic-bezier(.4,0,.2,1),opacity .2s ease;' +
        'display:flex;align-items:center;justify-content:center}' +
      '.xj3-fab.docked{transform:translateX(42px)}' +
      '.xj3-fab:hover{transform:translateX(0) scale(1.06)}' +
      '.xj3-fab:active{transform:translateX(0) scale(.95)}' +
      '.xj-panel-v3.open .xj3-fab{transform:translateX(-360px) scale(0);opacity:0;pointer-events:none}' +
      '.xj3-fab-icon{line-height:1}' +
      '.xj3-fab-dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;' +
        'background:var(--danger,#ff5252);border:2px solid var(--accent);display:none}' +
      '.xj3-fab-dot.show{display:block}' +
      '.xj3-drawer{position:fixed;top:0;right:0;width:360px;height:100vh;' +
        'background:var(--paper-2,#fff);border-left:1px solid var(--border);' +
        'display:flex;flex-direction:column;pointer-events:auto;' +
        'will-change:transform;transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);' +
        'box-shadow:-4px 0 24px rgba(0,0,0,.08)}' +
      '.xj-panel-v3.open .xj3-drawer{transform:translateX(0)}' +
      '.xj3-head{display:flex;align-items:center;gap:10px;padding:14px 16px;' +
        'border-bottom:1px solid var(--border);flex-shrink:0}' +
      '.xj3-avatar{width:40px;height:40px;border-radius:50%;background:var(--accent-soft);' +
        'color:var(--accent);display:flex;align-items:center;justify-content:center;' +
        'font-family:var(--serif);font-weight:700;font-size:18px;flex-shrink:0}' +
      '.xj3-head-info{flex:1;min-width:0}' +
      '.xj3-name{font-family:var(--serif);font-size:15px;font-weight:600}' +
      '.xj3-badge{font-size:9px;padding:1px 6px;border-radius:999px;background:var(--accent-soft);' +
        'color:var(--accent);font-weight:500;margin-left:6px;vertical-align:middle}' +
      '.xj3-sub{font-size:11px;color:var(--ink-3);margin-top:2px}' +
      '.xj3-close,.xj3-undo{border:none;background:none;font-size:20px;color:var(--ink-3);cursor:pointer;' +
        'padding:4px 8px;border-radius:6px;line-height:1}' +
      '.xj3-close:hover,.xj3-undo:hover{background:var(--bg);color:var(--ink)}' +
      '.xj3-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}' +
      '.xj3-msg{max-width:88%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.7;word-break:break-word}' +
      '.xj3-msg.ai{background:var(--accent-soft);color:var(--ink);align-self:flex-start;border-bottom-left-radius:4px}' +
      '.xj3-msg.user{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
      '.xj3-msg.typing{opacity:.6;font-style:italic}' +
      '.xj3-msg.system{background:transparent;color:var(--ink-3);font-size:11px;align-self:center;padding:4px 8px}' +
      '.xj3-msg.progress{background:transparent;color:var(--ink-3);font-size:11px;align-self:flex-start;padding:2px 4px}' +
      '.xj3-tier-banner{font-size:11px;padding:8px 12px;border-radius:8px;margin-bottom:4px;text-align:center}' +
      '.xj3-tier-banner.tier-user{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}' +
      '.xj3-tier-banner.tier-builtin{background:var(--bg);color:var(--ink-2);border:1px solid var(--border)}' +
      '.xj3-tier-banner .xj3-quota-pct{float:right;opacity:.85}' +
      '.xj3-lock-banner{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center;margin-bottom:8px}' +
      '.xj3-lock-inner{font-size:12px;color:var(--ink-2)}' +
      '.xj3-activate-btn{margin-top:8px;padding:6px 14px;border:1px solid var(--accent);border-radius:8px;' +
        'background:var(--accent);color:#fff;font:500 12px var(--sans);cursor:pointer}' +
      '.xj3-hint-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:2px}' +
      '.xj3-hint-card .h-title{font-size:11px;font-weight:600;color:var(--ink-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}' +
      '.xj3-hint-card ul{margin:0;padding-left:18px;font-size:12px;color:var(--ink-2);line-height:1.9}' +
      '.xj3-hint-card li{cursor:pointer}' +
      '.xj3-hint-card li:hover{color:var(--accent)}' +
      '.xj3-quick-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}' +
      '.xj3-quick-actions button{border:1px solid var(--border);background:var(--paper,#fff);' +
        'border-radius:999px;padding:5px 12px;font:11px var(--sans);cursor:pointer;color:var(--ink-2);' +
        'transition:transform .15s ease,border-color .15s ease,color .15s ease;will-change:transform}' +
      '.xj3-quick-actions button:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px)}' +
      '.xj3-input-row{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--border);flex-shrink:0}' +
      '.xj3-input-row input{flex:1;border:1px solid var(--border);border-radius:10px;padding:9px 12px;' +
        'font:13px var(--sans);outline:none;background:var(--bg);transition:border-color .15s ease}' +
      '.xj3-input-row input:focus{border-color:var(--accent)}' +
      '.xj3-input-row button{background:var(--accent);color:#fff;border:none;border-radius:10px;' +
        'padding:0 16px;font:600 13px var(--sans);cursor:pointer;transition:opacity .15s ease}' +
      '.xj3-input-row button:hover{opacity:.9}' +
      '.xj3-input-row button:active{opacity:.8}' +
      '.xj3-input-row #xj3-voice{background:none;border:none;font-size:16px;color:var(--ink-3);cursor:pointer;padding:0 8px;border-radius:8px;transition:color .15s ease}' +
      '.xj3-input-row #xj3-voice:hover{color:var(--accent)}' +
      '.xj3-input-row #xj3-voice.recording{color:#ff5252;animation:pulse 1.5s infinite}' +
      '.xj3-confirm-card{background:var(--paper,#fff);border:1px solid var(--danger,#ff5252);border-radius:10px;' +
        'padding:12px;margin:4px 0;align-self:stretch;box-shadow:0 2px 8px rgba(255,82,82,.1)}' +
      '.xj3-confirm-title{font-size:12px;font-weight:600;color:var(--danger,#ff5252);margin-bottom:8px}' +
      '.xj3-confirm-tool{font-size:11px;color:var(--ink-3);margin-bottom:6px}' +
      '.xj3-confirm-preview{font-size:12px;color:var(--ink);margin-bottom:10px;line-height:1.6}' +
      '.xj3-confirm-actions{display:flex;gap:8px;justify-content:flex-end}' +
      '.xj3-confirm-actions button{padding:6px 14px;border-radius:8px;font:12px var(--sans);cursor:pointer;border:1px solid var(--border);background:var(--paper,#fff);color:var(--ink-2)}' +
      '.xj3-confirm-actions .xj3-ok{background:var(--accent);color:#fff;border-color:var(--accent)}' +
      '.xj3-followup-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;' +
        'padding:10px 12px;margin:2px 0;align-self:stretch}' +
      '.xj3-followup-head{font-size:11px;font-weight:600;color:var(--ink-3);margin-bottom:6px}' +
      '.xj3-followup-item{font-size:12px;color:var(--ink-2);line-height:1.8;padding-left:12px;position:relative;cursor:pointer}' +
      '.xj3-followup-item:before{content:"•";position:absolute;left:0;color:var(--accent)}' +
      '.xj3-followup-item:hover{color:var(--accent)}' +
      '.xj3-nav-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;' +
        'padding:12px;margin:4px 0;align-self:stretch}' +
      '.xj3-nav-head{font-size:12px;font-weight:600;color:var(--ink);margin-bottom:4px}' +
      '.xj3-nav-reason{font-size:11px;color:var(--ink-3);margin-bottom:8px}' +
      '.xj3-nav-go{padding:6px 14px;border-radius:8px;border:1px solid var(--accent);' +
        'background:var(--accent);color:#fff;font:500 12px var(--sans);cursor:pointer}' +
      '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}';
    document.head.appendChild(style);
  }

  // 复用 xiaojing-panel.js 已建好的面板时，只补齐扩展样式（undo、确认卡、跟进制）
  function injectExtensionStyles() {
    if (document.getElementById('xj3-ext-styles')) return;
    var s = document.createElement('style');
    s.id = 'xj3-ext-styles';
    s.textContent = '' +
      '.xj3-undo-btn{position:absolute;top:14px;right:48px;border:1px solid var(--border);' +
        'background:var(--paper,#fff);color:var(--ink-2);font:11px var(--sans);border-radius:6px;' +
        'padding:3px 8px;cursor:pointer}' +
      '.xj3-undo-btn:hover{border-color:var(--accent);color:var(--accent)}' +
      '.xj3-undo-btn:disabled{opacity:.4;cursor:not-allowed}' +
      '.xj3-confirm-card{background:var(--paper,#fff);border:1px solid var(--danger,#ff5252);border-radius:10px;' +
        'padding:12px;margin:4px 0;align-self:stretch;box-shadow:0 2px 8px rgba(255,82,82,.1)}' +
      '.xj3-confirm-title{font-size:12px;font-weight:600;color:var(--danger,#ff5252);margin-bottom:8px}' +
      '.xj3-confirm-tool{font-size:11px;color:var(--ink-3);margin-bottom:6px}' +
      '.xj3-confirm-preview{font-size:12px;color:var(--ink);margin-bottom:10px;line-height:1.6}' +
      '.xj3-confirm-actions{display:flex;gap:8px;justify-content:flex-end}' +
      '.xj3-confirm-actions button{padding:6px 14px;border-radius:8px;font:12px var(--sans);cursor:pointer;border:1px solid var(--border);background:var(--paper,#fff);color:var(--ink-2)}' +
      '.xj3-confirm-actions .xj3-ok{background:var(--accent);color:#fff;border-color:var(--accent)}' +
      '.xj3-progress{font-size:11px;color:var(--ink-3);padding:4px 8px;align-self:flex-start}' +
      '.xj3-followup-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;' +
        'padding:10px 12px;margin:2px 0;align-self:stretch}' +
      '.xj3-followup-head{font-size:11px;font-weight:600;color:var(--ink-3);margin-bottom:6px}' +
      '.xj3-followup-item{font-size:12px;color:var(--ink-2);line-height:1.8;padding-left:12px;position:relative;cursor:pointer}' +
      '.xj3-followup-item:before{content:"•";position:absolute;left:0;color:var(--accent)}' +
      '.xj3-followup-item:hover{color:var(--accent)}' +
      '.xj3-nav-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;' +
        'padding:12px;margin:4px 0;align-self:stretch}' +
      '.xj3-nav-head{font-size:12px;font-weight:600;color:var(--ink);margin-bottom:4px}' +
      '.xj3-nav-reason{font-size:11px;color:var(--ink-3);margin-bottom:8px}' +
      '.xj3-nav-go{padding:6px 14px;border-radius:8px;border:1px solid var(--accent);' +
        'background:var(--accent);color:#fff;font:500 12px var(--sans);cursor:pointer}' +
      '.xj3-lock-banner{background:linear-gradient(135deg,#fff5f0,#fff);border:1px solid #ffb38a;' +
        'border-radius:10px;padding:12px;margin:4px 0;align-self:stretch}' +
      '.xj3-lock-title{font-size:12px;font-weight:600;color:#c44a00;margin-bottom:6px}' +
      '.xj3-lock-desc{font-size:11px;color:var(--ink-2);margin-bottom:8px;line-height:1.5}' +
      '.xj3-lock-go{padding:6px 14px;border-radius:8px;border:1px solid #ff8a4c;background:#ff8a4c;' +
        'color:#fff;font:12px var(--sans);cursor:pointer}';
    document.head.appendChild(s);
  }

  // 复用模式下，绑定 xiaojing-panel.js 未提供的事件（undo 按钮、followup 点击等）
  function bindExtEvents() {
    if (!panelEl) return;
    // 1) 注入 undo 按钮到头部
    var head = panelEl.querySelector('.xj3-head');
    if (head && !panelEl.querySelector('.xj3-undo-btn')) {
      var undo = document.createElement('button');
      undo.className = 'xj3-undo-btn';
      undo.textContent = '↺ 撤销';
      undo.title = '撤销最近一次写入';
      undo.disabled = !lastWriteAction;
      head.appendChild(undo);
      undo.addEventListener('click', function () {
        undoLastWrite();
        if (lastWriteAction) undo.disabled = false;
        else undo.disabled = true;
      });
    }
    // 2) 事件代理：followup / confirm / nav
    bodyEl.addEventListener('click', function (e) {
      var fu = e.target.closest('.xj3-followup-item');
      if (fu) { var t = fu.textContent.replace(/^[•\s]+/, ''); if (t) quickQuery(t); return; }
      var ok = e.target.closest('.xj3-confirm-actions .xj3-ok');
      if (ok) {
        var card = ok.closest('.xj3-confirm-card');
        var cb = card && card._resolveOk;
        if (cb) cb({ ok: true });
        if (card) card.remove();
        return;
      }
      var cancel = e.target.closest('.xj3-confirm-actions button:not(.xj3-ok)');
      if (cancel) {
        var card2 = cancel.closest('.xj3-confirm-card');
        var cb2 = card2 && card2._resolveOk;
        if (cb2) cb2({ ok: false });
        if (card2) card2.remove();
        return;
      }
      var nav = e.target.closest('.xj3-nav-go');
      if (nav) {
        var nc = nav.closest('.xj3-nav-card');
        var href = nc && nc.getAttribute('data-href');
        if (href) location.href = href;
      }
    });
  }

  function build() {
    if (panelEl) return panelEl;

    // 如果页面里 xiaojing-panel.js 已经创建了面板（#xj-panel-v3），
    // 则复用其 DOM 与 FAB，避免双悬浮球。但需要把 xiaojing-panel.js
    // 已经绑定的 click 监听器清掉（用 cloneNode 替换关键元素），
    // 再由 xinjing-chat 重新绑定。
    var existing = document.getElementById('xj-panel-v3');
    if (existing) {
      // 替换 fab / close / overlay / send / voice / input，剥离旧事件
      var fabOld = existing.querySelector('#xj3-fab');
      var closeOld = existing.querySelector('#xj3-close');
      var overlayOld = existing.querySelector('#xj3-overlay');
      var sendOld = existing.querySelector('#xj3-send');
      var voiceOld = existing.querySelector('#xj3-voice');
      var inputOld = existing.querySelector('#xj3-input');
      function rebind(orig, key) {
        if (!orig) return null;
        var fresh = orig.cloneNode(true);
        orig.parentNode.replaceChild(fresh, orig);
        return existing.querySelector(key);
      }
      rebind(fabOld, '#xj3-fab');
      rebind(closeOld, '#xj3-close');
      rebind(overlayOld, '#xj3-overlay');
      rebind(sendOld, '#xj3-send');
      rebind(voiceOld, '#xj3-voice');
      rebind(inputOld, '#xj3-input');

      panelEl = existing;
      bodyEl = panelEl.querySelector('#xj3-body');
      inputEl = panelEl.querySelector('#xj3-input');
      hintDotEl = panelEl.querySelector('#xj3-fab-dot');
      try {
        var fab = panelEl.querySelector('#xj3-fab');
        if (fab) fab.addEventListener('click', toggle);
        var closeBtn = panelEl.querySelector('#xj3-close');
        if (closeBtn) closeBtn.addEventListener('click', toggle);
        var ov = panelEl.querySelector('#xj3-overlay');
        if (ov) ov.addEventListener('click', toggle);
        if (inputEl) inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') send();
        });
        var sendBtn = panelEl.querySelector('#xj3-send');
        if (sendBtn) sendBtn.addEventListener('click', send);
        var voiceBtn = panelEl.querySelector('#xj3-voice');
        if (voiceBtn) voiceBtn.addEventListener('click', toggleVoice);
      } catch (e) { /* ignore */ }
      injectExtensionStyles();
      ensureSystemPrompt();
      refreshLock();
      renderGreeting();
      restoreMemory();
      bindExtEvents();
      try {
        if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
          window.__XJ_API__.onLicenseState(function () { refreshLock(); });
        }
      } catch (e) { /* ignore */ }
      try {
        if (typeof AI !== 'undefined' && AI.onQuotaChange) {
          AI.onQuotaChange(function () { updateQuotaBadge(); });
        }
      } catch (e) { /* ignore */ }
      return panelEl;
    }

    injectStyles();
    panelEl = document.createElement('div');
    panelEl.innerHTML = buildPanelHtml();
    document.body.appendChild(panelEl);
    panelEl = document.getElementById('xj-panel-v3');

    bodyEl = panelEl.querySelector('#xj3-body');
    inputEl = panelEl.querySelector('#xj3-input');
    hintDotEl = panelEl.querySelector('#xj3-fab-dot');

    panelEl.querySelector('#xj3-fab').addEventListener('click', toggle);
    panelEl.querySelector('#xj3-close').addEventListener('click', toggle);
    panelEl.querySelector('#xj3-overlay').addEventListener('click', toggle);
    panelEl.querySelector('.xj3-undo').addEventListener('click', undoLastWrite);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
    panelEl.querySelector('#xj3-send').addEventListener('click', send);
    panelEl.querySelector('#xj3-voice').addEventListener('click', toggleVoice);

    bodyEl.addEventListener('click', function (e) {
      var li = e.target.closest('#xj3-hint-list li');
      if (li) {
        var hint = li.getAttribute('data-hint');
        if (hint) askHint(hint);
      }
      var fi = e.target.closest('.xj3-followup-item');
      if (fi) {
        var txt = fi.textContent.trim();
        if (txt) quickQuery(txt);
      }
    });

    ensureSystemPrompt();
    refreshLock();
    renderGreeting();
    restoreMemory();

    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(function () { refreshLock(); });
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof AI !== 'undefined' && AI.onQuotaChange) {
        AI.onQuotaChange(function () { updateQuotaBadge(); });
      }
    } catch (e) { /* ignore */ }

    dailyCheck();
    return panelEl;
  }

  // ---------- 欢迎语 ----------
  function renderGreeting() {
    if (!bodyEl) return;
    var hasMemory = false;
    try {
      var saved = localStorage.getItem(MEM_KEY);
      if (saved) {
        var chat = JSON.parse(saved);
        hasMemory = Array.isArray(chat) && chat.length > 0;
      }
    } catch (e) {}
    if (hasMemory) return;

    var profile = (typeof Memory !== 'undefined' && Memory.getProfile) ? Memory.getProfile() : {};
    var userName = (profile && profile.name) || '梅';

    var hintList = [];
    try {
      if (typeof PageHints !== 'undefined' && PageHints.getHints) {
        hintList = PageHints.getHints(location.pathname);
      }
    } catch (e) { /* ignore */ }

    var html = '';
    html += '<div class="xj3-msg ai">你好，' + esc(userName) + '。<br>' +
      '我是小镜，你的工作台助手。有什么可以帮你的？</div>';

    if (hintList.length) {
      html += '<div class="xj3-hint-card" id="xj3-hint-list"><div class="h-title">📌 今日提醒</div><ul>';
      hintList.forEach(function (h) {
        html += '<li data-hint="' + esc(h) + '">' + esc(h) + '</li>';
      });
      html += '</ul></div>';
    }

    var pageCtx = getPageContext();
    if (pageCtx && pageCtx.capabilities && pageCtx.capabilities.length) {
      html += '<div class="xj3-hint-card"><div class="h-title">💡 ' + esc(pageCtx.title || '本页功能') + '</div><ul>';
      pageCtx.capabilities.forEach(function (c) {
        html += '<li>' + esc(c) + '</li>';
      });
      html += '</ul></div>';
    }

    html += '<div class="xj3-quick-actions">' +
      '<button onclick="XinJingChat.quickQuery(\'今天有几节咨询\')">今日安排</button>' +
      '<button onclick="XinJingChat.quickQuery(\'谁欠费\')">欠费查询</button>' +
      '<button onclick="XinJingChat.quickQuery(\'本月收入\')">本月收入</button>' +
      '<button onclick="XinJingChat.quickQuery(\'有多少来访者\')">来访者</button>' +
      '</div>';

    bodyEl.innerHTML = html;
    bodyEl.scrollTop = 0;
  }

  function getPageContext() {
    if (typeof window !== 'undefined' && window.__XJ_PAGE__) return window.__XJ_PAGE__;
    return null;
  }

  // ---------- 消息渲染 ----------
  function appendUserMsg(text) {
    appendUserMsgRaw(text);
    messages.push({ role: 'user', content: text });
  }
  function appendUserMsgRaw(text) {
    if (!bodyEl) return;
    var div = document.createElement('div');
    div.className = 'xj3-msg user';
    div.textContent = text;
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendAiMsg(text, isTyping) {
    var div = appendAiMsgRaw(text, isTyping);
    if (!isTyping) messages.push({ role: 'assistant', content: text });
    return div;
  }
  function appendAiMsgRaw(text, isTyping) {
    if (!bodyEl) return null;
    var div = document.createElement('div');
    div.className = 'xj3-msg ai' + (isTyping ? ' typing' : '');
    div.innerHTML = esc(text || '').replace(/\n/g, '<br>');
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return div;
  }

  function updateAiMsg(div, text) {
    if (!div) return;
    div.classList.remove('typing');
    div.innerHTML = esc(text).replace(/\n/g, '<br>');
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendSystemMsg(text) {
    if (!bodyEl) return;
    var div = document.createElement('div');
    div.className = 'xj3-msg system';
    div.textContent = text;
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendProgress(text) {
    if (!bodyEl) return;
    var div = document.createElement('div');
    div.className = 'xj3-msg progress';
    div.textContent = text;
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return div;
  }

  // ---------- System Prompt ----------
  function buildSystemPrompt() {
    var preamble = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
    var ctx = '';
    try {
      if (typeof Store !== 'undefined') {
        var clients = Store.getClients();
        var sessions = Store.getSessions();
        var todayStr = (typeof App !== 'undefined' && App.todayStr) ? App.todayStr() : new Date().toISOString().slice(0, 10);
        var todayS = sessions.filter(function (s) { return s.date === todayStr; });
        var owingCount = clients.filter(function (c) {
          return Store.getSessionsByClient(c.id).some(function (s) { return s.billing && s.billing.fee > 0 && !s.billing.paid; });
        }).length;
        var ym = todayStr.slice(0, 7);
        var monthIncome = sessions.filter(function (s) {
          return s.date && s.date.slice(0, 7) === ym && s.billing && s.billing.fee > 0;
        }).reduce(function (s, x) { return s + (x.billing.fee || 0); }, 0);
        ctx = '【当前真实数据概览】\n' +
          '今日咨询：' + todayS.length + '节\n' +
          '来访者总数：' + clients.length + '位\n' +
          '有欠费的来访者：' + owingCount + '位\n' +
          '本月收入：' + money(monthIncome) + '\n\n' +
          '【重要规则】\n' +
          '- 如果用户问数据问题，你可以引用上面这个数据概览回答。\n' +
          '- 如果需要更详细的数据或写入操作，使用提供的工具。\n' +
          '- 如果用户问的专业问题超出你的能力范围，诚实地让对方去AI督导页面。';
      }
    } catch (e) { /* ignore */ }

    var pageCtx = getPageContext();
    if (pageCtx && pageCtx.title) {
      ctx += '\n\n【当前页面】' + pageCtx.title;
      if (pageCtx.capabilities) ctx += '\n本页能力：' + pageCtx.capabilities.join('、');
    }

    return (preamble ? preamble + '\n\n' : '') + XIAOJING_IDENTITY + '\n\n' + ctx;
  }

  // ---------- 确认卡 ----------
  function requestConfirm(toolCall, args) {
    return new Promise(function (resolve) {
      if (!bodyEl) { resolve({ ok: false }); return; }
      var card = document.createElement('div');
      card.className = 'xj3-confirm-card';
      var toolName = (toolCall && toolCall.function && toolCall.function.name) || '';
      var previewHtml = '';
      try {
        previewHtml = renderConfirmPreview(toolName, args);
      } catch (e) { previewHtml = '<div style="font-size:12px;color:var(--ink-3)">参数：' + esc(JSON.stringify(args)) + '</div>'; }
      card.innerHTML =
        '<div class="xj3-confirm-title">⚠ 即将执行写入操作</div>' +
        '<div class="xj3-confirm-tool">工具：' + esc(toolName) + '</div>' +
        '<div class="xj3-confirm-preview">' + previewHtml + '</div>' +
        '<div class="xj3-confirm-actions">' +
          '<button class="xj3-cancel">取消</button>' +
          '<button class="xj3-ok">确认执行</button>' +
        '</div>';
      bodyEl.appendChild(card);
      bodyEl.scrollTop = bodyEl.scrollHeight;
      card.querySelector('.xj3-ok').addEventListener('click', function () {
        card.remove();
        resolve({ ok: true });
      });
      card.querySelector('.xj3-cancel').addEventListener('click', function () {
        card.remove();
        resolve({ ok: false });
      });
    });
  }

  function renderConfirmPreview(toolName, args) {
    var tn = toolName.replace(/_/g, '.');
    if ((toolName === 'billing_add_record' || tn === 'billing.add_record') && Array.isArray(args.records)) {
      var rows = args.records.map(function (r, i) {
        return '<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">' +
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
      return '<div style="font-size:12px">来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b> 月份：<b>' + esc(args.month || '') + '</b> 金额：<b>¥' + esc(String(args.amount || 0)) + '</b></div>';
    }
    if (toolName === 'client_update' || tn === 'client.update') {
      var keys = Object.keys(args.patch || {}).join(', ');
      return '<div style="font-size:12px">来访者 ID：<b>' + esc(args.clientId || '') + '</b><br>修改字段：<b>' + esc(keys) + '</b></div>';
    }
    if (toolName === 'supervision_start' || tn === 'supervision.start') {
      var modeName = args.supervisorName === 'cangjie' ? '仓颉版' : '女娲版';
      var materialPreview = String(args.material || '').slice(0, 200) + (String(args.material || '').length > 200 ? '…' : '');
      return '<div style="font-size:12px">' +
        '督导师：<b>' + esc(modeName) + '</b><br>' +
        '来访者：<b>' + esc(args.clientName || args.clientId || '') + '</b><br>' +
        '材料预览：<span style="font-size:11px;color:var(--ink-3)">' + esc(materialPreview) + '</span>' +
      '</div>';
    }
    return '<div style="font-size:12px;color:var(--ink-3)">参数：' + esc(JSON.stringify(args)) + '</div>';
  }

  // ---------- 跟进卡 / 导航卡 ----------
  function renderFollowupCard(items) {
    if (!bodyEl || !Array.isArray(items) || !items.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'xj3-followup-card';
    var head = document.createElement('div');
    head.className = 'xj3-followup-head';
    head.textContent = '💡 跟进提示';
    wrap.appendChild(head);
    items.forEach(function (t) {
      var it = document.createElement('div');
      it.className = 'xj3-followup-item';
      it.textContent = t;
      wrap.appendChild(it);
    });
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function renderNavCard(card) {
    if (!bodyEl || !card) return;
    var wrap = document.createElement('div');
    wrap.className = 'xj3-nav-card';
    var reason = card.reason ? ('<div class="xj3-nav-reason">' + esc(card.reason) + '</div>') : '';
    wrap.innerHTML =
      '<div class="xj3-nav-head">💡 建议前往「' + esc(card.label || '') + '」</div>' +
      reason +
      '<button class="xj3-nav-go">' + esc(card.label || '去看看') + ' →</button>';
    wrap.querySelector('.xj3-nav-go').addEventListener('click', function () {
      if (card.href) location.href = card.href;
    });
    bodyEl.appendChild(wrap);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function toast(msg, type) {
    if (typeof App !== 'undefined' && typeof App.showToast === 'function') {
      App.showToast(msg, type || 'success');
    }
  }

  // ---------- 撤销 ----------
  function recordWriteAction(toolName, args, result) {
    lastWriteAction = { toolName: toolName, args: args, result: result, ts: Date.now() };
  }

  function undoLastWrite() {
    if (!lastWriteAction) {
      toast('没有可撤销的操作', 'info');
      return;
    }
    var w = lastWriteAction;
    if ((w.toolName === 'billing.add_record' || w.toolName === 'billing_add_record') && w.result && w.result.sessionIds) {
      try {
        w.result.sessionIds.forEach(function (sid) {
          if (typeof Store !== 'undefined' && Store.deleteSession) Store.deleteSession(sid);
        });
        toast('已撤销 ' + w.result.sessionIds.length + ' 条记账记录', 'success');
        lastWriteAction = null;
      } catch (e) {
        toast('撤销失败：' + (e.message || ''), 'error');
      }
    } else {
      toast('该操作不支持撤销', 'info');
    }
  }

  // ---------- 发送 ----------
  async function send() {
    if (busy) return;
    if (!inputEl) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    build();
    refreshLock();
    appendUserMsg(text);

    var local = queryLocal(text);
    if (local) {
      appendAiMsg(local.content);
      saveMemory();
      return;
    }

    if (!isUnlocked()) {
      appendAiMsg('小镜需激活后才能使用 AI 对话。请先在设置中配置 AI 密钥。');
      saveMemory();
      return;
    }

    var hasAgentCore = typeof AgentCore !== 'undefined' && typeof AgentCore.runRound === 'function';
    var hasTools = typeof AgentTools !== 'undefined';
    busy = true;
    var typingDiv = appendAiMsg('思考中…', true);

    try {
      ensureSystemPrompt();
      if (hasAgentCore && hasTools) {
        var result = await AgentCore.runRound(messages, requestConfirm, function (name, status, data) {
          updateAiMsg(typingDiv, '');
          if (status === 'executing') appendProgress('正在执行：' + name + '…');
          else if (status === 'done') {
            if (data && data.switchedTo === 'user') {
              refreshTierUI();
              toast('已切换到你的高性能模型，我现在是完全体，可以做更多事', 'success');
              return;
            }
            if (data && data.switchedTo === 'builtin' && data.testError) {
              refreshTierUI();
              toast('接入测试未通过：' + data.testError + '，已降级到内置模型', 'error');
              return;
            }
            if (data && data.switchedTo === 'partial') {
              appendProgress(data.message || '已记录部分配置');
              return;
            }
            if (data && data.card && data.card.kind === 'navigate_hint') {
              renderNavCard(data.card);
              return;
            }
            if (data) {
              var summary = data.added !== undefined ? ('✓ 已新增 ' + data.added + ' 条记录' + (data.skipped ? '，跳过 ' + data.skipped + ' 条' : ''))
                : (data.receivable !== undefined ? ('✓ 应收 ¥' + data.receivable + ' / 已收 ¥' + data.received + ' / 余额 ¥' + data.balance)
                : '✓ 已完成');
              appendProgress(summary);
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
        if (result.error) {
          updateAiMsg(typingDiv, '⚠ ' + result.error);
        } else if (result.reply) {
          // AgentCore.runRound 已把模型消息写入 messages（同一数组引用），此处仅渲染，不再 push。
          updateAiMsg(typingDiv, result.reply);
        } else {
          // result.reply 为空：AgentCore 已写入最终 assistant 消息（可能 content 为空），
          // 仅补充友好兜底文案并就地修正最后一条消息，避免重复 push 产生两条 assistant。
          updateAiMsg(typingDiv, '（已完成）');
          var last = messages[messages.length - 1];
          if (last && last.role === 'assistant' && !last.content) {
            last.content = '已完成。';
          }
        }
      } else {
        if (typeof AI !== 'undefined' && AI.send) {
          var sys = buildSystemPrompt();
          AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
            if (res && res.error) {
              updateAiMsg(typingDiv, '出错：' + res.error);
            } else {
              var content = (res && res.content) || '（未获得回复）';
              updateAiMsg(typingDiv, content);
              messages.push({ role: 'assistant', content: content });
            }
            busy = false;
            saveMemory();
          });
          return;
        } else {
          updateAiMsg(typingDiv, 'AI 模块未就绪，请重启应用。');
        }
      }
    } catch (e) {
      updateAiMsg(typingDiv, '出错：' + (e.message || '未知错误'));
    }
    busy = false;
    saveMemory();
  }

  function quickQuery(text) {
    if (!inputEl) return;
    inputEl.value = text;
    send();
  }

  function askHint(hint) {
    if (!inputEl) return;
    inputEl.value = hint;
    send();
  }

  // ---------- 语音输入 ----------
  var voiceRecognition = null;
  var isRecording = false;

  function toggleVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      appendAiMsg('当前浏览器不支持语音输入');
      return;
    }
    var voiceBtn = panelEl.querySelector('#xj3-voice');
    if (!voiceBtn) return;

    if (!voiceRecognition) {
      voiceRecognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
      voiceRecognition.lang = 'zh-CN';
      voiceRecognition.interimResults = true;
      voiceRecognition.onresult = function (e) {
        var interim = '';
        var final = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) final += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (inputEl) inputEl.value = final + interim;
      };
      voiceRecognition.onend = function () {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceBtn.textContent = '🎤';
      };
      voiceRecognition.onerror = function (e) {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceBtn.textContent = '🎤';
        appendAiMsg('语音输入出错：' + (e.error || '未知错误'));
      };
    }

    if (isRecording) {
      voiceRecognition.stop();
    } else {
      voiceRecognition.start();
      isRecording = true;
      voiceBtn.classList.add('recording');
      voiceBtn.textContent = '⏹';
    }
  }

  // ---------- 开关 ----------
  function toggle() {
    build();
    isOpen = !isOpen;
    if (isOpen) {
      panelEl.classList.add('open');
      var f = panelEl.querySelector('#xj3-fab');
      if (f) f.classList.remove('docked');
      clearNewHint();
      setTimeout(function () { if (inputEl) inputEl.focus(); }, 300);
    } else {
      panelEl.classList.remove('open');
      var f2 = panelEl.querySelector('#xj3-fab');
      if (f2) f2.classList.add('docked');
    }
  }

  function open() {
    build();
    if (!isOpen) {
      isOpen = true;
      panelEl.classList.add('open');
      var f = panelEl.querySelector('#xj3-fab');
      if (f) f.classList.remove('docked');
      clearNewHint();
      setTimeout(function () { if (inputEl) inputEl.focus(); }, 300);
    }
  }

  function close() {
    if (isOpen && panelEl) {
      isOpen = false;
      panelEl.classList.remove('open');
      var f = panelEl.querySelector('#xj3-fab');
      if (f) f.classList.add('docked');
    }
  }

  function showNewHint() {
    build();
    hasNewHint = true;
    if (hintDotEl) hintDotEl.classList.add('show');
  }

  function clearNewHint() {
    hasNewHint = false;
    if (hintDotEl) hintDotEl.classList.remove('show');
  }

  function updateSub(text) {
    build();
    var sub = panelEl.querySelector('#xj3-sub');
    if (sub) sub.textContent = text || '工作台助手';
  }

  function refresh() {
    build();
    messages = [];
    ensureSystemPrompt();
    renderGreeting();
  }

  // ---------- 每日检查 ----------
  function dailyCheck() {
    try {
      if (location.pathname.indexOf('index.html') < 0 && location.pathname.indexOf('dashboard') < 0 && location.pathname !== '/') return;
      var today = new Date().toISOString().slice(0, 10);
      var lastCheck = localStorage.getItem('xj_daily_check');
      if (lastCheck === today) return;
      localStorage.setItem('xj_daily_check', today);

      var sessions = [];
      try { if (typeof Store !== 'undefined') sessions = Store.getSessions(); } catch (e) {}
      var pending = sessions.filter(function (s) {
        var fee = (s.billing && s.billing.fee) || 0;
        return fee > 0 && !(s.billing && s.billing.paid);
      });

      var stale = [];
      try {
        if (typeof Store !== 'undefined') {
          var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
          var now = Date.now();
          clients.forEach(function (c) {
            var cs = sessions.filter(function (s) { return s.clientId === c.id; });
            cs.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
            if (cs.length > 0 && cs[0].date) {
              var daysAgo = Math.floor((now - new Date(cs[0].date).getTime()) / 86400000);
              if (daysAgo > 30) stale.push(c.name + '（' + daysAgo + '天未会谈）');
            }
          });
        }
      } catch (e) {}

      if (pending.length > 0 || stale.length > 0) {
        var msg = '';
        if (pending.length > 0) msg += '📋 ' + pending.length + ' 笔未收款 ';
        if (stale.length > 0) msg += '⏰ ' + stale.length + ' 位来访者待跟进';
        try {
          if (typeof App !== 'undefined' && App.showToast) App.showToast(msg.trim(), 'info');
        } catch (e) {}
      }
    } catch (e) {}
  }

  // ---------- 加载自检 ----------
  // 校验统一对话面板 API 表面完整，供 app.js 初始化时调用。
  function selfTest() {
    var expected = ['build', 'toggle', 'open', 'close', 'send', 'quickQuery',
      'askHint', 'showNewHint', 'clearNewHint', 'updateSub', 'refresh', 'undo'];
    var missing = expected.filter(function (m) { return typeof api[m] !== 'function'; });
    var loaded = typeof window !== 'undefined' && window.XinJingChat === api;
    return { ok: missing.length === 0 && loaded, missing: missing, loaded: loaded };
  }

  // ---------- 导出 ----------
  var api = {
    build: build, toggle: toggle, open: open, close: close,
    send: send, quickQuery: quickQuery, askHint: askHint,
    showNewHint: showNewHint, clearNewHint: clearNewHint,
    updateSub: updateSub, refresh: refresh, undo: undoLastWrite,
    selfTest: selfTest
  };

  if (typeof window !== 'undefined') {
    window.XinJingChat = api;
    window.XiaojingPanel = api;
    window.toggleXiaojing = toggle;
    window.AgentOpen = open;
    window.AgentClose = close;
    window.AgentSend = function (text) {
      build();
      if (!isOpen) open();
      if (text) quickQuery(text);
    };
    window.AgentUndo = undoLastWrite;

    // 加载时主动接管 xiaojing-panel.js 已建好的面板（避免双悬浮球 / 重复事件）
    if (document.getElementById('xj-panel-v3') && !panelEl) {
      try { build(); } catch (e) { console.warn('[xinjing-chat] takeover fail', e); }
    }
  }

  return api;
})();
