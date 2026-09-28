"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const anchors = require("./anchors");
const schema = require("./schema");
const snapshot = require("./snapshot");
const wake = require("./wake");
const clock = require("./clock");
const walkIn = require("../walk-in-public");

const ROOT = anchors.repoRoot();
const GOLDEN = path.join(__dirname, "fixtures", "director-state.golden.json");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "director-state-"));
  return path.join(dir, "director-state.json");
}

function jsonResponse(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { result };
    },
  };
}

function accountInfo(address, fields = {}) {
  return {
    validated: true,
    ledger_index: fields.ledger_index || 21109999,
    status: "success",
    account_data: Object.assign(
      {
        Account: address,
        Balance: fields.balance || "50000000",
        OwnerCount: fields.owner_count == null ? 0 : fields.owner_count,
        Sequence: fields.sequence || 11,
        Flags: 0,
      },
      fields.regular_key ? { RegularKey: fields.regular_key } : {},
      fields.extra || {}
    ),
    account_flags: { disableMasterKey: false },
  };
}

function mockFetch(mutate) {
  const board = anchors.loadActivated(ROOT);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") {
      return { ok: true, status: 200, url };
    }
    const body = JSON.parse(init.body);
    const method = body.method;
    const params = body.params[0] || {};
    if (method === "server_info") {
      const networkId = String(url).includes("xahau") ? 21338 : 1;
      const build = networkId === 21338 ? "2026.6.21-release+3350" : "3.4.1";
      return jsonResponse({ info: { network_id: networkId, build_version: build } });
    }
    if (method === "server_state") {
      const seq = String(url).includes("xahau") ? 12699999 : 21109999;
      return jsonResponse({
        state: { validated_ledger: { seq, reserve_base: 1000000, reserve_inc: 200000 } },
      });
    }
    if (method === "feature") {
      return jsonResponse({
        features: {
          "9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377": {
            name: "BatchV1_1",
            enabled: false,
            supported: true,
          },
          "14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944": {
            name: "fixBatchV1_2",
            enabled: false,
            supported: true,
          },
          "955DF3FA5891195A9DAEFA1DDC6BB244B545DDE1BAA84CBB25D5F12A8DA68A0C": {
            name: "TicketBatch",
            enabled: true,
            supported: true,
          },
        },
      });
    }
    if (method === "account_info") {
      const regular = board.regular_keys.find((row) => row.account === params.account);
      return jsonResponse(
        accountInfo(params.account, {
          ledger_index: String(url).includes("xahau") ? 12699999 : 21109999,
          balance: params.account === anchors.WALLETS.W7.address ? "1000000000" : "50000000",
          owner_count: params.account === anchors.WALLETS.W7.address ? 1 : 0,
          regular_key: regular ? regular.regular_key : null,
        })
      );
    }
    if (method === "account_objects" && params.type === "signer_list") {
      return jsonResponse({
        validated: true,
        ledger_index: 21109999,
        status: "success",
        account_objects: [
          {
            LedgerEntryType: "SignerList",
            SignerQuorum: board.quorum,
            PreviousTxnID: "EDD27C458D314602E6059D8351D2DDA322A5E4BD1FD55602B3D2E667EA970299",
            SignerEntries: board.signers.map((row) => ({
              SignerEntry: { Account: row.address, SignerWeight: row.weight },
            })),
          },
        ],
      });
    }
    if (method === "account_objects" && params.type === "nft_offer") {
      return jsonResponse({
        validated: true,
        ledger_index: 21109999,
        status: "success",
        account_objects: [
          {
            index: walkIn.KNOWN_OFFER_ID,
            NFTokenID: walkIn.KNOWN_NFTOKEN_ID,
            Flags: 1,
            Amount: walkIn.AMOUNT_DROPS,
            Owner: walkIn.W2,
          },
        ],
      });
    }
    if (method === "account_objects" && params.type === "hook") {
      return jsonResponse({
        validated: true,
        ledger_index: 12699999,
        status: "success",
        account_objects: [
          {
            LedgerEntryType: "Hook",
            index: "C3ABA1460EF3339BFBC4CE25E963ABCF016DD16F71153263FB7989105666B629",
            PreviousTxnID: "7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447",
            Hooks: [{ Hook: { HookHash: anchors.PACK_HOOK_HASH } }],
          },
        ],
      });
    }
    if (method === "amm_info") {
      return jsonResponse({
        validated: true,
        ledger_index: 21109999,
        status: "success",
        amm: {
          account: anchors.AMM,
          amount: { currency: anchors.AETH_HEX, issuer: anchors.WALLETS.W0.address, value: "10.5" },
          amount2: "20000000",
          lp_token: { currency: "0330E60FAE706EAD2C7D511D790B07A6F3B89931" },
          trading_fee: 500,
        },
      });
    }
    if (method === "gateway_balances") {
      return jsonResponse({
        validated: true,
        ledger_index: 21109999,
        status: "success",
        obligations: { [anchors.AETH_HEX]: "10100" },
      });
    }
    throw new Error(`unexpected rpc ${method} ${params.type || ""}`);
  };
  fetchImpl.calls = calls;
  if (mutate) mutate(fetchImpl);
  return fetchImpl;
}

