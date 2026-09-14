'use strict';
// postbuild: 在 electron-builder 构建完成后、发布前执行
// 职责：
//   - Windows：把默认名 exe 重命名为稳定 ASCII 名（避免中文前缀被吞导致更新 404）；
//              修正 latest.yml 路径、生成 latest-portable.yml 与 portable 的 blockmap。
//   - macOS  ：校验/修正 latest-mac.yml（确保引用 ASCII 命名的 zip 更新包），供自动更新使用。
//   - Linux  ：本仓库暂不支持，直接退出。
//
// 健壮性说明（2026-07-16 修复）：
//   electron-builder 在 Windows 上偶尔会因 safe-delete 超时在 nsis 之后、portable 之前中断，
//   导致 portable exe / latest.yml / blockmap 未写出。为让自动更新在"nsis exe 已生成但其余
//   产物缺失"的情况下仍可用，本脚本：
//     - latest.yml 缺失时从 nsis exe 兜底生成（sha512 + size + releaseDate）；
//     - portable 缺失时仅告警、跳过 portable 自动更新，不 process.exit(1)；
//     - nsis / portable blockmap 缺失时用 app-builder 补生成（失败则退化为全量下载）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
const pkg = require('../package.json');
const version = pkg.version;
const PLATFORM = process.platform;

if (!fs.existsSync(dist)) {
  console.error('dist not found:', dist);
  process.exit(1);
}

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

const expand = (tpl) =>
  tpl
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{name\}/g, pkg.name || 'xinjing')
    .replace(/\$\{productName\}/g, (pkg.build && pkg.build.productName) || pkg.name || 'xinjing');

const entries = fs.readdirSync(dist);

