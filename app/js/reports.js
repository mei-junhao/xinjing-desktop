/* ============================================================
   心镜 XinJing — 报告中心逻辑
   ============================================================ */

/* ------------------------------------------------------------
   可复用：全站报告矩阵渲染器
   - 渲染 全部来访者 × 其会话 的矩阵表（table.matrix）
   - 列：来访者 | 节次 | 逐字稿 | SOAP | DAP | 反思 | 督导
   - 单元格点击：opts.onClickSession(sessionId, field) 或默认跳 session.html
     field ∈ 'transcript'|'soap'|'dap'|'reflection'|'supervision'；节次列 field=undefined
   - opts.clients：传入则只渲染这些来访者（咨询记录页的「报告矩阵」子面板用）
   ------------------------------------------------------------ */
window.Reports = {
  renderMatrix: function (container, opts) {
    opts = opts || {};
    const clients = opts.clients || Store.getClients();
    const supervisions = Store.getSupervisions();
    const onClick = opts.onClickSession || null;

    function supNamesForSession(sid) {
      return supervisions
        .filter((sv) => (sv.sessionIds || []).indexOf(sid) !== -1)
        .map((sv) => sv.supervisorName)
        .filter(Boolean);
    }
    function cell(sid, field, has, label) {
      const txt = label != null ? label : (has ? '有' : '—');
      if (onClick) {
        return '<td class="cell" data-sid="' + sid + '" data-field="' + field + '">' + App.escapeHtml(txt) + '</td>';
      }
      return '<td class="cell"><a href="session.html?id=' + sid + '">' + App.escapeHtml(txt) + '</a></td>';
    }

    let rows = '';
    clients.forEach(function (client) {
      const sessions = Store.getSessionsByClient(client.id);
      if (!sessions.length) return;
      sessions.forEach(function (s) {
        const supNames = supNamesForSession(s.id);
        rows += '<tr>'
          + '<td>' + App.escapeHtml(client.name) + '</td>'
          + '<td class="cell" data-sid="' + s.id + '" data-field="">第' + s.sessionNumber + '节 ' + (App.formatDate(s.date, true) || '') + '</td>'
          + cell(s.id, 'transcript', s.hasTranscript)
          + cell(s.id, 'soap', s.hasSoap)
          + cell(s.id, 'dap', s.hasDap)
          + cell(s.id, 'reflection', s.hasReflection)
          + cell(s.id, 'supervision', supNames.length > 0, supNames.join('、') || '—')
          + '</tr>';
      });
    });

    if (!rows) {
      container.innerHTML = '<div class="empty">暂无符合条件的报告记录。</div>';
      return;
    }
    container.innerHTML = '<table class="matrix"><thead><tr>'
      + '<th>来访者</th><th>节次</th><th>逐字稿</th><th>SOAP</th><th>DAP</th><th>反思</th><th>督导</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';

    if (!container.__matrixBound) {
      container.addEventListener('click', function (e) {
        const td = e.target.closest('[data-sid]');
        if (!td) return;
        const sid = td.getAttribute('data-sid');
        const field = td.getAttribute('data-field') || undefined;
        const cb = container.__matrixOnClick;
        if (cb) cb(sid, field);
        else location.href = 'session.html?id=' + sid;
      });
      container.__matrixBound = true;
    }
    container.__matrixOnClick = onClick;
  },
};

