#!/usr/bin/env node
'use strict';
// Genera build/icon.png (512x512): una corchea sobre fondo turquesa, con antialiasing por supersampling.
// Sin dependencias: codificador PNG propio (zlib de Node). electron-builder lo convierte a .ico al empaquetar.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 512, SS = 4;
const BG = [79, 209, 197], INK = [6, 32, 29];

const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), N - r), cy = Math.min(Math.max(y, r), N - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inEllipse = (x, y, cx, cy, rx, ry, rot) => {
  const c = Math.cos(rot), s = Math.sin(rot), dx = x - cx, dy = y - cy;
  return ((dx * c + dy * s) / rx) ** 2 + ((-dx * s + dy * c) / ry) ** 2 <= 1;
};
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const FLAG = [[300, 112], [330, 150], [372, 196], [384, 262], [350, 316], [354, 250], [322, 206], [300, 178]];
const isNote = (x, y) => inEllipse(x, y, 214, 352, 78, 54, -0.38) || (x >= 280 && x <= 302 && y >= 112 && y <= 342) || inPoly(x, y, FLAG);

const px = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let cov = 0, note = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      if (inRoundRect(fx, fy, 112)) { cov++; if (isNote(fx, fy)) note++; }
    }
    const a = cov / (SS * SS), t = cov ? note / cov : 0;
    const o = (y * N + x) * 4;
    px[o] = Math.round(BG[0] * (1 - t) + INK[0] * t);
    px[o + 1] = Math.round(BG[1] * (1 - t) + INK[1] * t);
    px[o + 2] = Math.round(BG[2] * (1 - t) + INK[2] * t);
    px[o + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`icono escrito: ${out} (${png.length} bytes)`);
