'use strict';
// Build the ROM, run it in the bundled ARM interpreter and save screenshots.
const { Asm } = require('./asm.js');
const { buildProgram, VARS, V } = require('./game.js');
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
console.log('code bytes:', res.size, ' rom bytes:', rom.length);

const g = new GBA(rom, res.labels);
let frame = 0;

function run(n, keys) {
  g.keys = keys === undefined ? 0x3FF : keys;
  for (let i = 0; i < n; i++) g.runUntilFrame(++frame);
}
const K = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };
const press = (k, hold = 2) => { run(hold, 0x3FF & ~k); run(2, 0x3FF); };

function shot(name) {
  const out = path.join(__dirname, name + '.png');
  fs.writeFileSync(out, encodePNG(240, 160, g.framebufferRGB(), 3));
  console.log('  shot', out);
}
const rd = (o) => g.read32(VARS + o) >>> 0;

run(20);
shot('shot_title');
press(K.START);
run(6);
shot('shot_level1');
press(K.RIGHT);
run(6);
shot('shot_cursor');
press(K.A);
run(8);
shot('shot_flip');
console.log('state', rd(V.STATE), 'lights', rd(V.LIGHTS).toString(16),
  'moves', rd(V.MOVES), 'count', rd(V.COUNT), 'cx', rd(V.CX), 'cy', rd(V.CY));
console.log('pc', g.r[15].toString(16), g.nearestLabel(g.r[15]), 'cycles', g.cycles, 'instr', g.instructions);
