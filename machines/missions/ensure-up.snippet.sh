# NOT installed. /workspace/foundry-ops/ensure-up.sh does not source this file.
# There is no cron on the box. Do not stop 127.0.0.1:8787, 8792, or 8793.
# Do not replace the armed release directory. Do not print or copy a GitHub token.
#
# Armed release, already running after ./bin/arm:
# RELEASE=/workspace/foundry-ops/releases/9e11391ed52d78261a7188881803ce0bad3b2bd0
# HOME_DIR=/workspace/foundry-ops/missions-runtime
# if ! [ -f "$HOME_DIR/worker.pid" ] || ! kill -0 "$(cat "$HOME_DIR/worker.pid")" 2>/dev/null; then
#   FOUNDRY_MISSION_HOME="$HOME_DIR" "$RELEASE/bin/start"
# fi
#
# Publisher, only when the parent has already put FOUNDRY_MISSION_GITHUB_TOKEN
# in the environment. This file does not read credentials. The next release
# uploads lab/missions/public-status.json only when its hash changes, and at
# most once every 15 minutes. The armed binary does not have that throttle yet,
# so do not run a publisher loop against it until that release is replaced.
