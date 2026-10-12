"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xrpl = require("xrpl");
const anchors = require("../director/anchors");
const policy = require("../runtime/policy");
const signer = require("../runtime/signer");
const pub = require("../walk-in-public");
const watch = require("../walk-in-remint-watch");
const catalog = require("./catalog");
const challenge = require("./challenge");
const redeem = require("./redeem");
const settle = require("./settle");
const deliver = require("./deliver");
const ledger = require("./ledger");
const licenseWatch = require("./watch");
const licenseServer = require("./server");
const demo = require("./demo");
const scribe = require("../agent-chat/scribe-server");

const ROOT = path.resolve(__dirname, "..", "..");
const NOW = new Date("2026-10-12T04:00:00.000Z");
const NFT = "11".repeat(32);
const OFFER = "22".repeat(32);

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "license-"));
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function rich() {
  return { balance: "80000000", ownerCount: 0, reserveBase: "1000000", reserveInc: "200000" };
}

function agent(wallet, tx, extra) {
  return Object.assign({
    env: { FOUNDRY_AGENT_SIGN: "yes" },
    wallet,
    tx,
    networkId: 1,
    account: rich(),
    history: [],
    motions: [],
    state: {
      watched: {
        batch: { atomic_enabled: false },
        walk_in_offer: { status: "open", offer_count: 1 },
      },
    },
    now: NOW,
  }, extra || {});
}

function sampleDoc(overrides) {
  return catalog.metadata(Object.assign({
    job_type: "ledger-analysis-report",
    uses: 1,
    expiry: catalog.DEFAULT_EXPIRY,
  }, overrides || {}));
}

function holderNft(doc, nftokenId) {
  return {
    NFTokenID: nftokenId || NFT,
    Issuer: catalog.W2,
    NFTokenTaxon: catalog.TAXON,
    URI: catalog.uriHex(doc),
  };
}

function infoFixture() {
  return {
    balance_drops: "42000000",
    owner_count: 3,
    sequence: 186,
  };
}

describe("license mint parameters", () => {
  it("builds a small deterministic mint, list, buy, and burn", () => {
    const doc = sampleDoc();
    const again = catalog.metadata(doc);
    assert.equal(catalog.canonical(doc), catalog.canonical(again));
    assert.equal(catalog.uriFor(doc).startsWith("aflic:1:"), true);
    assert.equal(catalog.uriFor(doc).length, "aflic:1:".length + 64);
    const mint = catalog.mintTx(doc);
    assert.equal(mint.TransactionType, "NFTokenMint");
    assert.equal(mint.Account, catalog.W2);
    assert.equal(mint.NFTokenTaxon, 20261012);
    assert.equal(mint.Flags, 9);
    assert.equal(mint.TransferFee, 5000);
    assert.equal(Object.hasOwn(mint, "Destination"), false);
    assert.equal(Object.hasOwn(mint, "Amount"), false);
    assert.equal(Buffer.from(mint.URI, "hex").toString("utf8"), catalog.uriFor(doc));
    const list = catalog.listTx(NFT);
    assert.equal(list.TransactionType, "NFTokenCreateOffer");
    assert.equal(list.Amount, "2000000");
    assert.equal(list.Flags, 1);
    assert.equal(Object.hasOwn(list, "Destination"), false);
    const buy = catalog.buyTx(OFFER);
    assert.equal(buy.TransactionType, "NFTokenAcceptOffer");
    assert.equal(buy.Account, catalog.W4);
    assert.equal(buy.NFTokenSellOffer, OFFER);
    const burn = catalog.burnTx(catalog.W4, NFT);
    assert.equal(burn.TransactionType, "NFTokenBurn");
    assert.equal(burn.Account, catalog.W4);
    assert.equal(Object.hasOwn(burn, "Owner"), false);
    assert.equal(catalog.explorerUrl("ab").startsWith("https://testnet.xrpl.org/transactions/"), true);
  });

  it("matches the desk JSON committed for the two jobs", () => {
    const desk = path.join(ROOT, "machines", "agent-work-license", "desk");
    for (const name of ["ledger-analysis-report.uses1.json", "scribe-summary.uses1.json", "ledger-analysis-report.uses3.json"]) {
      const text = fs.readFileSync(path.join(desk, name), "utf8");
      const doc = catalog.metadata(JSON.parse(text));
      assert.equal(text, `${catalog.canonical(doc)}\n`);
      assert.equal(catalog.parseUri(catalog.uriFor(doc)).hash, catalog.contentHash(doc));
    }
  });
});

