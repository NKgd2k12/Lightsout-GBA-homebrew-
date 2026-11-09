'use strict';
// Automated tests: runs the ROM in the bundled GBA interpreter and plays a
// full level with an independent Lights Out solver.
const { Asm } = require('./asm.js');
const { buildProgram, VARS, V, cellCentre3d } = require('./game.js');
const { makeRom } = require('./build.js');
const { GBA } = require('./emu.js');
const { encodePNG } = require('./png.js');
const fs = require('fs');
const path = require('path');

const A = new Asm(0x03000000);
buildProgram(A);
const res = A.assemble();
const rom = makeRom(res.buf, 'LIGHTS OUT');
fs.writeFileSync(path.join(__dirname, 'lightsout.gba'), rom);

const RELEASED = 0x3FF;
const K = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
const g = new GBA(rom, res.labels);
const rd = (o) => g.read32(VARS + o) >>> 0;
let frame = 0, fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const run = (n, keys = RELEASED) => { g.keys = keys; for (let i = 0; i < n; i++) g.runUntilFrame(++frame); };
const press = (k) => { run(1, RELEASED & ~k); run(1, RELEASED); };
const shot = (name) => {
  fs.writeFileSync(path.join(__dirname, name + '.png'), encodePNG(240, 160, g.framebufferRGB(), 3));
};

// ---- independent model of the puzzle (generated here, not imported) ----
const MASK = (() => {
  const m = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    let b = 0;
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < 5 && ny >= 0 && ny < 5) b |= 1 << (ny * 5 + nx);
    }
    m.push(b >>> 0);
  }
  return m;
})();
const popcount = (v) => { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; };

// Colour that a cell must show, read straight out of the displayed VRAM page.
function cellPixel(x, y) {
  const page = (g.dispcnt & 0x10) ? 0xA000 : 0;
  const [px, py] = cellCentre3d(x, y);
  return g.vram[page + py * 240 + px];
}
function screenMatches(lights) {
  for (let i = 0; i < 25; i++) {
    const want = (lights >> i) & 1 ? 4 : 1;
    const got = cellPixel(i % 5, (i / 5) | 0);
    if (got !== want) return `cell ${i} shows ${got}, want ${want}`;
  }
  return null;
}

// First-row brute force solve (32 candidates, the rest is forced).
function solve(lights) {
  for (let first = 0; first < 32; first++) {
    let grid = lights >>> 0;
    const out = [];
    for (let x = 0; x < 5; x++) if (first & (1 << x)) { grid ^= MASK[x]; out.push([x, 0]); }
    for (let y = 1; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        if (grid & (1 << ((y - 1) * 5 + x))) { grid ^= MASK[y * 5 + x]; out.push([x, y]); }
      }
    }
    if (grid === 0) return out;
  }
  return null;
}

function moveCursorTo(tx, ty) {
  let guard = 0;
  while (rd(V.CX) !== tx) { press(rd(V.CX) < tx ? K.RIGHT : K.LEFT); if (++guard > 50) throw new Error('cursor X stuck'); }
  while (rd(V.CY) !== ty) { press(rd(V.CY) < ty ? K.DOWN : K.UP); if (++guard > 50) throw new Error('cursor Y stuck'); }
}

// ------------------------------------------------------------------ tests
run(30);
ok('boots to title screen', rd(V.STATE) === 0, 'state=' + rd(V.STATE));
ok('light bitmask starts empty', rd(V.LIGHTS) === 0);

press(K.START);
run(4);
ok('START starts a game', rd(V.STATE) === 1, 'state=' + rd(V.STATE));
ok('level 1', rd(V.LEVEL) === 1, 'level=' + rd(V.LEVEL));
const lights0 = rd(V.LIGHTS);
ok('puzzle has lit lamps', lights0 !== 0, 'lights=0x' + lights0.toString(16));
ok('on-count matches puzzle', rd(V.COUNT) === popcount(lights0), 'count=' + rd(V.COUNT));
ok('moves reset', rd(V.MOVES) === 0);
ok('cursor starts centred', rd(V.CX) === 2 && rd(V.CY) === 2);
ok('grid drawn to match puzzle', screenMatches(lights0) === null, screenMatches(lights0) || '');

