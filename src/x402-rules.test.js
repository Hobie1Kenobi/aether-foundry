"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const rules = require("../web/lib/x402-rules");

const HASH = "A".repeat(64);
const INVOICE = "af-reserve-audit-test1";

function hashSignedTx(blob) {
  if (blob === "NOTPAY") throw new Error("not_payment_tx");
  if (blob === "BLOB") return HASH;
  throw new Error("invalid_tx_blob");
}

function sku() {
  return rules.getSku("reserve-audit");
}

function payment(overrides) {
  const row = sku();
  return Object.assign(
    {
      hash: HASH,
      validated: true,
      TransactionType: "Payment",
      Account: "rBuyerExamplexxxxxxxxxxxxxxxxxxxxx",
      Destination: rules.PAY_TO,
      Amount: row.drops,
      SourceTag: row.sourceTag,
      LastLedgerSequence: 21000000,
      NetworkID: 1,
      Memos: [
        {
          Memo: {
            MemoData: Buffer.from(INVOICE, "utf8").toString("hex").toUpperCase(),
          },
        },
      ],
      meta: {
        TransactionResult: "tesSUCCESS",
        delivered_amount: row.drops,
      },
      ledger_index: 211,
    },
    overrides || {}
  );
}

function headerFor(payload, acceptedOverrides) {
  const row = sku();
  const required = rules.buildPaymentRequired({
    sku: row,
    resourceUrl: "https://desk.example/api/x402/reserve-audit",
    invoiceId: INVOICE,
  });
  const accepted = Object.assign({}, required.accepts[0], acceptedOverrides || {});
  return rules.encodeHeader({
    x402Version: 2,
    accepted,
    payload,
  });
}

describe("x402 payment required", () => {
  it("advertises Testnet exact XRP to W3", () => {
    const row = sku();
    const required = rules.buildPaymentRequired({
      sku: row,
      resourceUrl: "https://desk.example/api/x402/reserve-audit",
      invoiceId: INVOICE,
    });
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts[0].network, "xrpl:1");
    assert.equal(required.accepts[0].scheme, "exact");
    assert.equal(required.accepts[0].asset, "XRP");
    assert.equal(required.accepts[0].payTo, "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw");
    assert.equal(required.accepts[0].amount, "250000");
    assert.equal(required.accepts[0].extra.sourceTag, 202609272);
    assert.equal(required.accepts[0].extra.paymentFlow, "upfront");
    assert.equal(JSON.stringify(required).includes("xrpl:0"), false);
    const again = rules.decodeHeader(rules.encodeHeader(required));
    assert.deepEqual(again, required);
  });

  it("prices the three SKUs in the 0.1–1 XRP band", () => {
    const rows = rules.listSkus();
    assert.deepEqual(
      rows.map((row) => row.id),
      ["machine-spec", "reserve-audit", "composition-quote"]
    );
    assert.deepEqual(
      rows.map((row) => row.drops),
      ["100000", "250000", "500000"]
    );
  });
});

