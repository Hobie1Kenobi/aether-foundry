"use strict";
/**
 * Public XRPL Testnet addresses the 2026-11-25 reset wipes. Addresses only, no seeds.
 * Source: corp/wallets.md, machines/governance-board/activated.json, machines/lp-badge-bound/addresses.json.
 */
const HOUSE = [
  { id: "W0", role: "TREASURY", address: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs", seedEnv: "W0_SEED" },
  { id: "W1", role: "MARKET", address: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS", seedEnv: "W1_SEED" },
  { id: "W2", role: "ATELIER", address: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw", seedEnv: "W2_SEED" },
  { id: "W3", role: "CHANNELS", address: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw", seedEnv: "W3_SEED" },
  { id: "W4", role: "ESCROW", address: "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN", seedEnv: "W4_SEED" },
  { id: "W5", role: "RD", address: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ", seedEnv: "W5_SEED" },
  { id: "W6", role: "GRANTS", address: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf", seedEnv: "W6_SEED" },
];
const AUX = [
  { id: "BUYER", role: "work-ticket client", address: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth", seedEnv: "BUYER_SEED" },
  { id: "STRANGER", role: "walk-in purchaser", address: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss", seedEnv: "STRANGER_SEED" },
  { id: "FOREIGN", role: "x402 outbound counterparty", address: "r3JbqcVQ4Pov4MhFUMSdnro7s3VgpaqssZ" },
  { id: "LPB_ISSUER", role: "lp-badge-bound issuer", address: "rPXJrQEJN2K9grJJBqQHQ2V5nazcZQo5Cn" },
  { id: "LPB_HOLDER", role: "lp-badge-bound holder", address: "rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm" },
  { id: "LPB_DOOR", role: "lp-badge-bound door", address: "r3UBPs7Lakfic2Mjq2QcgSqwfn6iYVGtFQ" },
  { id: "LPB_STRANGER", role: "lp-badge-bound stranger", address: "rUpVvDQWBQVvrdazFZfb6E7DPmoafN2jNj" },
];
/** Key-only accounts (SignerList members, RegularKeys). They need not be funded. */
const KEYS = [
  { id: "SIGNER_DIRECTOR", weight: 2, address: "rpEpjesFRPcpWWVKoheDT59YKtoA6Xureg" },
  { id: "SIGNER_TREASURER", weight: 2, address: "rHG25YbFNqFL9HzVqa9JQhXFY9Zignxznh" },
  { id: "SIGNER_ATELIER", weight: 1, address: "rGfkxsMvv833ioy2QjmTXhYF49J94N9WRu" },
  { id: "SIGNER_MARKET", weight: 1, address: "r4Qc6iUKrLZQwM9sPdPWCCHAK2bcMsrxVr" },
  { id: "W1_REGULAR", of: "W1", address: "rDyiGKuMgL2F8S7TjB6m6Wg1pLg5KDPJYY" },
  { id: "W2_REGULAR", of: "W2", address: "rNNzhkcScozB7Nzv3cWCZAEnu6MMC64rmy" },
  { id: "W3_REGULAR", of: "W3", address: "rJRxr1E1Dzz5TXJsCHhwQAm4qS68Y73dQj" },
  { id: "W4_REGULAR", of: "W4", address: "rfXBxqPjprj1J5Ekq5v82D3BDqRm7ms7p2" },
  { id: "W5_REGULAR", of: "W5", address: "rav5cYVarjSaXeeqCbsghMmmVGcJWB5y7Q" },
  { id: "W6_REGULAR", of: "W6", address: "rGjdFjMz577GF4uvb4N9ayCqP5Q74kwVq5" },
];
const OLD_AMM = "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w";
const OLD_LP_CURRENCY = "0330E60FAE706EAD2C7D511D790B07A6F3B89931";
const AETH_HEX = "4145544800000000000000000000000000000000";
const RLUSD = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
module.exports = { HOUSE, AUX, KEYS, OLD_AMM, OLD_LP_CURRENCY, AETH_HEX, RLUSD };
