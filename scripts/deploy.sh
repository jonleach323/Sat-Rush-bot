#!/usr/bin/env bash
#
# On-box deploy for the git-clone-on-server flow: pull the branch, install, build,
# restart the service, and tail logs. Run as a sudoer (it uses `sudo -u satrush`
# for the satrush-owned repo and `sudo systemctl` for the service).
#
#   sudo bash /opt/satrush/scripts/deploy.sh
#
# Secrets are never touched: /etc/satrush/.env, keypairs/, and data/ are left
# exactly as they are on disk. This only moves CODE.
set -euo pipefail

DIR="${SATRUSH_DIR:-/opt/satrush}"
BRANCH="${SATRUSH_BRANCH:-claude/sat-rush-strategy-client-1elnqw}"
SVC="${SATRUSH_SERVICE:-satrush}"
USER_="${SATRUSH_USER:-satrush}"

echo "▶ fetch + reset $BRANCH"
sudo -u "$USER_" git -C "$DIR" fetch origin "$BRANCH"
sudo -u "$USER_" git -C "$DIR" reset --hard "origin/$BRANCH"
echo "  now at $(sudo -u "$USER_" git -C "$DIR" rev-parse --short HEAD)"

echo "▶ install deps (compiles better-sqlite3 against this box)"
# cd into the repo so corepack reads THIS package.json for the pnpm version —
# `pnpm -C` alone isn't enough (corepack checks cwd before pnpm honors -C, and a
# home-dir package.json the user can't read would EACCES).
sudo -u "$USER_" bash -c "cd '$DIR' && pnpm install --frozen-lockfile"

echo "▶ build (tsc — also the typecheck gate; aborts the deploy on error)"
sudo -u "$USER_" bash -c "cd '$DIR' && pnpm -s build"

echo "▶ restart $SVC"
sudo systemctl restart "$SVC"
sleep 2
if systemctl is-active --quiet "$SVC"; then
  echo "✓ $SVC active"
else
  echo "✗ $SVC failed to start — recent logs:"
  sudo journalctl -u "$SVC" -n 40 --no-pager
  exit 1
fi

echo "▶ tailing $SVC (Ctrl-C to stop; the service keeps running)"
sudo journalctl -u "$SVC" -n 20 -f
