/* ============================================================
   心镜 XinJing — 设置页逻辑
   ============================================================ */

App.initPage({
  title: '设置',
  subtitle: 'AI 接口与数据管理',
  actions: '',
  onReady: function () {
    'use strict';

    function loadConfig() {
    const settings = Store.getSettings();
    const api = settings.apiConfig || {};
    document.getElementById('api-baseurl').value = api.baseUrl || '';
    document.getElementById('api-key').value = api.apiKey || '';
    document.getElementById('api-model').value = api.modelPreference || 'deepseek-pro';
  }

  window.saveApiConfig = function () {
    Store.saveSettings({
      apiConfig: {
        baseUrl: document.getElementById('api-baseurl').value.trim(),
        apiKey: document.getElementById('api-key').value.trim(),
        modelPreference: document.getElementById('api-model').value,
        maxTokens: 4000,
      },
    });
    App.showToast('已保存 API 配置', 'success');
  };

  window.testApi = async function () {
    const config = Store.getSettings().apiConfig || {};
    if (!config.baseUrl || !config.apiKey) {
      App.showToast('请先填写端点和密钥', 'error');
      return;
    }
    App.showToast('正在测试连接...');
    try {
      const resp = await fetch(config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + config.apiKey,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 10,
        }),
      });
      if (resp.ok) {
        App.showToast('连接成功 ✓', 'success');
      } else {
        App.showToast('连接失败：HTTP ' + resp.status, 'error');
      }
    } catch (e) {
      App.showToast('连接错误：' + e.message, 'error');
    }
  };

  function calcStorage() {
    const info = Store.storageInfo();
    const text = `后端：${info.backend} · 约 ${info.approxDataSizeMB} MB · 来访者 ${info.clientCount} / 会话 ${info.sessionCount} / 督导 ${info.supervisionCount}`;
    document.getElementById('storage-text').textContent = text;
    const bar = document.getElementById('storage-bar');
    if (bar) bar.style.width = Math.min(100, (info.approxDataSizeMB / 1024) * 100) + '%';
  }

  window.backupData = async function () {
    const json = await Store.exportAll();
    const dateStr = App.formatDate(new Date(), true).replace(/-/g, '');
    App.downloadFile(`心镜备份_${dateStr}.json`, json, 'application/json');
    Store.saveSettings({ backupLastTime: new Date().toISOString() });
    App.showToast('备份已下载', 'success');
    updateBackupTime();
  };

  window.restoreData = async function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      await Store.importAll(text);
      App.showToast('数据已恢复', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      App.showToast('恢复失败：文件格式错误', 'error');
    }
  };

  window.clearAllData = function () {
    App.confirmDialog('确定清除所有数据？此操作不可撤销。建议先备份。', () => {
      // 新架构：删除 IndexedDB 主库，并清理可能的降级 localStorage 键
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('xj2_')) localStorage.removeItem(k);
      });
      const db = indexedDB.deleteDatabase('xinjing_db');
      db.onsuccess = () => {
        App.showToast('已清除全部数据', 'success');
        setTimeout(() => location.reload(), 600);
      };
      db.onerror = () => {
        App.showToast('清除失败，请手动清理浏览器站点数据', 'error');
      };
    }, true);
  };

  function updateBackupTime() {
    const t = Store.getSettings().backupLastTime;
    document.getElementById('backup-time').textContent = t ? '上次备份：' + new Date(t).toLocaleString('zh-CN') : '尚未备份';
  }

  // ---------- 备份设置（多位置容灾 + 邮件提醒） ----------
  function getBackupConfig() {
    const s = Store.getSettings().backup;
    return s && typeof s === 'object'
      ? { locations: s.locations || [], email: s.email || '', emailEnabled: !!s.emailEnabled }
      : { locations: [], email: '', emailEnabled: false };
  }
  function renderBackupLocations() {
    const cfg = getBackupConfig();
    const box = document.getElementById('backup-locations');
    if (!box) return;
    if (!cfg.locations.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--sans)">尚未添加自定义备份位置（默认仍备份到 文档\\心镜备份）</div>';
      return;
    }
    box.innerHTML = cfg.locations.map((loc, i) =>
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--accent-soft);border-radius:var(--radius-sm);padding:8px 10px">' +
        '<span style="font-size:12px;color:var(--text);font-family:var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + App.escapeHtml(loc) + '</span>' +
        '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="removeBackupLocation(' + i + ')">移除</button>' +
      '</div>'
    ).join('');
  }
  window.loadBackupConfigUI = function () {
    const cfg = getBackupConfig();
    renderBackupLocations();
    const emailEl = document.getElementById('backup-email');
    const onEl = document.getElementById('backup-email-on');
    if (emailEl) emailEl.value = cfg.email || '';
    if (onEl) onEl.checked = !!cfg.emailEnabled;
  };
  window.addBackupLocation = async function () {
    if (!window.__XJ_API__ || typeof window.__XJ_API__.selectBackupFolder !== 'function') {
      App.showToast('备份文件夹选择不可用', 'error'); return;
    }
    const folder = await window.__XJ_API__.selectBackupFolder();
    if (!folder) return;
    const cfg = getBackupConfig();
    if (cfg.locations.indexOf(folder) === -1) cfg.locations.push(folder);
    Store.saveSettings({ backup: cfg });
    renderBackupLocations();
    App.showToast('已添加备份位置', 'success');
  };
  window.removeBackupLocation = function (i) {
    const cfg = getBackupConfig();
    cfg.locations.splice(i, 1);
    Store.saveSettings({ backup: cfg });
    renderBackupLocations();
  };
  window.saveBackupSettings = async function () {
    const cfg = getBackupConfig();
    const emailEl = document.getElementById('backup-email');
    const onEl = document.getElementById('backup-email-on');
    cfg.email = (emailEl && emailEl.value || '').trim();
    cfg.emailEnabled = !!(onEl && onEl.checked);
    Store.saveSettings({ backup: cfg });
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.saveBackupConfig === 'function') {
        await window.__XJ_API__.saveBackupConfig(cfg);
      }
    } catch (e) { /* ignore */ }
    const msg = document.getElementById('backup-settings-msg');
    if (msg) msg.textContent = '已保存 ✓';
    App.showToast('备份设置已保存', 'success');
  };

  // ---------- 督导师（AI 督导）管理 ----------
  let editingSupId = null;
  function loadSupervisorUI() {
    const unlocked = typeof Store.aiUnlocked === 'function' ? Store.aiUnlocked() : true;
    const lockNote = document.getElementById('supervisor-lock-note');
    const listEl = document.getElementById('supervisor-list');
    const addBtn = document.getElementById('add-supervisor-btn');
    const formEl = document.getElementById('supervisor-form');
    if (!unlocked) {
      if (lockNote) lockNote.classList.remove('hidden');
      if (listEl) listEl.innerHTML = '';
      if (addBtn) addBtn.classList.add('hidden');
      if (formEl) formEl.classList.add('hidden');
      return;
    }
    if (lockNote) lockNote.classList.add('hidden');
    if (addBtn) addBtn.classList.remove('hidden');
    renderSupervisorList();
  }
  function renderSupervisorList() {
    const listEl = document.getElementById('supervisor-list');
    if (!listEl) return;
    const list = (typeof Store.getSupervisorIdentities === 'function') ? Store.getSupervisorIdentities() : [];
    if (!list.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);font-family:var(--sans)">还没有自定义督导师，可点击下方按钮添加。</div>';
      return;
    }
    listEl.innerHTML = list.map((s) => {
      const builtin = !!s.builtin;
      const actions = builtin
        ? '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="viewSupervisor(\'' + s.id + '\')">查看</button>'
        : '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="showSupervisorForm(\'' + s.id + '\')">编辑</button>' +
          '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="deleteSupervisor(\'' + s.id + '\')">删除</button>';
      const tag = builtin ? '<span style="font-size:11px;color:var(--accent);font-family:var(--sans);background:var(--accent-soft);border-radius:4px;padding:1px 6px;margin-left:6px">内置</span>' : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--accent-soft);border-radius:var(--radius-sm);padding:8px 10px">' +
        '<span style="font-size:13px;color:var(--text);font-family:var(--sans)">' + App.escapeHtml(s.name) + tag + '</span>' +
        '<div style="display:flex;gap:6px">' + actions + '</div>' +
      '</div>';
    }).join('');
  }
  window.showSupervisorForm = function (id) {
    const formEl = document.getElementById('supervisor-form');
    const nameEl = document.getElementById('sup-name');
    const promptEl = document.getElementById('sup-prompt');
    if (formEl) formEl.classList.remove('hidden');
    editingSupId = id || null;
    if (id) {
      const s = (typeof Store.getSupervisorIdentity === 'function') ? Store.getSupervisorIdentity(id) : null;
      if (s) { nameEl.value = s.name; promptEl.value = s.prompt || ''; }
    } else {
      nameEl.value = '';
      promptEl.value = '';
    }
    if (nameEl) nameEl.focus();
  };
  window.hideSupervisorForm = function () {
    const formEl = document.getElementById('supervisor-form');
    if (formEl) formEl.classList.add('hidden');
    editingSupId = null;
  };
  window.viewSupervisor = function (id) {
    const s = (typeof Store.getSupervisorIdentity === 'function') ? Store.getSupervisorIdentity(id) : null;
    if (!s) return;
    const nameEl = document.getElementById('sup-name');
    const promptEl = document.getElementById('sup-prompt');
    const fileEl = document.getElementById('sup-prompt-file');
    if (nameEl) { nameEl.value = s.name; nameEl.readOnly = true; }
    if (promptEl) {
      // 内置督导师：不灌入方法论 prompt（保护 IP），显示占位文案
      if (s.builtin) {
        promptEl.value = '';
        promptEl.placeholder = '内置方法论受保护，不可查看';
      } else {
        promptEl.value = s.prompt || '';
      }
      promptEl.readOnly = true;
    }
    if (fileEl) fileEl.disabled = true;
    const formEl = document.getElementById('supervisor-form');
    if (formEl) formEl.classList.remove('hidden');
    const saveBtn = document.querySelector('#supervisor-form .btn-primary');
    if (saveBtn) { saveBtn.textContent = '关闭'; saveBtn.onclick = function () { window.hideSupervisorForm(); }; }
  };
  window.loadSupPromptFile = function () {
    const fileEl = document.getElementById('sup-prompt-file');
    const promptEl = document.getElementById('sup-prompt');
    if (!fileEl || !fileEl.files || !fileEl.files[0]) {
      App.showToast('请先选择文件', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      if (promptEl) promptEl.value = e.target.result;
      App.showToast('已读取提示词文件', 'success');
    };
    reader.onerror = function () { App.showToast('读取文件失败', 'error'); };
    reader.readAsText(fileEl.files[0], 'utf-8');
  };
  window.saveSupervisor = function () {
    const nameEl = document.getElementById('sup-name');
    const promptEl = document.getElementById('sup-prompt');
    const name = (nameEl && nameEl.value || '').trim();
    const prompt = (promptEl && promptEl.value || '').trim();
    if (promptEl && promptEl.readOnly) { window.hideSupervisorForm(); return; } // 查看态：仅关闭
    if (!name) { App.showToast('请填写督导师名称', 'error'); return; }
    if (!prompt) { App.showToast('请填写方法论提示词（或上传 .txt/.md）', 'error'); return; }
    try {
      if (editingSupId) {
        Store.updateSupervisorIdentity({ id: editingSupId, name: name, prompt: prompt });
      } else {
        Store.createSupervisorIdentity({ name: name, prompt: prompt, builtin: false });
      }
    } catch (e) {
      App.showToast('保存失败：' + (e.message || e), 'error');
      return;
    }
    App.showToast('已保存督导师', 'success');
    window.hideSupervisorForm();
    renderSupervisorList();
  };
  window.deleteSupervisor = function (id) {
    App.confirmDialog('确定删除该督导师身份？此操作不可撤销。', function () {
      try { Store.deleteSupervisorIdentity(id); } catch (e) { App.showToast('删除失败：' + (e.message || e), 'error'); return; }
      App.showToast('已删除', 'success');
      renderSupervisorList();
    });
  };

  // 外观：深色模式切换（偏好存于 localStorage，app.js 启动时统一应用）
  function isThemeDark() {
    return localStorage.getItem('xj_theme') === 'dark';
  }
  window.toggleTheme = function () {
    const next = !isThemeDark();
    try { localStorage.setItem('xj_theme', next ? 'dark' : 'light'); } catch (e) {}
    document.documentElement.classList.toggle('dark', next);
    const sw = document.getElementById('theme-toggle');
    if (sw) sw.setAttribute('aria-checked', String(next));
    App.showToast(next ? '已切换到深色' : '已切换到浅色', 'success');
  };
  function initThemeToggle() {
    const sw = document.getElementById('theme-toggle');
    if (sw) sw.setAttribute('aria-checked', String(isThemeDark()));
  }

  function fmtDate(ms) {
    if (!ms) return '终身';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 授权信息卡片：已激活用户展示档位与有效期；未激活给提示 + 本地激活入口（preload 注入按钮）+ 云激活在线校验入口
  async function renderLicenseInfo() {
    const card = document.getElementById('license-info-card');
    if (!card) return;
    let state = {};
    try { state = (await window.__XJ_API__.getState()) || {}; } catch (e) { state = {}; }
    if (!state || state.mode !== 'full' || !state.identity) {
      card.innerHTML =
        '<div style="font-family:var(--sans);font-weight:600;color:var(--text);margin-bottom:8px">未激活</div>' +
        '<div style="font-size:13px;color:var(--muted);font-family:var(--sans);line-height:1.6;margin-bottom:12px">完整功能（含 AI 督导）需输入激活码解锁。两种激活方式等效，任选其一。</div>' +
        '<div style="border-top:1px dashed var(--border);padding-top:12px;margin-bottom:12px">' +
          '<div style="font-size:13px;font-family:var(--sans);font-weight:600;color:var(--text);margin-bottom:6px">本地激活（离线，无需联网）</div>' +
          '<div style="font-size:12px;color:var(--muted);font-family:var(--sans);line-height:1.6;margin-bottom:8px">使用本地激活码离线校验，无需联网。如已有激活码，点下方按钮输入。</div>' +
          '<button class="btn btn-ghost btn-sm" onclick="window.__XJ_API__ && window.__XJ_API__.openActivation ? window.__XJ_API__.openActivation() : null">输入本地激活码</button>' +
        '</div>' +
        '<div style="border-top:1px dashed var(--border);padding-top:12px">' +
          '<div style="font-size:13px;font-family:var(--sans);font-weight:600;color:var(--text);margin-bottom:6px">云激活（在线校验，需联网）</div>' +
          '<div style="font-size:12px;color:var(--muted);font-family:var(--sans);line-height:1.6;margin-bottom:8px">云端校验激活码，本地不保存密钥。网络不可达时请改用本地激活。</div>' +
          '<div class="form-row" style="display:flex;gap:8px;margin-bottom:8px">' +
            '<input class="form-control" id="cloud-code-input" placeholder="输入云激活码" style="flex:1">' +
            '<button class="btn btn-primary btn-sm" id="cloud-activate-btn">云激活</button>' +
          '</div>' +
          '<div id="cloud-activate-msg" style="font-size:12px;color:var(--muted);font-family:var(--sans);line-height:1.5;min-height:14px"></div>' +
        '</div>';
      // 绑定云激活按钮
      const btn = document.getElementById('cloud-activate-btn');
      if (btn) btn.onclick = cloudActivate;
      return;
    }
    const tierLabel = (function (t) {
      if (t === 'pro') return '标准版 (Pro)';
      if (t === 'custom') return '定制旗舰版 (Custom)';
      if (t === 'full') return '完整版（旧激活码）';
      return t || '';
    })(state.tier);
    const expText = (state.expiresAt && state.expiresAt !== 0)
      ? ('有效期至 ' + fmtDate(state.expiresAt))
      : '终身有效';
    card.innerHTML =
      '<div style="font-family:var(--sans);font-weight:600;color:var(--text);margin-bottom:6px">已激活</div>' +
      '<div style="font-size:13px;color:var(--text);font-family:var(--sans);margin-bottom:4px">授权给：' + App.escapeHtml(state.identity) + (tierLabel ? ' · ' + tierLabel : '') + '</div>' +
      '<div style="font-size:13px;color:var(--muted);font-family:var(--sans)">' + expText + '</div>';
  }

  // 云激活：调 __XJ_API__.cloudActivate（preload → main xj:cloud-activate → cloud-verify.js POST 云端 Worker）
  async function cloudActivate() {
    const input = document.getElementById('cloud-code-input');
    const msg = document.getElementById('cloud-activate-msg');
    const btn = document.getElementById('cloud-activate-btn');
    if (!input || !btn) return;
    const code = (input.value || '').trim();
    if (!code) {
      if (msg) { msg.textContent = '请输入云激活码'; msg.style.color = 'var(--red, #c0463a)'; }
      return;
    }
    btn.disabled = true; btn.textContent = '校验中…';
    if (msg) { msg.textContent = '正在云端校验，请稍候…'; msg.style.color = 'var(--muted)'; }
    try {
      const r = await window.__XJ_API__.cloudActivate(code);
      if (r && r.ok) {
        if (msg) { msg.textContent = '云激活成功：' + (r.identity || '') + '（已解锁全部功能）'; msg.style.color = 'var(--green, #6E7E62)'; }
        App.showToast('云激活成功：' + (r.identity || ''), 'success');
        setTimeout(() => { location.reload(); }, 800);
      } else {
        if (msg) { msg.textContent = (r && r.error) || '云激活失败'; msg.style.color = 'var(--red, #c0463a)'; }
        btn.disabled = false; btn.textContent = '云激活';
      }
    } catch (e) {
      if (msg) { msg.textContent = '云激活失败：' + (e && e.message ? e.message : '未知错误'); msg.style.color = 'var(--red, #c0463a)'; }
      btn.disabled = false; btn.textContent = '云激活';
    }
  }
  window.cloudActivate = cloudActivate;
  // 主进程激活后实时刷新授权卡片与督导师锁（跨 realm 经桥接方法订阅）
  if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
    window.__XJ_API__.onLicenseState(() => { try { renderLicenseInfo(); loadSupervisorUI(); } catch (e) {} });
  }

    loadConfig();
    calcStorage();
    updateBackupTime();
    loadBackupConfigUI();
    loadSupervisorUI();
    initThemeToggle();
    renderLicenseInfo();
  },
});
