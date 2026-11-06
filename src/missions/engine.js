"use strict";

const crypto = require("crypto");
const anchors = require("../director/anchors");
const config = require("./config");
const { chicagoDay } = require("./clock");
const { exclusive, readEvents, coded } = require("./ledger");
const policy = require("./policy");
const { assertPublic } = require("./redact");
const axelarStatus = require("../bridge/axelar/status");

const OPEN_HOLDS = new Set(["awaiting_human_approval", "spending_disabled"]);
const NO_RELEASE = new Set(["uncertain", "bridge_pending"]);

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function missionId(key) {
  return `msn${sha(key).slice(0, 16)}`;
}

function blankDay() {
  return { reserved: "0", spent: "0", uncertain: "0", released: "0" };
}

function emptyState() {
  return {
    missions: {},
    days: {},
    killed: false,
    spending_enabled: false,
    denials: [],
    live_spent: 0n,
    live_uncertain: 0n,
    missionCommitted: {},
    classes: [],
  };
}

function add(bucket, field, amount) {
  bucket[field] = (BigInt(bucket[field]) + amount).toString();
}

function sub(bucket, field, amount) {
  const next = BigInt(bucket[field]) - amount;
  bucket[field] = (next < 0n ? 0n : next).toString();
}

function dayBucket(state, day) {
  if (!state.days[day]) state.days[day] = blankDay();
  return state.days[day];
}

function applyReserve(state, event) {
  const amount = BigInt(event.budget_drops);
  const day = dayBucket(state, event.day);
  add(day, "reserved", amount);
  const prior = BigInt(state.missionCommitted[event.mission_id] || "0");
  state.missionCommitted[event.mission_id] = (prior + amount).toString();
  const mission = state.missions[event.mission_id];
  if (!mission) return;
  mission.budget = event.components;
  mission.day = event.day;
  mission.hold = "unsubmitted";
}

function releaseHold(state, mission, reason, now) {
  if (!mission.budget || mission.hold === "released" || NO_RELEASE.has(mission.settlement)) return null;
  const amount = BigInt(mission.budget.budget_drops);
  const day = dayBucket(state, mission.day);
  sub(day, "reserved", amount);
  add(day, "released", amount);
  mission.hold = "released";
  mission.status = reason === "expiry" ? "expired" : mission.status;
  return {
    type: "budget.released",
    mission_id: mission.id,
    day: mission.day,
    drops: amount.toString(),
    reason,
    at: now,
    live: false,
  };
}

function fold(events) {
  const state = emptyState();
  for (const event of events) {
    if (!event || event.counted === false) continue;
    if (event.type === "control.kill") {
      state.killed = true;
      state.spending_enabled = false;
    }
    if (event.type === "control.clear_kill") state.killed = false;
    if (event.type === "control.activate" && !state.killed) {
      const per = BigInt(event.per_mission_drops || "0");
      const daily = BigInt(event.daily_drops || "0");
      if (per === config.PER_MISSION_DROPS && daily === config.DAILY_DROPS) {
        state.spending_enabled = true;
        state.classes = Array.isArray(event.classes) ? event.classes.filter((name) => name === config.AUTONOMOUS_CLASS) : [];
      }
    }
    if (event.type === "control.deactivate") {
      state.spending_enabled = false;
      state.classes = [];
    }
    if (event.type === "control.denial") state.denials.push(event);
    if (event.type === "mission.upsert") {
      state.missions[event.mission.id] = event.mission;
    }
    if (event.type === "budget.reserved") applyReserve(state, event);
    if (event.type === "budget.released") {
      const mission = state.missions[event.mission_id];
      if (mission && mission.hold !== "released") {
        const day = dayBucket(state, event.day);
        sub(day, "reserved", BigInt(event.drops));
        add(day, "released", BigInt(event.drops));
        mission.hold = "released";
      }
    }
    if (event.type === "budget.spent") {
      const day = dayBucket(state, event.day);
      const amount = BigInt(event.drops);
      sub(day, "reserved", amount);
      add(day, "spent", amount);
      if (event.live === true) state.live_spent += amount;
      const mission = state.missions[event.mission_id];
      if (mission) mission.hold = "spent";
    }
    if (event.type === "budget.fee_spent") {
      const day = dayBucket(state, event.day);
      const fee = BigInt(event.drops);
      sub(day, "reserved", fee);
      add(day, "spent", fee);
      if (event.live === true) state.live_spent += fee;
      const mission = state.missions[event.mission_id];
      if (mission) mission.fee_spent_drops = event.drops;
    }
    if (event.type === "budget.fee_narrowed") {
      const day = dayBucket(state, event.day);
      const amount = BigInt(event.drops || "0");
      sub(day, "reserved", amount);
      add(day, "released", amount);
      const prior = BigInt(state.missionCommitted[event.mission_id] || "0");
      const next = prior > amount ? prior - amount : 0n;
      state.missionCommitted[event.mission_id] = next.toString();
    }
    if (event.type === "budget.unsigned_released") {
      const day = dayBucket(state, event.day);
      const amount = BigInt(event.drops || "0");
      sub(day, "uncertain", amount);
      add(day, "released", amount);
      if (event.live === true) {
        state.live_uncertain -= amount;
        if (state.live_uncertain < 0n) state.live_uncertain = 0n;
      }
      const mission = state.missions[event.mission_id];
      if (mission) mission.hold = "released";
    }
    if (event.type === "budget.uncertain") {
      const day = dayBucket(state, event.day);
      const amount = BigInt(event.drops);
      sub(day, "reserved", amount);
      add(day, "uncertain", amount);
      if (event.live === true) state.live_uncertain += amount;
      const mission = state.missions[event.mission_id];
      if (mission) {
        mission.hold = "uncertain";
        mission.settlement = event.settlement;
        mission.retry_blocked = true;
      }
    }
    if (event.type === "budget.settled") {
      const day = dayBucket(state, event.day);
      const amount = BigInt(event.drops);
      sub(day, event.from || "uncertain", amount);
      add(day, "spent", amount);
      if (event.live === true) {
        state.live_uncertain -= amount;
        if (state.live_uncertain < 0n) state.live_uncertain = 0n;
        state.live_spent += amount;
      }
      const mission = state.missions[event.mission_id];
      if (mission) mission.hold = "spent";
    }
  }
  return state;
}

