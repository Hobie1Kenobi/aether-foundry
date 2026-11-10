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
const { verifiedEnv, KIND } = require("./bounds");
const { connectLive } = require("./live");
const engine = require("./engine");
const market = require("./market");
const bankroll = require("../bankroll");
const amm = require("./amm");
const rlusd = require("./rlusd");

const CHOICES = ["research", "observe", "hold", "reconcile", "cancel", "place", "withdraw"];

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
    rebalance: parsed.rebalance || null,
    max_action_drops: typeof parsed.max_action_drops === "string" ? parsed.max_action_drops : null,
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
    let observed;
    try {
      observed = await market.load(ledgerClient);
    } catch (error) {
      const row = Object.assign({}, base, {
        decision: "research",
        market: "unproved",
        rationale: "The validated pool, balances, or book could not be proved. Nothing is placed.",
        error_code: error.code || "UNCERTAIN",
        traded: false,
      });
      return remember(body.journal, row);
    }
    const currentLp = observed.pool.balance === 0n ? 0n : (observed.pool.xrp * observed.pool.balance) / observed.pool.supply;
    bankroll.commitMark(body.ledger, currentLp, now);
    const position = bankroll.room(view(body.ledger, now), observed);
    let slip = null;
    try {
      const probe = observed.pool.xrp > 1000000n ? 1000000n : observed.pool.xrp / 10n;
      if (probe > 0n) slip = market.slippage(observed.pool, probe);
    } catch (error) {
      slip = { error_code: error.code || "VALUATION" };
    }
    const used = policy.dayUsed(view(body.ledger, now), policy.chicagoDay(now));
    const bookCount = observed.offers.length;
    const inventory = {
      learning: false,
      traded: false,
      day_used_drops: used.toString(),
      lp_xrp_drops: position.lp_xrp.toString(),
      offer_lock_drops: position.offer_lock.toString(),
      reserve_drops: position.reserve.toString(),
      bankroll_used_drops: position.uncertain ? null : position.used.toString(),
      bankroll_remaining_drops: position.remaining.toString(),
      rlusd_headroom_drops: position.rlusd_headroom.toString(),
      bankroll_limit_drops: position.limit.toString(),
      cap_blocked: position.cap_blocked === true,
      aeth_valuation: position.aeth_valuation,
      risk_increasing: position.risk_increasing === true,
      base_reserve_drops: position.base_reserve.toString(),
      sole_lp: observed.pool.sole === true,
      foreign_quotes: observed.foreign.length,
      slippage: slip,
      preexisting_locked_drops: position.offer_lock.toString(),
      offer_count: bookCount,
    };
    const mission = body.ledger ? openMission(body.ledger, now) : null;
    if (mission && (mission.status === "dex_submitted" || mission.status === "dex_signed" || mission.status === "dex_unknown")) {
      const row = Object.assign({}, base, inventory, {
        decision: "reconcile",
        market: bookCount > 0 ? "own_book_only" : "empty",
        rationale: "An earlier order is unresolved. Reconcile it instead of opening another.",
        mission_id: mission.id,
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
      const row = Object.assign({}, base, inventory, {
        decision: "cancel",
        market: bookCount > 0 ? "own_book_only" : "empty",
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
      const row = Object.assign({}, base, inventory, {
        decision: "consume",
        market: bookCount > 0 ? "own_book_only" : "empty",
        rationale: "An open order may have been consumed. Check that history before placing another.",
        mission_id: mission.id,
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
    if (observed.pool.sole && observed.foreign.length === 0 && bookCount >= 0) {
      if (saved.rebalance === "exit-sole-lp" && actor) {
        const row = Object.assign({}, base, inventory, {
          decision: "withdraw",
          market: "sole_lp",
          rationale: "The saved policy asks to reduce the sole LP position. This is not an automatic liquidation. Recovered XRP is credited only after withdraw metadata and a smaller validated pool share.",
        });
        try {
          if (live) await live.openKey();
          const exited = await amm.withdraw(body.ledger, { now }, actor);
          row.signed = exited.signed === true;
          row.submitted = exited.submitted === true;
          row.replay = exited.replay === true;
          row.status = exited.status;
          row.traded = false;
        } catch (error) {
          row.error_code = error.code || "UNCERTAIN";
          row.signed = false;
        }
        return remember(body.journal, row);
      }
      const row = Object.assign({}, base, inventory, {
        decision: "research",
        market: "sole_lp",
        rationale: "W1 holds LP against no independent AETH bid. New AETH risk is closed. RLUSD may use only the XRP left after this high-water.",
      });
      if (live) {
        try {
          await live.openKey();
        } catch (error) {
          row.rlusd_error = error.code || "UNCERTAIN";
          row.signed = false;
          return remember(body.journal, row);
        }
      }
      let traded = null;
      try {
        traded = await rlusd.tick(source, body.ledger, now, actor || { ledger: ledgerClient, sign: async () => { throw Object.assign(new Error("no signer"), { code: "NO_CLIENT" }); }, submit: async () => { throw Object.assign(new Error("no submit"), { code: "NO_CLIENT" }); } }, position);
      } catch (error) {
        row.rlusd_error = error.code || "UNCERTAIN";
      }
      if (traded) return remember(body.journal, Object.assign(row, traded, { learning: false }));
      if (position.rlusd_headroom < 1000000n) row.aeth_exit_proposal = "w1-exit-sole-lp";
      return remember(body.journal, row);
    }
    if (bookCount > 0) {
      const row = Object.assign({}, base, inventory, {
        decision: "observe",
        market: observed.foreign.length > 0 ? "foreign_while_resting" : "own_book_only",
        rationale: observed.foreign.length > 0
          ? "A foreign quote is on the book, and W1 already rests. No duplicate quote is added."
          : "The book is W1's own quotes. No foreign quote is visible, so the choice is no trade.",
      });
      return remember(body.journal, row);
    }
    const foreignSize = observed.foreign.reduce((sum, row) => (row.size > sum ? row.size : sum), 0n);
    if (foreignSize > 0n) {
      if (position.risk_increasing !== true || observed.book_complete !== true) {
        return remember(body.journal, Object.assign({}, base, inventory, {
          decision: "research",
          market: "foreign",
          rationale: "A foreign quote is visible. Valuation is unproved, the book is incomplete, or the bankroll is full. Nothing is signed.",
        }));
      }
      const fee = 10n;
      const ceiling = bankroll.maxLock(observed, position, fee);
      const slice = position.remaining / 5n;
      const bound = saved.max_action_drops ? BigInt(saved.max_action_drops) : slice;
      let room = ceiling < bound || bound === 0n ? ceiling : bound;
      if (foreignSize / 2n < room) room = foreignSize / 2n;
      const bid = market.passiveBid(observed.pool, observed.asks, room);
      if (!bid) {
        return remember(body.journal, Object.assign({}, base, inventory, {
          decision: "research",
          market: "foreign",
          rationale: "No passive price sits under the pool and the ask. Nothing is signed.",
        }));
      }
      const key = standingKey({ gets: bid.taker_gets, pays: bid.taker_pays.value }, policy.chicagoDay(now));
      const row = Object.assign({}, base, inventory, {
        decision: "place",
        market: "foreign",
        rationale: "The passive bid pays 1 percent less XRP per AETH than the pool and does not cross the ask.",
        idempotency_key: key,
      });
      if (actor) {
        try {
          if (live) await live.openKey();
          const placed = await engine.place(body.ledger, {
            now,
            idempotency_key: key,
            taker_gets: bid.taker_gets,
            taker_pays: bid.taker_pays,
          }, actor);
          row.signed = placed.signed === true;
          row.submitted = placed.submitted === true;
          row.replay = placed.replay === true;
          row.status = placed.status;
          row.traded = false;
        } catch (error) {
          row.signed = false;
          row.error_code = error.code || "UNCERTAIN";
          if (error.code === "OBSERVE") row.decision = "observe";
        }
      }
      return remember(body.journal, row);
    }
    const standing = saved.standing_offer;
    if (!standing || observed.pool.sole || position.risk_increasing !== true) {
      const row = Object.assign({}, base, inventory, {
        decision: "research",
        market: "empty",
        rationale: "Spend is enabled. No foreign quote is visible, so nothing is placed to manufacture activity.",
      });
      return remember(body.journal, row);
    }
    const day = policy.chicagoDay(now);
    const key = standingKey(standing, day);
    const row = Object.assign({}, base, inventory, {
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

function journalDegraded(input, error) {
  const now = (input && input.now) || new Date().toISOString();
  const row = {
    schema: "aether.business.research",
    at: now,
    learning: false,
    spend_enabled: false,
    traded: false,
    signed: false,
    live_proof: false,
    decision: "observe",
    market: "degraded",
    error_name: error && error.name ? error.name : "Error",
    rationale: "The testnet socket is not connected. Nothing is signed.",
  };
  if (!input || !input.journal) return row;
  return remember(input.journal, row);
}

module.exports = {
  decide,
  readJournal,
  journalDegraded,
  CHOICES,
};