describe("verifyPaymentProof", () => {
  it("accepts a validated memo-bound Payment", async () => {
    const result = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      hashSignedTx,
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.payer, "rBuyerExamplexxxxxxxxxxxxxxxxxxxxx");
    assert.equal(result.invoiceId, INVOICE);
    assert.equal(result.ledgerIndex, 211);
  });

  it("accepts InvoiceID = sha256(invoiceId)", async () => {
    const tx = payment({
      Memos: undefined,
      InvoiceID: rules.sha256Hex(INVOICE),
    });
    const result = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH.toLowerCase() }),
      sku: sku(),
      lookupTx: async () => ({ found: true, tx }),
    });
    assert.equal(result.ok, true);
  });

  it("accepts a signed blob only after the tx is on the ledger", async () => {
    const missing = await rules.verifyPaymentProof({
      header: headerFor({ signedTxBlob: "BLOB" }),
      sku: sku(),
      hashSignedTx,
      lookupTx: async () => ({ found: false, code: "txnNotFound" }),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "payment_not_on_ledger");
    assert.equal(missing.txHash, HASH);

    const settled = await rules.verifyPaymentProof({
      header: headerFor({ signedTxBlob: "BLOB", transaction: HASH }),
      sku: sku(),
      hashSignedTx,
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(settled.ok, true);
  });

  it("rejects mainnet, wrong destination, partial pay, and a missing invoice", async () => {
    const mainnet = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }, { network: "xrpl:0" }),
      sku: sku(),
      lookupTx: async () => ({ found: true, tx: payment() }),
    });
    assert.equal(mainnet.code, "invalid_network");

    const dest = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      lookupTx: async () => ({
        found: true,
        tx: payment({ Destination: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs" }),
      }),
    });
    assert.equal(dest.code, "destination_mismatch");

    const partial = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      lookupTx: async () => ({
        found: true,
        tx: payment({ Flags: 0x00020000 }),
      }),
    });
    assert.equal(partial.code, "amount_mismatch");

    const naked = await rules.verifyPaymentProof({
      header: rules.encodeHeader({
        x402Version: 2,
        payload: { transaction: HASH },
      }),
      sku: sku(),
      lookupTx: async () => ({
        found: true,
        tx: payment({ Memos: undefined, InvoiceID: undefined }),
      }),
    });
    assert.equal(naked.code, "invoice_binding_missing");
  });

  it("rejects NetworkID 0, IOU amounts, and a non-payment blob", async () => {
    const network = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      lookupTx: async () => ({ found: true, tx: payment({ NetworkID: 0 }) }),
    });
    assert.equal(network.code, "invalid_network");

    const iou = await rules.verifyPaymentProof({
      header: headerFor({ transaction: HASH }),
      sku: sku(),
      lookupTx: async () => ({
        found: true,
        tx: payment({
          Amount: { currency: "4145544800000000000000000000000000000000", value: "1" },
        }),
      }),
    });
    assert.equal(iou.code, "amount_mismatch");

    const blob = await rules.verifyPaymentProof({
      header: headerFor({ signedTxBlob: "NOTPAY" }),
      sku: sku(),
      hashSignedTx,
      lookupTx: async () => {
        throw new Error("lookup should not run");
      },
    });
    assert.equal(blob.code, "not_payment_tx");
  });
});

describe("machine spec", () => {
  it("returns a Foundry pack and refuses a grid bot", () => {
    const spec = rules.buildMachineSpec(
      "escrow an NFT receipt and stream it on a channel"
    );
    assert.equal(spec.network, "xrpl:1");
    assert.equal(spec.grid_refused, false);
    assert.ok(spec.files["README.md"].includes("XRPL Testnet"));
    assert.ok(spec.files["PRIMITIVES.md"].includes("EscrowCreate"));
    assert.ok(spec.files["ECONOMICS.md"].includes("Testnet"));
    assert.ok(spec.primitives.length >= 3);

    const grid = rules.buildMachineSpec("run a grid bot on the book");
    assert.equal(grid.grid_refused, true);
    assert.match(grid.files["README.md"], /grid bot/i);
    assert.deepEqual(grid.primitives, ["account_info", "amm_info", "book_offers"]);
  });
});

const REGEX_PREFIX = new Set([
  "return",
  "throw",
  "case",
  "else",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "await",
  "yield",
  "do",
]);

function lastCodeChar(out) {
  for (let j = out.length - 1; j >= 0; j -= 1) {
    if (!/\s/.test(out[j])) return { ch: out[j], index: j };
  }
  return { ch: "", index: -1 };
}

function regexLikely(out) {
  const prev = lastCodeChar(out);
  if (!prev.ch) return true;
  if ("([{=,:;!&|?+-*%^~<>".includes(prev.ch)) return true;
  if (!/[A-Za-z0-9_$]/.test(prev.ch)) return false;
  let k = prev.index;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k -= 1;
  return REGEX_PREFIX.has(out.slice(k + 1, prev.index + 1).join(""));
}

