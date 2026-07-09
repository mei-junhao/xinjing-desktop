'use strict';

// 纯 JS 生成「心镜」图标：陶土色镜面圆盘 + 高光
// 依赖：pngjs（PNG 编码）、png-to-ico（转 .ico）
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pngToIco = require('png-to-ico').default;

const S = 256;
const png = new PNG({ width: S, height: S });

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const idx = (S * y + x) << 2;
  const ea = png.data[idx + 3] / 255;
  const na = (a / 255) * (1 - ea) + ea;
  if (na <= 0) return;
  png.data[idx] = clamp((r * (a / 255) * (1 - ea) + png.data[idx] * ea) / na);
  png.data[idx + 1] = clamp((g * (a / 255) * (1 - ea) + png.data[idx + 1] * ea) / na);
  png.data[idx + 2] = clamp((b * (a / 255) * (1 - ea) + png.data[idx + 2] * ea) / na);
  png.data[idx + 3] = Math.round(na * 255);
}

function lerp(a, b, t) { return a + (b - a) * t; }

const cx = 128, cy = 128, R = 112;

// 1) 陶土色圆盘（顶亮底暗渐变 + 柔边）
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= R) {
      const t = (y - (cy - R)) / (2 * R);
      const r = Math.round(lerp(198, 140, t));
      const g = Math.round(lerp(118, 72, t));
      const b = Math.round(lerp(86, 50, t));
      let a = 255;
      if (d > R - 2) a = Math.round(((R - d) / 2) * 255);
      setPx(x, y, r, g, b, a);
    }
  }
}

// 2) 内侧镜面环（左上提亮，模拟镜面反光）
const Ri = 74;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= Ri) {
      const sx = dx / Ri, sy = dy / Ri;
      const sheen = Math.max(0, -(sx + sy)) / 2; // 左上为正
      const r = Math.round(lerp(150, 214, sheen));
      const g = Math.round(lerp(96, 156, sheen));
      const b = Math.round(lerp(70, 122, sheen));
      setPx(x, y, r, g, b, 95);
    }
  }
}

// 3) 左上高光点
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - (cx - 40), dy = y - (cy - 44);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 28) setPx(x, y, 255, 246, 236, Math.round((1 - d / 28) * 160));
  }
}

fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
const outPng = path.join(__dirname, 'build', 'icon.png');
png.pack().pipe(fs.createWriteStream(outPng)).on('finish', () => {
  pngToIco(outPng)
    .then((ico) => {
      fs.writeFileSync(path.join(__dirname, 'build', 'icon.ico'), ico);
      console.log('图标已生成: build/icon.png, build/icon.ico');
    })
    .catch((e) => {
      console.error('生成 .ico 失败:', e.message);
      process.exit(1);
    });
});
