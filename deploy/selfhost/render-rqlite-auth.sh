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
# Normalize duplicate leading slashes BEFORE the guard: "//etc" would otherwise
# slip past the case patterns (S1) while `rm -rf //etc` still deletes /etc.
# Pure shell (no tr/sed): this must run even with an empty PATH, before the
# jq-missing guard fires.
while :; do
  case "$OUT" in //*) OUT="${OUT#/}";; *) break;; esac
done
# Guard rm -rf against a nonsensical AUTH_OUT_FILE: system paths as below,
# and relative "." / ".." / trailing-dot components, which would let a stray
# AUTH_OUT_FILE=.. (wrong cwd, typo) delete the parent tree. (/var is
# deliberately NOT listed: macOS temp dirs live under /var/folders, and the
# default output is a repo-relative path anyway.)
case "$OUT" in /|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*)
  echo "render-rqlite-auth: refusing dangerous AUTH_OUT_FILE: $OUT" >&2; exit 1;; esac
case "$OUT" in .|..|*/|/.|/..|*/.|*/..|*/../*|*/./*)
  echo "render-rqlite-auth: refusing relative or self-referential AUTH_OUT_FILE: $OUT" >&2; exit 1;; esac
# A leading '-' is parsed as an OPTION by mv/rm: the jq write would succeed
# (leaving a 0600 file of plaintext passwords), then `mv` and the EXIT trap's
# `rm -f "$OUT.tmp"` both fail with "illegal option", so the temp file stays
# behind. Its name matches no ignore rule. Same guard as backup.sh.
case "$OUT" in -*)
  echo "render-rqlite-auth: refusing AUTH_OUT_FILE starting with '-': $OUT" >&2; exit 1;; esac

# Remove a leftover credential artefact, but never a populated directory.
# - regular file / symlink: `rm -f` (a stale render must not survive)
# - empty directory:        `rmdir` (the bind-mount stub Docker creates)
# - populated directory:    refuse — that means AUTH_OUT_FILE points at a real
#   directory, and `rm -rf` there would destroy it (verified: it did).
remove_stale() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    rmdir "$1" 2>/dev/null || {
      echo "render-rqlite-auth: refusing to remove non-empty directory: $1" >&2; return 1; }
  else
    rm -f "$1"
  fi
}

if [ -z "${RQLITE_USERNAME:-}" ] || [ -z "${RQLITE_PASSWORD:-}" ] || [ -z "${RQLITE_JOIN_PASSWORD:-}" ]; then
  remove_stale "$OUT" || exit 1
  if [ -n "${RQLITE_USERNAME:-}${RQLITE_PASSWORD:-}${RQLITE_JOIN_PASSWORD:-}" ]; then
    echo "render-rqlite-auth: RQLITE_USERNAME, RQLITE_PASSWORD and RQLITE_JOIN_PASSWORD must all be set (or all empty)" >&2
    exit 1
  fi
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "render-rqlite-auth: jq is required but not installed" >&2; exit 1; }

# The temp file holds every plaintext password. A SIGKILL between the jq write
# and the rename would otherwise leave it behind — and `*.auth.json` ignore
# rules do not match a `.tmp` suffix, so it could enter git or an image layer.
trap 'rm -f "$OUT.tmp"' EXIT INT TERM HUP

# Same bind-mount directory trap as the stale-file cleanup above, but on the
# SUCCESS path: if $OUT is a directory, `mv "$OUT.tmp" "$OUT"` moves the file
# INTO the directory and `chmod` on the directory exits 0 — the entrypoint's
# [ -f ] check would then be false and rqlite would start WITHOUT auth,
# silently. Remove the directory first (N1, review round 2).
# `rmdir` again: this path only needs to clear the empty bind-mount stub, and
# a populated directory means a misconfigured AUTH_OUT_FILE that must not be
# destroyed (see remove_stale above).
if [ -d "$OUT" ] && [ ! -L "$OUT" ]; then
  rmdir "$OUT" 2>/dev/null || {
    echo "render-rqlite-auth: refusing to remove non-empty directory: $OUT" >&2; exit 1; }
fi

# The passwords must not appear in `jq`'s argv — on a shared host any local
# user can read /proc/<pid>/cmdline for the lifetime of the process. They go
# through the environment instead (jq exposes it to the filter as $ENV.VAR).
# `env` prints VAR=... lines; an empty variable is dropped, which would let an
# empty password slip through as undefined, so re-check them here.
RQLITE_USERNAME="$RQLITE_USERNAME" RQLITE_PASSWORD="$RQLITE_PASSWORD" \
  RQLITE_JOIN_PASSWORD="$RQLITE_JOIN_PASSWORD" \
jq -n '
  [
    { username: $ENV.RQLITE_USERNAME, password: $ENV.RQLITE_PASSWORD, perms: ["all"] },
    { username: "joiner", password: $ENV.RQLITE_JOIN_PASSWORD, perms: ["join"] },
    { username: "*", perms: ["status", "ready"] }
  ]' > "$OUT.tmp"
# Write-then-rename: a killed render must never leave a half-written auth file.
mv "$OUT.tmp" "$OUT"
# Belt-and-braces: if $OUT is still not a regular file after the rename, the
# entrypoint would silently start rqlite without auth — fail loudly instead.
if [ ! -f "$OUT" ]; then
  echo "render-rqlite-auth: $OUT is not a regular file after render; refusing to continue" >&2
  exit 1
fi
chmod 600 "$OUT"
