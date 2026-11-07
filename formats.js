/*! Planches — bibliothèque de formats : archives RAR (CBR) et détection d'images.
 *
 *  Décodeur RAR écrit pour Planches, en JavaScript pur :
 *    - RAR 2.9 à 4.x (« RAR3 ») : LZ + Huffman, PPMd var.H, filtres standards
 *      (E8, E8E9, Itanium, Delta, RGB, Audio) ;
 *    - RAR 5 et RAR 7 : LZ + Huffman, filtres Delta, E8, E8E9, ARM ;
 *    - fichiers « stockés » (sans compression), archives solides.
 *  Non pris en charge : chiffrement, volumes multiples, ancien format RAR 1.5/2.0.
 *
 *  Le modèle PPMd suit l'algorithme PPMd var.H de Dmitry Shkarin et
 *  l'implémentation du domaine public d'Igor Pavlov (7-Zip).
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.PlanchesFormats = lib;
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------------------------------------------------------------- utilitaires
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, crc = 0, start = 0, end = buf.length) {
  crc = ~crc;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

class RarError extends Error {
  constructor(message, code) { super(message); this.name = 'RarError'; this.code = code || 'error'; }
}

const u16le = (b, p) => b[p] | (b[p + 1] << 8);
const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u32be = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeCP437(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  }
  return s;
}
let utf8Fatal = null, utf8Loose = null;
function decodeUTF8(bytes, fatal) {
  if (fatal) {
    if (!utf8Fatal) utf8Fatal = new TextDecoder('utf-8', { fatal: true });
    return utf8Fatal.decode(bytes);
  }
  if (!utf8Loose) utf8Loose = new TextDecoder('utf-8');
  return utf8Loose.decode(bytes);
}
/** Nom de fichier : UTF-8 si valide, sinon page de code DOS 437. */
function decodeName(bytes, isUtf8) {
  if (isUtf8) return decodeUTF8(bytes, false);
  let ascii = true;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) { ascii = false; break; }
  if (ascii) return String.fromCharCode.apply(null, bytes);
  try { return decodeUTF8(bytes, true); } catch (e) { return decodeCP437(bytes); }
}

// --------------------------------------------------------------- lecture bits
function makeInput(data) {
  const buf = new Uint8Array(data.length + 256);
  buf.set(data);
  return { buf, addr: 0, bit: 0, len: data.length };
}
function getbits(inp) {
  const b = inp.buf, a = inp.addr;
  return ((((b[a] << 16) | (b[a + 1] << 8) | b[a + 2]) >>> (8 - inp.bit)) & 0xffff);
}
function getbits32(inp) {
  const b = inp.buf, a = inp.addr, s = inp.bit;
  let v = ((b[a] << 24) | (b[a + 1] << 16) | (b[a + 2] << 8) | b[a + 3]) >>> 0;
  if (s) v = ((v << s) | (b[a + 4] >>> (8 - s))) >>> 0;
  return v;
}
function addbits(inp, n) {
  n += inp.bit;
  inp.addr += n >>> 3;
  inp.bit = n & 7;
}
/** Lit n bits (n ≤ 53) en plusieurs fois. */
function readBitsLong(inp, n) {
  let v = 0;
  while (n > 0) {
    const k = n > 16 ? 16 : n;
    v = v * (1 << k) + (getbits(inp) >>> (16 - k));
    addbits(inp, k);
    n -= k;
  }
  return v;
}

// ------------------------------------------------------------------- Huffman
function makeDecodeTable(lens, off, size, quickBits) {
  const decodeLen = new Uint32Array(16), decodePos = new Uint32Array(16);
  const decodeNum = new Uint16Array(size);
  const lengthCount = new Uint32Array(16);
  for (let i = 0; i < size; i++) lengthCount[lens[off + i] & 0xf]++;
  lengthCount[0] = 0;
  let upperLimit = 0;
  for (let i = 1; i < 16; i++) {
    upperLimit += lengthCount[i];
    decodeLen[i] = upperLimit << (16 - i);
    upperLimit *= 2;
    decodePos[i] = decodePos[i - 1] + lengthCount[i - 1];
  }
  const copyPos = decodePos.slice();
  for (let i = 0; i < size; i++) {
    const l = lens[off + i] & 0xf;
    if (l !== 0) decodeNum[copyPos[l]++] = i;
  }
  const qsize = 1 << quickBits;
  const quickLen = new Uint8Array(qsize), quickNum = new Uint16Array(qsize);
  let cur = 0;
  for (let code = 0; code < qsize; code++) {
    const bitField = code << (16 - quickBits);
    while (cur < 16 && bitField >= decodeLen[cur]) cur++;
    if (cur >= 16) { quickLen[code] = 0; quickNum[code] = 0; continue; }
    quickLen[code] = cur;
    const dist = bitField - decodeLen[cur - 1];
    const pos = decodePos[cur] + (dist >>> (16 - cur));
    quickNum[code] = pos < size ? decodeNum[pos] : 0;
  }
  return { maxNum: size, decodeLen, decodePos, decodeNum, quickBits, quickLen, quickNum };
}

function decodeNumber(inp, t) {
  const b = inp.buf, a = inp.addr;
  const bitField = ((((b[a] << 16) | (b[a + 1] << 8) | b[a + 2]) >>> (8 - inp.bit)) & 0xfffe);
  const dl = t.decodeLen;
  if (bitField < dl[t.quickBits]) {
    const code = bitField >>> (16 - t.quickBits);
    const n = t.quickLen[code] + inp.bit;
    inp.addr = a + (n >>> 3);
    inp.bit = n & 7;
    return t.quickNum[code];
  }
  let bits = 15;
  for (let i = t.quickBits + 1; i < 15; i++) {
    if (bitField < dl[i]) { bits = i; break; }
  }
  const n = bits + inp.bit;
  inp.addr = a + (n >>> 3);
  inp.bit = n & 7;
  const dist = bitField - dl[bits - 1];
  let pos = t.decodePos[bits] + (dist >>> (16 - bits));
  if (pos >= t.maxNum) pos = 0;
  return t.decodeNum[pos];
}

/** Lecture des 20 longueurs de la table « BD » (commune RAR3/RAR5). */
function readBitLengths(inp, count) {
  const bitLength = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const length = getbits(inp) >>> 12;
    addbits(inp, 4);
    if (length === 15) {
      let zeroCount = getbits(inp) >>> 12;
      addbits(inp, 4);
      if (zeroCount === 0) bitLength[i] = 15;
      else {
        zeroCount += 2;
        while (zeroCount-- > 0 && i < count) bitLength[i++] = 0;
        i--;
      }
    } else bitLength[i] = length;
  }
  return bitLength;
}

// ------------------------------------------------------- filtres x86 / ARM
function e8Filter(d, size, fileOffset, e9, rar5) {
  const FILE_SIZE = 0x1000000;
  for (let curPos = 0; curPos + 4 < size;) {
    const b = d[curPos++];
    if (b === 0xe8 || (e9 && b === 0xe9)) {
      const offset = rar5 ? (curPos + fileOffset) % FILE_SIZE : ((curPos + fileOffset) >>> 0);
      const addr = u32le(d, curPos);
      let w = -1;
      if (addr & 0x80000000) {
        if (((addr + offset) & 0x80000000) === 0) w = (addr + FILE_SIZE) >>> 0;
      } else if (((addr - FILE_SIZE) & 0x80000000) !== 0) {
        w = (addr - offset) >>> 0;
      }
      if (w >= 0) {
        d[curPos] = w & 0xff; d[curPos + 1] = (w >>> 8) & 0xff;
        d[curPos + 2] = (w >>> 16) & 0xff; d[curPos + 3] = w >>> 24;
      }
      curPos += 4;
    }
  }
}

function armFilter(d, size, fileOffset) {
  for (let curPos = 0; curPos + 3 < size; curPos += 4) {
    if (d[curPos + 3] === 0xeb) {
      let offset = d[curPos] | (d[curPos + 1] << 8) | (d[curPos + 2] << 16);
      offset = (offset - Math.floor(((fileOffset + curPos) >>> 0) / 4)) >>> 0;
      d[curPos] = offset & 0xff; d[curPos + 1] = (offset >>> 8) & 0xff; d[curPos + 2] = (offset >>> 16) & 0xff;
    }
  }
}

function deltaFilter(src, len, channels, dst) {
  let srcPos = 0;
  for (let c = 0; c < channels; c++) {
    let prev = 0;
    for (let dp = c; dp < len; dp += channels) {
      prev = (prev - src[srcPos++]) & 0xff;
      dst[dp] = prev;
    }
  }
}

// ======================================================================
//  RAR 5 / RAR 7
// ======================================================================
const NC = 306, DCB = 64, DCX = 80, LDC = 16, RC = 44, BC = 20;

function readBlockHeader5(inp) {
  if (inp.bit) { inp.addr++; inp.bit = 0; }
  const b = inp.buf, a = inp.addr;
  if (a + 3 > inp.len) return null;
  const flags = b[a];
  const byteCount = ((flags >>> 3) & 3) + 1;
  if (byteCount === 4) return null;
  const saved = b[a + 1];
  let blockSize = 0;
  for (let i = 0; i < byteCount; i++) blockSize += b[a + 2 + i] << (i * 8);
  const check = (0x5a ^ flags ^ blockSize ^ (blockSize >>> 8) ^ (blockSize >>> 16)) & 0xff;
  if (check !== saved) return null;
  inp.addr = a + 2 + byteCount;
  return {
    start: inp.addr, size: blockSize, end: inp.addr + blockSize - 1,
    bitSize: (flags & 7) + 1, last: (flags & 0x40) !== 0, tablePresent: (flags & 0x80) !== 0,
  };
}

function readFilterData5(inp) {
  const byteCount = (getbits(inp) >>> 14) + 1;
  addbits(inp, 2);
  let data = 0;
  for (let i = 0; i < byteCount; i++) {
    data += (getbits(inp) >>> 8) * Math.pow(2, i * 8);
    addbits(inp, 8);
  }
  return data;
}

function slotToLength5(inp, slot) {
  let lbits, length = 2;
  if (slot < 8) { lbits = 0; length += slot; }
  else { lbits = (slot >>> 2) - 1; length += (4 | (slot & 3)) << lbits; }
  if (lbits > 0) {
    length += getbits(inp) >>> (16 - lbits);
    addbits(inp, lbits);
  }
  return length;
}

