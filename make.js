'use strict';
// Build lightsout.gba from the hand-written ARM program.
const { Asm } = require('./asm.js');
const { buildProgram } = require('./game.js');
const { makeRom } = require('./build.js');
const fs = require('fs');
const path = require('path');

const A = new Asm(0x03000000);
buildProgram(A);
const res = A.assemble();
const rom = makeRom(res.buf, 'LIGHTS OUT');
fs.writeFileSync(path.join(__dirname, 'lightsout.gba'), rom);
console.log('code bytes:', res.size, ' rom bytes:', rom.length);
