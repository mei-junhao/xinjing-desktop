#!/usr/bin/env node
'use strict';
/**
 * verify-build-files-policy.js — XinJing 5.0.0 生产构建 files 白名单策略验证器（正式版）
 *
 * 契约: XJ-5.0.0-G9-PRODUCTION-BUILD-FILES-POLICY-V1
 * 任务: XJ-5.0.0-g9-production-build-files-allowlist-hardening-001
 *
 * 真实解析，不做 YAML 字符串 grep：
 *  - 配置发现：read-config-file.getConfig（app-builder-lib 内部使用的同一入口，
 *    packageKey="build", configFilename="electron-builder"），证明默认入口自动加载哪个文件；
 *  - 配置合并/校验：app-builder-lib/out/util/config.js getConfig + validateConfig；
 *  - 有效文件策略：app-builder-lib/out/fileMatcher.js getMainFileMatchers（真实 matcher 注入逻辑）
 *    + createFilter，再对真实工作树做与 electron-builder readDir 同语义的遍历，
 *    得到"如果现在构建，哪些文件会进入 app.asar"的有效集合；
 *  - packaged 阶段：@electron/asar listPackage/extractFile 检查最终 app.asar 实际目录。
 *
 * 用法:
 *   node scripts/verify-build-files-policy.js --phase source [--config electron-builder.yml] [--root <dir>] [--out-dir <dir>]
 *   node scripts/verify-build-files-policy.js --phase packaged --asar <app.asar 路径> [--root <dir>]
 *   node scripts/verify-build-files-policy.js --mode expected-red [--root <dir>]
 *
 * 退出码: 0=PASS, 1=FAIL（含策略违规）, 2=用法错误。
 * 输出: stdout 打印 JSON 证据（violations 中只含路径/模式/结论，绝不打印 secret 内容）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 验证器所在仓库根（fixture 目录没有 node_modules，真实解析器必须从这里加载）
const HOST_ROOT = path.resolve(__dirname, '..');

// 静默 builder-util 日志（否则 "• loaded configuration" 等行会污染 stdout 的 JSON 证据）
try {
  const builderLog = require(path.join(HOST_ROOT, 'node_modules/builder-util/out/log.js'));
  builderLog.log.stream = { write() {} };
} catch (e) { /* 忽略：日志静默失败不影响验证 */ }

const EXPECTED_NAME = 'xinjing';
const EXPECTED_VERSION = '5.1.13';
const EXPECTED_MAIN = 'main.js';

// 正向 allowlist：根级生产文件（精确集合，任何其它根文件进入 app.asar 均视为违规）
const REQUIRED_ROOT_FILES = [
  'package.json',
  'main.js',
  'preload.js',
  'version.generated.js',
  'cloud-verify.js',
  'confirm-close-preload.js',
  'doc-chunker.js',
  'license-core.js',
  'license-public-keys.js',
  'license-revocations.json',
  'rag-index.js',
  'supervision-package-core.js',
  'supervision-package-public-keys.json',
];
// build 目录下允许进入 app.asar 的文件（构建资源图标随包分发）
const ALLOWED_BUILD_FILE = /^build\/icon\.(png|ico)$/;

// secret-bearing 精确名单（无条件禁止进入 app.asar / unpacked / portable）
const SECRET_FILES = [
  '.license-secret',
  '.app-proxy-key',
  'secret.generated.js',
  'proxy-secret.generated.js',
  'scripts/.cos-secret.ps1',
];
// 通用 secret 样文件名扫描（大小写不敏感；用于 asar 全量扫描）
const SECRET_NAME_RE = /(^|[\\/])(\.license-secret|\.app-proxy-key|secret\.generated\.js|proxy-secret\.generated\.js|\.cos-secret\.ps1|\.env|\.env\.[a-z0-9._-]+|credential[a-z0-9._-]*\.(json|txt|js)|[a-z0-9._-]+\.(pem|p12|pfx|key))$/i;
// 禁止顶层目录（无条件）
const FORBIDDEN_TOP_DIRS = ['docs', 'qa', 'tests', 'scripts', '.git', '.claude', '.pi', '.trae', '.codex', '.husky', '.github'];

function norm(p) { return String(p).replace(/\\/g, '/'); }

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(2);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[k] = argv[i + 1]; i++; } else { a[k] = true; }
  }
  return a;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/**
 * 检查单个相对路径是否符合正向 allowlist。
 * 返回 null = 合规；返回字符串 = 违规原因。
 */
