# Mission release install

The packed tarball replaces this file with one that names the git SHA. Unpack only into `/workspace/foundry-ops/releases/<sha>`. Leave `/workspace/aether-foundry` and its running signer, scribe, and license processes alone.

`bin/start` launches the worker asleep. `FOUNDRY_MISSION_RUN=yes node src/missions/runner.js` is a one-shot ready print, not this worker.

Exact dependency: `xrpl@5.3.0`, locked in `package-lock.json`, installed with `npm ci --omit=dev` from the public npm registry. Node `>=20.19`. No new paid service.
