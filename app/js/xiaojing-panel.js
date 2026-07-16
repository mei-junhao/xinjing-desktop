/* ============================================================
 * 心镜 XinJing — 小镜面板（v3.5.0 预览版）
 * 设计原则：动画只走 transform + opacity，避免布局重排卡顿
 * ============================================================ */
'use strict';

const XiaojingPanel = (() => {
  var panelEl = null;
  var bodyEl = null;
  var inputEl = null;
  var isOpen = false;
  var hasNewHint = false;
  var hintDotEl = null;

  var XIAOJING_IDENTITY = '你是心镜（XinJing）的助手「小镜」，身份设定：\n' +
    '- 你是心理咨询师的专业助理，不是AI督导，也不是大师。\n' +
    '- 你的职责是帮助管理日常工作：查看来访者信息、记账、提醒待办、回答关于app功能的问题。\n' +
    '- 你绝对不能说没有来源的话。如果用户问数据问题，你必须先查实时数据再回答，不能编造。\n' +
    '- 如果用户问的专业问题超出你的知识范围，诚实地说"这个需要请教AI督导或真人督导"。\n' +
    '- 回复简洁专业，用中文，语气温暖有边界。\n' +
    '- 你可以引导用户去各个页面：咨询记录、逐字稿整理、撰写报告、AI督导、真人督导、文档中心、账单、大师对话、设置、咨询日历、资料库。';

  function money(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); }

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
      if (results.length) return { type: 'text', content: '📊 欠费明细：\n' + results.join('\n') };
      return { type: 'text', content: '✅ 目前没有来访者有欠费。' };
    }

    if (q.indexOf('来访者') >= 0 || q.indexOf('客户') >= 0 || q.indexOf('人数') >= 0) {
      var active = clients.filter(function (c) { return c.status !== 'ended'; });
      return { type: 'text', content: '👥 共有 ' + clients.length + ' 位来访者（活跃 ' + active.length + ' 位）。' };
    }

    if (q.indexOf('收入') >= 0 || q.indexOf('本月') >= 0) {
      var todayStr = (typeof App !== 'undefined' && App.todayStr) ? App.todayStr() : new Date().toISOString().slice(0, 10);
      var ym = todayStr.slice(0, 7);
      var total = 0, paid = 0;
      sessions.forEach(function (s) {
        if (s.date && s.date.slice(0, 7) === ym && s.billing && s.billing.fee > 0) {
          total += s.billing.fee;
          if (s.billing.paid) paid += s.billing.fee;
        }
      });
      return { type: 'text', content: '💰 本月收入：' + money(total) + '（已收 ' + money(paid) + '，待收 ' + money(total - paid) + '）' };
    }

    if (q.indexOf('今天') >= 0 || q.indexOf('今日') >= 0) {
      var today = (typeof App !== 'undefined' && App.todayStr) ? App.todayStr() : new Date().toISOString().slice(0, 10);
      var todayS = sessions.filter(function (s) { return s.date === today; });
      return { type: 'text', content: '📅 今天有 ' + todayS.length + ' 节咨询。' + (todayS.length ? todayS.map(function (s) {
        var c = Store.getClient(s.clientId);
        return '  · ' + (c ? c.name : '?') + ' 第' + (s.sessionNumber || '?') + '节' + (s.billing && s.billing.fee ? ' ¥' + s.billing.fee : '');
      }).join('\n') : '') };
    }

    return null;
  }

  function escapeHtml(s) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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
            '<button class="xj3-close" id="xj3-close" title="收起">×</button>' +
          '</div>' +
          '<div class="xj3-body" id="xj3-body"></div>' +
          '<div class="xj3-input-row">' +
            '<input id="xj3-input" placeholder="问点什么……" autocomplete="off">' +
            '<button id="xj3-send">发送</button>' +
          '</div>' +
        '</div>' +
        '<button class="xj3-fab docked" id="xj3-fab" title="小镜">' +
          '<span class="xj3-fab-icon">小</span>' +
          '<span class="xj3-fab-dot" id="xj3-fab-dot"></span>' +
        '</button>' +
      '</div>';
  }

  function build() {
    if (panelEl) return panelEl;

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
      // 默认吸附在右侧：仅露出约 10px 边缘，不遮挡输入区；hover 或打开时滑出完整
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
      '.xj-panel-v3.open .xj3-fab{transform:translateX(-360px) scale(0);opacity:0;pointer-events:none}' +
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
      '.xj3-close{border:none;background:none;font-size:22px;color:var(--ink-3);cursor:pointer;' +
        'padding:4px 8px;border-radius:6px;line-height:1}' +
      '.xj3-close:hover{background:var(--bg);color:var(--ink)}' +
      '.xj3-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}' +
      '.xj3-msg{max-width:88%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.7;word-break:break-word}' +
      '.xj3-msg.ai{background:var(--accent-soft);color:var(--ink);align-self:flex-start;border-bottom-left-radius:4px}' +
      '.xj3-msg.user{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
      '.xj3-msg.typing{opacity:.6;font-style:italic}' +
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
      '.xj3-input-row button:active{opacity:.8}';
    document.head.appendChild(style);

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
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
    panelEl.querySelector('#xj3-send').addEventListener('click', send);

    bodyEl.addEventListener('click', function (e) {
      var li = e.target.closest('#xj3-hint-list li');
      if (li) {
        var hint = li.getAttribute('data-hint');
        if (hint) askHint(hint);
      }
    });

    renderGreeting();
    return panelEl;
  }

  function renderGreeting() {
    if (!bodyEl) return;
    var html = '';
    var profile = (typeof Memory !== 'undefined' && Memory.getProfile) ? Memory.getProfile() : {};
    var userName = (profile && profile.name) || '梅';

    var hintList = [];
    try {
      if (typeof PageHints !== 'undefined' && PageHints.getHints) {
        hintList = PageHints.getHints(location.pathname);
      }
    } catch (e) { /* ignore */ }

    html += '<div class="xj3-msg ai">你好，' + escapeHtml(userName) + '。<br>' +
      '我是小镜，你的工作台助手。有什么可以帮你的？</div>';

    if (hintList.length) {
      html += '<div class="xj3-hint-card" id="xj3-hint-list"><div class="h-title">📌 今日提醒</div><ul>';
      hintList.forEach(function (h) {
        html += '<li data-hint="' + escapeHtml(h) + '">' + escapeHtml(h) + '</li>';
      });
      html += '</ul></div>';
    }

    var pageCtx = getPageContext();
    if (pageCtx && pageCtx.capabilities && pageCtx.capabilities.length) {
      html += '<div class="xj3-hint-card"><div class="h-title">💡 ' + escapeHtml(pageCtx.title || '本页功能') + '</div><ul>';
      pageCtx.capabilities.forEach(function (c) {
        html += '<li>' + escapeHtml(c) + '</li>';
      });
      html += '</ul></div>';
    }

    html += '<div class="xj3-quick-actions">' +
      '<button onclick="XiaojingPanel.quickQuery(\'今天有几节咨询\')">今日安排</button>' +
      '<button onclick="XiaojingPanel.quickQuery(\'谁欠费\')">欠费查询</button>' +
      '<button onclick="XiaojingPanel.quickQuery(\'本月收入\')">本月收入</button>' +
      '<button onclick="XiaojingPanel.quickQuery(\'有多少来访者\')">来访者</button>' +
      '</div>';

    bodyEl.innerHTML = html;
    bodyEl.scrollTop = 0;
  }

  function getPageContext() {
    if (typeof window !== 'undefined' && window.__XJ_PAGE__) return window.__XJ_PAGE__;
    return null;
  }

  function appendUserMsg(text) {
    if (!bodyEl) return;
    var div = document.createElement('div');
    div.className = 'xj3-msg user';
    div.textContent = text;
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendAiMsg(text, isTyping) {
    if (!bodyEl) return null;
    var div = document.createElement('div');
    div.className = 'xj3-msg ai' + (isTyping ? ' typing' : '');
    div.innerHTML = escapeHtml(text || '').replace(/\n/g, '<br>');
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return div;
  }

  function updateAiMsg(div, text) {
    if (!div) return;
    div.classList.remove('typing');
    div.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

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
          '- 如果用户问数据问题，你只能引用上面这个数据概览，不能编造数字。\n' +
          '- 如果用户问的问题需要查更细的数据（如特定来访者的欠费），引导用户去账单页面自己查看。\n' +
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

  function send() {
    if (!inputEl) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    build();
    appendUserMsg(text);

    var local = queryLocal(text);
    if (local) {
      appendAiMsg(local.content);
      return;
    }

    if (!(typeof App !== 'undefined' && App.aiUnlocked && App.aiUnlocked())) {
      appendAiMsg('小镜需激活后才能使用 AI 对话。请先在设置中配置 AI 密钥。');
      return;
    }

    var typingDiv = appendAiMsg('思考中…', true);
    try {
      var sys = buildSystemPrompt();
      if (typeof AI !== 'undefined' && AI.send) {
        AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
          if (res && res.error) {
            updateAiMsg(typingDiv, '出错：' + res.error);
          } else {
            updateAiMsg(typingDiv, (res && res.content) || '（未获得回复）');
          }
        });
      } else {
        updateAiMsg(typingDiv, 'AI 模块未就绪，请重启应用。');
      }
    } catch (e) {
      updateAiMsg(typingDiv, '出错：' + (e.message || '未知错误'));
    }
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

  function toggle() {
    build();
    isOpen = !isOpen;
    if (isOpen) {
      panelEl.classList.add('open');
      if (panelEl) { var f = panelEl.querySelector('#xj3-fab'); if (f) f.classList.remove('docked'); }
      clearNewHint();
      setTimeout(function () { if (inputEl) inputEl.focus(); }, 300);
    } else {
      panelEl.classList.remove('open');
      if (panelEl) { var f2 = panelEl.querySelector('#xj3-fab'); if (f2) f2.classList.add('docked'); }
    }
  }

  function open() {
    build();
    if (!isOpen) {
      isOpen = true;
      panelEl.classList.add('open');
      if (panelEl) { var f = panelEl.querySelector('#xj3-fab'); if (f) f.classList.remove('docked'); }
      clearNewHint();
      setTimeout(function () { if (inputEl) inputEl.focus(); }, 300);
    }
  }

  function close() {
    if (isOpen && panelEl) {
      isOpen = false;
      panelEl.classList.remove('open');
      if (panelEl) { var f = panelEl.querySelector('#xj3-fab'); if (f) f.classList.add('docked'); }
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
    renderGreeting();
  }

  if (typeof window !== 'undefined') {
    window.XiaojingPanel = {
      build: build, toggle: toggle, open: open, close: close,
      send: send, quickQuery: quickQuery, askHint: askHint,
      showNewHint: showNewHint, clearNewHint: clearNewHint,
      updateSub: updateSub, refresh: refresh
    };
    window.toggleXiaojing = toggle;
  }

  return {
    build: build, toggle: toggle, open: open, close: close,
    send: send, quickQuery: quickQuery, askHint: askHint,
    showNewHint: showNewHint, clearNewHint: clearNewHint,
    updateSub: updateSub, refresh: refresh
  };
})();
