#!/bin/sh
# Official image ENTRYPOINT is rqlited itself, so compose must override with
# entrypoint: ["sh", "/entrypoint.sh"]. Append -auth only when the file exists.
set -e
if [ -f /auth/auth.json ]; then
  set -- "$@" -auth /auth/auth.json
  if [ -n "$RQLITE_JOIN_AS" ]; then
    set -- "$@" -join-as "$RQLITE_JOIN_AS"
  fi
fi
exec rqlited "$@"