function writeChecked(file, state) {
  snapshot.writeState(file, state, ROOT);
}

describe("director anchors", () => {
  it("formats America/Chicago with a numeric offset", () => {
    assert.equal(anchors.formatChicago(new Date("2026-09-27T21:33:00Z")), "2026-09-27T16:33:00-05:00");
  });

  it("matches W0–W7 in corp/wallets.md and refuses mainnet hosts", () => {
    const text = fs.readFileSync(path.join(ROOT, "corp", "wallets.md"), "utf8");
    const found = {};
    for (const match of text.matchAll(/^\| (W[0-7]) \| ([^|]+?) \| (r[1-9A-HJ-NP-Za-km-z]{24,34}) \|/gm)) {
      found[match[1]] = match[3];
    }
    for (const id of anchors.WALLET_IDS) {
      assert.equal(found[id], anchors.WALLETS[id].address);
    }
    assert.equal(anchors.WALLETS.W2.address, walkIn.W2);
    assert.throws(() => anchors.assertXrplTestnetUrl("https://s1.ripple.com:51234"), /mainnet/);
    assert.throws(() => anchors.assertXrplTestnetUrl("https://xrplcluster.com"), /mainnet|non-testnet|refusing/);
    assert.throws(() => anchors.assertXahauTestnetUrl("https://xahau.network"), /Xahau/);
    assert.throws(() => anchors.assertNetworkId(0, 1), /mainnet network id 0/);
    assert.throws(() => anchors.assertNetworkId(21337, 21338), /21337/);
    const board = anchors.loadActivated(ROOT);
    assert.equal(JSON.stringify(board).includes("SEED"), false);
    assert.equal(board.quorum, 3);
    assert.equal(board.signers.length, 4);
  });

  it("points machine hashes at text that is already in the pack", () => {
    for (const row of anchors.MACHINES) {
      const text = fs.readFileSync(path.join(ROOT, row.results), "utf8");
      if (row.last_result_hash) assert.equal(text.includes(row.last_result_hash), true, row.slug);
      else assert.equal(fs.existsSync(path.join(ROOT, row.results)), true);
    }
  });
});

