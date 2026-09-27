# Runbook

Foundry box. Secrets in `AETHER_SECRETS` or `/workspace/aether-foundry-secrets/.env`, mode 600. Never print them. Never run these signing commands in GitHub Actions.

Toolchain, if compile is needed again:

```bash
sudo apt-get install -y clang lld wabt
```

`clang` must have a `wasm32` target. `lld` provides `wasm-ld`. `wabt` provides `wasm-strip`.

## Already live

W7, the five destinations, and the trial payer are funded. The hook is installed. A 1 XAH split has validated. See `RESULTS.md`. Do not provision again unless `addresses.json` is missing.

## One-click from a clean box

```bash
npm install
npm run xahau:compile
npm run xahau:provision
npm run xahau:sethook -- --dry-run
npm run xahau:sethook -- --record
npm run xahau:trial -- --drops 1000000 --dry-run
npm run xahau:trial -- --drops 1000000 --record
```

`xahau:provision` POSTs `{}` to `https://xahau-test.net/accounts` with a User-Agent, writes each seed as soon as the faucet returns it, and writes public addresses to `addresses.json`. If that file already exists it prints the book and exits.

`xahau:sethook` reads `W7_SEED` (or `XAHAU_SEED`). The derived address must be the book’s W7. `--dry-run` autofills and does not sign. `--record` appends `xahau_set_hook` to `lab/ledger-log.jsonl` only after `tesSUCCESS`.

`xahau:trial` reads `W7_PAYER_SEED`. It pays W7 with SourceTag 7707, then checks five emits and balance deltas. `--record` appends `xahau_split_trial`.

## Reinstall

```bash
npm run xahau:compile
npm run xahau:sethook -- --override --dry-run
npm run xahau:sethook -- --override --record
```

`--override` sets Hook Flags to 1 (`hsfOVERRIDE`).

## What the scripts refuse

- `CI=true` or `GITHUB_ACTIONS=true` on any signing path
- Hosts other than `xahau-test.net` (including `xahau.network`, `ripple.com`, `xrplcluster.com`, `rippletest.net`)
- Network ID `0` and Xahau mainnet `21337`
- A seed whose address does not match the public book
