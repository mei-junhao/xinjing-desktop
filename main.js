'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const license = require('./license-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

app.setName('XinJing'); // 用户数据目录固定为 .../XinJing/，稳定存放试用与激活信息

const APP_DIR = path.join(__dirname, 'app');
const BUILD_DIR = path.join(__dirname, 'build');

// ---- 单实例锁：避免开多个心镜窗口 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let mainWindow = null;
let tray = null;
let server = null;
let PORT = 0;
let activationWindow = null;
let closeConfirmWin = null;
let licenseState = null; // {mode, identity, daysLeft, activated, trialDays, version}

// ---- 授权与试用状态 ----
function userDataDir() { return app.getPath('userData'); }

// 读取备份配置（渲染进程通过 IPC 写入 userData/backup-config.json）
function loadBackupConfig() {
  try {
    const p = path.join(userDataDir(), 'backup-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) { /* ignore */ }
  return { locations: [], email: '', emailEnabled: false };
}

// 导出当前用户数据到「文档/心镜备份」+ 用户自定义多位置（多份容灾），用于退出/常驻时备份
function exportBackup() {
  try {
    const src = userDataDir();                       // AppData\Local\XinJing（含 IndexedDB/激活/日记）
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const cfg = loadBackupConfig();
    const targets = [];

    // 1) 默认位置：文档\心镜备份（与安装目录隔离）
    try {
      const docs = app.getPath('documents');
      const def = path.join(docs, '心镜备份', 'XinJing-' + ts);
      fs.mkdirSync(path.dirname(def), { recursive: true });
      fs.cpSync(src, def, { recursive: true });
      targets.push(def);
    } catch (e) { console.error('[backup] 默认位置失败:', (e && e.message) || e); }

    // 2) 自定义多位置（多份容灾）
    (cfg.locations || []).forEach((loc) => {
      try {
        const d = path.join(loc, 'XinJing-' + ts);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.cpSync(src, d, { recursive: true });
        targets.push(d);
      } catch (e) { console.error('[backup] 自定义位置失败:', loc, (e && e.message) || e); }
    });

    console.log('[backup] exported ->', targets.join(' | '));

    // 3) 邮件提醒（mailto 兜底；真正的 SMTP 自动发送需 nodemailer + 邮箱 SMTP 凭据，见说明）
    if (cfg.emailEnabled && cfg.email) {
      try {
        const body = encodeURIComponent('心镜数据已自动备份（' + ts + '）：\n' + targets.join('\n'));
        shell.openExternal('mailto:' + cfg.email + '?subject=' + encodeURIComponent('心镜自动备份通知') + '&body=' + body);
      } catch (e) { console.error('[backup] 邮件提醒失败:', (e && e.message) || e); }
    }
    return targets;
  } catch (e) {
    console.error('[backup] failed:', (e && e.message) || e);
    return null;
  }
}
function readTrialFirstLaunch() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'trial.json'), 'utf8'));
    return j.firstLaunch || null;
  } catch (e) { return null; }
}
function ensureTrial() {
  let ts = readTrialFirstLaunch();
  if (!ts) {
    ts = Date.now();
    try { fs.writeFileSync(path.join(userDataDir(), 'trial.json'), JSON.stringify({ firstLaunch: ts })); } catch (e) { /* ignore */ }
  }
  return ts;
}
function readLicense() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'license.json'), 'utf8'));
    if (j && j.identity && j.activatedAt) return j;
  } catch (e) { /* ignore */ }
  return null;
}
function computeState() {
  const trial = license.trialStatus(ensureTrial(), Date.now());
  const lic = readLicense();
  const activated = !!(lic && lic.identity && lic.activatedAt);
  // 旧 license.json（升级前）无 tier 字段 → 视为完整版（祖父条款，权益等同 pro）
  const tier = (lic && lic.tier) ? lic.tier : (activated ? 'full' : 'free');
  // AI 解锁条件：已激活且为付费分层（pro / custom / 旧 full）。免费/受限模式锁定 AI 助手。
  const aiUnlocked = activated;
  licenseState = {
    mode: license.overallMode(activated, trial),
    identity: activated ? lic.identity : '',
    tier,
    aiUnlocked,
    daysLeft: trial.daysLeft,
    activated,
    trialDays: license.TRIAL_DAYS,
    version: app.getVersion()
  };
  return licenseState;
}

