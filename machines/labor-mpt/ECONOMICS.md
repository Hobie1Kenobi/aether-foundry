# ECONOMICS — Labor MPT

## What the token is for

A labor unit is one whole MPT (`AssetScale` 0), not a slice of the AETH IOU. The AMM pool stays AETH issued by W0 against XRP. Labor does not set `tfMPTCanTrade`, so it does not become a second book.

The cap is `MaximumAmount` `"1000000"`. The issuance cannot grow past one million units. Outstanding starts at zero. Authorize and opt-in create the holder object. They do not pay units out.

## Costs

| Item | Effect |
|------|--------|
| `server_info` / `feature` / `account_info` | Read. No fee. |
| `MPTokenIssuanceCreate` | One owner reserve on W5 for the issuance object, plus the base fee. No XRP payment. |
| `MPTokenAuthorize` (issuer) | Base fee on W5. |
| `MPTokenAuthorize` (holder opt-in) | One owner reserve on the holder for the `MPToken` object, plus the base fee. |

None of these move 50 XRP, so none of them need `lab/motions/`. A later escrow at or above 50 XRP still does.

## Floor

Transfer fee is `0`. Secondary transfers, once F3 or a payment exists, do not skim a percentage back to W5.

## Archive

Until the first `tesSUCCESS`, `lab/metrics.json` keeps `mpt_issuance_id` null and `/api/status` reports null. A live create writes the 48-hex id the transaction metadata returned. It does not write the dry-run prediction. Do not type one in.
