"use strict";

/**
 * Read-only eligibility for the W6 grants flywheel.
 * Labeled Foundry addresses (every web/lib/xrpl-public.ts WALLETS entry) are excluded.
 * STRANGER is labeled. A faucet buyer who is not in that list can be eligible.
 */

const hosts = require("../xrpl-hosts");
const policy = require("./policy");
const epoch = require("../time/rippleEpoch");

function emptyBucket() {
  return { seen: new Set(), eligible: [], excluded: [] };
}

function absorb(bucket, item, labeled) {
  if (!item || !policy.isClassic(item.address) || !policy.REASONS.includes(item.reason)) return;
  if (item.address === policy.W6) {
    bucket.excluded.push({ address: item.address, reason: item.reason, why: "labeled", label: "W6" });
    return;
  }
  const label = labeled && labeled.get(item.address);
  if (label) {
    const key = `x|${item.address}|${item.reason}`;
    if (bucket.seen.has(key)) return;
    bucket.seen.add(key);
    bucket.excluded.push({
      address: item.address,
      reason: item.reason,
      why: "labeled",
      label,
    });
    return;
  }
  const key = `${item.address}|${item.reason}`;
  if (bucket.seen.has(key)) {
    const prev = bucket.eligible.find((row) => row.address === item.address && row.reason === item.reason);
    if (prev && item.source && !prev.sources.includes(item.source)) prev.sources.push(item.source);
    if (prev && item.evidence && !prev.evidence) prev.evidence = item.evidence;
    return;
  }
  bucket.seen.add(key);
  bucket.eligible.push({
    address: item.address,
    reason: item.reason,
    sources: item.source ? [item.source] : [],
    evidence: item.evidence || null,
  });
}

function isAethRow(row) {
  const action = String(row.action || "");
  if (action === "lp_badge_bound_trustset" || action === "lp_badge_bound_aeth_buy") return true;
  if (/TrustSet/.test(action) && /AETH/.test(action)) return true;
  if (/PathPay/.test(action) && /AETH/.test(action)) return true;
  const delivered = row.delivered_amount;
  if (delivered && typeof delivered === "object" && String(delivered.currency || "").startsWith("41455448")) {
    return true;
  }
  if (row.tx_type === "TrustSet" && String(row.currency_hex || "").startsWith("41455448")) return true;
  return false;
}

function classifyLedgerRow(row) {
  if (!row || typeof row !== "object") return [];
  const out = [];
  const hash = row.hash ? String(row.hash).toUpperCase() : null;
  if (row.action === "walk_in_buy" && row.buyer) {
    out.push({ address: row.buyer, reason: "walk_in_acceptor", source: "ledger-log", evidence: hash });
  }
  if (row.action === "x402_hit" && row.payer) {
    out.push({ address: row.payer, reason: "x402_payer", source: "ledger-log", evidence: hash });
  }
  if (row.tx_type === "NFTokenAcceptOffer" && row.account && row.action !== "walk_in_buy") {
    const reason = /walk_in/i.test(String(row.action || "")) ? "walk_in_acceptor" : "artifact_holder";
    out.push({ address: row.account, reason, source: "ledger-log", evidence: hash });
  }
  if (isAethRow(row) && row.account) {
    out.push({ address: row.account, reason: "aeth_counterparty", source: "ledger-log", evidence: hash });
  }
  return out;
}

function parseJsonl(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip torn lines */
    }
  }
  return rows;
}

function fromLedger(text, labeled) {
  const bucket = emptyBucket();
  for (const row of parseJsonl(text)) {
    for (const item of classifyLedgerRow(row)) absorb(bucket, item, labeled);
  }
  return bucket;
}

function txOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  const tx = entry.tx_json || entry.tx || null;
  if (!tx || typeof tx !== "object") return null;
  const meta = entry.meta || entry.metaData || {};
  const result = meta.TransactionResult || "";
  if (entry.validated === false) return null;
  if (result && result !== "tesSUCCESS") return null;
  const hash = String(entry.hash || tx.hash || "").toUpperCase();
  return { tx, hash, date: tx.date == null ? entry.date : tx.date };
}

function isoFromRipple(date) {
  if (date == null || date === "") return "";
  const seconds = Number(date);
  if (!Number.isFinite(seconds)) return "";
  return new Date(epoch.rippleToUnix(seconds) * 1000).toISOString();
}