function classifyPath(rel) {
  const r = norm(rel);
  if (SECRET_FILES.includes(r)) return 'secret-bearing file matched: ' + r;
  if (SECRET_NAME_RE.test(r)) return 'secret-like name matched: ' + r;
  if (REQUIRED_ROOT_FILES.includes(r)) return null;
  if (ALLOWED_BUILD_FILE.test(r)) return null;
  if (r.startsWith('app/')) {
    if (r === 'app/') return 'empty app path';
    return null; // app/** 生产资源由 app/**/* 正向包含
  }
  const top = r.split('/')[0];
  if (FORBIDDEN_TOP_DIRS.includes(top)) return 'forbidden top-level directory included: ' + r;
  return 'path outside positive allowlist: ' + r;
}

/**
 * 真实配置发现 + 合并（app-builder-lib 同一代码路径）。
 * 返回 { config, discoveredFile, packageBuildKey }。
 */
async function resolveConfig(root) {
  // 始终使用 configPath=null：这正是 electron-builder CLI 的默认配置发现路径
  // （package.json build 键 -> electron-builder.{yml,yaml,json,json5,js,ts}），
  // 验证器必须证明默认入口自动加载的是根 electron-builder.yml。
  const { getConfig: discover } = require(require.resolve('read-config-file', { paths: [HOST_ROOT] }));
  const { getConfig, validateConfig } = require(path.join(HOST_ROOT, 'node_modules/app-builder-lib/out/util/config.js'));
  const lazyPkg = { value: Promise.resolve(readJsonSafe(path.join(root, 'package.json'))) };
  const packageMetadata = { get value() { return lazyPkg.value; } };
  const discovered = await discover(
    { packageKey: 'build', configFilename: 'electron-builder', projectDir: root, packageMetadata },
    null
  );
  const config = await getConfig(root, null, null, packageMetadata);
  const debugLogger = { isEnabled: false, add() {} };
  await validateConfig(config, debugLogger);
  return {
    config,
    discoveredFile: discovered && discovered.configFile ? norm(discovered.configFile) : null,
    discoveredFromPackageKey: !!(discovered && discovered.configFile == null),
  };
}

/**
 * 用真实 getMainFileMatchers + createFilter 计算有效包含集合。
 */
function computeEffectiveSet(root, config, outDir) {
  const { getMainFileMatchers } = require(path.join(HOST_ROOT, 'node_modules/app-builder-lib/out/fileMatcher.js'));
  const appDir = root;
  const destination = path.join(root, '__effective_dest__'); // 仅用于 matcher 构造，不落盘
  const macroExpander = (s) => s; // 正式配置的 files 中禁止宏；由调用方检查
  const platformPackager = {
    info: {
      projectDir: root,
      buildResourcesDir: path.resolve(root, (config.directories && config.directories.buildResources) || 'build'),
      isPrepackedAppAsar: false,
      config,
      debugLogger: { isEnabled: false, add() {} },
    },
  };
  const matchers = getMainFileMatchers(appDir, destination, macroExpander, config.win || {}, platformPackager, outDir || path.join(root, 'dist'), false);
  const matcher = matchers[0];
  const filter = matcher.createFilter();

  const included = [];
  const skippedTopDirs = [];
  const SKIP_ALWAYS = new Set(['.git', 'node_modules']);
  function walk(abs, rel) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      const isDir = ent.isDirectory();
      const stat = { isDirectory: () => isDir, isFile: () => ent.isFile() };
      let keep = false;
      try { keep = filter(childAbs, stat); } catch (e) { keep = false; }
      if (!keep) {
        if (!rel && isDir && SKIP_ALWAYS.has(ent.name)) continue;
        if (!rel && isDir) skippedTopDirs.push(childRel);
        continue; // 与 electron-builder readDir 同语义：被过滤的目录不进入、不下钻
      }
      if (isDir) { walk(childAbs, childRel); continue; }
      if (ent.isFile()) included.push(childRel);
    }
  }
  walk(root, '');
  included.sort((a, b) => a.localeCompare(b));
  return { patterns: matcher.patterns.slice(), included, skippedTopDirs };
}