describe("signer policy for license transactions", () => {
  it("lets W2 mint and list while the Walk-In offer is still open", () => {
    const doc = sampleDoc();
    const minted = policy.assertAgentRequest(agent("W2", catalog.mintTx(doc), { intent: "license_mint" }));
    assert.equal(minted.wallet.id, "W2");
    const listed = policy.assertAgentRequest(agent("W2", catalog.listTx(NFT), { intent: "license_list" }));
    assert.equal(listed.tx.Amount, "2000000");
    assert.equal(policy.loadAllowlist().tx_types.includes("NFTokenBurn"), true);
    assert.equal(policy.loadAllowlist().special.license_price_drops, "2000000");
    assert.equal(policy.loadAllowlist().special.license_challenge_wallet, "W4");
  });

  it("refuses the wrong wallet, a walk-in price, a destination, and a burn without the intent", () => {
    const doc = sampleDoc();
    throwsCode(() => policy.assertAgentRequest(agent("W4", Object.assign({}, catalog.mintTx(doc), { Account: catalog.W4 }), {
      intent: "license_mint",
    })), "WALLET");
    throwsCode(() => policy.assertAgentRequest(agent("W3", Object.assign({}, catalog.burnTx(anchors.WALLETS.W3.address, NFT)), {
      intent: "license_burn",
    })), "WALLET");
    throwsCode(() => policy.assertAgentRequest(agent("W2", catalog.burnTx(catalog.W2, NFT), { intent: "license_burn" })), "WALLET");
    throwsCode(() => policy.assertAgentRequest(agent("W4", {
      TransactionType: "NFTokenBurn",
      Account: catalog.W4,
      NFTokenID: NFT,
    })), "TX");
    throwsCode(() => policy.assertAgentRequest(agent("W2", Object.assign(catalog.listTx(NFT), { Amount: "10000000" }), {
      intent: "license_list",
    })), "CAP");
    throwsCode(() => policy.assertAgentRequest(agent("W2", Object.assign(catalog.listTx(NFT), { Destination: catalog.W4 }), {
      intent: "license_list",
    })), "DEST");
    throwsCode(() => policy.assertAgentRequest(agent("W2", catalog.listTx(NFT))), "TX");
    throwsCode(() => policy.assertSigningTx({
      TransactionType: "NFTokenCreateOffer",
      Account: catalog.W2,
      NFTokenID: NFT,
      Amount: "2000000",
      Flags: 1,
    }), "CAP");
  });

  it("caps the W4 accept at 2 XRP and counts it toward float and the daily cap", () => {
    const bought = policy.assertAgentRequest(agent("W4", catalog.buyTx(OFFER), {
      intent: "license_buy",
      offerAmount: "2000000",
      sellOffer: {
        LedgerEntryType: "NFTokenOffer",
        Amount: "2000000",
        Flags: 1,
        Owner: catalog.W2,
        NFTokenID: NFT,
      },
    }));
    assert.equal(bought.wallet.id, "W4");
    throwsCode(() => policy.assertAgentRequest(agent("W2", Object.assign({}, catalog.buyTx(OFFER), { Account: catalog.W2 }), {
      intent: "license_buy",
      offerAmount: "2000000",
    })), "WALLET");
    throwsCode(() => policy.assertAgentRequest(agent("W4", catalog.buyTx(OFFER), {
      intent: "license_buy",
      offerAmount: "10000000",
    })), "CAP");
    throwsCode(() => policy.assertAgentRequest(agent("W4", catalog.buyTx(OFFER), { intent: "license_buy" })), "CAP");
    throwsCode(() => policy.assertAgentRequest(agent("W4", catalog.buyTx(OFFER), {
      intent: "license_buy",
      offerAmount: "2000000",
      account: { balance: "3000000", ownerCount: 0, reserveBase: "1000000", reserveInc: "200000" },
    })), "FLOAT");
    throwsCode(() => policy.assertAgentRequest(agent("W4", catalog.buyTx(OFFER), {
      intent: "license_buy",
      offerAmount: "2000000",
      history: [{
        source: "agent-signer",
        ts: "2026-10-12T01:00:00.000Z",
        wallet: "W4",
        amount_drops: "29000000",
      }],
    })), "CAP");
    const burned = policy.assertAgentRequest(agent("W4", catalog.burnTx(catalog.W4, NFT), { intent: "license_burn" }));
    assert.equal(burned.tx.TransactionType, "NFTokenBurn");
  });
});