describe("director schema", () => {
  it("locks the golden fixture", () => {
    const raw = fs.readFileSync(GOLDEN, "utf8");
    assert.equal(raw, `${JSON.stringify(schema.fixtureState(), null, 2)}\n`);
    const state = schema.validateState(JSON.parse(raw), { root: ROOT });
    assert.equal(state.source, "fixture");
    assert.equal(state.next_actions.length, 3);
    assert.equal(state.wallets.W0.address, anchors.WALLETS.W0.address);
    assert.equal(state.watched.w0_signer_list.quorum, 3);
    assert.equal(state.watched.batch.atomic_enabled, false);
    assert.equal(JSON.stringify(state).includes("sEd"), false);
  });

  it("refuses seeds, secret keys, and mainnet hosts", () => {
    const state = schema.fixtureState();
    assert.throws(() => schema.assertNoSecrets({ seed: "not-a-real-secret" }), /secret field/);
    assert.throws(() => schema.validateState(Object.assign({}, state, { seed_env: "W0_SEED" })), /secret field/);
    const seeded = schema.fixtureState();
    seeded.blockers = [`sEd${"V".repeat(28)}`];
    assert.throws(() => schema.validateState(seeded), /seed-shaped/);
    const mainnet = schema.fixtureState();
    mainnet.networks.xrpl_testnet.http = "https://s1.ripple.com:51234";
    assert.throws(() => schema.validateState(mainnet), /mainnet/);
    const ident = schema.fixtureState();
    ident.networks.xrpl_testnet.network_id = 0;
    assert.throws(() => schema.validateState(ident), /network id 0/);
    const xahauMain = schema.fixtureState();
    xahauMain.networks.xahau_testnet.network_id = 21337;
    assert.throws(() => schema.validateState(xahauMain), /21337/);
  });

  it("refuses an invented trial hash and a sold-out offer id", () => {
    const invented = schema.fixtureState();
    invented.machines["batch-heartbeat"].last_result_hash = "A".repeat(64);
    assert.throws(() => schema.validateState(invented), /must not invent/);
    const sold = schema.fixtureState();
    sold.watched.walk_in_offer.status = "sold_out";
    sold.watched.walk_in_offer.offer_count = 0;
    assert.throws(() => schema.validateState(sold), /sold_out walk-in must not invent/);
  });

  it("preserves the continuation card and replaces the ledger", () => {
    const previous = schema.fixtureState();
    previous.next_actions = ["alpha", "beta", "gamma"];
    previous.blockers = ["founder must run remint on the box"];
    previous.last_session_id = "2026-09-27-8";
    const fresh = schema.fixtureState();
    fresh.networks.xrpl_testnet.validated_ledger_index = 21109999;
    fresh.next_actions = ["nope", "nope", "nope"];
    fresh.blockers = [];
    fresh.last_session_id = null;
    const merged = schema.mergePreserved(previous, fresh);
    assert.deepEqual(merged.next_actions, ["alpha", "beta", "gamma"]);
    assert.deepEqual(merged.blockers, ["founder must run remint on the box"]);
    assert.equal(merged.last_session_id, "2026-09-27-8");
    assert.equal(merged.networks.xrpl_testnet.validated_ledger_index, 21109999);
    const broken = schema.fixtureState();
    broken.next_actions = ["only one", "only two"];
    assert.throws(() => schema.mergePreserved(broken, fresh), /next_actions/);
  });
});