// 安全 MIME 映射（经典 <script>，.js 用 text/javascript）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// ---- 内置静态文件服务（避免 file:// 下 IndexedDB 不可用）----
function startStaticServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

        const resolved = path.resolve(APP_DIR, '.' + path.normalize(urlPath));
        if (!resolved.startsWith(APP_DIR + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        fs.stat(resolved, (err, stat) => {
          if (err || !stat.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(resolved).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          fs.createReadStream(resolved).pipe(res);
        });
      } catch (e) {
        res.writeHead(500);
        res.end('Internal Error');
      }
    });
    // 固定端口：IndexedDB/localStorage 按 origin(含端口) 隔离，随机端口会导致每次启动数据"丢失"
    const FIXED_PORT = 18765;
    const onErr = (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.warn('[server] 固定端口 ' + FIXED_PORT + ' 被占用，回退随机端口（数据可能无法跨重启持久化）');
        server.removeListener('error', onErr);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      } else {
        console.error('[server] 静态服务启动失败', err);
      }
    };
    server.on('error', onErr);
    server.listen(FIXED_PORT, '127.0.0.1', () => {
      server.removeListener('error', onErr);
      resolve(FIXED_PORT);
    });
  });
}

// ---- 主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    icon: path.join(BUILD_DIR, 'icon.png'),
    backgroundColor: '#f6f1ea',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需用 require('electron')，须关闭沙箱（默认即 false，显式兜底）
      webSecurity: false, // 允许 AI 功能向外部 API 发请求（本地单用户工具，可接受）
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/index.html`);

  mainWindow.webContents.on('preload-error', (ev, err) => {
    console.error('[preload-error] main window:', (err && err.stack) || err);
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  // 关闭 → 弹出美化版确认窗：后台常驻 or 完全退出
  // 顶部自定义 ✕ 与 Alt+F4 均等同「后台常驻」（拒绝退出）
  mainWindow.on('close', (e) => {
    if (app.isQuiting) return;            // 明确退出（托盘"退出"/确认选"完全退出"）不拦截
    e.preventDefault();
    if (closeConfirmWin) { try { closeConfirmWin.focus(); } catch (_) {} return; }
    closeConfirmWin = new BrowserWindow({
      width: 360,
      height: 252,
      parent: mainWindow,
      modal: true,
      frame: false,
      resizable: false,
      show: false,
      backgroundColor: '#f6f1ea',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, 'confirm-close-preload.js')
      }
    });
    closeConfirmWin.webContents.on('preload-error', (ev, err) => {
      console.error('[preload-error] close-confirm:', (err && err.stack) || err);
    });
    closeConfirmWin.loadURL(`http://127.0.0.1:${PORT}/confirm-close.html`);
    closeConfirmWin.once('ready-to-show', () => { if (closeConfirmWin) closeConfirmWin.show(); });
    // 用户直接关掉确认窗（Alt+F4 等）→ 等同「取消退出」：主窗口保持打开，不隐藏、不退
    closeConfirmWin.on('close', () => { /* 取消退出由抉择逻辑处理，主窗口保持打开 */ });
    closeConfirmWin.on('closed', () => { closeConfirmWin = null; });
  });

  mainWindow.on('show', () => {
    if (mainWindow) mainWindow.focus();
  });
}

