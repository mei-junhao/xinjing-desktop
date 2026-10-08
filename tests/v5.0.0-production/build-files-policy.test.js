'use strict';
/**
 * build-files-policy.test.js — XinJing 5.0.0 生产构建 files 白名单策略测试
 *
 * 契约: XJ-5.0.0-G9-PRODUCTION-BUILD-FILES-POLICY-V1
 * 任务: XJ-5.0.0-g9-production-build-files-allowlist-hardening-001
 *
 * 覆盖（任务卡 §3）：
 *   1. 安全基线（真实仓库 source 阶段 PASS，默认入口加载根 electron-builder.yml）
 *   2. 缺配置必须失败
 *   3. 全仓库 include 必须失败
 *   4. docs/qa/run 进入白名单必须失败
 *   5. 五类 secret（.license-secret / .app-proxy-key / secret.generated.js /
 *      proxy-secret.generated.js / scripts/.cos-secret.ps1）逐一必须失败
 *   6. 编码（base64/XOR 风格）的 proxy-secret 仍然必须失败
 *   7. package version/main 变异必须失败
 *   8. 未知额外根文件必须失败
 *   9. packaged asar 实际目录检查（违规 asar FAIL / 合规 asar PASS）
 *  10. fail-closed commercial/Trial 行为（真实 require 生产 main.js，
 *      electron 打桩 + 屏蔽 proxy-secret.generated 模拟 packaged 缺凭据状态，
 *      真实调用 xj:commercial:getAccountBalance 与 xj:aiRequest，
 *      断言返回 fail-closed 契约且未发出任何 fetch）
 *
 * 运行: node --test tests/v5.0.0-production/build-files-policy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-build-files-policy.js');

function runVerifier(args, cwd) {
  const r = spawnSync(process.execPath, [VERIFIER, ...args], {
    cwd: cwd || ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) { /* 保留原始输出供断言 */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const REQUIRED_ROOT_FILES = [
  'package.json', 'main.js', 'preload.js', 'version.generated.js', 'cloud-verify.js',
  'confirm-close-preload.js', 'doc-chunker.js', 'license-core.js', 'license-public-keys.js',
  'license-revocations.json', 'rag-index.js', 'supervision-package-core.js',
  'supervision-package-public-keys.json',
];

const SAFE_YML = [
  'appId: com.mei.xinjing', 'productName: XinJing', 'asar: true', 'npmRebuild: false',
  'files:',
  ...REQUIRED_ROOT_FILES.map((f) => '  - ' + f),
  '  - build/icon.png', '  - build/icon.ico', '  - app/**/*',
  'win:', '  target:', '    - target: portable', '      arch: [x64]',
  'publish: null', '',
].join('\n');

