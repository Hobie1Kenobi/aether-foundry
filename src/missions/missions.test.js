"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("node:worker_threads");
const anchors = require("../director/anchors");
const config = require("./config");
const { chicagoDay } = require("./clock");
const { view, startMission, approve, observe, evaluate, kill, publicFeed, publicReplay } = require("./engine");
const { handlePublic } = require("./public");

const FOREIGN = "rQsPPdwiBeVDqsdDnFcVmu7xTVHMjXRFqN";
const TOKEN = "mission-internal-16";
const NOW = "2026-11-06T18:00:00.000Z";
const NOV5 = "2026-11-06T05:30:00.000Z";
const NOV6 = "2026-11-06T06:30:00.000Z";

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "missions-"));
}

function observation(accounts, extra) {
  return Object.assign(
    {
      network: "xrpl:1",
      network_id: 1,
      accounts,
      prompt: "do not keep this private chain of thought sEdTTTTTTTTTTTTTTTTTTTTTTTT",
    },
    extra || {}
  );
}

function foreignObs() {
  return observation([
    { address: anchors.WALLETS.W0.address },
    { address: FOREIGN },
    { address: "rFakeSynthetic111111111111111111", synthetic: true },
  ]);
}

function buy(key, now, extra) {
  return Object.assign(
    {
      idempotency_key: key,
      now,
      observation: foreignObs(),
      payment_drops: "1000000",
      network_fee_drops: "0",
      account_reserve_drops: "1000000",
    },
    extra || {}
  );
}