function persist(api, mission) {
  api.append({ type: "mission.upsert", at: mission.updated_at, mission });
}

function labels(counterparty) {
  return {
    role: "agent",
    counterparty,
    environment: "testnet",
    mode: "simulation",
    approval: "human_required",
    network: config.NETWORK,
  };
}

function baseMission(key, now) {
  return {
    id: missionId(key),
    idempotency_key: key,
    stage: "goal",
    status: "open",
    code: null,
    rationale: "Foreign XRPL Testnet purchase mission opened. Signing is disabled.",
    labels: labels("unclassified"),
    budget: null,
    day: chicagoDay(now),
    hold: null,
    settlement: null,
    retry_blocked: false,
    live: false,
    signed: false,
    submitted: false,
    spending_enabled: false,
    artifact: null,
    proof_hash: null,
    explorer: null,
    foreign_revenue_drops: "0",
    expires_at: new Date(new Date(now).getTime() + config.HOLD_TTL_MS).toISOString(),
    updated_at: now,
    seller: null,
  };
}

function signedLiability(mission) {
  return Boolean(
    mission
    && (
      mission.presigned_hash
      || mission.submit_state
      || mission.signer_accepted === true
      || mission.signed === true
      || mission.hold === "uncertain"
      || mission.retry_blocked === true
    )
  );
}

function signedClaimMayRelease(input) {
  const last = input && input.lastLedgerSequence;
  const validated = input && input.validatedLedgerIndex;
  if (!Number.isInteger(last) || last <= 0) return false;
  if (!Number.isInteger(validated) || validated <= last) return false;
  return input.hashFound === false;
}

function expireHolds(api, state, now) {
  const instant = new Date(now).getTime();
  for (const mission of Object.values(state.missions)) {
    if (signedLiability(mission)) continue;
    if (!OPEN_HOLDS.has(mission.status) || mission.hold !== "unsubmitted") continue;
    if (!mission.expires_at || new Date(mission.expires_at).getTime() > instant) continue;
    const released = releaseHold(state, mission, "expiry", now);
    if (released) api.append(released);
    mission.status = "expired";
    mission.code = "expired";
    mission.stage = "evaluate";
    mission.rationale = "Unsubmitted hold expired. The reservation was released. An uncertain settlement would not expire this way.";
    mission.updated_at = now;
    persist(api, mission);
  }
}

function deny(api, mission, code, rationale, now) {
  mission.status = "blocked";
  mission.code = code;
  mission.stage = "policy";
  mission.rationale = rationale;
  mission.updated_at = now;
  mission.labels.approval = "denied";
  persist(api, mission);
  api.append({
    type: "control.denial",
    at: now,
    mission_id: mission.id,
    code,
    rationale,
    live: false,
  });
  return mission;
}

function payeeAllowed(allowlist, seller, resourceUrl) {
  const rows = allowlist && Array.isArray(allowlist.payees) ? allowlist.payees : [];
  for (const row of rows) {
    if (typeof row === "string") {
      if (row === seller) return true;
      continue;
    }
    if (!row || row.address !== seller || typeof row.resource !== "string") continue;
    if (row.resource === resourceUrl) return true;
  }
  return false;
}

const FEE_BLOCKS = new Set(["FEE", "FEE_CAP", "FEE_STALE"]);

