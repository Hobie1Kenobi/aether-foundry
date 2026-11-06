# RUNBOOK — Axelar ITS testnet round trip

**Status:** awaiting approval. Do not sign. Do not submit. Do not fund from this command.  
**Network:** XRPL Testnet id 1 and XRPL EVM Testnet chain id 1449000 only.  
**Signer:** none. The Foundry box signer is not on this path. W0 is not a source, a destination, or a key.

This runbook is AI-assisted operator documentation. It is not an audit and it does not authorize a transfer.

## Prerequisites (manual)

1. Create two **new** testnet wallets that are not W0, W1, W2, W3, W4, W5, W6, or W7.
   - One XRPL Testnet classic address.
   - One XRPL EVM Testnet address on chain id 1449000.
2. Keep the seeds in the operator's own secret store. Do not copy them into this repo, `.env`, `aether-foundry-secrets`, the signer environment, or a chat.
3. Copy `wallets.example.json` to `wallets.json` (gitignored). Fill only the two public addresses. Leave every secret out of the file.
4. Fund both wallets yourself from the public testnet faucets if you need a balance. This pack never calls a faucet.
5. Re-read the pinned gateway `rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2` against the current Axelar testnet config before any future signing change. `live_config_recheck` on a plan is false. A stale pin is a stop, not a guess.

## XRPL → XRPL EVM (reviewable unsigned plan)

```bash
npm run bridge:axelar -- plan \
  --direction xrpl-to-evm \
  --client-id round-trip-01 \
  --amount-drops 1000000 \
  --gas-drops 100000 \
  --from rYOURISOLATEDXRPLADDRESS \
  --to 0xYOURISOLATEDEVMADDRESS \
  --wallets machines/axelar-its-bridge/wallets.json
```

Expect `"mode": "dry-run"`, `"signed": false`, `"key_loaded": false`, `"signable": false`, `"network_id": 1`, and an unsigned Payment:

- `Destination` is the testnet gateway above.
- `Amount` is drops and **includes** gas. The recipient-side transfer is `Amount - gas_drops`.
- Memos, in order: `type=interchain_transfer`, `destination_address` (lowercase EVM hex without `0x`, then hex-encoded for the memo), `destination_chain=xrpl-evm`, `gas_fee_amount` (ASCII drops).
- No `payload` memo.
- `xrpl_http` is `https://testnet.xrpl-labs.com`.
- `destination_amount` is null. Do not assume a 1:10^12 conversion.

Caps: 2 XRP per plan including gas, gas strictly below the amount and at most 0.5 XRP, 5 XRP per source wallet per UTC day, one in-flight plan per source wallet. The same `client_id` with different fields is a replay refusal.

Read the JSON. If the gateway, chain name, or memo values are not the ones above, stop.

```bash
npm run bridge:axelar -- review --plan-id ait... --confirm REVIEW-AXELAR-TESTNET
```

That writes an approval record and sets status `approved_unsigned`. It still does not sign.

```bash
npm run bridge:axelar -- sign
npm run bridge:axelar -- submit
```

Both exit `SIGNING_DISABLED`. Do not paste the unsigned Payment into `npm run signer`.

## XRPL EVM → XRPL (not reviewable yet)

```bash
npm run bridge:axelar -- plan \
  --direction evm-to-xrpl \
  --client-id return-leg-01 \
  --amount-wei 1000000000000000000 \
  --gas-value-wei 100000000000000000 \
  --from 0xYOURISOLATEDEVMADDRESS \
  --to rYOURISOLATEDXRPLADDRESS \
  --wallets machines/axelar-its-bridge/wallets.json
```

Expect `blocked.code` `NATIVE_VALUE_UNVERIFIED`, `evm_call.value_wei` null, and `review_ready` false. Review refuses the plan. Do not attach a native value by hand.

## Status

Default status does not touch the network.

```bash
npm run bridge:axelar -- status --plan-id ait...
npm run bridge:axelar -- status --plan-id ait... --xrpl-file ./xrpl.json --gmp-file ./gmp.json --proof-file ./proof.json
```

`status --fetch` is refused.

Honest states:

| Observation | Status | Final |
| --- | --- | --- |
| No source tx | `planned` or `approved_unsigned` | no |
| Validated `tesSUCCESS`, no known GMP status | `uncertain` | no |
| GMP `insufficient_fee` (and the other unpaid-gas statuses in the AxelarJS enum) | `recovery` | no |
| GMP `error` | `error` | no |
| GMP `cannot_fetch_status`, `unknown_error`, empty body, or a status string this pack does not recognize (including a bare `executed`) | `uncertain` | no |
| GMP `destination_executed` or `express_executed` **and** a destination proof whose tx hash matches | `final` | yes |

A source `tesSUCCESS` only means the XRPL payment was included. It does not mean the bridge settled. `funds_at_gateway_possible: true` means the drops may be sitting on the gateway without an automated refund. Add Gas is not implemented here. Do not invent that memo.

XRPL engine failures (`tec…`, `tef…`, and the other non-`tesSUCCESS` results) are `error` with `funds_at_gateway_possible: false`.

## Stellar

```bash
npm run bridge:axelar -- stellar
```

Expect `supported: false` and `implemented: false`. Do not point this command at a Stellar address.

## After a later approval to submit

That approval is a separate change. It would need an isolated signer, a re-verified pin, and an explicit operator action. It still would not use W0, the desk, or the current agent allowlist.
