#!/usr/bin/env node
"use strict";
/**
 * Read-only pre/post-reset snapshot of Foundry XRPL Testnet state.
 * No seeds are loaded. No transaction is built, signed or submitted.
 *
 *   node src/reset/snapshot.js --out lab/reset-2026-11-25/pre-reset-snapshot.json
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hosts = require("../xrpl-hosts");
const A = require("./accounts");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "lab/reset-2026-11-25/pre-reset-snapshot.json";
const ROOT = path.resolve(__dirname, "../..");

async function req(client, body) {
  try {
    return (await client.request(body)).result;
  } catch (e) {
    return { error: (e.data && e.data.error) || e.message };
  }
}

async function paged(client, body, key) {
  const out = [];
  let marker;
  for (let i = 0; i < 50; i += 1) {
    const r = await req(client, { ...body, ...(marker ? { marker } : {}) });
    if (r.error) return out.length ? out : { error: r.error };
    out.push(...(r[key] || []));
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}

function fileFreeze(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  return { path: rel, bytes: buf.length, lines: lines.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), last_line: lines.length ? lines[lines.length - 1].slice(0, 400) : null };
}

(async () => {
  const client = await hosts.openClient(hosts.resolveWs(process.env));
  const li = { ledger_index: "validated" };
  const snap = { kind: "aether-foundry-testnet-snapshot", taken_at: new Date().toISOString(), rpc: client.url || null, note: "Read-only. Public ledger data only. No seeds." };
  const si = await req(client, { command: "server_info" });
  snap.server = si.error ? si : { network_id: si.info.network_id, build_version: si.info.build_version, validated_ledger: si.info.validated_ledger, complete_ledgers: si.info.complete_ledgers };
  const feat = await req(client, { command: "feature" });
  snap.amendments = feat.error ? feat : Object.fromEntries(Object.entries(feat.features || {}).map(([h, v]) => [v.name || h, { hash: h, enabled: !!v.enabled, supported: !!v.supported }]));

  snap.accounts = {};
  for (const a of [...A.HOUSE, ...A.AUX]) {
    const row = { id: a.id, role: a.role, address: a.address };
    const ai = await req(client, { command: "account_info", account: a.address, signer_lists: true, ...li });
    if (ai.error) { row.error = ai.error; snap.accounts[a.id] = row; continue; }
    const d = ai.account_data;
    row.account_root = { Balance: d.Balance, Flags: d.Flags, OwnerCount: d.OwnerCount, Sequence: d.Sequence, RegularKey: d.RegularKey || null, Domain: d.Domain || null, EmailHash: d.EmailHash || null, TransferRate: d.TransferRate || null, TickSize: d.TickSize || null, MintedNFTokens: d.MintedNFTokens || 0, BurnedNFTokens: d.BurnedNFTokens || 0, NFTokenMinter: d.NFTokenMinter || null };
    row.account_flags = ai.account_flags || null;
    row.signer_lists = (ai.signer_lists || d.signer_lists || []).map((s) => ({ SignerQuorum: s.SignerQuorum, SignerEntries: (s.SignerEntries || []).map((e) => e.SignerEntry) }));
    row.lines = await paged(client, { command: "account_lines", account: a.address, ...li }, "lines");
    row.offers = await paged(client, { command: "account_offers", account: a.address, ...li }, "offers");
    row.nfts = await paged(client, { command: "account_nfts", account: a.address, ...li }, "account_nfts");
    const objs = await paged(client, { command: "account_objects", account: a.address, ...li }, "account_objects");
    row.objects = Array.isArray(objs) ? objs.filter((o) => o.LedgerEntryType !== "RippleState" && o.LedgerEntryType !== "Offer" && o.LedgerEntryType !== "NFTokenPage") : objs;
    row.object_counts = Array.isArray(objs) ? objs.reduce((m, o) => ((m[o.LedgerEntryType] = (m[o.LedgerEntryType] || 0) + 1), m), {}) : null;
    if (a.id === "W0") row.gateway_balances = await req(client, { command: "gateway_balances", account: a.address, ...li });
    // NFT sell offers for each held NFT (W2 Walk-In, licenses)
    if (Array.isArray(row.nfts) && row.nfts.length && row.nfts.length <= 40) {
      row.nft_sell_offers = {};
      for (const n of row.nfts) {
        const so = await req(client, { command: "nft_sell_offers", nft_id: n.NFTokenID, ...li });
        if (!so.error) row.nft_sell_offers[n.NFTokenID] = so.offers;
      }
    }
    snap.accounts[a.id] = row;
  }
  snap.key_accounts = A.KEYS;
  const amm = await req(client, { command: "amm_info", asset: { currency: "XRP" }, asset2: { currency: A.AETH_HEX, issuer: A.HOUSE[0].address }, ...li });
  snap.amm = amm.error ? amm : amm.amm;
  snap.amm_expected_old_account = A.OLD_AMM;
  const rl = await req(client, { command: "account_info", account: A.RLUSD.issuer, ...li });
  snap.rlusd_issuer = { address: A.RLUSD.issuer, currency: A.RLUSD.currency, exists: !rl.error, flags: rl.account_data ? rl.account_data.Flags : null, domain: rl.account_data ? rl.account_data.Domain || null : null };
  snap.repo_freeze = { ledger_log: fileFreeze("lab/ledger-log.jsonl"), metrics: fileFreeze("lab/metrics.json"), director_state: fileFreeze("lab/director-state.json") };
  try { await client.disconnect(); } catch {}
  const outPath = path.resolve(ROOT, OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const text = JSON.stringify(snap, null, 2) + "\n";
  if (/\bs[1-9A-HJ-NP-Za-km-z]{25,34}\b/.test(text.replace(/"(Sequence|SourceTag|seq)"/g, ""))) {
    // Defensive: a family seed looks like s + base58. Ledger data never contains one; refuse to write if it does.
    const hits = text.match(/"s[1-9A-HJ-NP-Za-km-z]{27,30}"/g);
    if (hits) { console.error("refusing to write: seed-like string present"); process.exit(3); }
  }
  fs.writeFileSync(outPath, text);
  const summary = Object.values(snap.accounts).map((r) => `${r.id} ${r.error ? r.error : `bal=${Number(r.account_root.Balance) / 1e6} oc=${r.account_root.OwnerCount} lines=${r.lines.length} offers=${r.offers.length} nfts=${r.nfts.length}`}`);
  console.log(`wrote ${OUT}`);
  console.log(`ledger ${snap.server.validated_ledger && snap.server.validated_ledger.seq} network ${snap.server.network_id}`);
  console.log(summary.join("\n"));
})().catch((e) => { console.error(e.message); process.exit(1); });
