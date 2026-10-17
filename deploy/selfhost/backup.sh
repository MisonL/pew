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
# - Stages the copy in a fresh 0700 directory beside the target and renames it
#   into place only after validation: a failed same-day re-run must never
#   overwrite (or delete) an intact earlier archive, and a SIGKILLed run
#   cannot leave the archive world-readable (see the staging comment below).
# - Exits non-zero when .backup produced nothing, an empty file, or a
#   non-SQLite artifact, so a cron/systemd timer actually alerts instead of
#   keeping a silent bad file. The REPL cannot be trusted for this: it exits
#   0 even after printing `ERR! unauthorized`, so success is judged by the
#   archive on disk, and any stale archive from an interrupted earlier run is
#   removed before .backup starts.
#
# .env is sourced as shell: a password must be single-quoted there (an
# unquoted `$` expands, `$$` becomes the PID) and the file must not contain a
# bare `exit`. See the README backup section.
#
# Runs under bash 3.2 (macOS) as well as modern bash: the body is POSIX-safe
# (no arrays, no empty-array expansion under `set -u`).
set -eu
umask 077

cd "$(dirname "$0")"

# Load .env for the rqlite credentials. The script runs in its own shell, so
# exporting does not leak to the caller. .env is operator runtime state, not a
# tracked source file — hence the directive below.
# shellcheck disable=SC1091
if [ -f .env ]; then
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
if [ -d "$OUT" ]; then
  echo "backup.sh: output path is a directory: $OUT" >&2
  exit 1
fi
OUT_DIR=$(dirname "$OUT")
mkdir -p "$OUT_DIR"

# Stage inside a 0700 directory: `docker compose cp` preserves the
# container-side mode (0644 in the rqlite image) and ignores this shell's
# umask, so a staging file in a world-traversable directory would expose the
# archive — every password_hash/api_key — during the window before `chmod
# 600`, and PERMANENTLY if the run is SIGKILLed (no trap can run then). A
# 0700 parent keeps it unreadable either way, and mktemp guarantees a unique
# name. Staging beside OUT keeps the final `mv` on one filesystem.
STAGE=$(mktemp -d "$OUT_DIR/.pew-backup.XXXXXX")
TMP="$STAGE/backup.db"

# Best-effort cleanup on ANY exit: the staging directory and the in-container
# archive (same volume as the live db). The final OUT path is deliberately not
# touched here — validation below decides whether it may be replaced. Both
# commands are `|| true` so a failure here cannot abort the function and skip
# the in-container cleanup that follows.
# shellcheck disable=SC2329  # invoked via trap
cleanup() {
  rm -rf "$STAGE" 2>/dev/null || true
  docker compose exec -T "$SERVICE" rm -f /rqlite/file/backup.db >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Converge catchable signals onto the EXIT trap so the staging directory and
# the in-container copy are cleaned on Ctrl-C / systemd stop, not just on a
# normal exit. SIGKILL is uncatchable — the 0700 staging dir is what protects
# the archive in that case.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Clear any archive left behind by an interrupted earlier run: SIGKILL skips
# the cleanup trap, and the rqlite REPL exits 0 even when .backup fails (it
# prints `ERR! unauthorized` and still returns 0 — verified against rqlite
# 10.5.3). Without this, a failed run could copy and validate a STALE archive
# from a previous attempt and report success.
docker compose exec -T "$SERVICE" rm -f /rqlite/file/backup.db

if [ -n "${RQLITE_USERNAME:-}" ] && [ -n "${RQLITE_PASSWORD:-}" ]; then
  printf '.backup /rqlite/file/backup.db\n.exit\n' | \
    docker compose exec -T -e RQLITE_USERNAME -e RQLITE_PASSWORD "$SERVICE" \
      sh -c 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost'
else
  printf '.backup /rqlite/file/backup.db\n.exit\n' | \
    docker compose exec -T "$SERVICE" rqlite -H localhost
fi

# Success gate: the REPL's exit status cannot distinguish success from ERR!
# (see above), so the archive itself is the only trustworthy signal. A failed
# .backup leaves no file or a zero-byte one.
if ! docker compose exec -T "$SERVICE" sh -c 'test -s /rqlite/file/backup.db'; then
  echo "backup.sh: .backup produced no archive — check credentials and rqlite logs above" >&2
  exit 1
fi

docker compose cp "$SERVICE:/rqlite/file/backup.db" "$TMP"
# 0600 immediately: the copy arrives with the container-side 0644 (tar mode
# preserves it, ignoring this shell's umask) and the archive holds every
# password_hash/api_key.
chmod 600 "$TMP"

if [ ! -s "$TMP" ]; then
  echo "backup.sh: backup is empty — .backup failed (see output above)" >&2
  exit 1
fi
# Second check: a non-empty but corrupt artifact (error page, zero-filled
# stub) has no SQLite header. This is a FORMAT gate, not an integrity check —
# a truncated or header-only file still passes it; full verification is
# `sqlite3 <archive> 'PRAGMA integrity_check'` on a trusted host, recommended
# after any restore drill.
if ! printf 'SQLite format 3\000' | cmp -s -n 16 - "$TMP"; then
  echo "backup.sh: backup is not a SQLite database — refusing to keep it" >&2
  exit 1
fi

# Atomic replace: only a validated archive ever reaches the final path. The
# archive was chmod 0600 right after the copy and `mv` preserves the mode.
mv "$TMP" "$OUT"
echo "backup written to $OUT"
