'use strict';
// Minimal ARMv4T / GBA interpreter used only for testing the ROM headlessly.
// Implements exactly the instruction subset the assembler emits, plus enough
// of the memory map (VRAM / palette / IO / keypad / VCOUNT) to run the game.

const CYC_PER_LINE = 1232;
const LINES = 228;
const CYC_PER_FRAME = CYC_PER_LINE * LINES; // 280896

class GBA {
  constructor(rom, labels) {
    this.rom = rom;
    this.labels = labels || new Map();
    this.r = new Uint32Array(16);
    this.N = this.Z = this.C = this.V = 0;
    this.cycles = 0;
    this.frames = 0;
    this.iwram = new Uint8Array(0x8000);
    this.ewram = new Uint8Array(0x40000);
    this.vram = new Uint8Array(0x18000);
    this.pal = new Uint8Array(0x400);
    this.oam = new Uint8Array(0x400);
    this.io = new Uint8Array(0x400);
    this.keys = 0x3FF;       // active low, 1 = released
    this.lastPc = 0;
    this.traceBuf = [];
    this.instructions = 0;
    this.page = 0;
    this.dispcnt = 0;
    this.r[15] = 0x08000000;
  }

  // ---------- memory ----------
  read8(a) {
    a >>>= 0;
    if (a < 0x4000) return 0;
    if (a >= 0x02000000 && a < 0x02040000) return this.ewram[a & 0x3FFFF];
    if (a >= 0x03000000 && a < 0x03008000) return this.iwram[a & 0x7FFF];
    if (a >= 0x04000000 && a < 0x04000400) return this.ioRead8(a & 0x3FF);
    if (a >= 0x05000000 && a < 0x05000400) return this.pal[a & 0x3FF];
    if (a >= 0x06000000 && a < 0x06018000) return this.vram[a & 0x1FFFF];
    if (a >= 0x07000000 && a < 0x07000400) return this.oam[a & 0x3FF];
    if (a >= 0x08000000 && a < 0x0A000000) return this.rom[a & 0x1FFFFFF] || 0;
    if (a >= 0x0E000000) return 0xFF;
    return 0;
  }
  read16(a) {
    a >>>= 0;
    if (a >= 0x04000000 && a < 0x04000400) {
      const o = a & 0x3FF;
      if (o === 0x06) return this.vcount();
      if (o === 0x04) return (this.vcount() >= 160) ? 1 : 0;
    }
    return (this.read8(a) | (this.read8(a + 1) << 8)) & 0xFFFF;
  }
  read32(a) {
    a >>>= 0;
    if (a >= 0x08000000 && a < 0x0A000000) {
      const i = a & 0x1FFFFFF;
      return ((this.rom[i] | (this.rom[i + 1] << 8) | (this.rom[i + 2] << 16) | (this.rom[i + 3] << 24)) >>> 0);
    }
    if (a >= 0x03000000 && a < 0x03008000) {
      const i = a & 0x7FFF;
      return ((this.iwram[i] | (this.iwram[i + 1] << 8) | (this.iwram[i + 2] << 16) | (this.iwram[i + 3] << 24)) >>> 0);
    }
    return ((this.read16(a) | (this.read16(a + 2) << 16)) >>> 0);
  }
  write8(a, v) {
    a >>>= 0; v &= 0xFF;
    if (a >= 0x02000000 && a < 0x02040000) { this.ewram[a & 0x3FFFF] = v; return; }
    if (a >= 0x03000000 && a < 0x03008000) { this.iwram[a & 0x7FFF] = v; return; }
    if (a >= 0x04000000 && a < 0x04000400) { this.ioWrite(a & 0x3FF, v, 0xFF); return; }
    if (a >= 0x05000000 && a < 0x05000400) { this.pal[a & 0x3FF] = v; return; }
    if (a >= 0x06000000 && a < 0x06018000) { this.vram[a & 0x1FFFF] = v; return; }
    if (a >= 0x07000000 && a < 0x07000400) { this.oam[a & 0x3FF] = v; return; }
  }
  write16(a, v) {
    a >>>= 0; v &= 0xFFFF;
    if (a >= 0x04000000 && a < 0x04000400) { this.ioWrite(a & 0x3FF, v, 0xFFFF); return; }
    if (a >= 0x05000000 && a < 0x05000400) { this.pal[a & 0x3FF] = v & 0xFF; this.pal[(a & 0x3FF) + 1] = v >> 8; return; }
    if (a >= 0x06000000 && a < 0x06018000) { this.vram[a & 0x1FFFF] = v & 0xFF; this.vram[(a & 0x1FFFF) + 1] = v >> 8; return; }
    this.write8(a, v); this.write8(a + 1, v >> 8);
  }
  write32(a, v) {
    a >>>= 0; v >>>= 0;
    if (a >= 0x06000000 && a < 0x06018000) {
      const i = a & 0x1FFFF;
      this.vram[i] = v & 0xFF; this.vram[i + 1] = (v >>> 8) & 0xFF;
      this.vram[i + 2] = (v >>> 16) & 0xFF; this.vram[i + 3] = (v >>> 24) & 0xFF;
      return;
    }
    if (a >= 0x03000000 && a < 0x03008000) {
      const i = a & 0x7FFF;
      this.iwram[i] = v & 0xFF; this.iwram[i + 1] = (v >>> 8) & 0xFF;
      this.iwram[i + 2] = (v >>> 16) & 0xFF; this.iwram[i + 3] = (v >>> 24) & 0xFF;
      return;
    }
    if (a >= 0x04000000 && a < 0x04000400) { this.ioWrite(a & 0x3FF, v & 0xFFFF, 0xFFFF); this.ioWrite((a & 0x3FF) + 2, v >>> 16, 0xFFFF); return; }
    this.write16(a, v & 0xFFFF); this.write16(a + 2, v >>> 16);
  }
  ioRead8(o) {
    if (o === 0x06 || o === 0x07) { const v = this.vcount(); return o === 0x06 ? (v & 0xFF) : (v >> 8); }
    if (o >= 0x130 && o <= 0x131) return o === 0x130 ? (this.keys & 0xFF) : ((this.keys >> 8) & 0xFF);
    return this.io[o];
  }
  ioWrite(o, v, mask) {
    if (o === 0x00) {
      this.dispcnt = (v & 0xFFFF);
      this.io[o] = v & 0xFF; this.io[o + 1] = (v >> 8) & 0xFF;
      return;
    }
    this.io[o] = v & 0xFF;
    if (o + 1 < 0x400 && mask > 0xFF) this.io[o + 1] = (v >> 8) & 0xFF;
  }
  vcount() { return Math.floor((this.cycles % CYC_PER_FRAME) / CYC_PER_LINE) % LINES; }