class Rar5Decoder {
  constructor(winSize) {
    this.win = new Uint8Array(winSize);
    this.mask = winSize - 1;
    this.reset();
  }
  reset() {
    this.unpPtr = 0;
    this.oldDist = [0, 0, 0, 0];
    this.lastLength = 0;
    this.tablesRead = false;
    this.tables = null;
  }
  readTables(inp, extraDist) {
    const BD = makeDecodeTable(readBitLengths(inp, BC), 0, BC, 7);
    const dc = extraDist ? DCX : DCB;
    const tableSize = NC + dc + LDC + RC;
    const table = new Uint8Array(tableSize);
    for (let i = 0; i < tableSize;) {
      if (inp.addr > inp.len + 4) return false;
      const number = decodeNumber(inp, BD);
      if (number < 16) { table[i++] = number; }
      else if (number < 18) {
        let n;
        if (number === 16) { n = (getbits(inp) >>> 13) + 3; addbits(inp, 3); }
        else { n = (getbits(inp) >>> 9) + 11; addbits(inp, 7); }
        if (i === 0) return false;
        while (n-- > 0 && i < tableSize) { table[i] = table[i - 1]; i++; }
      } else {
        let n;
        if (number === 18) { n = (getbits(inp) >>> 13) + 3; addbits(inp, 3); }
        else { n = (getbits(inp) >>> 9) + 11; addbits(inp, 7); }
        while (n-- > 0 && i < tableSize) table[i++] = 0;
      }
    }
    if (inp.addr > inp.len) return false;
    this.tablesRead = true;
    this.tables = {
      LD: makeDecodeTable(table, 0, NC, 10),
      DD: makeDecodeTable(table, NC, dc, 7),
      LDD: makeDecodeTable(table, NC + dc, LDC, 7),
      RD: makeDecodeTable(table, NC + dc + LDC, RC, 7),
    };
    return true;
  }
  /** Décompresse un fichier ; renvoie { data, produced }. */
  decodeFile(packed, unpSize, solid, extraDist) {
    if (!solid) this.reset();
    const inp = makeInput(packed);
    const dataLen = packed.length;
    const out = new Uint8Array(unpSize);
    const win = this.win, mask = this.mask;
    const oldDist = this.oldDist;
    let unpPtr = this.unpPtr, outPos = 0, lastLength = this.lastLength;
    const filters = [];

    let bh = readBlockHeader5(inp);
    if (!bh) throw new RarError('Données RAR5 invalides (en-tête de bloc).', 'corrupt');
    if (bh.tablePresent && !this.readTables(inp, extraDist)) throw new RarError('Données RAR5 invalides (tables).', 'corrupt');
    if (!this.tablesRead) throw new RarError('Données RAR5 invalides (tables absentes).', 'corrupt');
    let { LD, DD, LDD, RD } = this.tables;

    const copy = (length, distance) => {
      let src = (unpPtr - distance) & mask;
      if (length > 16 && src + length <= mask && unpPtr + length <= mask && (distance >= length)) {
        win.copyWithin(unpPtr, src, src + length);
        const room = unpSize - outPos;
        if (room > 0) out.set(win.subarray(unpPtr, unpPtr + (length < room ? length : room)), outPos);
        unpPtr += length; outPos += length;
        return;
      }
      for (let i = 0; i < length; i++) {
        const v = win[src];
        win[unpPtr] = v;
        src = (src + 1) & mask;
        unpPtr = (unpPtr + 1) & mask;
        if (outPos < unpSize) out[outPos] = v;
        outPos++;
      }
    };

    let failed = false;
    main: for (;;) {
      while (inp.addr > bh.end || (inp.addr === bh.end && inp.bit >= bh.bitSize)) {
        if (bh.last) break main;
        bh = readBlockHeader5(inp);
        if (!bh) { failed = true; break main; }
        if (bh.tablePresent) {
          if (!this.readTables(inp, extraDist)) { failed = true; break main; }
          ({ LD, DD, LDD, RD } = this.tables);
        }
      }
      if (inp.addr > dataLen) { failed = true; break; }

      const mainSlot = decodeNumber(inp, LD);
      if (mainSlot < 256) {
        win[unpPtr] = mainSlot;
        unpPtr = (unpPtr + 1) & mask;
        if (outPos < unpSize) out[outPos] = mainSlot;
        outPos++;
        continue;
      }
      if (mainSlot >= 262) {
        let length = slotToLength5(inp, mainSlot - 262);
        let distance = 1, dbits;
        const distSlot = decodeNumber(inp, DD);
        if (distSlot < 4) { dbits = 0; distance += distSlot; }
        else { dbits = (distSlot >>> 1) - 1; distance += (2 | (distSlot & 1)) * Math.pow(2, dbits); }
        if (dbits > 0) {
          if (dbits >= 4) {
            if (dbits > 4) {
              const n = dbits - 4;
              if (n <= 16) { distance += (getbits(inp) >>> (16 - n)) * 16; addbits(inp, n); }
              else distance += readBitsLong(inp, n) * 16;
            }
            distance += decodeNumber(inp, LDD);
          } else {
            distance += getbits(inp) >>> (16 - dbits);
            addbits(inp, dbits);
          }
        }
        if (distance > 0x100) {
          length++;
          if (distance > 0x2000) {
            length++;
            if (distance > 0x40000) length++;
          }
        }
        oldDist[3] = oldDist[2]; oldDist[2] = oldDist[1]; oldDist[1] = oldDist[0]; oldDist[0] = distance;
        lastLength = length;
        copy(length, distance);
        continue;
      }
      if (mainSlot === 256) {
        const blockStart = readFilterData5(inp);
        let blockLength = readFilterData5(inp);
        if (blockLength > 0x400000) blockLength = 0;
        const type = getbits(inp) >>> 13;
        addbits(inp, 3);
        let channels = 0;
        if (type === 0) { channels = (getbits(inp) >>> 11) + 1; addbits(inp, 5); }
        filters.push({ start: outPos + blockStart, length: blockLength, type, channels });
        continue;
      }
      if (mainSlot === 257) {
        if (lastLength !== 0) copy(lastLength, oldDist[0]);
        continue;
      }
      // 258..261 : distances récentes
      const distNum = mainSlot - 258;
      const distance = oldDist[distNum];
      for (let i = distNum; i > 0; i--) oldDist[i] = oldDist[i - 1];
      oldDist[0] = distance;
      const length = slotToLength5(inp, decodeNumber(inp, RD));
      lastLength = length;
      copy(length, distance);
    }

    this.unpPtr = unpPtr;
    this.lastLength = lastLength;

    for (const f of filters) {
      const start = f.start;
      let len = f.length;
      if (len === 0 || start >= unpSize) continue;
      if (start + len > unpSize) len = unpSize - start;
      const d = out.subarray(start, start + len);
      if (f.type === 0) {
        const tmp = new Uint8Array(len);
        deltaFilter(d, len, f.channels, tmp);
        d.set(tmp);
      } else if (f.type === 1 || f.type === 2) {
        e8Filter(d, len, start, f.type === 2, true);
      } else if (f.type === 3) {
        armFilter(d, len, start);
      }
    }
    return { data: out, produced: outPos, failed };
  }
}

// ======================================================================
//  PPMd var.H (modèle utilisé par RAR 3.x / 4.x)
// ======================================================================
const PPM_MAX_O = 64, INT_BITS = 7, PERIOD_BITS = 7, TOT_BITS = INT_BITS + PERIOD_BITS;
const INTERVAL = 1 << INT_BITS, BIN_SCALE = 1 << TOT_BITS, MAX_FREQ = 124;
const N_INDEXES = 38, UNIT_SIZE = 12;
const kExpEscape = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2];
const kInitBinEsc = [0x3CDD, 0x1F3F, 0x59BF, 0x48F3, 0x64A1, 0x5ABC, 0x6632, 0x6051];
const RC_TOP = 1 << 24, RC_BOT = 1 << 15;
const DUMMY_SEE = 25 * 16;

const Indx2Units = new Uint8Array(N_INDEXES), Units2Indx = new Uint8Array(128);
{
  let k = 0;
  for (let i = 0; i < N_INDEXES; i++) {
    let step = i >= 12 ? 4 : (i >> 2) + 1;
    do { Units2Indx[k++] = i; } while (--step);
    Indx2Units[i] = k;
  }
}
const NS2BSIndx = new Uint8Array(256);
NS2BSIndx[0] = 0; NS2BSIndx[1] = 2; NS2BSIndx.fill(4, 2, 11); NS2BSIndx.fill(6, 11, 256);
const NS2Indx = new Uint8Array(256);
{
  let i;
  for (i = 0; i < 3; i++) NS2Indx[i] = i;
  for (let m = i, k = 1; i < 256; i++) {
    NS2Indx[i] = m;
    if (--k === 0) k = (++m) - 2;
  }
}
const HB2Flag = new Uint8Array(256);
HB2Flag.fill(8, 0x40);

class PPMModel {
  constructor() {
    this.size = 0;
    this.u8 = null;
    this.freeList = new Uint32Array(N_INDEXES);
    this.binSumm = new Uint16Array(128 * 64);
    this.seeSumm = new Uint16Array(25 * 16 + 1);
    this.seeShift = new Uint8Array(25 * 16 + 1);
    this.seeCount = new Uint8Array(25 * 16 + 1);
    this.charMask = new Uint8Array(256);
    this.ps = new Int32Array(256);
    this.ps2 = new Int32Array(PPM_MAX_O + 1);
    this.minContext = 0; this.maxContext = 0; this.foundState = 0;
    this.escCount = 0; this.numMasked = 0;
    this.lowCount = 0; this.highCount = 0; this.scale = 0;
    this.low = 0; this.code = 0; this.range = 0;
    this.initEsc = 0; this.hiBitsFlag = 0;
    this.inp = null;
    this.writeByte = null; // pour l'encodeur de test
  }
  get allocated() { return this.size !== 0; }

  alloc(size) {
    if (this.size === size && this.u8) return;
    this.alignOffset = 4 - (size & 3);
    const total = (this.alignOffset + size + UNIT_SIZE * 2 + 3) & ~3;
    const buf = new ArrayBuffer(total);
    this.u8 = new Uint8Array(buf);
    this.u16 = new Uint16Array(buf);
    this.u32 = new Uint32Array(buf);
    this.size = size;
  }
  free() { this.size = 0; this.u8 = this.u16 = this.u32 = null; this.minContext = 0; }

