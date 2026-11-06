"use strict";

const crypto = require("crypto");
const config = require("./config");
const abi = require("./abi");
const policy = require("./policy");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sourceTag(clientId) {
  const buf = crypto.createHash("sha256").update(`aether-axelar-its:${clientId}`).digest();
  const n = buf.readUInt32BE(0) & 0x7fffffff;
  return n === 0 ? 1 : n;
}

function memo(name, value) {
  return {
    Memo: {
      MemoType: Buffer.from(name, "utf8").toString("hex").toUpperCase(),
      MemoData: Buffer.from(String(value), "utf8").toString("hex").toUpperCase(),
    },
  };
}

function base(input, direction, now) {
  policy.assertNoSecretText(input);
  policy.assertNetwork(input || {});
  policy.assertAsset(input.asset);
  if (input.payload != null && input.payload !== "") {
    throw policy.coded("payload is refused; an empty payload is still a GMP call", "PAYLOAD");
  }
  const clientId = policy.assertClientId(input.client_id);
  const book = policy.assertWalletBook(input.wallets, direction, input.from, input.to);
  return {
    clientId,
    book,
    created_at: now || new Date().toISOString(),
  };
}

function envelope(core) {
  const planHash = sha256(JSON.stringify(core));
  const plan = Object.assign({}, core, {
    schema: "aether.axelar-its.plan",
    id: `ait${planHash.slice(0, 16)}`,
    plan_hash: planHash,
    mode: "dry-run",
    status: "planned",
    final: false,
    signed: false,
    submitted: false,
    signable: false,
    key_loaded: false,
    signing: "disabled",
    config_pin_date: config.PINNED_ON,
    live_config_recheck: false,
    destination_amount: null,
    destination_amount_reason: "its_hub_scaling_not_applied",
  });
  policy.assertNoSecretText(plan);
  return plan;
}

function buildForward(input, now) {
  const ctx = base(input, "xrpl-to-evm", now);
  const amounts = policy.assertForwardAmounts(input.amount_drops, input.gas_drops);
  const destinationHex = ctx.book.evm.slice(2);
  const unsigned = {
    TransactionType: "Payment",
    Account: ctx.book.xrpl,
    Destination: config.XRPL_GATEWAY,
    Amount: amounts.amount.toString(),
    SourceTag: sourceTag(ctx.clientId),
    NetworkID: config.XRPL_NETWORK_ID,
    Memos: [
      memo("type", config.MEMO_TYPE),
      memo("destination_address", destinationHex),
      memo("destination_chain", config.EVM_CHAIN),
      memo("gas_fee_amount", amounts.gas.toString()),
    ],
  };
  return envelope({
    client_id: ctx.clientId,
    created_at: ctx.created_at,
    direction: "xrpl-to-evm",
    network: config.XRPL_NETWORK,
    network_id: config.XRPL_NETWORK_ID,
    evm_chain_id: config.EVM_CHAIN_ID,
    axelar_source_chain: config.XRPL_CHAIN,
    axelar_destination_chain: config.EVM_CHAIN,
    asset: "XRP",
    token_id: config.XRP_TOKEN_ID,
    source_account: ctx.book.xrpl,
    destination_account: ctx.book.evm,
    gateway: config.XRPL_GATEWAY,
    its_evm: config.EVM_ITS,
    amount_drops: amounts.amount.toString(),
    gas_drops: amounts.gas.toString(),
    transfer_drops: amounts.transfer.toString(),
    amount_wei: null,
    gas_value_wei: null,
    xrpl_http: config.XRPL_HTTP,
    xrpl_http_ignored_published: config.IGNORED_PUBLISHED_XRPL_RPC,
    evm_rpc: config.EVM_RPC,
    gmp_api: config.GMP_API,
    unsigned_tx: unsigned,
    autofilled: false,
    evm_call: null,
    review_ready: true,
    blocked: null,
  });
}