function fromAccountTx(account, entries, labeled) {
  const bucket = emptyBucket();
  const paid = [];
  const list = Array.isArray(entries) ? entries.slice(0, policy.ACCOUNT_TX_LIMIT) : [];
  for (const entry of list) {
    const view = txOf(entry);
    if (!view) continue;
    const tx = view.tx;
    if (account === policy.W3 && tx.TransactionType === "Payment" && tx.Destination === policy.W3) {
      if (typeof tx.Amount !== "string") continue;
      if (!policy.X402_SOURCE_TAGS.has(Number(tx.SourceTag))) continue;
      absorb(
        bucket,
        { address: tx.Account, reason: "x402_payer", source: "account_tx", evidence: view.hash },
        labeled
      );
    }
    if (account === policy.W2 && tx.TransactionType === "NFTokenAcceptOffer" && tx.Account && tx.Account !== policy.W2) {
      absorb(
        bucket,
        { address: tx.Account, reason: "walk_in_acceptor", source: "account_tx", evidence: view.hash },
        labeled
      );
    }
    if (account === policy.W6 && tx.TransactionType === "Payment" && tx.Account === policy.W6) {
      const reason = policy.reasonFromMemos(tx);
      if (!reason || typeof tx.Amount !== "string") continue;
      if (!policy.isClassic(tx.Destination)) continue;
      paid.push({
        destination: tx.Destination,
        reason,
        hash: view.hash,
        result: "tesSUCCESS",
        ts: isoFromRipple(view.date),
        source: "account_tx",
      });
    }
  }
  return { bucket, paid };
}

function fromNfts(nfts, labeled) {
  const bucket = emptyBucket();
  const list = Array.isArray(nfts) ? nfts.slice(0, policy.NFT_LIMIT) : [];
  for (const nft of list) {
    if (!nft || typeof nft !== "object") continue;
    if (nft.nft_taxon != null && Number(nft.nft_taxon) !== 20260927) continue;
    const owner = nft.owner || nft.Owner;
    if (!owner) continue;
    absorb(
      bucket,
      {
        address: owner,
        reason: "artifact_holder",
        source: "nfts_by_issuer",
        evidence: nft.nft_id || nft.NFTokenID || null,
      },
      labeled
    );
  }
  return bucket;
}

function mergeBuckets(buckets) {
  const bucket = emptyBucket();
  for (const part of buckets) {
    if (!part) continue;
    for (const row of part.eligible || []) {
      absorb(bucket, { address: row.address, reason: row.reason, source: (row.sources || [])[0], evidence: row.evidence }, labeledPassthrough());
      const prev = bucket.eligible.find((item) => item.address === row.address && item.reason === row.reason);
      if (prev) {
        for (const source of row.sources || []) {
          if (source && !prev.sources.includes(source)) prev.sources.push(source);
        }
      }
    }
    for (const row of part.excluded || []) {
      const key = `x|${row.address}|${row.reason}|${row.why}`;
      if (bucket.seen.has(key)) continue;
      bucket.seen.add(key);
      bucket.excluded.push(row);
    }
  }
  return bucket;
}

function labeledPassthrough() {
  return { get() { return undefined; } };
}

function parsePaid(text) {
  const out = [];
  for (const row of parseJsonl(text)) {
    if (!row || typeof row !== "object") continue;
    const action = row.action;
    if (action && action !== "grant_paid") continue;
    if (!row.destination || !row.reason) continue;
    if (row.result && row.result !== "tesSUCCESS") continue;
    out.push({
      destination: row.destination,
      reason: row.reason,
      ts: row.ts || "",
      hash: row.hash || "",
      result: "tesSUCCESS",
    });
  }
  return out;
}

function paidBlocks(paid, address, reason, now, cooldownMs) {
  const window = cooldownMs == null ? policy.COOLDOWN_MS : cooldownMs;
  const clock = now == null ? Date.now() : now;
  for (const row of paid || []) {
    if (row.destination !== address || row.reason !== reason) continue;
    if (row.result && row.result !== "tesSUCCESS") continue;
    const ts = Date.parse(row.ts || "");
    if (!Number.isFinite(ts)) return true;
    if (clock - ts < window) return true;
  }
  return false;
}