  // ---------- register helpers ----------
  readReg(i) { return i === 15 ? ((this.r[15] + 4) >>> 0) : this.r[i]; }
  setNZ(v) { this.N = (v >>> 31) & 1; this.Z = v === 0 ? 1 : 0; }
  cond(c) {
    switch (c) {
      case 0: return this.Z === 1;
      case 1: return this.Z === 0;
      case 2: return this.C === 1;
      case 3: return this.C === 0;
      case 4: return this.N === 1;
      case 5: return this.N === 0;
      case 6: return this.V === 1;
      case 7: return this.V === 0;
      case 8: return this.C === 1 && this.Z === 0;
      case 9: return this.C === 0 || this.Z === 1;
      case 10: return this.N === this.V;
      case 11: return this.N !== this.V;
      case 12: return this.Z === 0 && this.N === this.V;
      case 13: return this.Z === 1 || this.N !== this.V;
      case 14: return true;
      default: return true;
    }
  }

  shift(val, type, amount, byReg, regVal) {
    // returns [result, carryOut]
    val >>>= 0;
    let carry = this.C;
    if (byReg) {
      const n = regVal & 0xFF;
      if (n === 0) return [val, carry];
      if (type === 0) {
        if (n < 32) { carry = (val >>> (32 - n)) & 1; val = (val << n) >>> 0; }
        else if (n === 32) { carry = val & 1; val = 0; }
        else { carry = 0; val = 0; }
      } else if (type === 1) {
        if (n < 32) { carry = (val >>> (n - 1)) & 1; val = val >>> n; }
        else if (n === 32) { carry = val >>> 31; val = 0; }
        else { carry = 0; val = 0; }
      } else if (type === 2) {
        if (n < 32) { carry = (val >>> (n - 1)) & 1; val = (val | (val & 0x80000000 ? 0xFFFFFFFE : 0)) >> n; val >>>= 0; }
        else { carry = val >>> 31; val = (val & 0x80000000) ? 0xFFFFFFFF : 0; }
      } else {
        const m = n & 31;
        if (m === 0) return [val, carry];
        val = ((val >>> m) | (val << (32 - m))) >>> 0; carry = (val >>> 31) & 1;
      }
      return [val >>> 0, carry];
    }
    let n = amount;
    if (type === 0) {
      if (n === 0) return [val, carry];
      carry = n < 32 ? (val >>> (32 - n)) & 1 : 0;
      val = n < 32 ? (val << n) >>> 0 : 0;
    } else if (type === 1) {
      if (n === 0) n = 32;
      carry = n <= 32 ? (val >>> (n - 1)) & 1 : 0;
      val = n < 32 ? (val >>> n) : 0;
    } else if (type === 2) {
      if (n === 0) n = 32;
      carry = n <= 32 ? (val >>> (n - 1)) & 1 : (val >>> 31);
      if (n < 32) val = (val >> n) >>> 0;
      else val = (val & 0x80000000) ? 0xFFFFFFFF : 0;
    } else {
      const m = n & 31;
      if (m === 0) { carry = val >>> 31; }
      else { val = ((val >>> m) | (val << (32 - m))) >>> 0; carry = (val >>> 31) & 1; }
    }
    return [val >>> 0, carry];
  }

