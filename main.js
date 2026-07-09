'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
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
let licenseState = null; // {mode, identity, daysLeft, activated, trialDays, version}

// ---- 授权与试用状态 ----
function userDataDir() { return app.getPath('userData'); }
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
  licenseState = {
    mode: license.overallMode(activated, trial),
    identity: activated ? lic.identity : '',
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
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
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
      webSecurity: false, // 允许 AI 功能向外部 API 发请求（本地单用户工具，可接受）
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/index.html`);

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  // 关闭 → 最小化到托盘，而非退出
  mainWindow.on('close', (e) => {
    if (!app.isQuiting && mainWindow) {
      e.preventDefault();
      mainWindow.hide();
    }
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

  // 便携版（绿色免安装单文件）：走独立的 latest-portable.yml 更新通道，并就地自我替换
  // electron-updater 6.x 不识别 portable 通道，也不具备 exe 自替换能力，这里手动补齐
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
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
  activationWindow.on('closed', () => { activationWindow = null; });
}

// ---- 授权相关 IPC ----
ipcMain.handle('xj:getState', () => licenseState || computeState());

ipcMain.on('xj:openActivation', () => openActivationWindow());

ipcMain.handle('xj:activate', (e, code) => {
  const v = license.verifyKey(code);
  if (!v.valid || !v.identity) {
    return { ok: false, error: '激活码无效，请核对后重试。' };
  }
  try {
    fs.writeFileSync(
      path.join(userDataDir(), 'license.json'),
      JSON.stringify({ identity: v.identity, activatedAt: Date.now() }, null, 2)
    );
  } catch (err) {
    return { ok: false, error: '保存激活信息失败：' + err.message };
  }
  computeState();
  return { ok: true, identity: v.identity };
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