function selectEligible(bucket, paid, now, cooldownMs) {
  const grouped = new Map();
  for (const row of bucket.eligible) {
    if (!grouped.has(row.address)) grouped.set(row.address, []);
    grouped.get(row.address).push(row);
  }
  const selectable = [];
  const cooled = [];
  for (const [address, rows] of grouped) {
    const ranked = rows.slice().sort((a, b) => policy.RANK[a.reason] - policy.RANK[b.reason]);
    const open = ranked.filter((row) => !paidBlocks(paid, address, row.reason, now, cooldownMs));
    if (open.length === 0) {
      cooled.push({ address, reason: ranked[0].reason, why: "cooldown" });
      continue;
    }
    selectable.push(open[0]);
  }
  selectable.sort((a, b) => policy.RANK[a.reason] - policy.RANK[b.reason] || a.address.localeCompare(b.address));
  return { selectable, cooled };
}

function suppressHolderDupes(bucket) {
  const buyers = new Set(
    bucket.eligible.filter((row) => row.reason === "walk_in_acceptor").map((row) => row.address)
  );
  return {
    eligible: bucket.eligible.filter((row) => row.reason !== "artifact_holder" || !buyers.has(row.address)),
    excluded: bucket.excluded,
  };
}

function combine(parts, paid, now, cooldownMs) {
  const merged = suppressHolderDupes(mergeBuckets(parts));
  const picked = selectEligible(merged, paid, now, cooldownMs);
  return {
    eligible: merged.eligible,
    selectable: picked.selectable,
    excluded: merged.excluded.concat(picked.cooled),
  };
}

function choose(selectable, args) {
  const list = Array.isArray(selectable) ? selectable : [];
  if (args && args.destination) {
    const rows = list.filter((row) => row.address === args.destination);
    if (args.reason) return rows.find((row) => row.reason === args.reason) || null;
    return rows[0] || null;
  }
  if (args && args.reason) return list.find((row) => row.reason === args.reason) || null;
  return list[0] || null;
}

function rpcParams(method, params) {
  return JSON.stringify({ method, params: [params] });
}

async function rpcCall(http, method, params, fetchImpl) {
  const response = await fetchImpl(http, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpcParams(method, params),
  });
  const body = await response.json();
  const result = (body && body.result) || body;
  if (result && result.error) {
    throw policy.coded(result.error_message || result.error, "RPC");
  }
  return result || {};
}

async function fetchSources(opts) {
  const http = policy.assertTestnetUrl(opts.http);
  const fetchImpl = opts.fetchImpl;
  const info = await rpcCall(http, "server_info", {}, fetchImpl);
  const networkId = info.info && info.info.network_id;
  policy.assertNetworkId(networkId);
  const limit = policy.ACCOUNT_TX_LIMIT;
  const txParams = (account) => ({
    account,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit,
    forward: false,
  });
  const w3 = await rpcCall(http, "account_tx", txParams(policy.W3), fetchImpl);
  const w2 = await rpcCall(http, "account_tx", txParams(policy.W2), fetchImpl);
  const w6tx = await rpcCall(http, "account_tx", txParams(policy.W6), fetchImpl);
  let nfts = [];
  try {
    const issued = await rpcCall(
      http,
      "nfts_by_issuer",
      { issuer: policy.W2, nft_taxon: 20260927, limit: policy.NFT_LIMIT },
      fetchImpl
    );
    nfts = Array.isArray(issued.nfts) ? issued.nfts.slice(0, policy.NFT_LIMIT) : [];
  } catch {
    nfts = [];
  }
  const enriched = [];
  for (const nft of nfts) {
    if (enriched.length >= policy.NFT_LIMIT) break;
    try {
      const infoNft = await rpcCall(http, "nft_info", { nft_id: nft.nft_id }, fetchImpl);
      enriched.push({
        nft_id: nft.nft_id,
        nft_taxon: nft.nft_taxon,
        owner: infoNft.owner || infoNft.nft_owner || null,
      });
    } catch {
      enriched.push({ nft_id: nft.nft_id, nft_taxon: nft.nft_taxon, owner: null });
    }
  }
  let w6 = null;
  try {
    const account = await rpcCall(
      http,
      "account_info",
      { account: policy.W6, ledger_index: "validated" },
      fetchImpl
    );
    const state = await rpcCall(http, "server_state", {}, fetchImpl);
    const validated = (state.state && state.state.validated_ledger) || {};
    w6 = {
      balance: account.account_data && account.account_data.Balance,
      ownerCount: account.account_data ? Number(account.account_data.OwnerCount || 0) : 0,
      reserveBase: validated.reserve_base,
      reserveInc: validated.reserve_inc,
      regularKey: (account.account_data && account.account_data.RegularKey) || null,
    };
  } catch {
    w6 = null;
  }
  return {
    networkId,
    w3: Array.isArray(w3.transactions) ? w3.transactions : [],
    w2: Array.isArray(w2.transactions) ? w2.transactions : [],
    w6tx: Array.isArray(w6tx.transactions) ? w6tx.transactions : [],
    nfts: enriched,
    w6,
  };
}

