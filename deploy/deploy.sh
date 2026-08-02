#!/usr/bin/env bash
# Deploy the Sat Rush client to the VPS.
#
#   ./deploy/deploy.sh user@vps [remote_dir]
#
# What it does: verify + build locally, rsync the repo (NEVER .env, keypairs/
# or data/), install deps + the systemd unit remotely, restart, tail logs.
#
# One-time server setup (by hand, never through this script):
#   sudo useradd -r -m -d /opt/satrush satrush
#   sudo mkdir -p /etc/satrush /opt/satrush/keypairs /opt/satrush/data
#   sudo cp .env  ->  /etc/satrush/.env          (root:satrush, chmod 640)
#   scp keypair   ->  /opt/satrush/keypairs/operator.json  (satrush, chmod 600)
# The env file must set KEYPAIR_PATH=/opt/satrush/keypairs/operator.json and
# DB_PATH=/opt/satrush/data/satrush.db.

set -euo pipefail

HOST="${1:?usage: deploy/deploy.sh user@vps [remote_dir]}"
REMOTE_DIR="${2:-/opt/satrush}"

echo "── local verify + build ──"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

echo "── rsync → $HOST:$REMOTE_DIR (secrets excluded) ──"
rsync -az --delete --info=stats1 \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --include '.env.example' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'keypairs/' \
  --exclude 'data/' \
  --exclude '*.db' --exclude '*.db-*' \
  --exclude 'KILL' \
  ./ "$HOST:$REMOTE_DIR/"

echo "── remote install + unit reload ──"
# Full install (not --prod): tsx is needed on the box for pnpm preflight and
# scripts/experiments/*; better-sqlite3 must compile on the server's ABI.
ssh "$HOST" REMOTE_DIR="$REMOTE_DIR" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
pnpm install --frozen-lockfile
sudo install -m 644 deploy/satrush.service /etc/systemd/system/satrush.service
sudo systemctl daemon-reload
sudo systemctl enable satrush >/dev/null
sudo systemctl restart satrush
sleep 2
systemctl --no-pager --lines=0 status satrush
REMOTE

echo "── tailing logs (ctrl-c to detach; the service keeps running) ──"
exec ssh -t "$HOST" "journalctl -u satrush -f -n 40"
