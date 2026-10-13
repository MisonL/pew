#!/bin/sh
# Renders deploy/selfhost/.rqlite-auth.json (spec Plan 3 §3.1.2).
# Three vars must ALL be set (RQLITE_USERNAME / RQLITE_PASSWORD /
# RQLITE_JOIN_PASSWORD) or nothing is produced and leftovers are removed —
# a half-configured .env must never yield a partial credential file.
set -eu
umask 077
OUT="${AUTH_OUT_FILE:-$(dirname "$0")/.rqlite-auth.json}"

if [ -z "${RQLITE_USERNAME:-}" ] || [ -z "${RQLITE_PASSWORD:-}" ] || [ -z "${RQLITE_JOIN_PASSWORD:-}" ]; then
  rm -rf "$OUT"   # rm -rf also removes the directory docker may have created for a missing bind-mount
  if [ -n "${RQLITE_USERNAME:-}${RQLITE_PASSWORD:-}${RQLITE_JOIN_PASSWORD:-}" ]; then
    echo "render-rqlite-auth: RQLITE_USERNAME, RQLITE_PASSWORD and RQLITE_JOIN_PASSWORD must all be set (or all empty)" >&2
    exit 1
  fi
  exit 0
fi

jq -n \
  --arg u "$RQLITE_USERNAME" --arg p "$RQLITE_PASSWORD" --arg jp "$RQLITE_JOIN_PASSWORD" \
  --arg p2 "${RQLITE_READ_PASSWORD:-$RQLITE_PASSWORD}" \
  '[
    { username: $u, password: $p, perms: ["all"] },
    { username: "pew-ro", password: $p2, perms: ["select"] },
    { username: "joiner", password: $jp, perms: ["join"] },
    { username: "*", perms: ["status", "ready"] }
  ]' > "$OUT"
chmod 600 "$OUT"
