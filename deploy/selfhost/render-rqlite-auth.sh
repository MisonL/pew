#!/bin/sh
# Renders deploy/selfhost/.rqlite-auth.json (spec Plan 3 §3.1.2).
# Three vars must ALL be set (RQLITE_USERNAME / RQLITE_PASSWORD /
# RQLITE_JOIN_PASSWORD) or nothing is produced and leftovers are removed —
# a half-configured .env must never yield a partial credential file.
# NOTE: there is deliberately no pew-ro read-only entry — rqlite 10.5.3 has no
# "select" permission name, and read/scheduler carry /db/request write paths,
# so a read-only user is unreachable in this architecture.
set -eu
umask 077
OUT="${AUTH_OUT_FILE:-$(dirname "$0")/.rqlite-auth.json}"
# Guard rm -rf against a nonsensical AUTH_OUT_FILE pointing at system paths —
# the stale-file cleanup below must never nuke one. (/var is deliberately NOT
# listed: macOS temp dirs live under /var/folders, and the default output is
# a repo-relative path anyway.)
case "$OUT" in /|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*)
  echo "render-rqlite-auth: refusing dangerous AUTH_OUT_FILE: $OUT" >&2; exit 1;; esac

if [ -z "${RQLITE_USERNAME:-}" ] || [ -z "${RQLITE_PASSWORD:-}" ] || [ -z "${RQLITE_JOIN_PASSWORD:-}" ]; then
  rm -rf "$OUT"   # rm -rf also removes the directory docker may have created for a missing bind-mount
  if [ -n "${RQLITE_USERNAME:-}${RQLITE_PASSWORD:-}${RQLITE_JOIN_PASSWORD:-}" ]; then
    echo "render-rqlite-auth: RQLITE_USERNAME, RQLITE_PASSWORD and RQLITE_JOIN_PASSWORD must all be set (or all empty)" >&2
    exit 1
  fi
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "render-rqlite-auth: jq is required but not installed" >&2; exit 1; }

jq -n \
  --arg u "$RQLITE_USERNAME" --arg p "$RQLITE_PASSWORD" --arg jp "$RQLITE_JOIN_PASSWORD" \
  '[
    { username: $u, password: $p, perms: ["all"] },
    { username: "joiner", password: $jp, perms: ["join"] },
    { username: "*", perms: ["status", "ready"] }
  ]' > "$OUT.tmp"
# Write-then-rename: a killed render must never leave a half-written auth file.
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"