describe("challenge and redeem", () => {
  it("verifies a regular-key signature and rejects a replay, the wrong holder, expiry, and a spent license", async () => {
    const root = tempRoot();
    const doc = sampleDoc();
    ledger.writeMetadata(root, doc);
    const wallet = xrpl.Wallet.generate();
    const regularKeys = [{ id: "W4", account: catalog.W4, regular_key: wallet.classicAddress }];
    const issued = challenge.issue({
      account: catalog.W4,
      nftokenId: NFT,
      job: doc.job_type,
      nonce: "ab".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 90,
    }, NOW);
    const signed = challenge.signMessage(issued.text, wallet);
    assert.equal(signed.address, wallet.classicAddress);
    assert.notEqual(signed.address, catalog.W4);
    const common = {
      root,
      now: NOW,
      nonces: new Set(),
      regularKeys,
      challenge: issued.text,
      signature: signed.signature,
      publicKey: signed.public_key,
      account: catalog.W4,
      nftokenId: NFT,
      nfts: [holderNft(doc)],
      accountInfo: infoFixture(),
      accountObjects: [{}, {}],
      ledgerIndex: 21423010,
      scribe: false,
    };
    const first = await redeem.redeem(common);
    assert.equal(first.uses_consumed, 1);
    assert.equal(first.settle.action, "burn");
    assert.equal(first.burn_tx.TransactionType, "NFTokenBurn");
    assert.equal(first.burn_tx.Account, catalog.W4);
    assert.equal(first.summary_source, "fallback");
    assert.match(first.summary, /42000000 drops/);
    assert.equal(first.receipt.signed, false);
    await assert.rejects(() => redeem.redeem(common), (error) => error.code === "REPLAY");

    const other = xrpl.Wallet.generate();
    const wrong = challenge.signMessage(issued.text, other);
    const fresh = challenge.issue({
      account: catalog.W4,
      nftokenId: NFT,
      job: doc.job_type,
      nonce: "cd".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 90,
    }, NOW);
    const wrongSigned = challenge.signMessage(fresh.text, other);
    await assert.rejects(() => redeem.redeem(Object.assign({}, common, {
      challenge: fresh.text,
      signature: wrongSigned.signature,
      publicKey: wrongSigned.public_key,
    })), (error) => error.code === "SIGNATURE");
    assert.equal(wrong.address, other.classicAddress);

    const held = challenge.issue({
      account: catalog.W4,
      nftokenId: NFT,
      job: doc.job_type,
      nonce: "ef".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 90,
    }, NOW);
    const heldSig = challenge.signMessage(held.text, wallet);
    await assert.rejects(() => redeem.redeem(Object.assign({}, common, {
      challenge: held.text,
      signature: heldSig.signature,
      publicKey: heldSig.public_key,
      nfts: [],
    })), (error) => error.code === "HOLDER");

    const expiredDoc = sampleDoc({ expiry: "2020-01-01T00:00:00Z" });
    const expiredRoot = tempRoot();
    ledger.writeMetadata(expiredRoot, expiredDoc);
    const expiredIssue = challenge.issue({
      account: catalog.W4,
      nftokenId: NFT,
      job: expiredDoc.job_type,
      nonce: "11".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 90,
    }, NOW);
    const expiredSig = challenge.signMessage(expiredIssue.text, wallet);
    await assert.rejects(() => redeem.redeem(Object.assign({}, common, {
      root: expiredRoot,
      challenge: expiredIssue.text,
      signature: expiredSig.signature,
      publicKey: expiredSig.public_key,
      nfts: [holderNft(expiredDoc)],
    })), (error) => error.code === "EXPIRED");

    const spentRoot = tempRoot();
    ledger.writeMetadata(spentRoot, doc);
    ledger.appendJsonl(path.join(spentRoot, "lab", "ledger-log.jsonl"), {
      event: "license_redeemed",
      nftoken_id: NFT,
      ok: true,
    });
    const spentIssue = challenge.issue({
      account: catalog.W4,
      nftokenId: NFT,
      job: doc.job_type,
      nonce: "22".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 90,
    }, NOW);
    const spentSig = challenge.signMessage(spentIssue.text, wallet);
    await assert.rejects(() => redeem.redeem(Object.assign({}, common, {
      root: spentRoot,
      challenge: spentIssue.text,
      signature: spentSig.signature,
      publicKey: spentSig.public_key,
    })), (error) => error.code === "USED_UP");
  });

  it("counts multi-use in the lab log and burns only the last use", async () => {
    const root = tempRoot();
    const doc = sampleDoc({ uses: 3 });
    ledger.writeMetadata(root, doc);
    const wallet = xrpl.Wallet.generate();
    const actions = [];
    for (let i = 0; i < 3; i += 1) {
      const issued = challenge.issue({
        account: catalog.W4,
        nftokenId: NFT,
        job: doc.job_type,
        nonce: crypto.randomBytes(16).toString("hex"),
        exp: Math.floor(NOW.getTime() / 1000) + 90,
      }, NOW);
      const signed = challenge.signMessage(issued.text, wallet);
      const result = await redeem.redeem({
        root,
        now: NOW,
        regularKeys: [{ id: "W4", account: catalog.W4, regular_key: wallet.classicAddress }],
        challenge: issued.text,
        signature: signed.signature,
        publicKey: signed.public_key,
        account: catalog.W4,
        nftokenId: NFT,
        nfts: [holderNft(doc)],
        accountInfo: infoFixture(),
        accountObjects: [],
        ledgerIndex: 5,
        scribe: false,
      });
      actions.push(result.settle.action);
    }
    assert.deepEqual(actions, ["counter", "counter", "burn"]);
    assert.equal(redeem.usesConsumed(root, NFT), 3);
    assert.equal(settle.decide(doc, 2).action, "counter");
    assert.equal(settle.decide(doc, 3).action, "burn");
  });

  it("accepts a master-key signature whose classic address is the holder", async () => {
    const root = tempRoot();
    const holder = xrpl.Wallet.generate();
    const doc = sampleDoc();
    ledger.writeMetadata(root, doc);
    const issued = challenge.issue({
      account: holder.classicAddress,
      nftokenId: NFT,
      job: doc.job_type,
      nonce: "33".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 30,
    }, NOW);
    const signed = challenge.signMessage(issued.text, holder);
    assert.equal(signed.address, holder.classicAddress);
    const result = await redeem.redeem({
      root,
      now: NOW,
      regularKeys: [],
      challenge: issued.text,
      signature: signed.signature,
      publicKey: signed.public_key,
      account: holder.classicAddress,
      nftokenId: NFT,
      nfts: [holderNft(doc)],
      accountInfo: infoFixture(),
      accountObjects: [],
      ledgerIndex: 9,
      scribe: false,
    });
    assert.equal(result.receipt.signature_via, "account");
    assert.equal(result.burn_tx.Account, holder.classicAddress);
  });

  it("serves challenge and redeem on loopback and refuses a dry-run signature by default", async () => {
    const root = tempRoot();
    const doc = sampleDoc();
    ledger.writeMetadata(root, doc);
    const started = await licenseServer.startServer({
      host: "127.0.0.1",
      port: 0,
      root,
      now: () => NOW,
      nfts: [holderNft(doc)],
      accountInfo: infoFixture(),
      accountObjects: [],
      ledgerIndex: 3,
      scribe: false,
    });
    try {
      assert.throws(() => licenseServer.assertBind("0.0.0.0"), (error) => error.code === "BIND");
      const health = await fetch(`${started.url}/health`);
      const healthBody = await health.json();
      assert.equal(healthBody.signing, false);
      assert.equal(healthBody.network_id, 1);
      const issued = await fetch(`${started.url}/v1/license/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: catalog.W4, nftoken_id: NFT, job: doc.job_type }),
      });
      const body = await issued.json();
      assert.equal(issued.status, 200);
      assert.match(body.challenge, /^aether-license-redeem\/v1\n/);
      const denied = await fetch(`${started.url}/v1/license/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: catalog.W4,
          nftoken_id: NFT,
          challenge: body.challenge,
          signature: "dry-run",
          public_key: "00",
        }),
      });
      const deniedBody = await denied.json();
      assert.equal(denied.status, 401);
      assert.equal(deniedBody.code, "SIGNATURE");
    } finally {
      await started.close();
    }
  });
});

