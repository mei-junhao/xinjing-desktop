/* ============================================================
   心镜 XinJing — 来访者列表逻辑
   ============================================================ */

App.initPage({
  title: '来访者',
  subtitle: '点击卡片查看详情，或新建来访者',
  actions: `<button class="btn btn-primary" onclick="App.openModal('client-modal')">新建来访者<span class="trail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></button>`,
  onReady: function () {
    'use strict';

    let currentStatus = 'all';
  let currentEditId = null;

  // 新建来访者模态框（复用 dashboard 的 HTML 结构，此处独立注入）
  injectNewClientModal();

  function injectNewClientModal() {
    if (document.getElementById('client-modal')) return;
    const div = document.createElement('div');
    div.className = 'modal-overlay';
    div.id = 'client-modal';
    div.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>新建来访者</h2>
          <button class="close" onclick="App.closeModal('client-modal')">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">姓名 / 化名 <span style="color:var(--red)">*</span></label>
            <input class="form-control" id="c-name" placeholder="如：小A / 阿拉伯">
          </div>
          <div class="form-row two">
            <div>
              <label class="form-label">性别</label>
              <select class="form-control" id="c-gender">
                <option value="unknown">未填</option>
                <option value="female">女</option>
                <option value="male">男</option>
                <option value="other">其他</option>
              </select>
            </div>
            <div>
              <label class="form-label">出生日期</label>
              <input class="form-control" id="c-birth" type="date">
            </div>
          </div>
          <div class="form-row two">
            <div>
              <label class="form-label">联系电话</label>
              <input class="form-control" id="c-phone" placeholder="选填">
            </div>
            <div>
              <label class="form-label">首访日期</label>
              <input class="form-control" id="c-firstvisit" type="date">
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">标签（逗号分隔）</label>
            <input class="form-control" id="c-tags" placeholder="如：成人个体, 焦虑">
          </div>
          <div class="form-row">
            <label class="form-label">备注</label>
            <textarea class="form-control" id="c-notes" placeholder="背景信息摘要、转介来源等"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="App.closeModal('client-modal')">取消</button>
          <button class="btn btn-primary" onclick="saveNewClient()">保存</button>
        </div>
      </div>`;
    document.body.appendChild(div);
    App.bindModalClose('client-modal');
    document.getElementById('c-firstvisit').value = App.todayStr();
  }

  window.saveNewClient = function () {
    const name = document.getElementById('c-name').value.trim();
    if (!name) {
      App.showToast('请填写姓名或化名', 'error');
      return;
    }
    const tagsInput = document.getElementById('c-tags').value.trim();
    const tags = tagsInput ? tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];
    let client;
    try {
      client = Store.createClient({
        name,
        gender: document.getElementById('c-gender').value,
        birthDate: document.getElementById('c-birth').value,
        phone: document.getElementById('c-phone').value.trim(),
        firstVisitDate: document.getElementById('c-firstvisit').value,
        tags,
        notes: document.getElementById('c-notes').value.trim(),
      });
    } catch (e) {
      App.showToast(e.message, 'error');
      return;
    }
    App.closeModal('client-modal');
    App.showToast('已创建来访者：' + name, 'success');
    document.getElementById('c-name').value = '';
    document.getElementById('c-birth').value = '';
    document.getElementById('c-phone').value = '';
    document.getElementById('c-tags').value = '';
    document.getElementById('c-notes').value = '';
    setTimeout(() => { location.href = 'client-detail.html?id=' + client.id; }, 500);
  };

  window.setStatusFilter = function (status) {
    currentStatus = status;
    document.querySelectorAll('#status-filter .pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.status === status);
    });
    renderClients();
  };

  function getLastSessionDate(clientId) {
    const sessions = Store.getSessionsByClient(clientId);
    if (!sessions.length) return '';
    const dates = sessions.map((s) => s.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : '';
  }

  window.renderClients = function () {
    const container = document.getElementById('client-list');
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    let clients = Store.getClients();

    if (currentStatus !== 'all') {
      clients = clients.filter((c) => c.status === currentStatus);
    }
    if (query) {
      clients = clients.filter((c) => {
        const hay = [c.name, (c.tags || []).join(' '), c.notes, c.alias].join(' ').toLowerCase();
        return hay.includes(query);
      });
    }

    clients.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    if (!clients.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">${App.svgIcon('clients')}</div><div class="text">没有匹配的来访者</div></div>`;
      return;
    }

    container.innerHTML = clients
      .map((c) => {
        const sessionCount = Store.getSessionsByClient(c.id).length;
        const firstVisit = c.firstVisitDate ? App.formatDate(c.firstVisitDate, true) : '未记录';
        return `<div class="ccard" onclick="location.href='client-detail.html?id=${c.id}'">
          <div class="row1">
            <span class="dot ${c.status}"></span>
            <span class="nm">${App.escapeHtml(c.name)}</span>
          </div>
          <div class="meta">
            <span>${App.statusLabel(c.status)}</span>
            <span>${sessionCount} 节</span>
            <span>首访 ${firstVisit}</span>
          </div>
        </div>`;
      })
      .join('');
  };

  // 编辑
  window.openEditClient = function (id, event) {
    event.stopPropagation();
    const client = Store.getClient(id);
    if (!client) return;
    currentEditId = id;
    document.getElementById('e-id').value = id;
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

  window.saveEditClient = function () {
    if (!currentEditId) return;
    const tagsInput = document.getElementById('e-tags').value.trim();
    const tags = tagsInput ? tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];
    try {
      Store.updateClient(currentEditId, {
        name: document.getElementById('e-name').value.trim(),
        gender: document.getElementById('e-gender').value,
        birthDate: document.getElementById('e-birth').value,
        phone: document.getElementById('e-phone').value.trim(),
        firstVisitDate: document.getElementById('e-firstvisit').value,
        status: document.getElementById('e-status').value,
        tags,
        notes: document.getElementById('e-notes').value.trim(),
      });
    } catch (e) {
      App.showToast(e.message, 'error');
      return;
    }
    App.closeModal('edit-modal');
    App.showToast('已保存修改', 'success');
    renderClients();
  };

  window.deleteCurrentClient = function () {
    App.confirmDialog('确定删除该来访者及其所有会话、督导记录？此操作不可撤销。', () => {
      try {
        Store.deleteClient(currentEditId);
      } catch (e) {
        App.showToast(e.message, 'error');
        return;
      }
      App.closeModal('edit-modal');
      App.showToast('已删除', 'success');
      renderClients();
    }, true);
  };

  renderClients();
  },
});
