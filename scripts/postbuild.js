'use strict';
// postbuild: 在 electron-builder 构建完成后、发布前执行
// 职责：把默认名 exe 重命名为稳定 ASCII 名（避免 GitHub 资产名吞掉中文前缀导致更新 404）、
//       修正 latest.yml 路径、生成 latest-portable.yml 与 portable 的 blockmap（portable 增量更新）
//
// 说明：GitHub Releases 资产名对中文等 Unicode 前缀支持不稳定（上传时可能被吞/损坏），
//       而自动更新要求 latest*.yml 中引用的文件名必须与实际上传资产名逐字节一致，
//       否则客户端下载 404。因此发布资产统一用 ASCII 文件名；中文品牌保留在
//       Release 标题（心镜 XinJing vX.Y.Z）与安装器界面（productName）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
const pkg = require('../package.json');
const version = pkg.version;

if (!fs.existsSync(dist)) {
  console.error('dist not found:', dist);
  process.exit(1);
}

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

// 发布资产统一用 ASCII 文件名（单一来源，避免硬编码漂移，且与 latest*.yml 逐字节一致）
const expand = (tpl) =>
  tpl
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{name\}/g, pkg.name || 'xinjing')
    .replace(/\$\{productName\}/g, (pkg.build && pkg.build.productName) || pkg.name || 'xinjing');

const nsisTpl = `xinjing-setup-${version}.exe`;
const portableTpl = `xinjing-portable-${version}.exe`;
const nsisName = expand(nsisTpl);
const portableName = expand(portableTpl);

const entries = fs.readdirSync(dist);
// nsis 安装包含 "setup"（或 "Setup"），portable 单文件不含
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
// blockmap 同步重命名（nsis 由 electron-builder 生成，portable 下文按需生成）
renameIf(`${nsisExe}.blockmap`, `${nsisName}.blockmap`);
renameIf(`${portableExe}.blockmap`, `${portableName}.blockmap`);

// 修正 nsis 的 latest.yml 里的路径/url 为最终发布名
const latestYml = path.join(dist, 'latest.yml');
if (fs.existsSync(latestYml) && nsisExe) {
  let c = fs.readFileSync(latestYml, 'utf8');
  c = c.split(nsisExe).join(nsisName);
  fs.writeFileSync(latestYml, c);
  console.log('patched latest.yml path ->', nsisName);
}

// 生成 portable 的更新元数据 latest-portable.yml（electron-builder 不为 exe 归档生成）
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

// 为 portable 生成独立 blockmap，使绿色版也能走增量下载（无需嵌在 exe 内）
// electron-builder 24 的 ArchiveTarget 只在 format==="zip" 时写更新信息，exe 归档不会产出，这里用 app-builder 补上。
async function buildPortableBlockmap() {
  if (!finalPortable) return;
  const input = path.join(dist, finalPortable);
  const blockmapFile = path.join(dist, `${finalPortable}.blockmap`);
  try {
    const { executeAppBuilder } = require('builder-util');
    // 与 electron-builder 内部 createBlockmap 同参数：--output 写出 blockmap 文件
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

(async () => {
  await buildPortableBlockmap();
  console.log('postbuild done. nsis =', finalNsis, '| portable =', finalPortable);
})();