describe("deliver and scribe", () => {
  it("keeps redeem on 8793 and Scribe on 8792", () => {
    assert.equal(licenseServer.DEFAULT_PORT, 8793);
    assert.equal(licenseServer.assertPort(undefined), 8793);
    assert.equal(licenseServer.assertPort(""), 8793);
    assert.equal(licenseServer.assertPort("8794"), 8794);
    assert.equal(deliver.DEFAULT_SCRIBE_URL, "http://127.0.0.1:8792");
    assert.equal(deliver.resolveScribeUrl({}), "http://127.0.0.1:8792");
    assert.equal(
      deliver.resolveScribeUrl({ AETHER_SCRIBE_URL: "http://127.0.0.1:8800/" }),
      "http://127.0.0.1:8800"
    );
  });

  it("uses Scribe when the summarize route is up and falls back when it is not", async () => {
    const report = deliver.reportFromReads(catalog.W4, infoFixture(), [{}, {}], 7);
    const down = await deliver.summarize(report, { scribeUrl: "http://127.0.0.1:9", timeoutMs: 200 });
    assert.equal(down.source, "fallback");
    const started = await scribe.startScribe({
      host: "127.0.0.1",
      port: 0,
      root: tempRoot(),
      env: { AETHER_SCRIBE_MOCK: "1" },
    });
    try {
      const up = await deliver.summarize(report, { scribeUrl: started.url, timeoutMs: 1000 });
      assert.equal(up.source, "scribe");
      assert.match(up.text, /^Scribe summary:/);
      assert.match(up.text, /42000000/);
    } finally {
      await started.close();
    }
  });
});