function safePreSignFee(mission) {
  return Boolean(
    mission
    && FEE_BLOCKS.has(mission.code)
    && mission.signed !== true
    && mission.submitted !== true
    && mission.live !== true
    && mission.signer_accepted !== true
    && !mission.submit_state
    && !mission.presigned_hash
    && mission.hold !== "uncertain"
  );
}

function feeRetryKey(events, mission, key) {
  if (!safePreSignFee(mission)) return null;
  let allowance = 0;
  let consumed = 0;
  const seen = new Set();
  for (const event of events) {
    if (
      event
      && event.type === "control.retry_fee"
      && event.explicit === true
      && event.idempotency_key === key
      && event.live === false
    ) {
      allowance += 1;
    }
    const row = event && event.type === "mission.upsert" ? event.mission : null;
    if (!row || row.retry_of !== key || !row.idempotency_key || seen.has(row.idempotency_key)) continue;
    seen.add(row.idempotency_key);
    if (allowance > consumed) consumed += 1;
  }
  if (allowance <= consumed) return null;
  const next = `${key}-fee-retry-${seen.size + 1}`;
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(next)) return null;
  return next;
}

function startMission(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  const key = String(input.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  policy.assertNetwork(input.observation || input);
  return exclusive(dir, (api) => {
    const events = api.read();
    const state = fold(events);
    expireHolds(api, state, now);
    const existing = Object.values(state.missions).find((mission) => mission.idempotency_key === key);
    let attemptKey = key;
    if (existing) {
      const successor = feeRetryKey(events, existing, key);
      if (!successor) return { mission: existing, replay: true };
      attemptKey = successor;
    }
    if (state.killed || input.action === "kill") {
      const mission = baseMission(key, now);
      return { mission: deny(api, mission, "killed", "Hard stop is on. The mission was denied and not reserved.", now), replay: false };
    }
    if (config.REFUSED_ACTIONS.includes(input.action)) {
      const mission = baseMission(key, now);
      return { mission: deny(api, mission, "action", `Action ${input.action} is not on the allowlist.`, now), replay: false };
    }
    const mission = baseMission(attemptKey, now);
    if (attemptKey !== key) mission.retry_of = key;
    mission.stage = "plan";
    const found = policy.discover(input.observation);
    if (found.foreign.length === 0) {
      mission.labels.counterparty = found.house.length ? "house" : "none";
      mission.rationale = "No foreign seller. House wallets and synthetic accounts are not foreign revenue.";
      mission.code = "no_foreign_seller";
      mission.status = "blocked";
      mission.stage = "plan";
      mission.updated_at = now;
      persist(api, mission);
      return { mission, replay: false };
    }
    const seller = found.foreign[0];
    mission.seller = seller;
    mission.labels.counterparty = "foreign";
    mission.resource_url = input.resource_url || null;
    if (!payeeAllowed(options.allowlist, seller, input.resource_url || null)) {
      return { mission: deny(api, mission, "payee_not_allowlisted", "The foreign account is not an allowlisted payee for this resource.", now), replay: false };
    }
    let priced;
    try {
      priced = policy.quote(input);
    } catch (error) {
      mission.code = error.code || "CAP";
      mission.status = "blocked";
      mission.rationale = error.message;
      mission.updated_at = now;
      persist(api, mission);
      api.append({ type: "control.denial", at: now, mission_id: mission.id, code: mission.code, rationale: error.message, live: false });
      return { mission, replay: false };
    }
    const day = chicagoDay(now);
    const used = policy.dayUsed(state, day);
    const committed = BigInt(state.missionCommitted[mission.id] || "0");
    if (committed + BigInt(priced.budget_drops) > config.PER_MISSION_DROPS) {
      return { mission: deny(api, mission, "CAP", "Per-mission cap of 1000000 drops includes every step.", now), replay: false };
    }
    if (used + BigInt(priced.budget_drops) > config.DAILY_DROPS) {
      return { mission: deny(api, mission, "CAP", "Chicago-day cap of 5000000 drops would be exceeded. Unresolved uncertain holds still count.", now), replay: false };
    }
    api.append({
      type: "budget.reserved",
      at: now,
      mission_id: mission.id,
      day,
      budget_drops: priced.budget_drops,
      components: priced,
      live: false,
    });
    mission.budget = priced;
    mission.committed_drops = (committed + BigInt(priced.budget_drops)).toString();
    mission.day = day;
    mission.hold = "unsubmitted";
    mission.stage = "policy";
    const kind = input.kind || config.AUTONOMOUS_CLASS;
    const classOpen = state.spending_enabled && Array.isArray(state.classes) && state.classes.includes(kind);
    mission.kind = kind;
    if (classOpen) {
      mission.status = "approved_ready";
      mission.labels.approval = "approved_unsigned";
      mission.rationale = "Class foreign-xrpl1-purchase is already approved within the caps. This purchase was not sent for a second approval. Nothing has been signed.";
    } else {
      mission.status = "awaiting_human_approval";
      mission.labels.approval = "human_required";
      mission.rationale = kind === config.AUTONOMOUS_CLASS
        ? "Plan is inside the cap. Runtime spend is not activated, so this purchase waits."
        : "This action is outside the approved class. A human must approve it. Nothing has been signed.";
    }
    mission.updated_at = now;
    persist(api, mission);
    return { mission, replay: false };
  });
}

function blockMission(dir, input) {
  const now = input.now || new Date().toISOString();
  const key = String(input.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    const existing = Object.values(state.missions).find((mission) => mission.idempotency_key === key);
    if (existing) return { mission: existing, replay: true };
    const mission = baseMission(key, now);
    mission.status = "blocked";
    mission.code = input.code || "unsupported_protocol";
    mission.stage = "policy";
    mission.complete = false;
    mission.hold = null;
    mission.labels.approval = "denied";
    mission.rationale = input.rationale || "This candidate is not a supported xrpl:1 XRP payment.";
    mission.updated_at = now;
    persist(api, mission);
    return { mission, replay: false };
  });
}

