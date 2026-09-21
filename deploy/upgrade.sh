#!/usr/bin/env bash
# On-box upgrade of a running deployment, as ONE command:
#
#   sudo /opt/satrush/deploy/upgrade.sh [branch-or-rev]
#
# fetch → checkout → install → build → verify dist matches HEAD → env:migrate
# → preflight → restart → wait for the boot line and confirm the revision the
# service reports is the one just built. Replaces the hand-typed sudo chains
# that ran yesterday's dist after a `git pull` without `pnpm build`.
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/opt/satrush}"
ENV_FILE="${ENV_FILE:-/etc/satrush/.env}"
SERVICE="${SERVICE:-satrush}"
USER_="${SERVICE_USER:-satrush}"
TARGET="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 ${TARGET}" >&2
  exit 2
fi
cd "$REMOTE_DIR"

as_user() { sudo -u "$USER_" env "PATH=$PATH" "$@"; }

echo "── backup (db, keys, env) ──"
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$REMOTE_DIR/backups"
tar czf "$REMOTE_DIR/backups/pre-upgrade-$TS.tgz" -C / "${REMOTE_DIR#/}/data" "${REMOTE_DIR#/}/keypairs" "${ENV_FILE#/}" 2>/dev/null || true
chmod 600 "$REMOTE_DIR/backups/pre-upgrade-$TS.tgz"

echo "── fetch + checkout ──"
as_user git fetch --prune origin
if [ -n "$TARGET" ]; then
  if as_user git show-ref --verify --quiet "refs/remotes/origin/$TARGET"; then
    as_user git checkout -q -B "$TARGET" "origin/$TARGET"
  else
    as_user git checkout -q "$TARGET"
  fi
else
  BRANCH=$(as_user git rev-parse --abbrev-ref HEAD)
  as_user git merge -q --ff-only "origin/$BRANCH"
fi
REV=$(as_user git rev-parse --short HEAD)
echo "checked out $REV ($(as_user git log -1 --format=%s))"

echo "── install + build ──"
as_user pnpm install --frozen-lockfile
as_user pnpm build
# dist must be newer than every source file, or the service runs old code.
NEWEST_SRC=$(find src -type f -printf '%T@\n' | sort -n | tail -1)
DIST_AT=$(stat -c %Y dist/index.js)
if [ "${DIST_AT%.*}" -lt "${NEWEST_SRC%.*}" ]; then
  echo "dist/index.js is older than src — build did not produce a fresh dist" >&2
  exit 1
fi

echo "── env migrate + preflight ──"
as_user pnpm env:migrate "$ENV_FILE" --write || true
chown root:"$USER_" "$ENV_FILE" && chmod 640 "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a
if ! as_user env DOTENV_CONFIG_PATH="$ENV_FILE" pnpm preflight; then
  echo "preflight FAILED — not restarting; the previous build keeps running" >&2
  exit 1
fi

echo "── restart ──"
install -m 644 deploy/satrush.service "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

echo "── verify the running revision ──"
for _ in $(seq 1 30); do
  sleep 1
  LINE=$(journalctl -u "$SERVICE" --since "-90s" -o cat 2>/dev/null | grep -m1 '"orchestrator started"' || true)
  if [ -n "$LINE" ]; then
    RUNNING=$(printf '%s' "$LINE" | sed -n 's/.*"rev":"\([0-9a-f]*\)".*/\1/p')
    if [ "$RUNNING" = "$REV" ]; then
      echo "service reports rev $RUNNING — upgrade complete"
      if journalctl -u "$SERVICE" --since "-90s" -o cat | grep -q "STALE BUILD"; then
        echo "WARNING: the service logged STALE BUILD" >&2; exit 1
      fi
      exit 0
    fi
    echo "service reports rev '$RUNNING', expected $REV" >&2
    exit 1
  fi
done
echo "no boot line within 30 s — check: journalctl -u $SERVICE -n 50" >&2
exit 1
