# THREAT — Axelar ITS testnet bridge

This pack does not sign. The threats below are the ones the planner and the existing signer are built to refuse. AI-assisted notes, not an audit.

## Mainnet and the wrong chain

Network id 0, any XRPL network other than id 1, and any EVM chain id other than `1449000` throw `MAINNET`. Hosts `ripple.com`, `s1.ripple.com`, `s2.ripple.com`, `xrplcluster.com`, `xrpl.ws`, `xrpl.link`, `rpc.xrplevm.org`, and `api.axelarscan.io` are refused. The status fetcher allowlist is three origins: XRPL Labs testnet HTTP, `https://rpc.testnet.xrplevm.org`, and `https://testnet.api.axelarscan.io`. The CLI does not call that fetcher.

The published mainnet gateway is refused as a destination. It is not used as a source.

## Treasury and the agent signer

W0–W7 cannot be the bridge source or destination. The agent signer refuses a Payment whose destination is either gateway and refuses memos `interchain_transfer`, `call_contract`, `destination_chain`, and `gas_fee_amount`. Grants and x402 outbound refuse the gateway too. No allowlist action was added. `signer.js` does not load `W0_SEED` and does not import this pack.

Dry-run planning does not read an environment variable for a key. There is no `dotenv` import and no `aether-foundry-secrets` path in this pack.

## Stale pin

Addresses are a snapshot of the Axelar testnet static config on 2026-11-06. The planner does not refresh them. XRPL EVM docs say those contracts can move while the sidechain is in development. A plan with `live_config_recheck: false` is not a claim that the gateway is still current. Signing stays disabled so a stale pin cannot be submitted by this code.

## Memo and value mistakes

`gas_fee_amount` is the ASCII drops string, and it must be strictly less than `Amount`. A decimal gas string on an XRP payment is how Axelar describes an unindexed, unrecoverable message. Zero gas is refused because this pack cannot build the Add Gas recovery payment.

A `payload` memo is refused. The ITS docs say an empty payload is still treated as a GMP call.

The return leg's `msg.value` is not set. Guessing it could lock native XRP in the ITS or token-manager path. The plan is blocked with `NATIVE_VALUE_UNVERIFIED`.

## Replay and caps

`client_id` is the idempotency key. The same id with a different plan hash throws `REPLAY`. A second non-terminal plan for the same source wallet throws `IN_FLIGHT`. Amounts above 2 XRP, gas above 0.5 XRP, or a UTC-day total above 5 XRP throw `CAP`. Return-leg wei amounts have the same 2 XRP / 0.5 XRP ceilings in 18-decimal units, and that plan is still not signable.

## False finality

`tesSUCCESS` on the source ledger is `uncertain` until a GMP status this pack recognizes is present. Strings that are not in the AxelarJS `GMPStatus` enum, including a bare `executed`, stay `uncertain`. `destination_executed` without a destination proof whose hash matches the GMP `executed.transactionHash` stays `uncertain`. `insufficient_fee` is `recovery` with `manual_add_gas_not_implemented`, not a success and not an automatic retry.

## Stellar

A dated Stellar chain id in the Axelar testnet config is not a route. Encoding a Stellar address from that snapshot would be speculative. The command returns `supported: false` and builds no transaction.
