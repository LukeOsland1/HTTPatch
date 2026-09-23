// Generates HTTPatch's PNG icons (no external deps) — a rounded indigo square
// with a white "H" glyph. Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const BG = [79, 70, 229, 255]; // indigo #4f46e5
const FG = [255, 255, 255, 255];

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling per axis — antialiases the glyph and corners
  const r = size * 0.18; // corner radius

  // A bold H remains readable at toolbar size.
  const stroke = size * 0.13;
  const top = size * 0.25;
  const bottom = size * 0.75;
  const hLeft = size * 0.25;
  const hRight = size * 0.75 - stroke;
  const hEnd = size * 0.75;
  const crossTop = size * 0.5 - stroke / 2;
  const crossBottom = size * 0.5 + stroke / 2;

  const inRounded = (x, y) => {
    const cx = Math.min(x, size - x);
    const cy = Math.min(y, size - y);
    if (cx >= r || cy >= r) return true;
    const dx = r - cx;
    const dy = r - cy;
    return dx * dx + dy * dy <= r * r;
  };
  const inGlyph = (x, y) => {
    if (y >= top && y < bottom && ((x >= hLeft && x < hLeft + stroke) || (x >= hRight && x < hEnd)))
      return true; // H verticals
    if (y >= crossTop && y < crossBottom && x >= hLeft && x < hEnd) return true; // H crossbar
    return false;
  };

  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inCount = 0;
      let fgCount = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS;
          const py_ = y + (sy + 0.5) / SS;
          if (!inRounded(px_, py_)) continue;
          inCount++;
          if (inGlyph(px_, py_)) fgCount++;
        }
      }
      const i = (y * size + x) * 4;
      if (inCount === 0) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }
      const bgCount = inCount - fgCount;
      // Mix white glyph over indigo by sub-sample coverage; alpha = rounded mask.
      px[i] = Math.round((FG[0] * fgCount + BG[0] * bgCount) / inCount);
      px[i + 1] = Math.round((FG[1] * fgCount + BG[1] * bgCount) / inCount);
      px[i + 2] = Math.round((FG[2] * fgCount + BG[2] * bgCount) / inCount);
      px[i + 3] = Math.round((inCount / total) * 255);
    }
  }
  return px;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, draw(size));
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icons/icon-${size}.png (${png.length} bytes)`);
}
