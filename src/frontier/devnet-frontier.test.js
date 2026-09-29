"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const devnet = require("../../web/lib/devnet-frontier");

const ROOT = path.join(__dirname, "../..");
const D0 = "rEizYPsEi1GMqiV5igtYVGzxsvwEENTFS1";
const W0 = "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs";

function row(extra) {
  return JSON.stringify(Object.assign({
    network: "XRPL Devnet",
    network_id: 2,
    result: "tesSUCCESS",
  }, extra));
}

describe("devnet frontier snapshot", () => {
  it("reads the public wallet book and ledger without testnet ids", () => {
    const snapshot = devnet.publicSnapshot({
      walletsText: fs.readFileSync(path.join(ROOT, "corp/wallets.md"), "utf8"),
      ledgerText: fs.readFileSync(path.join(ROOT, "lab/frontier/devnet-ledger.jsonl"), "utf8"),
      labeled: [W0],
    });
    assert.equal(snapshot.network, "XRPL Devnet");
    assert.equal(snapshot.networkId, 2);
    assert.equal(snapshot.accounts.D0, D0);
    assert.equal(snapshot.accounts.D1, "rNk7hv8UekyPCpq4sfgtvxrdTBxa3VLFit");
    assert.equal(snapshot.accounts.D2, "rGK3QfP57LzBzS8KcYHmpBa8NvUHxoxAgV");
    assert.equal(snapshot.accounts.D3, "rNqcmmEm9TP4pmK7UDHLf21Xr7N4xEHWG8");
    assert.equal(snapshot.f8.sponsor, D0);
    assert.equal(snapshot.f8.sponsoree, snapshot.accounts.D2);
    assert.equal(snapshot.f8.create_hash, "002F5E3D285FADCEED03D8CFA602C73363539BFCB1190D30E56BA4F4E3BB8BE4");
    assert.equal(snapshot.f8.object_hash, "5D533E560251B575007355766B5FB74BEA1C9985674FA682BC8EEDCDA779BF1F");
    assert.equal(snapshot.f8.prior_sponsee, "rpxsXpi7UwaPUp7opKkMGHJY6GR7MzsR1m");
    assert.equal(snapshot.f9.vault_id, "B5B7DD0567486B7D93CDE961B86B4B4107FE674E7F4EAE7CFF09BA13D8189992");
    assert.equal(snapshot.f9.broker_id, "948E5B2D0662EA714E0D65AFE431DD4B8943D6D31307D75F45CADEFB90246D35");
    assert.equal(snapshot.f9.loan_id, "4D6442A307F3D8B01E0A690CE9ADF3BBA5AF5E6B2EBD728379DC52F06C5678C1");
    assert.equal(snapshot.f9.accounting, "cash-basis");
    assert.equal(snapshot.f9.asset, "XRP");
    assert.equal(snapshot.f9.repay_hash, "44DF969BC51E490A75CF443D3DD8829E1100C16447383568D3E794C49465A32B");
    assert.equal(snapshot.f10.issuance_id, "0056E2EDA3062D0A34565850A19B583AE92C7D07C8BECAF6");
    assert.equal(snapshot.f10.symbol, "DEVNET-CONF");
    assert.equal(snapshot.f10.sender, "rE7gSkX5HoWs9t2Tax6tYDbivRqbMxF4RX");
    assert.equal(snapshot.f10.payment_hash, "E54EA0BECDFE21BFC8220B633553098266F8B18FAD1CC19B8D8C4A0F57A1FCB5");
    assert.equal(snapshot.f10.clawback_hash, "FD2616CF6DFCBDACAAE4E2C2F5FC6A93FF08FEADA780B758B336AE0E3482A360");
    assert.notEqual(snapshot.f10.issuance_id, devnet.TESTNET_LABOR_ISSUANCE);
    assert.doesNotMatch(JSON.stringify(snapshot), /sEd|_SEED|ELGAMAL/);
  });

  it("leaves cards empty when the public files are blank and drops foreign networks", () => {
    const blank = [
      "| ID | Role | Address | Network | Funded |",
      "| D0 | treasury | _blank_ | XRPL Devnet | no |",
      "| D1 | depositor | | XRPL Devnet | no |",
      "| W0 | TREASURY | " + W0 + " | XRPL Testnet | yes |",
    ].join("\n");
    const ledger = [
      row({
        action: "devnet_sponsor",
        step: "create",
        network: "xrpl:0",
        network_id: 0,
        hash: "A".repeat(64),
        sponsor: D0,
      }),
      row({
        action: "devnet_vault",
        step: "loan",
        network: "xrpl:1",
        network_id: 1,
        object_id: "B".repeat(64),
        hash: "C".repeat(64),
      }),
      row({
        action: "devnet_confidential",
        step: "issue",
        mpt_issuance_id: devnet.TESTNET_LABOR_ISSUANCE,
        hash: "E".repeat(64),
      }),
      row({
        action: "devnet_vault",
        step: "loan",
        loan_id: "F".repeat(64),
        hash: "1".repeat(64),
        D0_SEED: "sEd" + "V".repeat(20),
      }),
    ].join("\n");
    const snapshot = devnet.publicSnapshot({
      walletsText: blank,
      ledgerText: ledger,
      labeled: [W0, D0],
    });
    assert.equal(snapshot.accounts.D0, null);
    assert.equal(snapshot.accounts.D1, null);
    assert.equal(snapshot.f8.create_hash, null);
    assert.equal(snapshot.f8.sponsor, null);
    assert.equal(snapshot.f9.loan_id, null);
    assert.equal(snapshot.f9.vault_id, null);
    assert.equal(snapshot.f10.issuance_id, null);
    assert.equal(JSON.stringify(snapshot).includes(W0), false);
    assert.equal(JSON.stringify(snapshot).includes("sEd"), false);
  });

  it("refuses a testnet house address pasted into a devnet wallet row", () => {
    const markdown = "| D0 | treasury | `" + W0 + "` | XRPL Devnet | yes |";
    const accounts = devnet.parseWallets(markdown, new Set([W0]));
    assert.equal(accounts.D0, null);
    const open = devnet.parseWallets("| D2 | sponsoree | `" + D0 + "` | XRPL Devnet | no |", new Set());
    assert.equal(open.D2, D0);
  });
});
