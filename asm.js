'use strict';
// Tiny ARMv4T (ARM state) assembler, written from scratch for this project.
// Registers are passed as strings: 'r0'..'r12','sp','lr','pc'.
// Immediates are plain numbers. Shifted register operands: sh('r5', 2, 'lsl').

const SH = { lsl: 0, lsr: 1, asr: 2, ror: 3 };
const CC = { eq: 0, ne: 1, cs: 2, hs: 2, cc: 3, lo: 3, mi: 4, pl: 5, vs: 6, vc: 7,
             hi: 8, ls: 9, ge: 10, lt: 11, gt: 12, le: 13, al: 14 };
const DP = { and: 0, eor: 1, sub: 2, rsb: 3, add: 4, adc: 5, sbc: 6, rsc: 7,
             tst: 8, teq: 9, cmp: 10, cmn: 11, orr: 12, mov: 13, bic: 14, mvn: 15 };
const RN = { sp: 13, lr: 14, pc: 15, ip: 12, fp: 11, sb: 9, sl: 10 };

function reg(x) {
  if (typeof x === 'number') throw new Error('expected register name, got number ' + x);
  if (RN[x] !== undefined) return RN[x];
  if (/^r([0-9]|1[0-5])$/.test(x)) return +x.slice(1);
  throw new Error('bad register ' + x);
}
function sh(rm, n, type) { return { rm, n: n | 0, type: type || 'lsl' }; }
function shR(rm, rs, type) { return { rm, rs, type: type || 'lsl' }; }
function rr(a, b) { const out = []; for (let i = reg(a); i <= reg(b); i++) out.push(i); return out; }

function ror32(x, n) { n &= 31; return n ? (((x >>> n) | (x << (32 - n))) >>> 0) : (x >>> 0); }
function encImm(v) {
  v = v >>> 0;
  if ((v & 0xFFFFFF00) === 0) return v & 0xFF;
  for (let rot = 1; rot < 16; rot++) {
    const n = rot * 2;
    const imm8 = (((v << n) | (v >>> (32 - n))) >>> 0) & 0xFF;
    if (ror32(imm8, n) === v) return (rot << 8) | imm8;
  }
  return -1;
}

class Asm {
  constructor(base) {
    this.base = base >>> 0;
    this.buf = [];
    this.labels = new Map();
    this.fix = [];
    this.pending = [];
  }
  get pc() { return (this.base + this.buf.length) >>> 0; }
  emit(w) {
    const off = this.buf.length; const v = w >>> 0;
    this.buf.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
    return off;
  }
  patch32(off, v) {
    v = v >>> 0;
    for (let i = 0; i < 4; i++) this.buf[off + i] = (v >>> (8 * i)) & 0xFF;
  }
  label(n) {
    if (this.labels.has(n)) throw new Error('duplicate label ' + n);
    this.labels.set(n, this.pc);
  }
  align4() { while (this.buf.length & 3) this.buf.push(0); }

  op2(o) {
    if (typeof o === 'number') {
      if (o < 0) o = o >>> 0;
      const e = encImm(o);
      if (e < 0) throw new Error('immediate 0x' + (o >>> 0).toString(16) + ' not encodable');
      return { I: 1, bits: e >>> 0 };
    }
    if (typeof o === 'string') return { I: 0, bits: reg(o) };
    if (o && o.rm !== undefined) {
      const type = SH[o.type || 'lsl'];
      const rm = reg(o.rm);
      if (o.rs !== undefined) return { I: 0, bits: (((reg(o.rs) & 15) << 8) | (type << 5) | 0x10 | rm) >>> 0 };
      let n = o.n | 0;
      if (n === 32 && type !== 0) n = 0;
      if (n < 0 || n > 31) throw new Error('bad shift ' + n);
      return { I: 0, bits: (((n << 7) | (type << 5) | rm) >>> 0) };
    }
    throw new Error('bad operand2 ' + JSON.stringify(o));
  }

