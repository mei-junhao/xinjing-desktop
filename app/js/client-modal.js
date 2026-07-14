/* ============================================================
 * 心镜 XinJing — 新建来访者模态框（v3.4.2 完整字段版）
 *
 * 修复 v3.4.0 的 4 个 bug（见心镜-新建来访者字段结构与已知Bug.md）：
 *   Bug1: note → notes（字段名对齐 store schema）
 *   Bug2: 补齐 gender/birthDate/firstVisitDate/tags/alias
 *   Bug3: 双入口字段对齐（与 store schema 13 字段一致）
 *   Bug4: 去掉自造 id，走 Store.createClient 自动 genId
 *
 * 所有页面复用此模态框（首页、下拉新建、各页面按钮）
 * ============================================================ */
'use strict';

const ClientModal = (() => {

  function show(onSaved) {
    var overlay = document.createElement('div');
    overlay.className = 'xj-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center';
    var modal = document.createElement('div');
    modal.className = 'xj-modal';
    modal.style.cssText = 'background:var(--paper-2,#fff);border-radius:14px;padding:28px;max-width:520px;width:92%;box-shadow:0 16px 48px rgba(0,0,0,.18);max-height:90vh;overflow-y:auto';
    modal.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">' +
        '<span style="font-size:22px">👤</span>' +
        '<h3 style="margin:0;font-family:var(--serif);font-size:20px;flex:1">新建来访者</h3>' +
        '<button id="cm-cancel-x" style="border:none;background:transparent;font-size:20px;cursor:pointer;color:var(--ink-3);padding:4px">×</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div style="grid-column:1/-1"><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">姓名 *</label>' +
        '<input id="cm-name" placeholder="如：张三" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">化名</label>' +
        '<input id="cm-alias" placeholder="如：小白" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">性别</label>' +
        '<select id="cm-gender" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;background:var(--paper,#fff)">' +
        '<option value="unknown">未填</option><option value="male">男</option><option value="female">女</option><option value="other">其他</option></select></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">出生日期</label>' +
        '<input id="cm-birth" type="date" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">电话</label>' +
        '<input id="cm-phone" placeholder="如：138xxxx" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">邮箱</label>' +
        '<input id="cm-email" placeholder="如：xxx@mail.com" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">首访日期</label>' +
        '<input id="cm-firstvisit" type="date" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">标签（逗号分隔）</label>' +
        '<input id="cm-tags" placeholder="如：成人个体,焦虑" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%"></div>' +
        '<div style="grid-column:1/-1"><label style="font:11px var(--sans);color:var(--ink-3);display:block;margin-bottom:3px">备注</label>' +
        '<textarea id="cm-notes" placeholder="初步评估、主诉概述等" rows="2" style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font:13px var(--sans);width:100%;resize:vertical"></textarea></div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-top:20px;justify-content:flex-end">' +
        '<button id="cm-cancel" style="border:1px solid var(--border);border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:transparent">取消</button>' +
        '<button id="cm-save" style="border:none;border-radius:8px;padding:9px 20px;font:13px var(--sans);cursor:pointer;background:var(--accent);color:#fff;font-weight:600">保存</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 默认首访日期为今天
    var today = new Date().toISOString().slice(0, 10);
    var fv = document.getElementById('cm-firstvisit');
    if (fv) fv.value = today;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.id === 'cm-cancel-x') { overlay.remove(); }
    });
    document.getElementById('cm-cancel').addEventListener('click', function () { overlay.remove(); });
    document.getElementById('cm-save').addEventListener('click', function () {
      var name = (document.getElementById('cm-name').value || '').trim();
      if (!name) { if (typeof App !== 'undefined' && App.showToast) App.showToast('请填写姓名', 'warning'); return; }
      var tagsRaw = (document.getElementById('cm-tags').value || '').trim();
      var tags = tagsRaw ? tagsRaw.split(/[,，]/).map(function (t) { return t.trim(); }).filter(Boolean) : [];
      // 不自造 id，让 Store.createClient 自动生成
      var client = {
        name: name,
        alias: (document.getElementById('cm-alias').value || '').trim(),
        gender: document.getElementById('cm-gender').value || 'unknown',
        birthDate: (document.getElementById('cm-birth').value || '').trim(),
        phone: (document.getElementById('cm-phone').value || '').trim(),
        email: (document.getElementById('cm-email').value || '').trim(),
        firstVisitDate: (document.getElementById('cm-firstvisit').value || '').trim(),
        status: 'active',
        tags: tags,
        notes: (document.getElementById('cm-notes').value || '').trim(), // 修复：notes 复数
      };
      var saved = null;
      if (typeof Store !== 'undefined') saved = Store.createClient(client);
      overlay.remove();
      if (typeof onSaved === 'function') onSaved(saved || client);
      if (typeof App !== 'undefined' && App.showToast) App.showToast('已新增来访者「' + name + '」', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('client_created', { summary: '新建来访者「' + name + '」', relatedClientId: (saved || client).id });
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
