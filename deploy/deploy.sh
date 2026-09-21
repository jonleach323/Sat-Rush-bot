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
# The app tree is owned by the service user and closed to other logins, so
# rsync runs as root on the far end and ownership is restored afterwards.
rsync -az --delete --info=stats1 --rsync-path="sudo rsync" \
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
# Everything on the box runs under sudo with the `cd` inside it: the login
# user cannot enter the service user's tree, and the env file is root's.
ssh "$HOST" REMOTE_DIR="$REMOTE_DIR" 'sudo env "PATH=$PATH" REMOTE_DIR="$REMOTE_DIR" bash -s' <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
chown -R satrush:satrush "$REMOTE_DIR"
# Backup before anything changes: state db, keys, env (the only things that
# are not reproducible). Kept under the app tree, root-readable only.
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$REMOTE_DIR/backups"
tar czf "$REMOTE_DIR/backups/pre-upgrade-$TS.tgz" -C / "opt/satrush/data" "opt/satrush/keypairs" "etc/satrush/.env" 2>/dev/null || true
chmod 600 "$REMOTE_DIR/backups/pre-upgrade-$TS.tgz"
sudo -u satrush env "PATH=$PATH" pnpm install --frozen-lockfile
# V1 → V2 env migration: comments out hand-set values the V2 bot derives
# (a V1 MAX_PER_ROUND_USD would cap every round) and obsolete keys; a
# timestamped .bak sits next to the file.
pnpm env:migrate /etc/satrush/.env --write || true
chown root:satrush /etc/satrush/.env && chmod 640 /etc/satrush/.env
# Preflight against the migrated env: stale facts or a config gate abort the restart.
set -a; . /etc/satrush/.env; set +a
pnpm preflight
install -m 644 deploy/satrush.service /etc/systemd/system/satrush.service
systemctl daemon-reload
systemctl enable satrush >/dev/null
systemctl restart satrush
sleep 2
systemctl --no-pager --lines=0 status satrush
REMOTE

echo "── tailing logs (ctrl-c to detach; the service keeps running) ──"
exec ssh -t "$HOST" "journalctl -u satrush -f -n 40"