function approve(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    expireHolds(api, state, now);
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (state.killed) throw coded("hard stop is on", "killed");
    if (mission.retry_blocked) throw coded("refusing to advance an unknown or pending settlement", "NO_RETRY");
    if (!policy.tokenOk(input.token, options.token)) {
      api.append({
        type: "control.denial",
        at: now,
        mission_id: mission.id,
        code: "AUTH",
        rationale: "Internal approval was refused.",
        live: false,
      });
      throw coded("internal approval token was refused", "AUTH");
    }
    if (mission.status !== "awaiting_human_approval") {
      return { mission, replay: true };
    }
    mission.labels.approval = "approved_unsigned";
    mission.signed = false;
    mission.submitted = false;
    mission.spending_enabled = state.spending_enabled === true;
    mission.stage = "act";
    if (state.spending_enabled) {
      mission.status = "approved_ready";
      mission.rationale = "Human approval recorded and XRPL Testnet spend is activated. Nothing has been signed yet.";
    } else {
      mission.status = "spending_disabled";
      mission.rationale = "Human approval recorded. Runtime spend is not activated, so nothing was signed or submitted.";
    }
    mission.updated_at = now;
    persist(api, mission);
    return { mission, replay: false };
  });
}

function addStep(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  const key = String(input.idempotency_key || "");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(key)) throw coded("idempotency_key is missing", "IDEMPOTENCY");
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    expireHolds(api, state, now);
    const prior = Object.values(state.missions).find((mission) => mission.step_key === key);
    if (prior) return { mission: prior, replay: true };
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (state.killed) throw coded("hard stop is on", "killed");
    let priced;
    try {
      priced = policy.quote(input);
    } catch (error) {
      throw error;
    }
    const committed = BigInt(state.missionCommitted[mission.id] || "0");
    const extra = BigInt(priced.budget_drops);
    if (committed + extra > config.PER_MISSION_DROPS) {
      api.append({ type: "control.denial", at: now, mission_id: mission.id, code: "CAP", rationale: "Per-mission cap of 1000000 drops includes every step.", live: false });
      throw coded("per-mission cap includes every step", "CAP");
    }
    const day = chicagoDay(now);
    if (policy.dayUsed(state, day) + extra > config.DAILY_DROPS) {
      api.append({ type: "control.denial", at: now, mission_id: mission.id, code: "CAP", rationale: "Chicago-day cap would be exceeded.", live: false });
      throw coded("daily cap would be exceeded", "CAP");
    }
    api.append({
      type: "budget.reserved",
      at: now,
      mission_id: mission.id,
      day,
      budget_drops: priced.budget_drops,
      components: priced,
      live: false,
      step_key: key,
    });
    mission.committed_drops = (committed + extra).toString();
    mission.step_key = key;
    mission.updated_at = now;
    mission.rationale = "Another step was reserved against the same mission. The 1 XRP cap is the sum of the steps.";
    persist(api, mission);
    return { mission, replay: false };
  });
}

