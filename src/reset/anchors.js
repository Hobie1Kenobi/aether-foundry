#!/usr/bin/env node
"use strict";
/**
 * Swap the pre-reset AMM account / LP currency in LIVE config files only.
 * Historical records (lab/sessions, lab/ledger-log.jsonl, RESULTS.md, fixtures, snapshots) are never edited.
 *
 *   node src/reset/anchors.js --new-amm rXXXX --new-lp <40 hex>        dry-run (lists edits)
 *   node src/reset/anchors.js --new-amm rXXXX --new-lp <40 hex> --apply
 */
const fs = require("fs");
const path = require("path");
const A = require("./accounts");
const ROOT = path.resolve(__dirname, "../..");
const LIVE = [
  "web/lib/xrpl-public.ts", "web/lib/x402-rules.js", "web/lib/x402-facilitator.js", "public/xrp-ledger.toml",
  "src/director/anchors.js", "src/report/nav.js", "src/lp-badge-bound-guard.js", "src/director/schema.js",
  "corp/wallets.md", "lab/OPERATOR.md", "README.md", "src/walk-in-window-session.js", "src/oracle-mid-ticket-session.js", "src/lp-badge-session.js",
];
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const newAmm = get("--new-amm");
const newLp = get("--new-lp");
if (!newAmm || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(newAmm)) { console.error("need --new-amm r..."); process.exit(2); }
if (newLp && !/^[0-9A-F]{40}$/.test(newLp)) { console.error("--new-lp must be 40 hex"); process.exit(2); }
const apply = args.includes("--apply");
let total = 0;
for (const rel of LIVE) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  let t = fs.readFileSync(p, "utf8");
  const n1 = t.split(A.OLD_AMM).length - 1;
  const n2 = newLp ? t.split(A.OLD_LP_CURRENCY).length - 1 : 0;
  if (!n1 && !n2) continue;
  total += n1 + n2;
  console.log(`${apply ? "edit" : "would edit"} ${rel}: amm x${n1}${newLp ? ` lp x${n2}` : ""}`);
  if (apply) {
    t = t.split(A.OLD_AMM).join(newAmm);
    if (newLp) t = t.split(A.OLD_LP_CURRENCY).join(newLp);
    fs.writeFileSync(p, t);
  }
}
console.log(`${total} replacements ${apply ? "applied" : "(dry-run)"}; tests/fixtures/history untouched — run npm test after --apply`);