// ============================================================
// Windows：nsis 安装版 + portable 绿色版
// ============================================================
if (PLATFORM === 'win32') {
  const nsisTpl = `xinjing-setup-${version}.exe`;
  const portableTpl = `xinjing-portable-${version}.exe`;
  const nsisName = expand(nsisTpl);
  const portableName = expand(portableTpl);

  const nsisExe = entries.find((f) => f.endsWith('.exe') && /setup/i.test(f));
  const portableExe = entries.find((f) => f.endsWith('.exe') && !/setup/i.test(f));

  if (!nsisExe) {
    console.error('未找到 nsis 安装包 exe（dist 中应含带 "setup" 的 exe）。dist 内容：', entries);
    process.exit(1);
  }
  if (!portableExe) {
    console.warn('未找到 portable 绿色版 exe（dist 中除 setup 外的 exe），将跳过 portable 自动更新。dist 内容：', entries);
  }

  function renameIf(srcBase, dstBase) {
    if (!srcBase || srcBase === dstBase) return dstBase;
    const src = path.join(dist, srcBase);
    const dst = path.join(dist, dstBase);
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
      console.log(`renamed ${srcBase} -> ${dstBase}`);
    }
    return dstBase;
  }

  const finalNsis = renameIf(nsisExe, nsisName);
  const finalPortable = portableExe ? renameIf(portableExe, portableName) : null;
  renameIf(`${nsisExe}.blockmap`, `${nsisName}.blockmap`);
  if (portableExe) renameIf(`${portableExe}.blockmap`, `${portableName}.blockmap`);

  const latestYml = path.join(dist, 'latest.yml');
  if (fs.existsSync(latestYml) && nsisExe) {
    let c = fs.readFileSync(latestYml, 'utf8');
    c = c.split(nsisExe).join(nsisName);
    fs.writeFileSync(latestYml, c);
    console.log('patched latest.yml path ->', nsisName);
  } else if (!fs.existsSync(latestYml) && finalNsis) {
    // electron-builder 可能因构建中断未写出 latest.yml；这里从 nsis exe 兜底生成
    const p = path.join(dist, finalNsis);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      const hash = sha512(buf);
      const yml = [
        `version: ${version}`,
        'files:',
        `  - url: ${finalNsis}`,
        `    sha512: ${hash}`,
        `    size: ${buf.length}`,
        `path: ${finalNsis}`,
        `sha512: ${hash}`,
        `releaseDate: ${new Date().toISOString()}`,
        '',
      ].join('\n');
      fs.writeFileSync(latestYml, yml);
      console.log('generated latest.yml for', finalNsis);
    } else {
      console.error('latest.yml 缺失且 nsis exe 不存在，无法生成更新元数据');
      process.exit(1);
    }
  }

  if (finalPortable) {
    const p = path.join(dist, finalPortable);
    const buf = fs.readFileSync(p);
    const hash = sha512(buf);
    const yml = [
      `version: ${version}`,
      'files:',
      `  - url: ${finalPortable}`,
      `    sha512: ${hash}`,
      `    size: ${buf.length}`,
      `path: ${finalPortable}`,
      `sha512: ${hash}`,
      `releaseDate: ${new Date().toISOString()}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dist, 'latest-portable.yml'), yml);
    console.log('generated latest-portable.yml for', finalPortable);
  }

  (async () => {
    async function genBlockmap(srcBase) {
      if (!srcBase) return;
      const input = path.join(dist, srcBase);
      const blockmapFile = path.join(dist, srcBase + '.blockmap');
      if (fs.existsSync(blockmapFile)) {
        console.log('blockmap already exists ->', path.basename(blockmapFile));
        return;
      }
      try {
        const { executeAppBuilder } = require('builder-util');
        await executeAppBuilder(['blockmap', '--input', input, '--output', blockmapFile]);
        if (fs.existsSync(blockmapFile)) {
          console.log('generated blockmap ->', path.basename(blockmapFile));
        } else {
          console.warn('blockmap 未生成（app-builder 无输出），将退化为全量下载: ', srcBase);
        }
      } catch (e) {
        console.warn('blockmap 生成失败，将退化为全量下载: ', srcBase, e && e.message);
      }
    }
    await genBlockmap(finalNsis);
    await genBlockmap(finalPortable);
    console.log('postbuild (win) done. nsis =', finalNsis, '| portable =', finalPortable || '(skipped)');
  })();
}

// ============================================================
// macOS：dmg（首次安装）+ zip（自动更新载体）
// ============================================================
else if (PLATFORM === 'darwin') {
  const dmgName = expand(`xinjing-${version}.dmg`);
  const zipName = expand(`xinjing-${version}.zip`);

  const dmg = entries.find((f) => f.endsWith('.dmg'));
  const zip = entries.find((f) => f.endsWith('.zip') && !f.endsWith('.blockmap'));

  function renameIf(srcBase, dstBase) {
    if (!srcBase || srcBase === dstBase) return dstBase;
    const src = path.join(dist, srcBase);
    const dst = path.join(dist, dstBase);
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
      console.log(`renamed ${srcBase} -> ${dstBase}`);
    }
    return dstBase;
  }

  const finalDmg = dmg ? renameIf(dmg, dmgName) : null;
  const finalZip = zip ? renameIf(zip, zipName) : null;
  renameIf(`${zip}.blockmap`, `${zipName}.blockmap`);

  if (!finalDmg && !finalZip) {
    console.error('未找到 Mac 构建产物（dist 中应含 .dmg 与 .zip）。dist 内容：', entries);
    process.exit(1);
  }

  // 清理可能残留的 builder 旧名产物（避免上传重复/混淆文件）
  for (const e of fs.readdirSync(dist)) {
    if (e === dmgName || e === zipName) continue;
    if (/-mac\.(zip|dmg)$/.test(e) || /-mac\.zip\.blockmap$/.test(e)) {
      try { fs.unlinkSync(path.join(dist, e)); console.log('removed stray builder artifact:', e); } catch (_) {}
    }
  }

  const latestMac = path.join(dist, 'latest-mac.yml');
  if (fs.existsSync(latestMac)) {
    let c = fs.readFileSync(latestMac, 'utf8');
    // 把 yml 中 url:/path: 行引用的任何 .zip/.dmg 文件名，替换为已重命名的稳定 ASCII 名。
    // 不依赖 electron-builder 当次产出的具体命名（旧逻辑用 split(builderName) 在 builder
    // 旧名与 dist 实际文件名不一致时静默失效，导致 latest-mac.yml 引用 404 的旧名）。
    c = c.replace(/(url:\s*|path:\s*)([^\s]+\.zip)/g, `$1${zipName}`);
    c = c.replace(/(url:\s*|path:\s*)([^\s]+\.dmg)/g, `$1${dmgName}`);
    fs.writeFileSync(latestMac, c);
    console.log('patched latest-mac.yml -> zip:', zipName, '| dmg:', dmgName);
    // 校验：yml 中不得再出现 builder 旧名（以 -mac. 结尾的 zip/dmg），否则自动更新必 404
    if (/-mac\.(zip|dmg)/.test(c)) {
      console.error('latest-mac.yml 仍引用 builder 旧名，修复失败：\n' + c);
      process.exit(1);
    }
  } else {
    console.error('latest-mac.yml 缺失，Mac 自动更新将无法工作。dist 内容：', entries);
    process.exit(1);
  }

  console.log('postbuild (mac) done. dmg =', finalDmg, '| zip =', finalZip);
}

// ============================================================
// 其他平台：不支持
// ============================================================
else {
  console.error('postbuild: 不支持的平台', PLATFORM, '——本仓库仅构建 Windows / macOS。');
  process.exit(1);
}