function control(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    if (!policy.tokenOk(input.token, options.token)) {
      api.append({ type: "control.denial", at: now, mission_id: null, code: "AUTH", rationale: "Control authentication failed.", live: false });
      throw coded("control token was refused", "AUTH");
    }
    const state = fold(api.read());
    if (input.action === "activate") {
      if (input.confirm !== config.ACTIVATE_PHRASE) throw coded("activation phrase mismatch", "APPROVAL");
      if (state.killed) throw coded("hard stop is on", "killed");
      if (input.per_mission_drops && input.per_mission_drops !== config.PER_MISSION_DROPS.toString()) {
        throw coded("refusing to raise the per-mission cap", "CAP");
      }
      if (input.daily_drops && input.daily_drops !== config.DAILY_DROPS.toString()) {
        throw coded("refusing to raise the daily cap", "CAP");
      }
      api.append({
        type: "control.activate",
        at: now,
        per_mission_drops: config.PER_MISSION_DROPS.toString(),
        daily_drops: config.DAILY_DROPS.toString(),
        classes: [config.AUTONOMOUS_CLASS],
        network: config.NETWORK,
        live: false,
      });
      return { spending_enabled: true, at: now };
    }
    if (input.action === "deactivate") {
      if (input.confirm !== config.DEACTIVATE_PHRASE) throw coded("deactivation phrase mismatch", "APPROVAL");
      api.append({ type: "control.deactivate", at: now, live: false });
      return { spending_enabled: false, at: now };
    }
    if (input.action === "clear_kill") {
      if (input.confirm !== config.CLEAR_KILL_PHRASE) throw coded("clear-kill phrase mismatch", "APPROVAL");
      api.append({ type: "control.clear_kill", at: now, live: false });
      api.append({ type: "control.deactivate", at: now, live: false });
      return { killed: false, spending_enabled: false, at: now };
    }
    throw coded("unknown control", "COMMAND");
  });
}

function missionPayment(mission, wallet) {
  if (!wallet || !wallet.address) throw coded("isolated wallet address is required", "WALLET");
  if (policy.isHouse(wallet.address)) throw coded("isolated wallet is a house account", "W0");
  if (mission.budget && (mission.budget.bridge_gas_drops !== "0" || mission.budget.bridge_custody_drops !== "0")) {
    throw coded(
      "Bridge and destination-chain gas are not authorized. The return leg stays blocked. This act pays only an XRPL Testnet foreign seller.",
      "NON_XRP"
    );
  }
  const tx = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: mission.seller,
    Amount: mission.budget.payment_drops,
    Fee: mission.budget.network_fee_drops,
    NetworkID: config.NETWORK_ID,
  };
  if (policy.isHouse(tx.Destination)) throw coded("refusing a house payee", "W0");
  return tx;
}

function drySigner(body) {
  const runtimePolicy = require("../runtime/policy");
  runtimePolicy.assertMissionSpend(body.tx, body.env || {});
  return {
    dry_run: true,
    key_loaded: false,
    signed: false,
    submitted: false,
    live: false,
    tx: body.tx,
  };
}

function act(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    expireHolds(api, state, now);
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (state.killed) throw coded("hard stop is on", "killed");
    if (mission.retry_blocked) throw coded("refusing to retry an unknown or pending settlement", "NO_RETRY");
    if (mission.labels.approval !== "approved_unsigned") throw coded("human approval is required", "APPROVAL");
    if (!state.spending_enabled) throw coded("spending is not activated", "SPENDING_DISABLED");
    if (mission.submitted) return { mission, replay: true };
    const tx = missionPayment(mission, options.wallet);
    const signer = options.signer || drySigner;
    const result = signer({
      intent: "mission_spend",
      tx,
      dry_run: true,
      env: {
        MISSION_XRPL_ADDRESS: options.wallet.address,
        FOUNDRY_AGENT_SIGN: "yes",
      },
    });
    if (!result || result.key_loaded || result.signed || result.submitted || result.live) {
      throw coded("refusing a signer result that loaded a key or submitted", "SUBMIT");
    }
    mission.status = "ready_for_signer";
    mission.stage = "act";
    mission.unsigned_tx = result.tx || tx;
    mission.signed = false;
    mission.submitted = false;
    mission.live = false;
    mission.spending_enabled = true;
    mission.rationale = "Activated and approved. The signer dry-run accepted the Payment. No key was loaded and nothing was submitted.";
    mission.updated_at = now;
    persist(api, mission);
    api.append({
      type: "act.prepared",
      at: now,
      mission_id: mission.id,
      live: false,
      signed: false,
      submitted: false,
      network_id: 1,
    });
    return { mission, signer: { dry_run: true, key_loaded: false, signed: false, submitted: false }, replay: false };
  });
}

