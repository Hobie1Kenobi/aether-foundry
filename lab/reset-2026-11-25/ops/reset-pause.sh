#!/usr/bin/env bash
# Pause Testnet-touching Foundry box services for the 2026-11-25 XRPL Testnet reset.
# Install: cp to /workspace/foundry-ops/. Run Wed 2026-11-25 ~18:45 CT. No secrets read or printed.
# Leaves the missions worker / payments worker alone (rule: don't touch them).
set -u
OPS=/workspace/foundry-ops
date '+%F %T %Z' > "$OPS/RESET-PAUSE"          # ensure-up.sh exits early while this file exists
bash "$OPS/stop.sh" || true                       # herald, walk-in loop, signer, scribe, license
sh "$OPS/w1-dex-runtime/stop.sh" || true          # W1 DEX supervisor
for r in w3 w4 w5; do                             # W3 taker / W4 quoter / W5 RLUSD oracle
  pf="$OPS/dex-roles/$r/supervisor.pid"
  if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then kill "$(cat "$pf")" && echo "stopped $r"; fi
done
sleep 2
pgrep -af 'signer.js|herald.js|walk-in-remint-watch|dex/supervisor.js' | cut -c1-120 || echo "all Testnet services stopped"
