"use strict";

/**
 * One evidence-informed decision per call.
 * The journal remembers prior decisions. It does not train a model.
 * A self-only book is observe: spend can be enabled while nothing trades.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { view } = require("../../missions/engine");
const policy = require("../../missions/policy");
const missionConfig = require("../../missions/config");
const { verifiedEnv, KIND } = require("./bounds");
const { connectLive } = require("./live");
const engine = require("./engine");

const CHOICES = ["research", "observe", "hold", "reconcile", "cancel", "place"];

function journalPath(dir) {
  return path.join(dir, "decisions.jsonl");
}

function readJournal(dir) {
  const file = journalPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sanitize(record) {
  const text = JSON.stringify(record);
  if (/seed|secret|tx_blob|private/i.test(text)) {
    throw Object.assign(new Error("decision record is not public"), { code: "SECRET" });
  }
  return record;
}

function remember(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalPath(dir), `${JSON.stringify(sanitize(record))}\n`);
  return record;
}

function savedPolicy(env, body) {
  if (body.policy) return body.policy;
  const file = env.FOUNDRY_W1_DEX_POLICY;
  if (!file) return {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw Object.assign(new Error("standing policy is not a regular file"), { code: "POLICY" });
  }
  const text = fs.readFileSync(file, "utf8");
  if (/seed|secret|tx_blob|private/i.test(text)) {
    throw Object.assign(new Error("standing policy is not public"), { code: "SECRET" });
  }
  const parsed = JSON.parse(text);
  const offer = parsed && parsed.standing_offer;
  if (offer != null && (typeof offer !== "object" || Array.isArray(offer))) {
    throw Object.assign(new Error("standing policy is not an order"), { code: "POLICY" });
  }
  return {
    standing_offer: offer || null,
    cancel_standing: parsed.cancel_standing === true,
  };
}

function standingKey(standing, day) {
  const body = JSON.stringify(standing);
  return `w1-stand-${day}-${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

function openMission(dir, now) {
  return Object.values(view(dir, now).missions || {}).find((mission) => mission && mission.kind === KIND && mission.hold !== "released" && mission.status !== "dex_filled" && mission.status !== "dex_cancelled" && mission.status !== "dex_absent");
}

async function decide(env, input, clients) {
  const source = env || {};
  const body = input || {};
  const now = body.now || new Date().toISOString();
  const spend = verifiedEnv(source) != null && source.FOUNDRY_W1_DEX_LIVE === "yes";
  const base = {
    schema: "aether.business.research",
    at: now,
    learning: false,
    spend_enabled: spend && source.FOUNDRY_DEX_KILL !== "yes" && body.killed !== true,
    traded: false,
    live_proof: false,
    choice_set: CHOICES,
  };
  if (!body.journal) throw Object.assign(new Error("decision journal is missing"), { code: "LEDGER" });
  if (!spend || source.FOUNDRY_DEX_KILL === "yes" || body.killed === true) {
    const row = Object.assign({}, base, {
      decision: "hold",
      spend_enabled: false,
      market: "not_activated",
      rationale: "Spend is not enabled. Research is recorded and nothing is traded.",
    });
    remember(body.journal, row);
    return row;
  }
  const saved = savedPolicy(source, body);
  const runtime = clients && clients.mode === "injected" ? clients : null;
  const live = runtime ? null : await connectLive(source, body.deps);
  const ledgerClient = runtime ? runtime.ledger : live.clients.ledger;
  const actor = runtime || (live && live.clients);
  try {
    const book = await engine.inspectBook(ledgerClient);
    const used = policy.dayUsed(view(body.ledger, now), policy.chicagoDay(now));
    const capBlocked = used + book.locked > missionConfig.DAILY_DROPS;
    const mission = body.ledger ? openMission(body.ledger, now) : null;
    if (mission && (mission.status === "dex_submitted" || mission.status === "dex_signed" || mission.status === "dex_unknown")) {
      const row = Object.assign({}, base, {
        decision: "reconcile",
        market: book.count > 0 ? "own_book_only" : "empty",
        rationale: "An earlier order is unresolved. Reconcile it instead of opening another.",
        mission_id: mission.id,
        preexisting_locked_drops: book.locked.toString(),
        day_used_drops: used.toString(),
      });
      if (actor) {
        try {
          const settled = await engine.reconcile(body.ledger, { now, mission_id: mission.id }, actor);
          row.status = settled.status;
        } catch (error) {
          row.error_code = error.code || "UNCERTAIN";
        }
      }
      return remember(body.journal, row);
    }
    if (mission && (mission.status === "dex_open" || mission.status === "dex_partial") && saved.cancel_standing === true) {
      const row = Object.assign({}, base, {
        decision: "cancel",
        market: book.count > 0 ? "own_book_only" : "empty",
        rationale: "The saved policy withdraws this director's open order. Preexisting quotes are not cancelled.",
        mission_id: mission.id,
      });
      if (actor) {
        try {
          const cancelled = await engine.cancel(body.ledger, { now, mission_id: mission.id }, actor);
          row.status = cancelled.status;
          row.signed = cancelled.signed === true || Boolean(cancelled.cancel_hash);
        } catch (error) {
          row.error_code = error.code || "UNCERTAIN";
        }
      }
      return remember(body.journal, row);
    }
    if (mission && (mission.status === "dex_open" || mission.status === "dex_partial")) {
      const row = Object.assign({}, base, {
        decision: "consume",
        market: book.count > 0 ? "own_book_only" : "empty",
        rationale: "An open order may have been consumed. Check that history before placing another.",
        mission_id: mission.id,
        preexisting_locked_drops: book.locked.toString(),
      });
      if (actor) {
        try {
          await engine.consume(body.ledger, { now, mission_id: mission.id }, actor);
        } catch (error) {
          row.error_code = error.code || "UNCERTAIN";
        }
      }
      return remember(body.journal, row);
    }
    if (book.count > 0) {
      const row = Object.assign({}, base, {
        decision: "observe",
        market: "own_book_only",
        rationale: "The book is W1's own quotes. No external counterparty is allowlisted, so the choice is no trade.",
        preexisting_locked_drops: book.locked.toString(),
        day_used_drops: used.toString(),
        offer_count: book.count,
        cap_blocked: capBlocked,
      });
      return remember(body.journal, row);
    }
    const standing = saved.standing_offer;
    if (!standing) {
      const row = Object.assign({}, base, {
        decision: "research",
        market: "empty",
        rationale: "Spend is enabled and the book is empty. No standing order is configured, so nothing is placed.",
        preexisting_locked_drops: "0",
        day_used_drops: used.toString(),
      });
      return remember(body.journal, row);
    }
    const day = policy.chicagoDay(now);
    const key = standingKey(standing, day);
    const row = Object.assign({}, base, {
      decision: "place",
      market: "empty",
      rationale: "The book is empty and the standing order fits the saved policy. This key is stable for the Chicago day.",
      idempotency_key: key,
    });
    if (actor) {
      try {
        if (live) await live.openKey();
        const placed = await engine.place(body.ledger, {
          now,
          idempotency_key: key,
          taker_gets: standing.taker_gets,
          taker_pays: standing.taker_pays,
        }, actor);
        row.signed = placed.signed === true;
        row.submitted = placed.submitted === true;
        row.replay = placed.replay === true;
        row.traded = false;
        row.status = placed.status;
      } catch (error) {
        row.signed = false;
        row.submitted = false;
        row.traded = false;
        row.error_code = error.code || "UNCERTAIN";
        if (error.code === "OBSERVE") row.decision = "observe";
      }
    }
    return remember(body.journal, row);
  } finally {
    if (live) await live.close();
  }
}

module.exports = {
  decide,
  readJournal,
  CHOICES,
};