  // ---------- execution ----------
  step() {
    const pc = this.r[15] >>> 0;
    const w = this.read32(pc);
    this.lastPc = pc;
    this.r[15] = (pc + 4) >>> 0;
    this.cycles += 1;
    this.instructions++;
    const c = w >>> 28;
    if (c !== 14 && !this.cond(c)) return;
    const cls = (w >>> 25) & 7;
    if (cls === 0 || cls === 1) {
      if (cls === 0 && (w & 0x0FFFFFF0) === 0x012FFF10) { // BX
        const t = this.readReg(w & 15);
        if (t & 1) throw new Error('Thumb switch at 0x' + pc.toString(16));
        this.r[15] = (t & ~3) >>> 0;
        this.cycles += 2;
        return;
      }
      if ((w & 0x0F0000F0) === 0x00000090) { // MUL / MLA
        const A = (w >>> 21) & 1, S = (w >>> 20) & 1;
        const rd = (w >>> 16) & 15, rn = (w >>> 12) & 15, rs = (w >>> 8) & 15, rm = w & 15;
        let res = Math.imul(this.readReg(rm), this.readReg(rs)) >>> 0;
        if (A) res = (res + this.readReg(rn)) >>> 0;
        this.r[rd] = res;
        if (S) this.setNZ(res);
        this.cycles += 2;
        return;
      }
      if ((w & 0x0F8000F0) === 0x00800090) { // long multiply
        const U = (w >>> 22) & 1, A = (w >>> 21) & 1, S = (w >>> 20) & 1;
        const hi = (w >>> 16) & 15, lo = (w >>> 12) & 15, rs = (w >>> 8) & 15, rm = w & 15;
        let a = this.readReg(rm), b = this.readReg(rs);
        let p;
        if (U) p = BigInt(a >>> 0) * BigInt(b >>> 0);
        else p = BigInt(a | 0) * BigInt(b | 0);
        if (A) p += (BigInt(this.readReg(hi) >>> 0) << 32n) | BigInt(this.readReg(lo) >>> 0);
        p = BigInt.asUintN(64, p);
        this.r[lo] = Number(p & 0xFFFFFFFFn) >>> 0;
        this.r[hi] = Number(p >> 32n) >>> 0;
        if (S) { this.N = this.r[hi] >>> 31; this.Z = p === 0n ? 1 : 0; }
        this.cycles += 4;
        return;
      }
      if (cls === 0 && (w & 0x90) === 0x90 && (w & 0x60) !== 0) { // halfword / signed transfer
        return this.opHalf(w);
      }
      // data processing
      const I = (w >>> 25) & 1, op = (w >>> 21) & 15, S = (w >>> 20) & 1;
      const rn = (w >>> 16) & 15, rd = (w >>> 12) & 15;
      let op2, carry = this.C;
      if (I) {
        const imm = w & 0xFF, rot = ((w >>> 8) & 15) * 2;
        op2 = rot === 0 ? imm : (((imm >>> rot) | (imm << (32 - rot))) >>> 0);
        if (rot && S) carry = (op2 >>> 31) & 1;
      } else {
        const type = (w >>> 5) & 3, byReg = (w >>> 4) & 1;
        const rm = w & 15;
        const amount = (w >>> 7) & 31;
        const rs = (w >>> 8) & 15;
        const [v, cy] = this.shift(this.readReg(rm), type, amount, byReg, byReg ? this.readReg(rs) : 0);
        op2 = v; carry = cy;
      }
      let a = this.readReg(rn), b = op2;
      let res = 0, write = true;
      switch (op) {
        case 0: res = (a & b) >>> 0; break;
        case 1: res = (a ^ b) >>> 0; break;
        case 2: res = (a - b) >>> 0; this.setSubC(a, b, 0); break;
        case 3: res = (b - a) >>> 0; this.setSubC(b, a, 0); break;
        case 4: res = (a + b) >>> 0; this.setAddC(a, b, 0); break;
        case 5: res = (a + b + this.C) >>> 0; this.setAddC(a, b, this.C); break;
        case 6: res = (a - b - (1 - this.C)) >>> 0; this.setSubC(a, b, 1 - this.C); break;
        case 7: res = (b - a - (1 - this.C)) >>> 0; this.setSubC(b, a, 1 - this.C); break;
        case 8: this.setNZ(a & b); return;
        case 9: this.setNZ(a ^ b); return;
        case 10: this.setSubC(a, b, 0); this.setNZ(res = (a - b) >>> 0); return;
        case 11: this.setAddC(a, b, 0); this.setNZ((a + b) >>> 0); return;
        case 12: res = (a | b) >>> 0; break;
        case 13: res = b; break;
        case 14: res = (a & ~b) >>> 0; break;
        case 15: res = (~b) >>> 0; break;
      }
      if (op !== 2 && op !== 3 && op !== 4 && op !== 5 && op !== 6 && op !== 7 && S) {
        this.C = carry;
      }
      if (S) this.setNZ(res);
      if (rd !== 15) this.r[rd] = res;
      else this.r[15] = res & ~3;
      return;
    }
    if (cls === 2 || cls === 3) return this.opSingle(w, cls === 3);
    if (cls === 4) return this.opBlock(w);
    if (cls === 5) { // branch
      const L = (w >>> 24) & 1;
      let off = (w & 0xFFFFFF) << 2;
      if (off & 0x02000000) off |= 0xFC000000;
      off = off | 0;
      if (L) this.r[14] = this.r[15] >>> 0;
      this.r[15] = (this.r[15] + 4 + off) >>> 0;
      this.cycles += 2;
      return;
    }
    if (cls === 7) { // SWI -> ignore
      this.cycles += 3;
      return;
    }
    throw new Error('unimplemented opcode 0x' + w.toString(16) + ' at 0x' + pc.toString(16));
  }

