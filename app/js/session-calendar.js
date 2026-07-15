/* 心镜 · 咨询日历视图（会话按日期排布，复用账单月历的渲染骨架） */
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
    var box = document.getElementById('sc-body');
    if (!box) return;
    var label = document.getElementById('month-label');
    if (label) label.textContent = curYear + '年' + (curMonth + 1) + '月';

    var sessions = (typeof Store !== 'undefined' && Store.getSessions) ? Store.getSessions() : [];
    var monthSessions = sessions.filter(function (s) {
      if (!s.date) return false;
      var d = new Date(s.date);
      return d.getFullYear() === curYear && d.getMonth() === curMonth;
    });

    var overviewHtml = '<div class="bc-overview">' +
      '<div class="bc-ov-card"><div class="lbl">本月会谈</div><div class="val accent">' + monthSessions.length + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">涉及来访者</div><div class="val accent">' + countClients(monthSessions) + '</div></div>' +
      '</div>';

    var firstDay = new Date(curYear, curMonth, 1).getDay();
    var daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
    var daysInPrev = new Date(curYear, curMonth, 0).getDate();

    var dayNames = ['日', '一', '二', '三', '四', '五', '六'];
    var headHtml = '<div class="bc-cal-head">' + dayNames.map(function (n) { return '<div>' + n + '</div>'; }).join('') + '</div>';

    var cells = [];
    for (var i = 0; i < firstDay; i++) {
      cells.push({ day: daysInPrev - firstDay + 1 + i, other: true });
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = curYear + '-' + String(curMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      cells.push({
        day: d,
        date: dateStr,
        sessions: monthSessions.filter(function (s) { return s.date === dateStr; }),
        other: false,
        today: isToday(dateStr)
      });
    }
    var remaining = 42 - cells.length;
    for (var r = 1; r <= remaining; r++) {
      cells.push({ day: r, other: true });
    }

    var calHtml = '<div class="bc-calendar">' + headHtml + '<div class="bc-cal-body">';
    cells.forEach(function (c) {
      var cls = 'bc-day';
      if (c.other) cls += ' other';
      if (c.today) cls += ' today';
      var events = '';
      var eCount = 0;
      if (c.sessions) {
        c.sessions.forEach(function (s) {
          if (eCount >= 3) return;
          var client = (typeof Store !== 'undefined' && Store.getClient) ? Store.getClient(s.clientId) : null;
          var esc = (typeof App !== 'undefined' && App.escapeHtml) ? App.escapeHtml : function (x) { return x; };
          events += '<div class="day-event">' + esc(client ? client.name : '?') + ' 第' + (s.sessionNumber || '?') + '节</div>';
          eCount++;
        });
        if (c.sessions.length > 3) events += '<div class="day-more">+' + (c.sessions.length - 3) + '</div>';
      }
      calHtml += '<div class="' + cls + '" onclick="viewDay(\'' + (c.date || '') + '\')">' +
        '<div class="day-num">' + c.day + '</div>' +
        '<div class="day-events">' + events + '</div></div>';
    });
    calHtml += '</div></div>';

    box.innerHTML = overviewHtml + calHtml;
  }

  function countClients(arr) {
    var set = {};
    arr.forEach(function (s) { if (s.clientId) set[s.clientId] = 1; });
    return Object.keys(set).length;
  }

  function isToday(dateStr) {
    var now = new Date();
    var t = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    return dateStr === t;
  }

  window.viewDay = function (dateStr) {
    if (!dateStr) return;
    location.href = 'consult-notes.html?date=' + dateStr;
  };

  init();
})();