function fromRpcPayload(payload, labeled) {
  const w3 = fromAccountTx(policy.W3, payload.w3, labeled);
  const w2 = fromAccountTx(policy.W2, payload.w2, labeled);
  const w6 = fromAccountTx(policy.W6, payload.w6tx, labeled);
  const nfts = fromNfts(payload.nfts, labeled);
  return {
    buckets: [w3.bucket, w2.bucket, nfts],
    paid: w6.paid,
  };
}

async function collect(opts) {
  const labeled = opts.labeled;
  const local = fromLedger(opts.ledgerText || "", labeled);
  const filePaid = parsePaid(opts.grantsText || "").concat(parsePaid(opts.ledgerText || ""));
  let remoteBuckets = [];
  let chainPaid = [];
  let w6 = null;
  let rpcError = null;
  if (opts.rpc !== false) {
    try {
      const payload = opts.payload || (await hosts.withFailover(policy.assertTestnetUrl(opts.http), async (url) => {
        return fetchSources(Object.assign({}, opts, { http: url }));
      }));
      if (payload.networkId != null) policy.assertNetworkId(payload.networkId);
      const remote = fromRpcPayload(payload, labeled);
      remoteBuckets = remote.buckets;
      chainPaid = remote.paid;
      w6 = payload.w6 || null;
    } catch (error) {
      if (error && (error.code === "MAINNET" || error.code === "MOTION")) throw error;
      rpcError = error.message || String(error);
    }
  }
  const report = combine([local].concat(remoteBuckets), filePaid.concat(chainPaid), opts.now, opts.cooldownMs);
  return Object.assign(report, { w6, rpcError, paid: filePaid.concat(chainPaid) });
}

function renderScan(report) {
  const lines = [];
  lines.push("scan");
  lines.push(`network ${policy.NETWORK}`);
  lines.push("rule exclude every web/lib/xrpl-public.ts WALLETS address");
  lines.push("rule STRANGER is a labeled Foundry test actor and is not eligible");
  lines.push("rule a non-labeled faucet buyer who used a Foundry artifact can be eligible");
  lines.push(`cooldown_ms ${policy.COOLDOWN_MS}`);
  lines.push(`tx_cap ${policy.ACCOUNT_TX_LIMIT}`);
  if (report.rpcError) lines.push(`rpc_error ${report.rpcError}`);
  lines.push(`selectable ${report.selectable.length}`);
  report.selectable.forEach((row, index) => {
    lines.push(
      `${index + 1} ${row.address} ${row.reason} sources ${row.sources.join(",") || "none"} evidence ${row.evidence || "none"}`
    );
  });
  const labeled = report.excluded.filter((row) => row.why === "labeled");
  const cooled = report.excluded.filter((row) => row.why === "cooldown");
  lines.push(`excluded_labeled ${labeled.length}`);
  lines.push(`excluded_cooldown ${cooled.length}`);
  cooled.forEach((row) => lines.push(`cooldown ${row.address} ${row.reason}`));
  lines.push("no payment (scan is read-only)");
  return lines.join("\n");
}

module.exports = {
  classifyLedgerRow,
  parseJsonl,
  fromLedger,
  fromAccountTx,
  fromNfts,
  parsePaid,
  paidBlocks,
  selectEligible,
  combine,
  choose,
  fetchSources,
  fromRpcPayload,
  collect,
  renderScan,
  isoFromRipple,
};