function endsJsxTag(source, gt) {
  if (gt > 0 && source[gt - 1] === "=") return false;
  for (let j = gt - 1; j >= 0; j -= 1) {
    const c = source[j];
    if (c === "<") return true;
    if ("\n;()[]{}&|+-*,?:".includes(c)) return false;
  }
  return false;
}

function maskJsxText(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === ">" && endsJsxTag(source, i)) {
      let j = i + 1;
      let plain = true;
      while (j < source.length && source[j] !== "<") {
        if ("(){};=".includes(source[j])) {
          plain = false;
          break;
        }
        j += 1;
      }
      if (plain && j < source.length && source[j] === "<") {
        out += `>${" ".repeat(j - i - 1)}`;
        i = j;
        continue;
      }
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function codeForSigningScan(source) {
  const out = [];
  let i = 0;
  const n = source.length;

  function blank(ch) {
    out.push(ch === "\n" ? "\n" : " ");
  }

  function scanCode(stopAtInterpClose) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      const next = i + 1 < n ? source[i + 1] : "";
      if (c === "/" && next === "/") {
        blank(c);
        blank(next);
        i += 2;
        while (i < n && source[i] !== "\n") {
          blank(source[i]);
          i += 1;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        blank(c);
        blank(next);
        i += 2;
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
          blank(source[i]);
          i += 1;
        }
        if (i < n) {
          blank("*");
          blank("/");
          i += 2;
        }
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        const quote = c;
        blank(c);
        i += 1;
        while (i < n) {
          const s = source[i];
          if (s === "\\") {
            blank(s);
            i += 1;
            if (i < n) {
              blank(source[i]);
              i += 1;
            }
            continue;
          }
          if (quote === "`" && s === "$" && source[i + 1] === "{") {
            out.push("$", "{");
            i += 2;
            scanCode(true);
            continue;
          }
          blank(s);
          i += 1;
          if (s === quote) break;
          if (quote !== "`" && s === "\n") break;
        }
        continue;
      }
      if (c === "/" && regexLikely(out)) {
        blank(c);
        i += 1;
        let inClass = false;
        while (i < n && source[i] !== "\n") {
          const r = source[i];
          if (r === "\\") {
            blank(r);
            i += 1;
            if (i < n) {
              blank(source[i]);
              i += 1;
            }
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]" && inClass) inClass = false;
          blank(r);
          i += 1;
          if (r === "/" && !inClass) break;
        }
        continue;
      }
      if (stopAtInterpClose && c === "}" && depth === 0) {
        out.push("}");
        i += 1;
        return;
      }
      if (c === "{") depth += 1;
      else if (c === "}") depth = Math.max(0, depth - 1);
      out.push(c);
      i += 1;
    }
  }

  scanCode(false);
  return maskJsxText(out.join(""));
}

describe("desk signing ban", () => {
  it("does not call Wallet.sign or fromSeed under web/", () => {
    const root = path.join(__dirname, "..", "web");
    const files = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === ".next") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(ent.name)) files.push(full);
      }
    };
    walk(root);
    const banned = /Wallet\.sign|fromSeed\s*\(/;
    const samples = [
      ["const signed = Wallet.sign(tx);", true],
      ["const sign = Wallet.sign;", true],
      ["xrpl.Wallet.fromSeed(seed)", true],
      ["fromSeed (seed)", true],
      ["const signed = `${Wallet.sign(tx)}`;", true],
      ['value.replace(/-/g, "+"); const signed = Wallet.sign(tx);', true],
      ['<span className="mono">Wallet.sign</span>', false],
      ['const note = "does not call Wallet.sign";', false],
      ["const note = 'fromSeed(seed)';", false],
      ["// Wallet.sign(tx)", false],
      ["/* fromSeed(seed) */", false],
      ["const label = `Wallet.sign`;", false],
    ];
    for (const [sample, hit] of samples) {
      assert.equal(banned.test(codeForSigningScan(sample)), hit, sample);
    }
    assert.ok(files.some((file) => file.endsWith(path.join("app", "demo", "page.tsx"))));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert.equal(banned.test(codeForSigningScan(text)), false, file);
    }
  });
});
