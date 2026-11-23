#!/usr/bin/env bash
# Resume after PLAN.md phase 8 verification passes. No secrets read or printed.
set -u
OPS=/workspace/foundry-ops
rm -f "$OPS/RESET-PAUSE"
bash "$OPS/ensure-up.sh"
sleep 8
bash "$OPS/status.sh"
pgrep -af 'dex/supervisor.js' | cut -c1-120