describe("remint watch license line", () => {
  it("keeps a 10 XRP Walk-In offer open and records a missing license offer", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "machines", "walk-in-window"), { recursive: true });
    fs.writeFileSync(path.join(root, "machines", "walk-in-window", "RESULTS.md"), `# walk-in\n\n| NFTokenID | \`${NFT}\` |\n| OfferID | \`${OFFER}\` |\n`);
    const licenseOffer = "33".repeat(32);
    const licenseNft = "44".repeat(32);
    fs.mkdirSync(path.join(root, "machines", "agent-work-license"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "machines", "agent-work-license", "RESULTS.md"),
      `# Machine: agent-work-license — RESULTS\n\n| NFTokenID | \`${licenseNft}\` |\n| OfferID | \`${licenseOffer}\` |\n`
    );
    const logs = [];
    const code = await watch.run(["node", "watch", "--root", root, "--quiet"], {
      now: () => NOW,
      log: (line) => logs.push(line),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              status: "success",
              validated: true,
              ledger_index: 50,
              account_objects: [{
                index: OFFER,
                NFTokenID: NFT,
                Flags: 1,
                Amount: pub.AMOUNT_DROPS,
                Owner: pub.W2,
              }],
            },
          };
        },
      }),
    });
    assert.equal(code, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^SOLD OUT license plan=/);
    assert.equal(fs.existsSync(path.join(root, "lab", "remint-plans")), true);
    const names = fs.readdirSync(path.join(root, "lab", "remint-plans"));
    assert.equal(names.some((name) => name.startsWith("license-")), true);
    assert.equal(names.some((name) => name.startsWith("walk-in-")), false);
    const plan = JSON.parse(fs.readFileSync(path.join(root, "lab", "remint-plans", names[0]), "utf8"));
    assert.equal(plan.detect_only, true);
    assert.equal(plan.remint, false);
    assert.equal(plan.signed, false);
    const line = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8");
    assert.match(line, /license_sold_out/);
    assert.doesNotMatch(line, /walk_in_sold_out/);
  });

  it("does not treat a 2 XRP license offer as the Walk-In line", () => {
    const grouped = licenseWatch.partition([
      { amount: "10000000", offerId: "AA" },
      { amount: "2000000", offerId: "BB" },
      { amount: "1", offerId: "CC" },
    ]);
    assert.equal(grouped.walkIn.length, 1);
    assert.equal(grouped.license.length, 1);
    assert.equal(grouped.other.length, 1);
  });
});