describe("director snapshot", () => {
  it("does not load xrpl, xahau, dotenv, or a secrets file", () => {
    const files = ["anchors.js", "schema.js", "snapshot.js", "wake.js", "clock.js"];
    const banned = [/require\(["']xrpl["']\)/, /require\(["']xahau["']\)/, /require\(["']dotenv["']\)/, /aether-foundry-secrets/, /fromSeed/, /Wallet\.sign/];
    for (const file of files) {
      const text = fs.readFileSync(path.join(__dirname, file), "utf8");
      for (const pattern of banned) assert.doesNotMatch(text, pattern, file);
    }
  });

  it("writes a validated snapshot from mocked RPC and keeps the card", async () => {
    const file = tempFile();
    const previous = schema.fixtureState();
    previous.next_actions = ["keep-a", "keep-b", "keep-c"];
    previous.blockers = ["founder blocker stays"];
    previous.last_session_id = "session-keep";
    writeChecked(file, previous);
    const code = await snapshot.run(["node", "snapshot", "--root", ROOT, "--state", file], {
      fetchImpl: mockFetch(),
      now: new Date("2026-09-27T21:33:00Z"),
      silent: true,
    });
    assert.equal(code, 0);
    const written = schema.validateState(JSON.parse(fs.readFileSync(file, "utf8")), { root: ROOT });
    assert.equal(written.source, "director:snapshot");
    assert.equal(written.updated_at, "2026-09-27T16:33:00-05:00");
    assert.equal(written.networks.xrpl_testnet.validated_ledger_index, 21109999);
    assert.equal(written.networks.xahau_testnet.validated_ledger_index, 12699999);
    assert.equal(written.networks.xrpl_testnet.network_id, 1);
    assert.equal(written.networks.xahau_testnet.network_id, 21338);
    assert.equal(written.watched.walk_in_offer.status, "open");
    assert.equal(written.watched.walk_in_offer.offer_id, walkIn.KNOWN_OFFER_ID);
    assert.equal(written.watched.w0_signer_list.matches_h1, true);
    assert.equal(written.watched.w0_signer_list.master_disabled, false);
    assert.equal(written.watched.regular_keys.matches_pack, true);
    assert.equal(written.watched.batch.atomic_enabled, false);
    assert.equal(written.watched.w7_hook.matches_pack, true);
    assert.deepEqual(written.next_actions, ["keep-a", "keep-b", "keep-c"]);
    assert.deepEqual(written.blockers, ["founder blocker stays"]);
    assert.equal(written.last_session_id, "session-keep");
    assert.equal(JSON.stringify(written).includes("SEED"), false);
  });

  it("does not write when Batch amendments or the network id are missing or mainnet", async () => {
    const missing = tempFile();
    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", missing], {
          fetchImpl: async (url, init) => {
            const base = mockFetch();
            if (init.method === "POST" && JSON.parse(init.body).method === "feature") {
              return jsonResponse({ features: {} });
            }
            return base(url, init);
          },
          silent: true,
        }),
      /BatchV1/
    );
    assert.equal(fs.existsSync(missing), false);

    const mainnet = tempFile();
    let called = 0;
    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", mainnet, "--xrpl-http", "https://s1.ripple.com:51234"], {
          fetchImpl: async () => {
            called += 1;
            return jsonResponse({});
          },
          silent: true,
        }),
      /mainnet|refusing/
    );
    assert.equal(called, 0);
    assert.equal(fs.existsSync(mainnet), false);

    const wrongId = tempFile();
    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", wrongId], {
          fetchImpl: async (url, init) => {
            const base = mockFetch();
            if (init.method === "POST" && JSON.parse(init.body).method === "server_info" && !String(url).includes("xahau")) {
              return jsonResponse({ info: { network_id: 0, build_version: "3.4.1" } });
            }
            return base(url, init);
          },
          silent: true,
        }),
      /network id 0/
    );
    assert.equal(fs.existsSync(wrongId), false);
  });

  it("refuses a seed field on account_info and leaves the file unwritten", async () => {
    const file = tempFile();
    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", file], {
          fetchImpl: async (url, init) => {
            const base = mockFetch();
            const response = await base(url, init);
            if (init.method === "POST" && JSON.parse(init.body).method === "account_info") {
              const result = await response.json();
              result.result.account_data.Seed = `sEd${"V".repeat(28)}`;
              return {
                ok: true,
                status: 200,
                async json() {
                  return result;
                },
              };
            }
            return response;
          },
          silent: true,
        }),
      /secret field|seed-shaped/
    );
    assert.equal(fs.existsSync(file), false);
  });

  it("refuses to invent validated_ledger_index when RPC fails and keeps the card", async () => {
    const file = tempFile();
    const previous = schema.fixtureState();
    previous.next_actions = ["keep-a", "keep-b", "keep-c"];
    previous.blockers = ["founder blocker stays"];
    previous.last_session_id = "session-keep";
    previous.networks.xrpl_testnet.validated_ledger_index = 21102567;
    writeChecked(file, previous);

    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", file], {
          fetchImpl: async () => {
            throw new Error("socket hang up");
          },
          silent: true,
        }),
      /failed/
    );
    const afterTransport = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(afterTransport.networks.xrpl_testnet.validated_ledger_index, 21102567);
    assert.deepEqual(afterTransport.next_actions, ["keep-a", "keep-b", "keep-c"]);
    assert.deepEqual(afterTransport.blockers, ["founder blocker stays"]);
    assert.equal(afterTransport.last_session_id, "session-keep");

    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", file], {
          fetchImpl: async (url, init) => {
            const base = mockFetch();
            if (init && init.method === "POST" && JSON.parse(init.body).method === "server_state" && !String(url).includes("xahau")) {
              return jsonResponse({ state: {} });
            }
            return base(url, init);
          },
          silent: true,
        }),
      /validated_ledger/
    );
    const afterOmitted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(afterOmitted.networks.xrpl_testnet.validated_ledger_index, 21102567);
    assert.equal(afterOmitted.networks.xahau_testnet.validated_ledger_index, previous.networks.xahau_testnet.validated_ledger_index);
    assert.deepEqual(afterOmitted.next_actions, ["keep-a", "keep-b", "keep-c"]);
    assert.deepEqual(afterOmitted.blockers, ["founder blocker stays"]);
    assert.equal(afterOmitted.last_session_id, "session-keep");

    const missing = tempFile();
    await assert.rejects(
      () =>
        snapshot.run(["node", "snapshot", "--root", ROOT, "--state", missing], {
          fetchImpl: async () => {
            throw new Error("socket hang up");
          },
          silent: true,
        }),
      /failed/
    );
    assert.equal(fs.existsSync(missing), false);
  });
});