  dp(op, rd, rn, o2, opts) {
    opts = opts || {};
    const cond = CC[opts.cond || 'al'];
    const { I, bits } = this.op2(o2);
    const w = ((cond << 28) | (I << 25) | (op << 21) | ((opts.s ? 1 : 0) << 20) |
               ((reg(rn) & 15) << 16) | ((reg(rd) & 15) << 12) | bits) >>> 0;
    return this.emit(w);
  }
  mov(rd, o2, o) { return this.dp(13, rd, 'r0', o2, o); }
  mvn(rd, o2, o) { return this.dp(15, rd, 'r0', o2, o); }
  and(rd, rn, o2, o) { return this.dp(0, rd, rn, o2, o); }
  eor(rd, rn, o2, o) { return this.dp(1, rd, rn, o2, o); }
  sub(rd, rn, o2, o) { return this.dp(2, rd, rn, o2, o); }
  rsb(rd, rn, o2, o) { return this.dp(3, rd, rn, o2, o); }
  add(rd, rn, o2, o) { return this.dp(4, rd, rn, o2, o); }
  adc(rd, rn, o2, o) { return this.dp(5, rd, rn, o2, o); }
  sbc(rd, rn, o2, o) { return this.dp(6, rd, rn, o2, o); }
  orr(rd, rn, o2, o) { return this.dp(12, rd, rn, o2, o); }
  bic(rd, rn, o2, o) { return this.dp(14, rd, rn, o2, o); }
  tst(rn, o2, o) { return this.dp(8, 'r0', rn, o2, Object.assign({ s: true }, o)); }
  teq(rn, o2, o) { return this.dp(9, 'r0', rn, o2, Object.assign({ s: true }, o)); }
  cmp(rn, o2, o) { return this.dp(10, 'r0', rn, o2, Object.assign({ s: true }, o)); }
  cmn(rn, o2, o) { return this.dp(11, 'r0', rn, o2, Object.assign({ s: true }, o)); }
  lsl(rd, rm, n, o) { return this.dp(13, rd, 'r0', sh(rm, n, 'lsl'), o); }
  lsr(rd, rm, n, o) { return this.dp(13, rd, 'r0', sh(rm, n, 'lsr'), o); }
  asr(rd, rm, n, o) { return this.dp(13, rd, 'r0', sh(rm, n, 'asr'), o); }

  mul(rd, rm, rs, o) {
    o = o || {};
    const w = ((CC[o.cond || 'al'] << 28) | ((o.s ? 1 : 0) << 20) | ((reg(rd) & 15) << 16) |
               ((reg(rs) & 15) << 8) | 0x90 | (reg(rm) & 15)) >>> 0;
    return this.emit(w);
  }
  mla(rd, rm, rs, rn, o) {
    o = o || {};
    const w = ((CC[o.cond || 'al'] << 28) | (1 << 21) | ((o.s ? 1 : 0) << 20) | ((reg(rd) & 15) << 16) |
               ((reg(rn) & 15) << 12) | ((reg(rs) & 15) << 8) | 0x90 | (reg(rm) & 15)) >>> 0;
    return this.emit(w);
  }

  ldr(rd, rn, off, o) { return this.ls(1, 0, rd, rn, off, o); }
  str(rd, rn, off, o) { return this.ls(0, 0, rd, rn, off, o); }
  ldrb(rd, rn, off, o) { return this.ls(1, 1, rd, rn, off, o); }
  strb(rd, rn, off, o) { return this.ls(0, 1, rd, rn, off, o); }