describe("signer challenge endpoint", () => {
  const token = "test-signer-token-ok";

  function issued() {
    return challenge.issue({
      account: anchors.WALLETS.W4.address,
      nftokenId: NFT,
      job: "ledger-analysis-report",
      nonce: "ab".repeat(16),
      exp: Math.floor(NOW.getTime() / 1000) + 60,
    }, NOW);
  }

  it("dry-runs a W4 challenge and refuses a transaction, another wallet, and a loose string", async () => {
    let loads = 0;
    const base = {
      env: { FOUNDRY_AGENT_SIGN: "yes", FOUNDRY_SIGNER_TOKEN: token },
      skipAuth: true,
      skipRpc: true,
      networkId: 1,
      now: NOW,
      dry: true,
      loadSeed() {
        loads += 1;
        throw new Error("key loaded");
      },
    };
    const out = await signer.signChallenge({ wallet: "W4", challenge: issued().text }, base);
    assert.equal(out.body.dry_run, true);
    assert.equal(out.body.key_loaded, false);
    assert.equal(out.body.signed, false);
    assert.equal(loads, 0);
    await assert.rejects(
      () => signer.signChallenge({ wallet: "W4", challenge: issued().text, tx: { TransactionType: "Payment" } }, base),
      (error) => error.code === "TX"
    );
    await assert.rejects(
      () => signer.signChallenge({ wallet: "W2", challenge: issued().text }, base),
      (error) => error.code === "WALLET"
    );
    await assert.rejects(
      () => signer.signChallenge({ wallet: "W4", challenge: "sign this arbitrary string" }, base),
      (error) => error.code === "CHALLENGE"
    );
    assert.equal(loads, 0);
  });

  it("signs with the injected wallet and returns no seed", async () => {
    const activated = anchors.loadActivated(ROOT);
    const regular = activated.regular_keys.find((row) => row.id === "W4");
    const key = xrpl.Wallet.generate();
    let loads = 0;
    const out = await signer.signChallenge({
      wallet: "W4",
      challenge: issued().text,
    }, {
      env: { FOUNDRY_AGENT_SIGN: "yes", FOUNDRY_SIGNER_TOKEN: token },
      skipAuth: true,
      skipRpc: true,
      networkId: 1,
      now: NOW,
      loadSeed() {
        loads += 1;
        return "present-not-a-family-seed";
      },
      openWallet() {
        return { classicAddress: regular.regular_key, publicKey: key.publicKey, privateKey: key.privateKey };
      },
    });
    assert.equal(loads, 1);
    assert.equal(out.body.account, anchors.WALLETS.W4.address);
    assert.equal(out.body.public_key, key.publicKey);
    assert.equal(JSON.stringify(out.body).includes("present-not-a-family-seed"), false);
    assert.equal(challenge.verifyMessage(issued().text, out.body.signature, out.body.public_key), true);
  });
});

