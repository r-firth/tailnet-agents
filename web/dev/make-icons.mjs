// Generates the PWA icons as PNGs with no dependencies: the dithered Familiar
// mark (Bayer 4x4, the same shape as the in-app canvas mark) on the dark bg.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
fs.mkdirSync(OUT, { recursive: true });

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BG = [22, 21, 19], TILE = BG, AG = [255, 122, 69];
const mark = (u, v) => { const d = Math.hypot(u - 0.55, v - 0.45); return d < 0.5 ? Math.max(0, 1 - d * 1.7) : 0; };

function icon(size, { maskable = false, radius = 0.22 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const grid = 12;                         // dither cells across the mark
  const inset = maskable ? 0.22 : 0.16;     // maskable keeps the mark in the safe zone
  const m0 = size * inset, ms = size * (1 - 2 * inset);
  const r = size * radius;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    // rounded square (full bleed when maskable)
    if (!maskable) {
      const cx = Math.min(Math.max(x + 0.5, r), size - r), cy = Math.min(Math.max(y + 0.5, r), size - r);
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) { buf[i + 3] = 0; continue; }
    }
    let c = BG;
    const u = (x - m0) / ms, v = (y - m0) / ms;
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      const gx = Math.floor(u * grid), gy = Math.floor(v * grid);
      const val = mark((gx + 0.5) / grid, (gy + 0.5) / grid);
      c = val * 16 > BAYER[(gy & 3) * 4 + (gx & 3)] + 0.5 ? AG : TILE;
      // small gap between cells keeps it crisp at every size
      const fx = u * grid - gx, fy = v * grid - gy;
      if (size >= 128 && (fx < 0.06 || fy < 0.06) && c === AG) c = [230, 108, 60];
    }
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
  return png(size, size, buf);
}

const out = { 'icon-192.png': icon(192), 'icon-512.png': icon(512), 'maskable-512.png': icon(512, { maskable: true }), 'apple-touch-icon.png': icon(180, { maskable: true }), 'favicon-32.png': icon(32, { radius: 0.2 }) };
for (const [f, b] of Object.entries(out)) fs.writeFileSync(path.join(OUT, f), b);
console.log('icons written to', OUT, Object.keys(out).join(', '));