function buildReturn(input, now) {
  const ctx = base(input, "evm-to-xrpl", now);
  const amounts = policy.assertReturnAmounts(input.amount_wei, input.gas_value_wei);
  const destinationBytes = Buffer.from(ctx.book.xrpl, "ascii");
  const data = abi.encodeInterchainTransfer({
    tokenId: config.XRP_TOKEN_ID,
    destinationChain: config.XRPL_CHAIN,
    destinationAddress: destinationBytes,
    amount: amounts.amount,
    metadata: Buffer.alloc(0),
    gasValue: amounts.gas,
  });
  return envelope({
    client_id: ctx.clientId,
    created_at: ctx.created_at,
    direction: "evm-to-xrpl",
    network: config.XRPL_NETWORK,
    network_id: config.XRPL_NETWORK_ID,
    evm_chain_id: config.EVM_CHAIN_ID,
    axelar_source_chain: config.EVM_CHAIN,
    axelar_destination_chain: config.XRPL_CHAIN,
    asset: "XRP",
    token_id: config.XRP_TOKEN_ID,
    source_account: ctx.book.evm,
    destination_account: ctx.book.xrpl,
    gateway: config.XRPL_GATEWAY,
    its_evm: config.EVM_ITS,
    amount_drops: null,
    gas_drops: null,
    transfer_drops: null,
    amount_wei: amounts.amount.toString(),
    gas_value_wei: amounts.gas.toString(),
    xrpl_http: config.XRPL_HTTP,
    xrpl_http_ignored_published: config.IGNORED_PUBLISHED_XRPL_RPC,
    evm_rpc: config.EVM_RPC,
    gmp_api: config.GMP_API,
    unsigned_tx: null,
    autofilled: false,
    evm_call: {
      chain_id: config.EVM_CHAIN_ID,
      to: config.EVM_ITS,
      data,
      value_wei: null,
      metadata: "0x",
      destination_ascii: ctx.book.xrpl,
      its_version: config.ITS_VERSION,
      signature: config.TRANSFER_SIGNATURE,
    },
    review_ready: false,
    blocked: {
      code: "NATIVE_VALUE_UNVERIFIED",
      reason:
        "ITS v2.1.1 takeToken burns or pulls the token via the token manager. The published XRPL EVM XRP row uses the 0xEeee sentinel and mintBurn. This pack does not guess msg.value, so the return leg is not signable.",
    },
  });
}

function build(input, now) {
  const direction = policy.assertDirection(input && input.direction);
  if (direction === "xrpl-to-evm") return buildForward(input, now);
  return buildReturn(input, now);
}

function plan(input, store, now) {
  const built = build(input, now);
  if (!store) return built;
  const prev = store.findByClient(built.client_id);
  if (prev) {
    if (prev.plan_hash !== built.plan_hash) {
      throw policy.coded("refusing replay with different parameters", "REPLAY");
    }
    return prev;
  }
  policy.assertCapacity(store.list(), built);
  store.put(built);
  return built;
}

function review(store, planId, confirm, now) {
  if (!store) throw policy.coded("review needs a plan store", "STORE");
  if (confirm !== config.REVIEW_PHRASE) throw policy.coded("review confirmation phrase mismatch", "APPROVAL");
  const row = store.get(planId);
  if (!row) throw policy.coded("plan not found", "PLAN");
  if (!row.review_ready || row.blocked) throw policy.coded("plan is not reviewable", row.blocked ? row.blocked.code : "APPROVAL");
  const record = {
    schema: "aether.axelar-its.review",
    plan_id: row.id,
    plan_hash: row.plan_hash,
    confirm: config.REVIEW_PHRASE,
    approved: true,
    signed: false,
    submitted: false,
    signable: false,
    signing: "disabled",
    at: now || new Date().toISOString(),
  };
  store.putReview(record);
  const next = Object.assign({}, row, { status: "approved_unsigned", final: false, signed: false, submitted: false, signable: false });
  store.put(next);
  return { plan: next, review: record };
}

function refuseSign() {
  throw policy.coded("signing and submission are disabled in this build", "SIGNING_DISABLED");
}

module.exports = {
  sourceTag,
  memo,
  build,
  plan,
  review,
  refuseSign,
};
