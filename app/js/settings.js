/* ============================================================
   心镜 XinJing — 设置页逻辑
   ============================================================ */

App.initPage({
  title: '设置',
  subtitle: 'AI 接口与数据管理',
  actions: '',
  onReady: function () {
    'use strict';

    // sandbox preload 通过主进程读取真实应用版本，避免本地 require 在沙箱中失效。
    async function getAppVersion() {
      var ver = '5.1.9';
      try {
        if (window.__XJ_API__ && typeof window.__XJ_API__.getVersion === 'function') {
          ver = await window.__XJ_API__.getVersion() || ver;
        }
      } catch (e) {}
      return ver;
    }
    async function setVersion() {
      var ver = await getAppVersion();
      var verEl = document.getElementById('ver-text');
      if (verEl) verEl.textContent = 'v' + ver;
      var aboutVer = document.getElementById('about-version');
      if (aboutVer) aboutVer.textContent = 'v' + ver;
      var updateInfo = document.getElementById('update-info');
      if (updateInfo) updateInfo.textContent = '当前版本 v' + ver;
    }
    setVersion();
    updateBackupTime();

    // 检查更新：唯一权威实现在 js/settings-update-ui.js（typed 状态流、
    // committed-only 成功文案、无 3 秒假兜底）。此处不再重复定义 window.checkUpdate，
    // 避免加载顺序覆盖权威实现。

    // 主题 toggle 初始状态
    var themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.classList.toggle('on', document.documentElement.classList.contains('dark'));
    }
    window.toggleTheme = function () {
      var isDark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('xj_theme', isDark ? 'dark' : 'light'); } catch (e) {}
      if (themeToggle) themeToggle.classList.toggle('on', isDark);
    };

    // 激活状态 — 订阅式监听（主进程广播后实时刷新，不依赖启动快照）
    var licEl = document.getElementById('license-status');
    function refreshLicense() {
      if (!licEl) return;
      try {
        var state = (typeof App !== 'undefined' && App.getLicenseState) ? App.getLicenseState() : null;
        if (state) {
          if (state.verified || state.activated) {
            licEl.innerHTML = '<span class="badge ok">已激活 · 会员版</span>';
          } else if (state.mode === 'trial') {
            licEl.innerHTML = '<span class="badge warn">试用中 · 剩余' + (state.trialDaysLeft || '?') + '天</span>';
          } else {
            licEl.innerHTML = '<span class="badge warn">未激活 · 免费版</span>';
          }
          return;
        }
        var snap = window.__XJ_API__ && window.__XJ_API__.getState ? window.__XJ_API__.getState() : {};
        if (snap.verified || snap.activated) {
          licEl.innerHTML = '<span class="badge ok">已激活 · 会员版</span>';
        } else {
          licEl.innerHTML = '<span class="badge warn">未激活 · 免费版</span>';
        }
      } catch (e) {
        licEl.innerHTML = '<span class="badge warn">查询中…</span>';
      }
    }
    refreshLicense();
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.onLicenseState === 'function') {
        window.__XJ_API__.onLicenseState(refreshLicense);
      }
    } catch (e) {}

    // 自定义模型行切换
    var modelSelect = document.getElementById('api-model');
    var customRow = document.getElementById('custom-model-row');
    if (modelSelect && customRow) {
      modelSelect.addEventListener('change', function () {
        customRow.style.display = this.value === '__custom__' ? '' : 'none';
      });
    }

    var savedApiKey = '';
    async function loadConfig() {
    const settings = Store.getSettings();
    const api = settings.apiConfig || {};
    document.getElementById('api-baseurl').value = api.baseUrl || '';
    savedApiKey = typeof api.apiKey === 'string' ? api.apiKey : '';
    var keyInput = document.getElementById('api-key');
    keyInput.value = '';
    keyInput.placeholder = savedApiKey ? '密钥已保存；输入新密钥可替换' : 'sk-...';
    const OLD = ['deepseek-pro', 'deepseek-flash', 'minimax-m3', 'agnes', 'deepseek-reasoner', 'deepseek-chat'];
    let modelPref = api.modelPreference || '';
    if (OLD.indexOf(modelPref) !== -1) {
      modelPref = '';
      Store.saveSettings({ apiConfig: Object.assign({}, api, { modelPreference: '', verified: false }) });
    }
    // 如果模型在预设列表中，直接选中；否则选"自定义"并填入
    var sel = document.getElementById('api-model');
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === modelPref) { sel.value = modelPref; found = true; break; }
    }
    if (!found && modelPref) {
      sel.value = '__custom__';
      var cm = document.getElementById('api-custom-model');
      if (cm) { cm.value = modelPref; document.getElementById('custom-model-row').style.display = ''; }
    } else {
      sel.value = modelPref || '__builtin__';
    }
  }

  async function encryptApiKey(rawKey) {
    if (!rawKey) return savedApiKey;
    if (!window.__XJ_API__ || typeof window.__XJ_API__.encryptSecret !== 'function') {
      throw new Error('本机密钥加密服务不可用');
    }
    const encrypted = await window.__XJ_API__.encryptSecret(rawKey);
    if (typeof encrypted !== 'string' || !encrypted.startsWith('xj-enc:')) {
      throw new Error('本机无法安全加密密钥');
    }
    return encrypted;
  }

  // 显示当前生效档位（内置 / 用户），供用户感知低性能 vs 高性能
  // 诚实化：必须 verified===true 才认作已接入高性能，否则如实显示「未验证」并引导重新验证
  function selectedBuiltinModelLabel() {
    var id = 'deepseek-v4-pro';
    try {
      var selection = (Store.getSettings() || {}).aiModelSelection;
      if (selection && typeof selection.modelId === 'string') id = selection.modelId;
    } catch (e) {}
    return ({
      'deepseek-v4-pro': 'DeepSeek V4 Pro（主力模型）',
      'deepseek-v4-flash': 'DeepSeek V4 Flash（主力模型）',
      'gpt-5.6': 'GPT Terra（主力模型）',
    })[id] || id;
  }

  function updateTierStatus() {
    const el = document.getElementById('api-tier-status');
    if (!el) return;
    let tier = 'builtin', cfg = null, unverified = false;
    try {
      if (typeof AI !== 'undefined' && AI.getTier) tier = AI.getTier();
      // 非 agent 与 Agent 默认均展示服务器主力模型；Qwen 仅由服务端失败时兜底
      if (typeof AI !== 'undefined' && AI.getNonAgentConfig) cfg = AI.getNonAgentConfig();
      else if (typeof AI !== 'undefined' && AI.getActiveConfig) cfg = AI.getActiveConfig();
      const api = (Store.getSettings().apiConfig) || {};
      if (api.apiKey && api.verified !== true) unverified = true;
    } catch (e) { /* ignore */ }
    if (tier === 'user' && cfg) {
      el.innerHTML = '<b>高性能模型</b> · ' + App.escapeHtml(cfg.model) + '（已验证，理解质量提升）';
    } else if (unverified) {
      el.innerHTML = '🌱 <b>内置免费模型</b> · 你填的密钥<b>未验证</b>，点「接入高性能 AI」重新验证';
    } else {
      el.innerHTML = '🌱 <b>内置主力模型</b> · ' + App.escapeHtml((cfg && cfg.label) || (cfg && cfg.model) || selectedBuiltinModelLabel()) + '（默认对话模型）';
    }
    renderTrialQuota();
  }

  // 试用额度展示：显示主力线路状态与剩余额度；用户档不显示
  function renderTrialQuota() {
    const box = document.getElementById('trial-quota-box');
    if (!box) return;
    let tier = 'builtin';
    try { if (typeof AI !== 'undefined' && AI.getTier) tier = AI.getTier(); } catch (e) {}
    if (tier === 'user') { box.style.display = 'none'; box.innerHTML = ''; return; }
    const q = (typeof AI !== 'undefined' && AI.getQuota) ? AI.getQuota() : null;
    const pct = q && q.percent != null ? q.percent : null;
    const remain = q && q.remainingYuan != null ? q.remainingYuan : null;
    const reset = q && q.resetAt ? q.resetAt : null;
    const isBasic = q && q.tier === 'basic';
    const pctText = pct == null ? '查询中…' : (pct + '%');
    box.style.display = 'block';
    const barColor = isBasic ? 'var(--muted)' : (pct != null && pct <= 15 ? '#d98a3a' : 'var(--accent, #8b93c7)');
    box.innerHTML =
      '<div style="font-size:12px;font-family:var(--sans);line-height:1.5;margin-bottom:6px">' +
        '🌱 <b>免费试用额度</b> · 剩余 <b>' + pctText + '</b>' +
        (remain != null ? '（约 ¥' + remain.toFixed(2) + ' / ¥5）' : '') +
        (isBasic ? ' · <span style="color:#d98a3a">主力线路暂不可用，将由服务器尝试免费兜底</span>' : ' · 当前使用 ' + App.escapeHtml(selectedBuiltinModelLabel())) +
      '</div>' +
      '<div style="height:8px;border-radius:6px;background:var(--accent-soft, rgba(139,147,199,.18));overflow:hidden">' +
        '<div style="height:100%;width:' + (pct == null ? 0 : Math.max(2, Math.min(100, pct))) + '%;background:' + barColor + ';transition:width .3s"></div>' +
      '</div>' +
      (reset ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">额度周期重置：' + App.escapeHtml(reset) + '</div>' : '') +
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">主力线路失败时才会切换到 Qwen 免费兜底；会员余额不足会明确提示并停止扣费。</div>';
  }

  window.saveApiConfig = async function () {
    var sel = document.getElementById('api-model');
    var model = sel.value;
    if (model === '__custom__') {
      model = document.getElementById('api-custom-model').value.trim();
    }
    // 选「内置免费模型」= 清除自有配置，回退到内置模型
    if (model === '__builtin__' || !model) {
      var builtinSave = await Store.saveSettingsDurable({ apiConfig: {} });
      if (!builtinSave.ok) {
        App.showToast('配置保存失败，当前设置未改变', 'error');
        return false;
      }
      savedApiKey = '';
      document.getElementById('api-key').value = '';
      document.getElementById('api-key').placeholder = 'sk-...';
      App.showToast('已切换回内置免费模型', 'success');
    } else {
      var rawKey = document.getElementById('api-key').value.trim();
      var encKey;
      try {
        encKey = await encryptApiKey(rawKey);
      } catch (e) {
        App.showToast(e.message || '密钥无法安全保存，请重试', 'error');
        return false;
      }
      if (!encKey) {
        App.showToast('请输入 API Key', 'error');
        return false;
      }
      const previous = (Store.getSettings().apiConfig) || {};
      const nextBaseUrl = document.getElementById('api-baseurl').value.trim();
      const unchangedConnection = !rawKey && previous.baseUrl === nextBaseUrl && previous.modelPreference === model;
      var apiSave = await Store.saveSettingsDurable({
        apiConfig: {
          baseUrl: nextBaseUrl,
          apiKey: encKey,
          modelPreference: model,
          maxTokens: 4000,
          verified: unchangedConnection && previous.verified === true,
        },
      });
      if (!apiSave.ok) {
        App.showToast('配置保存失败，当前设置未改变', 'error');
        return false;
      }
      savedApiKey = encKey;
      document.getElementById('api-key').value = '';
      document.getElementById('api-key').placeholder = '密钥已保存；输入新密钥可替换';
      App.showToast('已保存 API 配置', 'success');
    }
    updateTierStatus();
    if (!window.__xjSettingsModelSelectionBound) {
      window.__xjSettingsModelSelectionBound = true;
      window.addEventListener('xj:model-selection-changed', updateTierStatus);
    }
  };

  // 一键清除自有配置，回到内置免费模型
  window.useBuiltinModel = async function () {
    var builtinSave = await Store.saveSettingsDurable({ apiConfig: {} });
    if (!builtinSave.ok) {
      App.showToast('配置保存失败，当前设置未改变', 'error');
      return false;
    }
    document.getElementById('api-baseurl').value = '';
    document.getElementById('api-key').value = '';
    document.getElementById('api-key').placeholder = 'sk-...';
    document.getElementById('api-model').value = '__builtin__';
    savedApiKey = '';
    updateTierStatus();
    App.showToast('已清除配置，改用内置免费模型', 'success');
  };

  window.testApi = async function () {
    var sel = document.getElementById('api-model');
    var model = sel ? sel.value : '';
    if (model === '__custom__') model = document.getElementById('api-custom-model').value.trim();
    var rawKey = document.getElementById('api-key').value.trim();
    var cfg = {
      baseUrl: document.getElementById('api-baseurl').value.trim(),
      apiKey: rawKey || savedApiKey,
      model: model,
    };
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model || model === '__builtin__') {
      App.showToast('请先填写接口地址、模型和密钥', 'error');
      return;
    }
    App.showToast('正在测试连接...');
    try {
      const test = typeof AI !== 'undefined' && AI.testConnection ? await AI.testConnection(cfg) : { ok: false };
      if (test.ok) {
        App.showToast('连接成功 ✓（' + cfg.model + '）', 'success');
      } else {
        App.showToast('连接失败，请检查接口地址、模型和密钥', 'error');
      }
    } catch (e) {
      App.showToast('连接错误，请检查网络后重试', 'error');
    }
  };

  function calcStorage() {
    const info = Store.storageInfo();
    const text = `后端：${info.backend} · 约 ${info.approxDataSizeMB} MB · 来访者 ${info.clientCount} / 会话 ${info.sessionCount} / 督导 ${info.supervisionCount}`;
    document.getElementById('storage-text').textContent = text;
    const bar = document.getElementById('storage-bar');
    if (bar) bar.style.width = Math.min(100, (info.approxDataSizeMB / 1024) * 100) + '%';
  }

  function backupErrorMessage(code) {
    const messages = {
      XJ_BACKUP_PASSPHRASE_TOO_SHORT: '恢复口令至少需要 12 个字符。',
      XJ_BACKUP_AUTH_FAILED: '恢复口令错误，或备份文件已损坏/被修改。',
      XJ_BACKUP_PACKAGE_INVALID: '这不是可识别的加密备份文件。',
      XJ_BACKUP_PACKAGE_UNSUPPORTED: '备份版本不受当前版本支持。',
      XJ_BACKUP_KDF_UNSUPPORTED: '该备份属于设备自动备份，请在原设备恢复，或使用恢复口令备份跨设备迁移。',
      XJ_BACKUP_PAYLOAD_HASH_MISMATCH: '备份完整性校验失败，当前数据未改变。',
      XJ_BACKUP_SAFETY_WRITE_FAILED: '恢复前安全快照创建失败，当前数据未改变。',
      XJ_IMPORT_DURABLE_FAILED: '数据写入失败，当前数据未改变。',
      XJ_BACKUP_SENDER_DENIED: '备份请求来源未通过安全校验。',
    };
    return messages[code] || '备份操作失败，当前数据未改变。';
  }

  function requestBackupPassphrase(mode) {
    return new Promise(function (resolve) {
      var overlay = document.getElementById('backup-passphrase-modal');
      if (!overlay || !App || typeof App.openModal !== 'function') { resolve(null); return; }
      var title = document.getElementById('backup-passphrase-title');
      var description = document.getElementById('backup-passphrase-description');
      var input = document.getElementById('backup-passphrase');
      var confirm = document.getElementById('backup-passphrase-confirm');
      var confirmRow = document.getElementById('backup-passphrase-confirm-row');
      var restoreRow = document.getElementById('backup-restore-confirm-row');
      var restoreCheck = document.getElementById('backup-restore-confirm');
      var error = document.getElementById('backup-passphrase-error');
      var submit = document.getElementById('backup-passphrase-submit');
      var result = null;
      var settled = false;
      var minimum = window.XJBackupCrypto && window.XJBackupCrypto.PASSPHRASE_MIN_LENGTH || 12;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (input) input.value = '';
        if (confirm) confirm.value = '';
        if (restoreCheck) restoreCheck.checked = false;
        resolve(value);
      }
      if (title) title.textContent = mode === 'export' ? '设置恢复口令' : '输入恢复口令';
      if (description) description.textContent = mode === 'export'
        ? '该口令用于在其他设备恢复此备份。口令不会保存；丢失后无法找回。'
        : '恢复会替换当前业务数据，但会保留当前设置和 API 密钥。请输入创建备份时的恢复口令。';
      if (confirmRow) confirmRow.style.display = mode === 'export' ? 'block' : 'none';
      if (restoreRow) restoreRow.style.display = mode === 'restore' ? 'block' : 'none';
      if (error) error.textContent = '';
      if (submit) {
        submit.textContent = mode === 'export' ? '导出加密备份' : '验证并恢复';
        submit.onclick = function () {
          var passphrase = input ? input.value : '';
          if (Array.from(passphrase).length < minimum || !passphrase.trim()) {
            if (error) error.textContent = '恢复口令至少需要 ' + minimum + ' 个字符。';
            if (input) input.focus();
            return;
          }
          if (mode === 'export' && passphrase !== (confirm ? confirm.value : '')) {
            if (error) error.textContent = '两次输入的恢复口令不一致。';
            if (confirm) confirm.focus();
            return;
          }
          if (mode === 'restore' && (!restoreCheck || !restoreCheck.checked)) {
            if (error) error.textContent = '请先确认会替换当前业务数据。';
            return;
          }
          result = { passphrase: passphrase, confirmed: true };
          App.closeModal('backup-passphrase-modal');
        };
      }
      App.bindModalClose('backup-passphrase-modal');
      App.openModal('backup-passphrase-modal', {
        initialFocus: '#backup-passphrase',
        onClose: function () { finish(result); },
      });
    });
  }

  var dataSafetyController = null;
  if (window.XJSettingsDataSafetyController && typeof window.XJSettingsDataSafetyController.createSettingsDataSafetyController === 'function') {
    dataSafetyController = window.XJSettingsDataSafetyController.createSettingsDataSafetyController({
      requestPassphrase: requestBackupPassphrase,
      bridge: window.__XJ_API__ || {},
      store: Store,
      ui: {
        showToast: function (message, type) { App.showToast(message, type); },
        downloadFile: function (name, content, mime) { App.downloadFile(name, content, mime); },
        formatDate: function (date, compact) { return App.formatDate(date, compact); },
        updateBackupTime: updateBackupTime,
        reload: function () { setTimeout(function () { location.reload(); }, 800); },
      },
    });
  }

  window.backupData = function () {
    if (!dataSafetyController) {
      App.showToast('加密备份暂不可用，请恢复后重试', 'error');
      return Promise.resolve({ ok: false, errorCode: 'XJ_BACKUP_CONTROLLER_UNAVAILABLE', value: null });
    }
    return dataSafetyController.backup();
  };

  window.restoreData = function (event) {
    var inputElement = event && event.target ? event.target : null;
    var file = inputElement && inputElement.files ? inputElement.files[0] : null;
    if (!file) return Promise.resolve({ ok: false, errorCode: 'no-file', value: null });
    if (!dataSafetyController) {
      App.showToast('加密恢复暂不可用，请恢复后重试', 'error');
      return Promise.resolve({ ok: false, errorCode: 'XJ_RESTORE_CONTROLLER_UNAVAILABLE', value: null });
    }
    return dataSafetyController.restore({ file: file, inputElement: inputElement });
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
    const el = document.getElementById('backup-time');
    const t = Store.getSettings().backupLastTime;
    const txt = t ? '上次备份：' + new Date(t).toLocaleString('zh-CN') : '尚未备份';
    if (el) el.textContent = txt;
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
  // v3.5.0 用户自建知识库：选择资料文件夹 + 回显已选路径
  window.selectUserDocFolder = async function () {
    if (!window.__XJ_API__ || typeof window.__XJ_API__.selectUserDocFolder !== 'function') {
      App.showToast('资料文件夹选择不可用', 'error'); return;
    }
    const folder = await window.__XJ_API__.selectUserDocFolder();
    const el = document.getElementById('userdoc-path');
    if (el) el.textContent = folder || '未设置';
    if (window.UserDocs) {
      window.UserDocs.preload();        // 重新预取 AI 注入缓存
      if (window.UserDocs.invalidateMeta) window.UserDocs.invalidateMeta();
    }
    await renderUserDocStats(true);
    App.showToast(folder ? '已设置资料库' : '已清除资料库', folder ? 'success' : 'info');
  };
  async function renderUserDocStats(force) {
    const st = document.getElementById('userdoc-stats');
    if (!st) return;
    if (!window.UserDocs || !window.UserDocs.getMeta) { st.textContent = ''; return; }
    try {
      const meta = await window.UserDocs.getMeta(!!force);
      if (!meta || !meta.ok || !meta.folder) { st.textContent = ''; return; }
      const s = meta.stats || {};
      const files = s.fileCount || (meta.files ? meta.files.length : 0);
      if (!files) { st.textContent = '文件夹为空，未发现 .md / .txt 文件'; return; }
      const chars = s.totalChars || 0;
      const charTxt = chars >= 10000 ? (Math.round(chars / 1000) / 10) + ' 万字' : chars + ' 字';
      st.textContent = files + ' 份资料 · ' + charTxt + ' · ' + (s.categoryCount || 0) + ' 个分类';
    } catch (e) { st.textContent = ''; }
  }
  window.loadUserDocUI = async function () {
    try {
      const r = await window.__XJ_API__.getUserDocFolder();
      const el = document.getElementById('userdoc-path');
      if (el) el.textContent = (r && r.folder) ? r.folder : '未设置';
    } catch (e) { /* ignore */ }
    renderUserDocStats(false);
    loadRagIndexStatus();
  };
  async function loadRagIndexStatus() {
    const row = document.getElementById('rag-index-row');
    const progRow = document.getElementById('rag-progress-row');
    const st = document.getElementById('rag-index-status');
    const tier = (window.__XJ__ && window.__XJ__.tier) ? window.__XJ__.tier : 'free';
    const ragAvailable = (tier !== 'free') && window.__XJ_API__ && window.__XJ_API__.ragIndexStatus;
    if (row) row.style.display = ragAvailable ? '' : 'none';
    if (progRow) progRow.style.display = 'none';
    if (!st) return;
    if (!ragAvailable) { st.textContent = '不可用'; return; }
    try {
      const r = await window.__XJ_API__.ragIndexStatus();
      if (!r || !r.ok) { st.textContent = '未构建'; return; }
      if (!r.fileCount) { st.textContent = '未构建'; return; }
      const time = r.lastIndexed ? new Date(r.lastIndexed).toLocaleString('zh-CN') : '-';
      st.textContent = r.fileCount + ' 份文件 · ' + r.chunkCount + ' 个文本块 · ' + time;
    } catch (e) { st.textContent = '未构建'; }
  }
  window.buildRagIndex = async function () {
    if (!window.__XJ_API__ || !window.__XJ_API__.ragIndex) {
      App.showToast('索引功能不可用', 'error'); return;
    }
    const btn = document.getElementById('rag-index-btn');
    const cancelBtn = document.getElementById('rag-cancel-btn');
    const progRow = document.getElementById('rag-progress-row');
    const progBar = document.getElementById('rag-progress-bar');
    const progText = document.getElementById('rag-index-progress-text');
    if (btn) btn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    if (progRow) progRow.style.display = '';
    if (progText) { progText.style.display = ''; progText.textContent = '准备中…'; }
    let progressOff = null;
    try {
      if (window.__XJ_API__.onRagProgress) {
        progressOff = window.__XJ_API__.onRagProgress(function (p) {
          if (progBar && p.total) {
            const pct = Math.min(100, Math.round((p.current / p.total) * 100));
            progBar.style.width = pct + '%';
          }
          if (progText && p.fileName) {
            progText.textContent = (p.stage || '索引中') + '：' + p.fileName;
          }
        });
      }
      const r = await window.__XJ_API__.ragIndex();
      if (r && r.ok) {
        App.showToast('索引构建完成', 'success');
      } else if (r && r.canceled) {
        App.showToast('已取消', 'info');
      } else {
        App.showToast('索引失败：' + ((r && r.error) || 'unknown'), 'error');
      }
    } catch (e) {
      App.showToast('索引失败：' + e.message, 'error');
    } finally {
      if (progressOff && typeof progressOff === 'function') { try { progressOff(); } catch (e) {} }
      if (btn) btn.style.display = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (progRow) progRow.style.display = 'none';
      if (progText) progText.style.display = 'none';
      if (progBar) progBar.style.width = '0%';
      loadRagIndexStatus();
    }
  };
  window.cancelRagIndex = function () {
    if (window.__XJ_API__ && window.__XJ_API__.ragCancel) {
      window.__XJ_API__.ragCancel();
    }
  };
  window.saveBackupSettings = async function () {
    const cfg = getBackupConfig();
    const emailEl = document.getElementById('backup-email');
    const onEl = document.getElementById('backup-email-on');
    cfg.email = (emailEl && emailEl.value || '').trim();
    cfg.emailEnabled = !!(onEl && onEl.checked);
    try {
      if (window.__XJ_API__ && typeof window.__XJ_API__.saveBackupConfig === 'function') {
        var saved = await window.__XJ_API__.saveBackupConfig(cfg);
        if (!saved || saved.ok !== true) {
          App.showToast(backupErrorMessage(saved && saved.errorCode), 'error');
          return false;
        }
      }
      Store.saveSettings({ backup: cfg });
    } catch (_) {
      App.showToast('备份设置保存失败，请恢复后重试', 'error');
      return false;
    }
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

  function initWritingStyleToggle() {
    const toggle = document.getElementById('writing-style-toggle');
    const status = document.getElementById('writing-style-status');
    if (!toggle) return;

    function enabled() {
      const settings = typeof Store !== 'undefined' && Store.getSettings ? Store.getSettings() : {};
      if (typeof PromptGovernance !== 'undefined' && PromptGovernance.isWritingStyleEnabled) {
        return PromptGovernance.isWritingStyleEnabled(settings);
      }
      return !settings.promptGovernance || settings.promptGovernance.writingStyleEnabled !== false;
    }
    function sync(message) {
      const active = enabled();
      toggle.classList.toggle('on', active);
      toggle.setAttribute('aria-checked', String(active));
      if (status) status.textContent = message || (active ? '已启用口语化表达，不影响事实与来源限制' : '已关闭口语化表达，事实与来源限制继续生效');
    }

    sync();
    toggle.addEventListener('click', async function () {
      if (typeof Store === 'undefined' || !Store.getSettings || !Store.saveSettingsDurable) {
        if (status) status.textContent = '本地设置尚未就绪，未改变表达风格';
        return;
      }
      const current = Store.getSettings() || {};
      const currentGovernance = current.promptGovernance && typeof current.promptGovernance === 'object' ? current.promptGovernance : {};
      const next = !enabled();
      toggle.disabled = true;
      const result = await Store.saveSettingsDurable({ promptGovernance: Object.assign({}, currentGovernance, { writingStyleEnabled: next }) });
      toggle.disabled = false;
      if (!result || !result.ok) {
        sync('本地设置未保存，表达风格保持不变');
        return;
      }
      sync(next ? '已启用口语化表达，不影响事实与来源限制' : '已关闭口语化表达，事实与来源限制继续生效');
    });
  }

  function initPrivacyObservabilityUI() {
    if (!window.XJSettingsObservabilityController || typeof window.XJSettingsObservabilityController.createSettingsObservabilityController !== 'function') return;
    var controller = window.XJSettingsObservabilityController.createSettingsObservabilityController({
      elements: {
        toggle: document.getElementById('privacy-consent-toggle'),
        status: document.getElementById('privacy-observability-status'),
        count: document.getElementById('privacy-observability-count'),
        exportButton: document.getElementById('privacy-export-btn'),
        clearButton: document.getElementById('privacy-clear-btn'),
        revokeButton: document.getElementById('privacy-revoke-btn'),
      },
      app: App,
    });
    controller.initialize();
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

  function renderMembershipSummary() {
    const state = App.getLicenseState ? App.getLicenseState() : {};
    const tier = (typeof XJEntitlements !== 'undefined') ? XJEntitlements.effectiveTier(state) : 'free';
    const name = document.getElementById('membership-plan-name');
    const detail = document.getElementById('membership-plan-detail');
    const badge = document.getElementById('membership-plan-badge');
    if (name) name.textContent = state.mode === 'trial' && state.aiUnlocked ? '旗舰试用' : ((typeof XJEntitlements !== 'undefined') ? XJEntitlements.tierLabel(tier) : '免费版');
    if (detail) {
      if (tier === 'custom') detail.textContent = '16K 上下文、向量 + Rerank 精排与全部会员临床能力';
      else if (tier === 'pro' || tier === 'full') detail.textContent = 'AI 临床工具、4K 向量检索、大师会诊与会员皮肤';
      else detail.textContent = '手工执业工作流与 2K 关键词资料检索';
    }
    if (badge) badge.innerHTML = App.membershipBadge();
  }

  // ============================================================
  // v5.0.2 桌面账号投影（contract-v502-desktop-auth-session-membership-v1）
  // 登录状态与会员档位只展示主进程返回的服务器权威投影；
  // 网络失败/未知档位 fail-closed 显示「不可用/未知」，绝不编造会员身份。
  // ============================================================
  var DESKTOP_TIER_LABEL = { free: '免费版', pro: '会员版 (Pro)', flagship: '旗舰版 (Flagship)' };

  function desktopAccountBridge() {
    return window.__XJ_API__ && window.__XJ_API__.account ? window.__XJ_API__.account : null;
  }

  function fmtMembershipFetchedAt(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  function renderDesktopAccountStatus(snapshot) {
    var statusEl = document.getElementById('desktop-account-status');
    var badgeEl = document.getElementById('desktop-account-badge');
    var memberEl = document.getElementById('desktop-account-membership');
    if (!statusEl || !badgeEl || !memberEl) return;
    if (!snapshot || snapshot.authenticated !== true) {
      statusEl.textContent = '未登录';
      badgeEl.className = 'badge warn';
      badgeEl.textContent = '未登录';
      memberEl.textContent = '未登录：会员信息以登录后的服务器核验为准';
      return;
    }
    var account = snapshot.account || {};
    statusEl.textContent = (account.email || '已登录') + (account.accountId ? ' · ' + account.accountId : '');
    badgeEl.className = 'badge ok';
    badgeEl.textContent = '已登录';
    var m = snapshot.membership;
    if (m && m.status === 'ok' && m.serverAuthoritative === true && DESKTOP_TIER_LABEL[m.tier]) {
      memberEl.textContent = DESKTOP_TIER_LABEL[m.tier] + (fmtMembershipFetchedAt(m.fetchedAt) ? '（核验于 ' + fmtMembershipFetchedAt(m.fetchedAt) + '）' : '');
    } else if (m && m.status === 'error') {
      memberEl.textContent = '会员信息获取失败（服务器为唯一权威）：' + (m.errorCode || 'unknown') + '，请点击刷新重试';
    } else {
      memberEl.textContent = '会员信息未知：服务器未返回可信档位';
    }
  }

  function initDesktopAccountPanel() {
    var bridge = desktopAccountBridge();
    var statusEl = document.getElementById('desktop-account-status');
    if (!statusEl) return;
    if (!bridge) {
      renderDesktopAccountStatus(null);
      return;
    }
    var refreshBtn = document.getElementById('desktop-account-refresh');
    var refreshing = false;

    function refreshSnapshot() {
      bridge.status().then(function (snapshot) {
        renderDesktopAccountStatus(snapshot);
      }).catch(function () { renderDesktopAccountStatus(null); });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        if (refreshing) return;
        refreshing = true;
        refreshBtn.disabled = true;
        var memberEl = document.getElementById('desktop-account-membership');
        if (memberEl) memberEl.textContent = '正在向服务器核验会员信息…';
        bridge.refreshMembership().then(function () {
          refreshSnapshot();
        }).catch(function () {
          refreshSnapshot();
        }).finally(function () {
          refreshing = false;
          refreshBtn.disabled = false;
        });
      });
    }

    // 登出：事件委托到 document。设置页的布局注入/图标渲染会重建 DOM 节点，
    // 直接 addEventListener 绑在按钮上会因节点被替换而失效；委托按当前节点命中。
    if (!document.body.dataset.logoutDelegated) {
      document.body.dataset.logoutDelegated = '1';
      document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('#desktop-account-logout') : null;
        if (!btn || btn.dataset.logoutPending === '1') return;
        btn.dataset.logoutPending = '1';
        btn.disabled = true;
        btn.textContent = '退出中…';
        bridge.logout().then(function (result) {
          if (result && result.revoke && result.revoke.ok === false) {
            console.warn('logout: server revoke reported ' + (result.revoke.error && result.revoke.error.code || 'failure'));
          }
          if (result && result.navigation && result.navigation.ok === false) {
            console.warn('logout: main navigation reported ' + (result.navigation.error && result.navigation.error.code || 'failure'));
          }
        }).catch(function (e) {
          console.warn('logout: ipc failed');
        }).finally(function () {
          // 主进程已完成有界导航；此处保留 250ms 兜底，并再加 replace 兜底。
          window.setTimeout(function () {
            try { window.location.replace('account.html'); }
            catch (err) { window.location.href = 'account.html'; }
          }, 250);
        });
      });
    }

    if (typeof bridge.onChanged === 'function') {
      bridge.onChanged(function () { refreshSnapshot(); });
    }
    refreshSnapshot();
  }

  function initSkinSelector() {
    const buttons = Array.from(document.querySelectorAll('[data-skin-name]'));
    function sync() {
      const active = App.Theme.getSkin();
      buttons.forEach(function (button) {
        const skin = button.getAttribute('data-skin-name');
        const locked = skin !== 'clinical' && !App.canUse('premium-skins');
        button.classList.toggle('active', skin === active);
        button.setAttribute('aria-pressed', String(skin === active));
        button.toggleAttribute('data-locked', locked);
        button.title = locked ? '升级会员后可使用此设计语言' : '';
      });
    }
    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        const skin = button.getAttribute('data-skin-name');
        if (App.Theme.setSkin(skin)) sync();
        else App.openPlans();
      });
    });
    sync();
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
    window.__XJ_API__.onLicenseState(() => { try { renderLicenseInfo(); loadSupervisorUI(); loadRagIndexStatus(); } catch (e) {} });
  }

  // ============================================================
  // 接入高性能 AI 抽屉（对话式引导，独立可靠，不依赖付费 Agent）
  // 修复「接入失败仍显示高性能」：以 AI.testConnection 真实结果为唯一事实来源。
  // ============================================================
  const CD = { state: 'ask', provider: '', baseUrl: '', model: '', models: [], defaultModel: '', apiKey: '' };
  const PROVIDER_PRESETS = {
    deepseek:   { label: 'DeepSeek',   baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
    siliconflow:{ label: '硅基流动',   baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.5-4B', models: ['Qwen/Qwen3.5-4B', 'Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V3'] },
    openai:     { label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
    moonshot:   { label: '月之暗面',   baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
    zhipu:      { label: '智谱',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', models: ['glm-4', 'glm-4-flash', 'glm-4-air'] },
    qwen:       { label: '通义千问',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
    doubao:     { label: '豆包',       baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-pro-32k', models: ['doubao-pro-32k', 'doubao-pro-4k', 'doubao-1.5-pro-256k'] },
    other:      { label: '其他/自定义', baseUrl: '', defaultModel: '', models: [] },
  };
  function cdEl(id) { return document.getElementById(id); }
  function cdMsg(role, html) {
    const box = cdEl('cd-msgs');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'xj-cd-msg ' + (role === 'user' ? 'xj-cd-user' : 'xj-cd-ai');
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
  function cdChips(labels) {
    const box = cdEl('cd-chips');
    if (!box) return;
    box.innerHTML = '';
    (labels || []).forEach(function (l) {
      const b = document.createElement('button');
      b.className = 'xj-chip';
      b.textContent = l.label;
      b.addEventListener('click', l.onClick);
      box.appendChild(b);
    });
  }
  function cdClearChips() { const box = cdEl('cd-chips'); if (box) box.innerHTML = ''; }
  function cdShowInput(show, placeholder) {
    const row = cdEl('cd-input-row');
    const inp = cdEl('cd-input');
    if (!row || !inp) return;
    row.style.display = show ? 'flex' : 'none';
    if (show) { inp.value = ''; if (placeholder) inp.placeholder = placeholder; setTimeout(function () { inp.focus(); }, 30); }
  }
  function cdReset() { CD.state = 'ask'; CD.provider = ''; CD.baseUrl = ''; CD.model = ''; CD.models = []; CD.defaultModel = ''; CD.apiKey = ''; }
  function openConnectDrawer() {
    cdReset();
    const ov = cdEl('connect-drawer');
    if (ov) ov.classList.add('xj-open');
    const box = cdEl('cd-msgs');
    if (box) box.innerHTML = '';
    cdMsg('ai', '要接入你自己的高性能 AI 吗？你手头准备好 API 密钥了吗？');
    cdChips([
      { label: '✅ 我已经有了', onClick: cdOnHave },
      { label: '❌ 还没有，教我买', onClick: showDsGuide },
    ]);
    cdShowInput(false);
  }
  function closeConnectDrawer() {
    const ov = cdEl('connect-drawer');
    if (ov) ov.classList.remove('xj-open');
    cdClearChips();
    cdShowInput(false);
  }
  function cdOnHave() {
    cdMsg('user', '我已经有了');
    CD.state = 'provider';
    cdMsg('ai', '太好了！你在<b>哪家买的</b>？或把 API 端点（baseUrl）直接发我。');
    const chips = Object.keys(PROVIDER_PRESETS).map(function (k) {
      return { label: PROVIDER_PRESETS[k].label, onClick: function () { cdPickProvider(k); } };
    });
    cdChips(chips);
    cdShowInput(true, '如：DeepSeek，或贴 https://api.xxx.com/v1');
  }
  function cdPickProvider(k) {
    const p = PROVIDER_PRESETS[k];
    CD.provider = k;
    CD.baseUrl = p.baseUrl;
    CD.models = p.models || [];
    CD.defaultModel = p.defaultModel;
    cdMsg('user', p.label);
    if (!p.baseUrl) {
      cdMsg('ai', '这是自定义平台，请把 <b>API 端点 (baseUrl)</b> 和<b>模型名</b> 发我（空格分隔）。');
      cdShowInput(true, 'baseUrl 与 model，空格分隔');
      CD.state = 'custom';
      cdClearChips();
      return;
    }
    if (!CD.models.length) {
      cdMsg('ai', '该平台我没有预设模型列表，请直接发我<b>模型名</b>。');
      cdShowInput(true, '模型名，如 deepseek-v4-pro');
      CD.state = 'modelFree';
      cdClearChips();
      return;
    }
    CD.state = 'model';
    cdMsg('ai', '这个服务商的可用模型有：<b>' + CD.models.join('</b> / <b>') + '</b>。用默认的 <b>' + CD.defaultModel + '</b> 还是指定一个？');
    const chips = CD.models.map(function (m) {
      return { label: m, onClick: function () { cdPickModel(m); } };
    });
    chips.push({ label: '用默认（' + CD.defaultModel + '）', onClick: function () { cdPickModel(CD.defaultModel); } });
    chips.push({ label: '✏️ 其他模型名…', onClick: cdPickModelFree });
    cdChips(chips);
    cdShowInput(false);
  }
  function cdPickModelFree() {
    CD.state = 'modelFree';
    cdMsg('user', '其他模型名');
    cdMsg('ai', '好的，请把<b>模型名</b>发我（如 ' + CD.defaultModel + ' 或 deepseek-v4-pro）。');
    cdShowInput(true, '模型名，如 deepseek-v4-pro');
    cdClearChips();
  }
  function cdPickModel(m) {
    CD.model = m;
    cdMsg('user', m);
    CD.state = 'key';
    cdMsg('ai', '最后一步：把你的 <b>API 密钥</b>（sk- 开头那串）发我，我马上帮你测试连接。');
    cdShowInput(true, 'sk-...');
    cdClearChips();
  }
  function cdOnInputSend() {
    const inp = cdEl('cd-input');
    if (!inp) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    if (CD.state === 'provider') {
      const lower = text.toLowerCase();
      let matched = null;
      Object.keys(PROVIDER_PRESETS).forEach(function (k) {
        if (k !== 'other' && (lower.indexOf(k) !== -1 || lower.indexOf(PROVIDER_PRESETS[k].label.toLowerCase()) !== -1)) matched = k;
      });
      if (matched) { cdPickProvider(matched); return; }
      if (text.indexOf('http') !== -1) {
        CD.provider = 'other';
        CD.baseUrl = text.replace(/\/$/, '');
        CD.models = []; CD.defaultModel = '';
        cdMsg('user', text);
        cdMsg('ai', '收到端点。再把<b>模型名</b>发我（如 deepseek-v4-pro）。');
        cdShowInput(true, '模型名');
        CD.state = 'modelFree';
        return;
      }
      cdMsg('user', text);
      cdMsg('ai', '没认出服务商。可直接发服务商名（DeepSeek/硅基流动/OpenAI…）或 API 端点链接。');
      return;
    }
    if (CD.state === 'custom') {
      cdMsg('user', text);
      const parts = text.split(/\s+/);
      CD.baseUrl = (parts[0] || '').replace(/\/$/, '');
      CD.model = parts[1] || '';
      if (!CD.baseUrl || !CD.model) { cdMsg('ai', '需要 baseUrl 和 model 两个值，用空格分隔再发一次。'); return; }
      cdAskKey();
      return;
    }
    if (CD.state === 'modelFree') {
      cdMsg('user', text);
      CD.model = text;
      cdAskKey();
      return;
    }
    if (CD.state === 'key') {
      cdMsg('user', text.replace(/./g, '•'));
      CD.apiKey = text;
      cdAskKey();
      return;
    }
  }
  function cdAskKey() {
    CD.state = 'key';
    cdMsg('ai', '正在测试连接…（几秒就好）');
    cdShowInput(false);
    cdClearChips();
    cdTestAndApply();
  }
  // 友好中文错误映射：保留底层 error 供调试（console），但给用户看中文。
  function cdFriendlyError(raw) {
    const s = (raw == null ? '' : String(raw)).toLowerCase();
    if (s.indexOf('429') !== -1 || s.indexOf('rate') !== -1 || s.indexOf('too many') !== -1 || s.indexOf('rate limit') !== -1) {
      return '请求过于频繁，请稍候';
    }
    if (s.indexOf('401') !== -1 || s.indexOf('403') !== -1 || s.indexOf('unauthorized') !== -1 || s.indexOf('authentication') !== -1 || s.indexOf('invalid api') !== -1 || s.indexOf('invalid key') !== -1 || s.indexOf('api key') !== -1 || s.indexOf('key error') !== -1) {
      return 'API Key 无效，请核对后重试';
    }
    if (s.indexOf('timeout') !== -1 || s.indexOf('timed out') !== -1 || s.indexOf('aborted') !== -1 || s.indexOf('econn') !== -1) {
      return '连接超时，请稍后重试';
    }
    if (s.indexOf('network') !== -1 || s.indexOf('fetch') !== -1 || s.indexOf('enotfound') !== -1 || s.indexOf('dns') !== -1 || s.indexOf('offline') !== -1 || s.indexOf('failed to fetch') !== -1 || s.indexOf('getaddrinfo') !== -1) {
      return '网络异常，请检查连接后重试';
    }
    return '配置失败，请重试';
  }
  // 「有 Key」验证成功后的引导：打开 Agent 对话（或降级 toast）
  function cdOpenAgent() {
    try {
      if (typeof window.AgentOpen === 'function') {
        window.AgentOpen();
      } else {
        App.showToast('Agent 已就绪，点击右下角助手开始对话', 'success');
      }
    } catch (e) {
      App.showToast('Agent 已就绪，点击右下角助手开始对话', 'success');
    }
    closeConnectDrawer();
  }
  async function cdTestAndApply() {
    const cfg = { baseUrl: CD.baseUrl, apiKey: CD.apiKey, model: CD.model };
    let test = { ok: false, error: '未配置' };
    try {
      if (typeof AI !== 'undefined' && AI.testConnection) test = await AI.testConnection(cfg);
    } catch (e) { test = { ok: false, error: (e && e.message) || '测试异常' }; }
    const merged = {
      baseUrl: CD.baseUrl, apiKey: CD.apiKey, modelPreference: CD.model,
      provider: CD.provider, maxTokens: 4000, verified: test.ok,
    };
    var toSave = Object.assign({}, merged);
    try {
      toSave.apiKey = await encryptApiKey(toSave.apiKey);
    } catch (e) {
      cdMsg('ai', '<b>密钥未保存</b>。本机暂时无法安全加密密钥，请恢复系统密钥服务后重试。');
      cdChips([{ label: '重试', onClick: cdTestAndApply }, { label: '关闭', onClick: closeConnectDrawer }]);
      return;
    }
    var drawerSave = await Store.saveSettingsDurable({ apiConfig: toSave });
    if (!drawerSave.ok) {
      cdMsg('ai', '<b>配置未保存</b>。本地存储暂不可用，当前设置未改变；请恢复后重试。');
      cdChips([{ label: '重试', onClick: cdTestAndApply }, { label: '关闭', onClick: closeConnectDrawer }]);
      return;
    }
    savedApiKey = toSave.apiKey;
    updateTierStatus();
    if (test.ok) {
      cdMsg('ai', '<b>接入成功，已验证可用</b>。模型理解与表达质量已提升；小镜的可执行操作仍以现有工具为准。');
      cdChips([
        { label: '🤖 试用 Agent 对话', onClick: cdOpenAgent },
        { label: '关闭', onClick: closeConnectDrawer },
      ]);
    } else {
      // 调试信息保留底层 error，但给用户中文友好提示
      try { console.warn('[API接入] testConnection 未通过：', test.error); } catch (e) {}
      const zh = cdFriendlyError(test.error);
      cdMsg('ai', '❌ <b>' + zh + '</b>。<br>已自动降级到<b>内置免费模型</b>。你的密钥已保留，可检查后重试（端点 / 模型名 / 密钥是否正确）。');
      cdChips([
        { label: '重新输入密钥', onClick: function () { CD.state = 'key'; cdMsg('ai', '把密钥再发我一次：'); cdShowInput(true, 'sk-...'); cdClearChips(); } },
        { label: '关闭', onClick: closeConnectDrawer },
      ]);
    }
  }
  function showDsGuide() { const m = cdEl('ds-guide-modal'); if (m) m.classList.add('xj-open'); }
  function hideDsGuide() { const m = cdEl('ds-guide-modal'); if (m) m.classList.remove('xj-open'); }
  function bindConnectDrawer() {
    const bind = function (id, ev, fn) { const e = cdEl(id); if (e) e.addEventListener(ev, fn); };
    bind('btn-connect-ai', 'click', openConnectDrawer);
    bind('link-use-builtin', 'click', function () { if (window.useBuiltinModel) window.useBuiltinModel(); });
    bind('cd-close', 'click', closeConnectDrawer);
    bind('cd-send', 'click', cdOnInputSend);
    bind('cd-input', 'keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); cdOnInputSend(); } });
    bind('connect-drawer', 'click', function (e) { if (e.target === cdEl('connect-drawer')) closeConnectDrawer(); });
    bind('ds-guide-close', 'click', hideDsGuide);
    bind('ds-guide-done', 'click', function () { hideDsGuide(); openConnectDrawer(); });
    bind('ds-guide-modal', 'click', function (e) { if (e.target === cdEl('ds-guide-modal')) hideDsGuide(); });
  }

    loadConfig();
    bindConnectDrawer();
    var planButton = document.getElementById('btn-view-plans');
    if (planButton) planButton.addEventListener('click', App.openPlans);
    initSkinSelector();
    renderMembershipSummary();
    App.onLicenseStateChange(renderMembershipSummary);
    initDesktopAccountPanel();
    updateTierStatus();
    // ===== 账号：称呼 / 执业取向 编辑（此前按钮无处理函数，点击无效）=====
    function loadProfile() {
      var s = (Store.getSettings().profile) || {};
      var nameEl = document.getElementById('account-name-display');
      var orientEl = document.getElementById('account-orientation-display');
      if (nameEl) nameEl.textContent = s.displayName ? s.displayName : '未设置';
      if (orientEl) orientEl.textContent = s.orientation ? s.orientation : '未设置';
    }
    var _editField = null;
    var _editReturnFocus = null;
    function openAccountEdit(field) {
      _editField = field;
      _editReturnFocus = document.activeElement;
      var s = (Store.getSettings().profile) || {};
      var title = document.getElementById('account-edit-title');
      var input = document.getElementById('account-edit-input');
      if (title) title.textContent = (field === 'name') ? '编辑称呼' : '编辑执业取向';
      if (input) {
        input.value = (field === 'name') ? (s.displayName || '') : (s.orientation || '');
        input.readOnly = false;
        input.disabled = false;
      }
      var modal = document.getElementById('account-edit-modal');
      if (modal) { modal.style.display = 'flex'; modal.classList.add('xj-open'); }
      if (input) {
        // Electron 中刚显示的模态，单次 setTimeout(focus) 在部分环境（尤其中文 IME）不生效，
        // 表现为「能点开但无法输入」。改用双 rAF 确保布局提交后再聚焦，并选中已有文本便于直接覆盖。
        var focusInput = function () { try { input.focus(); if (input.value) input.select(); } catch (e) {} };
        if (window.requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(focusInput); });
        else setTimeout(focusInput, 30);
      }
    }
    function saveAccountEdit() {
      var input = document.getElementById('account-edit-input');
      var val = input ? input.value.trim() : '';
      var s = (Store.getSettings().profile) || {};
      if (_editField === 'name') s.displayName = val;
      else if (_editField === 'orient') s.orientation = val;
      Store.saveSettings({ profile: s });
      loadProfile();
      var modal = document.getElementById('account-edit-modal');
      if (modal) modal.style.display = 'none';
      if (_editReturnFocus && typeof _editReturnFocus.focus === 'function') _editReturnFocus.focus();
      _editField = null;
      _editReturnFocus = null;
    }
    function closeAccountEdit() {
      var modal = document.getElementById('account-edit-modal');
      if (modal) modal.style.display = 'none';
      if (_editReturnFocus && typeof _editReturnFocus.focus === 'function') _editReturnFocus.focus();
      _editField = null;
      _editReturnFocus = null;
    }
    var btnName = document.getElementById('btn-edit-name');
    var btnOrient = document.getElementById('btn-edit-orient');
    var btnSave = document.getElementById('account-edit-save');
    var btnCancel = document.getElementById('account-edit-cancel');
    var modalOverlay = document.getElementById('account-edit-modal');
    var editInput = document.getElementById('account-edit-input');
    if (btnName) btnName.addEventListener('click', function () { openAccountEdit('name'); });
    if (btnOrient) btnOrient.addEventListener('click', function () { openAccountEdit('orient'); });
    if (btnSave) btnSave.addEventListener('click', saveAccountEdit);
    if (btnCancel) btnCancel.addEventListener('click', closeAccountEdit);
    if (modalOverlay) modalOverlay.addEventListener('click', function (e) { if (e.target === modalOverlay) closeAccountEdit(); });
    if (editInput) editInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); saveAccountEdit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeAccountEdit(); }
    });
    loadProfile();
    // v3.4.1: 暴露给 settings.html 内联脚本使用
    window.openConnectDrawer = openConnectDrawer;
    window.cdPickProvider = cdPickProvider;
    window.closeConnectDrawer = closeConnectDrawer;
    // 订阅试用额度变更，实时刷新进度条（v1.7.0）
    if (typeof AI !== 'undefined' && AI.onQuotaChange) {
      try { AI.onQuotaChange(renderTrialQuota); } catch (e) {}
    }
    if (typeof AI !== 'undefined' && AI.fetchQuota) {
      try { AI.fetchQuota(); } catch (e) {}
    }
    calcStorage();
    updateBackupTime();
    loadBackupConfigUI();
    loadUserDocUI();
    loadSupervisorUI();
    initThemeToggle();
    initWritingStyleToggle();
    initPrivacyObservabilityUI();
    renderLicenseInfo();
  },
});