// ---- 托盘 ----
function createTray() {
  const icon = nativeImage.createFromPath(path.join(BUILD_DIR, 'icon.png'));
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('心镜 XinJing');
  const trayMenu = Menu.buildFromTemplate([
    {
      label: '显示心镜',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { label: '检查更新', click: () => checkForUpdatesManual() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        exportBackup();   // 托盘「退出」也是完全退出，同样先备份
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---- 开机自启 ----
function enableAutoStart() {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: []
  });
}

// ---- 自动更新（GitHub Releases 作为更新源）----
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;        // 先询问，再下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时若已下载则自动安装
  // 关闭差分(增量)更新：NSIS 差分重组偶发写出损坏安装包，
  // 表现为 "Failed to decompress files / Error opening ZIP file"。
  // 本项目安装包仅约 73MB，整包下载换取更新可靠性，值得。
  autoUpdater.disableDifferentialDownload = true;

  // 更新源迁移到腾讯云 COS（国内节点，下载比 GitHub 快）：
  // 用 generic provider 指向 COS 桶默认域名，latest.yml / latest-portable.yml / exe 平铺在桶根，
  // 路径与 electron-updater 的请求模型完全匹配，自动更新改走国内链路
  autoUpdater.setFeedURL({ provider: 'generic', url: 'https://xinjing-1439314927.cos.ap-guangzhou.myqcloud.com/' });

  // 版本类型判定（决定走哪个更新通道）：
  //   安装版（NSIS）→ 不设 channel → 读 latest.yml（其中 path 指向 xinjing-setup-x.y.z.exe）
  //   便携版（绿色单文件）→ channel='latest-portable' → 读 latest-portable.yml（path 指向 portable 包）
  // 判定优先级：① electron 便携环境变量（最高权威）；② 可执行文件名含 "portable"
  //              （electron-builder 默认命名 xinjing-portable-x.y.z.exe）。两者都不命中 → 视为安装版
  //              → 严格走 setup 更新，绝不误拉便携包覆盖安装版用户。
  const isPortable = !!(process.env.PORTABLE_EXECUTABLE_FILE ||
    /portable/i.test(path.basename(process.execPath)));
  if (isPortable) {
    autoUpdater.channel = 'latest-portable'; // 读取 latest-portable.yml 而非 latest.yml
    const fsMod = require('fs');
    const osMod = require('os');
    const { spawn } = require('child_process');
    // 覆盖安装逻辑：下载完成后，退出前派生一个 detached 批处理，
    // 等本进程退出（解锁 exe）后把新文件覆盖到运行中的 portable exe 路径，再重启
    autoUpdater.doInstall = () => {
      const helper = autoUpdater.downloadedUpdateHelper;
      const newExe = helper && helper.file;
      const curExe = process.env.PORTABLE_EXECUTABLE_FILE;
      if (!newExe || !curExe) return false;
      const oldExe = curExe + '.old';
      const bat = path.join(osMod.tmpdir(), `xj-portable-update-${Date.now()}.bat`);
      const BOM = '﻿'; // UTF-8 BOM，确保 cmd 正确解析中文路径
      const lines = [
        '@echo off',
        'chcp 65001 >nul',
        'setlocal',
        ':wait',
        `tasklist /fi "PID eq ${process.pid}" | find " ${process.pid} " >nul`,
        'if %errorlevel%==0 (',
        '  timeout /t 1 /nobreak >nul',
        '  goto wait',
        ')',
        `if exist "${oldExe}" del /f /q "${oldExe}"`,
        `move /y "${curExe}" "${oldExe}"`,
        `copy /y "${newExe}" "${curExe}"`,
        `start "" "${curExe}"`,
        'endlocal',
      ];
      try {
        fsMod.writeFileSync(bat, BOM + lines.join('\r\n') + '\r\n');
        const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        app.isQuiting = true;
        app.quit();
        return true;
      } catch (e) {
        console.error('[auto-updater] portable self-replace failed:', e && e.message);
        return false;
      }
    };
  }

  autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    const notes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : (Array.isArray(info.releaseNotes) ? info.releaseNotes.map(n => n.note || '').join('\n') : '');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `心镜 XinJing 有新版本 v${info.version} 可用（当前 v${app.getVersion()}）。`,
      detail: notes ? `更新内容：\n${notes}\n\n是否现在下载并更新？` : '是否现在下载并更新？',
      buttons: ['立即更新', '稍后'],
      cancelId: 1,
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on('update-not-available', () => { /* 已是最新，静默 */ });

  autoUpdater.on('update-downloaded', () => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新就绪',
      message: '新版本已下载完成，重启后生效。',
      buttons: ['现在重启', '稍后重启'],
      cancelId: 1,
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater] error:', err && err.message);
  });

  // 启动 3 秒后再检查，避免阻塞首屏
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* 离线/无发布时忽略 */ });
  }, 3000);
}

