/* ============================================================
 * 心镜 XinJing · 咨询日历模块（v2 完整版）
 * ------------------------------------------------------------
 * 功能：
 *  - 月 / 周 / 日 三视图切换
 *  - 会话状态色编码（待确认/已确认/已完成/已取消/爽约/危机）
 *  - 点击事件查看详情，支持标记状态、删除、跳转编辑
 *  - 日历内快速新建会话（选来访者 + 时段 + 类型 + 状态）
 *  - 时间冲突检测（默认 30 分钟缓冲）
 *  - 按来访者筛选
 *  - 记账状态联动展示
 * 数据源：Store.sessions（本地 IndexedDB），不接外部日历 API
 * ============================================================ */
(function () {
  'use strict';

  // 会话间缓冲时间（分钟），避免背靠背
  var BUFFER_MINUTES = 30;
  // 时间轴显示区间（日视图）
  var DAY_VIEW_START_HOUR = 7;
  var DAY_VIEW_END_HOUR = 22;

  // 状态配置：key -> { label, fg(前景色变量), bg(背景色变量), dot }
  var STATUS_CFG = {
    pending: { label: '待确认', fg: 'var(--orange)', bg: 'var(--orange-soft)', dot: 'var(--orange)' },
    confirmed: { label: '已确认', fg: 'var(--blue)', bg: 'var(--blue-soft)', dot: 'var(--blue)' },
    completed: { label: '已完成', fg: 'var(--green)', bg: 'var(--green-soft)', dot: 'var(--green)' },
    cancelled: { label: '已取消', fg: 'var(--red)', bg: 'var(--red-soft)', dot: 'var(--red)' },
    no_show: { label: '爽约', fg: 'var(--red)', bg: 'var(--red-soft)', dot: 'var(--red)' },
  };
  // 类型配置
  var TYPE_CFG = {
    initial: { label: '初访' },
    followup: { label: '复访' },
    crisis: { label: '危机', fg: 'var(--accent)', bg: 'var(--accent-soft)', dot: 'var(--accent)', bold: true },
    group: { label: '团体' },
  };

  var dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  var dayNamesFull = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var state = {
    view: 'month', // month | week | day
    cursor: new Date(), // 当前视图锚点日期
    filterClientId: '',
  };

  // ---------- 工具 ----------
  function esc(str) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(str == null ? '' : String(str));
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type || '');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDate(s) {
    if (!s) return null;
    var p = String(s).split('-');
    if (p.length !== 3) return null;
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function todayStr() {
    var n = new Date();
    return fmtDate(n);
  }
  function addDays(d, n) { var r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function addMonths(d, n) { var r = new Date(d); var day = r.getDate(); r.setMonth(r.getMonth() + n); if (r.getDate() < day) r.setDate(0); return r; }
  // 按重复规则计算第 i 次（i 从 0 起）的日期字符串
  function occurrenceDate(baseStr, rule, i) {
    var base = parseDate(baseStr);
    if (!base) return baseStr;
    var d = base;
    if (rule === 'weekly') d = addDays(base, 7 * i);
    else if (rule === 'biweekly') d = addDays(base, 14 * i);
    else if (rule === 'monthly') d = addMonths(base, i);
    return fmtDate(d);
  }
  function genSeriesId() { return 'ser_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function weekStart(d) {
    var r = new Date(d);
    r.setHours(0, 0, 0, 0);
    r.setDate(r.getDate() - r.getDay()); // 周日为起点
    return r;
  }

  // 时间字符串 "HH:MM" -> 分钟数
  function timeToMin(t) {
    if (!t) return 0;
    var p = String(t).split(':');
    if (p.length !== 2) return 0;
    return Number(p[0]) * 60 + Number(p[1]);
  }
  function minToTime(m) {
    m = Math.max(0, Math.round(m));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  // 计算时长（分钟）
  function durationOf(s) {
    if (s.durationMinutes && Number(s.durationMinutes) > 0) return Number(s.durationMinutes);
    if (s.startTime && s.endTime) {
      var d = timeToMin(s.endTime) - timeToMin(s.startTime);
      return d > 0 ? d : 0;
    }
    return 0;
  }

  // 派生会话状态（兼容旧数据无 status 字段）
  function statusOf(s) {
    if (s.status && STATUS_CFG[s.status]) return s.status;
    // 旧数据按内容派生
    if (s.hasSoap || s.hasDap || (s.transcript && s.transcript.trim()) || (s.summary && s.summary.trim())) return 'completed';
    if (s.isConfirmed) return 'confirmed';
    return 'pending';
  }
  // 类型（兼容旧数据）
  function typeOf(s) {
    if (s.type && TYPE_CFG[s.type]) return s.type;
    return 'followup';
  }
  // 取该状态的展示色（危机类型优先用 accent）
  function colorFor(s) {
    if (typeOf(s) === 'crisis') return TYPE_CFG.crisis;
    return STATUS_CFG[statusOf(s)];
  }

  function clientName(clientId) {
    var c = (typeof Store !== 'undefined' && Store.getClient) ? Store.getClient(clientId) : null;
    return c ? c.name : '（已删除）';
  }

  // 获取过滤后的会话
  function getSessions() {
    if (typeof Store === 'undefined' || !Store.getSessions) return [];
    var list = Store.getSessions();
    // 过滤孤儿会话（来访者已删，仍残留 session）——避免日历出现大量「（已删除）」
    list = list.filter(function (s) { return Store.getClient && Store.getClient(s.clientId); });
    if (state.filterClientId) list = list.filter(function (s) { return s.clientId === state.filterClientId; });
    return list;
  }
  function sessionsOnDate(dateStr) {
    return getSessions().filter(function (s) { return s.date === dateStr; })
      .sort(function (a, b) { return timeToMin(a.startTime || '') - timeToMin(b.startTime || ''); });
  }

  // 冲突检测：返回与候选时段冲突的会话列表（含缓冲时间）
  function detectConflicts(dateStr, startMin, endMin, excludeId) {
    var conflicts = [];
    var day = sessionsOnDate(dateStr);
    var bufStart = startMin - BUFFER_MINUTES;
    var bufEnd = endMin + BUFFER_MINUTES;
    for (var i = 0; i < day.length; i++) {
      var s = day[i];
      if (s.id === excludeId) continue;
      var sStart = timeToMin(s.startTime || '');
      var sEnd = sStart + durationOf(s);
      // 重叠判定（含缓冲）
      if (bufStart < sEnd && bufEnd > sStart) conflicts.push(s);
    }
    return conflicts;
  }

  // ---------- 渲染主入口 ----------
  function render() {
    var box = document.getElementById('sc-body');
    if (!box) return;
    updatePeriodLabel();
    updateViewSwitch();
    populateClientFilter();
    var html = renderLegend();
    if (state.view === 'month') html += renderOverview() + renderMonth();
    else if (state.view === 'week') html += renderWeek();
    else html += renderDay();
    box.innerHTML = html;
  }

  function updatePeriodLabel() {
    var el = document.getElementById('period-label');
    if (!el) return;
    if (state.view === 'month') el.textContent = state.cursor.getFullYear() + '年' + (state.cursor.getMonth() + 1) + '月';
    else if (state.view === 'week') {
      var ws = weekStart(state.cursor);
      var we = addDays(ws, 6);
      el.textContent = (ws.getMonth() + 1) + '.' + ws.getDate() + ' - ' + (we.getMonth() + 1) + '.' + we.getDate(); // 511-001#1: 显式括号防运算符优先级（M.D - M.D）
    } else el.textContent = state.cursor.getFullYear() + '年' + (state.cursor.getMonth() + 1) + '月' + state.cursor.getDate() + '日';
  }
  function updateViewSwitch() {
    ['month', 'week', 'day'].forEach(function (v) {
      var btn = document.getElementById('vw-' + v);
      if (btn) btn.classList.toggle('active', state.view === v);
    });
  }
  function populateClientFilter() {
    var sel = document.getElementById('sc-filter-client');
    if (!sel) return;
    var cur = state.filterClientId;
    var clients = (typeof Store !== 'undefined' && Store.getClients) ? Store.getClients() : [];
    var html = '<option value="">全部来访者</option>' + clients.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    sel.innerHTML = html;
    sel.value = cur;
  }

  function renderLegend() {
    var items = [
      { dot: 'var(--orange)', label: '待确认' },
      { dot: 'var(--blue)', label: '已确认' },
      { dot: 'var(--green)', label: '已完成' },
      { dot: 'var(--red)', label: '已取消/爽约' },
      { dot: 'var(--accent)', label: '危机' },
    ];
    return '<div class="sc-legend">' + items.map(function (it) {
      return '<span class="lg"><span class="dot" style="background:' + it.dot + '"></span>' + esc(it.label) + '</span>';
    }).join('') + '<span class="lg" style="margin-left:auto;color:var(--ink-3)">缓冲 ' + BUFFER_MINUTES + ' 分钟</span></div>';
  }

  // 概览统计（月视图用）
  function renderOverview() {
    var ym = state.cursor.getFullYear() + '-' + pad2(state.cursor.getMonth() + 1);
    var month = getSessions().filter(function (s) { return (s.date || '').slice(0, 7) === ym; });
    var clientSet = {};
    month.forEach(function (s) { if (s.clientId) clientSet[s.clientId] = 1; });
    var completed = month.filter(function (s) { return statusOf(s) === 'completed'; }).length;
    var pending = month.filter(function (s) { var st = statusOf(s); return st === 'pending' || st === 'confirmed'; }).length;
    var cards = [
      { lbl: '本月会谈', val: month.length, cls: 'accent' },
      { lbl: '涉及来访者', val: Object.keys(clientSet).length, cls: 'accent' },
      { lbl: '已完成', val: completed, cls: 'green' },
      { lbl: '待进行', val: pending, cls: 'orange' },
    ];
    return '<div class="sc-overview">' + cards.map(function (c) {
      return '<div class="sc-ov-card"><div class="lbl">' + esc(c.lbl) + '</div><div class="val ' + c.cls + '">' + c.val + '</div></div>';
    }).join('') + '</div>';
  }

  // ---------- 月视图 ----------
  function renderMonth() {
    var y = state.cursor.getFullYear();
    var m = state.cursor.getMonth();
    var firstDay = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var daysInPrev = new Date(y, m, 0).getDate();

    var headHtml = '<div class="sc-cal-head">' + dayNames.map(function (n, i) {
      var we = (i === 0 || i === 6) ? ' we' : '';
      return '<div class="' + we.trim() + '">' + n + '</div>';
    }).join('') + '</div>';

    var cells = [];
    // 上月填充
    for (var i = 0; i < firstDay; i++) cells.push({ day: daysInPrev - firstDay + 1 + i, other: true });
    // 本月
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = y + '-' + pad2(m + 1) + '-' + pad2(d);
      cells.push({ day: d, date: ds, sessions: sessionsOnDate(ds), other: false, today: ds === todayStr(), dow: new Date(y, m, d).getDay() });
    }
    // 下月填充至 42 格
    var rem = 42 - cells.length;
    for (var r = 1; r <= rem; r++) cells.push({ day: r, other: true });

    var bodyHtml = '<div class="sc-cal-body">';
    cells.forEach(function (c) {
      var cls = 'sc-day';
      if (c.other) cls += ' other';
      if (c.today) cls += ' today';
      var we = (c.dow === 0 || c.dow === 6) ? ' we' : '';
      var events = '';
      if (c.sessions) {
        var shown = 0;
        c.sessions.forEach(function (s) {
          if (shown >= 3) return;
          var col = colorFor(s);
          var statusText = typeOf(s) === 'crisis' ? ('危机 · ' + STATUS_CFG[statusOf(s)].label) : STATUS_CFG[statusOf(s)].label;
          events += '<div class="day-event" style="background:' + col.bg + ';color:' + col.fg + '"' +
            (typeOf(s) === 'crisis' ? ';font-weight:700' : '') +
            ' onclick="event.stopPropagation();SessionCal.openDetail(\'' + esc(s.id) + '\')">' +
            (s.startTime ? esc(s.startTime.slice(0, 5)) + ' ' : '') + esc(clientName(s.clientId)) + ' <span class="day-event-status">· ' + esc(statusText) + '</span></div>';
          shown++;
        });
        if (c.sessions.length > 3) events += '<div class="day-more">+' + (c.sessions.length - 3) + ' 更多</div>';
      }
      var click = c.date ? 'SessionCal.onDayClick(\'' + c.date + '\')' : '';
      bodyHtml += '<div class="' + cls + '" onclick="' + click + '">' +
        '<div class="day-num' + we + '">' + c.day + '</div>' +
        '<div class="day-events">' + events + '</div>' +
        (c.date ? '<span class="add-hint">＋</span>' : '') +
        '</div>';
    });
    bodyHtml += '</div>';
    return '<div class="sc-cal">' + headHtml + bodyHtml + '</div>';
  }

  // ---------- 周视图 ----------
  function renderWeek() {
    var ws = weekStart(state.cursor);
    var cols = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(ws, i);
      var ds = fmtDate(d);
      cols.push({
        date: ds, dow: i, day: d.getDate(),
        sessions: sessionsOnDate(ds), today: ds === todayStr(),
      });
    }
    var html = '<div class="sc-week">';
    cols.forEach(function (c) {
      var colCls = 'sc-week-col' + (c.today ? ' today' : '');
      var body = '';
      if (c.sessions.length === 0) {
        body = '<div class="w-empty">无安排</div>';
      } else {
        c.sessions.forEach(function (s) {
          var col = colorFor(s);
          body += '<div class="sc-week-event" style="background:' + col.bg + ';color:' + col.fg + ';border-left-color:' + col.dot +
            (typeOf(s) === 'crisis' ? ';font-weight:700' : '') +
            '" onclick="SessionCal.openDetail(\'' + esc(s.id) + '\')">' +
            '<div class="we-time">' + esc((s.startTime || '').slice(0, 5)) + (s.endTime ? ' - ' + esc(s.endTime.slice(0, 5)) : '') + '</div>' +
            '<div class="we-name">' + esc(clientName(s.clientId)) + ' · 第' + esc(s.sessionNumber || '?') + '节</div>' +
            '<div class="we-meta">' + esc(TYPE_CFG[typeOf(s)].label) + ' · ' + esc(STATUS_CFG[statusOf(s)].label) +
            (Store.isBillableSession(s) ? (s.billing && s.billing.paid ? ' · 已收' : ' · 未收') : '') + '</div>' +
            '</div>';
        });
      }
      body += '<div class="w-add" onclick="SessionCal.openNewSession(\'' + c.date + '\')">＋ 新建</div>';
      html += '<div class="' + colCls + '">' +
        '<div class="w-head"><div class="w-dname">' + dayNamesFull[c.dow] + '</div><div class="w-dnum">' + c.day + '</div></div>' +
        '<div class="w-body">' + body + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  // ---------- 日视图（时间轴） ----------
  function renderDay() {
    var ds = fmtDate(state.cursor);
    var list = sessionsOnDate(ds);
    var d = state.cursor;
    var dateLabel = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + dayNamesFull[d.getDay()];

    if (list.length === 0) {
      return '<div class="sc-dayview"><div class="dv-date">' + esc(dateLabel) + '</div>' +
        '<div class="dv-empty">今天没有咨询安排</div>' +
        '<div class="dv-add"><button onclick="SessionCal.openNewSession(\'' + ds + '\')">＋ 在今天新建会话</button></div></div>';
    }

    var hours = '';
    for (var h = DAY_VIEW_START_HOUR; h <= DAY_VIEW_END_HOUR; h++) {
      hours += '<div class="tl-hour"><span class="tl-lab">' + pad2(h) + ':00</span></div>';
    }
    // 事件定位
    var eventsHtml = '';
    list.forEach(function (s) {
      var startMin = timeToMin(s.startTime || '');
      var dur = durationOf(s);
      var endMin = startMin + dur;
      var top = (startMin - DAY_VIEW_START_HOUR * 60) * (48 / 60); // 48px per hour
      var height = Math.max(28, dur * (48 / 60));
      var col = colorFor(s);
      eventsHtml += '<div class="tl-event" style="top:' + top + 'px;height:' + height + 'px;background:' + col.bg + ';color:' + col.fg + ';border-left-color:' + col.dot +
        (typeOf(s) === 'crisis' ? ';font-weight:700' : '') +
        '" onclick="SessionCal.openDetail(\'' + esc(s.id) + '\')">' +
        '<div class="te-time">' + esc((s.startTime || '').slice(0, 5)) + (s.endTime ? ' - ' + esc(s.endTime.slice(0, 5)) : '') + '</div>' +
        '<div class="te-name">' + esc(clientName(s.clientId)) + ' · 第' + esc(s.sessionNumber || '?') + '节</div>' +
        '<div class="te-meta">' + esc(TYPE_CFG[typeOf(s)].label) + ' · ' + esc(STATUS_CFG[statusOf(s)].label) + '</div>' +
        '</div>';
    });

    return '<div class="sc-dayview"><div class="dv-date">' + esc(dateLabel) + '</div>' +
      '<div class="sc-timeline">' + hours + eventsHtml + '</div></div>';
  }

  // ---------- 交互：视图切换与导航 ----------
  function setView(v) {
    state.view = v;
    render();
  }
  function prev() {
    if (state.view === 'month') state.cursor = addMonths(state.cursor, -1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, -7);
    else state.cursor = addDays(state.cursor, -1);
    render();
  }
  function next() {
    if (state.view === 'month') state.cursor = addMonths(state.cursor, 1);
    else if (state.view === 'week') state.cursor = addDays(state.cursor, 7);
    else state.cursor = addDays(state.cursor, 1);
    render();
  }
  function today() {
    state.cursor = new Date();
    render();
  }
  // 点击月视图某天：切到日视图
  function onDayClick(dateStr) {
    state.cursor = parseDate(dateStr) || new Date();
    state.view = 'day';
    render();
  }

  // ---------- 事件详情弹窗 ----------
  function openDetail(sessionId) {
    var s = (typeof Store !== 'undefined' && Store.getSession) ? Store.getSession(sessionId) : null;
    if (!s) { toast('会话不存在', 'warning'); return; }
    var c = Store.getClient(s.clientId);
    var st = statusOf(s);
    var tp = typeOf(s);
    var col = colorFor(s);
    var billable = Store.isBillableSession(s);
    var billInfo = billable ? ('¥' + (s.billing.fee || 0) + (s.billing.paid ? '（已收）' : '（未收）')) : '无账单';

    var overlay = document.createElement('div');
    overlay.className = 'sc-modal-overlay';
    overlay.innerHTML = '<div class="sc-modal" style="position:relative">' +
      '<button class="sm-close sc-detail-close" type="button" aria-label="关闭会谈详情">×</button>' +
      '<h3>' + esc(clientName(s.clientId)) + ' · 第' + esc(s.sessionNumber || '?') + '节</h3>' +
      '<div class="sm-sub">' + esc(TYPE_CFG[tp].label) + '会谈' +
      '<span class="sm-badge" style="background:' + col.bg + ';color:' + col.fg + '">' + esc(STATUS_CFG[st].label) + '</span></div>' +
      '<div class="sm-row"><span class="k">日期</span><span class="v">' + esc(s.date || '未设置') + '</span></div>' +
      '<div class="sm-row"><span class="k">时间</span><span class="v">' + esc((s.startTime || '').slice(0, 5)) + (s.endTime ? ' - ' + esc(s.endTime.slice(0, 5)) : '') + (durationOf(s) ? '（' + durationOf(s) + '分钟）' : '') + '</span></div>' +
      (c ? '<div class="sm-row"><span class="k">来访者</span><span class="v">' + esc(c.name) + (c.alias ? '（' + esc(c.alias) + '）' : '') + '</span></div>' : '') +
      '<div class="sm-row"><span class="k">类型</span><span class="v">' + esc(TYPE_CFG[tp].label) + '</span></div>' +
      '<div class="sm-row"><span class="k">账单</span><span class="v">' + esc(billInfo) + '</span></div>' +
      '<div class="sm-row"><span class="k">记录</span><span class="v">' + (s.hasTranscript ? '逐字稿 ' : '') + (s.hasSoap ? 'SOAP ' : '') + (s.hasDap ? 'DAP ' : '') + (s.hasSummary ? '摘要 ' : '') + (!s.hasTranscript && !s.hasSoap && !s.hasDap && !s.hasSummary ? '尚未填写' : '') + '</span></div>' +
      '<div class="sm-actions">' +
      '<button class="primary" onclick="SessionCal.jumpToEdit(\'' + esc(s.id) + '\')">进入编辑</button>' +
      (st === 'pending' ? '<button onclick="SessionCal.setStatus(\'' + esc(s.id) + '\',\'confirmed\')">标记已确认</button>' : '') +
      (st !== 'completed' && st !== 'cancelled' ? '<button onclick="SessionCal.setStatus(\'' + esc(s.id) + '\',\'completed\')">标记完成</button>' : '') +
      (st !== 'cancelled' ? '<button onclick="SessionCal.setStatus(\'' + esc(s.id) + '\',\'cancelled\')">标记取消</button>' : '') +
      '<button onclick="SessionCal.openNewSession(null,\'' + esc(s.id) + '\')">编辑时段</button>' +
      '<button class="danger" onclick="SessionCal.removeSession(\'' + esc(s.id) + '\')">删除</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function closeDetail() {
      if (typeof App !== 'undefined' && typeof App.closeModalElement === 'function') {
        App.closeModalElement(overlay);
      } else {
        overlay.classList.remove('show');
        overlay.remove();
      }
    }
    var detailClose = overlay.querySelector('.sc-detail-close');
    if (detailClose) detailClose.addEventListener('click', closeDetail);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDetail(); });
    if (typeof App !== 'undefined' && typeof App.openModalElement === 'function') {
      App.openModalElement(overlay, { removeOnClose: true, initialFocus: '.sc-detail-close' });
    } else {
      overlay.classList.add('show');
      if (detailClose) detailClose.focus();
    }
  }

  // 跳转到 consult-notes 编辑（带参数预选）
  function jumpToEdit(sessionId) {
    var s = Store.getSession(sessionId);
    if (!s) return;
    // 关闭弹窗
    var ov = document.querySelector('.sc-modal-overlay');
    if (ov) ov.remove();
    location.href = 'consult-notes.html?clientId=' + encodeURIComponent(s.clientId) + '&sessionId=' + encodeURIComponent(s.id) + '&mode=quick';
  }

  // 设置状态
  async function setStatus(sessionId, newStatus) {
    var s = Store.getSession(sessionId);
    if (!s) return;
    var next = Object.assign({}, s, { status: newStatus });
    if (newStatus === 'confirmed') next.isConfirmed = true;
    if (newStatus === 'cancelled' || newStatus === 'no_show') next.isConfirmed = false;
    var saved = await Store.updateSessionFull(next);
    if (!saved || !saved.ok) { toast('状态保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
    toast('已标记为「' + STATUS_CFG[newStatus].label + '」', 'success');
    // 关闭并重开详情
    var ov = document.querySelector('.sc-modal-overlay');
    if (ov) ov.remove();
    render();
  }

  // 删除会话——重复系列提供三选项（本次 / 本次及之后 / 全部系列），单节直接删
  async function removeSession(sessionId) {
    var s = Store.getSession(sessionId);
    if (!s) return;
    var closeAndRender = function () {
      var ov = document.querySelector('.sc-modal-overlay');
      if (ov) {
        if (typeof App !== 'undefined' && typeof App.closeModalElement === 'function') App.closeModalElement(ov);
        if (ov.isConnected) ov.remove();
      }
      render();
      // 详情中的删除按钮会随 overlay 一起移除，共享确认框无法恢复到已断开的节点；
      // 将焦点落到稳定的日历内容容器，保证确认/取消后键盘路径仍有明确落点。
      var calendarBody = document.getElementById('sc-body');
      if (calendarBody && typeof calendarBody.focus === 'function') {
        try { calendarBody.focus({ preventScroll: true }); } catch (e) { calendarBody.focus(); }
      }
    };
    async function deleteAndFinish(ids, successMessage) {
      try {
        var result = await Store.deleteSessionsDurable(ids);
        if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || 'data was not persisted');
        toast(successMessage, 'success');
        closeAndRender();
        return true;
      } catch (error) {
        toast('删除失败：原有会谈未改变，请恢复存储后重试', 'error');
        return false;
      }
    }
    // 非重复系列：单节删除
    if (!s.seriesId) {
      if (typeof App === 'undefined' || typeof App.confirmDialog !== 'function') {
        toast('确认组件未就绪，未执行删除', 'error');
        return;
      }
      var confirmOverlay = App.confirmDialog('确认删除这节会话？此操作不可撤销。', async function () {
        return deleteAndFinish([sessionId], '已删除会话');
      }, true);
      // 详情弹窗是日历专属层（z-index:9999），共享确认框必须位于其上方才能接收 trusted click。
      if (confirmOverlay && confirmOverlay.style) confirmOverlay.style.setProperty('z-index', '10050', 'important');
      return;
    }
    // 重复系列：弹出三选项
    var overlay = document.createElement('div');
    overlay.className = 'sc-modal-overlay';
    overlay.innerHTML = '<div class="sc-modal" style="position:relative;max-width:400px">' +
      '<button class="sm-close" id="series-delete-close" type="button" aria-label="关闭删除范围选择">×</button>' +
      '<h3>删除重复预约</h3>' +
      '<div class="sm-sub">这是一个重复预约系列，请选择删除范围。</div>' +
      '<div class="sf-actions" style="flex-direction:column;gap:8px;margin-top:16px">' +
      '<button class="save" id="del-one" style="width:100%">仅删除本次</button>' +
      '<button class="save" id="del-after" style="width:100%">删除本次及之后</button>' +
      '<button class="danger" id="del-all" style="width:100%">删除全部系列</button>' +
      '<button class="cancel" id="series-delete-cancel" data-modal-cancel type="button" style="width:100%">取消</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    function closeSeriesModal() {
      if (typeof App !== 'undefined' && typeof App.closeModalElement === 'function') App.closeModalElement(overlay);
      overlay.remove();
    }
    document.getElementById('series-delete-close').addEventListener('click', closeSeriesModal);
    document.getElementById('series-delete-cancel').addEventListener('click', closeSeriesModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSeriesModal(); });
    if (typeof App !== 'undefined' && typeof App.openModalElement === 'function') {
      App.openModalElement(overlay, { initialFocus: '#series-delete-cancel', removeOnClose: true });
    } else {
      overlay.classList.add('show');
      document.getElementById('series-delete-cancel').focus();
    }

    function seriesSessions() {
      return Store.getSessions().filter(function (x) { return x.seriesId === s.seriesId; });
    }
    function setDeleteButtonsBusy(busy) {
      ['del-one', 'del-after', 'del-all'].forEach(function (id) {
        var button = document.getElementById(id);
        if (button) button.disabled = busy;
      });
    }
    document.getElementById('del-one').addEventListener('click', async function () {
      setDeleteButtonsBusy(true);
      var deleted = await deleteAndFinish([sessionId], '已删除本次会话');
      if (deleted) closeSeriesModal(); else setDeleteButtonsBusy(false);
    });
    document.getElementById('del-after').addEventListener('click', async function () {
      var ids = seriesSessions().filter(function (x) { return (x.date || '') >= (s.date || ''); }).map(function (x) { return x.id; });
      setDeleteButtonsBusy(true);
      var deleted = await deleteAndFinish(ids, '已删除本次及之后共 ' + ids.length + ' 节');
      if (deleted) closeSeriesModal(); else setDeleteButtonsBusy(false);
    });
    document.getElementById('del-all').addEventListener('click', async function () {
      var ids = seriesSessions().map(function (x) { return x.id; });
      setDeleteButtonsBusy(true);
      var deleted = await deleteAndFinish(ids, '已删除整个系列共 ' + ids.length + ' 节');
      if (deleted) closeSeriesModal(); else setDeleteButtonsBusy(false);
    });
  }

  // ---------- 新建/编辑会话表单 ----------
  // editSessionId：传入则编辑现有会话时段；preDate：新建时预填日期
  function openNewSession(preDate, editSessionId) {
    var editing = editSessionId ? Store.getSession(editSessionId) : null;
    var clients = (typeof Store !== 'undefined' && Store.getClients) ? Store.getClients().filter(function (c) { return c.status !== 'ended'; }) : [];
    if (clients.length === 0) {
      toast('请先新建来访者', 'warning');
      if (typeof ClientModal !== 'undefined') {
        ClientModal.show(function () { openNewSession(preDate, editSessionId); });
      }
      return;
    }

    var today = todayStr();
    var initDate = editing ? (editing.date || today) : (preDate || today);
    var initStart = editing ? (editing.startTime || '09:00') : '09:00';
    var initEnd = editing ? (editing.endTime || '10:00') : '10:00';
    var initType = editing ? typeOf(editing) : 'followup';
    var initStatus = editing ? statusOf(editing) : 'pending';
    var initClient = editing ? editing.clientId : (state.filterClientId || clients[0].id);

    var overlay = document.createElement('div');
    overlay.className = 'sc-modal-overlay';
    overlay.innerHTML = '<div class="sc-modal" style="position:relative;max-width:480px">' +
      '<button class="sm-close" onclick="this.closest(\'.sc-modal-overlay\').remove()">×</button>' +
      '<h3>' + (editing ? '编辑会话' : '新建会话') + '</h3>' +
      '<div class="sm-sub">在日历上安排一节咨询，系统会自动检测时间冲突。</div>' +
      '<div class="sc-form">' +
      '<div class="sf-row"><label>来访者 *</label>' +
      '<select id="sf-client">' + clients.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === initClient ? ' selected' : '') + '>' + esc(c.name) + (c.alias ? '（' + esc(c.alias) + '）' : '') + '</option>';
      }).join('') + '</select></div>' +
      '<div class="sf-2col">' +
      '<div class="sf-row"><label>日期 *</label><input type="date" id="sf-date" value="' + esc(initDate) + '"></div>' +
      '<div class="sf-row"><label>类型</label><select id="sf-type">' +
      Object.keys(TYPE_CFG).map(function (k) { return '<option value="' + k + '"' + (k === initType ? ' selected' : '') + '>' + TYPE_CFG[k].label + '</option>'; }).join('') +
      '</select></div>' +
      '</div>' +
      '<div class="sf-2col">' +
      '<div class="sf-row"><label>开始时间 *</label><input type="time" id="sf-start" value="' + esc(initStart) + '"></div>' +
      '<div class="sf-row"><label>结束时间 *</label><input type="time" id="sf-end" value="' + esc(initEnd) + '"></div>' +
      '</div>' +
      '<div class="sf-row"><label>状态</label><select id="sf-status">' +
      Object.keys(STATUS_CFG).map(function (k) { return '<option value="' + k + '"' + (k === initStatus ? ' selected' : '') + '>' + STATUS_CFG[k].label + '</option>'; }).join('') +
      '</select></div>' +
      (editing ? '' :
        '<div class="sf-2col">' +
        '<div class="sf-row"><label>重复</label><select id="sf-repeat">' +
        '<option value="none">不重复</option>' +
        '<option value="weekly">每周</option>' +
        '<option value="biweekly">每两周</option>' +
        '<option value="monthly">每月</option>' +
        '</select></div>' +
        '<div class="sf-row"><label>重复次数（含本次）</label><input type="number" id="sf-repeat-count" value="8" min="1" max="52"></div>' +
        '</div>') +
      '<div id="sf-conflict"></div>' +
      '<div class="sf-actions">' +
      '<button class="cancel" onclick="this.closest(\'.sc-modal-overlay\').remove()">取消</button>' +
      '<button class="save" id="sf-save">' + (editing ? '保存修改' : '创建会话') + '</button>' +
      '</div>' +
      '</div></div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { overlay.classList.remove('show'); setTimeout(function () { overlay.remove(); }, 200); }
    });

    // 冲突实时检测
    function checkConflict() {
      var dateVal = document.getElementById('sf-date').value;
      var startVal = document.getElementById('sf-start').value;
      var endVal = document.getElementById('sf-end').value;
      var box = document.getElementById('sf-conflict');
      var saveBtn = document.getElementById('sf-save');
      if (!dateVal || !startVal || !endVal) { box.innerHTML = ''; saveBtn.disabled = false; return; }
      var sMin = timeToMin(startVal);
      var eMin = timeToMin(endVal);
      if (eMin <= sMin) {
        box.innerHTML = '<div class="sf-warn">结束时间必须晚于开始时间</div>';
        saveBtn.disabled = true;
        return;
      }
      var conflicts = detectConflicts(dateVal, sMin, eMin, editing ? editing.id : null);
      if (conflicts.length > 0) {
        var names = conflicts.map(function (c) { return clientName(c.clientId) + '(' + (c.startTime || '').slice(0, 5) + ')'; }).join('、');
        box.innerHTML = '<div class="sf-warn">⚠ 与以下会话时间冲突（含' + BUFFER_MINUTES + '分钟缓冲）：' + esc(names) + '</div>';
        saveBtn.disabled = true;
      } else {
        var dur = eMin - sMin;
        box.innerHTML = '<div class="sf-ok">✓ 时段可用，时长 ' + dur + ' 分钟</div>';
        saveBtn.disabled = false;
      }
    }
    ['sf-date', 'sf-start', 'sf-end'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', checkConflict);
    });
    checkConflict();

    // 保存
    document.getElementById('sf-save').addEventListener('click', async function () {
      var clientId = document.getElementById('sf-client').value;
      var dateVal = document.getElementById('sf-date').value;
      var startVal = document.getElementById('sf-start').value;
      var endVal = document.getElementById('sf-end').value;
      var typeVal = document.getElementById('sf-type').value;
      var statusVal = document.getElementById('sf-status').value;
      if (!clientId) { toast('请选择来访者', 'warning'); return; }
      if (!dateVal || !startVal || !endVal) { toast('请填写日期与时间', 'warning'); return; }
      var sMin = timeToMin(startVal);
      var eMin = timeToMin(endVal);
      if (eMin <= sMin) { toast('结束时间必须晚于开始时间', 'warning'); return; }
      // 二次冲突校验（防止用户忽略提示）
      var conflicts = detectConflicts(dateVal, sMin, eMin, editing ? editing.id : null);
      if (conflicts.length > 0) {
        toast('存在时间冲突，请先调整', 'warning');
        return;
      }
      var dur = eMin - sMin;
      if (editing) {
        // 编辑现有
        var edited = Object.assign({}, editing, {
          clientId: clientId, date: dateVal, startTime: startVal, endTime: endVal,
          durationMinutes: dur, type: typeVal, status: statusVal,
          isConfirmed: (statusVal === 'confirmed' || statusVal === 'completed'),
        });
        var saved = await Store.updateSessionFull(edited);
        if (!saved || !saved.ok) { toast('保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
        toast('已保存修改', 'success');
      } else {
        // 新建（支持按周/双周/月重复）
        var repEl = document.getElementById('sf-repeat');
        var rule = repEl ? repEl.value : 'none';
        var countEl = document.getElementById('sf-repeat-count');
        var count = rule === 'none' ? 1 : Math.max(1, Math.min(52, parseInt(countEl && countEl.value, 10) || 1));
        var seriesId = count > 1 ? genSeriesId() : null;
        var created = 0, skipped = 0;
        for (var i = 0; i < count; i++) {
          var occDate = occurrenceDate(dateVal, rule, i);
          // 每次时段冲突检测：冲突则跳过该次（不中断整个系列）
          if (detectConflicts(occDate, sMin, eMin, null).length > 0) { skipped++; continue; }
          var payload = {
            clientId: clientId,
            date: occDate,
            startTime: startVal,
            endTime: endVal,
            durationMinutes: dur,
            type: typeVal,
            status: statusVal,
            isConfirmed: (statusVal === 'confirmed' || statusVal === 'completed'),
          };
          if (seriesId) { payload.seriesId = seriesId; payload.recurrence = rule; }
          var createdResult = await Store.createSessionDurable(payload);
          if (!createdResult || !createdResult.ok) {
            toast('创建失败：已停止后续创建，未保存的会谈草稿可恢复', 'error');
            return;
          }
          created++;
        }
        if (count > 1) {
          toast('已创建 ' + created + ' 节' + (skipped ? '（跳过 ' + skipped + ' 节时间冲突）' : ''), 'success');
        } else {
          toast('已新建会话', 'success');
        }
      }
      overlay.classList.remove('show');
      setTimeout(function () { overlay.remove(); render(); }, 200);
    });
  }

  // ---------- 待办双视图（日历 + 待办抽屉，非颜色单一表达） ----------
  function renderTodoPanel() {
    var box = document.getElementById('sc-todo-body');
    if (!box) return;
    var items = [];
    var clinicalTasks = (typeof Store !== 'undefined' && typeof Store.getClinicalTasks === 'function') ? Store.getClinicalTasks() : [];
    clinicalTasks.filter(function (task) {
      return task && (task.status === 'open' || task.status === 'ai-draft');
    }).slice(0, 10).forEach(function (task) {
      var client = Store.getClient(task.clientId);
      var isAiDraft = task.status === 'ai-draft';
      var sourceRefs = Array.isArray(task.sourceRefs) ? task.sourceRefs : [];
      var meta = isAiDraft
        ? 'AI 草稿 · 待人工确认 · 运行 ' + (task.actionRunId || '未知') + (sourceRefs.length ? ' · 来源 ' + sourceRefs.join('、') : '')
        : (task.due ? ('截止 ' + task.due) : '跨会谈跟进');
      items.push({
        title: task.title || '未命名任务',
        meta: (client ? client.name : '未知来访者') + ' · ' + meta,
        tag: isAiDraft ? 'AI 草稿' : '待办',
        tone: isAiDraft ? 'var(--accent)' : 'var(--green)',
      });
    });
    var allSessions = (typeof Store !== 'undefined' && Store.getSessions) ? Store.getSessions() : [];
    allSessions.filter(function (s) { return s.hasTranscript && !s.hasSoap && !s.hasDap; }).slice(0, 6).forEach(function (s) {
      var c = Store.getClient(s.clientId);
      items.push({ title: '整理逐字稿：' + (c ? c.name : '?') + ' 第' + (s.sessionNumber || '?') + '节', meta: (typeof App !== 'undefined' && App.formatDate) ? App.formatDate(s.date) : (s.date || ''), tag: '逐字稿', tone: 'var(--blue)' });
    });
    if (!items.length) {
      box.innerHTML = '<div class="sc-todo-empty">暂无待办。日历内的状态会同时以文字和颜色标注。</div>';
      return;
    }
    box.innerHTML = items.slice(0, 12).map(function (item) {
      return '<div class="sc-todo-item"><span class="t-dot" style="background:' + item.tone + '"></span><div class="t-main"><div class="t-title">' + esc(item.title) + '<span class="t-tag" style="background:var(--bg-sunken);color:' + item.tone + '">' + esc(item.tag) + '</span></div><div class="t-meta">' + esc(item.meta) + '</div></div></div>';
    }).join('');
  }

  function openTodoPanel(open) {
    var panel = document.getElementById('sc-todo-panel');
    var scrim = document.getElementById('sc-todo-scrim');
    var toggle = document.getElementById('sc-todo-toggle');
    if (!panel) return;
    var wasOpen = panel.classList.contains('open');
    var isOpen = open === undefined ? !panel.classList.contains('open') : !!open;
    if (isOpen && !wasOpen) {
      panel.__xjReturnFocus = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : toggle;
    }
    panel.classList.toggle('open', isOpen);
    panel.setAttribute('aria-hidden', String(!isOpen));
    if (scrim) scrim.classList.toggle('show', isOpen);
    if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
      renderTodoPanel();
      var close = document.getElementById('sc-todo-close');
      if (close && typeof close.focus === 'function') setTimeout(function () { close.focus(); }, 0);
    } else if (wasOpen) {
      var returnFocus = panel.__xjReturnFocus || toggle;
      panel.__xjReturnFocus = null;
      if (returnFocus && typeof returnFocus.focus === 'function') setTimeout(function () { returnFocus.focus(); }, 0);
    }
  }

  function toggleTodoPanel() { openTodoPanel(); }

  function bindTodoPanel() {
    var toggle = document.getElementById('sc-todo-toggle');
    var close = document.getElementById('sc-todo-close');
    var scrim = document.getElementById('sc-todo-scrim');
    if (toggle) toggle.addEventListener('click', function () { openTodoPanel(); });
    if (close) close.addEventListener('click', function () { openTodoPanel(false); });
    if (scrim) scrim.addEventListener('click', function () { openTodoPanel(false); });
    document.addEventListener('keydown', function (e) {
      var panel = document.getElementById('sc-todo-panel');
      if (e.key === 'Escape' && panel && panel.classList.contains('open')) {
        e.preventDefault();
        openTodoPanel(false);
      }
    });
  }

  // ---------- 公开接口 ----------
  window.SessionCal = {
    setView: setView,
    prev: prev,
    next: next,
    today: today,
    render: render,
    onDayClick: onDayClick,
    openDetail: openDetail,
    openNewSession: openNewSession,
    jumpToEdit: jumpToEdit,
    setStatus: setStatus,
    removeSession: removeSession,
    toggleTodo: toggleTodoPanel,
    openTodoPanel: openTodoPanel,
  };

  // ---------- 启动 ----------
  function init() {
    // 兼容旧版直接调用 prevMonth/nextMonth/todayMonth/viewDay
    window.prevMonth = function () { prev(); };
    window.nextMonth = function () { next(); };
    window.todayMonth = function () { today(); };
    window.viewDay = function (dateStr) { onDayClick(dateStr); };

    // P0#2 修复：session-calendar 不再手动 outerHTML 替换侧栏 + 重绑事件，改用 App.refreshSidebarChrome()
    if (typeof App !== 'undefined' && typeof App.refreshSidebarChrome === 'function') {
      App.refreshSidebarChrome();
    } else if (typeof App !== 'undefined' && App.renderSidebar) {
      var sm = document.getElementById('sidebar-mount');
      if (sm) sm.innerHTML = App.renderSidebar();
      if (typeof App.bindSidebarControls === 'function') App.bindSidebarControls();
    }
    try {
      var params = new URLSearchParams(location.search);
      var date = params.get('date');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) state.cursor = new Date(date + 'T00:00:00');
      var requestedClientId = params.get('clientId');
      if (requestedClientId && Store.getClient(requestedClientId)) state.filterClientId = requestedClientId;
      var shouldCreate = params.get('new') === '1' || params.get('action') === 'new';
    } catch (e) {}
    render();
    bindTodoPanel();
    try {
      if (shouldCreate) setTimeout(function () { openNewSession(fmtDate(state.cursor), null); }, 0);
    } catch (e) {}
  }

  // 确保 Store 数据已从 IndexedDB 载入内存后再初始化
  function boot() {
    if (typeof Store === 'undefined') { setTimeout(boot, 50); return; }
    if (Store.isHydrated && Store.isHydrated()) { init(); return; }
    if (typeof Store.hydrate === 'function') {
      Store.hydrate().then(init).catch(function (e) {
        console.warn('[SessionCal] 数据加载失败，使用空数据', e);
        init();
      });
    } else {
      init();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
