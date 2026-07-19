/* 心镜 v3.7.0 — 账单月历视图（合并月结单 + 月概览含支出/净收入 + 月结模式自动计算）*/
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

  function ymOf() { return curYear + '-' + String(curMonth + 1).padStart(2, '0'); }

  // Bug-13 修复：避免 new Date('YYYY-MM-DD') 按 UTC 解析在非东八区错位
  // 改用字符串前缀比较判断是否属于某年某月
  function dateInMonth(dateStr, year, month) {
    if (!dateStr || dateStr.length < 7) return false;
    var ym = year + '-' + String(month + 1).padStart(2, '0');
    return dateStr.slice(0, 7) === ym;
  }

  function isToday(dateStr) {
    var now = new Date();
    var t = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    return dateStr === t;
  }

  // v3.7.0 月结模式自动计算应收：
  //   per-session/prepaid → 本月 sessions.fee 合计
  //   monthly → 本月 sessions.fee 合计（用户指定按本月真实咨询节数，不是固定月费）
  //   任何模式都允许用户在月结单区手动覆盖金额
  // Bug-6 修复：移除未使用的 client 参数
  function computeReceivable(sessions) {
    var total = 0;
    sessions.forEach(function (s) {
      var fee = (s.billing && Number(s.billing.fee)) || 0;
      total += fee;
    });
    return total;
  }

  function computeReceived(client, ym, sessions) {
    var sessionPaid = 0;
    sessions.forEach(function (s) {
      if (s.billing && s.billing.paid) {
        var fee = Number(s.billing.fee) || 0;
        var paidAmt = (s.billing.paidAmount != null) ? Number(s.billing.paidAmount) : fee;
        sessionPaid += paidAmt;
      }
    });
    var mpAmount = 0;
    if (client && client.billing && Array.isArray(client.billing.monthlyPayments)) {
      client.billing.monthlyPayments.forEach(function (m) {
        if (m.month === ym) {
          var amt = Number(m.amount) || 0;
          if (amt > 0) mpAmount += amt;  // P3-C: 统一 >0 过滤
        }
      });
    }
    return sessionPaid + mpAmount;
  }

  function render() {
    var box = document.getElementById('bc-body');
    document.getElementById('month-label').textContent = curYear + '年' + (curMonth + 1) + '月';

    // 保存当前月结单区选中的来访者/月份，避免 render() 后被重置
    // P3#9 修复：prevMonthInput 命名避免遮蔽全局函数 prevMonth()
    var savedClientId = null, savedYm = null;
    var prevClient = document.getElementById('bc-inv-client');
    var prevMonthInput = document.getElementById('bc-inv-month');
    if (prevClient && prevClient.value) {
      savedClientId = prevClient.value;
      savedYm = prevMonthInput ? prevMonthInput.value : null;
    }

    var ym = ymOf();
    var sessions = Store.getSessions();
    // Bug-3 修复：仅纳入 billing 非 null 的财务会谈，排除临床记录（billing:null）
    // 与 billing-shell.html 的 billableSessionsFor 口径一致
    var monthSessions = sessions.filter(function (s) {
      if (!s.date) return false;
      if (!Store.isBillableSession(s)) return false;
      // Bug-13: 用字符串比较代替 new Date() 避免时区错位
      return dateInMonth(s.date, curYear, curMonth);
    });

    // 月概览（含支出/净收入，v3.7.0 6 张卡片）
    var totalFee = 0, totalPaid = 0;
    var sessionCount = monthSessions.length;
    monthSessions.forEach(function (s) {
      var b = s.billing || {};
      var fee = Number(b.fee) || 0;
      if (fee > 0) totalFee += fee;
      if (b.paid) totalPaid += (b.paidAmount != null ? Number(b.paidAmount) : fee);
    });
    // P2-A 修复（第四轮压测）：已收需追加所有 client 的当月 monthlyPayments（月结单确认结算写入的金额），
    //   与 billing-shell.html 的 renderBillingStats.mPaid 口径一致；
    //   待收改为 totalFee - totalPaid（同时覆盖 partial payment 场景，避免双重计算）
    var ymStr = ymOf();
    Store.getClients().forEach(function (c) {
      if (c.billing && Array.isArray(c.billing.monthlyPayments)) {
        c.billing.monthlyPayments.forEach(function (mp) {
          if (mp.month === ymStr) {
            var amt = Number(mp.amount) || 0;
            if (amt > 0) totalPaid += amt;  // P3-C: 统一 >0 过滤，与 clientAgg/renderBillingStats 对齐
          }
        });
      }
    });
    var totalPending = Math.max(0, totalFee - totalPaid);

    var allExpenses = Store.getExpenses ? Store.getExpenses() : [];
    var monthExpenses = allExpenses.filter(function (e) {
      if (!e.date) return false;
      // Bug-13: 用字符串比较代替 new Date() 避免时区错位
      return dateInMonth(e.date, curYear, curMonth);
    });
    var totalExpense = monthExpenses.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    // P3-F 修复（第四轮压测）：改名"应收净额"，与 billing-shell 的"净收入(已收口径)"区分
    var netIncome = totalFee - totalExpense;
    // P3#8 修复：负数净收入显示 -¥1,000 而非 ¥-1,000
    function fmtMoney(n) { return (n < 0 ? '-¥' : '¥') + Math.abs(n).toLocaleString(); }

    var overviewHtml = '<div class="bc-overview">' +
      '<div class="bc-ov-card"><div class="lbl">会谈次数</div><div class="val count">' + sessionCount + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">收入</div><div class="val income">¥' + totalFee.toLocaleString() + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">支出</div><div class="val expense">¥' + totalExpense.toLocaleString() + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">应收净额</div><div class="val net">' + fmtMoney(netIncome) + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">已收</div><div class="val received">¥' + totalPaid.toLocaleString() + '</div></div>' +
      '<div class="bc-ov-card"><div class="lbl">待收</div><div class="val pending">¥' + totalPending.toLocaleString() + '</div></div>' +
      '</div>';

    // 日历
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
      var daySession = monthSessions.filter(function (s) { return s.date === dateStr; });
      cells.push({ day: d, date: dateStr, sessions: daySession, other: false, today: isToday(dateStr) });
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
          var b = s.billing || {};
          var cls2 = b.paid ? 'in' : (b.fee > 0 ? 'pending' : '');
          var client = Store.getClient(s.clientId);
          var clientName = client ? client.name : '?';
          events += '<div class="day-event ' + cls2 + '">' + (client ? App.escapeHtml(clientName) : '?') + (b.fee ? ' ¥' + b.fee : '') + '</div>';
          eCount++;
        });
      }
      var dayExpenses = monthExpenses.filter(function (e) { return e.date === c.date; });
      dayExpenses.forEach(function (e) {
        if (eCount >= 4) return;
        events += '<div class="day-event out">' + App.escapeHtml(e.category || '支出') + ' -¥' + (e.amount || 0) + '</div>';
        eCount++;
      });
      calHtml += '<div class="' + cls + '" data-date="' + (c.date || '') + '">' +
        '<div class="day-num">' + c.day + '</div>' +
        '<div class="day-events">' + events + '</div></div>';
    });
    calHtml += '</div></div>';

    // v3.7.0 月结单区（月历子项）
    var invoiceHtml = renderInvoiceSection(ym);

    box.innerHTML = overviewHtml + calHtml + invoiceHtml;

    // 点击日期：弹层显示当日明细（不再跳页）
    box.querySelectorAll('.bc-day[data-date]').forEach(function (el) {
      el.addEventListener('click', function () {
        var date = el.dataset.date;
        if (!date) return;
        showDayDetail(date, monthSessions.filter(function (s) { return s.date === date; }), monthExpenses.filter(function (e) { return e.date === date; }));
      });
    });

    bindInvoiceEvents(ym);

    // 恢复月结单区选中状态：如果有 savedClientId，加载该来访者；否则自动加载第一个
    // P2#2 修复：月份恢复优先使用 savedYm（用户在月结单区选的月份），无则用月历当前月份 ym
    var restoreClient = document.getElementById('bc-inv-client');
    if (restoreClient) {
      var restoreYm = savedYm || ym;
      if (savedClientId) {
        // 尝试恢复选中值（如果来访者仍存在）
        var clientExists = Array.from(restoreClient.options).some(function (o) { return o.value === savedClientId; });
        if (clientExists) {
          restoreClient.value = savedClientId;
          var monthInput = document.getElementById('bc-inv-month');
          if (monthInput) monthInput.value = restoreYm;
          renderInvoiceDetail(savedClientId, restoreYm);
        } else {
          // 来访者不存在了，加载第一个
          if (restoreClient.value) renderInvoiceDetail(restoreClient.value, restoreYm);
        }
      } else if (restoreClient.value) {
        // 首次渲染，自动加载第一个来访者本月
        renderInvoiceDetail(restoreClient.value, restoreYm);
      }
    }
  }

  // v3.7.0 月结单区渲染
  function renderInvoiceSection(ym) {
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    if (!clients.length) {
      return '<div class="bc-invoice-section"><h3>📋 月结单</h3><div class="bc-inv-empty">请先在来访者档案中创建来访者</div></div>';
    }
    var clientOpts = clients.map(function (c) {
      return '<option value="' + App.escapeHtml(c.id) + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
    return '<div class="bc-invoice-section">' +
      '<h3>📋 月结单</h3><div class="hint">生成账单并确认结算，写入月结记录（含打印/PDF 与手动覆盖金额）</div>' +
      '<div class="bc-inv-form">' +
        '<label>来访者<select id="bc-inv-client">' + clientOpts + '</select></label>' +
        '<label>月份<input type="month" id="bc-inv-month" value="' + ym + '"></label>' +
        '<button id="bc-inv-load">加载月结单</button>' +
      '</div>' +
      '<div id="bc-inv-detail"></div>' +
      '</div>';
  }

  function bindInvoiceEvents(ym) {
    var loadBtn = document.getElementById('bc-inv-load');
    if (!loadBtn) return;
    loadBtn.addEventListener('click', function () {
      var clientId = document.getElementById('bc-inv-client').value;
      var month = document.getElementById('bc-inv-month').value || ym;
      if (!clientId) { App.showToast('请选择来访者', 'warning'); return; }
      renderInvoiceDetail(clientId, month);
    });
  }

  function renderInvoiceDetail(clientId, ym) {
    var detailBox = document.getElementById('bc-inv-detail');
    if (!detailBox) return;
    var client = Store.getClient(clientId);
    if (!client) { detailBox.innerHTML = '<div class="bc-inv-empty">来访者不存在</div>'; return; }

    var ymParts = ym.split('-');
    var y = parseInt(ymParts[0], 10);
    var m = parseInt(ymParts[1], 10) - 1;
    // Bug-12 修复：校验 ym 格式，避免 NaN 导致静默返回空列表
    if (isNaN(y) || isNaN(m) || m < 0 || m > 11) {
      detailBox.innerHTML = '<div class="bc-inv-empty">月份格式错误：' + App.escapeHtml(ym) + '</div>';
      return;
    }
    var sessions = Store.getSessions().filter(function (s) {
      if (!s.date || s.clientId !== clientId) return false;
      if (!Store.isBillableSession(s)) return false;  // Bug-3: 排除临床记录
      // Bug-13: 用字符串比较代替 new Date() 避免时区错位
      return dateInMonth(s.date, y, m);
    });
    sessions.sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });

    var mode = (client.billing && client.billing.billingMode) || 'per-session';
    var modeLabel = mode === 'monthly' ? '月结' : (mode === 'prepaid' ? '预付费' : '次结');
    var modeClass = mode === 'monthly' ? 'monthly' : '';

    var receivable = computeReceivable(sessions);  // 应收：本月实际会谈费用合计
    var received = computeReceived(client, ym, sessions);  // 已收：已付 sessions + monthlyPayments
    var pending = Math.max(0, receivable - received);

    // 已有月结记录金额（用于显示「已记月结」）
    // P3-C 修复（第五轮压测）：统一 >0 过滤，与 computeReceived 对齐
    var existingMpAmount = 0;
    if (client.billing && Array.isArray(client.billing.monthlyPayments)) {
      client.billing.monthlyPayments.forEach(function (mp) {
        if (mp.month === ym) {
          var amt = Number(mp.amount) || 0;
          if (amt > 0) existingMpAmount += amt;
        }
      });
    }

    // P1 修复：「确认结算」按钮结算的是 pending（待收金额），不是 receivable（应收总额）。
    // 语义：monthlyPayments[ym] = 月末补充结算金额（用户为结清本月待收而支付的额外款项）。
    // 这样 received = sessionPaid + mpAmount 不会双重计算。
    // 用户若想记录「整月一次性付清」，可点「手动覆盖金额」输入完整金额（会替换月结记录）。
    // P1#二轮修复：确认结算用 'add' 累加语义（prevMp + pending），避免二次结算丢失历史 mp。
    //   手动覆盖用 'replace' 替换语义（amt 直接覆盖 prevMp）。
    var settleAmount = pending;
    var settleBtnLabel = pending > 0
      ? '确认结算 ¥' + pending.toLocaleString()
      : '已结清（无需结算）';
    // P3#9 修复：变量名 settleBtnDisabled 误导（实际是属性串），重命名为 settleBtnAttrs
    var settleBtnAttrs = pending <= 0 ? ' disabled style="opacity:.5;cursor:not-allowed"' : '';

    var rowsHtml = sessions.map(function (s, i) {
      var b = s.billing || {};
      var fee = Number(b.fee) || 0;
      var paidAmt = b.paid ? (b.paidAmount != null ? Number(b.paidAmount) : fee) : 0;
      return '<tr><td style="padding:6px 4px">' + App.escapeHtml(s.date || '') + '</td>' +
        '<td>第' + (s.sessionNumber || (i + 1)) + '节</td>' +
        '<td>¥' + fee.toLocaleString() + '</td>' +
        '<td style="color:' + (b.paid ? 'var(--success)' : 'var(--orange)') + '">' + (b.paid ? '已收 ¥' + paidAmt.toLocaleString() : '待收') + '</td></tr>';
    }).join('');
    if (!rowsHtml) rowsHtml = '<tr><td colspan="4" style="text-align:center;padding:14px;color:var(--ink-3)">本月暂无会谈记录</td></tr>';

    // P1 修复：拆分显示「会谈已收」与「月结已收」，避免用户误以为双重计算
    var sessionPaidOnly = 0;
    sessions.forEach(function (s) {
      if (s.billing && s.billing.paid) {
        var fee = Number(s.billing.fee) || 0;
        sessionPaidOnly += (s.billing.paidAmount != null) ? Number(s.billing.paidAmount) : fee;
      }
    });

    var summaryHtml = '<div class="bc-inv-summary">' +
      '<div class="item"><span>结算模式</span><b><span class="bc-inv-mode-tag ' + modeClass + '">' + modeLabel + '</span></b></div>' +
      '<div class="item income"><span>应收（自动）</span><b>¥' + receivable.toLocaleString() + '</b></div>' +
      '<div class="item"><span>会谈已收</span><b>¥' + sessionPaidOnly.toLocaleString() + '</b></div>' +
      (existingMpAmount > 0 ? '<div class="item"><span>月结已收</span><b>¥' + existingMpAmount.toLocaleString() + '</b></div>' : '') +
      '<div class="item"><span>已收合计</span><b>¥' + received.toLocaleString() + '</b></div>' +
      '<div class="item pending"><span>待收</span><b>¥' + pending.toLocaleString() + '</b></div>' +
      '</div>';

    var actionsHtml = '<div class="bc-inv-actions">' +
      '<button class="btn-print" id="bc-inv-print">打印 / 存为 PDF</button>' +
      '<button class="btn-settle" id="bc-inv-settle"' + settleBtnAttrs + '>' + settleBtnLabel + '</button>' +
      '<button class="btn-override" id="bc-inv-toggle-override">手动覆盖金额</button>' +
      '<span id="bc-inv-override-wrap" style="display:none">' +
        '<input type="number" class="override-input" id="bc-inv-override-amt" value="' + settleAmount + '" min="0" placeholder="补充结算金额">' +
        '<button class="btn-settle" id="bc-inv-settle-override">按此金额结算</button>' +
      '</span>' +
      '</div>';

    var billHtml = '<div class="bc-inv-bill">' +
      '<table style="width:100%;border-collapse:collapse;font:13px var(--sans)">' +
      '<thead><tr style="color:var(--ink-3);border-bottom:1px solid var(--border)"><th style="padding:6px 4px;text-align:left">日期</th><th>节次</th><th>费用</th><th>状态</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table>' +
      '</div>';

    detailBox.innerHTML = summaryHtml + actionsHtml + billHtml;

    // 绑定事件
    var printBtn = document.getElementById('bc-inv-print');
    if (printBtn) printBtn.addEventListener('click', function () { printInvoice(client, ym, sessions, receivable, received, pending); });

    var settleBtn = document.getElementById('bc-inv-settle');
    if (settleBtn) settleBtn.addEventListener('click', function () {
      if (pending <= 0) { App.showToast('本月已结清，无需结算', 'info'); return; }
      // P1#二轮修复：'add' 模式——在已有 mp 基础上累加 pending，避免覆盖历史月结金额
      doSettle(clientId, ym, pending, 'add');
    });

    var toggleBtn = document.getElementById('bc-inv-toggle-override');
    if (toggleBtn) toggleBtn.addEventListener('click', function () {
      var wrap = document.getElementById('bc-inv-override-wrap');
      if (wrap) wrap.style.display = (wrap.style.display === 'none' ? 'inline-flex' : 'none');
    });

    var settleOverrideBtn = document.getElementById('bc-inv-settle-override');
    if (settleOverrideBtn) settleOverrideBtn.addEventListener('click', function () {
      var amt = Number(document.getElementById('bc-inv-override-amt').value) || 0;
      if (amt <= 0) { App.showToast('结算金额需 > 0', 'warning'); return; }
      // 'replace' 模式：amt 直接替换该月所有 mp，用于「整月一次性付清」场景
      doSettle(clientId, ym, amt, 'replace');
    });
  }

  // v3.7.0 写入 monthlyPayments（真实结算）
  // P1#二轮修复：doSettle 区分两种模式——
  //   mode='add'      → 在该月已有 mp 累计金额基础上累加 amount（用于「确认结算」按钮结清待收）
  //   mode='replace'  → 用 amount 直接替换该月所有 mp（用于「手动覆盖金额」按钮一次性重置）
  // P3#10 修复：amount 上界合理性校验（单次结算金额不应超过 1 亿，防误操作）
  function doSettle(clientId, ym, amount, mode) {
    var client = Store.getClient(clientId);
    if (!client) { App.showToast('来访者不存在', 'error'); return; }
    if (amount <= 0) { App.showToast('结算金额需 > 0', 'warning'); return; }
    if (amount > 100000000) { App.showToast('结算金额异常过大，已拦截', 'error'); return; }
    // 月份格式校验（防 YYYY-M 不规范输入）
    if (!/^\d{4}-\d{2}$/.test(ym)) { App.showToast('月份格式错误', 'error'); return; }
    var billing = Object.assign({}, client.billing || {});
    var oldMp = Array.isArray(billing.monthlyPayments) ? billing.monthlyPayments : [];
    var prevAmount = oldMp
      .filter(function (m) { return m.month === ym; })
      .reduce(function (s, m) { return s + (Number(m.amount) || 0); }, 0);
    var newAmount = mode === 'add' ? (prevAmount + amount) : amount;
    // 移除该月所有旧条目，保留其他月份
    billing.monthlyPayments = oldMp.filter(function (m) { return m.month !== ym; });
    billing.monthlyPayments.push({ month: ym, amount: newAmount });
    Store.updateClient(clientId, { billing: billing });
    var label = mode === 'add' ? '本次 ¥' + amount.toLocaleString() + '，累计 ¥' + newAmount.toLocaleString()
                               : '已设为 ¥' + newAmount.toLocaleString();
    App.showToast('月结已保存 · ' + label, 'success');
    // render() 会自动恢复月结单区到当前选中的来访者
    render();
  }

  function printInvoice(client, ym, sessions, receivable, received, pending) {
    var y = ym.slice(0, 4);
    var m = Number(ym.slice(5));
    // P3-2 修复（第三轮压测）：防御性校验，避免异常 ym 导致 "NaN 月"
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
      App.showToast('月份格式错误，无法打印', 'error');
      return;
    }
    var rows = sessions.map(function (s, i) {
      var b = s.billing || {};
      var fee = Number(b.fee) || 0;
      var paid = !!(b && b.paid);
      var paidAmt = paid ? (b.paidAmount != null ? Number(b.paidAmount) : fee) : 0;
      return '<tr><td style="padding:6px">' + App.escapeHtml(s.date || '') + '</td><td>第' + (s.sessionNumber || (i + 1)) + '节</td><td>¥' + fee.toLocaleString() + '</td><td style="color:' + (paid ? '#3f7d5a' : '#b06a47') + '">' + (paid ? '已收 ¥' + paidAmt.toLocaleString() : '未收') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" style="text-align:center;padding:14px;color:#999">本月暂无会谈记录</td></tr>';
    var billHtml =
      '<div style="max-width:520px;margin:0 auto;background:#fff;padding:32px 34px;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#3a2f28">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid #9E5A3C;padding-bottom:12px;margin-bottom:18px">' +
          '<div><div style="font-size:20px;font-weight:700;color:#9E5A3C;letter-spacing:1px">心镜 · 咨询账单</div><div style="font-size:12px;color:#9a8a7c;margin-top:4px">XinJing Psychological Counseling</div></div>' +
          '<div style="font-size:13px;color:#6b5d52;text-align:right">账单月份<br><b style="font-size:16px">' + y + ' 年 ' + m + ' 月</b></div>' +
        '</div>' +
        '<div style="font-size:15px;margin-bottom:4px">尊敬的 <b>' + App.escapeHtml(client.name) + '</b> 女士/先生：</div>' +
        '<div style="font-size:13px;color:#6b5d52;margin-bottom:18px">以下是您 ' + y + ' 年 ' + m + ' 月的咨询明细，感谢您的信任与同行。</div>' +
        '<div style="display:flex;gap:10px;margin-bottom:18px">' +
          '<div style="flex:1;background:#fbf3ea;border:1px solid #efe2d2;border-radius:10px;padding:10px 8px;text-align:center"><div style="font-size:17px;font-weight:700;color:#9E5A3C">' + sessions.length + ' 节</div><div style="font-size:11px;color:#9a8a7c">本月咨询</div></div>' +
          '<div style="flex:1;background:#fbf3ea;border:1px solid #efe2d2;border-radius:10px;padding:10px 8px;text-align:center"><div style="font-size:17px;font-weight:700;color:#9E5A3C">¥' + receivable.toLocaleString() + '</div><div style="font-size:11px;color:#9a8a7c">应收合计</div></div>' +
          '<div style="flex:1;background:#fbf3ea;border:1px solid #efe2d2;border-radius:10px;padding:10px 8px;text-align:center"><div style="font-size:17px;font-weight:700;color:#3f7d5a">¥' + received.toLocaleString() + '</div><div style="font-size:11px;color:#9a8a7c">已收</div></div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="color:#9E5A3C;text-align:left;border-bottom:1px solid #e7d8c8"><th style="padding:8px 6px">日期</th><th>节次</th><th>费用</th><th>状态</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<div style="display:flex;justify-content:space-between;margin-top:18px;padding-top:14px;border-top:1px solid #e7d8c8;font-size:14px">' +
          '<span>应收合计：<b>¥' + receivable.toLocaleString() + '</b></span>' +
          '<span>已收：<b style="color:#3f7d5a">¥' + received.toLocaleString() + '</b></span>' +
          '<span>待付：<b style="color:#b06a47">¥' + pending.toLocaleString() + '</b></span>' +
        '</div>' +
        '<div style="margin-top:18px;font-size:11px;color:#a89a8c;text-align:center;line-height:1.7">本账单由心镜 XinJing 自动生成 · 如有疑问请与咨询师联系<br>截图即具参考价值，正式发票请向咨询师索取</div>' +
      '</div>';
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(40,30,22,.55);z-index:10030;display:flex;align-items:center;justify-content:center;overflow:auto;padding:24px';
    overlay.innerHTML = '<div style="position:relative;max-height:92vh;overflow:auto">' +
      '<button onclick="this.closest(\'.modal-overlay\').remove()" style="position:absolute;top:-6px;right:-6px;z-index:2;width:34px;height:34px;border-radius:50%;border:none;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:18px;cursor:pointer;color:#6b5d52">×</button>' +
      billHtml +
      '<div style="text-align:center;margin-top:14px"><button onclick="window.print()" style="border:none;background:#9E5A3C;color:#fff;border-radius:8px;padding:9px 22px;font:600 13px sans-serif;cursor:pointer">打印 / 存为 PDF</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
  }

  // v3.7.0 当日明细弹层（不跳页）
  function showDayDetail(date, sessions, expenses) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10020;display:flex;align-items:center;justify-content:center;padding:20px';
    var sHtml = sessions.length ? sessions.map(function (s) {
      var b = s.billing || {};
      var client = Store.getClient(s.clientId);
      var clientName = client ? client.name : '?';
      var fee = Number(b.fee) || 0;
      // P2-B 修复（第四轮压测）：已收行用 paidAmount（实收），无则回退 fee，与 renderBDetail/showMonthlyBill 口径一致
      var paidAmt = b.paid ? (b.paidAmount != null ? Number(b.paidAmount) : fee) : 0;
      var status = b.paid ? '<span style="color:var(--success)">已收 ¥' + paidAmt.toLocaleString() + '</span>' : '<span style="color:var(--orange)">待收 ¥' + fee.toLocaleString() + '</span>';
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span>' + App.escapeHtml(clientName) + ' 第' + (s.sessionNumber || '') + '节</span>' + status + '</div>';
    }).join('') : '<div style="text-align:center;color:var(--ink-3);padding:14px">当日无收入记录</div>';

    var eHtml = expenses.length ? expenses.map(function (e) {
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)"><span>' + App.escapeHtml(e.category || '支出') + (e.description ? ' · ' + App.escapeHtml(e.description) : '') + '</span><span style="color:var(--success)">-¥' + (Number(e.amount) || 0).toLocaleString() + '</span></div>';
    }).join('') : '<div style="text-align:center;color:var(--ink-3);padding:14px">当日无支出记录</div>';

    var dayTotalIn = sessions.reduce(function (s, x) { return s + (Number(x.billing && x.billing.fee) || 0); }, 0);
    var dayTotalOut = expenses.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);

    overlay.innerHTML = '<div style="background:var(--paper-2,#fff);border-radius:14px;padding:22px;max-width:460px;width:92%;max-height:90vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,.18)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px"><h3 style="margin:0;font-family:var(--serif);font-size:18px">' + date + ' 明细</h3>' +
      '<button onclick="this.closest(\'.modal-overlay\').remove()" style="border:none;background:transparent;font-size:20px;cursor:pointer;color:var(--ink-3)">×</button></div>' +
      '<div style="font:12px var(--sans);color:var(--ink-3);margin-bottom:8px">收入 ¥' + dayTotalIn.toLocaleString() + ' · 支出 ¥' + dayTotalOut.toLocaleString() + ' · 净 ' + (dayTotalIn - dayTotalOut < 0 ? '-¥' : '¥') + Math.abs(dayTotalIn - dayTotalOut).toLocaleString() + '</div>' +
      '<div style="font:13px var(--sans)">' + sHtml + eHtml + '</div>' +
      '<div style="text-align:right;margin-top:14px"><button onclick="location.href=\'billing-shell.html?date=' + date + '\'" style="border:1px solid var(--border);background:transparent;border-radius:8px;padding:8px 14px;font:13px var(--sans);cursor:pointer;color:var(--ink-2)">前往账单编辑</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
  }

  init();
})();
