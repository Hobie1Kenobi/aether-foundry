"use strict";

const MASK = 0xffffffffffffffffn;

const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x, n) {
  const s = BigInt(n);
  if (s === 0n) return x & MASK;
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function keccakF(a) {
  for (let round = 0; round < 24; round += 1) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x += 1) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    const d = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i += 1) a[i] = (a[i] ^ d[i % 5]) & MASK;

    const b = new Array(25);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y]);
      }
    }

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const i = x + 5 * y;
        a[i] = (b[i] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK;
      }
    }
    a[0] = (a[0] ^ RC[round]) & MASK;
  }
}

function keccak256(message) {
  const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message);
  const rate = 136;
  const paddedLen = Math.ceil((bytes.length + 1) / rate) * rate;
  const pad = Buffer.alloc(paddedLen);
  bytes.copy(pad);
  pad[bytes.length] ^= 0x01;
  pad[paddedLen - 1] ^= 0x80;

  const a = new Array(25).fill(0n);
  for (let offset = 0; offset < pad.length; offset += rate) {
    for (let i = 0; i < rate; i += 8) {
      let lane = 0n;
      for (let b = 0; b < 8; b += 1) {
        lane |= BigInt(pad[offset + i + b]) << BigInt(8 * b);
      }
      a[i / 8] ^= lane;
    }
    keccakF(a);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) {
    const lane = a[Math.floor(i / 8)];
    out[i] = Number((lane >> BigInt(8 * (i % 8))) & 0xffn);
  }
  return out;
}

module.exports = { keccak256 };
