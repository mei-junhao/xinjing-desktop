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

    loadConfig();
    calcStorage();
    updateBackupTime();
    initThemeToggle();
  },
});