/** 正向 allowlist 结构性检查（对 config.files 本身）。 */
function checkFilesPolicyShape(config, violations) {
  const files = config.files;
  if (!Array.isArray(files) || files.length === 0) {
    violations.push('config.files 缺失或为空 => electron-builder 将回退为默认全仓库包含 (**/*)');
    return;
  }
  const positive = [];
  for (const item of files) {
    if (typeof item !== 'string') {
      violations.push('config.files 含对象形式条目（本契约只接受字符串正向白名单）: ' + JSON.stringify(item));
      continue;
    }
    if (item.includes('${')) {
      violations.push('config.files 模式包含宏（禁止）: ' + item);
      continue;
    }
    if (!item.startsWith('!')) positive.push(item);
  }
  if (positive.length === 0) {
    violations.push('config.files 全为排除模式 => 等价于默认全仓库包含，违反正向白名单契约');
  }
  for (const p of positive) {
    const bare = p.replace(/^\.\//, '');
    if (bare === '**/*' || bare === '**' || bare === '*' || bare === '**/**') {
      violations.push('config.files 含全仓库捕获模式（禁止 denylist 风格）: ' + p);
    }
  }
}

/** source 阶段主检查。root 支持 fixture 目录。 */
async function phaseSource(root, expectedConfigPath, outDir) {
  const violations = [];
  const evidence = { phase: 'source', root: norm(root), at: new Date().toISOString(), violations };

  // 1) package.json 语义（version/main/name）
  const pkg = readJsonSafe(path.join(root, 'package.json'));
  evidence.package_json = {
    exists: !!pkg,
    name: pkg && pkg.name, version: pkg && pkg.version, main: pkg && pkg.main,
    has_build_key: !!(pkg && pkg.build),
    dist_script: pkg && pkg.scripts && pkg.scripts.dist,
    dependencies: pkg ? Object.keys(pkg.dependencies || {}) : null,
    devDependencies: pkg ? Object.keys(pkg.devDependencies || {}) : null,
  };
  if (!pkg) violations.push('package.json 缺失');
  else {
    if (pkg.build != null) violations.push('package.json 存在 build 键（正式配置必须只存在于根 electron-builder.yml）');
    if (pkg.name !== EXPECTED_NAME) violations.push(`package.json name 漂移: ${pkg.name} != ${EXPECTED_NAME}`);
    if (pkg.version !== EXPECTED_VERSION) violations.push(`package.json version 漂移: ${pkg.version} != ${EXPECTED_VERSION}`);
    if (pkg.main !== EXPECTED_MAIN) violations.push(`package.json main 漂移: ${pkg.main} != ${EXPECTED_MAIN}`);
    const dist = String((pkg.scripts || {}).dist || '');
    if (dist.trim() !== 'electron-builder') {
      violations.push(`scripts.dist 不是裸 electron-builder（可能绕过默认配置发现）: ${dist}`);
    }
  }

  // 2) 默认配置发现 + 真实解析
  let resolved = null;
  try {
    resolved = await resolveConfig(root);
  } catch (e) {
    violations.push('正式构建配置解析失败: ' + String(e && e.message || e));
  }
  if (resolved) {
    evidence.config = {
      discovered_file: resolved.discoveredFile,
      discovered_from_package_build_key: resolved.discoveredFromPackageKey,
      appId: resolved.config.appId,
      productName: resolved.config.productName,
      asar: resolved.config.asar,
      npmRebuild: resolved.config.npmRebuild,
      directories: resolved.config.directories || null,
      win_target: resolved.config.win && resolved.config.win.target,
      portable: resolved.config.portable || null,
      publish: resolved.config.publish === undefined ? 'undefined' : resolved.config.publish,
      files: resolved.config.files || null,
    };
    // 默认入口必须加载根 electron-builder.yml（而不是 package.json build 键或任何其它文件）
    const expectedYml = norm(path.join(root, expectedConfigPath || 'electron-builder.yml'));
    if (!resolved.discoveredFile) {
      violations.push('未发现任何正式构建配置（默认入口找不到 electron-builder.yml，也不允许 package.json build 键）');
    } else if (resolved.discoveredFile !== expectedYml) {
      violations.push(`默认入口加载了非预期配置: ${resolved.discoveredFile} != ${expectedYml}`);
    }
    if (resolved.config.asar !== true) violations.push('asar 必须为 true（app.asar 边界）');
    if (resolved.config.npmRebuild !== false) violations.push('npmRebuild 必须为 false（固定本地缓存离线构建语义）');
    if (!resolved.config.appId) violations.push('appId 缺失');
    if (!resolved.config.productName) violations.push('productName 缺失');
    const wt = resolved.config.win && resolved.config.win.target;
    const wtJson = JSON.stringify(wt || null);
    if (!/portable/.test(wtJson) || !/x64/.test(wtJson)) violations.push('win.target 必须固定 portable x64: ' + wtJson);

    // 3) files 正向白名单结构检查（对原始 YAML 做 js-yaml 真实解析；
    //    getConfig 会把字符串数组规范化为 {filter:[...]}，结构契约必须看原始形态）
    const rawYmlPath = path.join(root, expectedConfigPath || 'electron-builder.yml');
    let rawYml = null;
    if (fs.existsSync(rawYmlPath)) {
      try {
        const yaml = require(path.join(HOST_ROOT, 'node_modules/js-yaml'));
        rawYml = yaml.load(fs.readFileSync(rawYmlPath, 'utf8'));
      } catch (e) {
        violations.push('正式 YAML 解析失败: ' + String(e && e.message || e));
      }
    }
    evidence.raw_files = rawYml ? rawYml.files || null : null;
    checkFilesPolicyShape(rawYml || {}, violations);

    // 4) 有效集合（真实 matcher + 真实工作树）
    const eff = computeEffectiveSet(root, resolved.config, outDir);
    evidence.effective = {
      patterns: eff.patterns,
      included_count: eff.included.length,
      included: eff.included.slice(0, 400),
      skipped_top_dirs: eff.skippedTopDirs,
    };
    for (const rel of eff.included) {
      const v = classifyPath(rel);
      if (v) violations.push(v);
    }
    // 必需文件必须被包含
    for (const req of REQUIRED_ROOT_FILES) {
      if (!eff.included.includes(req)) violations.push('必需根生产文件未进入有效集合: ' + req);
    }
    for (const reqApp of ['app/index.html', 'app/settings.html', 'app/activation.html']) {
      if (!eff.included.includes(reqApp)) violations.push('必需 app 路由未进入有效集合: ' + reqApp);
    }
    if (!eff.included.some((r) => ALLOWED_BUILD_FILE.test(r))) violations.push('build/icon.* 未进入有效集合');
    // secret 显式名单核对（冗余但独立于 classifyPath 的证据）
    for (const s of SECRET_FILES) {
      if (eff.included.includes(s)) violations.push('secret-bearing 文件进入有效集合: ' + s);
    }
  }

  evidence.ok = violations.length === 0;
  evidence.verdict = evidence.ok ? 'PASS' : 'FAIL';
  return evidence;
}

/** packaged 阶段：检查最终 app.asar 实际目录。 */
async function phasePackaged(root, asarPath) {
  const violations = [];
  const evidence = { phase: 'packaged', root: norm(root), asar: norm(asarPath), at: new Date().toISOString(), violations };
  if (!fs.existsSync(asarPath)) { violations.push('app.asar 不存在: ' + asarPath); evidence.ok = false; evidence.verdict = 'FAIL'; return evidence; }

  const asar = require(path.join(HOST_ROOT, 'node_modules/@electron/asar'));
  const rawEntries = asar.listPackage(asarPath);
  const allEntries = rawEntries.map((e) => norm(e).replace(/^\//, '')).filter(Boolean).sort((a, b) => a.localeCompare(b));
  // listPackage 同时返回目录条目；派生目录集合，文件清单只保留真正的文件
  const dirSet = new Set();
  for (const e of allEntries) {
    const parts = e.split('/');
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
  }
  const entries = allEntries.filter((e) => !dirSet.has(e));
  evidence.entry_count = allEntries.length;
  evidence.file_count = entries.length;

  // 1) 全量白名单核对（asar 内 node_modules 为 builder 生产依赖修剪结果，允许）
  const rootFiles = [];
  const topDirs = new Set();
  for (const rel of entries) {
    if (rel.includes('/')) { topDirs.add(rel.split('/')[0]); continue; }
    rootFiles.push(rel);
    const v = classifyPath(rel);
    if (v) violations.push(v);
  }
  evidence.root_files = rootFiles;
  evidence.top_dirs = Array.from(topDirs).sort();
  for (const d of topDirs) {
    if (FORBIDDEN_TOP_DIRS.includes(d)) violations.push('app.asar 含禁止顶层目录: ' + d + '/');
    else if (!['app', 'build', 'node_modules'].includes(d)) violations.push('app.asar 含白名单外顶层目录: ' + d + '/');
  }

  // 2) 全量 secret 扫描（文件名层；大小写不敏感；含 node_modules 深处；扫全部条目含目录名）
  const secretHits = allEntries.filter((e) => SECRET_NAME_RE.test(e) || SECRET_FILES.some((s) => e === s || e.endsWith('/' + s)));
  evidence.secret_scan = { hits: secretHits, count: secretHits.length };
  if (secretHits.length > 0) violations.push('app.asar secret 扫描命中: ' + secretHits.join(', '));
  if (entries.includes('proxy-secret.generated.js')) violations.push('proxy-secret.generated.js 出现在 app.asar（即使内容被编码也禁止）');

  // 3) 必需根文件存在且与 allowlist 完全一致（无未知额外根文件）
  for (const req of REQUIRED_ROOT_FILES) {
    if (!entries.includes(req)) violations.push('app.asar 缺少必需根生产文件: ' + req);
  }
  for (const rf of rootFiles) {
    if (!REQUIRED_ROOT_FILES.includes(rf)) violations.push('app.asar 出现未知额外根文件: ' + rf);
  }
  for (const reqApp of ['app/index.html', 'app/settings.html', 'app/activation.html']) {
    if (!entries.includes(reqApp)) violations.push('app.asar 缺少必需路由: ' + reqApp);
  }

  // 4) packaged package.json 语义（builder 规范化可接受：剥离 devDependencies 等；
  //    但 name/version/main/dependencies 必须与仓库 package.json 语义一致，拒绝版本或入口漂移）
  try {
    const buf = asar.extractFile(asarPath, 'package.json');
    const packaged = JSON.parse(buf.toString('utf8'));
    const repo = readJsonSafe(path.join(root, 'package.json')) || {};
    const sem = {
      name_eq: packaged.name === repo.name,
      version_eq: packaged.version === repo.version,
      main_eq: packaged.main === repo.main,
      dependencies_eq: JSON.stringify(packaged.dependencies || null) === JSON.stringify(repo.dependencies || null),
      packaged_devDependencies: packaged.devDependencies === undefined ? 'absent' : 'present',
      packaged_version: packaged.version,
      packaged_main: packaged.main,
    };
    evidence.package_json_semantic = sem;
    if (!sem.name_eq) violations.push(`packaged package.json name 漂移: ${packaged.name} != ${repo.name}`);
    if (!sem.version_eq) violations.push(`packaged package.json version 漂移: ${packaged.version} != ${repo.version}`);
    if (!sem.main_eq) violations.push(`packaged package.json main 漂移: ${packaged.main} != ${repo.main}`);
    if (!sem.dependencies_eq) violations.push('packaged package.json dependencies 与仓库不一致');
    if (packaged.version !== EXPECTED_VERSION) violations.push(`packaged version != ${EXPECTED_VERSION}`);
    if (packaged.main !== EXPECTED_MAIN) violations.push(`packaged main != ${EXPECTED_MAIN}`);
  } catch (e) {
    violations.push('无法读取 packaged package.json: ' + String(e && e.message || e));
  }

  evidence.ok = violations.length === 0;
  evidence.verdict = evidence.ok ? 'PASS' : 'FAIL';
  return evidence;
}

/**
 * expected-red：不安全 fixture 必须全部被拒绝；安全基线 fixture 必须通过
 * （防止验证器"拒绝一切"式假绿）。
 */
async function modeExpectedRed(root) {
  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-bfp-red-'));
  const results = [];
  const dangerFiles = {
    'docs/agent-note.md': 'fixture doc',
    'qa/runs/run-1/secret-carrying.log': 'fixture run log',
    'tests/fixture.test.js': '// fixture test',
    'scripts/.cos-secret.ps1': '# fixture cos secret name only',
    'proxy-secret.generated.js': "module.exports={APP_PROXY_KEY:Buffer.from('Zml4dHVyZS1lbmNvZGVk','base64').toString('base64')};",
    'secret.generated.js': 'module.exports={FIXTURE:true};',
    '.license-secret': 'fixture-license-secret-name-only',
    '.app-proxy-key': 'fixture-app-proxy-key-name-only',
    'stray-root-tool.js': '// unknown extra root file',
    '_tmp_agent_scratch.js': '// scratch',
  };
  function makeFixture(name, yml, pkgMut) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const pkg = Object.assign({
      name: EXPECTED_NAME, version: EXPECTED_VERSION, main: EXPECTED_MAIN, private: true,
      dependencies: { 'electron-updater': '^6.3.9' }, devDependencies: { electron: '43.2.0' },
      scripts: { dist: 'electron-builder' },
    }, pkgMut || {});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    if (yml !== null) fs.writeFileSync(path.join(dir, 'electron-builder.yml'), yml);
    for (const [rel, content] of Object.entries(dangerFiles)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    for (const rel of REQUIRED_ROOT_FILES) {
      if (!fs.existsSync(path.join(dir, rel))) fs.writeFileSync(path.join(dir, rel), '// fixture ' + rel);
    }
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    for (const h of ['index.html', 'settings.html', 'activation.html']) fs.writeFileSync(path.join(dir, 'app', h), '<html></html>');
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'icon.png'), 'PNG');
    fs.writeFileSync(path.join(dir, 'build', 'icon.ico'), 'ICO');
    return dir;
  }
  const safeYml = [
    'appId: com.mei.xinjing', 'productName: XinJing', 'asar: true', 'npmRebuild: false',
    'files:',
    ...REQUIRED_ROOT_FILES.map((f) => '  - ' + f),
    '  - build/icon.png', '  - build/icon.ico', '  - app/**/*',
    'win:', '  target:', '    - target: portable', '      arch: [x64]',
    'publish: null', '',
  ].join('\n');

  async function runCase(id, name, fixtureDir, expectPass) {
    let ev;
    try { ev = await phaseSource(fixtureDir, 'electron-builder.yml', path.join(fixtureDir, 'dist')); }
    catch (e) { ev = { verdict: 'ERROR', violations: [String(e && e.message || e)], ok: false }; }
    const asExpected = expectPass ? ev.verdict === 'PASS' : ev.verdict === 'FAIL';
    results.push({ id, name, expected: expectPass ? 'PASS(reject=null)' : 'FAIL(rejected)', actual: ev.verdict, as_expected: asExpected, violations: (ev.violations || []).slice(0, 8) });
  }

  await runCase('F0', '安全基线（正向白名单）必须通过', makeFixture('F0-safe', safeYml), true);
  await runCase('F1', '缺少正式构建配置必须失败', makeFixture('F1-missing', null), false);
  await runCase('F2', '全仓库 **/* 包含必须失败', makeFixture('F2-all', safeYml.replace('files:', 'files:\n  - "**/*"')), false);
  await runCase('F3', '加入 docs/qa 禁止目录必须失败', makeFixture('F3-docs', safeYml.replace('files:', 'files:\n  - docs/**/*\n  - qa/**/*')), false);
  await runCase('F4', '包含 proxy-secret.generated.js（编码内容）必须失败', makeFixture('F4-proxy', safeYml.replace('files:', 'files:\n  - proxy-secret.generated.js')), false);
  await runCase('F5', '仅 !secret.generated.js 但仍允许 docs/qa/runs 必须失败', makeFixture('F5-negonly', 'appId: com.mei.xinjing\nproductName: XinJing\nasar: true\nnpmRebuild: false\nfiles:\n  - "!secret.generated.js"\nwin:\n  target:\n    - target: portable\n      arch: [x64]\npublish: null\n'), false);
  await runCase('F6', 'package version 变异必须失败', makeFixture('F6-version', safeYml, { version: '4.2.4' }), false);
  await runCase('F7', 'package main 变异必须失败', makeFixture('F7-main', safeYml, { main: 'bootstrap.js' }), false);
  await runCase('F8', '未知额外根文件进入白名单必须失败', makeFixture('F8-stray', safeYml.replace('files:', 'files:\n  - stray-root-tool.js')), false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const allOk = results.every((r) => r.as_expected);
  return { mode: 'expected-red', at: new Date().toISOString(), results, ok: allOk, verdict: allOk ? 'PASS' : 'FAIL' };
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.root || process.cwd());
  if (args.mode === 'expected-red') {
    const ev = await modeExpectedRed(root);
    console.log(JSON.stringify(ev, null, 2));
    process.exit(ev.ok ? 0 : 1);
  }
  const phase = args.phase || 'source';
  if (phase === 'source') {
    const ev = await phaseSource(root, typeof args.config === 'string' ? args.config : null, args['out-dir'] ? path.resolve(args['out-dir']) : null);
    console.log(JSON.stringify(ev, null, 2));
    process.exit(ev.ok ? 0 : 1);
  }
  if (phase === 'packaged') {
    if (typeof args.asar !== 'string') fail('--phase packaged 需要 --asar <app.asar>');
    const ev = await phasePackaged(root, path.resolve(args.asar));
    console.log(JSON.stringify(ev, null, 2));
    process.exit(ev.ok ? 0 : 1);
  }
  fail('未知 phase: ' + phase);
}

main().catch((e) => fail(String(e && e.stack || e)));