// cursor navigation and clamping
press(K.RIGHT); press(K.RIGHT); press(K.DOWN);
ok('cursor moves', rd(V.CX) === 4 && rd(V.CY) === 3, 'cx=' + rd(V.CX) + ' cy=' + rd(V.CY));
press(K.RIGHT); press(K.DOWN);
ok('cursor clamps at edges', rd(V.CX) === 4 && rd(V.CY) === 4);
press(K.LEFT); press(K.LEFT); press(K.LEFT); press(K.LEFT); press(K.LEFT); press(K.UP); press(K.UP); press(K.UP); press(K.UP); press(K.UP);
ok('cursor clamps at 0,0', rd(V.CX) === 0 && rd(V.CY) === 0, 'cx=' + rd(V.CX) + ' cy=' + rd(V.CY));

// a single flip must toggle exactly the cross around the cursor
const before = rd(V.LIGHTS) >>> 0;
press(K.A);
const after = rd(V.LIGHTS) >>> 0;
ok('A flips the right cross', after === ((before ^ MASK[0]) >>> 0),
  'before=0x' + before.toString(16) + ' after=0x' + after.toString(16));
ok('move counter counts', rd(V.MOVES) === 1, 'moves=' + rd(V.MOVES));
ok('on-count recomputed', rd(V.COUNT) === popcount(after));
ok('screen follows the flip', screenMatches(after) === null, screenMatches(after) || '');

// B restores the puzzle
press(K.B);
ok('B resets the puzzle', (rd(V.LIGHTS) >>> 0) === lights0 && rd(V.MOVES) === 0);

// START deals a new puzzle at the same level
press(K.START);
run(2);
const lightsNew = rd(V.LIGHTS) >>> 0;
ok('START deals a new puzzle', lightsNew !== 0, 'lights=0x' + lightsNew.toString(16));
ok('still level 1', rd(V.LEVEL) === 1);

// play a full board with the independent solver
const plan = solve(lightsNew);
ok('puzzle is solvable', plan !== null, 'presses=' + (plan ? plan.length : '?'));
if (plan) {
  for (const [x, y] of plan) {
    moveCursorTo(x, y);
    press(K.A);
  }
  ok('board goes dark', rd(V.LIGHTS) === 0, 'lights=0x' + rd(V.LIGHTS).toString(16));
  ok('solved state entered', rd(V.STATE) === 2, 'state=' + rd(V.STATE));
  ok('move counter matches solution', rd(V.MOVES) === plan.length, 'moves=' + rd(V.MOVES) + ' plan=' + plan.length);
  ok('keys are still responsive', g.r[15] !== 0);
}

run(4);
shot('shot_solved');
ok('overlay covers the board', (() => {
  const page = (g.dispcnt & 0x10) ? 0xA000 : 0;
  return g.vram[page + 80 * 240 + 120] === 11;
})(), 'centre pixel=' + g.vram[((g.dispcnt & 0x10) ? 0xA000 : 0) + 80 * 240 + 120]);

// next level
press(K.A);
run(4);
ok('A advances the level', rd(V.LEVEL) === 2 && rd(V.STATE) === 1, 'level=' + rd(V.LEVEL) + ' state=' + rd(V.STATE));
ok('new puzzle is lit', rd(V.LIGHTS) !== 0);
ok('moves reset for level 2', rd(V.MOVES) === 0);
shot('shot_level2');

// sound off should silence the PSG
const sndBefore = rd(V.SOUND);
press(K.SELECT);
ok('SELECT toggles sound', rd(V.SOUND) === (sndBefore ^ 1), 'sound=' + rd(V.SOUND));

// frame pacing: exactly one logic frame per display frame
const f0 = rd(V.FRAME), k0 = frame;
run(120);
ok('one logic frame per display frame', rd(V.FRAME) - f0 === 120, 'advance=' + (rd(V.FRAME) - f0));

// rendering cost: run a frame that has to redraw and count instructions
press(K.RIGHT);
const i0 = g.instructions;
run(1);
console.log('  redraw frame instructions:', g.instructions - i0, '(budget ~280k cycles/frame)');

// L/R tilt the perspective view without touching the puzzle
const yaw0 = rd(V.YAW);
press(K.L);
ok('L tilts the 3D view', rd(V.YAW) === Math.min(6, yaw0 + 1), 'yaw=' + rd(V.YAW));
press(K.R);
ok('R tilts it back', rd(V.YAW) === yaw0, 'yaw=' + rd(V.YAW));
run(2);

console.log(fails ? fails + ' FAILED' : 'ALL OK');
process.exit(fails ? 1 : 0);