  // ---- accès aux structures (offsets dans le tas)
  numStats(c) { return this.u16[c >> 1]; }
  setNumStats(c, v) { this.u16[c >> 1] = v; }
  summFreq(c) { return this.u16[(c + 2) >> 1]; }
  setSummFreq(c, v) { this.u16[(c + 2) >> 1] = v; }
  stats(c) { return this.u32[(c + 4) >> 2]; }
  setStats(c, v) { this.u32[(c + 4) >> 2] = v; }
  suffix(c) { return this.u32[(c + 8) >> 2]; }
  setSuffix(c, v) { this.u32[(c + 8) >> 2] = v; }
  successor(s) { return (this.u16[(s + 2) >> 1] | (this.u16[(s + 4) >> 1] << 16)) >>> 0; }
  setSuccessor(s, v) { this.u16[(s + 2) >> 1] = v & 0xffff; this.u16[(s + 4) >> 1] = v >>> 16; }
  copyState(d, s) {
    const u = this.u16;
    u[d >> 1] = u[s >> 1]; u[(d + 2) >> 1] = u[(s + 2) >> 1]; u[(d + 4) >> 1] = u[(s + 4) >> 1];
  }
  swapStates(a, b) {
    const u = this.u16;
    for (let k = 0; k < 6; k += 2) { const t = u[(a + k) >> 1]; u[(a + k) >> 1] = u[(b + k) >> 1]; u[(b + k) >> 1] = t; }
  }

  // ---- sous-allocateur
  insertNode(node, indx) { this.u32[node >> 2] = this.freeList[indx]; this.freeList[indx] = node; }
  removeNode(indx) { const node = this.freeList[indx]; this.freeList[indx] = this.u32[node >> 2]; return node; }
  splitBlock(ptr, oldIndx, newIndx) {
    const nu = Indx2Units[oldIndx] - Indx2Units[newIndx];
    ptr += Indx2Units[newIndx] * UNIT_SIZE;
    let i = Units2Indx[nu - 1];
    if (Indx2Units[i] !== nu) {
      const k = Indx2Units[--i];
      this.insertNode(ptr + k * UNIT_SIZE, nu - k - 1);
    }
    this.insertNode(ptr, i);
  }
  glueFreeBlocks() {
    const u16 = this.u16, u32 = this.u32;
    const head = this.alignOffset + this.size;
    let n = head;
    this.glueCount = 255;
    for (let i = 0; i < N_INDEXES; i++) {
      const nu = Indx2Units[i];
      let next = this.freeList[i];
      this.freeList[i] = 0;
      while (next !== 0) {
        const node = next;
        u32[(node + 4) >> 2] = n;
        u32[(n + 8) >> 2] = next;
        n = next;
        next = u32[node >> 2];
        u16[node >> 1] = 0;
        u16[(node + 2) >> 1] = nu;
      }
    }
    u16[head >> 1] = 1;
    u32[(head + 4) >> 2] = n;
    u32[(n + 8) >> 2] = head;
    if (this.loUnit !== this.hiUnit) u16[this.loUnit >> 1] = 1;

    while (n !== head) {
      const node = n;
      let nu = u16[(node + 2) >> 1];
      for (;;) {
        const node2 = node + nu * UNIT_SIZE;
        nu += u16[(node2 + 2) >> 1];
        if (u16[node2 >> 1] !== 0 || nu >= 0x10000) break;
        const prev2 = u32[(node2 + 8) >> 2], next2 = u32[(node2 + 4) >> 2];
        u32[(prev2 + 4) >> 2] = next2;
        u32[(next2 + 8) >> 2] = prev2;
        u16[(node + 2) >> 1] = nu;
      }
      n = u32[(node + 4) >> 2];
    }

    for (n = u32[(head + 4) >> 2]; n !== head;) {
      let node = n;
      const next = u32[(node + 4) >> 2];
      let nu = u16[(node + 2) >> 1];
      for (; nu > 128; nu -= 128, node += 128 * UNIT_SIZE) this.insertNode(node, N_INDEXES - 1);
      let i = Units2Indx[nu - 1];
      if (Indx2Units[i] !== nu) {
        const k = Indx2Units[--i];
        this.insertNode(node + k * UNIT_SIZE, nu - k - 1);
      }
      this.insertNode(node, i);
      n = next;
    }
  }
  allocUnitsRare(indx) {
    if (this.glueCount === 0) {
      this.glueFreeBlocks();
      if (this.freeList[indx] !== 0) return this.removeNode(indx);
    }
    let i = indx;
    do {
      if (++i === N_INDEXES) {
        const numBytes = Indx2Units[indx] * UNIT_SIZE;
        this.glueCount--;
        if (this.unitsStart - this.text > numBytes) { this.unitsStart -= numBytes; return this.unitsStart; }
        return 0;
      }
    } while (this.freeList[i] === 0);
    const retVal = this.removeNode(i);
    this.splitBlock(retVal, i, indx);
    return retVal;
  }
  allocUnits(indx) {
    if (this.freeList[indx] !== 0) return this.removeNode(indx);
    const numBytes = Indx2Units[indx] * UNIT_SIZE;
    if (numBytes <= this.hiUnit - this.loUnit) {
      const r = this.loUnit;
      this.loUnit += numBytes;
      return r;
    }
    return this.allocUnitsRare(indx);
  }
  shrinkUnits(oldPtr, oldNU, newNU) {
    const i0 = Units2Indx[oldNU - 1], i1 = Units2Indx[newNU - 1];
    if (i0 === i1) return oldPtr;
    if (this.freeList[i1] !== 0) {
      const ptr = this.removeNode(i1);
      this.u8.copyWithin(ptr, oldPtr, oldPtr + newNU * UNIT_SIZE);
      this.insertNode(oldPtr, i0);
      return ptr;
    }
    this.splitBlock(oldPtr, i0, i1);
    return oldPtr;
  }

  // ---- modèle
  restartModel() {
    const u8 = this.u8;
    this.charMask.fill(0);
    this.freeList.fill(0);
    this.text = this.alignOffset;
    this.hiUnit = this.text + this.size;
    this.loUnit = this.unitsStart = this.hiUnit - Math.floor(this.size / 8 / UNIT_SIZE) * 7 * UNIT_SIZE;
    this.glueCount = 0;
    this.orderFall = this.maxOrder;
    this.runLength = this.initRL = -(this.maxOrder < 12 ? this.maxOrder : 12) - 1;
    this.prevSuccess = 0;
    this.hiUnit -= UNIT_SIZE;
    const mc = this.minContext = this.maxContext = this.hiUnit;
    this.setSuffix(mc, 0);
    this.setNumStats(mc, 256);
    this.setSummFreq(mc, 257);
    const fs = this.foundState = this.loUnit;
    this.loUnit += (256 / 2) * UNIT_SIZE;
    this.setStats(mc, fs);
    for (let i = 0; i < 256; i++) {
      const s = fs + i * 6;
      u8[s] = i; u8[s + 1] = 1;
      this.setSuccessor(s, 0);
    }
    for (let i = 0; i < 128; i++) {
      for (let k = 0; k < 8; k++) {
        const val = BIN_SCALE - Math.floor(kInitBinEsc[k] / (i + 2));
        for (let m = 0; m < 64; m += 8) this.binSumm[i * 64 + k + m] = val;
      }
    }
    for (let i = 0; i < 25; i++) {
      for (let k = 0; k < 16; k++) {
        const s = i * 16 + k;
        this.seeShift[s] = PERIOD_BITS - 4;
        this.seeSumm[s] = (5 * i + 10) << (PERIOD_BITS - 4);
        this.seeCount[s] = 4;
      }
    }
  }
  startModel(maxOrder) {
    this.escCount = 1;
    this.maxOrder = maxOrder;
    this.restartModel();
    this.seeShift[DUMMY_SEE] = PERIOD_BITS;
    this.seeSumm[DUMMY_SEE] = 0;
    this.seeCount[DUMMY_SEE] = 64;
  }
  clearMask() { this.escCount = 1; this.charMask.fill(0); }

  createSuccessors(skip) {
    const u8 = this.u8, ps = this.ps2;
    let c = this.minContext;
    const fs = this.foundState;
    const upBranch = this.successor(fs);
    const fsSymbol = u8[fs];
    let numPs = 0;
    if (!skip) ps[numPs++] = fs;
    while (this.suffix(c)) {
      c = this.suffix(c);
      let s;
      if (this.numStats(c) !== 1) {
        s = this.stats(c);
        while (u8[s] !== fsSymbol) s += 6;
      } else s = c + 2;
      const succ = this.successor(s);
      if (succ !== upBranch) {
        c = succ;
        if (numPs === 0) return c;
        break;
      }
      if (numPs >= ps.length) return 0;
      ps[numPs++] = s;
    }
    const upSymbol = u8[upBranch];
    const upSucc = upBranch + 1;
    let upFreq;
    if (this.numStats(c) === 1) upFreq = u8[c + 3];
    else {
      let s = this.stats(c);
      while (u8[s] !== upSymbol) s += 6;
      const cf = u8[s + 1] - 1;
      const s0 = this.summFreq(c) - this.numStats(c) - cf;
      upFreq = 1 + ((2 * cf <= s0) ? (5 * cf > s0 ? 1 : 0) : Math.floor((2 * cf + 3 * s0 - 1) / (2 * s0)));
    }
    do {
      let c1;
      if (this.hiUnit !== this.loUnit) c1 = (this.hiUnit -= UNIT_SIZE);
      else if (this.freeList[0] !== 0) c1 = this.removeNode(0);
      else {
        c1 = this.allocUnitsRare(0);
        if (!c1) return 0;
      }
      this.setNumStats(c1, 1);
      u8[c1 + 2] = upSymbol; u8[c1 + 3] = upFreq;
      this.setSuccessor(c1 + 2, upSucc);
      this.setSuffix(c1, c);
      this.setSuccessor(ps[--numPs], c1);
      c = c1;
    } while (numPs !== 0);
    return c;
  }