  ls(load, byte, rd, rn, off, o) {
    o = o || {};
    const cond = CC[o.cond || 'al'];
    let I = 0, bits = 0;
    if (typeof off === 'number') bits = 0;
    else {
      I = 1;
      if (typeof off === 'string') bits = reg(off);
      else {
        const type = SH[off.type || 'lsl'];
        let n = off.n | 0; if (n === 32 && type !== 0) n = 0;
        bits = ((n << 7) | (type << 5) | reg(off.rm)) >>> 0;
      }
    }
    let U = 1, imm = 0;
    if (typeof off === 'number') { U = off >= 0 ? 1 : 0; imm = Math.abs(off); }
    if (imm > 4095) throw new Error('ldr/str offset too large');
    const P = o.post ? 0 : 1;
    const W = (o.post ? 1 : (o.wb ? 1 : 0));
    const w = ((cond << 28) | (1 << 26) | (I << 25) | (P << 24) | (U << 23) | (byte << 22) |
               (W << 21) | (load << 20) | ((reg(rn) & 15) << 16) | ((reg(rd) & 15) << 12) |
               (I ? bits : (imm & 0xFFF))) >>> 0;
    return this.emit(w);
  }

  // halfword / signed transfers.  kind: 'h' (u16), 'sb', 'sh'
  lsh(load, kind, rd, rn, off, o) {
    o = o || {};
    const cond = CC[o.cond || 'al'];
    const SHB = kind === 'h' ? 1 : (kind === 'sb' ? 2 : 3);
    let I = 1, imm = 0, bits = 0;
    if (typeof off === 'number') { imm = Math.abs(off); if (imm > 255) throw new Error('half offset too large'); }
    else {
      I = 0;
      if (typeof off === 'string') bits = reg(off);
      else bits = ((SH[off.type || 'lsl'] << 5) | reg(off.rm)) >>> 0;
    }
    const U = (typeof off === 'number' && off < 0) ? 0 : 1;
    const P = o.post ? 0 : 1;
    const W = (o.post ? 1 : (o.wb ? 1 : 0));
    const w = ((cond << 28) | (P << 24) | (U << 23) | (I << 22) | (W << 21) | (load << 20) |
               ((reg(rn) & 15) << 16) | ((reg(rd) & 15) << 12) |
               (I ? (((imm & 0xF0) << 4) | 0x90 | (SHB << 5) | (imm & 0xF))
                  : (0x90 | (SHB << 5) | bits))) >>> 0;
    return this.emit(w);
  }
  ldrh(rd, rn, off, o) { return this.lsh(1, 'h', rd, rn, off, o); }
  strh(rd, rn, off, o) { return this.lsh(0, 'h', rd, rn, off, o); }
  ldrsb(rd, rn, off, o) { return this.lsh(1, 'sb', rd, rn, off, o); }
  ldrsh(rd, rn, off, o) { return this.lsh(1, 'sh', rd, rn, off, o); }

  stm(kind, rn, list, o) {
    o = o || {};
    const P = /b$/.test(kind) ? 1 : 0, U = /^(i|d)/.test(kind) && kind[0] === 'i' ? 1 : 1;
    let Pbit, Ubit;
    if (kind === 'ia') { Pbit = 0; Ubit = 1; } else if (kind === 'ib') { Pbit = 1; Ubit = 1; }
    else if (kind === 'da') { Pbit = 0; Ubit = 0; } else if (kind === 'db') { Pbit = 1; Ubit = 0; }
    else throw new Error('bad stm kind ' + kind);
    let m = 0; for (const r of list) m |= 1 << reg(r);
    const w = ((CC[o.cond || 'al'] << 28) | (4 << 25) | (Pbit << 24) | (Ubit << 23) | ((o.wb ? 1 : 0) << 21) |
               ((o.load ? 1 : 0) << 20) | ((reg(rn) & 15) << 16) | (m >>> 0)) >>> 0;
    return this.emit(w);
  }
  push(...list) { return this.stm('db', 'sp', flat(list), { wb: true }); }
  pop(...list) { return this.stm('ia', 'sp', flat(list), { wb: true, load: true }); }

  b(target, cond) {
    const c = CC[typeof cond === 'string' ? cond : 'al'];
    const off = this.emit((c << 28) | 0x0A000000);
    this.fix.push({ off, target, kind: 'b', at: (this.base + off) >>> 0 });
    return off;
  }
  bl(target) {
    const off = this.emit(0xEB000000);
    this.fix.push({ off, target, kind: 'b', at: (this.base + off) >>> 0 });
    return off;
  }
  bx(rm, o) {
    o = o || {};
    return this.emit(((CC[o.cond || 'al'] << 28) | 0x012FFF10 | reg(rm)) >>> 0);
  }
  nop() { return this.emit(0xE1A00000); }

