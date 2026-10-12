# THREAT — Agent Work License

## Replay

**Threat:** A captured challenge signature is posted twice and the agent does the job twice.

**Mitigation:** The nonce is 16 random bytes. It is written to `lab/licenses/nonces.jsonl` after the signature verifies and before `account_nfts`. A second post is `REPLAY` (HTTP 409) even if the first post failed the holder check. Challenge expiry is 120 seconds, and the signer will not sign an `exp` more than 10 minutes ahead.

## Wrong holder

**Threat:** An account signs a challenge for a token it does not hold, or quotes another account's classic address.

**Mitigation:** The challenge text binds `account` and `nftoken_id`. The signature must recover to that account or to the regular key registered for it. `account_nfts` on a validated ledger must list that token, issued by W2, taxon `20261012`. A mismatch is `HOLDER` and the work does not run.

## Expired or spent

**Threat:** A license past `expiry`, or past its use count, still gets a report.

**Mitigation:** Expiry is inside the hashed metadata committed by the URI. Uses are the count of `license_redeemed` rows for that `NFTokenID`. Either failure returns before deliver. The last successful use asks the holder to burn. Burning is what takes the token off the ledger. The log is what stops a second job if the burn has not landed yet.

## Signer scope

**Threat:** The new endpoint becomes a general signing oracle, or a license sale moves 10 XRP, or W1 mints a lookalike.

**Mitigation:** `/sign-challenge` rejects any body that contains `tx`. The string must be the six-line challenge, and the account line must be W4. `NFTokenBurn` is refused unless the intent is `license_burn` and the wallet is W4. Mint and list are W2 only, with the taxon, flags, fee, and 2 XRP amount fixed. Buy is W4 only, and the signer reads the offer itself. Network id must be 1 before any of those signatures. CI cannot start the signer. The demo does not load a seed.

W0 is still refused. Mainnet hosts and network ids `0` and `21337` are still refused. A signed blob is submitted on the connection that autofilled it, not on a second host.

## Regular key versus account

**Threat:** The check "signature matches the classic address" is pointed at the wrong address, so W4's regular key looks like a stranger, or a stranger's key is accepted as W4.

**Mitigation:** For an outside holder, the derived address must equal the claimed account. For W4, the derived address must equal the regular key in `activated.json` for that account. A key that is neither is `SIGNATURE`. The NFT holder checked on-ledger is always the account in the challenge, which for the demo is W4's account, not the regular key account.

## Resale fee

**Threat:** Treating the 5% as if it came out of W4's 2 XRP purchase, or as if the watch should remint a sold license.

**Mitigation:** The issuer's own sale does not pay `TransferFee`. The fee appears when a non-issuer sells. The watch records a sold-out license line and stops. It does not submit `NFTokenMint`.

## Metadata swap

**Threat:** The server trusts a JSON body from the buyer instead of the URI on the token.

**Mitigation:** The buyer does not send the metadata. The server decodes the URI from `account_nfts` and loads the file whose canonical hash is that URI. A file that hashes differently is ignored.

## Scribe

**Threat:** A remote model is required to finish the job, or a summary call leaves the loopback.

**Mitigation:** Deliver reads the ledger first. Scribe is optional and only `127.0.0.1`. Failure keeps a deterministic sentence. The receipt says which source wrote it.
