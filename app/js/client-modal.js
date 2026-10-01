/* ============================================================
 * 心镜 XinJing — 来访者档案模态框（新建 / 编辑 / 删除）
 *
 * 功能（2026-09-29 档案模块增强）：
 *   - 新建来访者：原有 13 字段 + 收费标准 / 次结·月结 / 进行中·已结束
 *   - 编辑来访者档案：传入 existing 即进入编辑模式，预填全部字段
 *   - 费用变更记录：{ fee, startDate } 列表（按生效开始日期匹配账单计价）
 *   - 删除来访：仅编辑模式显示，二次确认后走 Store.deleteClient（级联清理会话/督导）
 *   - 保存后回调 onSaved(client)
 * ============================================================ */
'use strict';

const ClientModal = (() => {

  function esc(s) {
    if (typeof App !== 'undefined' && App.escapeHtml) return App.escapeHtml(String(s == null ? '' : s));
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function show(onSaved, existing) {
    const isEdit = !!(existing && existing.id);
    var overlay = document.createElement('div');
    overlay.className = 'xj-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
    var modal = document.createElement('div');
    modal.className = 'xj-modal';
    modal.style.cssText = 'background:var(--paper-2,#fff);border-radius:14px;padding:28px;max-width:560px;width:92%;box-shadow:0 16px 48px rgba(0,0,0,.18);max-height:90vh;overflow-y:auto';

    var cur = isEdit ? existing : {};
    var feeChanges = isEdit && Array.isArray(cur.feeChanges)
      ? cur.feeChanges.map(function (ch) { return { fee: Number(ch.fee) || 0, startDate: ch.startDate || '' }; })
      : [];

    modal.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">' +
        '<span style="font-size:22px">👤</span>' +
        '<h3 style="margin:0;font-family:var(--serif);font-size:20px;flex:1">' + (isEdit ? '编辑来访者档案' : '新建来访者') + '</h3>' +
        '<button id="cm-cancel-x" style="border:none;background:transparent;font-size:20px;cursor:pointer;color:var(--ink-3);padding:4px">×</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div style="grid-column:1/-1"><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">姓名 *</label>' +
        '<input id="cm-name" value="' + esc(cur.name || '') + '" placeholder="如：张三" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">化名</label>' +
        '<input id="cm-alias" value="' + esc(cur.alias || '') + '" placeholder="如：小白" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">性别</label>' +
        '<select id="cm-gender" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;background:var(--paper,#fff)">' +
        '<option value="unknown"' + ((cur.gender || 'unknown') === 'unknown' ? ' selected' : '') + '>未填</option>' +
        '<option value="male"' + (cur.gender === 'male' ? ' selected' : '') + '>男</option>' +
        '<option value="female"' + (cur.gender === 'female' ? ' selected' : '') + '>女</option>' +
        '<option value="other"' + (cur.gender === 'other' ? ' selected' : '') + '>其他</option></select></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">出生日期</label>' +
        '<input id="cm-birth" type="date" value="' + esc(cur.birthDate || '') + '" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">电话</label>' +
        '<input id="cm-phone" value="' + esc(cur.phone || '') + '" placeholder="如：138xxxx" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">邮箱</label>' +
        '<input id="cm-email" value="' + esc(cur.email || '') + '" placeholder="如：xxx@mail.com" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">首访日期</label>' +
        '<input id="cm-firstvisit" type="date" value="' + esc(cur.firstVisitDate || '') + '" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">标签（逗号分隔）</label>' +
        '<input id="cm-tags" value="' + esc(Array.isArray(cur.tags) ? cur.tags.join(',') : cur.tags || '') + '" placeholder="如：成人个体,焦虑" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        // —— 档案计费区（2026-09-29 新增）——
        '<div><label style="font:11px var(--sans);color:var(--accent);display:block;margin-bottom:3px">收费标准（¥/次）</label>' +
        '<input id="cm-fee" type="number" min="0" step="1" value="' + (Number(cur.fee) || 0) + '" placeholder="如：500" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">结算方式</label>' +
        '<select id="cm-billingmode" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;background:var(--paper,#fff)">' +
        '<option value="per-session"' + (cur.billingMode !== 'monthly' ? ' selected' : '') + '>次结</option>' +
        '<option value="monthly"' + (cur.billingMode === 'monthly' ? ' selected' : '') + '>月结</option></select></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">个案状态</label>' +
        '<select id="cm-status" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;background:var(--paper,#fff)">' +
        '<option value="active"' + (cur.status !== 'ended' ? ' selected' : '') + '>进行中</option>' +
        '<option value="ended"' + (cur.status === 'ended' ? ' selected' : '') + '>已结束</option></select></div>' +
        '<div style="grid-column:1/-1"><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">备注</label>' +
        '<textarea id="cm-notes" rows="2" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;resize:vertical">' + esc(cur.notes || '') + '</textarea></div>' +
        // —— 费用变更记录 ——
        '<div style="grid-column:1/-1;margin-top:2px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><label style="font:11px var(--sans);color:var(--ink-3);margin:0">费用变更记录（写收费后，账单中 0 元部分自动按生效费率补价）</label>' +
          '<button type="button" id="cm-fc-add" style="margin-left:auto;border:1px dashed var(--accent);border-radius:6px;padding:3px 10px;font:11px var(--sans);cursor:pointer;color:var(--accent);background:transparent">＋ 添加变更</button></div>' +
          '<div id="cm-fc-list" style="display:flex;flex-direction:column;gap:4px"></div>' +
          '<div id="cm-fc-new" style="display:none;gap:8px;align-items:center;margin-top:6px;border:1px solid var(--border);border-radius:8px;padding:8px 10px">' +
            '<input id="cm-fc-fee" type="number" min="0" step="1" placeholder="¥/次" style="border:1px solid var(--border);border-radius:6px;padding:6px 10px;font:12px var(--sans);width:90px">' +
            '<input id="cm-fc-date" type="date" style="border:1px solid var(--border);border-radius:6px;padding:6px 10px;font:12px var(--sans);flex:1">' +
            '<button type="button" id="cm-fc-ok" style="border:none;border-radius:6px;padding:6px 12px;font:12px var(--sans);cursor:pointer;background:var(--accent);color:#fff">添加</button>' +
            '<button type="button" id="cm-fc-cancel" style="border:1px solid var(--border);border-radius:6px;padding:6px 12px;font:12px var(--sans);cursor:pointer;background:transparent">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end;align-items:center">' +
        (isEdit ? '<button id="cm-delete" style="margin-right:auto;border:1px solid #d33;border-radius:8px;padding:9px 16px;font:13px var(--sans);cursor:pointer;color:#d33;background:transparent">🗑 删除来访</button>' : '') +
        '<button id="cm-cancel" style="border:1px solid var(--border);border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:transparent">取消</button>' +
        '<button id="cm-save" style="border:none;border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:var(--accent);color:#fff;font-weight:600">' + (isEdit ? '保存档案' : '保存') + '</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // —— 费用变更记录渲染 ——
    function renderFeeChanges() {
      var box = document.getElementById('cm-fc-list');
      if (!box) return;
      box.innerHTML = feeChanges.length ? feeChanges.map(function (ch, i) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--border);border-radius:8px;font:12px var(--sans)">' +
          '<span style="font-weight:600">¥' + esc(String(Number(ch.fee) || 0)) + '/次</span>' +
          '<span style="color:var(--ink-3)">自 ' + esc(ch.startDate || '（未指定日期）') + ' 起生效</span>' +
          '<button type="button" data-idx="' + i + '" style="margin-left:auto;border:none;background:transparent;cursor:pointer;color:#d33;font:12px var(--sans)">删除</button></div>';
      }).join('') : '<div style="font:12px var(--sans);color:var(--ink-3);padding:4px 2px">暂无费用变更 — 添加后，账单会自动按「开始日期」匹配对应费率补价。</div>';
      box.querySelectorAll('[data-idx]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-idx'));
          if (!isNaN(idx) && idx >= 0) feeChanges.splice(idx, 1);
          renderFeeChanges();
        });
      });
    }
    renderFeeChanges();

    var fcNew = document.getElementById('cm-fc-new');
    document.getElementById('cm-fc-add').addEventListener('click', function () {
      fcNew.style.display = 'flex';
      var d = document.getElementById('cm-fc-date');
      if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
      document.getElementById('cm-fc-fee').focus();
    });
    document.getElementById('cm-fc-cancel').addEventListener('click', function () { fcNew.style.display = 'none'; });
    function commitFeeChange() {
      var fee = Number(document.getElementById('cm-fc-fee').value) || 0;
      var startDate = (document.getElementById('cm-fc-date').value || '').trim();
      if (fee <= 0) { if (typeof App !== 'undefined' && App.showToast) App.showToast('请填写大于 0 的费率', 'warning'); return; }
      if (!startDate) { if (typeof App !== 'undefined' && App.showToast) App.showToast('请选择开始日期', 'warning'); return; }
      feeChanges.push({ fee: fee, startDate: startDate });
      fcNew.style.display = 'none';
      document.getElementById('cm-fc-fee').value = '';
      renderFeeChanges();
    }
    document.getElementById('cm-fc-ok').addEventListener('click', commitFeeChange);
    document.getElementById('cm-fc-fee').addEventListener('keydown', function (e) { if (e.key === 'Enter') commitFeeChange(); });

    // —— 关闭 / 取消 ——
    var previouslyFocused = document.activeElement;
    var overlayClosed = false;
    function closeOverlay() {
      if (overlayClosed) return;
      overlayClosed = true;
      document.removeEventListener('keydown', escapeListener, true);
      overlay.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus({ preventScroll: true }); } catch (e) { previouslyFocused.focus(); }
      }
    }
    function escapeListener(event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeOverlay();
    }
    document.addEventListener('keydown', escapeListener, true);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.id === 'cm-cancel-x') { closeOverlay(); }
    });
    document.getElementById('cm-cancel').addEventListener('click', function () { closeOverlay(); });

    // —— 删除来访（仅编辑模式）——
    if (isEdit) {
      document.getElementById('cm-delete').addEventListener('click', async function () {
        var yn = window.confirm('确定删除来访者「' + esc(cur.name || '') + '」吗？\n\n其全部会谈记录、督导关联与材料关联将一并删除，此操作不可撤销。');
        if (!yn) return;
        var result = null;
        if (typeof Store !== 'undefined' && Store.deleteClient) result = await Store.deleteClient(cur.id);
        if (!result || !result.ok) {
          if (typeof App !== 'undefined' && App.showToast) App.showToast('删除失败：' + ((result && result.error && result.error.message) || '请恢复存储后重试'), 'error');
          return;
        }
        closeOverlay();
        if (typeof Memory !== 'undefined' && Memory.record) Memory.record('client_deleted', { summary: '删除来访者「' + cur.name + '」', relatedClientId: cur.id });
        if (typeof App !== 'undefined' && App.showToast) App.showToast('已删除来访者「' + cur.name + '」', 'success');
        if (typeof onSaved === 'function') onSaved(null, true);
      });
    }

    // —— 保存 ——
    document.getElementById('cm-save').addEventListener('click', async function () {
      var name = (document.getElementById('cm-name').value || '').trim();
      if (!name) { if (typeof App !== 'undefined' && App.showToast) App.showToast('请填写姓名', 'warning'); return; }
      var tagsRaw = (document.getElementById('cm-tags').value || '').trim();
      var tags = tagsRaw ? tagsRaw.split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
      var fee = Number(document.getElementById('cm-fee').value) || 0;
      var billingMode = document.getElementById('cm-billingmode').value === 'monthly' ? 'monthly' : 'per-session';
      var status = document.getElementById('cm-status').value === 'ended' ? 'ended' : 'active';
      var client = {
        name: name,
        alias: (document.getElementById('cm-alias').value || '').trim(),
        gender: document.getElementById('cm-gender').value || 'unknown',
        birthDate: (document.getElementById('cm-birth').value || '').trim(),
        phone: (document.getElementById('cm-phone').value || '').trim(),
        email: (document.getElementById('cm-email').value || '').trim(),
        firstVisitDate: (document.getElementById('cm-firstvisit').value || '').trim(),
        status: status,
        fee: fee,
        billingMode: billingMode,
        feeChanges: feeChanges,
        tags: tags,
        notes: (document.getElementById('cm-notes').value || '').trim(),
      };
      var result = null;
      if (isEdit && typeof Store !== 'undefined' && Store.updateClientDurable) {
        result = await Store.updateClientDurable(cur.id, client);
      } else if (typeof Store !== 'undefined' && Store.createClientDurable) {
        result = await Store.createClientDurable(client);
      }
      if (!result || !result.ok) {
        if (typeof App !== 'undefined' && App.showToast) App.showToast('保存失败：来访者草稿已保留，请恢复存储后重试', 'error');
        return;
      }
      var saved = result.value;
            closeOverlay();
            // 2026-10-01：档案保存成功后，立即按新收费把该来访者已有 0 元账单自动补价
            //（persist 写回 + toast 反馈 + 广播事件让账单视图在写完后刷新）
            try {
              var _archId = (saved && saved.id) || cur.id;
              var _archCl = (typeof Store !== 'undefined' && Store.getClient) ? Store.getClient(_archId) : null;
              if (_archCl && typeof Store.fillZeroFeesDurable === 'function') {
                var _archSc = (typeof Store.getSessionsByClient === 'function') ? Store.getSessionsByClient(_archId).slice() : [];
                Store.fillZeroFeesDurable(_archSc, _archCl).then(function (fillRes) {
                  if (fillRes && fillRes.ok && fillRes.written > 0 && typeof App !== 'undefined' && App.showToast) {
                    App.showToast('已按新收费标准自动补价 ' + fillRes.written + ' 笔 0 元费用', 'success');
                  }
                  try {
                    window.dispatchEvent(new CustomEvent('xinjing:client-saved', { detail: { clientId: _archId, written: (fillRes && fillRes.written) || 0 } }));
                  } catch (e2) {}
                }).catch(function () {});
              } else {
                try {
                  window.dispatchEvent(new CustomEvent('xinjing:client-saved', { detail: { clientId: _archId, written: 0 } }));
                } catch (e2) {}
              }
            } catch (e1) {}
            if (typeof onSaved === 'function') onSaved(saved || client);
      if (typeof App !== 'undefined' && App.showToast) App.showToast((isEdit ? '已保存「' : '已新增来访者「') + name + '」', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record(isEdit ? 'client_updated' : 'client_created', { summary: (isEdit ? '更新来访者档案「' : '新建来访者「') + name + '」', relatedClientId: (saved || client).id });
    });
    setTimeout(function () { document.getElementById('cm-name').focus(); }, 100);
  }

  function injectIntoDropdown(selectEl, onSaved) {
    if (!selectEl) return;
    var opt = document.createElement('option');
    opt.value = '__new__';
    opt.textContent = '＋ 新建来访';
    opt.style.color = 'var(--accent)';
    opt.style.fontWeight = '600';
    selectEl.appendChild(opt);
    selectEl.addEventListener('change', function () {
      if (this.value === '__new__') {
        this.value = this.options[0] ? this.options[0].value : '';
        show(function (client) {
          var o = document.createElement('option');
          o.value = client.id;
          o.textContent = client.name;
          selectEl.appendChild(o);
          selectEl.value = client.id;
          if (typeof onSaved === 'function') onSaved(client);
        });
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.ClientModal = { show: show, injectIntoDropdown: injectIntoDropdown };
  }
  return { show: show, injectIntoDropdown: injectIntoDropdown };
})();