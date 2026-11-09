'use strict';
// LIGHTS OUT - a 5x5 logic puzzle for the Game Boy Advance.
// Hand-assembled ARMv4T (ARM state) code, running from IWRAM.
// No devkit, no C compiler: asm.js builds the machine code, build.js wraps it
// in a raw .gba image with a valid header.
const { Asm, sh, shR } = require('./asm.js');
const { fontBytes, strIdx } = require('./font.js');

const VARS = 0x03007000;
const V = {
  LIGHTS: 0, START: 4, CX: 8, CY: 12, MOVES: 16, LEVEL: 20, SEED: 24,
  FRAME: 28, KEYS: 32, PREV: 36, PRESS: 40, STATE: 44, SOLVEDT: 48,
  SOUND: 52, COUNT: 56, FB: 60, NEED: 64, ONES: 68,
  T0: 72, T1: 76, T2: 80, T3: 84, T4: 88, T5: 92, T6: 96, T7: 100,
  YAW: 104,
};

// 15-bit BGR555 colour from 8-bit RGB.
const C = (r, g, b) => ((r >> 3) & 31) | (((g >> 3) & 31) << 5) | (((b >> 3) & 31) << 10);

const PALETTE = [
  C(9, 11, 22),     // 0  background
  C(38, 46, 74),    // 1  lamp off, body
  C(58, 70, 108),   // 2  lamp off, top highlight
  C(22, 27, 46),    // 3  lamp off, bottom shadow
  C(255, 206, 64),  // 4  lamp on, body
  C(255, 246, 164), // 5  lamp on, top highlight
  C(196, 128, 24),  // 6  lamp on, bottom shadow
  C(238, 244, 255), // 7  cursor
  C(210, 220, 242), // 8  text
  C(104, 116, 150), // 9  dim text
  C(96, 232, 148),  // 10 accent green
  C(16, 20, 38),    // 11 panel
  C(58, 70, 108),   // 12 panel border
  C(255, 196, 72),  // 13 gold
  C(255, 255, 255), // 14 white
  C(0, 0, 0),       // 15 black
  // 16..23: cool vertical gradient used by the title screen
  C(3, 5, 12),
  C(5, 8, 17),
  C(7, 12, 24),
  C(9, 16, 32),
  C(12, 20, 40),
  C(9, 16, 32),
  C(7, 12, 24),
  C(5, 8, 17),
];