  /** Mise à jour du modèle ; renvoie false si le modèle a été réinitialisé. */
  updateModel() {
    const u8 = this.u8;
    const fs = this.foundState;
    const fsSymbol = u8[fs], fsFreq = u8[fs + 1];
    let fSuccessor = this.successor(fs);
    let c;
    if (fsFreq < (MAX_FREQ >> 2) && this.suffix(this.minContext) !== 0) {
      c = this.suffix(this.minContext);
      if (this.numStats(c) === 1) {
        const s = c + 2;
        if (u8[s + 1] < 32) u8[s + 1]++;
      } else {
        let s = this.stats(c);
        if (u8[s] !== fsSymbol) {
          do { s += 6; } while (u8[s] !== fsSymbol);
          if (u8[s + 1] >= u8[s - 5]) { this.swapStates(s, s - 6); s -= 6; }
        }
        if (u8[s + 1] < MAX_FREQ - 9) { u8[s + 1] += 2; this.setSummFreq(c, this.summFreq(c) + 2); }
      }
    }
    if (this.orderFall === 0) {
      this.minContext = this.maxContext = this.createSuccessors(true);
      if (this.minContext === 0) return this.restartFromUpdate();
      this.setSuccessor(this.foundState, this.minContext);
      return true;
    }
    u8[this.text++] = fsSymbol;
    let successorV = this.text;
    if (this.text >= this.unitsStart) return this.restartFromUpdate();
    if (fSuccessor) {
      if (fSuccessor <= successorV) {
        const cs = this.createSuccessors(false);
        if (cs === 0) return this.restartFromUpdate();
        fSuccessor = cs;
      }
      if (--this.orderFall === 0) {
        successorV = fSuccessor;
        if (this.maxContext !== this.minContext) this.text--;
      }
    } else {
      this.setSuccessor(this.foundState, successorV);
      fSuccessor = this.minContext;
    }
    const ns = this.numStats(this.minContext);
    const s0 = this.summFreq(this.minContext) - ns - (fsFreq - 1);
    for (c = this.maxContext; c !== this.minContext; c = this.suffix(c)) {
      const ns1 = this.numStats(c);
      if (ns1 !== 1) {
        if ((ns1 & 1) === 0) {
          const oldNU = ns1 >>> 1;
          const i = Units2Indx[oldNU - 1];
          if (i !== Units2Indx[oldNU]) {
            const ptr = this.allocUnits(i + 1);
            if (!ptr) return this.restartFromUpdate();
            const oldPtr = this.stats(c);
            u8.copyWithin(ptr, oldPtr, oldPtr + oldNU * UNIT_SIZE);
            this.insertNode(oldPtr, i);
            this.setStats(c, ptr);
          }
        }
        const sf = this.summFreq(c);
        this.setSummFreq(c, sf + (2 * ns1 < ns ? 1 : 0) + 2 * ((4 * ns1 <= ns ? 1 : 0) & (sf <= 8 * ns1 ? 1 : 0)));
      } else {
        const s = this.allocUnits(0);
        if (!s) return this.restartFromUpdate();
        this.copyState(s, c + 2);
        this.setStats(c, s);
        let f = u8[s + 1];
        if (f < (MAX_FREQ >> 2) - 1) f <<= 1; else f = MAX_FREQ - 4;
        u8[s + 1] = f;
        this.setSummFreq(c, f + this.initEsc + (ns > 3 ? 1 : 0));
      }
      let cf = 2 * fsFreq * (this.summFreq(c) + 6);
      const sf = s0 + this.summFreq(c);
      if (cf < 6 * sf) {
        cf = 1 + (cf > sf ? 1 : 0) + (cf >= 4 * sf ? 1 : 0);
        this.setSummFreq(c, this.summFreq(c) + 3);
      } else {
        cf = 4 + (cf >= 9 * sf ? 1 : 0) + (cf >= 12 * sf ? 1 : 0) + (cf >= 15 * sf ? 1 : 0);
        this.setSummFreq(c, this.summFreq(c) + cf);
      }
      const s = this.stats(c) + ns1 * 6;
      this.setSuccessor(s, successorV);
      u8[s] = fsSymbol; u8[s + 1] = cf;
      this.setNumStats(c, ns1 + 1);
    }
    this.maxContext = this.minContext = fSuccessor;
    return true;
  }
  restartFromUpdate() { this.restartModel(); this.escCount = 0; return false; }

  rescale() {
    const u8 = this.u8, mc = this.minContext;
    const stats = this.stats(mc);
    let s = this.foundState;
    {
      const t0 = this.u16[s >> 1], t1 = this.u16[(s + 2) >> 1], t2 = this.u16[(s + 4) >> 1];
      for (; s !== stats; s -= 6) this.copyState(s, s - 6);
      this.u16[s >> 1] = t0; this.u16[(s + 2) >> 1] = t1; this.u16[(s + 4) >> 1] = t2;
    }
    let escFreq = this.summFreq(mc) - u8[s + 1];
    u8[s + 1] += 4;
    const adder = this.orderFall !== 0 ? 1 : 0;
    u8[s + 1] = (u8[s + 1] + adder) >> 1;
    let sumFreq = u8[s + 1];
    let i = this.numStats(mc) - 1;
    do {
      s += 6;
      escFreq -= u8[s + 1];
      u8[s + 1] = (u8[s + 1] + adder) >> 1;
      sumFreq += u8[s + 1];
      if (u8[s + 1] > u8[s - 5]) {
        let s1 = s;
        const t0 = this.u16[s1 >> 1], t1 = this.u16[(s1 + 2) >> 1], t2 = this.u16[(s1 + 4) >> 1];
        const tf = u8[s1 + 1];
        do { this.copyState(s1, s1 - 6); s1 -= 6; } while (s1 !== stats && tf > u8[s1 - 5]);
        this.u16[s1 >> 1] = t0; this.u16[(s1 + 2) >> 1] = t1; this.u16[(s1 + 4) >> 1] = t2;
      }
    } while (--i);
    if (u8[s + 1] === 0) {
      const numStats0 = this.numStats(mc);
      i = 0;
      do { i++; s -= 6; } while (u8[s + 1] === 0);
      escFreq += i;
      this.setNumStats(mc, numStats0 - i);
      if (this.numStats(mc) === 1) {
        const sym = u8[stats], s1 = this.u16[(stats + 2) >> 1], s2 = this.u16[(stats + 4) >> 1];
        let freq = u8[stats + 1];
        do { freq -= freq >> 1; escFreq >>= 1; } while (escFreq > 1);
        this.insertNode(stats, Units2Indx[((numStats0 + 1) >> 1) - 1]);
        const os = mc + 2;
        u8[os] = sym; u8[os + 1] = freq;
        this.u16[(os + 2) >> 1] = s1; this.u16[(os + 4) >> 1] = s2;
        this.foundState = os;
        return;
      }
      const n0 = (numStats0 + 1) >> 1, n1 = (this.numStats(mc) + 1) >> 1;
      if (n0 !== n1) this.setStats(mc, this.shrinkUnits(stats, n0, n1));
    }
    this.setSummFreq(mc, sumFreq + escFreq - (escFreq >> 1));
    this.foundState = this.stats(mc);
  }

  binSummIndex() {
    const u8 = this.u8, mc = this.minContext, rs = mc + 2;
    this.hiBitsFlag = HB2Flag[u8[this.foundState]];
    return (u8[rs + 1] - 1) * 64 + this.prevSuccess +
      NS2BSIndx[this.numStats(this.suffix(mc)) - 1] +
      this.hiBitsFlag + 2 * HB2Flag[u8[rs]] + ((this.runLength >> 26) & 0x20);
  }
  makeEscFreq2(diff) {
    const mc = this.minContext, ns = this.numStats(mc);
    if (ns !== 256) {
      const see = NS2Indx[diff - 1] * 16 +
        (diff < ((this.numStats(this.suffix(mc)) - ns) >>> 0) ? 1 : 0) +
        2 * (this.summFreq(mc) < 11 * ns ? 1 : 0) +
        4 * (this.numMasked > diff ? 1 : 0) + this.hiBitsFlag;
      const summ = this.seeSumm[see];
      const r = summ >>> this.seeShift[see];
      this.seeSumm[see] = (summ - r) & 0xffff;
      this.scale = r + (r === 0 ? 1 : 0);
      return see;
    }
    this.scale = 1;
    return DUMMY_SEE;
  }
  seeUpdate(see) {
    if (this.seeShift[see] < PERIOD_BITS && --this.seeCount[see] === 0) {
      this.seeSumm[see] = (this.seeSumm[see] * 2) & 0xffff;
      this.seeCount[see] = 3 << this.seeShift[see]++;
    }
  }
  update1(p) {
    const u8 = this.u8, mc = this.minContext;
    this.foundState = p;
    u8[p + 1] += 4;
    this.setSummFreq(mc, this.summFreq(mc) + 4);
    if (u8[p + 1] > u8[p - 5]) {
      this.swapStates(p, p - 6);
      this.foundState = p -= 6;
      if (u8[p + 1] > MAX_FREQ) this.rescale();
    }
  }
  update2(p) {
    const u8 = this.u8, mc = this.minContext;
    this.foundState = p;
    u8[p + 1] += 4;
    this.setSummFreq(mc, this.summFreq(mc) + 4);
    if (u8[p + 1] > MAX_FREQ) this.rescale();
    this.escCount = (this.escCount + 1) & 0xff;
    this.runLength = this.initRL;
  }
  /** Suite commune après décodage/encodage d'un symbole trouvé. */
  afterSymbol() {
    const succ = this.successor(this.foundState);
    if (this.orderFall === 0 && succ > this.text) this.minContext = this.maxContext = succ;
    else {
      this.updateModel();
      if (this.escCount === 0) this.clearMask();
    }
  }

