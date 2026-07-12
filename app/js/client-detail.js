/* ============================================================
   心镜 XinJing — 来访者详情逻辑
   ============================================================ */

const params = new URLSearchParams(location.search);
const clientId = params.get('id');

App.initPage({
  onReady: function () {
    'use strict';

    if (!clientId) {
      location.href = 'clients.html';
      return;
    }

    const client = Store.getClient(clientId);
    if (!client) {
      location.href = 'clients.html';
      return;
    }

    App.injectLayout(
      client.name,
      `首访 ${client.firstVisitDate ? App.formatDate(client.firstVisitDate, true) : '未记录'} · ${App.statusLabel(client.status)}`,
      `<button class="btn btn-ghost btn-sm" onclick="location.href='index.html'">← 工作台</button>
<button class="btn btn-primary" onclick="newSession()">新增会话<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`
    );
    App.bindModalClose('confirm-modal');
    App.bindModalClose('edit-modal');

  // ---------- 基本信息 ----------
  function renderBasic() {
    document.getElementById('detail-avatar').textContent = App.avatarText(client.name);
    document.getElementById('detail-name').textContent = client.name;
    const subParts = [];
    if (client.gender && client.gender !== 'unknown') subParts.push(App.genderLabel(client.gender));
    if (client.birthDate) subParts.push('生于 ' + App.formatDate(client.birthDate, true));
    if (client.phone) subParts.push('☎ ' + client.phone);
    document.getElementById('detail-sub').innerHTML = subParts.join(' · ');
    document.getElementById('detail-tags').innerHTML = App.renderTags(client.tags);
    document.getElementById('detail-notes').textContent = client.notes || '（暂无备注）';
  }

  // ---------- 会话列表 ----------
  async function renderSessions() {
    const container = document.getElementById('session-list');
    const sessions = Store.getSessionsByClient(clientId);
    document.getElementById('session-count').textContent = sessions.length ? `共 ${sessions.length} 节` : '';

    if (!sessions.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('chat')}</div><div class="text">还没有会话记录，点击下方按钮新增</div></div>`;
      return;
    }

    container.innerHTML = sessions
      .map((s) => `
        <div class="list-card" onclick="location.href='session.html?id=${s.id}'">
          <div class="row1">
            <span class="title">第 ${s.sessionNumber} 节</span>
            <span class="meta">${App.formatDate(s.date, true)} ${s.startTime ? '· ' + s.startTime : ''}</span>
          </div>
          <div class="desc">${App.renderReportTags(s)}</div>
        </div>`)
      .join('');
  }

  // ---------- 督导列表 ----------
  function renderSupervisions() {
    const container = document.getElementById('supervision-list');
    const sessionIds = Store.getSessionsByClient(clientId).map((s) => s.id);
    const sups = Store.getSupervisions().filter((sv) => (sv.sessionIds || []).some((sid) => sessionIds.includes(sid)));
    document.getElementById('sup-count').textContent = sups.length ? `共 ${sups.length} 条` : '';

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
            return s ? '第' + s.sessionNumber + '节' : '';
          })
          .filter(Boolean)
          .join('、');
        return `<div class="list-card" onclick="location.href='supervision.html'">
          <div class="row1">
            <span class="title">${sv.supervisorName || '未填督导师'} · ${typeLabel}</span>
            <span class="meta">${App.formatDate(sv.date, true)}</span>
          </div>
          <div class="desc">关联：${names || '无'}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- 操作 ----------
  // 新增会话：先让用户自定义「第X节」序号（默认 = 当前最大节数+1）
  window.newSession = function () {
    const input = document.getElementById('new-session-number');
    if (input) {
      const next = (typeof Store.nextSessionNumber === 'function') ? Store.nextSessionNumber(clientId) : 1;
      input.value = next;
    }
    App.openModal('session-number-modal');
    setTimeout(() => { if (input) input.focus(); }, 50);
  };

  window.createSessionWithNumber = async function () {
    const input = document.getElementById('new-session-number');
    let num = 1;
    if (input && input.value) {
      num = parseInt(input.value, 10);
      if (!Number.isFinite(num) || num < 1) {
        App.showToast('节数必须为正整数', 'error');
        return;
      }
    }
    try {
      const session = await Store.createSession({ clientId, sessionNumber: num });
      App.closeModal('session-number-modal');
      location.href = 'session.html?id=' + session.id;
    } catch (e) {
      // createSession 在受限模式下可能对只读(溢出)来访者抛错（S9 守卫），需提示而非静默失败
      App.showToast(e && e.message ? e.message : '新建节次失败', 'error');
    }
  };

  window.openEditFromDetail = function () {
    document.getElementById('e-id').value = clientId;
    document.getElementById('e-name').value = client.name || '';
    document.getElementById('e-gender').value = client.gender || 'unknown';
    document.getElementById('e-birth').value = client.birthDate || '';
    document.getElementById('e-phone').value = client.phone || '';
    document.getElementById('e-firstvisit').value = client.firstVisitDate || '';
    document.getElementById('e-status').value = client.status || 'active';
    document.getElementById('e-tags').value = (client.tags || []).join(', ');
    document.getElementById('e-notes').value = client.notes || '';
    App.openModal('edit-modal');
  };

  window.saveEditFromDetail = function () {
    const tagsInput = document.getElementById('e-tags').value.trim();
    const tags = tagsInput ? tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];
    Store.updateClient(clientId, {
      name: document.getElementById('e-name').value.trim(),
      gender: document.getElementById('e-gender').value,
      birthDate: document.getElementById('e-birth').value,
      phone: document.getElementById('e-phone').value.trim(),
      firstVisitDate: document.getElementById('e-firstvisit').value,
      status: document.getElementById('e-status').value,
      tags,
      notes: document.getElementById('e-notes').value.trim(),
    });
    App.closeModal('edit-modal');
    App.showToast('已保存', 'success');
    location.reload();
  };

  window.deleteFromDetail = function () {
    App.confirmDialog('确定删除该来访者及其所有数据？不可撤销。', () => {
      Store.deleteClient(clientId);
      App.closeModal('edit-modal');
      App.showToast('已删除', 'success');
      setTimeout(() => { location.href = 'clients.html'; }, 500);
    }, true);
  };

    // ---------- 初始渲染 ----------
    renderBasic();
    renderSessions();
    renderSupervisions();
  },
});
