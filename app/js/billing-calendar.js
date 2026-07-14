/* 心镜 v3.1.0 — 账单月历视图 */
(function () {
  'use strict';
  var curYear, curMonth;

  function init() {
    var now = new Date();
    curYear = now.getFullYear();
    curMonth = now.getMonth();
    render();
  }

  window.prevMonth = function () {
    curMonth--;
    if (curMonth < 0) { curMonth = 11; curYear--; }
    render();
  };

  window.nextMonth = function () {
    curMonth++;
    if (curMonth > 11) { curMonth = 0; curYear++; }
    render();
  };

  window.todayMonth = function () {
    var now = new Date();
    curYear = now.getFullYear();
    curMonth = now.getMonth();
    render();
  };

  function render() {
    var box = document.getElementById('bc-body');
    document.getElementById('month-label').textContent = curYear + '年' + (curMonth + 1) + '月';

    var sessions = Store.getSessions();
    var monthSessions = sessions.filter(function (s) {
      if (!s.date) return false;
      var d = new Date(s.date);
      return d.getFullYear() === curYear && d.getMonth() === curMonth;
    });

    // 月概览
    var totalFee = 0, totalPaid = 0, totalPending = 0, sessionCount = monthSessions.length;
    monthSessions.forEach(function (s) {
      var b = s.billing || {};
      if (b.fee > 0) totalFee += b.fee;
      if (b.paid) totalPaid += b.fee || 0;
      if (b.fee > 0 && !b.paid) totalPending += b.fee;
    });

    var overviewHtml = '<div class="bc-overview">' +
      '<div class="bc-ov-card"><div class="lbl">会谈次数</div><div class="val accent">' + sessionCount + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">总收入</div><div class="val red">¥' + totalFee.toLocaleString() + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">已收款</div><div class="val red">¥' + totalPaid.toLocaleString() + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">待收款</div><div class="val accent">¥' + totalPending.toLocaleString() + '</div></div>' +
      '</div>';

    // 日历
    var firstDay = new Date(curYear, curMonth, 1).getDay();
    var daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
    var daysInPrev = new Date(curYear, curMonth, 0).getDate();

    var dayNames = ['日', '一', '二', '三', '四', '五', '六'];
    var headHtml = '<div class="bc-cal-head">' + dayNames.map(function (n) { return '<div>' + n + '</div>'; }).join('') + '</div>';

    var cells = [];
    // 上月填充
    for (var i = 0; i < firstDay; i++) {
      cells.push({ day: daysInPrev - firstDay + 1 + i, other: true });
    }
    // 本月
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = curYear + '-' + String(curMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var daySession = monthSessions.filter(function (s) { return s.date === dateStr; });
      cells.push({ day: d, date: dateStr, sessions: daySession, other: false, today: isToday(dateStr) });
    }
    // 下月填充
    var remaining = 42 - cells.length;
    for (var r = 1; r <= remaining; r++) {
      cells.push({ day: r, other: true });
    }

    var calHtml = '<div class="bc-calendar">' + headHtml + '<div class="bc-cal-body">';
    // 读取当月支出
    var allExpenses = Store.getExpenses ? Store.getExpenses() : [];
    var monthExpenses = allExpenses.filter(function (e) {
      if (!e.date) return false;
      var d = new Date(e.date);
      return d.getFullYear() === curYear && d.getMonth() === curMonth;
    });

    cells.forEach(function (c) {
      var cls = 'bc-day';
      if (c.other) cls += ' other';
      if (c.today) cls += ' today';
      var events = '';
      var eCount = 0;
      if (c.sessions) {
        c.sessions.forEach(function (s) {
          if (eCount >= 3) return;
          var b = s.billing || {};
          var cls2 = b.paid ? 'in' : (b.fee > 0 ? 'pending' : '');
          var client = Store.getClient(s.clientId);
          events += '<div class="day-event ' + cls2 + '">' + (client ? client.name : '?') + (b.fee ? ' ¥' + b.fee : '') + '</div>';
          eCount++;
        });
      }
      // 当日支出事件
      var dayExpenses = monthExpenses.filter(function (e) { return e.date === c.date; });
      dayExpenses.forEach(function (e) {
        if (eCount >= 4) return;
        events += '<div class="day-event out">' + (e.category || '支出') + ' -¥' + (e.amount || 0) + '</div>';
        eCount++;
      });
      calHtml += '<div class="' + cls + '" onclick="viewDay(\'' + (c.date || '') + '\')">' +
        '<div class="day-num">' + c.day + '</div>' +
        '<div class="day-events">' + events + '</div></div>';
    });
    calHtml += '</div></div>';

    box.innerHTML = overviewHtml + calHtml;
  }

  function isToday(dateStr) {
    var now = new Date();
    var t = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    return dateStr === t;
  }

  window.viewDay = function (dateStr) {
    if (!dateStr) return;
    location.href = 'billing-shell.html?date=' + dateStr;
  };

  init();
  // 月历底部会员门控（v3.2.0 featureGate 硬门控 + lockBadge 视觉）
  if (typeof App !== 'undefined' && typeof App.featureGate === 'function' && !App.featureGate('billing-calendar')) {
    var bcBody = document.getElementById('bc-body');
    if (bcBody) {
      var gateDiv = document.createElement('div');
      gateDiv.innerHTML = '<div class="xj-locked-area" style="text-align:center;padding:24px;font-size:12px;color:var(--ink-3);border-top:1px solid var(--border);margin-top:16px"><div class="xj-lock-overlay"></div>' + App.lockBadge('billing-calendar') + ' 月历明细<br>升级会员查看每日收入支出明细</div>';
      bcBody.appendChild(gateDiv);
    }
  }
})();