function recordSubmission(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.submitted) return { mission, replay: true };
    if (state.killed) throw coded("hard stop is on", "killed");
    if (!state.spending_enabled) throw coded("spending is not activated", "SPENDING_DISABLED");
    if (mission.status !== "ready_for_signer") throw coded("mission is not ready for the dedicated signer", "SIGN");
    const result = input.result || {};
    const text = JSON.stringify(result);
    if (anchors.EMBEDDED_SEED_RE.test(text)) throw coded("refusing a result that contains a seed", "SEED");
    if (result.dry_run === true || result.submitted !== true || result.live !== true || result.signed !== true) {
      throw coded("dedicated signer did not submit", "SUBMIT");
    }
    const hash = String(result.hash || "").toUpperCase();
    if (!anchors.HASH_RE.test(hash)) throw coded("refusing a submission without a ledger hash", "SUBMIT");
    if (Number(result.network_id) !== config.NETWORK_ID) throw coded("refusing network id", "MAINNET");
    if (result.engine_result !== "tesSUCCESS") throw coded("refusing a result that is not tesSUCCESS", "SUBMIT");
    const amount = BigInt(mission.budget ? mission.budget.budget_drops : "0");
    if (amount <= 0n) throw coded("mission budget is missing", "CAP");
    api.append({
      type: "budget.spent",
      at: now,
      mission_id: mission.id,
      day: mission.day,
      drops: amount.toString(),
      live: true,
      hash,
    });
    mission.status = "submitted";
    mission.submitted = true;
    mission.signed = true;
    mission.live = true;
    mission.hold = "spent";
    mission.settlement = "xrpl_validated";
    mission.proof_hash = hash;
    mission.explorer = `${config.EXPLORER_TX}${hash}`;
    mission.foreign_revenue_drops = mission.budget.payment_drops;
    mission.retry_blocked = true;
    mission.stage = "observe";
    mission.rationale = "Dedicated mission signer submitted a network-id-1 Payment. The EVM return leg was not used.";
    mission.updated_at = now;
    persist(api, mission);
    return { mission, replay: false };
  });
}

function classifyBridge(observation) {
  const classified = axelarStatus.classify({
    direction: observation.direction || "xrpl-to-evm",
    network_id: observation.network_id,
    evm_chain_id: observation.evm_chain_id,
    xrpl: observation.xrpl,
    gmp: observation.gmp,
    destination_proof: observation.destination_proof,
    local_status: observation.local_status,
  });
  if (classified.final) return { settlement: "dest_final", retry: false, classified };
  if (classified.status === "pending" || classified.status === "recovery") {
    return { settlement: "bridge_pending", retry: false, classified };
  }
  if (classified.status === "error") return { settlement: "failed", retry: false, classified };
  return { settlement: "uncertain", retry: false, classified };
}

function observe(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.retry_blocked) throw coded("refusing to retry an unknown or pending outcome", "NO_RETRY");
    if (mission.idempotency_observe && mission.idempotency_observe === input.observe_key) {
      return { mission, replay: true };
    }
    const report = input.report || {};
    if (report.kind === "bridge") {
      const bridge = classifyBridge(report);
      if (bridge.classified && bridge.classified.code === "MAINNET") {
        mission.status = "failure";
        mission.code = "MAINNET";
        mission.stage = "observe";
        mission.retry_blocked = true;
        mission.live = false;
        mission.rationale = "Bridge report named a mainnet network. The hold was not released and nothing was submitted.";
        mission.updated_at = now;
        persist(api, mission);
        return { mission, bridge, replay: false };
      }
      mission.settlement = bridge.settlement;
      mission.stage = "observe";
      mission.live = false;
      mission.retry_blocked = bridge.settlement === "uncertain" || bridge.settlement === "bridge_pending";
      mission.rationale =
        bridge.settlement === "dest_final"
          ? "Bridge classification is destination-final in simulation only. Live settlement is not claimed while signing is disabled."
          : bridge.settlement === "bridge_pending"
            ? "Bridge is pending. Source inclusion is not destination finality. Retry is blocked."
            : "Bridge outcome is uncertain. The reservation stays put and retry is blocked.";
      if (mission.retry_blocked && mission.budget && mission.hold === "unsubmitted") {
        api.append({
          type: "budget.uncertain",
          at: now,
          mission_id: mission.id,
          day: mission.day,
          drops: mission.budget.budget_drops,
          settlement: bridge.settlement,
          live: false,
        });
        mission.hold = "uncertain";
      }
      mission.status = bridge.settlement === "failed" ? "failure" : mission.status;
      mission.idempotency_observe = input.observe_key || null;
      mission.updated_at = now;
      persist(api, mission);
      return { mission, bridge, replay: false };
    }
    if (report.validated === true && report.result && report.result !== "tesSUCCESS") {
      const fee = policy.drops(report.fee_drops || "0", "fee_drops");
      const budget = BigInt(mission.budget ? mission.budget.budget_drops : "0");
      if (fee > budget) throw coded("failed fee exceeds the reservation", "CAP");
      if (mission.budget && mission.hold === "unsubmitted") {
        api.append({
          type: "budget.fee_spent",
          at: now,
          mission_id: mission.id,
          day: mission.day,
          drops: fee.toString(),
          live: false,
        });
        const rest = budget - fee;
        if (rest > 0n) {
          api.append({
            type: "budget.released",
            at: now,
            mission_id: mission.id,
            day: mission.day,
            drops: rest.toString(),
            reason: "source_failure",
            live: false,
          });
        }
        mission.hold = "released";
        mission.fee_spent_drops = fee.toString();
      }
      mission.status = "failure";
      mission.stage = "observe";
      mission.settlement = "failed";
      mission.retry_blocked = true;
      mission.rationale = "Source transaction failed. The network fee stays spent. The unsent amount was released. No automatic retry.";
      mission.idempotency_observe = input.observe_key || null;
      mission.updated_at = now;
      persist(api, mission);
      return { mission, replay: false };
    }
    mission.settlement = "uncertain";
    mission.retry_blocked = true;
    mission.stage = "observe";
    mission.status = "uncertain";
    mission.rationale = "Outcome is not a validated failure or a destination proof. Nothing is released and nothing is retried.";
    if (mission.budget && mission.hold === "unsubmitted") {
      api.append({
        type: "budget.uncertain",
        at: now,
        mission_id: mission.id,
        day: mission.day,
        drops: mission.budget.budget_drops,
        settlement: "uncertain",
        live: false,
      });
      mission.hold = "uncertain";
    }
    mission.idempotency_observe = input.observe_key || null;
    mission.updated_at = now;
    persist(api, mission);
    return { mission, replay: false };
  });
}

