/* 心镜 v3.5.0 — 首页工作台（小镜面板已统一到 xiaojing-panel.js） */
(function () {
  'use strict';

  var money = function (n) { return '¥' + Number(n || 0).toLocaleString('zh-CN'); };

  document.getElementById('wel-date').textContent = App.todayFullCN();

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

  function esc(v) { return App.escapeHtml(String(v || '')); }

  function noteMode(s) {
    return (s.hasSoap || s.hasDap || s.hasSummary || s.notes || s.transcript) ? '已有记录' : '待记录';
  }

  function sessionHref(s) {
    return 'consult-notes.html?clientId=' + encodeURIComponent(s.clientId || '') +
      '&sessionId=' + encodeURIComponent(s.id || '') + '&mode=quick';
  }

  function renderSchedule() {
    var today = App.todayStr();
    var sessions = Store.getSessions().filter(function (s) { return s && s.date; });
    var todaySessions = sessions.filter(function (s) { return s.date === today; }).sort(function (a, b) {
      return String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99'));
    });
    var week = document.getElementById('week-schedule');
    var list = document.getElementById('today-schedule');
    if (!week || !list) return;
    var base = new Date(today + 'T00:00:00');
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(base); d.setDate(base.getDate() + i);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      var count = sessions.filter(function (s) { return s.date === key && s.status !== 'cancelled'; }).length;
      days.push('<button class="schedule-day' + (count ? ' has-session' : '') + '" onclick="location.href=\'session-calendar.html?date=' + key + '\'" title="查看日历">' +
        (i === 0 ? '今天' : ('周' + '日一二三四五六'.charAt(d.getDay()))) + '<br><b>' + (d.getMonth() + 1) + '/' + d.getDate() + '</b><br>' + (count ? count + ' 节' : '空闲') + '</button>');
    }
    week.innerHTML = days.join('');
    if (!todaySessions.length) {
      list.innerHTML = '<div class="schedule-empty">今天没有已安排的会谈。<a href="session-calendar.html">安排一节会谈</a></div>';
      return;
    }
    list.innerHTML = todaySessions.map(function (s) {
      var c = Store.getClient(s.clientId);
      var name = c ? c.name : '未命名来访者';
      return '<div class="today-session"><div class="today-session-time">' + esc((s.startTime || '待定').slice(0, 5)) + '</div>' +
        '<div class="today-session-info"><div class="today-session-name">' + esc(name) + ' · 第' + esc(s.sessionNumber || '?') + '节</div><div class="today-session-meta">' + esc(noteMode(s)) + (s.status ? ' · ' + esc(s.status) : '') + '</div></div>' +
        '<div class="today-session-actions"><a class="back" href="' + sessionHref(s) + '">开始记录</a></div></div>';
    }).join('');
  }

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

  function renderKbTile(_retry) {
    var el = document.getElementById('kb-mod-count');
    if (!el) return;
    if (typeof UserDocs === 'undefined' || !UserDocs.getMeta) {
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

  App.initPage({ title: '首页', subtitle: '', actions: '', noSidebar: true, onReady: function () {
    renderStats();
    renderSchedule();
    renderRecent();
    renderTodo();
    renderKbTile();
    // 强引导：新手任务清单（真实数据驱动）+ 首启聚光灯导览
    try {
      if (window.Onboarding) {
        Onboarding.renderChecklist();
        Onboarding.maybeStartTour();
      }
    } catch (e) { console.warn('[dashboard] onboarding 挂接失败', e); }
  }});
})();