describe("dry-run demo", () => {
  it("prints the six steps, explorer links, and a summary without seeds", async () => {
    const root = tempRoot();
    const lines = [];
    const token = "demo-token-should-not-print";
    const code = await demo.run(["node", "demo", "--dry-run", "--pace", "0", "--root", root], {
      env: { FOUNDRY_SIGNER_TOKEN: token, PATH: process.env.PATH },
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    assert.equal(code, 0);
    assert.match(text, /DRY-RUN/);
    assert.match(text, /1\/6  MINT/);
    assert.match(text, /2\/6  LIST/);
    assert.match(text, /3\/6  BUY/);
    assert.match(text, /4\/6  REDEEM/);
    assert.match(text, /5\/6  DELIVER/);
    assert.match(text, /6\/6  SETTLE/);
    assert.match(text, /https:\/\/testnet\.xrpl\.org\/transactions\/[A-F0-9]{64}/);
    assert.match(text, /42000000/);
    assert.match(text, /fallback/);
    assert.match(text, /NFTokenBurn/);
    assert.equal(text.includes(token), false);
    assert.doesNotMatch(text, /sEd/);
    const log = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8");
    assert.match(log, /license_redeemed/);
    assert.match(log, /license_settled/);
  });

  it("refuses --live under CI and the CLI dry-run exits 0", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "license", "demo.js"), "utf8");
    assert.doesNotMatch(source, /fromSeed|AETHER_SECRETS|W2_REGULAR_SEED|W4_REGULAR_SEED/);
    const refused = spawnSync(process.execPath, ["src/license/demo.js", "--live"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, CI: "true" },
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /refusing --live under CI/);
    const ran = spawnSync(process.execPath, ["src/license/demo.js", "--dry-run", "--pace", "0"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /DRY-RUN/);
    assert.match(ran.stdout, /https:\/\/testnet\.xrpl\.org\/transactions\//);
    assert.equal(demo.parsePace("1.5s"), 1500);
    assert.equal(demo.parsePace("0"), 0);
  });

  it("runs the live path against an injected signer and ledger", async () => {
    const root = tempRoot();
    const buyer = xrpl.Wallet.generate();
    const doc = sampleDoc();
    const nft = "AB".repeat(32);
    const offer = "CD".repeat(32);
    const hashes = {
      license_mint: "A1".repeat(32),
      license_list: "B2".repeat(32),
      license_buy: "C3".repeat(32),
      license_burn: "D4".repeat(32),
    };
    const seen = [];
    const lines = [];
    const code = await demo.runLive({
      paceMs: 0,
      root,
      job: doc.job_type,
      uses: 1,
      expiry: doc.expiry,
    }, {
      env: { CI: "", GITHUB_ACTIONS: "", FOUNDRY_SIGNER_TOKEN: "injected-token-ok" },
      scribe: false,
      log: (line) => lines.push(line),
      error: (line) => lines.push(String(line)),
      regularKeys: [{ id: "W4", account: catalog.W4, regular_key: buyer.classicAddress }],
      client: {
        networkId: 1,
        url: "https://testnet.xrpl-labs.com",
        async sign(payload) {
          seen.push(payload.intent);
          if (!hashes[payload.intent]) throw new Error(`unexpected ${payload.intent}`);
          return { hash: hashes[payload.intent], result: "tesSUCCESS" };
        },
        async signChallenge(payload) {
          if (payload.tx) throw new Error("challenge path received a tx");
          return challenge.signMessage(payload.challenge, buyer);
        },
        async tx(_url, hash) {
          if (hash === hashes.license_mint) return { meta: { nftoken_id: nft } };
          if (hash === hashes.license_list) {
            return {
              meta: {
                AffectedNodes: [{
                  CreatedNode: { LedgerEntryType: "NFTokenOffer", LedgerIndex: offer },
                }],
              },
            };
          }
          return { meta: {} };
        },
        async accountNfts() {
          return [holderNft(doc, nft)];
        },
        async readAccount() {
          return { info: infoFixture(), objects: [{}, {}], ledgerIndex: 21423010 };
        },
      },
    });
    const text = lines.join("\n");
    assert.equal(code, 0, text);
    assert.deepEqual(seen, ["license_mint", "license_list", "license_buy", "license_burn"]);
    assert.match(text, /LIVE/);
    assert.match(text, new RegExp(hashes.license_burn));
    assert.match(text, /https:\/\/testnet\.xrpl\.org\/transactions\/D4D4/);
    assert.doesNotMatch(text, /injected-token-ok/);
    const burned = fs.readFileSync(path.join(root, "lab", "ledger-log.jsonl"), "utf8");
    assert.match(burned, /license_burned/);
    assert.match(burned, /license_redeemed/);
  });
});