  setSubC(a, b, cin) {
    const r = (a - b - cin) >>> 0;
    this.C = (a >>> 0) >= ((b + cin) >>> 0) ? 1 : 0;
    this.V = (((a ^ b) & (a ^ r)) >>> 31) & 1;
  }
  setAddC(a, b, cin) {
    const r = (a + b + cin) >>> 0;
    this.C = (r < (a >>> 0)) ? 1 : 0;
    this.V = ((~(a ^ b) & (a ^ r)) >>> 31) & 1;
  }

  opSingle(w, regOffset) {
    const I = regOffset ? 1 : 0, P = (w >>> 24) & 1, U = (w >>> 23) & 1;
    const B = (w >>> 22) & 1;
    const W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 15, rd = (w >>> 12) & 15;
    let off;
    if (I) {
      const type = (w >>> 5) & 3, n = (w >>> 7) & 31;
      off = this.shift(this.readReg(w & 15), type, n, 0, 0)[0];
    } else off = w & 0xFFF;
    const base = this.readReg(rn) >>> 0;
    let addr = P ? (U ? base + off : base - off) : base;
    addr >>>= 0;
    if (L) {
      let v = B ? this.read8(addr) : this.read32(addr);
      if (rd === 15) { this.r[15] = v & ~3; }
      else this.r[rd] = v >>> 0;
    } else {
      const v = this.readReg(rd);
      if (B) this.write8(addr, v & 0xFF); else this.write32(addr, v);
    }
    if (!P) { addr = U ? base + off : base - off; this.r[rn] = addr >>> 0; }
    else if (W) this.r[rn] = (U ? base + off : base - off) >>> 0;
    this.cycles += 1;
  }

