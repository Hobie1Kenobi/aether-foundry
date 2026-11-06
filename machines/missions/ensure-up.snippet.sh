# Parent may paste this into /workspace/foundry-ops/ensure-up.sh.
# It is not sourced until then. Do not add a cron entry.
# Does not signal 127.0.0.1:8787, 8792, or 8793.
# Does not print tokens.env or account.json.

HOME_DIR=/workspace/foundry-ops/missions-runtime
RELEASE=/workspace/foundry-ops/releases/REPLACE_WITH_RELEASE_SHA
TOKENS="$HOME_DIR/tokens.env"
ACCOUNT="$HOME_DIR/account.json"

mode_ok() {
  [ -f "$1" ] && [ "$(stat -c %a "$1" 2>/dev/null || true)" = "600" ]
}

if [ -f "$TOKENS" ]; then
  if ! mode_ok "$TOKENS"; then
    echo "tokens.env must be mode 0600" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$TOKENS"
  set +a
fi

unset W0_SEED W1_SEED W2_SEED W3_SEED W4_SEED W5_SEED W6_SEED W7_SEED \
  W1_REGULAR_SEED W2_REGULAR_SEED W3_REGULAR_SEED W4_REGULAR_SEED \
  W5_REGULAR_SEED W6_REGULAR_SEED AETHER_SECRETS FOUNDRY_AGENT_SIGN

if [ -f "$ACCOUNT" ] && ! mode_ok "$ACCOUNT"; then
  echo "account.json must be mode 0600" >&2
  exit 1
fi

if [ -x "$RELEASE/bin/start" ]; then
  if [ ! -f "$HOME_DIR/worker.pid" ] || ! kill -0 "$(cat "$HOME_DIR/worker.pid")" 2>/dev/null; then
    FOUNDRY_MISSION_HOME="$HOME_DIR" "$RELEASE/bin/start"
  fi
fi
