"use strict";

/**
 * Detect-only sold-out notice for the license product line.
 * The Walk-In remint watch calls this. It never signs and never remints.
 */

const fs = require("fs");
const path = require("path");
const pub = require("../walk-in-public");
const catalog = require("./catalog");

function partition(offers) {
  const walkIn = [];
  const license = [];
  const other = [];
  for (const offer of offers || []) {
    const amount = offer && offer.amount != null ? String(offer.amount) : "";
    if (amount === pub.AMOUNT_DROPS) walkIn.push(offer);
    else if (amount === catalog.PRICE_DROPS) license.push(offer);
    else other.push(offer);
  }
  return { walkIn, license, other };
}

function stampUtc(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    String(date.getUTCFullYear())
    + p(date.getUTCMonth() + 1)
    + p(date.getUTCDate())
    + "-"
    + p(date.getUTCHours())
    + p(date.getUTCMinutes())
    + p(date.getUTCSeconds())
  );
}

function lastKnownFromResults(text) {
  const body = text || "";
  const offerIds = [...body.matchAll(/^\| OfferID \| `([A-Fa-f0-9]{64})` \|/gm)].map((m) => m[1].toUpperCase());
  const nftIds = [...body.matchAll(/^\| NFTokenID \| `([A-Fa-f0-9]{64})` \|/gm)].map((m) => m[1].toUpperCase());
  if (!offerIds.length || !nftIds.length) return null;
  return {
    offerId: offerIds[offerIds.length - 1],
    nftokenId: nftIds[nftIds.length - 1],
  };
}

function readLastKnown(root) {
  const file = path.join(root, "machines", "agent-work-license", "RESULTS.md");
  if (!fs.existsSync(file)) return null;
  return lastKnownFromResults(fs.readFileSync(file, "utf8"));
}

function alreadyRecorded(jsonlText, offerId, simulated) {
  if (!offerId) return false;
  let found = false;
  for (const line of String(jsonlText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row.event !== "license_sold_out" && row.action !== "license_sold_out") continue;
      if (String(row.offer_id || "").toUpperCase() !== offerId.toUpperCase()) continue;
      const rowSim = Boolean(row.simulated);
      if (simulated ? rowSim : !rowSim) found = true;
    } catch {
      /* skip */
    }
  }
  return found;
}

function buildPlan(info) {
  return {
    machine: "agent-work-license",
    network: "XRPL Testnet",
    mode: "dry-run",
    signed: false,
    detect_only: true,
    remint: false,
    simulated: Boolean(info.simulated),
    detected_at: info.detectedAt,
    rpc: info.rpc,
    ledger_index: info.ledgerIndex == null ? null : info.ledgerIndex,
    w2: catalog.W2,
    last_known: {
      nftoken_id: info.nftokenId,
      offer_id: info.offerId,
      amount_drops: catalog.PRICE_DROPS,
    },
    notes: [
      "Detect-only. This file is not a signed transaction and not a remint.",
      "The Walk-In 10 XRP line is a different product. Do not remint it from this plan.",
      "A new license listing is an operator action on the Foundry box.",
    ],
  };
}

function planFileName(root, stamp) {
  const dir = path.join(root, "lab", "remint-plans");
  fs.mkdirSync(dir, { recursive: true });
  let name = `license-${stamp}.json`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `license-${stamp}-${n}.json`;
    n += 1;
  }
  return `lab/remint-plans/${name}`;
}

function appendText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  }
  fs.appendFileSync(file, prefix + text);
}

function recordSoldOut(root, info) {
  const when = info.now || new Date();
  const detectedAt = when.toISOString().replace(/\.\d{3}Z$/, "Z");
  const rel = planFileName(root, stampUtc(when));
  const plan = buildPlan({
    simulated: info.simulated,
    detectedAt,
    rpc: info.rpc,
    ledgerIndex: info.ledgerIndex,
    nftokenId: info.nftokenId,
    offerId: info.offerId,
  });
  fs.writeFileSync(path.join(root, rel), `${JSON.stringify(plan, null, 2)}\n`);
  const event = {
    ts: detectedAt,
    event: "license_sold_out",
    action: "license_sold_out",
    network: "XRPL Testnet",
    w2: catalog.W2,
    offer_id: info.offerId,
    nftoken_id: info.nftokenId,
    plan: rel,
    rpc: info.rpc,
    ledger_index: info.ledgerIndex == null ? null : info.ledgerIndex,
    signed: false,
    detect_only: true,
  };
  if (info.simulated) event.simulated = true;
  appendText(path.join(root, "lab", "ledger-log.jsonl"), `${JSON.stringify(event)}\n`);
  const results = path.join(root, "machines", "agent-work-license", "RESULTS.md");
  const section = `
## Sold-out detection ${detectedAt}

License sell offer is gone (\`account_objects\` sell offers at ${catalog.PRICE_DROPS} drops). Last known OfferID \`${info.offerId}\`, NFTokenID \`${info.nftokenId}\`. Dry-run plan: \`${rel}\`. Detect-only. Not a remint.
`;
  if (!fs.existsSync(results)) {
    appendText(results, `# Machine: agent-work-license — RESULTS\n\n**Network:** XRPL Testnet\n${section}`);
  } else {
    appendText(results, section);
  }
  return rel;
}

function detectSoldOut(root, info) {
  const known = readLastKnown(root);
  if (!known) return null;
  const open = partition(info && info.offers).license;
  if (open.length > 0) return null;
  const jsonlPath = path.join(root, "lab", "ledger-log.jsonl");
  const jsonlText = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf8") : "";
  if (alreadyRecorded(jsonlText, known.offerId, Boolean(info && info.simulated))) return null;
  return recordSoldOut(root, {
    now: info && info.now,
    rpc: info && info.rpc,
    ledgerIndex: info && info.ledgerIndex,
    nftokenId: known.nftokenId,
    offerId: known.offerId,
    simulated: Boolean(info && info.simulated),
  });
}

module.exports = {
  partition,
  stampUtc,
  lastKnownFromResults,
  readLastKnown,
  alreadyRecorded,
  buildPlan,
  recordSoldOut,
  detectSoldOut,
};
