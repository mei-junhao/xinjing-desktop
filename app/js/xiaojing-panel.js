/* ============================================================
 * 心镜 XinJing — 小镜面板复用（v3.4.0）
 *
 * 从 agent-shell.js 抽取面板逻辑，供首页和 9 个无坞页复用。
 * 替代已废弃的 FAB 悬浮球。
 * ============================================================ */
'use strict';

const XiaojingPanel = (() => {
  let panelEl = null, bodyEl = null, inputEl = null;
  let messages = [];

  function build() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'xj-panel';
    panelEl.id = 'xj-panel';
    panelEl.innerHTML =
      '<div class="xj-head"><div class="xj-name">小镜</div><div class="xj-greet" id="xj-greet-v2"></div></div>' +
      '<div class="xj-body" id="xj-body-v2"></div>' +
      '<div class="xj-input-row"><input id="xj-input-v2" placeholder="对小镜说…" onkeydown="if(event.key===\'Enter\')XiaojingPanel.send()"><button onclick="XiaojingPanel.send()">发送</button></div>';
    document.body.appendChild(panelEl);
    bodyEl = panelEl.querySelector('.xj-body');
    inputEl = panelEl.querySelector('.xj-input-row input');
    panelEl.querySelector('.xj-head').addEventListener('click', function () { toggle(); });
    greet();
    return panelEl;
  }

  function toggle() {
    if (!panelEl) build();
    panelEl.classList.toggle('open');
    var page = document.getElementById('main-page') || document.querySelector('.main');
    if (page) page.classList.toggle('panel-open');
  }

  function greet() {
    var greetEl = document.getElementById('xj-greet-v2');
    if (!greetEl) return;
    var today = new Date().toISOString().slice(0, 10);
    var allSessions = [];
    try { if (typeof Store !== 'undefined') allSessions = Store.getSessions(); } catch (e) {}
    var todayS = allSessions.filter(function (s) { return s.date === today; });
    var done = todayS.filter(function (s) { return s.billing && s.billing.paid; }).length;
    var profile = (typeof Memory !== 'undefined' && Memory.getProfile) ? Memory.getProfile() : {};
    var name = (profile && profile.name) || '梅';
    greetEl.innerHTML = '你好，' + name + '。<br>今天 ' + done + '/' + todayS.length + ' 节咨询。';
  }

  function send() {
    if (!inputEl) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    if (!bodyEl) return;
    bodyEl.innerHTML += '<div class="xj-msg user">' + (typeof App !== 'undefined' && App.escapeHtml ? App.escapeHtml(text) : text) + '</div>';
    bodyEl.innerHTML += '<div class="xj-msg ai">思考中…</div>';
    bodyEl.scrollTop = bodyEl.scrollHeight;

    if (!(typeof App !== 'undefined' && App.aiUnlocked && App.aiUnlocked())) {
      bodyEl.innerHTML += '<div class="xj-msg ai">小镜需激活后才能使用 AI 对话。请先激活。</div>';
      bodyEl.scrollTop = bodyEl.scrollHeight;
      return;
    }

    var typingId = 'xj-typing-' + Date.now();
    bodyEl.innerHTML += '<div class="xj-msg ai" id="' + typingId + '">思考中…</div>';
    bodyEl.scrollTop = bodyEl.scrollHeight;

    try {
      var ctx = '';
      if (typeof Store !== 'undefined') {
        var clients = Store.getClients();
        var sessions = Store.getSessions();
        ctx = '【当前数据概览】来访者 ' + clients.length + ' 位，今日咨询 ' + sessions.filter(function (s) { return s.date === new Date().toISOString().slice(0, 10); }).length + ' 节';
      }
      var sys = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
      sys += '\n你是小镜，心镜工作台助手。' + ctx;
      if (typeof AI !== 'undefined' && AI.send) {
        AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
          var t = document.getElementById(typingId);
          if (t) t.innerHTML = (res && res.content) ? res.content.replace(/\n/g, '<br>') : '（未获得回复）';
          bodyEl.scrollTop = bodyEl.scrollHeight;
        });
      }
    } catch (e) {
      var t = document.getElementById(typingId);
      if (t) t.innerHTML = '出错：' + (e.message || '未知错误');
    }
  }

  if (typeof window !== 'undefined') {
    window.XiaojingPanel = { build: build, toggle: toggle, send: send, greet: greet };
    window.toggleXiaojing = toggle;
  }
  return { build: build, toggle: toggle, send: send, greet: greet };
})();