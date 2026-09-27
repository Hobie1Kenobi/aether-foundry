# THREAT — Work-Ticket Escrow v0

## Adversary / failure notes

### Stuck escrow (observed)

**Incident:** First Trial A create `6B9528CCE3F90E39A6D6E1A8A1F1E637E1A38B575F0DDB105785D3A66A319462` used **Unix** timestamps in FinishAfter/CancelAfter. XRPL expects **Ripple Epoch**. Those values decode to ~year 2056 → 10 XRP locked on BUYER `rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth` until then (OwnerCount includes that escrow).

**Mitigation:** Always `FinishAfter = unix_now - 946684800 + delta`. Documented in RUNBOOK. Retried Trial A with correct epoch → finish OK.

### Reserve drain

- Attacker/spammer could open many escrow objects on a shared custodian if W4 were Owner; v0 makes **BUYER** the Owner so reserve hits the client.
- W1 offer spam similarly burns owner reserve (0.2 XRP each).

### Unfunded finish

- EscrowFinish needs fee + optional signer reserve. If W4 is empty, finish can be submitted by BUYER or any account after FinishAfter (unconditional escrow).
- Conditioned escrow (future) without published fulfillment → permanent lock until CancelAfter.

### NFT / escrow desync

- v0 does not atomically bind NFT transfer to escrow finish. BUYER may hold Artifact while cancelling escrow (Trial B) or fail to finish after receiving NFT.
- Future: brokered flow, or conditioned escrow with fulfillment held by Atelier.

### Passive CLOB self-cross

- Asking AETH/XRP rates on the wrong side of mid causes self-match or `tfPassive` kill. Housekeeping used wider non-crossing wings.

### Seed exposure

- Seeds only in `/workspace/aether-foundry-secrets/.env` (chmod 600). Never commit. Rotate if leaked.
