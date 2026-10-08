'use strict';

// Windows desktop mark: a calm clinical mirror aperture, legible down to 16px.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pngToIco = require('png-to-ico').default;

const size = 256;
const png = new PNG({ width: size, height: size });

function clamp(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function lerp(start, end, amount) { return start + (end - start) * amount; }

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
  const index = (size * y + x) << 2;
  const existing = png.data[index + 3] / 255;
  const next = alpha + existing * (1 - alpha);
  if (!next) return;
  png.data[index] = clamp((color[0] * alpha + png.data[index] * existing * (1 - alpha)) / next);
  png.data[index + 1] = clamp((color[1] * alpha + png.data[index + 1] * existing * (1 - alpha)) / next);
  png.data[index + 2] = clamp((color[2] * alpha + png.data[index + 2] * existing * (1 - alpha)) / next);
  png.data[index + 3] = clamp(next * 255);
}

function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const px = Math.max(left + radius - x, 0, x - (right - radius));
  const py = Math.max(top + radius - y, 0, y - (bottom - radius));
  return Math.sqrt(px * px + py * py) - radius;
}

// Rounded square material.
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const distance = roundedRectDistance(x, y, 12, 12, 244, 244, 54);
    if (distance > 1.2) continue;
    const alpha = distance > 0 ? 1 - distance / 1.2 : 1;
    const diagonal = (x + y) / (size * 2);
    const radial = Math.max(0, 1 - Math.hypot(x - 84, y - 62) / 220);
    blend(x, y, [lerp(10, 28, diagonal), lerp(89, 143, radial), lerp(79, 128, radial)], alpha);
  }
}

// Inset mirror body and a quiet rim.
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const dx = (x - 128) / 76;
    const dy = (y - 128) / 76;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= 1 && distance >= .82) {
      blend(x, y, [188, 226, 218], Math.max(.12, 1 - (distance - .82) / .18) * .8);
    }
    if (distance < .82) {
      const sheen = Math.max(0, 1 - Math.hypot(x - 102, y - 95) / 94);
      blend(x, y, [lerp(13, 46, sheen), lerp(58, 113, sheen), lerp(53, 102, sheen)], .94);
    }
  }
}

// A vertical aperture: the mirror's opening, not a literal letterform.
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const dx = (x - 128) / 20;
    const dy = (y - 128) / 51;
    const aperture = dx * dx + dy * dy;
    if (aperture <= 1) {
      const sheen = Math.max(0, 1 - Math.hypot(x - 122, y - 96) / 68);
      blend(x, y, [lerp(224, 246, sheen), lerp(241, 252, sheen), lerp(237, 249, sheen)], .96);
    }
  }
}

// Single optical highlight for dimensionality.
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x - 91, y - 77);
    if (distance < 18) blend(x, y, [255, 255, 255], (1 - distance / 18) * .28);
  }
}

fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
const pngPath = path.join(__dirname, 'build', 'icon.png');
png.pack().pipe(fs.createWriteStream(pngPath)).on('finish', function () {
  pngToIco(pngPath).then(function (ico) {
    fs.writeFileSync(path.join(__dirname, 'build', 'icon.ico'), ico);
    console.log('Generated build/icon.png and build/icon.ico');
  }).catch(function (error) {
    console.error('Unable to generate icon.ico:', error.message);
    process.exit(1);
  });
});
