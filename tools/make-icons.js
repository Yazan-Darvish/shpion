// Генерирует icon-192.png и icon-512.png без зависимостей: рисуем по формулам, кодируем PNG через zlib.
// Запуск: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const C = {
  bg: [232, 213, 166],
  bgEdge: [214, 190, 135],
  ink: [30, 26, 19],
  red: [179, 38, 30],
  lens: [245, 236, 214]
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Цвет точки в нормированных координатах 0..1 (рисуем сверху вниз по слоям)
function shade(u, v) {
  const d = Math.hypot(u - 0.5, v - 0.5);
  // фон с лёгкой виньеткой
  const t = Math.min(1, d / 0.75);
  let col = C.bg.map((c, i) => c + (C.bgEdge[i] - c) * t * t);

  // кольцо штампа
  if (d <= 0.375 && d >= 0.345) col = C.red;

  // шляпа: тулья, лента, поля
  const crown = inRoundRect(u, v, 0.355, 0.255, 0.645, 0.47, 0.06) && !inEllipse(u, v, 0.5, 0.25, 0.06, 0.035);
  if (crown) col = C.ink;
  if (inRoundRect(u, v, 0.355, 0.415, 0.645, 0.462, 0)) col = C.red;
  if (inEllipse(u, v, 0.5, 0.475, 0.235, 0.042)) col = C.ink;

  // очки
  for (const cx of [0.405, 0.595]) {
    if (inCircle(u, v, cx, 0.6, 0.078)) col = inCircle(u, v, cx, 0.6, 0.05) ? C.lens : C.ink;
  }
  if (inRoundRect(u, v, 0.47, 0.585, 0.53, 0.603, 0.006)) col = C.ink;
  // блик в линзах
  for (const cx of [0.39, 0.58]) if (inEllipse(u, v, cx, 0.585, 0.014, 0.01)) col = [255, 255, 255];

  return col;
}

function render(size) {
  const ss = 4; // суперсэмплинг для сглаживания
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = ss * ss;
      raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n); raw[o + 2] = Math.round(b / n); raw[o + 3] = 255;
    }
  }
  return encodePNG(size, size, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const root = path.join(__dirname, '..');
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(root, `icon-${size}.png`), render(size));
  console.log(`icon-${size}.png готов`);
}
