'use strict';
// Measures how long one full redraw takes (cycles) in the bundled interpreter.
const { Asm } = require('./asm.js');
const { buildProgram } = require('./game.js');
const { makeRom } = require('./build.js');
const { GBA } = require('./emu.js');

const A = new Asm(0x03000000);
buildProgram(A);
const res = A.assemble();
const rom = makeRom(res.buf, 'LIGHTS OUT');
const g = new GBA(rom, res.labels);
const lab = (n) => res.labels.get(n);
const RENDER = lab('render'), DONE = lab('after_render');

const FRAME = 280896;
let t0 = -1, i0 = 0, frame = 0;
let maxTitle = 0, maxPlay = 0, nTitle = 0, nPlay = 0;
let prevFrame = -1;

while (frame < 120) {
  const pc = g.r[15];
  if (pc === RENDER) { t0 = g.cycles; i0 = g.instructions; }
  if (pc === DONE && t0 >= 0) {
    const c = g.cycles - t0;
    const state = g.read32(0x03007000 + 44);
    if (state === 0) { maxTitle = Math.max(maxTitle, c); nTitle++; }
    else { maxPlay = Math.max(maxPlay, c); nPlay++; }
    t0 = -1;
  }
  // scripted input, one decision per display frame
  const f = Math.floor(g.cycles / FRAME);
  if (f !== prevFrame) {
    prevFrame = f;
    frame = f;
    if (f >= 20 && f < 23) g.keys = 0x3FF & ~8;            // START
    else if (f >= 30 && f % 3 === 0) g.keys = 0x3FF & ~(1 << ((4 + (f / 3) % 2))); // d-pad
    else if (f >= 40 && f % 5 === 0) g.keys = 0x3FF & ~1;  // A
    else g.keys = 0x3FF;
  }
  g.step();
}
console.log('title redraws:', nTitle, 'max cycles:', maxTitle);
console.log('play  redraws:', nPlay, 'max cycles:', maxPlay, ' (frame budget', FRAME + ')');