function evaluate(dir, input) {
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    const state = fold(api.read());
    const mission = state.missions[input.mission_id];
    if (!mission) throw coded("mission not found", "PLAN");
    if (mission.retry_blocked && mission.settlement !== "dest_final" && mission.settlement !== "xrpl_validated") {
      throw coded("refusing to evaluate a retry of an unknown outcome", "NO_RETRY");
    }
    const payload = input.payload || {};
    if (payload.network === "xrpl:0" || payload.network_id === 0) {
      mission.status = "failure";
      mission.code = "MAINNET";
      mission.rationale = "Payload named mainnet. It was not published.";
      mission.updated_at = now;
      persist(api, mission);
      return { mission, replay: false };
    }
    const secret = Object.keys(payload).some((key) => /seed|secret|private|prompt|chain_of_thought/i.test(key));
    if (secret || policy.isHouse(payload.seller) || payload.seller !== mission.seller) {
      mission.status = "failure";
      mission.code = "payload_rejected";
      mission.stage = "evaluate";
      mission.rationale = "Payload failed validation. House trades and secret fields are not published as foreign revenue.";
      mission.foreign_revenue_drops = "0";
      mission.updated_at = now;
      persist(api, mission);
      return { mission, replay: false };
    }
    const hash = typeof payload.hash === "string" && /^[0-9A-F]{64}$/.test(payload.hash) ? payload.hash : null;
    mission.stage = "evaluate";
    mission.artifact = {
      schema: "aether.mission.artifact",
      seller: mission.seller,
      counterparty: "foreign",
      network: config.NETWORK,
      amount_drops: mission.budget ? mission.budget.payment_drops : "0",
      proof_hash: hash,
      explorer: hash ? `${config.EXPLORER_TX}${hash}` : null,
      live: mission.live === true && Boolean(hash),
    };
    mission.proof_hash = hash;
    mission.explorer = mission.artifact.explorer;
    const qualified = payload.qualified === true && payload.network === config.NETWORK && payload.seller === mission.seller;
    mission.complete = qualified;
    if (qualified && mission.live === true && hash) {
      mission.foreign_revenue_drops = mission.budget ? mission.budget.payment_drops : "0";
      mission.status = "complete";
      mission.rationale = "Validated artifact matches the qualified xrpl:1 service and the settled payment.";
    } else if (qualified) {
      mission.foreign_revenue_drops = "0";
      mission.status = "complete";
      mission.rationale = "Validated artifact matches the qualified xrpl:1 service. No live settlement is claimed.";
    } else {
      mission.foreign_revenue_drops = "0";
      mission.rationale = hash
        ? "Artifact recorded with a hash. It is not a qualified service result."
        : "Artifact published without a proof hash. No hash was invented. Foreign revenue stays zero.";
      if (mission.status === "spending_disabled" || mission.status === "awaiting_human_approval") {
        mission.status = "published_simulation";
      }
    }
    persist(api, mission);
    return { mission, replay: false };
  });
}

function kill(dir, input, opts) {
  const options = opts || {};
  const now = input.now || new Date().toISOString();
  return exclusive(dir, (api) => {
    if (!policy.tokenOk(input.token, options.token)) {
      api.append({ type: "control.denial", at: now, mission_id: null, code: "AUTH", rationale: "Kill switch authentication failed.", live: false });
      throw coded("kill switch authentication failed", "AUTH");
    }
    api.append({ type: "control.kill", at: now, rationale: "Hard stop recorded.", live: false });
    return { killed: true, at: now };
  });
}

function ageStale(observed, now) {
  if (!observed) return true;
  const then = new Date(observed).getTime();
  const clock = new Date(now || Date.now()).getTime();
  if (Number.isNaN(then) || Number.isNaN(clock)) return true;
  return clock - then > config.STALE_MS;
}