describe("director wake", () => {
  it("prints a continuation card and exits 0 on a fresh green file", () => {
    const file = tempFile();
    const state = schema.fixtureState();
    state.source = "director:snapshot";
    state.updated_at = anchors.formatChicago(new Date());
    writeChecked(file, state);
    const result = wake.run(["node", "wake", "--state", file, "--check", "--quiet"], { silent: true });
    assert.equal(result.code, 0);
    assert.equal(result.card.check.ok, true);
    assert.match(result.text, /CONTINUATION CARD/);
    assert.equal(result.card.next_actions.length, 3);
    assert.equal(result.card.networks.xrpl_testnet.network_id, 1);
    assert.equal(result.card.networks.xahau_testnet.network_id, 21338);
  });

  it("alerts per routine without paging the others", () => {
    const file = tempFile();
    const state = schema.fixtureState();
    state.source = "director:snapshot";
    state.updated_at = anchors.formatChicago(new Date());
    state.watched.walk_in_offer = {
      account: anchors.WALLETS.W2.address,
      status: "sold_out",
      offer_id: null,
      nftoken_id: null,
      amount_drops: null,
      offer_count: 0,
      pack_offer_id: walkIn.KNOWN_OFFER_ID,
      ledger_index: state.watched.walk_in_offer.ledger_index,
    };
    state.machines["walk-in-window"].status = "sold_out";
    state.probes.desk.http_status = 503;
    writeChecked(file, state);
    const morning = wake.run(["node", "wake", "--state", file, "--check", "--routine", "morning-health"], { silent: true });
    assert.equal(morning.code, 2);
    assert.ok(morning.card.check.alerts.some((item) => item.code === "desk"));
    assert.equal(morning.card.check.alerts.some((item) => item.code === "walk_in_sold_out"), false);
    const shop = wake.run(["node", "wake", "--state", file, "--check", "--routine", "walk-in-remint"], { silent: true });
    assert.equal(shop.code, 2);
    assert.deepEqual(shop.card.check.alerts.map((item) => item.code), ["walk_in_sold_out"]);
    const batch = wake.run(["node", "wake", "--state", file, "--check", "--routine", "batch-probe"], { silent: true });
    assert.equal(batch.code, 0);

    state.probes.desk.http_status = 200;
    state.watched.batch.amendments = state.watched.batch.amendments.map((row) =>
      row.name === "BatchV1_1" ? Object.assign({}, row, { enabled: true }) : row
    );
    state.watched.batch.atomic_enabled = true;
    state.watched.walk_in_offer = schema.fixtureState().watched.walk_in_offer;
    state.machines["walk-in-window"].status = "open";
    writeChecked(file, state);
    const flipped = wake.run(["node", "wake", "--state", file, "--check", "--routine", "batch-probe"], { silent: true });
    assert.equal(flipped.code, 2);
    assert.equal(flipped.card.check.alerts[0].code, "batch_enabled");
    const nav = wake.run(["node", "wake", "--state", file, "--check", "--routine", "weekly-nav"], { silent: true });
    assert.equal(nav.code, 0);
  });

  it("exits 2 from the CLI when the check is stale", () => {
    const file = tempFile();
    const state = schema.fixtureState();
    state.updated_at = "2020-01-01T00:00:00-06:00";
    writeChecked(file, state);
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "wake.js"), "--state", file, "--check", "--quiet", "--routine", "batch-probe"],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /stale/);
    assert.equal(result.stdout, "");
  });
});