  // ---- décodeur arithmétique (codeur « sans retenue » de RAR)
  initDecoder(inp) {
    this.inp = inp;
    this.low = 0; this.code = 0; this.range = 0xFFFFFFFF;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.getChar()) >>> 0;
  }
  getChar() { const inp = this.inp; return inp.buf[inp.addr++] | 0; }
  rcCount() {
    this.range = Math.floor(this.range / this.scale);
    return Math.floor(((this.code - this.low) >>> 0) / this.range);
  }
  rcShiftCount(shift) {
    this.range = this.range >>> shift;
    return Math.floor(((this.code - this.low) >>> 0) / this.range);
  }
  rcDecode() {
    this.low = (this.low + this.range * this.lowCount) >>> 0;
    this.range = (this.range * (this.highCount - this.lowCount)) >>> 0;
  }
  rcNormalize() {
    for (;;) {
      if (((this.low ^ (this.low + this.range)) >>> 0) >= RC_TOP) {
        if (this.range >= RC_BOT) break;
        this.range = (-this.low) & (RC_BOT - 1);
      }
      this.code = ((this.code << 8) | this.getChar()) >>> 0;
      this.range = (this.range << 8) >>> 0;
      this.low = (this.low << 8) >>> 0;
    }
  }

  decodeSymbol1() {
    const u8 = this.u8, mc = this.minContext;
    this.scale = this.summFreq(mc);
    let p = this.stats(mc);
    const count = this.rcCount();
    if (count >= this.scale) return false;
    let hiCnt = u8[p + 1];
    if (count < hiCnt) {
      this.highCount = hiCnt;
      this.prevSuccess = 2 * hiCnt > this.scale ? 1 : 0;
      this.runLength += this.prevSuccess;
      this.foundState = p;
      hiCnt += 4;
      u8[p + 1] = hiCnt;
      this.setSummFreq(mc, this.summFreq(mc) + 4);
      if (hiCnt > MAX_FREQ) this.rescale();
      this.lowCount = 0;
      return true;
    }
    if (this.foundState === 0) return false;
    this.prevSuccess = 0;
    let i = this.numStats(mc) - 1;
    while ((hiCnt += u8[(p += 6) + 1]) <= count) {
      if (--i === 0) {
        this.hiBitsFlag = HB2Flag[u8[this.foundState]];
        this.lowCount = hiCnt;
        this.charMask[u8[p]] = this.escCount;
        i = (this.numMasked = this.numStats(mc)) - 1;
        this.foundState = 0;
        do { p -= 6; this.charMask[u8[p]] = this.escCount; } while (--i);
        this.highCount = this.scale;
        return true;
      }
    }
    this.lowCount = (this.highCount = hiCnt) - u8[p + 1];
    this.update1(p);
    return true;
  }
  decodeBinSymbol() {
    const u8 = this.u8, rs = this.minContext + 2;
    const idx = this.binSummIndex();
    let bs = this.binSumm[idx];
    if (this.rcShiftCount(TOT_BITS) < bs) {
      this.foundState = rs;
      if (u8[rs + 1] < 128) u8[rs + 1]++;
      this.lowCount = 0;
      this.highCount = bs;
      this.binSumm[idx] = (bs + INTERVAL - ((bs + 32) >> 7)) & 0xffff;
      this.prevSuccess = 1;
      this.runLength++;
    } else {
      this.lowCount = bs;
      bs = (bs - ((bs + 32) >> 7)) & 0xffff;
      this.binSumm[idx] = bs;
      this.highCount = BIN_SCALE;
      this.initEsc = kExpEscape[bs >> 10];
      this.numMasked = 1;
      this.charMask[u8[rs]] = this.escCount;
      this.prevSuccess = 0;
      this.foundState = 0;
    }
  }
  decodeSymbol2() {
    const u8 = this.u8, mc = this.minContext, ps = this.ps;
    let i = this.numStats(mc) - this.numMasked;
    const see = this.makeEscFreq2(i);
    let p = this.stats(mc) - 6, hiCnt = 0, n = 0;
    do {
      do { p += 6; } while (this.charMask[u8[p]] === this.escCount);
      hiCnt += u8[p + 1];
      ps[n++] = p;
    } while (--i);
    this.scale += hiCnt;
    const count = this.rcCount();
    if (count >= this.scale) return false;
    if (count < hiCnt) {
      let k = 0;
      p = ps[0];
      hiCnt = 0;
      while ((hiCnt += u8[p + 1]) <= count) p = ps[++k];
      this.lowCount = (this.highCount = hiCnt) - u8[p + 1];
      this.seeUpdate(see);
      this.update2(p);
    } else {
      this.lowCount = hiCnt;
      this.highCount = this.scale;
      for (let j = 0; j < n; j++) this.charMask[u8[ps[j]]] = this.escCount;
      this.seeSumm[see] = (this.seeSumm[see] + this.scale) & 0xffff;
      this.numMasked = this.numStats(mc);
    }
    return true;
  }
  validContext(c) { return c > this.text && c <= this.alignOffset + this.size - UNIT_SIZE; }
  decodeChar() {
    if (!this.validContext(this.minContext)) return -1;
    if (this.numStats(this.minContext) !== 1) {
      const st = this.stats(this.minContext);
      if (st <= this.text || st > this.alignOffset + this.size) return -1;
      if (!this.decodeSymbol1()) return -1;
    } else this.decodeBinSymbol();
    this.rcDecode();
    while (this.foundState === 0) {
      this.rcNormalize();
      do {
        this.orderFall++;
        this.minContext = this.suffix(this.minContext);
        if (!this.validContext(this.minContext)) return -1;
      } while (this.numStats(this.minContext) === this.numMasked);
      if (!this.decodeSymbol2()) return -1;
      this.rcDecode();
    }
    const symbol = this.u8[this.foundState];
    this.afterSymbol();
    this.rcNormalize();
    return symbol;
  }
  /** Réinitialisation après données corrompues (comme unrar). */
  cleanUp() { this.alloc(1 << 20); this.startModel(2); }
}

// ======================================================================
//  RAR 2.9 / 3.x / 4.x (« Unpack29 »)
// ======================================================================
const NC30 = 299, DC30 = 60, LDC30 = 17, RC30 = 28, BC30 = 20;
const HUFF_TABLE_SIZE30 = NC30 + DC30 + LDC30 + RC30;
const LDecode = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
const LBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
const DDecode30 = new Uint32Array(DC30), DBits30 = new Uint8Array(DC30);
{
  const counts = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12];
  let dist = 0, slot = 0;
  for (let i = 0; i < counts.length; i++) {
    for (let j = 0; j < counts[i]; j++, slot++, dist += (1 << i)) { DDecode30[slot] = dist; DBits30[slot] = i; }
  }
}
const SDDecode = [0, 4, 8, 16, 32, 64, 128, 192], SDBits = [2, 2, 3, 4, 5, 6, 6, 6];
const BLOCK_LZ = 0, BLOCK_PPM = 1;
const VMSF_NONE = 0, VMSF_E8 = 1, VMSF_E8E9 = 2, VMSF_ITANIUM = 3, VMSF_RGB = 4, VMSF_AUDIO = 5, VMSF_DELTA = 6;
const VM_MEMSIZE = 0x40000;
const STD_FILTERS = [
  [53, 0xad576887, VMSF_E8], [57, 0x3cd7e57e, VMSF_E8E9], [120, 0x3769893f, VMSF_ITANIUM],
  [29, 0x0e06077d, VMSF_DELTA], [149, 0x1c2c5dc8, VMSF_RGB], [216, 0xbc85e701, VMSF_AUDIO],
];

function identifyFilter(code) {
  let x = 0;
  for (let i = 1; i < code.length; i++) x ^= code[i];
  if (x !== code[0]) return VMSF_NONE;
  const crc = crc32(code);
  for (const [len, c, t] of STD_FILTERS) if (len === code.length && c === crc) return t;
  return VMSF_NONE;
}

function readVMData(inp) {
  let data = getbits(inp);
  switch (data & 0xc000) {
    case 0:
      addbits(inp, 6);
      return (data >>> 10) & 0xf;
    case 0x4000:
      if ((data & 0x3c00) === 0) { data = (0xffffff00 | ((data >>> 2) & 0xff)) >>> 0; addbits(inp, 14); }
      else { data = (data >>> 6) & 0xff; addbits(inp, 10); }
      return data;
    case 0x8000:
      addbits(inp, 2);
      data = getbits(inp);
      addbits(inp, 16);
      return data;
    default:
      addbits(inp, 2);
      data = getbits(inp) * 65536;
      addbits(inp, 16);
      data += getbits(inp);
      addbits(inp, 16);
      return data >>> 0;
  }
}

function itaniumGetBits(d, bitPos, bitCount) {
  const a = bitPos >>> 3, s = bitPos & 7;
  const v = (d[a] | (d[a + 1] << 8) | (d[a + 2] << 16) | (d[a + 3] << 24)) >>> s;
  return (v & (0xffffffff >>> (32 - bitCount))) >>> 0;
}
function itaniumSetBits(d, bitField, bitPos, bitCount) {
  const a = bitPos >>> 3, s = bitPos & 7;
  let andMask = (0xffffffff >>> (32 - bitCount)) >>> 0;
  andMask = ~(andMask << s) >>> 0;
  bitField = (bitField << s) >>> 0;
  for (let i = 0; i < 4; i++) {
    d[a + i] &= andMask & 0xff;
    d[a + i] |= bitField & 0xff;
    andMask = ((andMask >>> 8) | 0xff000000) >>> 0;
    bitField >>>= 8;
  }
}

/** Exécute un filtre standard RAR3 ; mem contient les données (et la zone de sortie). */
function runFilter30(type, mem, dataSize, R, fileOffset) {
  switch (type) {
    case VMSF_E8: case VMSF_E8E9:
      if (dataSize > VM_MEMSIZE || dataSize < 4) return null;
      e8Filter(mem, dataSize, fileOffset, type === VMSF_E8E9, false);
      return mem.subarray(0, dataSize);
    case VMSF_ITANIUM: {
      if (dataSize > VM_MEMSIZE || dataSize < 21) return null;
      const masks = [4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];
      let curPos = 0, off = fileOffset >>> 4, base = 0;
      while (curPos < dataSize - 21) {
        const byte = (mem[base] & 0x1f) - 0x10;
        if (byte >= 0) {
          const cmdMask = masks[byte];
          if (cmdMask !== 0) {
            for (let i = 0; i <= 2; i++) {
              if (cmdMask & (1 << i)) {
                const startPos = i * 41 + 5;
                const sub = mem.subarray(base);
                if (itaniumGetBits(sub, startPos + 37, 4) === 5) {
                  const offset = itaniumGetBits(sub, startPos + 13, 20);
                  itaniumSetBits(sub, (offset - off) & 0xfffff, startPos + 13, 20);
                }
              }
            }
          }
        }
        base += 16; curPos += 16; off++;
      }
      return mem.subarray(0, dataSize);
    }
    case VMSF_DELTA: {
      const channels = R[0];
      if (dataSize > VM_MEMSIZE / 2 || channels > 1024 || channels === 0) return null;
      deltaFilter(mem, dataSize, channels, mem.subarray(dataSize, dataSize * 2));
      return mem.subarray(dataSize, dataSize * 2);
    }
    case VMSF_RGB: {
      const width = R[0] - 3, posR = R[1];
      if (dataSize > VM_MEMSIZE / 2 || dataSize < 3 || width > dataSize || posR > 2) return null;
      const dst = dataSize;
      let src = 0;
      for (let ch = 0; ch < 3; ch++) {
        let prev = 0;
        for (let i = ch; i < dataSize; i += 3) {
          let predicted;
          if (i >= width + 3) {
            const upper = mem[dst + i - width], upperLeft = mem[dst + i - width - 3];
            predicted = prev + upper - upperLeft;
            const pa = Math.abs(predicted - prev), pb = Math.abs(predicted - upper), pc = Math.abs(predicted - upperLeft);
            if (pa <= pb && pa <= pc) predicted = prev;
            else if (pb <= pc) predicted = upper;
            else predicted = upperLeft;
          } else predicted = prev;
          prev = (predicted - mem[src++]) & 0xff;
          mem[dst + i] = prev;
        }
      }
      for (let i = posR, border = dataSize - 2; i < border; i += 3) {
        const g = mem[dst + i + 1];
        mem[dst + i] = (mem[dst + i] + g) & 0xff;
        mem[dst + i + 2] = (mem[dst + i + 2] + g) & 0xff;
      }
      return mem.subarray(dataSize, dataSize * 2);
    }
    case VMSF_AUDIO: {
      const channels = R[0];
      if (dataSize > VM_MEMSIZE / 2 || channels > 128 || channels === 0) return null;
      const dst = dataSize;
      let src = 0;
      for (let ch = 0; ch < channels; ch++) {
        let prevByte = 0, prevDelta = 0, d1 = 0, d2 = 0, d3, k1 = 0, k2 = 0, k3 = 0;
        const dif = [0, 0, 0, 0, 0, 0, 0];
        for (let i = ch, byteCount = 0; i < dataSize; i += channels, byteCount++) {
          d3 = d2; d2 = prevDelta - d1; d1 = prevDelta;
          let predicted = ((8 * prevByte + k1 * d1 + k2 * d2 + k3 * d3) >>> 3) & 0xff;
          const curByte = mem[src++];
          predicted = (predicted - curByte) & 0xff;
          mem[dst + i] = predicted;
          prevDelta = ((predicted - prevByte) << 24) >> 24;
          prevByte = predicted;
          const d = ((curByte << 24) >> 24) * 8;
          dif[0] += Math.abs(d); dif[1] += Math.abs(d - d1); dif[2] += Math.abs(d + d1);
          dif[3] += Math.abs(d - d2); dif[4] += Math.abs(d + d2); dif[5] += Math.abs(d - d3); dif[6] += Math.abs(d + d3);
          if ((byteCount & 0x1f) === 0) {
            let minDif = dif[0], numMinDif = 0;
            dif[0] = 0;
            for (let j = 1; j < 7; j++) {
              if (dif[j] < minDif) { minDif = dif[j]; numMinDif = j; }
              dif[j] = 0;
            }
            switch (numMinDif) {
              case 1: if (k1 >= -16) k1--; break;
              case 2: if (k1 < 16) k1++; break;
              case 3: if (k2 >= -16) k2--; break;
              case 4: if (k2 < 16) k2++; break;
              case 5: if (k3 >= -16) k3--; break;
              case 6: if (k3 < 16) k3++; break;
            }
          }
        }
      }
      return mem.subarray(dataSize, dataSize * 2);
    }
  }
  return null;
}