function allow() {
  return { allowlist: { payees: [FOREIGN] }, token: TOKEN };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

describe("mission caps and ledger", () => {
  it("uses the Chicago day and keeps authorized spend disabled", () => {
    assert.equal(config.SPENDING_ENABLED, false);
    assert.equal(config.SIGNING_ENABLED, false);
    assert.equal(config.PER_MISSION_DROPS, 1000000n);
    assert.equal(config.DAILY_DROPS, 5000000n);
    assert.equal(chicagoDay(NOV5), "2026-11-05");
    assert.equal(chicagoDay(NOV6), "2026-11-06");
  });

  it("blocks a book with no foreign seller and does not count house or synthetic revenue", () => {
    const root = dir();
    const house = startMission(
      root,
      {
        idempotency_key: "house-only-1",
        now: NOW,
        observation: observation([{ address: anchors.WALLETS.W3.address }, { address: FOREIGN, synthetic: true }]),
        payment_drops: "10",
      },
      allow()
    );
    assert.equal(house.mission.code, "no_foreign_seller");
    assert.equal(house.mission.labels.counterparty, "house");
    assert.equal(house.mission.foreign_revenue_drops, "0");
    assert.equal(view(root).days[chicagoDay(NOW)], undefined);
    assert.equal(fs.readFileSync(path.join(root, "events.jsonl"), "utf8").includes("chain of thought"), false);
  });

  it("reserves inside the cap, replays without a second hold, and survives a new handle", () => {
    const root = dir();
    const first = startMission(root, buy("cap-replay-1", NOW, { account_reserve_drops: "5000000" }), allow());
    assert.equal(first.mission.status, "awaiting_human_approval");
    assert.equal(first.mission.signed, false);
    assert.equal(first.mission.budget.budget_drops, "1000000");
    assert.equal(first.mission.budget.account_reserve_drops, "5000000");
    assert.equal(view(root).days[chicagoDay(NOW)].reserved, "1000000");
    const again = startMission(root, buy("cap-replay-1", NOW), allow());
    assert.equal(again.replay, true);
    assert.equal(again.mission.id, first.mission.id);
    const reloaded = view(root);
    assert.equal(reloaded.days[chicagoDay(NOW)].reserved, "1000000");
    assert.equal(reloaded.live_spend_drops, "0");
    assert.equal(reloaded.spending_enabled, false);
  });

  it("refuses a sixth mission, a restart does not clear the day, and the next Chicago day is a new window", () => {
    const root = dir();
    const lateNov5 = "2026-11-06T05:50:00.000Z";
    const earlyNov6 = "2026-11-06T06:05:00.000Z";
    for (let i = 0; i < 5; i += 1) {
      const row = startMission(root, buy(`fill-day-${i}0`, lateNov5, { payment_drops: "1000000", network_fee_drops: "0" }), allow());
      assert.equal(row.mission.status, "awaiting_human_approval");
    }
    const sixth = startMission(root, buy("fill-day-50", lateNov5), allow());
    assert.equal(sixth.mission.code, "CAP");
    assert.equal(view(root).days["2026-11-05"].reserved, "5000000");
    const restarted = view(root);
    assert.equal(restarted.days["2026-11-05"].reserved, "5000000");
    const next = startMission(root, buy("next-day-1", earlyNov6), allow());
    assert.equal(next.mission.status, "awaiting_human_approval");
    assert.equal(view(root).days["2026-11-05"].reserved, "5000000");
    assert.equal(view(root).days["2026-11-06"].reserved, "1000000");
  });

  it("counts fees and keeps an uncertain hold, and releases only the unsent part of a failed tx", () => {
    const root = dir();
    const row = startMission(
      root,
      buy("fee-fail-1", NOW, { payment_drops: "1000", network_fee_drops: "12", account_reserve_drops: "10000000" }),
      allow()
    );
    assert.equal(row.mission.budget.budget_drops, "1012");
    const failed = observe(root, {
      mission_id: row.mission.id,
      now: NOW,
      observe_key: "obs-fail-1",
      report: { validated: true, result: "tecUNFUNDED_PAYMENT", fee_drops: "12" },
    });
    assert.equal(failed.mission.status, "failure");
    assert.equal(failed.mission.fee_spent_drops, "12");
    const books = view(root).days[chicagoDay(NOW)];
    assert.equal(books.spent, "12");
    assert.equal(books.reserved, "0");
    assert.equal(books.released, "1000");
    throwsCode(
      () => observe(root, { mission_id: row.mission.id, now: NOW, observe_key: "obs-fail-2", report: {} }),
      "NO_RETRY"
    );

    const pending = startMission(root, buy("fee-unknown-1", NOW, { payment_drops: "50", network_fee_drops: "0" }), allow());
    const unknown = observe(root, { mission_id: pending.mission.id, now: NOW, observe_key: "obs-unknown", report: {} });
    assert.equal(unknown.mission.settlement, "uncertain");
    assert.equal(view(root).days[chicagoDay(NOW)].uncertain, "50");
    const later = new Date(new Date(NOW).getTime() + 2 * 60 * 60 * 1000).toISOString();
    startMission(root, buy("after-unknown", later, { payment_drops: "10", network_fee_drops: "0" }), allow());
    assert.equal(view(root).days[chicagoDay(NOW)].uncertain, "50");
  });

  it("separates bridge pending from destination final and does not retry either unknown state", () => {
    const root = dir();
    const hash = "AB".repeat(32);
    const pending = startMission(root, buy("bridge-pend", NOW, { payment_drops: "20", network_fee_drops: "0", bridge_gas_drops: "5", bridge_custody_drops: "10" }), allow());
    const held = observe(root, {
      mission_id: pending.mission.id,
      now: NOW,
      observe_key: "bridge-obs-1",
      report: { kind: "bridge", direction: "xrpl-to-evm", gmp: { status: "source_gateway_called" } },
    });
    assert.equal(held.mission.settlement, "bridge_pending");
    assert.equal(held.mission.live, false);
    throwsCode(() => observe(root, { mission_id: pending.mission.id, now: NOW, report: { kind: "bridge" } }), "NO_RETRY");

    const done = startMission(root, buy("bridge-final", NOW, { payment_drops: "20", network_fee_drops: "0" }), allow());
    const final = observe(root, {
      mission_id: done.mission.id,
      now: NOW,
      observe_key: "bridge-obs-2",
      report: {
        kind: "bridge",
        direction: "xrpl-to-evm",
        gmp: { status: "destination_executed", executed: { transactionHash: `0x${hash.toLowerCase()}` } },
        destination_proof: {
          network: "xrpl_evm_testnet",
          chain_id: "1449000",
          status: "success",
          tx_hash: `0x${hash.toLowerCase()}`,
        },
      },
    });
    assert.equal(final.mission.settlement, "dest_final");
    assert.equal(final.mission.live, false);
    assert.notEqual(final.mission.settlement, held.mission.settlement);
  });

  it("expires an unsubmitted hold and refuses non-XRP gas, mainnet, over-cap, and reserve-as-fee", () => {
    const root = dir();
    const opened = startMission(root, buy("expire-me", NOW, { payment_drops: "30", network_fee_drops: "0" }), allow());
    const later = new Date(new Date(NOW).getTime() + 31 * 60 * 1000).toISOString();
    const next = startMission(root, buy("after-expiry", later, { payment_drops: "30", network_fee_drops: "0" }), allow());
    assert.equal(next.mission.status, "awaiting_human_approval");
    assert.equal(view(root).missions[opened.mission.id].status, "expired");
    assert.equal(view(root).days[chicagoDay(NOW)].reserved, "30");

    const gas = startMission(root, buy("needs-evm-gas", NOW, { gas_value_wei: "1" }), allow());
    assert.equal(gas.mission.code, "NON_XRP");
    throwsCode(() => startMission(root, buy("mainnet-net", NOW, { observation: observation([{ address: FOREIGN }], { network: "xrpl:0" }) }), allow()), "MAINNET");
    const over = startMission(root, buy("over-one", NOW, { payment_drops: "1000001", network_fee_drops: "0" }), allow());
    assert.equal(over.mission.code, "CAP");
    const reserve = startMission(root, buy("reserve-fee", NOW, { account_reserve_as_fee: true }), allow());
    assert.equal(reserve.mission.code, "RESERVE");
  });

  it("requires human approval, then still refuses to sign, and publishes no invented revenue", () => {
    const root = dir();
    const row = startMission(root, buy("approve-1", NOW, { payment_drops: "40", network_fee_drops: "12" }), allow());
    throwsCode(() => approve(root, { mission_id: row.mission.id, token: "nope-token-value", now: NOW }, allow()), "AUTH");
    assert.equal(fs.readFileSync(path.join(root, "events.jsonl"), "utf8").includes("nope-token-value"), false);
    const approved = approve(root, { mission_id: row.mission.id, token: TOKEN, now: NOW }, allow());
    assert.equal(approved.mission.status, "spending_disabled");
    assert.equal(approved.mission.signed, false);
    assert.equal(approved.mission.submitted, false);
    const published = evaluate(root, {
      mission_id: row.mission.id,
      now: NOW,
      payload: { seller: FOREIGN, network: "xrpl:1" },
    });
    assert.equal(published.mission.artifact.seller, FOREIGN);
    assert.equal(published.mission.artifact.proof_hash, null);
    assert.equal(published.mission.explorer, null);
    assert.equal(published.mission.foreign_revenue_drops, "0");
    const other = startMission(root, buy("approve-2", NOW, { payment_drops: "10", network_fee_drops: "0" }), allow());
    approve(root, { mission_id: other.mission.id, token: TOKEN, now: NOW }, allow());
    const rejected = evaluate(root, {
      mission_id: other.mission.id,
      now: NOW,
      payload: { seller: anchors.WALLETS.W0.address, network: "xrpl:1" },
    });
    assert.equal(rejected.mission.code, "payload_rejected");
    const feed = publicFeed(root);
    assert.equal(feed.spending_enabled, false);
    assert.equal(feed.live_spend_drops, "0");
    assert.equal(feed.authorized_per_mission_drops, "1000000");
    assert.equal(feed.authorized_daily_drops, "5000000");
    assert.equal(JSON.stringify(feed).includes("hidden"), false);
    assert.equal(JSON.stringify(publicReplay(root, row.mission.id)).includes("hidden"), false);
  });

  it("records a hard stop and denies the next mission", () => {
    const root = dir();
    assert.equal(kill(root, { token: TOKEN, now: NOW }, allow()).killed, true);
    const stopped = startMission(root, buy("after-kill", NOW, { payment_drops: "10", network_fee_drops: "0" }), allow());
    assert.equal(stopped.mission.code, "killed");
    assert.equal(view(root).days[chicagoDay(NOW)], undefined);
  });

  it("serializes concurrent reservations so the daily cap cannot be passed", async () => {
    const root = dir();
    const enginePath = require.resolve("./engine");
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(
        (index) =>
          new Promise((resolve, reject) => {
            const worker = new Worker(
              `
                const { startMission } = require(${JSON.stringify(enginePath)});
                const { parentPort, workerData } = require("node:worker_threads");
                const anchors = require(${JSON.stringify(require.resolve("../director/anchors"))});
                const input = {
                  idempotency_key: "race-key-" + workerData.index,
                  now: ${JSON.stringify(NOW)},
                  observation: { network: "xrpl:1", network_id: 1, accounts: [{ address: ${JSON.stringify(FOREIGN)} }] },
                  payment_drops: "1000000",
                  network_fee_drops: "0",
                };
                try {
                  const result = startMission(workerData.dir, input, { allowlist: { payees: [${JSON.stringify(FOREIGN)}] } });
                  parentPort.postMessage({ code: result.mission.code, status: result.mission.status });
                } catch (error) {
                  parentPort.postMessage({ code: error.code || "ERROR" });
                }
              `,
              { eval: true, workerData: { dir: root, index } }
            );
            worker.on("message", resolve);
            worker.on("error", reject);
          })
      )
    );
    const reserved = results.filter((row) => row.status === "awaiting_human_approval");
    const capped = results.filter((row) => row.code === "CAP");
    assert.equal(reserved.length, 5);
    assert.equal(capped.length, 1);
    assert.equal(view(root).days[chicagoDay(NOW)].reserved, "5000000");
  });
});

describe("public mission interface", () => {
  it("is read-only even when a bearer and a command are presented", () => {
    const root = dir();
    startMission(root, buy("public-1", NOW, { payment_drops: "15", network_fee_drops: "0" }), allow());
    const denied = handlePublic({ method: "POST", route: "feed", authorization: `Bearer ${TOKEN}`, command: "kill" }, root);
    assert.equal(denied.status, 405);
    assert.equal(denied.body.code, "PUBLIC_WRITE");
    assert.equal(JSON.stringify(denied.body).includes(TOKEN), false);
    const feed = handlePublic({ method: "GET", route: "feed" }, root);
    assert.equal(feed.status, 200);
    assert.equal(feed.body.live_spend_drops, "0");
    assert.equal(feed.body.spending_enabled, false);
    const status = handlePublic({ method: "GET", route: "status", served_at: NOW }, root);
    assert.equal(status.body.source, "ledger");
    assert.ok(status.body.source_observed_at);
    const missing = handlePublic({ method: "GET", route: "status" }, dir());
    assert.equal(missing.body.source, "unavailable");
    assert.equal(missing.body.source_observed_at, null);
  });
});
