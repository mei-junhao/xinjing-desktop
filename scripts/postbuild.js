'use strict';
// postbuild: 在 electron-builder 构建完成后、发布前执行
// 职责：
//   - Windows：把默认名 exe 重命名为稳定 ASCII 名（避免中文前缀被吞导致更新 404）；
//              修正 latest.yml 路径、生成 latest-portable.yml 与 portable 的 blockmap。
//   - macOS  ：校验/修正 latest-mac.yml（确保引用 ASCII 命名的 zip 更新包），供自动更新使用。
//   - Linux  ：本仓库暂不支持，直接退出。
//
// 说明：GitHub Releases 资产名对中文等 Unicode 前缀支持不稳定，而自动更新要求
//       latest*.yml 中引用的文件名必须与实际上传资产名逐字节一致，否则客户端下载 404。
//       因此发布资产统一用 ASCII 文件名；中文品牌保留在 Release 标题与安装器界面。
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
    console.error('未找到 portable 绿色版 exe（dist 中除 setup 外的 exe）。dist 内容：', entries);
    process.exit(1);
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
  const finalPortable = renameIf(portableExe, portableName);
  renameIf(`${nsisExe}.blockmap`, `${nsisName}.blockmap`);
  renameIf(`${portableExe}.blockmap`, `${portableName}.blockmap`);

  const latestYml = path.join(dist, 'latest.yml');
  if (fs.existsSync(latestYml) && nsisExe) {
    let c = fs.readFileSync(latestYml, 'utf8');
    c = c.split(nsisExe).join(nsisName);
    fs.writeFileSync(latestYml, c);
    console.log('patched latest.yml path ->', nsisName);
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
    if (finalPortable) {
      const input = path.join(dist, finalPortable);
      const blockmapFile = path.join(dist, `${finalPortable}.blockmap`);
      try {
        const { executeAppBuilder } = require('builder-util');
        await executeAppBuilder(['blockmap', '--input', input, '--output', blockmapFile]);
        if (fs.existsSync(blockmapFile)) {
          console.log('generated portable blockmap ->', path.basename(blockmapFile));
        } else {
          console.warn('portable blockmap 未生成（app-builder 无输出），将退化为全量下载');
        }
      } catch (e) {
        console.warn('portable blockmap 生成失败，将退化为全量下载：', e && e.message);
      }
    }
    console.log('postbuild (win) done. nsis =', finalNsis, '| portable =', finalPortable);
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

  // latest-mac.yml 由 electron-builder 生成，引用 zip 更新包。
  // 由于 artifactName 已为 ASCII，通常无需改；这里做一次防御性修正，
  // 把其中可能残留的默认（含中文 productName）文件名替换为 ASCII 名。
  const latestMac = path.join(dist, 'latest-mac.yml');
  if (fs.existsSync(latestMac)) {
    let c = fs.readFileSync(latestMac, 'utf8');
    const before = c;
    if (finalZip && dmg) c = c.split(dmg).join(dmgName);
    if (finalZip && zip) c = c.split(zip).join(zipName);
    if (c !== before) {
      fs.writeFileSync(latestMac, c);
      console.log('patched latest-mac.yml references to ASCII names');
    }
    console.log('verified latest-mac.yml exists ->', finalZip || finalDmg);
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
