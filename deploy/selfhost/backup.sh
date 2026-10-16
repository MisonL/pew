#!/usr/bin/env bash
# One-shot rqlite backup for the selfhost stack, cron/systemd-timer safe.
#
# Usage: bash backup.sh [output-path]   (default: ./backup-YYYY-MM-DD.db)
#
# - Reads RQLITE_USERNAME/RQLITE_PASSWORD from ./.env (the rqlite REPL needs
#   -u when auth is enabled; anonymous .backup gets 401).
# - Array-form credentials: a password containing spaces must survive as ONE
#   argument — `-u "$u:$p"` inline expansion would word-split and truncate it.
# - umask 077 + chmod 600: the archive contains every password_hash/api_key.
# - Exits non-zero on an empty archive, so a cron/systemd timer actually
#   alerts instead of leaving a silent 0-byte file.
#
# Requires bash (arrays); the deployment target's /bin/sh may be dash.
set -eu
umask 077

cd "$(dirname "$0")"

# Load .env for the rqlite credentials. The script runs in its own shell, so
# exporting does not leak to the caller.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# Cluster profile has no `rqlite` service; the leader is rqlite-1 (README).
SERVICE=rqlite
if [ "${COMPOSE_PROFILES:-single}" = "cluster" ]; then
  SERVICE=rqlite-1
fi

OUT="${1:-backup-$(date +%F).db}"

RQLITE_ARGS=()
[ -n "${RQLITE_USERNAME:-}" ] && RQLITE_ARGS=(-u "$RQLITE_USERNAME:${RQLITE_PASSWORD:-}")

printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T "$SERVICE" rqlite "${RQLITE_ARGS[@]}" -H localhost

docker compose cp "$SERVICE:/rqlite/file/backup.db" "$OUT"
# Cleanup before any later failure: the in-container copy would otherwise sit
# in the rqlite volume forever (one file per run is overwritten, but the
# restore runbook's discipline is to not leave archives in the volume).
docker compose exec -T "$SERVICE" rm -f /rqlite/file/backup.db

if [ ! -s "$OUT" ]; then
  echo "backup.sh: backup is empty — .backup failed (see output above)" >&2
  rm -f "$OUT"
  exit 1
fi
# After the emptiness check: chmod on a missing file would mask the real error.
chmod 600 "$OUT"
echo "backup written to $OUT"