/** 在 tmp 中构造一个与真实仓库同构（最小化）的 fixture 项目。 */
function makeFixture(name, opts) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-bfp-test-' + name + '-'));
  const repoPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkg = Object.assign({}, repoPkg, (opts && opts.pkg) || {});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (opts && opts.yml === null) { /* 不写 electron-builder.yml（缺配置场景） */ }
  else fs.writeFileSync(path.join(dir, 'electron-builder.yml'), (opts && opts.yml) || SAFE_YML);
  for (const rel of REQUIRED_ROOT_FILES) {
    if (rel === 'package.json') continue;
    fs.writeFileSync(path.join(dir, rel), '// fixture ' + rel);
  }
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  for (const h of ['index.html', 'settings.html', 'activation.html']) {
    fs.writeFileSync(path.join(dir, 'app', h), '<html></html>');
  }
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'icon.png'), 'PNG');
  fs.writeFileSync(path.join(dir, 'build', 'icon.ico'), 'ICO');
  // 危险文件（名称真实、内容为无凭据占位，绝不复制真实 secret 值）
  const dangers = {
    'docs/agent-note.md': 'fixture doc',
    'qa/runs/run-1/agent.log': 'fixture run log',
    'tests/fixture.test.js': '// fixture test',
    'scripts/tool.ps1': '# fixture script',
    'proxy-secret.generated.js': "module.exports={APP_PROXY_KEY:Buffer.from('fixture-encoded','utf8').toString('base64')};",
    'secret.generated.js': 'module.exports={FIXTURE:true};',
    '.license-secret': 'fixture-name-only',
    '.app-proxy-key': 'fixture-name-only',
    'scripts/.cos-secret.ps1': '# fixture-name-only',
    'stray-root-tool.js': '// unknown extra root file',
  };
  for (const [rel, content] of Object.entries(dangers)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function sourceAgainstFixture(fixtureDir) {
  return runVerifier(['--config', 'electron-builder.yml', '--phase', 'source', '--root', fixtureDir, '--out-dir', path.join(fixtureDir, 'dist')]);
}

test('T1 安全基线：真实仓库 source 阶段 PASS，默认入口加载根 electron-builder.yml', () => {
  const r = runVerifier(['--config', 'electron-builder.yml', '--phase', 'source']);
  assert.strictEqual(r.code, 0, 'source 阶段必须 exit 0；实际输出: ' + r.stdout.slice(0, 2000));
  assert.ok(r.json && r.json.ok === true, 'json.ok 必须为 true');
  const discovered = r.json.config && r.json.config.discovered_file;
  assert.strictEqual(discovered, path.join(ROOT, 'electron-builder.yml').replace(/\\/g, '/'), '默认入口必须自动加载根 electron-builder.yml');
  assert.ok(r.json.effective && r.json.effective.included_count > 0, '有效集合不能为空');
  for (const req of REQUIRED_ROOT_FILES) {
    assert.ok(r.json.effective.included.includes(req), '必需根生产文件必须进入有效集合: ' + req);
  }
  assert.strictEqual(r.json.violations.length, 0, 'violations 必须为空');
});

test('T2 缺配置：无 electron-builder.yml 且无 package.json build 键必须失败', () => {
  const dir = makeFixture('missing-config', { yml: null });
  const r = sourceAgainstFixture(dir);
  assert.strictEqual(r.code, 1);
  assert.match(JSON.stringify(r.json.violations), /未发现任何正式构建配置|解析失败/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T3 全仓库 include（**/*）必须失败', () => {
  const dir = makeFixture('all-repo', { yml: SAFE_YML.replace('files:', 'files:\n  - "**/*"') });
  const r = sourceAgainstFixture(dir);
  assert.strictEqual(r.code, 1);
  const v = JSON.stringify(r.json.violations);
  assert.match(v, /全仓库捕获模式/, '必须拒绝 **/* 捕获模式');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T4 docs/qa/run 进入白名单必须失败', () => {
  for (const extra of ['docs/**/*', 'qa/**/*', 'qa/runs/**/*']) {
    const dir = makeFixture('forbidden-dir', { yml: SAFE_YML.replace('files:', 'files:\n  - "' + extra + '"') });
    const r = sourceAgainstFixture(dir);
    assert.strictEqual(r.code, 1, '加入 ' + extra + ' 必须 FAIL');
    assert.match(JSON.stringify(r.json.violations), /forbidden|禁止/, '必须给出禁止目录违规: ' + extra);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T5 五类 secret 逐一进入白名单必须失败', () => {
  const secrets = ['.license-secret', '.app-proxy-key', 'secret.generated.js', 'proxy-secret.generated.js', 'scripts/.cos-secret.ps1'];
  for (const s of secrets) {
    const dir = makeFixture('secret', { yml: SAFE_YML.replace('files:', 'files:\n  - "' + s + '"') });
    const r = sourceAgainstFixture(dir);
    assert.strictEqual(r.code, 1, '加入 ' + s + ' 必须 FAIL');
    assert.match(JSON.stringify(r.json.violations), new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '必须点名拒绝: ' + s);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T6 编码后的 proxy-secret（base64/XOR 风格可逆编码）仍必须失败', () => {
  const dir = makeFixture('encoded-proxy', { yml: SAFE_YML.replace('files:', 'files:\n  - proxy-secret.generated.js') });
  // fixture 内容已是 base64 可逆编码形态；策略必须按名称+路径拒绝，与内容编码无关
  const r = sourceAgainstFixture(dir);
  assert.strictEqual(r.code, 1);
  assert.match(JSON.stringify(r.json.violations), /proxy-secret\.generated\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T7 package version/main 变异必须失败', () => {
  const dirV = makeFixture('version', { yml: SAFE_YML, pkg: { version: '4.2.4' } });
  const rv = sourceAgainstFixture(dirV);
  assert.strictEqual(rv.code, 1);
  assert.match(JSON.stringify(rv.json.violations), /version 漂移/);
  fs.rmSync(dirV, { recursive: true, force: true });

  const dirM = makeFixture('main', { yml: SAFE_YML, pkg: { main: 'bootstrap.js' } });
  const rm = sourceAgainstFixture(dirM);
  assert.strictEqual(rm.code, 1);
  assert.match(JSON.stringify(rm.json.violations), /main 漂移/);
  fs.rmSync(dirM, { recursive: true, force: true });
});

test('T8 未知额外根文件进入白名单必须失败', () => {
  const dir = makeFixture('stray', { yml: SAFE_YML.replace('files:', 'files:\n  - stray-root-tool.js') });
  const r = sourceAgainstFixture(dir);
  assert.strictEqual(r.code, 1);
  assert.match(JSON.stringify(r.json.violations), /stray-root-tool\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T9 packaged asar 实际目录：违规 asar FAIL / 合规 asar PASS', async () => {
  const asar = require(path.join(ROOT, 'node_modules/@electron/asar'));
  const repoPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // 违规 asar：含 docs/ + proxy-secret.generated.js
  const badTree = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-bfp-badasar-'));
  fs.mkdirSync(path.join(badTree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(badTree, 'docs', 'note.md'), 'x');
  fs.writeFileSync(path.join(badTree, 'proxy-secret.generated.js'), 'module.exports={};');
  fs.writeFileSync(path.join(badTree, 'package.json'), JSON.stringify(repoPkg, null, 2));
  const badAsar = path.join(badTree, 'app.asar');
  await asar.createPackage(badTree, badAsar);
  const rb = runVerifier(['--phase', 'packaged', '--asar', badAsar]);
  assert.strictEqual(rb.code, 1, '违规 asar 必须 FAIL');
  assert.match(JSON.stringify(rb.json.violations), /proxy-secret\.generated\.js/);
  assert.match(JSON.stringify(rb.json.violations), /docs/);

  // 合规 asar：精确 allowlist（13 根文件 + app 路由 + build 图标 + node_modules 示例）
  const goodTree = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-bfp-goodasar-'));
  for (const rel of REQUIRED_ROOT_FILES) {
    if (rel === 'package.json') { fs.writeFileSync(path.join(goodTree, rel), JSON.stringify(repoPkg, null, 2)); continue; }
    fs.writeFileSync(path.join(goodTree, rel), '// fixture');
  }
  fs.mkdirSync(path.join(goodTree, 'app'), { recursive: true });
  for (const h of ['index.html', 'settings.html', 'activation.html']) fs.writeFileSync(path.join(goodTree, 'app', h), '<html></html>');
  fs.mkdirSync(path.join(goodTree, 'build'), { recursive: true });
  fs.writeFileSync(path.join(goodTree, 'build', 'icon.png'), 'PNG');
  fs.writeFileSync(path.join(goodTree, 'build', 'icon.ico'), 'ICO');
  fs.mkdirSync(path.join(goodTree, 'node_modules', 'example-dep'), { recursive: true });
  fs.writeFileSync(path.join(goodTree, 'node_modules', 'example-dep', 'index.js'), '// prod dep');
  const goodAsar = path.join(goodTree, 'app.asar');
  await asar.createPackage(goodTree, goodAsar);
  const rg = runVerifier(['--phase', 'packaged', '--asar', goodAsar]);
  assert.strictEqual(rg.code, 0, '合规 asar 必须 PASS: ' + rg.stdout.slice(0, 2000));
  assert.strictEqual(rg.json.secret_scan.count, 0);

  fs.rmSync(badTree, { recursive: true, force: true });
  fs.rmSync(goodTree, { recursive: true, force: true });
});

test('T10 fail-closed：packaged 缺 APP_PROXY_KEY 时商业余额与 Trial AI 真实行为契约', async () => {
  // —— 真实加载生产 main.js：electron 打桩 + 屏蔽 proxy-secret.generated（模拟 packaged 缺文件）——
  const Module = require('node:module');
  const tmpBase = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-bfp-failclosed-'));
  const userData = path.join(tmpBase, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  process.env.XJ_AGENT_ACCEPTANCE = '1';
  process.env.XJ_AGENT_ACCEPTANCE_USER_DATA = userData;

  const ipcHandlers = new Map();
  const ipcOn = new Map();
  const electronStub = {
    app: {
      getPath: (k) => path.join(tmpBase, k),
      setPath: () => {},
      whenReady: () => new Promise(() => {}), // 永不 resolve：不触发窗口/服务器启动
      on: () => {}, once: () => {}, off: () => {},
      getVersion: () => '5.0.0',
      getName: () => 'XinJing',
      setName: () => {},
      setAppUserModelId: () => {},
      disableHardwareAcceleration: () => {},
      requestSingleInstanceLock: () => true,
      quit: () => {}, exit: () => {},
      isPackaged: false,
      quitReason: null,
      commandLine: { appendSwitch: () => {} },
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send() {}, on() {}, session: {} }; }
      loadFile() {} loadURL() {} on() {} once() {} show() {} focus() {} restore() {} isMinimized() { return false; }
      static getAllWindows() { return []; }
    },
    Tray: class { constructor() {} on() {} setToolTip() {} setContextMenu() {} destroy() {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({}) },
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    ipcMain: {
      handle: (ch, fn) => ipcHandlers.set(ch, fn),
      on: (ch, fn) => ipcOn.set(ch, fn),
      once: (ch, fn) => ipcOn.set('once:' + ch, fn),
      removeHandler: () => {},
    },
    net: { request: () => { throw new Error('network disabled in fail-closed test'); } },
    shell: { openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './proxy-secret.generated' && parent && parent.filename && parent.filename.endsWith('main.js')) {
      const err = new Error("Cannot find module './proxy-secret.generated' (packaged fail-closed simulation)");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return origLoad.apply(this, arguments);
  };

  // fetch 间谍：任何真实网络调用都会被记录（fail-closed 契约要求零调用）
  const fetchCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { fetchCalls.push(String(a[0])); return Promise.reject(new Error('network disabled')); };

  try {
    require(path.join(ROOT, 'main.js')); // 真实生产入口模块
    const trustedEvent = () => ({
      senderFrame: { url: 'http://127.0.0.1:0/index.html' }, // PORT 未启动=0，isTrustedRendererEvent 语义内受信
      sender: { id: 7, isDestroyed: () => false },
    });

    // 商业余额：缺 APP_PROXY_KEY => { ok:false, errorCode:'server-balance-unavailable', retryable:false }
    const balanceHandler = ipcHandlers.get('xj:commercial:getAccountBalance');
    assert.ok(typeof balanceHandler === 'function', 'xj:commercial:getAccountBalance handler 必须已注册');
    const balance = await balanceHandler(trustedEvent(), {});
    assert.deepStrictEqual(
      { ok: balance.ok, errorCode: balance.errorCode, retryable: balance.retryable },
      { ok: false, errorCode: 'server-balance-unavailable', retryable: false },
      '商业余额必须 fail-closed 且不可重试: ' + JSON.stringify(balance)
    );

    // Trial AI：缺 APP_PROXY_KEY => { ok:false, error:{code:'XJ_AI_PROXY_UNAVAILABLE'} }
    const aiHandler = ipcHandlers.get('xj:aiRequest');
    assert.ok(typeof aiHandler === 'function', 'xj:aiRequest handler 必须已注册');
    const trial = await aiHandler(trustedEvent(), {
      requestId: 'failclosedtrial00000001', kind: 'quota', config: { isTrial: true },
    });
    assert.ok(trial && trial.ok === false, 'Trial AI 必须失败: ' + JSON.stringify(trial));
    assert.strictEqual(trial.error && trial.error.code, 'XJ_AI_PROXY_UNAVAILABLE', '错误码必须是 XJ_AI_PROXY_UNAVAILABLE');

    // 零网络：两条 fail-closed 路径都不得触发任何 fetch（不发出真实非回环请求）
    assert.strictEqual(fetchCalls.length, 0, 'fail-closed 路径不得发起任何 fetch: ' + JSON.stringify(fetchCalls));
  } finally {
    Module._load = origLoad;
    globalThis.fetch = origFetch;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