if (document.getElementById('report-tbody')) {
App.initPage({
  title: '报告中心',
  subtitle: '筛选、浏览与导出个案报告',
  actions: '',
  onReady: function () {
    'use strict';

    const filter = {
    client: 'all',
    rtype: 'all',
    stype: 'all',
    sup: 'all',
  };

  const selected = new Set();

  function initFilters() {
    // 来访者 → select 下拉
    const clients = Store.getClients();
    const clientSelect = document.getElementById('filter-client-select');
    clientSelect.innerHTML = '<option value="all">全部来访者</option>' +
      clients.map((c) => `<option value="${c.id}">${App.escapeHtml(c.name)}</option>`).join('');
    document.getElementById('client-count-hint').textContent = clients.length ? `共 ${clients.length} 位` : '';

    // 督导师 → select 下拉（从督导记录中收集）
    const supervisors = [...new Set(Store.getSupervisions().map((sv) => sv.supervisorName).filter(Boolean))];
    const supSelect = document.getElementById('filter-sup-select');
    supSelect.innerHTML = '<option value="all">全部督导师</option>' +
      supervisors.map((s) => `<option value="${App.escapeHtml(s)}">${App.escapeHtml(s)}</option>`).join('');
  }

  window.setFilter = function (type, value) {
    filter[type] = value;
    // 更新对应组的 pill 状态
    const attrMap = { client: 'client', rtype: 'rtype', stype: 'stype', sup: 'sup' };
    document.querySelectorAll(`.pill[${attrMap[type]}]`).forEach((p) => {
      p.classList.toggle('active', p.getAttribute(attrMap[type]) === value);
    });
    // 同步 select 值（来访者 / 督导师）
    if (type === 'client') {
      const sel = document.getElementById('filter-client-select');
      if (sel) sel.value = value;
    }
    if (type === 'sup') {
      const sel = document.getElementById('filter-sup-select');
      if (sel) sel.value = value;
    }
    renderTable();
  };

  function getSupervisionForSession(sessionId) {
    return Store.getSupervisions().filter((sv) => (sv.sessionIds || []).includes(sessionId));
  }

  function matchFilters(session, sups) {
    if (filter.client !== 'all' && session.clientId !== filter.client) return false;
    if (filter.rtype !== 'all') {
      const map = { transcript: session.hasTranscript, soap: session.hasSoap, dap: session.hasDap, reflection: session.hasReflection };
      if (!map[filter.rtype]) return false;
    }
    if (filter.stype !== 'all') {
      const hasType = sups.some((sv) => sv.type === filter.stype);
      if (!hasType) return false;
    }
    if (filter.sup !== 'all') {
      const hasSup = sups.some((sv) => sv.supervisorName === filter.sup);
      if (!hasSup) return false;
    }
    return true;
  }

  function renderTable() {
    const tbody = document.getElementById('report-tbody');
    const clients = Store.getClients();
    let rows = '';

    for (const client of clients) {
      if (filter.client !== 'all' && client.id !== filter.client) continue;
      const sessions = Store.getSessionsByClient(client.id);
      const matched = sessions.filter((s) => {
        const sups = getSupervisionForSession(s.id);
        return matchFilters(s, sups);
      });

      if (!matched.length) continue;

      // 客户端分组头
      rows += `<tr><td colspan="7" class="client-group-header">${App.escapeHtml(client.name)} · 共 ${matched.length} 节</td></tr>`;

      for (const s of matched) {
        const sups = getSupervisionForSession(s.id);
        const individual = sups.filter((sv) => sv.type === 'individual');
        const group = sups.filter((sv) => sv.type === 'group');
        const isSel = selected.has(s.id);

        rows += `<tr>
          <td><span class="checkbox ${isSel ? 'checked' : ''}" data-sid="${s.id}" onclick="toggleSelect('${s.id}')">${isSel ? '✓' : ''}</span></td>
          <td><span class="session-link" onclick="location.href='session.html?id=${s.id}'">第${s.sessionNumber}节</span><br><span style="font-size:11px;color:var(--muted)">${App.formatDate(s.date, true)}</span></td>
          <td>${s.hasTranscript ? `<span class="tag tag-transcript">逐字稿</span>` : '<span style="color:var(--muted)">—</span>'}</td>
          <td>
            ${s.hasSoap ? '<span class="tag tag-soap">SOAP</span> ' : ''}
            ${s.hasDap ? '<span class="tag tag-dap">DAP</span>' : ''}
            ${!s.hasSoap && !s.hasDap ? '<span style="color:var(--muted)">—</span>' : ''}
          </td>
          <td>${s.hasReflection ? '<span class="tag tag-reflection">反思</span>' : '<span style="color:var(--muted)">—</span>'}</td>
          <td>${individual.length ? individual.map((sv) => `<span class="tag tag-supervision">${App.escapeHtml(sv.supervisorName || '?')}✓</span>`).join(' ') : '<span style="color:var(--muted)">—</span>'}</td>
          <td>${group.length ? group.map((sv) => `<span class="tag tag-supervision">${App.escapeHtml(sv.supervisorName || '?')}✓</span>`).join(' ') : '<span style="color:var(--muted)">—</span>'}</td>
        </tr>`;
      }
    }

    if (!rows) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon">${App.svgIcon('bars')}</div><div class="text">没有符合条件的报告</div></div></td></tr>`;
    } else {
      tbody.innerHTML = rows;
    }
    updateSelectedHint();
  }

  window.toggleSelect = function (sid) {
    if (selected.has(sid)) selected.delete(sid);
    else selected.add(sid);
    renderTable();
  };

  window.toggleCheckAll = function () {
    const checkAll = document.getElementById('check-all');
    const isChecked = checkAll.classList.contains('checked');
    const tbody = document.getElementById('report-tbody');
    const checkboxes = tbody.querySelectorAll('.checkbox[data-sid]');
    checkboxes.forEach((cb) => {
      const sid = cb.dataset.sid;
      if (isChecked) selected.delete(sid);
      else selected.add(sid);
    });
    checkAll.classList.toggle('checked', !isChecked);
    checkAll.textContent = !isChecked ? '✓' : '';
    renderTable();
    // 保持全选状态视觉
    checkAll.classList.toggle('checked', !isChecked);
    checkAll.textContent = !isChecked ? '✓' : '';
  };

  function updateSelectedHint() {
    const hint = document.getElementById('selected-hint');
    hint.textContent = selected.size ? `已勾选 ${selected.size} 节，可一键导出` : '勾选节次后可一键导出';
  }

  window.exportSelected = function () {
    if (!selected.size) {
      App.showToast('请先勾选要导出的节次', 'error');
      return;
    }
    Export.exportBatch([...selected]).then(() => {
      App.showToast(`已导出 ${selected.size} 节报告`, 'success');
    });
  };

    // 初始渲染
    initFilters();
    renderTable();
  },
});
}
