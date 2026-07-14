/* 心镜 v3.1.0 — 首页工作台 + 小镜增强版（身份定义 + 数据查询 + 反幻觉） */
(function () {
  'use strict';

  var money = function (n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); };

  // 欢迎日期
  document.getElementById('wel-date').textContent = App.todayFullCN();

  // ---- 小镜面板 ----
  window.toggleXiaojing = function () {
    var panel = document.getElementById('xj-panel');
    var page = document.getElementById('main-page');
    panel.classList.toggle('open');
    page.classList.toggle('panel-open');
  };

  // 小镜身份定义
  var XIAOJING_IDENTITY = '你是心镜（XinJing）的助手「小镜」，身份设定：\n' +
    '- 你是心理咨询师梅的专业助理，不是AI督导，也不是大师。\n' +
    '- 你的职责是帮助梅管理日常工作：查看来访者信息、记账、提醒待办、回答关于app功能的问题。\n' +
    '- 你绝对不能说没有来源的话。如果用户问数据问题（如"谁欠费最多"），你必须先查实时数据再回答，不能编造。\n' +
    '- 如果用户问的专业问题超出你的知识范围，诚实地说"这个需要请教AI督导或真人督导"。\n' +
    '- 回复简洁专业，用中文，语气温暖有边界。\n' +
    '- 你可以引导用户去各个页面：咨询记录、逐字稿整理、撰写报告、AI督导、真人督导、文档中心、账单、大师对话、设置。';

  // 小镜欢迎语
  function renderXjGreet() {
    var allSessions = Store.getSessions();
    var clients = Store.getClients();
    var today = App.todayStr();
    var todaySessions = allSessions.filter(function (s) { return s.date === today; });
    var doneToday = todaySessions.filter(function (s) { return s.billing && s.billing.paid; }).length;
    var pendingReports = allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).length;

    var profile = (typeof Memory !== 'undefined' && Memory.getProfile) ? Memory.getProfile() : {};
    var userName = (profile && profile.name) || '梅';
    document.getElementById('xj-greet').innerHTML = '你好，' + userName + '。<br>今天完成了 ' + doneToday + ' 节咨询，共 ' + todaySessions.length + ' 节。';

    var body = document.getElementById('xj-body');
    var msgs = [];
    if (pendingReports > 0) msgs.push('📋 ' + pendingReports + ' 份逐字稿尚未整理为报告，可以去「逐字稿整理」页面处理。');
    var owingClients = clients.filter(function (c) {
      var owe = Store.getSessionsByClient(c.id).reduce(function (s, x) {
        return s + ((x.billing && x.billing.fee > 0 && !x.billing.paid) ? x.billing.fee : 0);
      }, 0);
      return owe > 0;
    });
    if (owingClients.length) msgs.push('💰 ' + owingClients.length + ' 位来访者有欠费未收，需要我帮你查一下明细吗？');
    if (!msgs.length) msgs.push('一切正常。有什么需要帮忙的吗？我可以查数据、记账、提醒待办。');
    // 快捷入口
    msgs.push('<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
      '<button onclick="xjNav(\'transcript.html\')" style="border:1px solid var(--border);border-radius:6px;padding:4px 10px;font:10px var(--sans);cursor:pointer;background:transparent;color:var(--ink-2)">📋 逐字稿整理</button>' +
      '<button onclick="xjNav(\'supervision.html\')" style="border:1px solid var(--border);border-radius:6px;padding:4px 10px;font:10px var(--sans);cursor:pointer;background:transparent;color:var(--ink-2)">🧠 AI 督导</button>' +
      '<button onclick="xjNav(\'billing-shell.html\')" style="border:1px solid var(--border);border-radius:6px;padding:4px 10px;font:10px var(--sans);cursor:pointer;background:transparent;color:var(--ink-2)">💰 账单</button>' +
      '</div>');

    body.innerHTML = msgs.map(function (m) { return '<div class="xj-msg ai">' + m + '</div>'; }).join('');
  }

  window.xjNav = function (url) {
    if (window.toggleXiaojing) toggleXiaojing();
    setTimeout(function () { location.href = url; }, 300);
  };

  // 查询实时数据
  function queryData(query) {
    var q = query.toLowerCase();
    var clients = Store.getClients();
    var sessions = Store.getSessions();
    var results = [];

    // 查欠费
    if (q.indexOf('欠费') >= 0 || q.indexOf('没付') >= 0 || q.indexOf('未收') >= 0) {
      clients.forEach(function (c) {
        var sessionsByClient = Store.getSessionsByClient(c.id);
        var unpaid = sessionsByClient.filter(function (s) { return s.billing && s.billing.fee > 0 && !s.billing.paid; });
        if (unpaid.length) {
          var total = unpaid.reduce(function (s, x) { return s + (x.billing.fee || 0); }, 0);
          results.push(c.name + '：' + unpaid.length + '节未付，共' + money(total));
        }
      });
      if (results.length) return '📊 欠费明细：\n' + results.join('\n');
      return '✅ 目前没有来访者有欠费。';
    }

    // 查来访者数量
    if (q.indexOf('来访者') >= 0 || q.indexOf('客户') >= 0 || q.indexOf('人数') >= 0) {
      var active = clients.filter(function (c) { return c.status !== 'ended'; });
      return '👥 共有 ' + clients.length + ' 位来访者（活跃 ' + active.length + ' 位）。';
    }

    // 查本月收入
    if (q.indexOf('收入') >= 0 || q.indexOf('本月') >= 0) {
      var ym = App.todayStr().slice(0, 7);
      var total = 0, paid = 0;
      sessions.forEach(function (s) {
        if (s.date && s.date.slice(0, 7) === ym && s.billing && s.billing.fee > 0) {
          total += s.billing.fee;
          if (s.billing.paid) paid += s.billing.fee;
        }
      });
      return '💰 本月收入：' + money(total) + '（已收 ' + money(paid) + '，待收 ' + money(total - paid) + '）';
    }

    // 查今日
    if (q.indexOf('今天') >= 0 || q.indexOf('今日') >= 0) {
      var today = App.todayStr();
      var todayS = sessions.filter(function (s) { return s.date === today; });
      return '📅 今天有 ' + todayS.length + ' 节咨询。' + (todayS.length ? todayS.map(function (s) {
        var c = Store.getClient(s.clientId);
        return '  · ' + (c ? c.name : '?') + ' 第' + (s.sessionNumber || '?') + '节' + (s.billing && s.billing.fee ? ' ¥' + s.billing.fee : '');
      }).join('\n') : '');
    }

    return null; // 无法匹配，交给AI
  }

  window.sendXjMsg = function () {
    var input = document.getElementById('xj-input');
    var text = (input.value || '').trim();
    if (!text) return;
    var body = document.getElementById('xj-body');
    body.innerHTML += '<div class="xj-msg" style="background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px">' + App.escapeHtml(text) + '</div>';
    input.value = '';
    body.scrollTop = body.scrollHeight;

    // 先尝试本地数据查询
    var dataResult = queryData(text);
    if (dataResult) {
      body.innerHTML += '<div class="xj-msg ai">' + dataResult.replace(/\n/g, '<br>') + '</div>';
      body.scrollTop = body.scrollHeight;
      return;
    }

    // 真实 AI 对话
    if (!App.aiUnlocked()) {
      body.innerHTML += '<div class="xj-msg ai">小镜需激活后才能使用 AI 对话。请先激活。</div>';
      body.scrollTop = body.scrollHeight;
      return;
    }

    // 添加 typing
    var typingId = 'xj-typing-' + Date.now();
    body.innerHTML += '<div class="xj-msg ai" id="' + typingId + '">思考中…</div>';
    body.scrollTop = body.scrollHeight;

    // 构建数据上下文（反幻觉：只给真实数据）
    var clients = Store.getClients();
    var sessions = Store.getSessions();
    var today = App.todayStr();
    var todayS = sessions.filter(function (s) { return s.date === today; });
    var owingClients = clients.filter(function (c) {
      return Store.getSessionsByClient(c.id).some(function (s) { return s.billing && s.billing.fee > 0 && !s.billing.paid; });
    });
    var ctx = '【当前真实数据概览】\n' +
      '今日咨询：' + todayS.length + '节\n' +
      '来访者总数：' + clients.length + '位\n' +
      '有欠费的来访者：' + owingClients.length + '位\n' +
      '本月收入：' + money(sessions.filter(function (s) { return s.date && s.date.slice(0, 7) === today.slice(0, 7) && s.billing && s.billing.fee > 0; }).reduce(function (s, x) { return s + (x.billing.fee || 0); }, 0)) + '\n\n' +
      '【重要规则】\n' +
      '- 如果用户问数据问题，你只能引用上面这个数据概览，不能编造数字。\n' +
      '- 如果用户问的问题需要查更细的数据（如特定来访者的欠费），引导用户去账单页面自己查看。\n' +
      '- 如果用户问的专业问题超出你的能力范围，诚实地让对方去AI督导页面。';

    var preamble = (typeof PersonaPreamble !== 'undefined' && PersonaPreamble.build) ? PersonaPreamble.build() : '';
    var sys = (preamble ? preamble + '\n\n' : '') + XIAOJING_IDENTITY + '\n\n' + ctx;
    var msgs = [{ role: 'system', content: sys }, { role: 'user', content: text }];

    if (typeof AI !== 'undefined' && AI.send) {
      AI.send(msgs, function (res) {
        var t = document.getElementById(typingId);
        if (t) t.remove();
        if (res && res.content) {
          body.innerHTML += '<div class="xj-msg ai">' + App.escapeHtml(res.content).replace(/\n/g, '<br>') + '</div>';
        } else {
          body.innerHTML += '<div class="xj-msg ai">抱歉，我没能理解。请再试一次。</div>';
        }
        body.scrollTop = body.scrollHeight;
      });
    } else {
      var t2 = document.getElementById(typingId);
      if (t2) { t2.remove(); }
      body.innerHTML += '<div class="xj-msg ai">AI 模块未就绪，请重启应用。</div>';
      body.scrollTop = body.scrollHeight;
    }
  };

  // ---- 指标卡片 ----
  function renderStats() {
    var allSessions = Store.getSessions();
    var today = App.todayStr();
    var ym = today.slice(0, 7);
    var todaySessions = allSessions.filter(function (s) { return s.date === today; });
    var mRec = 0, mRecv = 0;
    allSessions.forEach(function (s) {
      var fee = (s.billing && Number(s.billing.fee)) || 0;
      if (fee > 0 && s.date && s.date.slice(0, 7) === ym) {
        mRec += fee;
        if (s.billing && s.billing.paid) mRecv += fee;
      }
    });
    var pendingReports = allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).length;

    document.getElementById('stat-today').textContent = todaySessions.length + ' 节';
    document.getElementById('stat-today-sub').textContent = '已完成 ' + todaySessions.filter(function (s) { return s.billing && s.billing.paid; }).length + ' 节';
    document.getElementById('stat-income').textContent = money(mRec);
    document.getElementById('stat-income-sub').textContent = '已收 ' + money(mRecv) + ' · 待收 ' + money(mRec - mRecv);
    document.getElementById('stat-pending-reports').textContent = pendingReports;
  }

  // ---- 最近咨询 ----
  function renderRecent() {
    var container = document.getElementById('recent-sessions');
    var sessions = Store.getRecentSessions(3);
    if (!sessions.length) {
      container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">暂无咨询记录</div>';
      return;
    }
    container.innerHTML = sessions.map(function (s) {
      var client = Store.getClient(s.clientId);
      var name = client ? client.name : '未知';
      var fee = (s.billing && s.billing.fee) ? ' · ¥' + s.billing.fee : '';
      var tags = [];
      if (s.hasSoap) tags.push('SOAP');
      if (s.hasDap) tags.push('DAP');
      if (s.hasReflection) tags.push('反思');
      return '<div class="ritem"><div class="rav">' + (name.charAt(0) || '?') + '</div><div class="info"><div class="nm">' + App.escapeHtml(name) + ' · 第' + s.sessionNumber + '节</div><div class="mt">' + App.formatDate(s.date) + fee + '</div></div>' + (tags.length ? '<span class="tag">' + tags.join(' · ') + '</span>' : '') + '</div>';
    }).join('');
  }

  // ---- 待办 ----
  function renderTodo() {
    var container = document.getElementById('todo-list');
    var allSessions = Store.getSessions();
    var clients = Store.getClients();
    var items = [];

    var pending = allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).slice(0, 2);
    pending.forEach(function (s) {
      var c = Store.getClient(s.clientId);
      items.push({ nm: '整理逐字稿：' + (c ? c.name : '?') + ' 第' + s.sessionNumber + '节', mt: App.formatDate(s.date) });
    });

    clients.forEach(function (c) {
      var owe = Store.getSessionsByClient(c.id).reduce(function (s, x) {
        return s + ((x.billing && x.billing.fee > 0 && !x.billing.paid) ? 1 : 0);
      }, 0);
      if (owe > 0 && items.length < 4) {
        items.push({ nm: '催收：' + c.name, mt: owe + ' 节未付' });
      }
    });

    if (!items.length) {
      container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">暂无待办</div>';
      return;
    }
    container.innerHTML = items.map(function (i) {
      return '<div class="ritem"><div class="rav" style="background:var(--bg-sunken);color:var(--ink-2)">·</div><div class="info"><div class="nm">' + App.escapeHtml(i.nm) + '</div><div class="mt">' + App.escapeHtml(i.mt) + '</div></div></div>';
    }).join('');
  }

  // ---- 我的资料库瓦片（入口4：仪表盘统计瓦片）----
  function renderKbTile(_retry) {
    var el = document.getElementById('kb-mod-count');
    if (!el) return;
    if (typeof UserDocs === 'undefined' || !UserDocs.getMeta) {
      // userdocs.js 经 preload 异步注入，可能尚未就绪，短暂重试一次
      if ((_retry || 0) < 10) { setTimeout(function () { renderKbTile((_retry || 0) + 1); }, 300); }
      return;
    }
    UserDocs.getMeta(false).then(function (meta) {
      if (!meta || !meta.ok || !meta.folder) {
        el.textContent = '未设置';
        el.style.background = 'var(--bg-sunken)';
        el.style.color = 'var(--ink-2)';
        return;
      }
      var st = meta.stats || {};
      var files = st.fileCount || (meta.files ? meta.files.length : 0);
      if (!files) {
        el.textContent = '空文件夹';
        el.style.background = 'var(--bg-sunken)';
        el.style.color = 'var(--ink-2)';
        return;
      }
      var chars = st.totalChars || 0;
      var kw = chars >= 10000 ? (Math.round(chars / 1000) / 10) + '万字' : chars + '字';
      el.textContent = files + ' 份 · ' + kw;
      el.style.background = 'var(--success)';
      el.style.color = '#fff';
    }).catch(function () {
      el.textContent = '未设置';
    });
  }

  // ---- 初始化 ----
  App.initPage({ title: '首页', subtitle: '', actions: '', noSidebar: true, onReady: function () {
    renderStats();
    renderRecent();
    renderTodo();
    renderXjGreet();
    renderKbTile();
  }});
})();