  // load a 32-bit constant / label address through a literal pool
  ldrk(rd, val) {
    const off = this.emit(0xE59F0000 | ((reg(rd) & 15) << 12));
    this.pending.push({ off, rd: reg(rd), val, at: (this.base + off) >>> 0 });
    return off;
  }
  pool() {
    if (!this.pending.length) return;
    this.align4();
    const base = this.pc;
    const list = this.pending;
    this.pending = [];
    list.forEach((p, i) => {
      const disp = (base + i * 4) - (p.at + 8);
      if (disp < 0 || disp > 4095) throw new Error('literal pool out of reach: ' + disp);
      this.patch32(p.off, (0xE59F0000 | ((p.rd & 15) << 12) | (disp & 0xFFF)) >>> 0);
    });
    for (const p of list) {
      if (typeof p.val === 'number') this.dw(p.val);
      else this.dw(p.val.label);
    }
  }
  dw(...vals) {
    for (const v of vals) {
      if (typeof v === 'number') this.emit(v);
      else if (typeof v === 'string') { const off = this.emit(0); this.fix.push({ off, kind: 'word', target: v }); }
      else if (v && v.label) { const off = this.emit(0); this.fix.push({ off, kind: 'word', target: v.label }); }
      else throw new Error('bad dw ' + v);
    }
  }
  dh(...vals) { for (const v of vals) this.buf.push(v & 0xFF, (v >>> 8) & 0xFF); }
  db(arr) { for (const b of arr) this.buf.push(b & 0xFF); }
  ascii(s) { for (let i = 0; i < s.length; i++) this.buf.push(s.charCodeAt(i) & 0xFF); }

  assemble() {
    if (this.pending.length) throw new Error('literal pool not flushed');
    for (const f of this.fix) {
      const t = this.labels.get(f.target);
      if (t === undefined) throw new Error('undefined label ' + f.target);
      if (f.kind === 'b') {
        const d = ((t - (f.at + 8)) >> 2);
        const w = ((this.u32(f.off) & 0xFF000000) | (d & 0xFFFFFF)) >>> 0;
        this.patch32(f.off, w);
      } else if (f.kind === 'word') {
        this.patch32(f.off, t >>> 0);
      }
    }
    return { buf: Uint8Array.from(this.buf), base: this.base, labels: this.labels, size: this.buf.length };
  }
  u32(off) {
    return ((this.buf[off] | (this.buf[off + 1] << 8) | (this.buf[off + 2] << 16) | (this.buf[off + 3] << 24)) >>> 0);
  }
}

function flat(list) {
  const out = [];
  for (const x of list) { if (Array.isArray(x)) out.push(...x); else out.push(x); }
  return out;
}

// conditional variants: A.movne(...), A.addeq(...), A.ble('label'), ...
const CONDS = ['eq', 'ne', 'cs', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le'];
const COND_METHODS = ['mov', 'mvn', 'add', 'sub', 'rsb', 'adc', 'sbc', 'and', 'orr', 'eor', 'bic',
  'mul', 'mla', 'ldr', 'str', 'ldrb', 'strb', 'ldrh', 'strh', 'ldrsb', 'ldrsh', 'cmp', 'tst', 'bx',
  'lsl', 'lsr', 'asr'];
for (const c of CONDS) {
  for (const m of COND_METHODS) {
    Asm.prototype[m + c] = function (...args) {
      const last = args[args.length - 1];
      if (last && typeof last === 'object' && last.rm === undefined && last.label === undefined) {
        args[args.length - 1] = Object.assign({}, last, { cond: c });
      } else args.push({ cond: c });
      return this[m](...args);
    };
  }
  Asm.prototype['b' + c] = function (t) { return this.b(t, c); };
}

module.exports = { Asm, reg, sh, shR, rr, CC, SH };
