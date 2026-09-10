// Generates the PWA / home-screen icons from code, so there are no binary
// blobs in the repo that nobody can regenerate or explain.
//
//     node tools/make-icons.mjs
//
// Writes icons/icon-<size>.png plus a maskable variant. Hand-rolled PNG
// encoder rather than a dependency: the app itself has zero dependencies and
// no build step, and pulling in a graphics library to draw four rectangles
// would be the largest thing in the project by an order of magnitude. zlib is
// in Node's standard library, which is the only hard part of a PNG.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../icons/', import.meta.url));

// Matches the app's --bg and --accent tokens.
const BG = [0x0e, 0x10, 0x13];
const ACCENT = [0xf0, 0xa9, 0x3a];
const ACCENT_HI = [0xff, 0xc4, 0x5f];

// ---------------------------------------------------------------------------
// Minimal PNG writer: RGBA, no interlacing, one IDAT.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0.

  // Each scanline is prefixed with its filter byte; filter 0 (None) keeps this
  // simple and still compresses well on flat-colour art.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// The mark: a barbell, drawn in normalised 0..1 coordinates so one definition
// renders at every size.
//
// `inset` is the maskable safe zone. Android crops a maskable icon to whatever
// shape the launcher likes (circle, squircle, teardrop), and only the middle
// ~80% is guaranteed to survive, so the maskable build draws the same bar
// smaller inside the same square.
// ---------------------------------------------------------------------------
function barbellParts(inset) {
  const s = (v) => 0.5 + (v - 0.5) * inset;   // scale about the centre
  return [
    // [x0, y0, x1, y1, colour] — the bar, then inner plates, then outer plates.
    [s(0.16), s(0.470), s(0.84), s(0.530), ACCENT],
    [s(0.24), s(0.330), s(0.33), s(0.670), ACCENT_HI],
    [s(0.67), s(0.330), s(0.76), s(0.670), ACCENT_HI],
    [s(0.13), s(0.390), s(0.20), s(0.610), ACCENT],
    [s(0.80), s(0.390), s(0.87), s(0.610), ACCENT],
  ];
}

function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  // Opaque background: iOS applies its own rounded mask, and a transparent
  // home-screen icon renders black on some launchers.
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = BG[0]; rgba[i * 4 + 1] = BG[1]; rgba[i * 4 + 2] = BG[2]; rgba[i * 4 + 3] = 255;
  }
  const put = (x, y, [r, g, b]) => {
    const o = (y * size + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
  };
  for (const [x0, y0, x1, y1, colour] of barbellParts(maskable ? 0.78 : 1)) {
    const px0 = Math.round(x0 * size), px1 = Math.round(x1 * size);
    const py0 = Math.round(y0 * size), py1 = Math.round(y1 * size);
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        if (x >= 0 && y >= 0 && x < size && y < size) put(x, y, colour);
      }
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-180.png', 180, {}],           // apple-touch-icon (iOS home screen)
  ['icon-192.png', 192, {}],           // manifest, Android
  ['icon-512.png', 512, {}],           // manifest, splash + store-ish surfaces
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = renderIcon(size, opts);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`wrote icons/${name}  ${size}x${size}  ${png.length} bytes`);
}
