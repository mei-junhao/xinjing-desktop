/* ============================================================
   心镜 XinJing — 督导记录逻辑
   ============================================================ */

App.initPage({
  title: '督导',
  subtitle: '个体与团体督导记录',
  actions: `<button class="btn btn-primary" onclick="openSupModal()">新增督导记录<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`,
  onReady: function () {
    'use strict';

    App.bindModalClose('sup-modal');
    let currentType = 'all';

  window.setSupType = function (type) {
    currentType = type;
    document.querySelectorAll('#sup-type-filter .pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.type === type);
    });
    renderList();
  };

  function renderSessionOptions(selectedIds) {
    const sessions = Store.getSessions();
    if (!sessions.length) {
      document.getElementById('sv-sessions').innerHTML = '<div style="font-size:13px;color:var(--muted);font-family:var(--sans)">暂无会话记录</div>';
      return;
    }
    document.getElementById('sv-sessions').innerHTML = sessions
      .map((s) => {
        const client = Store.getClient(s.clientId);
        const name = client ? client.name : '?';
        const checked = selectedIds.includes(s.id) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-family:var(--sans);font-size:13px;cursor:pointer">
          <input type="checkbox" value="${s.id}" ${checked}> ${App.escapeHtml(name)} · 第${s.sessionNumber}节 (${App.formatDate(s.date, true)})
        </label>`;
      })
      .join('');
  }

  window.openSupModal = function (id) {
    const isEdit = !!id;
    document.getElementById('sup-modal-title').textContent = isEdit ? '编辑督导记录' : '新增督导记录';
    document.getElementById('sv-id').value = id || '';
    document.getElementById('sv-type').value = 'individual';
    document.getElementById('sv-supervisor').value = '';
    document.getElementById('sv-date').value = App.todayStr();
    document.getElementById('sv-content').value = '';
    document.getElementById('sv-conclusion').value = '';
    renderSessionOptions([]);
    if (isEdit) {
      const sv = Store.getSupervision(id);
      if (sv) {
        document.getElementById('sv-type').value = sv.type;
        document.getElementById('sv-supervisor').value = sv.supervisorName || '';
        document.getElementById('sv-date').value = sv.date || App.todayStr();
        document.getElementById('sv-content').value = sv.content || '';
        document.getElementById('sv-conclusion').value = sv.conclusion || '';
        renderSessionOptions(sv.sessionIds || []);
      }
    }
    App.openModal('sup-modal');
  };

  window.saveSupervision = function () {
    const id = document.getElementById('sv-id').value;
    const sessionIds = [...document.querySelectorAll('#sv-sessions input:checked')].map((c) => c.value);
    const data = {
      type: document.getElementById('sv-type').value,
      supervisorName: document.getElementById('sv-supervisor').value.trim(),
      date: document.getElementById('sv-date').value,
      sessionIds,
      content: document.getElementById('sv-content').value.trim(),
      conclusion: document.getElementById('sv-conclusion').value.trim(),
    };
    try {
      if (id) {
        Store.updateSupervision(id, data);
        App.showToast('已保存', 'success');
      } else {
        Store.createSupervision(data);
        App.showToast('已新增督导记录', 'success');
      }
    } catch (e) {
      App.showToast(e.message, 'error');
      return;
    }
    App.closeModal('sup-modal');
    renderList();
  };

  function renderList() {
    const container = document.getElementById('sup-list');
    let sups = Store.getSupervisions();
    if (currentType !== 'all') sups = sups.filter((s) => s.type === currentType);
    sups.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    if (!sups.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('cap')}</div><div class="text">暂无督导记录</div></div>`;
      return;
    }

    container.innerHTML = sups
      .map((sv) => {
        const typeLabel = sv.type === 'group' ? '团体督导' : '个体督导';
        const names = (sv.sessionIds || [])
          .map((sid) => {
            const s = Store.getSession(sid);
            if (!s) return '';
            const c = Store.getClient(s.clientId);
            return c ? `${c.name}·第${s.sessionNumber}节` : '';
          })
          .filter(Boolean)
          .join('、');
        const preview = (sv.content || '').slice(0, 60);
        return `<div class="list-card">
          <div class="row1">
            <span class="title">${App.escapeHtml(sv.supervisorName || '未填督导师')} · ${typeLabel}</span>
            <span class="meta">${App.formatDate(sv.date, true)}
              <span style="margin-left:8px;cursor:pointer;color:var(--accent)" onclick="openSupModal('${sv.id}')">编辑</span>
              <span style="margin-left:8px;cursor:pointer;color:var(--red)" onclick="deleteSup('${sv.id}')">删除</span>
            </span>
          </div>
          ${names ? `<div class="meta" style="margin-bottom:4px">关联：${App.escapeHtml(names)}</div>` : ''}
          <div class="desc">${App.escapeHtml(preview) || '（无内容）'}</div>
        </div>`;
      })
      .join('');
  }

  window.deleteSup = function (id) {
    App.confirmDialog('确定删除该督导记录？', () => {
      try {
        Store.deleteSupervision(id);
      } catch (e) {
        App.showToast(e.message, 'error');
        return;
      }
      App.showToast('已删除', 'success');
      renderList();
    }, true);
  };

    renderList();
  },
});