class Rar29Decoder {
  constructor(winSize) {
    this.win = new Uint8Array(winSize);
    this.mask = winSize - 1;
    this.ppm = new PPMModel();
    this.oldTable = new Uint8Array(HUFF_TABLE_SIZE30);
    this.reset();
  }
  reset() {
    this.unpPtr = 0;
    this.oldDist = [0, 0, 0, 0];
    this.lastLength = 0;
    this.tablesRead = false;
    this.oldTable.fill(0);
    this.ppmEscChar = 2;
    this.blockType = BLOCK_LZ;
    this.filters = [];
    this.oldFilterLengths = [];
    this.lastFilter = 0;
    this.prevLowDist = 0;
    this.lowDistRepCount = 0;
  }
  readTables() {
    const inp = this.inp;
    if (inp.bit) { inp.addr++; inp.bit = 0; }
    const bitField = getbits(inp);
    if (bitField & 0x8000) {
      this.blockType = BLOCK_PPM;
      return this.ppmInit();
    }
    this.blockType = BLOCK_LZ;
    this.prevLowDist = 0;
    this.lowDistRepCount = 0;
    if (!(bitField & 0x4000)) this.oldTable.fill(0);
    addbits(inp, 2);
    const BD = makeDecodeTable(readBitLengths(inp, BC30), 0, BC30, 7);
    const table = new Uint8Array(HUFF_TABLE_SIZE30);
    for (let i = 0; i < HUFF_TABLE_SIZE30;) {
      if (inp.addr > inp.len + 4) return false;
      const number = decodeNumber(inp, BD);
      if (number < 16) { table[i] = (number + this.oldTable[i]) & 0xf; i++; }
      else if (number < 18) {
        let n;
        if (number === 16) { n = (getbits(inp) >>> 13) + 3; addbits(inp, 3); }
        else { n = (getbits(inp) >>> 9) + 11; addbits(inp, 7); }
        if (i === 0) return false;
        while (n-- > 0 && i < HUFF_TABLE_SIZE30) { table[i] = table[i - 1]; i++; }
      } else {
        let n;
        if (number === 18) { n = (getbits(inp) >>> 13) + 3; addbits(inp, 3); }
        else { n = (getbits(inp) >>> 9) + 11; addbits(inp, 7); }
        while (n-- > 0 && i < HUFF_TABLE_SIZE30) table[i++] = 0;
      }
    }
    this.tablesRead = true;
    if (inp.addr > inp.len) return false;
    this.LD = makeDecodeTable(table, 0, NC30, 10);
    this.DD = makeDecodeTable(table, NC30, DC30, 7);
    this.LDD = makeDecodeTable(table, NC30 + DC30, LDC30, 7);
    this.RD = makeDecodeTable(table, NC30 + DC30 + LDC30, RC30, 7);
    this.oldTable.set(table);
    return true;
  }
  ppmInit() {
    const inp = this.inp, ppm = this.ppm;
    const getChar = () => inp.buf[inp.addr++] | 0;
    let maxOrder = getChar();
    const reset = (maxOrder & 0x20) !== 0;
    let maxMB = 0;
    if (reset) maxMB = getChar();
    else if (!ppm.allocated) return false;
    if (maxOrder & 0x40) this.ppmEscChar = getChar();
    ppm.initDecoder(inp);
    if (reset) {
      maxOrder = (maxOrder & 0x1f) + 1;
      if (maxOrder > 16) maxOrder = 16 + (maxOrder - 16) * 3;
      if (maxOrder === 1) { ppm.free(); return false; }
      try { ppm.alloc((maxMB + 1) << 20); }
      catch (e) { throw new RarError('Mémoire insuffisante pour décompresser cette archive.', 'memory'); }
      ppm.startModel(maxOrder);
    }
    return ppm.minContext !== 0;
  }
  safePPM() {
    const ch = this.ppm.decodeChar();
    if (ch === -1) { this.ppm.cleanUp(); this.blockType = BLOCK_LZ; }
    return ch;
  }
  readEndOfBlock() {
    const inp = this.inp;
    const bitField = getbits(inp);
    let newTable, newFile = false;
    if (bitField & 0x8000) { newTable = true; addbits(inp, 1); }
    else { newFile = true; newTable = (bitField & 0x4000) !== 0; addbits(inp, 2); }
    this.tablesRead = !newTable;
    if (newFile) return false;
    return this.readTables();
  }
  readVMCode(outPos) {
    const inp = this.inp;
    const firstByte = getbits(inp) >>> 8;
    addbits(inp, 8);
    let length = (firstByte & 7) + 1;
    if (length === 7) { length = (getbits(inp) >>> 8) + 7; addbits(inp, 8); }
    else if (length === 8) { length = getbits(inp); addbits(inp, 16); }
    if (length === 0) return false;
    const code = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      if (inp.addr > inp.len) return false;
      code[i] = getbits(inp) >>> 8;
      addbits(inp, 8);
    }
    return this.addVMCode(firstByte, code, outPos);
  }
  readVMCodePPM(outPos) {
    const firstByte = this.safePPM();
    if (firstByte === -1) return false;
    let length = (firstByte & 7) + 1;
    if (length === 7) {
      const b1 = this.safePPM();
      if (b1 === -1) return false;
      length = b1 + 7;
    } else if (length === 8) {
      const b1 = this.safePPM();
      if (b1 === -1) return false;
      const b2 = this.safePPM();
      if (b2 === -1) return false;
      length = b1 * 256 + b2;
    }
    if (length === 0) return false;
    const code = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const ch = this.safePPM();
      if (ch === -1) return false;
      code[i] = ch;
    }
    return this.addVMCode(firstByte, code, outPos);
  }
  addVMCode(firstByte, code, outPos) {
    const vin = makeInput(code);
    let filtPos;
    if (firstByte & 0x80) {
      filtPos = readVMData(vin);
      if (filtPos === 0) { this.filters = []; this.oldFilterLengths = []; this.lastFilter = 0; }
      else filtPos--;
    } else filtPos = this.lastFilter;
    if (filtPos > this.filters.length || filtPos > this.oldFilterLengths.length) return false;
    this.lastFilter = filtPos;
    const newFilter = filtPos === this.filters.length;
    let filter;
    if (newFilter) {
      if (filtPos > 8192) return false;
      filter = { type: VMSF_NONE };
      this.filters.push(filter);
      this.oldFilterLengths.push(0);
    } else filter = this.filters[filtPos];
    if (this.prgStack.length > 100000) return false;
    const sf = { start: 0, length: 0, initR: new Uint32Array(7), type: VMSF_NONE };
    this.prgStack.push(sf);
    let blockStart = readVMData(vin);
    if (firstByte & 0x40) blockStart += 258;
    sf.start = outPos + blockStart;
    if (firstByte & 0x20) {
      sf.length = readVMData(vin);
      this.oldFilterLengths[filtPos] = sf.length;
    } else sf.length = filtPos < this.oldFilterLengths.length ? this.oldFilterLengths[filtPos] : 0;
    sf.initR[4] = sf.length;
    if (firstByte & 0x10) {
      const initMask = getbits(vin) >>> 9;
      addbits(vin, 7);
      for (let i = 0; i < 7; i++) if (initMask & (1 << i)) sf.initR[i] = readVMData(vin);
    }
    if (newFilter) {
      const vmCodeSize = readVMData(vin);
      if (vmCodeSize >= 0x10000 || vmCodeSize === 0 || vin.addr + vmCodeSize > code.length) return false;
      const vmCode = new Uint8Array(vmCodeSize);
      for (let i = 0; i < vmCodeSize; i++) { vmCode[i] = getbits(vin) >>> 8; addbits(vin, 8); }
      filter.type = identifyFilter(vmCode);
    }
    sf.type = filter.type;
    return true;
  }
  applyFilters(out) {
    let mem = null;
    for (const f of this.prgStack) {
      const start = f.start, len = f.length;
      if (f.type === VMSF_NONE || len === 0 || start >= out.length || len > VM_MEMSIZE) continue;
      const avail = Math.min(len, out.length - start);
      if (!mem) mem = new Uint8Array(VM_MEMSIZE + 8);
      mem.fill(0, 0, Math.min(VM_MEMSIZE, len * 2));
      mem.set(out.subarray(start, start + avail));
      const res = runFilter30(f.type, mem, len, f.initR, start);
      if (res) out.set(res.subarray(0, avail), start);
    }
  }
  decodeFile(packed, unpSize, solid) {
    if (!solid) this.reset();
    this.prgStack = [];
    const inp = this.inp = makeInput(packed);
    const dataLen = packed.length;
    const out = new Uint8Array(unpSize);
    const win = this.win, mask = this.mask, oldDist = this.oldDist;
    let unpPtr = this.unpPtr, outPos = 0, lastLength = this.lastLength;

    const copy = (length, distance) => {
      let src = (unpPtr - distance) & mask;
      if (length > 16 && src + length <= mask && unpPtr + length <= mask && distance >= length) {
        win.copyWithin(unpPtr, src, src + length);
        const room = unpSize - outPos;
        if (room > 0) out.set(win.subarray(unpPtr, unpPtr + (length < room ? length : room)), outPos);
        unpPtr += length; outPos += length;
        return;
      }
      for (let i = 0; i < length; i++) {
        const v = win[src];
        win[unpPtr] = v;
        src = (src + 1) & mask;
        unpPtr = (unpPtr + 1) & mask;
        if (outPos < unpSize) out[outPos] = v;
        outPos++;
      }
    };
    const put = (v) => {
      win[unpPtr] = v;
      unpPtr = (unpPtr + 1) & mask;
      if (outPos < unpSize) out[outPos] = v;
      outPos++;
    };
    const insertOldDist = (d) => { oldDist[3] = oldDist[2]; oldDist[2] = oldDist[1]; oldDist[1] = oldDist[0]; oldDist[0] = d; };

    let failed = false;
    if ((!solid || !this.tablesRead) && !this.readTables()) failed = true;
    let { LD, DD, LDD, RD } = this;
    if (!failed) for (;;) {
      if (inp.addr > dataLen) break;
      if (this.blockType === BLOCK_PPM) {
        const ch = this.ppm.decodeChar();
        if (ch === -1) { this.ppm.cleanUp(); this.blockType = BLOCK_LZ; failed = true; break; }
        if (ch === this.ppmEscChar) {
          const next = this.safePPM();
          if (next === 0) {
            if (!this.readTables()) { failed = true; break; }
            ({ LD, DD, LDD, RD } = this);
            continue;
          }
          if (next === -1) { failed = true; break; }
          if (next === 2) break;
          if (next === 3) {
            if (!this.readVMCodePPM(outPos)) { failed = true; break; }
            continue;
          }
          if (next === 4) {
            let distance = 0, length = 0, bad = false;
            for (let i = 0; i < 4 && !bad; i++) {
              const c = this.safePPM();
              if (c === -1) bad = true;
              else if (i === 3) length = c;
              else distance = distance * 256 + c;
            }
            if (bad) { failed = true; break; }
            copy(length + 32, distance + 2);
            continue;
          }
          if (next === 5) {
            const length = this.safePPM();
            if (length === -1) { failed = true; break; }
            copy(length + 4, 1);
            continue;
          }
        }
        put(ch);
        continue;
      }

      if (outPos >= unpSize) {
        // Fichier complet : on ne consomme que le marqueur de fin éventuel (256).
        const a = inp.addr, b = inp.bit;
        const peek = decodeNumber(inp, LD);
        inp.addr = a; inp.bit = b;
        if (peek !== 256) break;
      }
      let number = decodeNumber(inp, LD);
      if (number < 256) { put(number); continue; }
      if (number >= 271) {
        number -= 271;
        let length = LDecode[number] + 3;
        let bits = LBits[number];
        if (bits > 0) { length += getbits(inp) >>> (16 - bits); addbits(inp, bits); }
        const distNumber = decodeNumber(inp, DD);
        let distance = DDecode30[distNumber] + 1;
        bits = DBits30[distNumber];
        if (bits > 0) {
          if (distNumber > 9) {
            if (bits > 4) { distance += (getbits(inp) >>> (20 - bits)) << 4; addbits(inp, bits - 4); }
            if (this.lowDistRepCount > 0) {
              this.lowDistRepCount--;
              distance += this.prevLowDist;
            } else {
              const lowDist = decodeNumber(inp, LDD);
              if (lowDist === 16) {
                this.lowDistRepCount = 15;
                distance += this.prevLowDist;
              } else {
                distance += lowDist;
                this.prevLowDist = lowDist;
              }
            }
          } else {
            distance += getbits(inp) >>> (16 - bits);
            addbits(inp, bits);
          }
        }
        if (distance >= 0x2000) {
          length++;
          if (distance >= 0x40000) length++;
        }
        insertOldDist(distance);
        lastLength = length;
        copy(length, distance);
        continue;
      }
      if (number === 256) {
        if (!this.readEndOfBlock()) break;
        ({ LD, DD, LDD, RD } = this);
        continue;
      }
      if (number === 257) {
        if (!this.readVMCode(outPos)) { failed = true; break; }
        continue;
      }
      if (number === 258) {
        if (lastLength !== 0) copy(lastLength, oldDist[0]);
        continue;
      }
      if (number < 263) {
        const distNum = number - 259;
        const distance = oldDist[distNum];
        for (let i = distNum; i > 0; i--) oldDist[i] = oldDist[i - 1];
        oldDist[0] = distance;
        const lengthNumber = decodeNumber(inp, RD);
        let length = LDecode[lengthNumber] + 2;
        const bits = LBits[lengthNumber];
        if (bits > 0) { length += getbits(inp) >>> (16 - bits); addbits(inp, bits); }
        lastLength = length;
        copy(length, distance);
        continue;
      }
      // 263..271 : distances courtes
      number -= 263;
      let distance = SDDecode[number] + 1;
      const bits = SDBits[number];
      if (bits > 0) { distance += getbits(inp) >>> (16 - bits); addbits(inp, bits); }
      insertOldDist(distance);
      lastLength = 2;
      copy(2, distance);
    }
    this.unpPtr = unpPtr;
    this.lastLength = lastLength;
    this.applyFilters(out);
    this.prgStack = [];
    this.inp = null;
    return { data: out, produced: outPos, failed };
  }
}