describe("director clock", () => {
  it("names routines from the UTC schedules and does not sign", () => {
    const mondayMorning = new Date("2026-09-28T13:56:00Z");
    const tuesdayMorning = new Date("2026-09-29T13:56:00Z");
    const mondayBatch = new Date("2026-09-28T17:56:00Z");
    const tuesdayAfternoon = new Date("2026-09-29T17:56:00Z");
    const freshness = new Date("2026-09-28T14:30:00Z");
    assert.deepEqual(
      clock.resolveRoutines({ schedule: "56 13 * * 1-5", now: mondayMorning }).map((row) => row.name),
      ["morning-health", "weekly-nav"]
    );
    assert.deepEqual(
      clock.resolveRoutines({ schedule: "56 13 * * 1", now: mondayMorning }).map((row) => row.name),
      ["weekly-nav", "morning-health"]
    );
    assert.deepEqual(
      clock.resolveRoutines({ schedule: "56 13 * * 1-5", now: tuesdayMorning }).map((row) => row.name),
      ["morning-health"]
    );
    assert.deepEqual(
      clock.resolveRoutines({ schedule: "56 17 * * 1,3,5", now: mondayBatch }).map((row) => row.name),
      ["batch-probe"]
    );
    assert.equal(clock.cronMatches("30 * * * *", freshness), true);
    assert.equal(clock.cronMatches("56 17 * * 1,3,5", tuesdayAfternoon), false);
    assert.equal(clock.cronMatches("56 13 * * 1-5", new Date("2026-10-03T13:56:00Z")), false);
    const dispatched = clock.resolveRoutines({
      eventName: "workflow_dispatch",
      routineInput: "batch-probe",
      now: mondayMorning,
    });
    assert.deepEqual(dispatched.map((row) => row.name), ["batch-probe"]);
    assert.deepEqual(clock.wakeArgv(dispatched[0]), ["--check", "--quiet", "--routine", "batch-probe"]);
    assert.deepEqual(clock.wakeArgv(clock.SCHEDULES[0]), ["--check", "--quiet"]);
    assert.throws(() => clock.resolveRoutines({ eventName: "workflow_dispatch", routineInput: "walk-in-remint" }), /unknown routine/);
    assert.throws(() => clock.resolveRoutines({ now: tuesdayAfternoon }), /no director routine/);
  });

  it("merges wake exits and fails the job on alert without a commit ledger guess", () => {
    assert.equal(clock.mergeExit(0, 0), 0);
    assert.equal(clock.mergeExit(0, 2), 2);
    assert.equal(clock.mergeExit(2, 0), 2);
    assert.equal(clock.mergeExit(2, 1), 1);
    assert.throws(() => clock.requireWakeCode(2), /refusing to sign or remint/);
    assert.throws(() => clock.requireWakeCode(1), /wake fatal/);
    assert.throws(() => clock.requireWakeCode(""), /wake exit missing/);
    assert.equal(clock.requireWakeCode(0), 0);
    assert.equal(clock.requireWakeCode("0"), 0);
    const state = schema.fixtureState();
    assert.equal(clock.commitMessage(state), `chore(director): snapshot ${state.networks.xrpl_testnet.validated_ledger_index}`);
    const blank = schema.fixtureState();
    delete blank.networks.xrpl_testnet.validated_ledger_index;
    assert.throws(() => clock.commitMessage(blank), /validated_ledger_index/);
    blank.networks.xrpl_testnet.validated_ledger_index = 0;
    assert.throws(() => clock.commitMessage(blank), /validated_ledger_index/);
    const alert = spawnSync(process.execPath, [path.join(__dirname, "clock.js"), "--require-wake-code", "2"], { encoding: "utf8" });
    assert.equal(alert.status, 2);
    assert.match(alert.stderr, /exit 2/);
    const quiet = spawnSync(process.execPath, [path.join(__dirname, "clock.js"), "--merge-exit", "0", "2"], { encoding: "utf8" });
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout.trim(), "2");
  });

  it("refuses seed env, runtime:live, and mainnet hosts in the workflow", () => {
    const yml = fs.readFileSync(path.join(ROOT, clock.WORKFLOW_REL), "utf8");
    clock.assertWorkflow(yml);
    assert.equal(yml.includes("runtime:live"), false);
    assert.equal(yml.includes("runtime:watch"), false);
    assert.doesNotMatch(yml, /_SEED/);
    assert.doesNotMatch(yml, /secrets\./);
    assert.throws(() => clock.assertWorkflow(`${yml}\nrun: npm run runtime:live\n`), /runtime:live/);
    assert.throws(() => clock.assertWorkflow(yml.replace("npm test", "npm test\nhttps://s1.ripple.com:51234")), /ripple\.com/);
    assert.throws(() => clock.assertActionsEnv({ GITHUB_ACTIONS: "true", W2_REGULAR_SEED: "present" }), /seed env/);
    assert.throws(() => clock.assertActionsEnv({ FOUNDRY_DAEMON_LIVE: "yes" }), /FOUNDRY_DAEMON_LIVE/);
    const gated = spawnSync(
      process.execPath,
      [path.join(__dirname, "clock.js"), "--assert-workflow"],
      { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", W6_REGULAR_SEED: "present" } }
    );
    assert.equal(gated.status, 1);
    assert.match(gated.stderr, /seed env/);
    assert.doesNotMatch(gated.stderr, /present/);
    const text = fs.readFileSync(path.join(__dirname, "clock.js"), "utf8");
    assert.doesNotMatch(text, /require\(["']xrpl["']\)/);
    assert.doesNotMatch(text, /Wallet/);
    assert.equal(fs.existsSync(path.join(ROOT, "lab", "weekly", ".gitkeep")), true);
  });
});

describe("director contract docs", () => {
  it("names every routine field in DIRECTOR_WAKE.md", () => {
    const doc = fs.readFileSync(path.join(ROOT, "lab", "DIRECTOR_WAKE.md"), "utf8");
    for (const [routine, fields] of Object.entries(wake.ROUTINE_READS)) {
      assert.equal(doc.includes(routine), true, routine);
      for (const field of fields) assert.equal(doc.includes(field), true, field);
    }
    assert.match(doc, /next_actions/);
    assert.match(doc, /blockers/);
    assert.match(doc, /last_session_id/);
  });
});

describe("committed director state", () => {
  it("is a live snapshot with public anchors and no seeds", () => {
    const file = path.join(ROOT, "lab", "director-state.json");
    const state = schema.validateState(JSON.parse(fs.readFileSync(file, "utf8")), { root: ROOT });
    assert.equal(state.source, "director:snapshot");
    assert.equal(state.networks.xrpl_testnet.http, anchors.XRPL_HTTP);
    assert.equal(state.networks.xahau_testnet.http, anchors.XAHAU_HTTP);
    assert.equal(state.networks.xrpl_testnet.network_id, 1);
    assert.equal(state.networks.xahau_testnet.network_id, 21338);
    assert.ok(state.networks.xrpl_testnet.validated_ledger_index > 21000000);
    assert.ok(state.networks.xahau_testnet.validated_ledger_index > 1);
    assert.equal(state.wallets.W7.address, anchors.WALLETS.W7.address);
    assert.equal(state.next_actions.length, 3);
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /sEd[1-9A-HJ-NP-Za-km-z]{10,}/);
    assert.doesNotMatch(text, /"(seed|secret|private_key|seed_env)"/i);
  });
});
