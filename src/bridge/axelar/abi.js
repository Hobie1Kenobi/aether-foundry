"use strict";

const { keccak256 } = require("./keccak");
const config = require("./config");

const SELECTOR = keccak256(Buffer.from(config.TRANSFER_SIGNATURE)).subarray(0, 4).toString("hex");

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function u256(value) {
  let n;
  try {
    n = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw coded("uint256 is not an integer", "ABI");
  }
  if (n < 0n || n >= 2n ** 256n) throw coded("uint256 out of range", "ABI");
  return n.toString(16).padStart(64, "0");
}

function encodeBytes(buf) {
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const data = body.toString("hex").padEnd(Math.ceil(body.length / 32) * 64, "0");
  return u256(body.length) + data;
}

function encodeInterchainTransfer(args) {
  const token = String(args.tokenId || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(token)) throw coded("tokenId is not bytes32", "ABI");
  const chain = Buffer.from(String(args.destinationChain || ""), "utf8");
  if (chain.length === 0) throw coded("destination chain is empty", "ABI");
  const dest = Buffer.isBuffer(args.destinationAddress)
    ? args.destinationAddress
    : Buffer.from(args.destinationAddress || "");
  if (dest.length === 0) throw coded("destination address is empty", "ABI");
  const meta = args.metadata && args.metadata.length ? Buffer.from(args.metadata) : Buffer.alloc(0);
  const chainTail = encodeBytes(chain);
  const destTail = encodeBytes(dest);
  const metaTail = encodeBytes(meta);
  const offChain = 32 * 6;
  const offDest = offChain + chainTail.length / 2;
  const offMeta = offDest + destTail.length / 2;
  const head = [
    token,
    u256(offChain),
    u256(offDest),
    u256(args.amount),
    u256(offMeta),
    u256(args.gasValue),
  ].join("");
  return `0x${SELECTOR}${head}${chainTail}${destTail}${metaTail}`;
}

module.exports = {
  SELECTOR,
  encodeInterchainTransfer,
};