// ======================================================================
//  En-têtes d'archives
// ======================================================================
function decodeRar4Name(bytes, unicode) {
  if (unicode) {
    const z = bytes.indexOf(0);
    if (z < 0) return decodeUTF8(bytes, false);
    const name = bytes.subarray(0, z), enc = bytes.subarray(z + 1);
    const out = [];
    let encPos = 0, decPos = 0;
    const highByte = enc.length > 0 ? enc[encPos++] : 0;
    let flags = 0, flagBits = 0;
    const max = 2048;
    while (encPos < enc.length && decPos < max) {
      if (flagBits === 0) { flags = enc[encPos++]; flagBits = 8; }
      switch (flags >> 6) {
        case 0:
          if (encPos >= enc.length) break;
          out[decPos++] = enc[encPos++];
          break;
        case 1:
          if (encPos >= enc.length) break;
          out[decPos++] = enc[encPos++] + (highByte << 8);
          break;
        case 2:
          if (encPos + 1 >= enc.length) break;
          out[decPos++] = enc[encPos] + (enc[encPos + 1] << 8);
          encPos += 2;
          break;
        case 3: {
          if (encPos >= enc.length) break;
          let length = enc[encPos++];
          if (length & 0x80) {
            if (encPos >= enc.length) break;
            const correction = enc[encPos++];
            for (length = (length & 0x7f) + 2; length > 0 && decPos < max; length--, decPos++) {
              out[decPos] = ((name[decPos] + correction) & 0xff) + (highByte << 8);
            }
          } else {
            for (length += 2; length > 0 && decPos < max; length--, decPos++) out[decPos] = name[decPos] | 0;
          }
          break;
        }
      }
      flags = (flags << 2) & 0xff;
      flagBits -= 2;
    }
    return String.fromCharCode.apply(null, out);
  }
  return decodeName(bytes, false);
}

function readVint(b, p) {
  let v = 0, mul = 1, i = 0;
  for (; i < 10 && p + i < b.length; i++) {
    const c = b[p + i];
    v += (c & 0x7f) * mul;
    mul *= 128;
    if (!(c & 0x80)) return [v, i + 1];
  }
  return [v, i];
}

function parseRar5(src, start) {
  const entries = [];
  let pos = start, solidArchive = false;
  let guard = 0;
  while (pos + 7 <= src.size && guard++ < 1000000) {
    const pre = src.read(pos, 16);
    if (pre.length < 7) break;
    const [hsize, vlen] = readVint(pre, 4);
    if (hsize === 0 || hsize > 0x200000) throw new RarError('En-tête RAR5 invalide.', 'corrupt');
    const total = 4 + vlen + hsize;
    const h = src.read(pos, total);
    if (h.length < total) throw new RarError('Archive RAR tronquée.', 'truncated');
    let p = 4 + vlen;
    const rv = () => { const [v, l] = readVint(h, p); p += l; return v; };
    const type = rv(), hflags = rv();
    let extraSize = 0, dataSize = 0;
    if (hflags & 1) extraSize = rv();
    if (hflags & 2) dataSize = rv();
    const extraStart = total - extraSize;
    if (type === 1) {
      const aflags = rv();
      solidArchive = (aflags & 4) !== 0;
    } else if (type === 2) {
      const fflags = rv();
      const unpSize = rv();
      rv(); // attributs
      if (fflags & 2) p += 4;
      let crc = null;
      if (fflags & 4) { crc = u32le(h, p); p += 4; }
      const ci = rv();
      rv(); // système hôte
      const nameLen = rv();
      const name = decodeUTF8(h.subarray(p, p + nameLen), false);
      p += nameLen;
      let encrypted = false, isLink = false;
      for (let q = extraStart; q < total;) {
        const [rsize, l1] = readVint(h, q);
        if (rsize === 0) break;
        const [rtype] = readVint(h, q + l1);
        if (rtype === 1) encrypted = true;
        if (rtype === 5) isLink = true;
        q += l1 + rsize;
      }
      const algo = ci & 0x3f;
      const method = (ci >>> 7) & 7;
      const dictBits = (ci >>> 10) & (algo === 1 ? 0x1f : 0xf);
      let dictSize = 0x20000 * Math.pow(2, dictBits);
      if (algo === 1) dictSize += Math.floor(dictSize / 32) * ((ci >>> 15) & 0x1f);
      entries.push({
        index: entries.length, name, isDir: (fflags & 1) !== 0 || isLink,
        unpSize: (fflags & 8) ? -1 : unpSize, packSize: dataSize, dataPos: pos + total,
        crc, method, algo, dictSize, solid: (ci & 0x40) !== 0, encrypted,
        splitBefore: (hflags & 0x08) !== 0, splitAfter: (hflags & 0x10) !== 0, version: algo === 1 ? 70 : 50,
      });
    } else if (type === 4) {
      throw new RarError('Archive protégée par un mot de passe : non prise en charge.', 'encrypted');
    } else if (type === 5) {
      break;
    }
    pos += total + dataSize;
  }
  return { version: 5, solid: solidArchive, entries };
}