// Bitmask of the cells toggled by pressing cell i (itself + orthogonal neighbours).
function maskTable() {
  const out = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      let m = 0;
      const cells = [[x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [cx, cy] of cells) {
        if (cx >= 0 && cx < 5 && cy >= 0 && cy < 5) m |= 1 << (cy * 5 + cx);
      }
      out.push(m >>> 0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Perspective board geometry.
//
// The 5x5 board is projected as if seen from above and in front: rows farther
// away are narrower and shorter, near rows wider and taller.  L/R tilt the
// view by shearing the projection, which is a cheap oblique "camera" turn that
// keeps every cell's top and bottom edge horizontal.
//
// Everything the renderer needs is precomputed per tilt level into 12-byte
// quads: x0,xr0,y0,x1,xr1,y1,bit,pad,stepL(halfword),stepR(halfword).
// fill_trap() walks the quad scanline by scanline, interpolating the left and
// right edges with the 8.8 fixed-point steps.
const ROW_Y0 = [22, 40, 59, 80, 104];
const ROW_Y1 = [36, 55, 76, 100, 126];
const P_TOP = [30, 32, 34, 36, 39];
const P_BOT = [32, 34, 36, 39, 42];
const G_TOP = [2, 2, 2, 3, 3];
const G_BOT = [2, 2, 3, 3, 3];
const YAW_SHEARS = [-18, -12, -6, 0, 6, 12, 18];
const YAW_DEFAULT = 4;

const shiftAt = (shear, y) => Math.round(shear * (y - 76) / 104);

function quadBytes(x0, xr0, y0, x1, xr1, y1, bit) {
  const dy = y1 - y0;
  const stepL = Math.round((x1 - x0) * 256 / dy);
  const stepR = Math.round((xr1 - xr0) * 256 / dy);
  return [x0 & 255, xr0 & 255, y0 & 255, x1 & 255, xr1 & 255, y1 & 255,
    bit & 255, 0, stepL & 255, (stepL >> 8) & 255, stepR & 255, (stepR >> 8) & 255];
}

function buildBoard3d() {
  const slabs = [], cells = [], centres = [];
  let bounds = null;
  for (let level = 0; level < YAW_SHEARS.length; level++) {
    const sh = (y) => shiftAt(YAW_SHEARS[level], y);
    // slab: shadow, raised border, dark play surface
    slabs.push(...quadBytes(
      120 - 79 + sh(17) + 5, 120 + 79 + sh(17) + 5, 22,
      120 - 109 + sh(134) + 5, 120 + 109 + sh(134) + 5, 139, 0));
    slabs.push(...quadBytes(
      120 - 79 + sh(17), 120 + 79 + sh(17), 17,
      120 - 109 + sh(134), 120 + 109 + sh(134), 134, 0));
    slabs.push(...quadBytes(
      120 - 76 + sh(20), 120 + 76 + sh(20), 20,
      120 - 106 + sh(131), 120 + 106 + sh(131), 131, 0));
    // 25 raised pads, far row first (painter's algorithm)
    for (let j = 0; j < 5; j++) {
      const y0 = ROW_Y0[j], y1 = ROW_Y1[j];
      for (let i = 0; i < 5; i++) {
        const l0 = 120 - P_TOP[j] * 2.5 + i * P_TOP[j] + G_TOP[j] / 2 + sh(y0);
        const l1 = 120 - P_BOT[j] * 2.5 + i * P_BOT[j] + G_BOT[j] / 2 + sh(y1);
        const x0 = Math.round(l0), xr0 = Math.round(l0 + P_TOP[j] - G_TOP[j]);
        const x1 = Math.round(l1), xr1 = Math.round(l1 + P_BOT[j] - G_BOT[j]);
        cells.push(...quadBytes(x0, xr0, y0, x1, xr1, y1, j * 5 + i));
        if (level === YAW_DEFAULT) {
          const cy = (y0 + y1) / 2, t = (cy - y0) / (y1 - y0);
          const xl = x0 + (x1 - x0) * t, xr = xr0 + (xr1 - xr0) * t;
          centres.push([Math.round((xl + xr - 1) / 2), Math.round(cy)]);
          // pixel extents of every pad, including the 3px front face; the
          // screen-capture analyser fits this box to the picture
          const box = [Math.min(x0, x1), Math.max(xr0, xr1), y0, y1 + 3];
          if (!bounds) bounds = box.slice();
          else {
            bounds[0] = Math.min(bounds[0], box[0]);
            bounds[1] = Math.max(bounds[1], box[1]);
            bounds[2] = Math.min(bounds[2], box[2]);
            bounds[3] = Math.max(bounds[3], box[3]);
          }
        }
      }
    }
  }
  return { slabs, cells, centres, bounds };
}

const BOARD3D = buildBoard3d();
// Screen centre of each pad, used by the headless test to sample the VRAM.
const cellCentre3d = (i, j) => BOARD3D.centres[j * 5 + i];
// Bounding box of the pad grid at the default tilt: x0, x1, y0, y1.
const padBounds3d = BOARD3D.bounds;

function buildProgram(A) {
  const L = (n) => ({ label: n });
  const M = maskTable();

  // ============================================================ entry point
  A.label('start');
  A.ldrk('r11', VARS);
  A.ldrk('r0', 0x03007E00);
  A.mov('sp', 'r0');
  A.ldrk('r0', 0x01010101);
  A.str('r0', 'r11', V.ONES);
  A.ldrk('r0', 0x13572468);
  A.str('r0', 'r11', V.SEED);
  A.ldrk('r0', 0x3FF);
  A.str('r0', 'r11', V.PREV);
  A.mov('r0', 0);
  A.str('r0', 'r11', V.STATE);
  A.str('r0', 'r11', V.FRAME);
  A.str('r0', 'r11', V.MOVES);
  A.str('r0', 'r11', V.PRESS);
  A.str('r0', 'r11', V.NEED);
  A.str('r0', 'r11', V.T0);
  A.str('r0', 'r11', V.LIGHTS);
  A.str('r0', 'r11', V.COUNT);
  A.mov('r0', 1);
  A.str('r0', 'r11', V.LEVEL);
  A.str('r0', 'r11', V.SOUND);
  A.mov('r0', YAW_DEFAULT);
  A.str('r0', 'r11', V.YAW);
  A.mov('r0', 2);
  A.str('r0', 'r11', V.CX);
  A.str('r0', 'r11', V.CY);
  A.bl('init_video');
  A.bl('init_draw');
  A.b('main');
  A.pool();

  // ============================================================ main loop
  // Wait for VBlank, show a freshly rendered page if one is waiting, read
  // input, run logic, and redraw into the hidden page when something changed.
  // Flipping only after a redraw keeps the picture stable while the game is
  // idle instead of alternating between the new and the old page every frame.
  A.label('main');
  A.bl('wait_vblank');
  A.ldr('r0', 'r11', V.T0);
  A.cmp('r0', 0);
  A.beq('main_input');
  A.bl('flip');
  A.mov('r0', 0);
  A.str('r0', 'r11', V.T0);
  A.label('main_input');
  A.bl('read_input');
  A.bl('update');
  A.ldr('r0', 'r11', V.NEED);
  A.cmp('r0', 0);
  A.beq('main');
  A.bl('render');
  A.mov('r0', 0);
  A.str('r0', 'r11', V.NEED);
  A.mov('r0', 1);
  A.str('r0', 'r11', V.T0);
  A.b('main');

  // ============================================================ video setup
  A.label('init_video');
  A.push('r4', 'lr');
  A.ldrk('r0', 0x04000000);
  A.mov('r1', 0);
  A.strh('r1', 'r0', 0);              // display off while we set everything up
  // palette: 16 halfwords
  A.ldrk('r0', 0x05000000);
  A.ldrk('r1', L('palette'));
  A.mov('r2', PALETTE.length);
  A.label('iv_pal');
  A.ldrh('r3', 'r1', 2, { post: true });
  A.strh('r3', 'r0', 2, { post: true });
  A.sub('r2', 'r2', 1, { s: true });
  A.bne('iv_pal');
  // sound: master on, PSG at full volume
  A.ldrk('r0', 0x04000084);
  A.mov('r1', 0x80);
  A.strb('r1', 'r0', 0);
  A.ldrk('r0', 0x04000082);
  A.mov('r1', 2);
  A.strh('r1', 'r0', 0);
  A.pop('r4', 'pc');
  A.pool();

  // Draw the opening screen into both VRAM pages, then enable the display.
  A.label('init_draw');
  A.push('lr');
  A.ldrk('r0', 0x06000000);
  A.str('r0', 'r11', V.FB);
  A.bl('render');
  A.ldrk('r0', 0x0600A000);
  A.str('r0', 'r11', V.FB);
  A.bl('render');
  // Leave FB on the hidden page; page 0 stays on screen.  The first redraw
  // then has somewhere safe to go.
  A.ldrk('r0', 0x04000000);
  A.ldrk('r1', 0x0404);               // mode 4, BG2 on, page 0
  A.strh('r1', 'r0', 0);
  A.pop('pc');
  A.pool();

  // ============================================================ timing
  // Spin until the raster reaches line 160, then until it leaves that line, so
  // the main loop advances exactly once per frame even when it is fast.
  A.label('wait_vblank');
  A.ldrk('r0', 0x04000006);
  A.label('wv_loop');
  A.ldrh('r1', 'r0', 0);
  A.cmp('r1', 160);
  A.bne('wv_loop');
  A.label('wv_out');
  A.ldrh('r1', 'r0', 0);
  A.cmp('r1', 160);
  A.beq('wv_out');
  A.bx('lr');

  // Toggle the displayed page and point FB at the hidden one.
  A.label('flip');
  A.ldrk('r0', 0x04000000);
  A.ldrh('r1', 'r0', 0);
  A.eor('r1', 'r1', 0x10);
  A.strh('r1', 'r0', 0);
  A.and('r2', 'r1', 0x10);
  A.eor('r2', 'r2', 0x10);
  A.ldrk('r3', L('pagetab'));
  A.ldr('r3', 'r3', sh('r2', 2, 'lsr'));
  A.str('r3', 'r11', V.FB);
  A.bx('lr');
  A.pool();

  // ============================================================ input
  // KEYS is active-high; PRESS has one bit set per newly pressed button.
  A.label('read_input');
  A.ldrk('r0', 0x04000130);
  A.ldrh('r1', 'r0', 0);
  A.mvn('r1', 'r1');
  A.mov('r1', sh('r1', 22, 'lsl'));
  A.mov('r1', sh('r1', 22, 'lsr'));
  A.ldr('r2', 'r11', V.KEYS);
  A.str('r2', 'r11', V.PREV);
  A.str('r1', 'r11', V.KEYS);
  A.bic('r3', 'r1', 'r2');
  A.str('r3', 'r11', V.PRESS);
  A.bx('lr');
  A.pool();

  // ============================================================ game logic
  A.label('update');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'lr');
  A.ldr('r0', 'r11', V.FRAME);
  A.add('r0', 'r0', 1);
  A.str('r0', 'r11', V.FRAME);
  A.ldr('r8', 'r11', V.PRESS);
  A.ldr('r9', 'r11', V.STATE);
  A.cmp('r9', 0);
  A.beq('up_title');
  A.cmp('r9', 2);
  A.beq('up_solved');

  // ---------- playing: cursor movement
  A.tst('r8', 0x10);                  // RIGHT
  A.beq('up_dr');
  A.ldr('r0', 'r11', V.CX);
  A.cmp('r0', 4);
  A.addlt('r0', 'r0', 1);
  A.str('r0', 'r11', V.CX);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_dr');
  A.tst('r8', 0x20);                  // LEFT
  A.beq('up_dl');
  A.ldr('r0', 'r11', V.CX);
  A.cmp('r0', 0);
  A.subgt('r0', 'r0', 1);
  A.str('r0', 'r11', V.CX);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_dl');
  A.tst('r8', 0x40);                  // UP
  A.beq('up_du');
  A.ldr('r0', 'r11', V.CY);
  A.cmp('r0', 0);
  A.subgt('r0', 'r0', 1);
  A.str('r0', 'r11', V.CY);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_du');
  A.tst('r8', 0x80);                  // DOWN
  A.beq('up_dd');
  A.ldr('r0', 'r11', V.CY);
  A.cmp('r0', 4);
  A.addlt('r0', 'r0', 1);
  A.str('r0', 'r11', V.CY);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_dd');

  // ---------- L/R: tilt the 3D view (7 fixed camera angles)
  A.tst('r8', 0x200);                 // L
  A.beq('up_lr');
  A.ldr('r0', 'r11', V.YAW);
  A.cmp('r0', 6);
  A.addlt('r0', 'r0', 1);
  A.str('r0', 'r11', V.YAW);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_lr');
  A.tst('r8', 0x100);                 // R
  A.beq('up_rr');
  A.ldr('r0', 'r11', V.YAW);
  A.cmp('r0', 0);
  A.subgt('r0', 'r0', 1);
  A.str('r0', 'r11', V.YAW);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.label('up_rr');

  // ---------- A: flip the lamp under the cursor
  A.tst('r8', 1);
  A.beq('up_ab');
  A.mov('r0', 1);
  A.str('r0', 'r11', V.NEED);
  A.bl('toggle');
  A.ldr('r0', 'r11', V.MOVES);
  A.add('r0', 'r0', 1);
  A.str('r0', 'r11', V.MOVES);
  A.bl('count_lights');
  A.mov('r0', 0x740);
  A.bl('sfx');
  A.ldr('r0', 'r11', V.LIGHTS);
  A.cmp('r0', 0);
  A.bne('up_ab');
  A.mov('r0', 2);
  A.str('r0', 'r11', V.STATE);
  A.ldr('r0', 'r11', V.FRAME);
  A.str('r0', 'r11', V.SOLVEDT);
  A.bl('sfx_win');
  A.label('up_ab');

  // ---------- B: restart the current puzzle
  A.tst('r8', 2);
  A.beq('up_bb');
  A.ldr('r0', 'r11', V.START);
  A.str('r0', 'r11', V.LIGHTS);
  A.mov('r0', 0);
  A.str('r0', 'r11', V.MOVES);
  A.mov('r1', 1);
  A.str('r1', 'r11', V.NEED);
  A.bl('count_lights');
  A.mov('r0', 0x500);
  A.bl('sfx');
  A.label('up_bb');

  // ---------- START: fresh puzzle at the same level
  A.tst('r8', 8);
  A.beq('up_sb');
  A.bl('new_puzzle');
  A.mov('r0', 1);
  A.str('r0', 'r11', V.NEED);
  A.label('up_sb');

  // ---------- SELECT: sound on/off
  A.tst('r8', 4);
  A.beq('up_done');
  A.ldr('r0', 'r11', V.SOUND);
  A.eor('r0', 'r0', 1);
  A.str('r0', 'r11', V.SOUND);
  A.mov('r0', 0x600);
  A.bl('sfx');
  A.b('up_done');

  // ---------- title screen
  A.label('up_title');
  A.tst('r8', 8);
  A.beq('up_tb');
  A.mov('r0', 1);
  A.str('r0', 'r11', V.LEVEL);
  A.str('r0', 'r11', V.STATE);
  A.bl('new_puzzle');
  A.mov('r0', 1);
  A.str('r0', 'r11', V.NEED);
  A.mov('r0', 0x500);
  A.bl('sfx');
  A.label('up_tb');
  A.ldr('r0', 'r11', V.FRAME);
  A.tst('r0', 8);                     // redraw 7.5x/second for the animation
  A.movne('r0', 1);
  A.strne('r0', 'r11', V.NEED);
  A.b('up_done');

  // ---------- solved screen
  A.label('up_solved');
  A.tst('r8', 1);
  A.beq('up_vb');
  A.ldr('r0', 'r11', V.LEVEL);
  A.add('r0', 'r0', 1);
  A.str('r0', 'r11', V.LEVEL);
  A.mov('r0', 1);
  A.str('r0', 'r11', V.STATE);
  A.bl('new_puzzle');
  A.mov('r0', 1);
  A.str('r0', 'r11', V.NEED);
  A.mov('r0', 0x600);
  A.bl('sfx');
  A.label('up_vb');
  A.ldr('r0', 'r11', V.FRAME);
  A.tst('r0', 16);
  A.movne('r0', 1);
  A.strne('r0', 'r11', V.NEED);

  A.label('up_done');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'pc');
  A.pool();

  // ============================================================ puzzle helpers
  // XOR the lamp cross around the cursor into LIGHTS.
  A.label('toggle');
  A.ldr('r0', 'r11', V.CY);
  A.mov('r1', 5);
  A.mul('r0', 'r1', 'r0');
  A.ldr('r1', 'r11', V.CX);
  A.add('r0', 'r0', 'r1');
  A.ldrk('r2', L('masks'));
  A.ldr('r2', 'r2', sh('r0', 2, 'lsl'));
  A.ldr('r3', 'r11', V.LIGHTS);
  A.eor('r3', 'r3', 'r2');
  A.str('r3', 'r11', V.LIGHTS);
  A.bx('lr');
  A.pool();

  A.label('count_lights');
  A.ldr('r0', 'r11', V.LIGHTS);
  A.mov('r1', 0);
  A.mov('r2', 25);
  A.label('cl_loop');
  A.tst('r0', 1);
  A.addne('r1', 'r1', 1);
  A.mov('r0', sh('r0', 1, 'lsr'));
  A.sub('r2', 'r2', 1, { s: true });
  A.bne('cl_loop');
  A.str('r1', 'r11', V.COUNT);
  A.bx('lr');

  // 32-bit LCG (Numerical Recipes), full period.
  A.label('rand');
  A.ldr('r0', 'r11', V.SEED);
  A.ldrk('r1', 1664525);
  A.mul('r0', 'r1', 'r0');
  A.ldrk('r1', 1013904223);
  A.add('r0', 'r0', 'r1');
  A.str('r0', 'r11', V.SEED);
  A.bx('lr');
  A.pool();

  // Build a fresh, always-solvable puzzle: scramble the blank board with N
  // random crosses. Solving it means undoing those toggles.
  A.label('new_puzzle');
  A.push('r4', 'r5', 'r6', 'lr');
  A.ldrk('r5', L('masks'));
  A.mov('r0', 0);
  A.str('r0', 'r11', V.LIGHTS);
  A.str('r0', 'r11', V.MOVES);
  A.mov('r0', 2);
  A.str('r0', 'r11', V.CX);
  A.str('r0', 'r11', V.CY);
  A.ldr('r0', 'r11', V.LEVEL);
  A.mov('r1', 2);
  A.mul('r0', 'r1', 'r0');
  A.add('r0', 'r0', 4);               // 6 toggles on level 1
  A.cmp('r0', 26);
  A.movgt('r0', 26);
  A.mov('r4', 'r0');                  // r4 = toggles left
  A.label('np_loop');
  A.bl('rand');
  A.mov('r1', sh('r0', 16, 'lsr'));
  A.and('r1', 'r1', 255);
  A.mov('r2', 5);
  A.mul('r1', 'r2', 'r1');
  A.mov('r1', sh('r1', 8, 'lsr'));    // x = ((r>>16)&255)*5/256
  A.mov('r2', sh('r0', 24, 'lsr'));
  A.mov('r3', 5);
  A.mul('r2', 'r3', 'r2');
  A.mov('r2', sh('r2', 8, 'lsr'));    // y = (r>>24)*5/256
  A.mov('r3', 5);
  A.mul('r2', 'r3', 'r2');
  A.add('r2', 'r2', 'r1');
  A.ldr('r3', 'r5', sh('r2', 2, 'lsl'));
  A.ldr('r0', 'r11', V.LIGHTS);
  A.eor('r0', 'r0', 'r3');
  A.str('r0', 'r11', V.LIGHTS);
  A.sub('r4', 'r4', 1, { s: true });
  A.bne('np_loop');
  A.ldr('r0', 'r11', V.LIGHTS);
  A.cmp('r0', 0);
  A.bne('np_done');
  A.ldr('r3', 'r5', 12 * 4);          // pathological case: poke the centre
  A.eor('r0', 'r0', 'r3');
  A.str('r0', 'r11', V.LIGHTS);
  A.label('np_done');
  A.str('r0', 'r11', V.START);
  A.bl('count_lights');
  A.pop('r4', 'r5', 'r6', 'pc');
  A.pool();

  // ============================================================ sound
  // r0 = PSG frequency (0..2047). No-op while sound is switched off.
  A.label('sfx');
  A.push('r4', 'lr');
  A.ldr('r4', 'r11', V.SOUND);
  A.cmp('r4', 0);
  A.beq('sfx_end');
  A.ldrk('r1', 0x04000060);
  A.mov('r2', 0);
  A.strh('r2', 'r1', 0);              // no sweep
  A.ldrk('r2', 0xFB80);               // volume 15, decay, 50% duty
  A.strh('r2', 'r1', 2);
  A.orr('r0', 'r0', 0x8000);          // trigger
  A.strh('r0', 'r1', 4);
  A.label('sfx_end');
  A.pop('r4', 'pc');
  A.pool();

  A.label('delay');
  A.sub('r0', 'r0', 1, { s: true });
  A.bne('delay');
  A.bx('lr');

  // Rising three-note jingle when a puzzle is solved.
  A.label('sfx_win');
  A.push('r4', 'lr');
  A.mov('r0', 0x300);
  A.bl('sfx');
  A.ldrk('r0', 40000);
  A.bl('delay');
  A.mov('r0', 0x480);
  A.bl('sfx');
  A.ldrk('r0', 40000);
  A.bl('delay');
  A.mov('r0', 0x600);
  A.bl('sfx');
  A.ldrk('r0', 70000);
  A.bl('delay');
  A.pop('r4', 'pc');
  A.pool();

  // ============================================================ drawing
  A.label('render');
  A.push('r4', 'lr');
  A.ldr('r0', 'r11', V.STATE);
  A.cmp('r0', 0);
  A.beq('rn_title');
  A.bl('draw_play');
  A.b('rn_done');
  A.label('rn_title');
  A.bl('draw_title');                 // the title paints its own gradient
  A.label('rn_done');
  A.label('after_render');
  A.pop('r4', 'pc');

  A.label('draw_play');
  A.push('r4', 'lr');
  A.bl('draw_bg');
  A.bl('draw_grid');
  A.bl('draw_hud');
  A.ldr('r0', 'r11', V.STATE);
  A.cmp('r0', 2);
  A.bne('dp_done');
  A.bl('draw_overlay');
  A.label('dp_done');
  A.pop('r4', 'pc');

  // ---------- soft background gradient (same palette as the title screen)
  A.label('draw_bg');
  A.push('r4', 'r5', 'r6', 'r7', 'lr');
  A.mov('r5', 0);                     // y
  A.mov('r6', 16);                    // first gradient colour
  A.mov('r7', 8);                     // bands
  A.label('bg_band');
  A.mov('r0', 0);
  A.mov('r1', 'r5');
  A.mov('r2', 240);
  A.mov('r3', 20);
  A.mov('r4', 'r6');
  A.bl('rect');
  A.add('r5', 'r5', 20);
  A.add('r6', 'r6', 1);
  A.sub('r7', 'r7', 1, { s: true });
  A.bne('bg_band');
  A.pop('r4', 'r5', 'r6', 'r7', 'pc');
  A.pool();

  // ---------- perspective 5x5 lamp board
  A.label('draw_grid');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12', 'lr');
  // cursor cell index
  A.ldr('r0', 'r11', V.CY);
  A.mov('r1', 5);
  A.mul('r0', 'r1', 'r0');
  A.ldr('r1', 'r11', V.CX);
  A.add('r0', 'r0', 'r1');
  A.str('r0', 'r11', V.T1);
  A.mov('r9', 'r0');                  // cursor index
  A.ldr('r10', 'r11', V.LIGHTS);
  // pick the slab quads for this tilt level (3 quads of 12 bytes)
  A.ldr('r0', 'r11', V.YAW);
  A.mov('r1', 36);
  A.mul('r0', 'r1', 'r0');
  A.ldrk('r8', L('slabs3d'));
  A.add('r8', 'r8', 'r0');
  // dark play surface, then a thin raised border around it
  A.add('r0', 'r8', 12);              // outer quad
  A.mov('r1', 11);
  A.mov('r2', 0);
  A.bl('fill_trap');
  A.ldrb('r0', 'r8', 12);             // top band, inset past the side strips
  A.add('r0', 'r0', 3);
  A.ldrb('r2', 'r8', 13);
  A.ldrb('r1', 'r8', 12);
  A.sub('r2', 'r2', 'r1');
  A.sub('r2', 'r2', 6);
  A.mov('r1', 17);
  A.mov('r3', 3);
  A.mov('r4', 12);
  A.bl('rect');
  A.ldrb('r0', 'r8', 15);             // bottom band
  A.add('r0', 'r0', 3);
  A.ldrb('r2', 'r8', 16);
  A.ldrb('r1', 'r8', 15);
  A.sub('r2', 'r2', 'r1');
  A.sub('r2', 'r2', 6);
  A.mov('r1', 131);
  A.mov('r3', 3);
  A.mov('r4', 12);
  A.bl('rect');
  // slab front lip and the shadow it casts on the table
  A.ldrb('r0', 'r8', 15);
  A.mov('r1', 134);
  A.mov('r2', 218);
  A.mov('r3', 3);
  A.mov('r4', 3);
  A.bl('rect');
  A.ldrb('r0', 'r8', 15);
  A.mov('r1', 137);
  A.mov('r2', 218);
  A.mov('r3', 3);
  A.mov('r4', 15);
  A.bl('rect');
  // slanted left/right border strips (3px), walked along the outer quad
  A.ldrb('r4', 'r8', 12);
  A.ldrb('r5', 'r8', 13);
  A.ldrsh('r7', 'r8', 20);
  A.ldrsh('r9', 'r8', 22);
  A.mov('r4', sh('r4', 8, 'lsl'));
  A.add('r4', 'r4', 128);
  A.mov('r5', sh('r5', 8, 'lsl'));
  A.add('r5', 'r5', 128);
  A.mov('r2', 17);
  A.mov('r10', 134);
  A.sub('r10', 'r10', 'r2');
  A.ldr('r8', 'r11', V.FB);
  A.mov('r0', 240);
  A.mul('r0', 'r2', 'r0');
  A.add('r8', 'r8', 'r0');
  A.mov('r12', 12);
  A.label('dg_edge');
  A.mov('r0', sh('r4', 8, 'lsr'));    // left edge
  A.mov('r1', sh('r5', 8, 'lsr'));    // right edge
  A.strb('r12', 'r8', 'r0');
  A.add('r3', 'r0', 1);
  A.strb('r12', 'r8', 'r3');
  A.add('r3', 'r0', 2);
  A.strb('r12', 'r8', 'r3');
  A.sub('r3', 'r1', 3);
  A.strb('r12', 'r8', 'r3');
  A.add('r3', 'r3', 1);
  A.strb('r12', 'r8', 'r3');
  A.add('r3', 'r3', 1);
  A.strb('r12', 'r8', 'r3');
  A.add('r8', 'r8', 240);
  A.add('r4', 'r4', 'r7');
  A.add('r5', 'r5', 'r9');
  A.sub('r10', 'r10', 1, { s: true });
  A.bne('dg_edge');
  // the edge walk used r9/r10 as its own steps, so restore the cursor index
  // and the lamp bitmask before drawing the pads
  A.ldr('r9', 'r11', V.T1);
  A.ldr('r10', 'r11', V.LIGHTS);
  // 25 raised pads, far row first (painter's algorithm)
  A.ldr('r0', 'r11', V.YAW);
  A.mov('r1', 300);
  A.mul('r0', 'r1', 'r0');
  A.ldrk('r8', L('cells3d'));
  A.add('r8', 'r8', 'r0');
  A.mov('r5', 25);
  A.label('dg_loop');
  A.ldrb('r7', 'r8', 6);              // bit index
  A.mov('r0', shR('r10', 'r7', 'lsr'));
  A.tst('r0', 1);
  A.mov('r6', 1);                     // lamp off body
  A.movne('r6', 4);                   // lamp on body
  // front (south) face first: a 3px band under the bottom edge
  A.ldrb('r0', 'r8', 3);              // x1
  A.ldrb('r2', 'r8', 4);              // xr1
  A.sub('r2', 'r2', 'r0');
  A.ldrb('r1', 'r8', 5);              // y1
  A.mov('r3', 3);
  A.mov('r4', 0);                     // off: near-black side
  A.cmp('r6', 4);
  A.moveq('r4', 6);                   // on: warm shadow
  A.bl('rect');
  // cursor gets a white ring, others a 1px top highlight
  A.cmp('r7', 'r9');
  A.bne('dg_noc');
  A.mov('r0', 'r8');
  A.mov('r1', 7);
  A.mov('r2', 0);
  A.bl('fill_trap');
  A.mov('r0', 'r8');
  A.mov('r1', 'r6');
  A.mov('r2', 2);
  A.bl('fill_trap');
  A.b('dg_next');
  A.label('dg_noc');
  A.mov('r0', 'r8');
  A.mov('r1', 'r6');
  A.mov('r2', 0);
  A.bl('fill_trap');
  A.ldrb('r0', 'r8', 0);
  A.ldrb('r2', 'r8', 1);
  A.sub('r2', 'r2', 'r0');
  A.ldrb('r1', 'r8', 2);
  A.mov('r3', 1);
  A.add('r4', 'r6', 1);
  A.bl('rect');
  A.label('dg_next');
  A.add('r8', 'r8', 12);
  A.sub('r5', 'r5', 1, { s: true });
  A.bne('dg_loop');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12', 'pc');
  A.pool();

  // ---------- top and bottom read-outs (2x scale for legibility)
  A.label('draw_hud');
  A.push('r4', 'r5', 'lr');
  A.ldrk('r2', L('s_level'));
  A.mov('r0', 6);
  A.mov('r1', 2);
  A.mov('r3', 8);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.ldr('r0', 'r11', V.LEVEL);
  A.mov('r1', 78);
  A.mov('r2', 2);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.mov('r5', 2);
  A.bl('draw_num');
  A.ldrk('r2', L('s_moves'));
  A.mov('r0', 130);
  A.mov('r1', 2);
  A.mov('r3', 8);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.ldr('r0', 'r11', V.MOVES);
  A.mov('r1', 202);
  A.mov('r2', 2);
  A.mov('r3', 3);
  A.mov('r4', 14);
  A.mov('r5', 2);
  A.bl('draw_num');
  A.ldrk('r2', L('s_on'));
  A.mov('r0', 6);
  A.mov('r1', 144);
  A.mov('r3', 8);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.ldr('r0', 'r11', V.COUNT);
  A.mov('r1', 46);
  A.mov('r2', 144);
  A.mov('r3', 2);
  A.mov('r4', 10);
  A.mov('r5', 2);
  A.bl('draw_num');
  A.ldrk('r2', L('s_reset'));
  A.mov('r0', 152);
  A.mov('r1', 144);
  A.mov('r3', 9);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.pop('r4', 'r5', 'pc');
  A.pool();

  // ---------- "solved" panel
  A.label('draw_overlay');
  A.push('r4', 'r5', 'lr');
  // drop shadow, border, dark panel, green accent strip
  A.mov('r0', 38);
  A.mov('r1', 48);
  A.mov('r2', 168);
  A.mov('r3', 72);
  A.mov('r4', 15);
  A.bl('rect');
  A.mov('r0', 36);
  A.mov('r1', 46);
  A.mov('r2', 168);
  A.mov('r3', 72);
  A.mov('r4', 12);
  A.bl('rect');
  A.mov('r0', 38);
  A.mov('r1', 48);
  A.mov('r2', 164);
  A.mov('r3', 68);
  A.mov('r4', 11);
  A.bl('rect');
  A.mov('r0', 38);
  A.mov('r1', 48);
  A.mov('r2', 164);
  A.mov('r3', 2);
  A.mov('r4', 10);
  A.bl('rect');
  // SOLVED! with a warm shadow
  A.ldrk('r2', L('s_solved'));
  A.mov('r0', 59);
  A.mov('r1', 52);
  A.mov('r3', 6);
  A.mov('r4', 3);
  A.bl('draw_str');
  A.ldrk('r2', L('s_solved'));
  A.mov('r0', 57);
  A.mov('r1', 50);
  A.mov('r3', 13);
  A.mov('r4', 3);
  A.bl('draw_str');
  // move count, 2x
  A.ldrk('r2', L('s_moves'));
  A.mov('r0', 66);
  A.mov('r1', 82);
  A.mov('r3', 8);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.ldr('r0', 'r11', V.MOVES);
  A.mov('r1', 138);
  A.mov('r2', 82);
  A.mov('r3', 3);
  A.mov('r4', 14);
  A.mov('r5', 2);
  A.bl('draw_num');
  // blinking prompt
  A.ldr('r0', 'r11', V.FRAME);
  A.tst('r0', 16);
  A.bne('do_done');
  A.ldrk('r2', L('s_pressa'));
  A.mov('r0', 78);
  A.mov('r1', 102);
  A.mov('r3', 10);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.label('do_done');
  A.pop('r4', 'r5', 'pc');
  A.pool();

  // ---------- title screen
  A.label('draw_title');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'lr');

  // soft vertical gradient
  A.mov('r6', 0);
  A.mov('r8', 0);
  A.mov('r9', 16);
  A.label('dt_band');
  A.mov('r0', 0);
  A.mov('r1', 'r8');
  A.mov('r2', 240);
  A.mov('r3', 20);
  A.mov('r4', 'r9');
  A.bl('rect');
  A.add('r8', 'r8', 20);
  A.add('r9', 'r9', 1);
  A.add('r6', 'r6', 1);
  A.cmp('r6', 8);
  A.blt('dt_band');

  // a few twinkling specks
  A.ldrk('r10', L('stars'));
  A.mov('r9', 12);
  A.label('dt_star');
  A.ldrb('r0', 'r10', 1, { post: true });
  A.ldrb('r1', 'r10', 1, { post: true });
  A.ldrb('r4', 'r10', 1, { post: true });
  A.mov('r2', 1);
  A.mov('r3', 1);
  A.bl('rect');
  A.sub('r9', 'r9', 1, { s: true });
  A.bne('dt_star');

  // thin rules top and bottom
  A.mov('r0', 20);
  A.mov('r1', 5);
  A.mov('r2', 200);
  A.mov('r3', 1);
  A.mov('r4', 12);
  A.bl('rect');
  A.mov('r0', 118);
  A.mov('r1', 4);
  A.mov('r2', 4);
  A.mov('r3', 3);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 20);
  A.mov('r1', 157);
  A.mov('r2', 200);
  A.mov('r3', 1);
  A.mov('r4', 12);
  A.bl('rect');
  A.mov('r0', 118);
  A.mov('r1', 156);
  A.mov('r2', 4);
  A.mov('r3', 3);
  A.mov('r4', 13);
  A.bl('rect');

  // big logo: black drop shadow, white and gold face
  A.ldrk('r2', L('s_lights'));
  A.mov('r0', 37);
  A.mov('r1', 14);
  A.mov('r3', 15);
  A.mov('r4', 3);
  A.bl('draw_str');
  A.ldrk('r2', L('s_lights'));
  A.mov('r0', 35);
  A.mov('r1', 12);
  A.mov('r3', 14);
  A.mov('r4', 3);
  A.bl('draw_str');
  A.ldrk('r2', L('s_out'));
  A.mov('r0', 154);
  A.mov('r1', 14);
  A.mov('r3', 15);
  A.mov('r4', 3);
  A.bl('draw_str');
  A.ldrk('r2', L('s_out'));
  A.mov('r0', 152);
  A.mov('r1', 12);
  A.mov('r3', 13);
  A.mov('r4', 3);
  A.bl('draw_str');

  // rule under the logo
  A.mov('r0', 35);
  A.mov('r1', 36);
  A.mov('r2', 169);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 35);
  A.mov('r1', 38);
  A.mov('r2', 169);
  A.mov('r3', 1);
  A.mov('r4', 6);
  A.bl('rect');

  // framed demo board
  A.mov('r0', 77);
  A.mov('r1', 40);
  A.mov('r2', 86);
  A.mov('r3', 86);
  A.mov('r4', 12);
  A.bl('rect');
  A.mov('r0', 79);
  A.mov('r1', 42);
  A.mov('r2', 82);
  A.mov('r3', 82);
  A.mov('r4', 11);
  A.bl('rect');
  A.mov('r0', 79);
  A.mov('r1', 42);
  A.mov('r2', 82);
  A.mov('r3', 1);
  A.mov('r4', 2);
  A.bl('rect');
  A.mov('r0', 77);
  A.mov('r1', 40);
  A.mov('r2', 2);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 161);
  A.mov('r1', 40);
  A.mov('r2', 2);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 77);
  A.mov('r1', 124);
  A.mov('r2', 2);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 161);
  A.mov('r1', 124);
  A.mov('r2', 2);
  A.mov('r3', 2);
  A.mov('r4', 13);
  A.bl('rect');

  // animated 5x5 demo: a real puzzle being solved, one cross at a time
  A.ldr('r0', 'r11', V.FRAME);
  A.mov('r0', sh('r0', 4, 'lsr'));     // one demo frame per 16-frame redraw
  A.and('r0', 'r0', 15);
  A.ldrk('r1', L('title_patterns'));
  A.ldr('r9', 'r1', sh('r0', 2, 'lsl'));
  A.ldrk('r1', L('title_cursors'));
  A.ldrb('r10', 'r1', 'r0');
  A.mov('r5', 0);
  A.mov('r7', 85);
  A.mov('r8', 49);
  A.label('dt_cell');
  A.mov('r6', 1);
  A.tst('r9', 1);
  A.movne('r6', 4);
  A.mov('r0', 'r7');
  A.mov('r1', 'r8');
  A.mov('r2', 12);
  A.mov('r3', 12);
  A.mov('r4', 'r6');
  A.bl('rect');
  A.mov('r0', 'r7');
  A.mov('r1', 'r8');
  A.mov('r2', 12);
  A.mov('r3', 2);
  A.add('r4', 'r6', 1);
  A.bl('rect');
  A.mov('r0', 'r7');
  A.add('r1', 'r8', 10);
  A.mov('r2', 12);
  A.mov('r3', 2);
  A.add('r4', 'r6', 2);
  A.bl('rect');
  A.cmp('r5', 'r10');
  A.bne('dt_noc');
  A.mov('r0', 'r7');
  A.sub('r0', 'r0', 1);
  A.mov('r1', 'r8');
  A.sub('r1', 'r1', 1);
  A.mov('r2', 14);
  A.mov('r3', 1);
  A.mov('r4', 7);
  A.bl('rect');
  A.mov('r0', 'r7');
  A.sub('r0', 'r0', 1);
  A.add('r1', 'r8', 12);
  A.mov('r2', 14);
  A.mov('r3', 1);
  A.mov('r4', 7);
  A.bl('rect');
  A.mov('r0', 'r7');
  A.sub('r0', 'r0', 1);
  A.mov('r1', 'r8');
  A.sub('r1', 'r1', 1);
  A.mov('r2', 1);
  A.mov('r3', 14);
  A.mov('r4', 7);
  A.bl('rect');
  A.add('r0', 'r7', 12);
  A.mov('r1', 'r8');
  A.sub('r1', 'r1', 1);
  A.mov('r2', 1);
  A.mov('r3', 14);
  A.mov('r4', 7);
  A.bl('rect');
  A.label('dt_noc');
  A.mov('r9', sh('r9', 1, 'lsr'));
  A.add('r5', 'r5', 1);
  A.add('r7', 'r7', 14);
  A.cmp('r7', 155);
  A.movge('r7', 85);
  A.addge('r8', 'r8', 14);
  A.cmp('r5', 25);
  A.blt('dt_cell');

  // press-start button
  A.mov('r0', 45);
  A.mov('r1', 128);
  A.mov('r2', 150);
  A.mov('r3', 19);
  A.mov('r4', 13);
  A.bl('rect');
  A.mov('r0', 47);
  A.mov('r1', 130);
  A.mov('r2', 146);
  A.mov('r3', 16);
  A.mov('r4', 11);
  A.bl('rect');
  A.ldr('r0', 'r11', V.FRAME);
  A.tst('r0', 32);
  A.bne('dt_pdone');
  A.ldrk('r2', L('s_press'));
  A.mov('r0', 55);
  A.mov('r1', 131);
  A.mov('r3', 14);
  A.mov('r4', 2);
  A.bl('draw_str');
  A.label('dt_pdone');

  // control legend: gold key names, light actions
  A.ldrk('r2', L('s_a'));
  A.mov('r0', 6);
  A.mov('r1', 149);
  A.mov('r3', 13);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_flip'));
  A.mov('r0', 18);
  A.mov('r1', 149);
  A.mov('r3', 8);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_b'));
  A.mov('r0', 54);
  A.mov('r1', 149);
  A.mov('r3', 13);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_resetword'));
  A.mov('r0', 66);
  A.mov('r1', 149);
  A.mov('r3', 8);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_lr'));
  A.mov('r0', 114);
  A.mov('r1', 149);
  A.mov('r3', 13);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_viewword'));
  A.mov('r0', 138);
  A.mov('r1', 149);
  A.mov('r3', 8);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_startword'));
  A.mov('r0', 174);
  A.mov('r1', 149);
  A.mov('r3', 13);
  A.mov('r4', 1);
  A.bl('draw_str');
  A.ldrk('r2', L('s_new'));
  A.mov('r0', 210);
  A.mov('r1', 149);
  A.mov('r3', 8);
  A.mov('r4', 1);
  A.bl('draw_str');

  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'pc');
  A.pool();

  // ---------- fill(r0=dest r1=length r2=colour): byte fill with word fast path
  A.label('fill');
  A.ldr('r3', 'r11', V.ONES);
  A.mul('r2', 'r3', 'r2');
  A.b('fill_pat');

  A.label('fill_pat');
  A.cmp('r1', 0);
  A.bxle('lr');
  A.and('r3', 'r0', 3);
  A.cmp('r3', 0);
  A.beq('fp_words');
  A.rsb('r3', 'r3', 4);
  A.cmp('r3', 'r1');
  A.movgt('r3', 'r1');
  A.sub('r1', 'r1', 'r3');
  A.label('fp_head');
  A.strb('r2', 'r0', 1, { post: true });
  A.sub('r3', 'r3', 1, { s: true });
  A.bne('fp_head');
  A.label('fp_words');
  A.cmp('r1', 4);
  A.blt('fp_tail');
  A.label('fp_wloop');
  A.str('r2', 'r0', 4, { post: true });
  A.sub('r1', 'r1', 4, { s: true });
  A.cmp('r1', 4);
  A.bge('fp_wloop');
  A.label('fp_tail');
  A.cmp('r1', 0);
  A.bxle('lr');
  A.label('fp_bloop');
  A.strb('r2', 'r0', 1, { post: true });
  A.sub('r1', 'r1', 1, { s: true });
  A.bne('fp_bloop');
  A.bx('lr');

  // ---------- rect(r0=x r1=y r2=w r3=h r4=colour), clipped to the screen
  A.label('rect');
  A.push('r4', 'r5', 'r6', 'r7', 'lr');
  A.cmp('r0', 0);
  A.bge('rc_x0');
  A.add('r2', 'r2', 'r0');
  A.mov('r0', 0);
  A.label('rc_x0');
  A.add('r5', 'r0', 'r2');
  A.cmp('r5', 240);
  A.ble('rc_x1');
  A.sub('r2', 'r2', 'r5');
  A.add('r2', 'r2', 240);
  A.label('rc_x1');
  A.cmp('r2', 0);
  A.ble('rc_done');
  A.cmp('r1', 0);
  A.bge('rc_y0');
  A.add('r3', 'r3', 'r1');
  A.mov('r1', 0);
  A.label('rc_y0');
  A.add('r5', 'r1', 'r3');
  A.cmp('r5', 160);
  A.ble('rc_y1');
  A.sub('r3', 'r3', 'r5');
  A.add('r3', 'r3', 160);
  A.label('rc_y1');
  A.cmp('r3', 0);
  A.ble('rc_done');
  A.ldr('r6', 'r11', V.ONES);
  A.mul('r4', 'r6', 'r4');
  A.mov('r6', 'r2');
  A.mov('r7', 'r3');
  A.mov('r3', 240);
  A.mul('r5', 'r1', 'r3');
  A.add('r5', 'r5', 'r0');
  A.ldr('r3', 'r11', V.FB);
  A.add('r5', 'r3', 'r5');
  A.label('rc_row');
  A.mov('r0', 'r5');
  A.mov('r1', 'r6');
  A.mov('r2', 'r4');
  A.bl('fill_pat');
  A.add('r5', 'r5', 240);
  A.sub('r7', 'r7', 1, { s: true });
  A.bne('rc_row');
  A.label('rc_done');
  A.pop('r4', 'r5', 'r6', 'r7', 'pc');
  A.pool();

  // ---------- fill_trap(r0=quad r1=colour r2=inset): span-fill a perspective
  // quad, optionally shrunk by `inset` pixels on every side.  The quad holds
  // x0,xr0,y0,x1,xr1,y1,bit,pad,stepL(s16),stepR(s16) with 8.8 fixed steps.
  A.label('fill_trap');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12', 'lr');
  A.mov('r8', 'r0');                  // quad
  A.mov('r6', 'r1');                  // colour
  A.mov('r12', 'r2');                 // inset
  A.ldrb('r0', 'r8', 0);              // top-left x
  A.ldrb('r1', 'r8', 1);              // top-right x
  A.ldrb('r2', 'r8', 2);              // top y
  A.ldrb('r5', 'r8', 5);              // bottom y
  A.ldrsh('r7', 'r8', 8);             // left edge step
  A.ldrsh('r9', 'r8', 10);            // right edge step
  A.add('r2', 'r2', 'r12');
  A.sub('r5', 'r5', 'r12');
  A.cmp('r5', 'r2');
  A.ble('ft_done');
  A.sub('r10', 'r5', 'r2');           // scanline count
  // left edge at the top of the inset quad
  A.add('r0', 'r0', 'r12');
  A.mov('r0', sh('r0', 8, 'lsl'));
  A.mov('r3', 'r12');
  A.mul('r3', 'r7', 'r3');
  A.add('r4', 'r0', 'r3');
  A.add('r4', 'r4', 128);             // 8.8 rounding
  // right edge
  A.sub('r1', 'r1', 'r12');
  A.mov('r1', sh('r1', 8, 'lsl'));
  A.mov('r3', 'r12');
  A.mul('r3', 'r9', 'r3');
  A.add('r5', 'r1', 'r3');
  A.add('r5', 'r5', 128);
  // row pointer
  A.ldr('r8', 'r11', V.FB);
  A.mov('r0', 240);
  A.mul('r0', 'r2', 'r0');
  A.add('r8', 'r8', 'r0');
  A.label('ft_loop');
  A.mov('r1', sh('r4', 8, 'lsr'));    // left
  A.mov('r2', sh('r5', 8, 'lsr'));    // right
  A.cmp('r1', 0);
  A.movlt('r1', 0);
  A.cmp('r2', 240);
  A.movgt('r2', 240);
  A.sub('r2', 'r2', 'r1');
  A.cmp('r2', 0);
  A.ble('ft_skip');
  A.add('r0', 'r8', 'r1');
  A.mov('r1', 'r2');
  A.mov('r2', 'r6');
  A.bl('fill');
  A.label('ft_skip');
  A.add('r8', 'r8', 240);
  A.add('r4', 'r4', 'r7');
  A.add('r5', 'r5', 'r9');
  A.sub('r10', 'r10', 1, { s: true });
  A.bne('ft_loop');
  A.label('ft_done');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r12', 'pc');

  // ---------- draw_char(r0=x r1=y r2=glyph r3=colour r4=scale)
  A.label('draw_char');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'lr');
  A.mov('r6', 'r0');
  A.mov('r5', 'r1');
  A.mov('r8', 'r3');
  A.mov('r7', 'r4');
  A.ldrk('r9', L('font'));
  A.mov('r0', 5);
  A.mul('r0', 'r2', 'r0');
  A.add('r9', 'r9', 'r0');
  A.ldr('r10', 'r11', V.FB);
  A.mov('r0', 240);
  A.mul('r0', 'r5', 'r0');
  A.add('r10', 'r10', 'r0');
  A.add('r10', 'r10', 'r6');
  A.mov('r4', 0);
  A.label('dc_col');
  A.ldrb('r3', 'r9', 'r4');
  A.mov('r2', 0);
  A.label('dc_row');
  A.tst('r3', 1);
  A.beq('dc_skip');
  A.mov('r5', 'r4');
  A.mul('r5', 'r7', 'r5');
  A.add('r5', 'r10', 'r5');
  A.mov('r1', 'r2');
  A.mul('r1', 'r7', 'r1');
  A.mov('r0', 240);
  A.mul('r1', 'r0', 'r1');
  A.add('r5', 'r5', 'r1');
  A.mov('r6', 0);
  A.label('dc_dy');
  A.mov('r0', 'r6');
  A.mov('r1', 240);
  A.mul('r0', 'r1', 'r0');
  A.add('r0', 'r5', 'r0');
  A.mov('r1', 0);
  A.label('dc_dx');
  A.strb('r8', 'r0', 'r1');
  A.add('r1', 'r1', 1);
  A.cmp('r1', 'r7');
  A.blt('dc_dx');
  A.add('r6', 'r6', 1);
  A.cmp('r6', 'r7');
  A.blt('dc_dy');
  A.label('dc_skip');
  A.mov('r3', sh('r3', 1, 'lsr'));
  A.add('r2', 'r2', 1);
  A.cmp('r2', 7);
  A.blt('dc_row');
  A.add('r4', 'r4', 1);
  A.cmp('r4', 5);
  A.blt('dc_col');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'pc');
  A.pool();

  // ---------- draw_str(r0=x r1=y r2=ptr r3=colour r4=scale)
  A.label('draw_str');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'lr');
  A.mov('r5', 'r0');
  A.mov('r6', 'r1');
  A.mov('r7', 'r2');
  A.mov('r9', 'r3');
  A.mov('r10', 'r4');
  A.mov('r8', 6);
  A.mul('r8', 'r10', 'r8');
  A.label('ds_loop');
  A.ldrb('r2', 'r7', 0);
  A.cmp('r2', 255);
  A.beq('ds_done');
  A.mov('r0', 'r5');
  A.mov('r1', 'r6');
  A.mov('r3', 'r9');
  A.mov('r4', 'r10');
  A.bl('draw_char');
  A.add('r5', 'r5', 'r8');
  A.add('r7', 'r7', 1);
  A.b('ds_loop');
  A.label('ds_done');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'pc');
  A.pool();

  // ---------- draw_num(r0=value r1=x r2=y r3=digits r4=colour r5=scale)
  A.label('draw_num');
  A.push('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'lr');
  A.mov('r6', 'r0');                  // value
  A.mov('r7', 'r1');                  // x
  A.mov('r8', 'r2');                  // y
  A.mov('r9', 'r3');                  // digits
  A.mov('r10', 'r4');                 // colour
  A.mov('r0', 6);
  A.mul('r0', 'r5', 'r0');            // spacing = 6 * scale
  A.sub('r1', 'r9', 1);
  A.mul('r1', 'r0', 'r1');
  A.add('r7', 'r7', 'r1');            // x += (digits - 1) * spacing
  A.label('dn_loop');
  A.mov('r0', 205);
  A.mul('r0', 'r6', 'r0');
  A.mov('r0', sh('r0', 11, 'lsr'));
  A.mov('r1', 10);
  A.mul('r1', 'r0', 'r1');
  A.sub('r2', 'r6', 'r1');            // digit
  A.mov('r6', 'r0');                  // value = quotient
  A.mov('r0', 'r7');
  A.mov('r1', 'r8');
  A.mov('r3', 'r10');
  A.mov('r4', 'r5');
  A.bl('draw_char');
  A.mov('r0', 6);
  A.mul('r0', 'r5', 'r0');
  A.sub('r7', 'r7', 'r0');
  A.sub('r9', 'r9', 1, { s: true });
  A.bne('dn_loop');
  A.pop('r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'pc');
  A.pool();

  // ============================================================ data
  A.align4();
  A.label('palette');
  for (let i = 0; i < PALETTE.length; i += 2) A.dw(PALETTE[i] | (PALETTE[i + 1] << 16));
  A.label('pagetab');
  A.dw(0x06000000, 0x0600A000);
  A.label('masks');
  for (const m of M) A.dw(m);
  A.label('font');
  A.db(fontBytes());
  A.label('s_level');
  A.db(strIdx('LEVEL'));
  A.label('s_moves');
  A.db(strIdx('MOVES'));
  A.label('s_on');
  A.db(strIdx('ON'));
  A.label('s_reset');
  A.db(strIdx('B:RESET'));
  A.label('s_solved');
  A.db(strIdx('SOLVED!'));
  A.label('s_pressa');
  A.db(strIdx('PRESS A'));
  A.label('s_lights');
  A.db(strIdx('LIGHTS'));
  A.label('s_out');
  A.db(strIdx('OUT'));
  A.label('s_puzzle');
  A.db(strIdx('PUZZLE'));
  A.label('s_press');
  A.db(strIdx('PRESS START'));
  A.label('s_ctrl1');
  A.db(strIdx('A:FLIP  B:RESET'));
  A.label('s_ctrl2');
  A.db(strIdx('START:NEW'));
  A.label('s_a');
  A.db(strIdx('A'));
  A.label('s_b');
  A.db(strIdx('B'));
  A.label('s_flip');
  A.db(strIdx('FLIP'));
  A.label('s_resetword');
  A.db(strIdx('RESET'));
  A.label('s_startword');
  A.db(strIdx('START'));
  A.label('s_new');
  A.db(strIdx('NEW'));
  A.label('s_lr');
  A.db(strIdx('L/R'));
  A.label('s_viewword');
  A.db(strIdx('VIEW'));
  // Demo board on the title screen: the 14-press solution of puzzle 0x9FA119
  // (generated offline with the same mask table) followed by a short blank
  // pause.  title_cursors picks the cell highlighted on each frame.
  A.align4();
  A.label('title_patterns');
  for (const p of [
    0x9FA119, 0x9FA13A, 0x9FA1B4, 0x9FB070,
    0x9FF360, 0x9F7F40, 0x9E6300, 0x9A1200,
    0x927000, 0xD56000, 0x5B4000, 0x1570000,
    0x1260000, 0x1C40000, 0, 0,
  ]) A.dw(p);
  A.label('title_cursors');
  A.db([0, 2, 7, 9, 10, 11, 13, 14, 17, 18, 19, 21, 22, 23, 12, 12]);
  A.label('stars');
  A.db([
    10, 18, 12, 24, 50, 9, 14, 82, 12, 26, 112, 9,
    12, 142, 12, 218, 20, 9, 230, 52, 12, 216, 84, 9,
    228, 114, 12, 212, 142, 9, 44, 126, 13, 196, 126, 13,
  ]);
  // Precomputed perspective geometry: 7 tilt levels of slab quads and 25 pad
  // quads; row-major, far row first so the painter's algorithm comes for free.
  A.align4();
  A.label('slabs3d');
  A.db(BOARD3D.slabs);
  A.align4();
  A.label('cells3d');
  A.db(BOARD3D.cells);
  A.align4();
}

module.exports = { buildProgram, VARS, V, maskTable, cellCentre3d, padBounds3d, YAW_DEFAULT };