  opHalf(w) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, I = (w >>> 22) & 1;
    const W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 15, rd = (w >>> 12) & 15;
    const SH = (w >>> 5) & 3;
    let off;
    if (I) off = ((w >>> 4) & 0xF0) | (w & 0xF);
    else off = this.readReg(w & 15) >>> 0;
    const base = this.readReg(rn) >>> 0;
    const addr = ((P ? (U ? base + off : base - off) : base) >>> 0);
    if (L) {
      let v;
      if (SH === 1) v = this.read16(addr);
      else if (SH === 2) { v = this.read8(addr); if (v & 0x80) v |= 0xFFFFFF00; }
      else { v = this.read16(addr); if (v & 0x8000) v |= 0xFFFF0000; }
      this.r[rd] = v >>> 0;
    } else {
      const v = this.readReg(rd);
      if (SH === 1) this.write16(addr, v & 0xFFFF);
      else this.write8(addr, v & 0xFF);
    }
    if (!P || W) this.r[rn] = (U ? base + off : base - off) >>> 0;
    this.cycles += 1;
  }

  opBlock(w) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, S = (w >>> 22) & 1;
    const W = (w >>> 21) & 1, L = (w >>> 20) & 1;
    const rn = (w >>> 16) & 15;
    const list = w & 0xFFFF;
    let base = this.readReg(rn) >>> 0;
    let n = 0;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
    if (n === 0) throw new Error('empty ldm/stm');
    let addr;
    if (U) addr = (base + (P ? 4 : 0)) >>> 0;
    else addr = (base - n * 4 + (P ? 0 : 4)) >>> 0;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      if (L) {
        const v = this.read32(addr);
        if (i === 15) this.r[15] = v & ~3; else this.r[i] = v >>> 0;
      } else {
        this.write32(addr, this.readReg(i));
      }
      addr = (addr + 4) >>> 0;
    }
    if (W) {
      const nbase = U ? (base + n * 4) >>> 0 : (base - n * 4) >>> 0;
      if (L && (list & (1 << rn)) && !(list & (1 << 15))) { /* unpredictable */ }
      this.r[rn] = nbase;
    }
    this.cycles += n + 1;
  }

  // ---------- driver ----------
  runUntilFrame(target) {
    const t = target * CYC_PER_FRAME;
    while (this.cycles < t) this.step();
    this.frames = target;
  }
  runCycles(n) { for (let i = 0; i < n; i++) this.step(); }
  runInstructions(n) { for (let i = 0; i < n; i++) this.step(); }

  nearestLabel(pc) {
    let best = null, bd = 1 << 30;
    for (const [name, addr] of this.labels) {
      const d = pc - addr;
      if (d >= 0 && d < bd) { bd = d; best = name; }
    }
    return best ? best + '+0x' + bd.toString(16) : '?';
  }

  // framebuffer of the currently displayed page as RGB
  framebufferRGB() {
    const base = (this.dispcnt & 0x10) ? 0xA000 : 0;
    const out = new Uint8Array(240 * 160 * 3);
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 240; x++) {
        const idx = this.vram[base + y * 240 + x];
        const col = this.pal[idx * 2] | (this.pal[idx * 2 + 1] << 8);
        const r = (col & 31) * 255 / 31 | 0;
        const g = ((col >> 5) & 31) * 255 / 31 | 0;
        const b = ((col >> 10) & 31) * 255 / 31 | 0;
        const o = (y * 240 + x) * 3;
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
      }
    }
    return out;
  }
}

module.exports = { GBA, CYC_PER_FRAME };