function view(dir, now) {
  const events = dir ? readEvents(dir).filter((event) => event && event.counted !== false && event.type) : [];
  const clock = now || new Date().toISOString();
  if (!events.length) {
    return {
      spending_enabled: false,
      spending_enabled_source: "default_off",
      signing_enabled: false,
      authorized_per_mission_drops: config.PER_MISSION_DROPS.toString(),
      authorized_daily_drops: config.DAILY_DROPS.toString(),
      timezone: config.TIMEZONE,
      live_spend_drops: null,
      reserved_drops: null,
      uncertain_drops: null,
      accounted_spent_drops: null,
      killed: false,
      source: "unavailable",
      source_observed_at: null,
      stale: true,
      missions: {},
      days: {},
      denials: [],
    };
  }
  const state = fold(events);
  let observed = null;
  for (const event of events) {
    if (event.at) observed = event.at;
  }
  const day = state.days[chicagoDay(clock)] || { reserved: "0", spent: "0", uncertain: "0", released: "0" };
  const live = state.live_spent + state.live_uncertain;
  return {
    spending_enabled: state.spending_enabled === true,
    spending_enabled_source: "ledger",
    signing_enabled: false,
    authorized_per_mission_drops: config.PER_MISSION_DROPS.toString(),
    authorized_daily_drops: config.DAILY_DROPS.toString(),
    timezone: config.TIMEZONE,
    live_spend_drops: live.toString(),
    reserved_drops: day.reserved,
    uncertain_drops: day.uncertain,
    accounted_spent_drops: day.spent,
    killed: state.killed,
    source: "ledger",
    source_observed_at: observed,
    stale: ageStale(observed, clock),
    missions: state.missions,
    days: state.days,
    denials: state.denials,
  };
}

function publicFeed(dir, now) {
  const full = view(dir, now);
  const missions = Object.values(full.missions || {}).map((mission) => ({
    id: mission.id,
    status: mission.status,
    code: mission.code,
    stage: mission.stage,
    rationale: mission.rationale,
    labels: mission.labels,
    settlement: mission.settlement,
    live: mission.live === true,
    signed: mission.signed === true,
    submitted: mission.submitted === true,
    complete: mission.complete === true,
    foreign_revenue_drops: /^[0-9]+$/.test(String(mission.foreign_revenue_drops || ""))
      ? String(mission.foreign_revenue_drops)
      : "0",
    proof_hash: mission.proof_hash,
    explorer: mission.explorer,
    budget_drops: mission.budget ? mission.budget.budget_drops : "0",
    account_reserve_drops: mission.budget ? mission.budget.account_reserve_drops : "0",
    network_fee_drops: mission.budget ? mission.budget.network_fee_drops : "0",
    bridge_custody_drops: mission.budget ? mission.budget.bridge_custody_drops : "0",
  }));
  const liveDrops = full.live_spend_drops;
  return assertPublic({
    schema: "aether.missions.public",
    spending_enabled: full.spending_enabled,
    spending_enabled_source: full.spending_enabled_source,
    signing_enabled: false,
    authorized_per_mission_drops: full.authorized_per_mission_drops,
    authorized_daily_drops: full.authorized_daily_drops,
    authorized_per_mission_xrp: "1",
    authorized_daily_xrp: "5",
    timezone: config.TIMEZONE,
    live_spend_drops: liveDrops,
    live_spend_xrp: liveDrops == null ? null : (Number(liveDrops) / 1000000).toString(),
    reserved_drops: full.reserved_drops,
    uncertain_drops: full.uncertain_drops,
    accounted_spent_drops: full.accounted_spent_drops,
    source: full.source,
    source_observed_at: full.source_observed_at,
    stale: full.stale,
    killed: full.killed,
    note:
      full.source === "ledger"
        ? "Figures are folded from the append-only mission ledger. Signing is still a separate box step."
        : "No mission ledger is visible to this process. Live spend is unknown, not zero.",
    missions,
  });
}

function publicDetail(dir, id) {
  const feed = publicFeed(dir);
  const mission = feed.missions.find((item) => item.id === id);
  if (!mission) return null;
  return assertPublic({ schema: "aether.missions.detail", mission });
}

function publicReplay(dir, id) {
  const events = readEvents(dir)
    .filter((event) => event && (event.mission_id === id || (event.mission && event.mission.id === id)))
    .map((event) => ({
      type: event.type,
      at: event.at,
      code: event.code || (event.mission && event.mission.code) || null,
      status: event.mission ? event.mission.status : null,
      settlement: event.settlement || (event.mission && event.mission.settlement) || null,
      rationale: event.rationale || (event.mission && event.mission.rationale) || null,
      live: event.live === true,
    }));
  return assertPublic({ schema: "aether.missions.replay", id, events });
}

module.exports = {
  fold,
  missionId,
  startMission,
  blockMission,
  payeeAllowed,
  safePreSignFee,
  signedLiability,
  signedClaimMayRelease,
  feeRetryKey,
  addStep,
  approve,
  control,
  act,
  recordSubmission,
  observe,
  evaluate,
  kill,
  view,
  publicFeed,
  publicDetail,
  publicReplay,
  classifyBridge,
};