function checkForUpdatesManual() {
  autoUpdater.checkForUpdates().catch(() => {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '检查更新',
        message: '暂时无法连接更新服务器，请检查网络后重试。'
      });
    }
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(APP_DIR)) {
    console.error('app 目录缺失:', APP_DIR);
    app.quit();
    return;
  }
  computeState(); // 启动即确定授权/试用状态
  PORT = await startStaticServer();
  createWindow();
  createTray();
  enableAutoStart();
  if (app.isPackaged) setupAutoUpdater(); // 仅在打包后启用自动更新（开发态跳过）
});

// ---- 激活窗口 ----
function openActivationWindow() {
  if (activationWindow) { activationWindow.focus(); return; }
  activationWindow = new BrowserWindow({
    width: 520,
    height: 620,
    minWidth: 420,
    minHeight: 540,
    parent: mainWindow || undefined,
    show: true,
    center: true,
    resizable: true,
    icon: path.join(BUILD_DIR, 'icon.png'),
    backgroundColor: '#f6f1ea',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  activationWindow.loadURL(`http://127.0.0.1:${PORT}/activation.html`);
  activationWindow.webContents.on('preload-error', (ev, err) => {
    console.error('[preload-error] activation window:', (err && err.stack) || err);
  });
  activationWindow.on('closed', () => { activationWindow = null; });
}

// ---- 授权相关 IPC ----
ipcMain.handle('xj:getState', () => licenseState || computeState());
ipcMain.handle('xj:getVersion', () => app.getVersion());
// 保存备份配置（多位置 + 邮箱），供 exportBackup 在退出/常驻时读取
ipcMain.handle('xj:saveBackupConfig', (e, cfg) => {
  try {
    fs.writeFileSync(path.join(userDataDir(), 'backup-config.json'), JSON.stringify(cfg || {}));
    return true;
  } catch (err) { console.error('[backup-config] save failed', err.message); return false; }
});
// 选择备份文件夹（自定义多位置容灾）
ipcMain.handle('xj:selectBackupFolder', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择备份位置' });
    return r.canceled ? null : (r.filePaths && r.filePaths[0]) || null;
  } catch (err) { console.error('[backup] select folder failed', err.message); return null; }
});

ipcMain.on('xj:openActivation', () => openActivationWindow());

// 关闭确认窗的抉择：cancel=取消退出(主窗口保持打开) / stay=后台常驻 / quit=完全退出
ipcMain.on('xj:closeDecision', (ev, action) => {
  if (closeConfirmWin) { try { closeConfirmWin.close(); } catch (_) {} closeConfirmWin = null; }
  if (action === 'cancel') {
    // 取消退出：仅关闭确认窗，主窗口保持原样打开，不隐藏、不退
    return;
  }
  exportBackup();   // 完全退出 / 后台常驻 都先导出一份数据备份（落盘到文档/心镜备份 + 自定义位置）
  if (action === 'quit') {
    app.isQuiting = true;
    app.quit();
  } else {
    if (mainWindow) mainWindow.hide();   // 后台常驻
  }
});

ipcMain.handle('xj:activate', (e, code) => {
  const v = license.verifyKey(code);
  if (!v.valid || !v.identity) {
    return { ok: false, error: '激活码无效，请核对后重试。' };
  }
  try {
    fs.writeFileSync(
      path.join(userDataDir(), 'license.json'),
      JSON.stringify({ identity: v.identity, tier: v.tier, activatedAt: Date.now() }, null, 2)
    );
  } catch (err) {
    return { ok: false, error: '保存激活信息失败：' + err.message };
  }
  computeState();
  return { ok: true, identity: v.identity, tier: v.tier };
});

ipcMain.on('xj:activationDone', () => {
  if (activationWindow) {
    try { activationWindow.close(); } catch (e) { /* ignore */ }
    activationWindow = null;
  }
  if (mainWindow) mainWindow.reload();
});

// 第二实例：聚焦已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // Windows 下保持运行（托盘常驻），不退出
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
  }
});