function parseRar4(src, start) {
  const entries = [];
  let pos = start, solidArchive = false, guard = 0;
  while (pos + 7 <= src.size && guard++ < 1000000) {
    const b7 = src.read(pos, 7);
    if (b7.length < 7) break;
    const type = b7[2], flags = u16le(b7, 3), headSize = u16le(b7, 5);
    if (headSize < 7) throw new RarError('En-tête RAR invalide.', 'corrupt');
    const h = src.read(pos, headSize);
    if (h.length < headSize) throw new RarError('Archive RAR tronquée.', 'truncated');
    let addSize = (flags & 0x8000) && headSize >= 11 ? u32le(h, 7) : 0;
    if (type === 0x73) {
      solidArchive = (flags & 0x0008) !== 0;
      if (flags & 0x0080) throw new RarError('Archive protégée par un mot de passe : non prise en charge.', 'encrypted');
    } else if (type === 0x74 || type === 0x7a) {
      if (headSize < 32) throw new RarError('En-tête de fichier RAR invalide.', 'corrupt');
      let packSize = u32le(h, 7), unpSize = u32le(h, 11);
      const crc = u32le(h, 16), unpVer = h[24], method = h[25], nameSize = u16le(h, 26);
      let p = 32;
      if (flags & 0x100) {
        packSize += u32le(h, 32) * 4294967296;
        unpSize += u32le(h, 36) * 4294967296;
        p = 40;
      }
      addSize = packSize;
      if (type === 0x74) {
        const name = decodeRar4Name(h.subarray(p, Math.min(p + nameSize, headSize)), (flags & 0x200) !== 0).replace(/\\/g, '/');
        entries.push({
          index: entries.length, name, isDir: (flags & 0xe0) === 0xe0,
          unpSize, packSize, dataPos: pos + headSize, crc, unpVer,
          method: method === 0x30 ? 0 : method - 0x30, dictSize: 0x10000 << ((flags >>> 5) & 7),
          solid: (flags & 0x10) !== 0, encrypted: (flags & 0x04) !== 0,
          splitBefore: (flags & 0x01) !== 0, splitAfter: (flags & 0x02) !== 0, version: unpVer,
        });
      }
    } else if (type === 0x7b) {
      break;
    }
    pos += headSize + addSize;
  }
  return { version: 4, solid: solidArchive, entries };
}

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

class RarArchive {
  constructor(src, info) {
    this.src = src;
    this.format = info.version;
    this.solid = info.solid;
    this.entries = info.entries;
    this.decoder = null;
    this.cursor = -1;
  }
  windowSize() {
    let maxDict = 0, total = 0, maxFile = 0;
    for (const e of this.entries) {
      if (e.isDir || e.method === 0) continue;
      const d = this.format === 5 ? e.dictSize : 0x400000;
      if (d > maxDict) maxDict = d;
      const sz = Math.max(e.unpSize, 0);
      total += sz;
      if (sz > maxFile) maxFile = sz;
    }
    const need = this.solid || this.entries.some(e => e.solid) ? total : maxFile;
    let w = nextPow2(Math.max(1 << 18, Math.min(maxDict || (1 << 18), Math.max(need, 1))));
    if (w > 0x40000000) throw new RarError('Dictionnaire RAR trop grand pour un navigateur.', 'memory');
    return w;
  }
  ensureDecoder() {
    if (this.decoder) return this.decoder;
    const w = this.windowSize();
    try {
      this.decoder = this.format === 5 ? new Rar5Decoder(w) : new Rar29Decoder(w);
    } catch (e) {
      throw new RarError('Mémoire insuffisante pour décompresser cette archive.', 'memory');
    }
    return this.decoder;
  }
  /** true si l'entrée i nécessite le décodage préalable des entrées précédentes. */
  needsChain(i) { const e = this.entries[i]; return e.method !== 0 && e.solid; }
  chainStart(i) {
    let s = i;
    while (s > 0) {
      const e = this.entries[s];
      if (e.method !== 0 && !e.isDir && !e.solid) break;
      s--;
    }
    return s;
  }
  /** Décode l'entrée i et renvoie ses données (Uint8Array). */
  extract(i) {
    const e = this.entries[i];
    if (e.isDir) return new Uint8Array(0);
    if (e.encrypted) throw new RarError('Fichier protégé par un mot de passe : non pris en charge.', 'encrypted');
    if (e.splitBefore || e.splitAfter) throw new RarError('Archive en plusieurs volumes : non prise en charge.', 'multivolume');
    if (e.method === 0) {
      const d = this.src.read(e.dataPos, e.packSize);
      return e.unpSize >= 0 && d.length > e.unpSize ? d.subarray(0, e.unpSize) : d;
    }
    if (this.format === 4 && e.unpVer < 29) {
      throw new RarError('Ancien format RAR (version 1.5/2.0) : non pris en charge.', 'old_format');
    }
    // onChain(fait, total) : progression facultative quand il faut décompresser les entrées précédentes
    const report = (j, s) => { if (this.onChain) this.onChain(j - s + 1, i - s); };
    if (e.solid && !(this.cursor >= this.chainStart(i) && this.cursor < i)) {
      // reprendre la chaîne solide depuis son début
      const s = this.chainStart(i);
      this.cursor = -1;
      for (let j = s; j < i; j++) {
        const ej = this.entries[j];
        if (ej.isDir || ej.method === 0) continue;
        this.decodeEntry(j);
        report(j, s);
      }
    } else if (e.solid) {
      const s = this.cursor + 1;
      for (let j = s; j < i; j++) {
        const ej = this.entries[j];
        if (ej.isDir || ej.method === 0) continue;
        this.decodeEntry(j);
        report(j, s);
      }
    }
    return this.decodeEntry(i);
  }
  decodeEntry(i) {
    const e = this.entries[i];
    if (e.encrypted) throw new RarError('Fichier protégé par un mot de passe : non pris en charge.', 'encrypted');
    if (e.splitBefore || e.splitAfter) throw new RarError('Archive en plusieurs volumes : non prise en charge.', 'multivolume');
    const dec = this.ensureDecoder();
    const packed = this.src.read(e.dataPos, e.packSize);
    if (packed.length < e.packSize) throw new RarError('Archive RAR tronquée.', 'truncated');
    const solid = e.solid && this.cursor >= 0;
    const unp = e.unpSize >= 0 ? e.unpSize : packed.length * 8;
    const res = this.format === 5 ? dec.decodeFile(packed, unp, solid, e.algo === 1) : dec.decodeFile(packed, unp, solid);
    this.cursor = i;
    e.produced = res.produced;
    if (e.crc !== null && e.crc !== undefined) e.crcOk = crc32(res.data) === e.crc;
    return res.data;
  }
}

function findRarSignature(head) {
  for (let i = 0; i + 7 <= head.length; i++) {
    if (head[i] === 0x52 && head[i + 1] === 0x61 && head[i + 2] === 0x72 && head[i + 3] === 0x21 &&
        head[i + 4] === 0x1A && head[i + 5] === 0x07) {
      if (head[i + 6] === 0x00) return { pos: i, version: 4 };
      if (head[i + 6] === 0x01 && head[i + 7] === 0x00) return { pos: i, version: 5 };
    }
  }
  return null;
}

/** Ouvre une archive RAR. src = { size, read(pos, len) → Uint8Array }. */
function openRar(src) {
  const head = src.read(0, Math.min(src.size, 1 << 16));
  const sig = findRarSignature(head);
  if (!sig) throw new RarError("Ce fichier n'est pas une archive RAR valide.", 'not_rar');
  const info = sig.version === 5 ? parseRar5(src, sig.pos + 8) : parseRar4(src, sig.pos + 7);
  return new RarArchive(src, info);
}

// ======================================================================
//  Images : type et dimensions à partir des premiers octets
// ======================================================================
const IMAGE_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp)$/i;
function isImageName(name) {
  const base = name.split('/').pop();
  if (!base || base.startsWith('._') || /^(thumbs\.db|\.ds_store)$/i.test(base)) return false;
  if (/(^|\/)__MACOSX\//.test(name)) return false;
  return IMAGE_EXT.test(base);
}
function mimeFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' })[ext] || 'application/octet-stream';
}

function jpegOrientation(b, p, len) {
  // p : début des données du segment APP1
  if (len < 14 || b[p] !== 0x45 || b[p + 1] !== 0x78 || b[p + 2] !== 0x69 || b[p + 3] !== 0x66) return 1;
  const t = p + 6;
  const le = b[t] === 0x49;
  const r16 = (o) => le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
  const r32 = (o) => le ? u32le(b, o) : u32be(b, o);
  const ifd = t + r32(t + 4);
  if (ifd + 2 > b.length) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    if (r16(e) === 0x0112) return r16(e + 8) || 1;
  }
  return 1;
}

/** Détecte le type d'image et ses dimensions (null si inconnu). */
function sniffImage(b) {
  const n = b.length;
  if (n >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: 'image/png', w: u32be(b, 16), h: u32be(b, 20) };
  }
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2, orientation = 1;
    while (p + 9 < n) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (m === 0xe1) orientation = jpegOrientation(b, p + 4, len - 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        let h = (b[p + 5] << 8) | b[p + 6], w = (b[p + 7] << 8) | b[p + 8];
        if (orientation >= 5 && orientation <= 8) { const t = w; w = h; h = t; }
        return { mime: 'image/jpeg', w, h };
      }
      p += 2 + len;
    }
    return { mime: 'image/jpeg', w: 0, h: 0 };
  }
  if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { mime: 'image/gif', w: u16le(b, 6), h: u16le(b, 8) };
  }
  if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const c = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (c === 'VP8 ') return { mime: 'image/webp', w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (c === 'VP8L') {
      const w = 1 + ((b[21] | (b[22] << 8)) & 0x3fff);
      const h = 1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff);
      return { mime: 'image/webp', w, h };
    }
    if (c === 'VP8X') return { mime: 'image/webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return { mime: 'image/webp', w: 0, h: 0 };
  }
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = u32le(b, 18) | 0, h = u32le(b, 22) | 0;
    return { mime: 'image/bmp', w: Math.abs(w), h: Math.abs(h) };
  }
  if (n >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(avif|avis|mif1|heic|heix)$/.test(brand)) {
      for (let i = 12; i + 20 < n; i++) {
        if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
          return { mime: 'image/avif', w: u32be(b, i + 8), h: u32be(b, i + 12) };
        }
      }
      return { mime: 'image/avif', w: 0, h: 0 };
    }
  }
  return null;
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('fr', { numeric: true, sensitivity: 'base' }) : null;
function naturalCompare(a, b) {
  return collator ? collator.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0);
}

return {
  crc32, RarError, openRar, findRarSignature, sniffImage, isImageName, mimeFromName,
  naturalCompare, decodeName, decodeCP437,
  // exposés pour les tests
  _internal: { PPMModel, Rar29Decoder, Rar5Decoder, makeDecodeTable, identifyFilter, readVMData, runFilter30, STD_FILTERS },
};
}));
