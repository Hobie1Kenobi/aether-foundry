# Documented only. Do not source this from bin/start, cron, or the missions worker.
# Paste the block before the host ensure-up script's final `exit 0` if these
# roles should come back after a restart. A live pid is left alone.
# Does not read or print key files. Does not signal 127.0.0.1:8787, 8792, or 8793.
# Does not start the missions payment worker and does not touch msn5b5c3223e5e88526.

ROOT=/workspace/aether-foundry
HOME_DIR=/workspace/foundry-ops/dex-roles
mkdir -p "$HOME_DIR"

start_once() {
  local name="$1"
  shift
  local pidfile="$HOME_DIR/${name}.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  (
    cd "$ROOT" || exit 1
    "$@" >> "$HOME_DIR/${name}.log" 2>&1 &
    echo $! > "$pidfile"
  )
}

if [ "${FOUNDRY_W1_DEX_SUPERVISOR:-}" = "yes" ]; then
  start_once w1 env FOUNDRY_DEX_ROLE=W1 node src/business/dex/supervisor.js
fi
if [ "${FOUNDRY_W3_DEX_SUPERVISOR:-}" = "yes" ]; then
  start_once w3 env FOUNDRY_DEX_ROLE=W3 node src/business/dex/supervisor.js
fi
if [ "${FOUNDRY_W4_DEX_SUPERVISOR:-}" = "yes" ]; then
  start_once w4 env FOUNDRY_DEX_ROLE=W4 node src/business/dex/supervisor.js
fi
if [ "${FOUNDRY_W5_ORACLE_SUPERVISOR:-}" = "yes" ]; then
  start_once w5-oracle node src/business/dex/oracle.js --supervise
fi
