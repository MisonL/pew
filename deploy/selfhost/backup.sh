#!/usr/bin/env bash
# One-shot rqlite backup for the selfhost stack, cron/systemd-timer safe.
#
# Usage: bash backup.sh [output-path]   (default: <script dir>/backup-YYYY-MM-DD.db)
#
# Trust assumption: sourcing ./.env executes it as shell (load-bearing for the
# credentials). .env is operator-owned state next to the compose file; keep it
# 0600 and never copy one in from an untrusted source.
#
# - Reads RQLITE_USERNAME/RQLITE_PASSWORD from ./.env (the rqlite REPL needs
#   -u when auth is enabled; anonymous .backup gets 401). A half-filled pair
#   counts as unset, same rule as resolveBasicAuth in basic-auth.ts.
# - Credentials reach the container through its ENVIRONMENT (docker exec -e
#   forwards the value from this shell): argv is world-readable in `ps`, the
#   environment is not. Same rule as reset-password.ts. A password with
#   spaces therefore needs no array quoting games.
# - chmod 600 immediately after the copy: the archive contains every
#   password_hash/api_key, and docker compose cp PRESERVES the container-side
#   mode (644 in the rqlite image), ignoring this shell's umask.
# - Writes to a temp name and renames only after validation: a failed same-day
#   re-run must never overwrite (or delete) an intact earlier archive.
# - Exits non-zero when the archive is empty or not SQLite, so a cron/systemd
#   timer actually alerts instead of keeping a silent bad file.
#
# Runs under bash 3.2 (macOS) as well as modern bash: the body is POSIX-safe
# (no arrays, no empty-array expansion under `set -u`).
set -eu
umask 077

cd "$(dirname "$0")"

# Load .env for the rqlite credentials. The script runs in its own shell, so
# exporting does not leak to the caller. .env is operator runtime state next
# to the compose file, not a tracked source file, so shellcheck is told to
# stop here for this one directive.
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

# Cluster profile has no `rqlite` service; the leader is rqlite-1 (README).
# Comma-form lists (COMPOSE_PROFILES=single,test) must still match.
SERVICE=rqlite
case ",${COMPOSE_PROFILES:-single}," in
  *,cluster,*) SERVICE=rqlite-1 ;;
esac

OUT="${1:-backup-$(date +%F).db}"
# A cron target directory (/var/backups/pew) usually does not exist yet;
# `docker compose cp` refuses a missing parent, so create it up front.
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.tmp.$$"

# Best-effort cleanup on ANY exit: the in-container archive (same volume as
# the live db) and the temp file. The final OUT path is deliberately not
# touched here — validation below decides whether it may be replaced.
# shellcheck disable=SC2329  # invoked via trap
cleanup() {
  rm -f "$TMP"
  docker compose exec -T "$SERVICE" rm -f /rqlite/file/backup.db >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -n "${RQLITE_USERNAME:-}" ] && [ -n "${RQLITE_PASSWORD:-}" ]; then
  printf '.backup /rqlite/file/backup.db\n.exit\n' | \
    docker compose exec -T -e RQLITE_USERNAME -e RQLITE_PASSWORD "$SERVICE" \
      sh -c 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost'
else
  printf '.backup /rqlite/file/backup.db\n.exit\n' | \
    docker compose exec -T "$SERVICE" rqlite -H localhost
fi

docker compose cp "$SERVICE:/rqlite/file/backup.db" "$TMP"
chmod 600 "$TMP"

if [ ! -s "$TMP" ]; then
  echo "backup.sh: backup is empty — .backup failed (see output above)" >&2
  exit 1
fi
# Second check: a non-empty but corrupt artifact (partial write, error page)
# has no SQLite header. The README establishes 'SQLite format 3' as the
# acceptance property of a valid backup.
if ! printf 'SQLite format 3\000' | cmp -s -n 16 - "$TMP"; then
  echo "backup.sh: backup is not a SQLite database — refusing to keep it" >&2
  exit 1
fi

# Atomic replace: only a validated archive ever reaches the final path.
mv "$TMP" "$OUT"
echo "backup written to $OUT"
