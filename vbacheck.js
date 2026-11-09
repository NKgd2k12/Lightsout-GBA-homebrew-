'use strict';
// Analyse emulator screen captures (a whole emulator window, possibly stretched
// by an LCD filter).  Reads the lamp grid and cursor position straight from the
// picture, fitting the known perspective pad layout to the pads it can see.
const fs = require('fs');
const zlib = require('zlib');
const { cellCentre3d, padBounds3d } = require('./game.js');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xFF;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

// Colours after VBA-M's "srgb" colour correction + LCD filter.
const ON = [246, 175, 133];
const OFF = [15, 38, 51];
const RING = [226, 237, 240];
const eq = (p, c) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2];
const dist = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;

// Pad-grid extents in GBA pixel coordinates (default tilt).
const [GX0, GX1, GY0, GY1] = padBounds3d;

for (const file of process.argv.slice(2)) {
  const im = decodePNG(file);
  const px = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= im.w || y >= im.h) return [0, 0, 0];
    const o = (y * im.w + x) * im.bpp;
    return [im.data[o], im.data[o + 1], im.data[o + 2]];
  };

  // Fit the pad bounding box: every ON/OFF pixel belongs to a pad.
  let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const p = px(x, y);
    if (eq(p, ON) || eq(p, OFF)) {
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) { console.log(`${file}  no game screen`); continue; }

  const sx = (bx1 + 1 - bx0) / (GX1 - GX0);
  const sy = (by1 + 1 - by0) / (GY1 - GY0);
  const mapX = (gx) => bx0 + (gx - GX0) * sx;
  const mapY = (gy) => by0 + (gy - GY0) * sy;

  let lights = 0, grid = '', unknown = 0;
  // Sample a few points inside each pad, so an OSD overlay covering the exact
  // centre does not turn into a false lamp.
  const sample = (gx, gy) => {
    for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [6, 0], [-6, 0]]) {
      const p = px(mapX(gx + dx), mapY(gy + dy));
      if (dist(p, ON) < 2500) return 1;
      if (dist(p, OFF) < 2500) return 0;
    }
    return -1;
  };
  for (let r = 0; r < 5; r++) {
    let row = '';
    for (let c = 0; c < 5; c++) {
      const [gx, gy] = cellCentre3d(c, r);
      const v = sample(gx, gy);
      row += v === 1 ? '1' : v === 0 ? '.' : '?';
      if (v < 0) unknown++;
      if (v === 1) lights |= 1 << (r * 5 + c);
    }
    grid += row + (r < 4 ? '/' : '');
  }

  // White cursor ring: its centroid sits on the selected pad.
  let n = 0, sxSum = 0, sySum = 0;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    if (eq(px(x, y), RING)) { n++; sxSum += x; sySum += y; }
  }
  let cursor = '-';
  if (n > 100) {
    const gx = GX0 + (sxSum / n - bx0) / sx;
    const gy = GY0 + (sySum / n - by0) / sy;
    let best = 0, bestD = 1e9;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      const [cx, cy] = cellCentre3d(c, r);
      const d = (cx - gx) ** 2 + (cy - gy) ** 2;
      if (d < bestD) { bestD = d; best = r * 5 + c; }
    }
    cursor = `${best % 5},${(best / 5) | 0}`;
  }
  console.log(`${file}  origin=${bx0},${by0} scale=${sx.toFixed(2)} cursor=${cursor} ` +
    `lights=0x${(lights >>> 0).toString(16)} ${grid}` + (unknown ? ` unknown=${unknown}` : ''));
}
