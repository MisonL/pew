#!/bin/sh
# compose overrides the image ENTRYPOINT (docker-entrypoint.sh) with this
# script. The official wrapper did two jobs we must now do ourselves:
#   - exec the rqlited binary (it was the ENTRYPOINT target's argument builder)
#   - append the positional data directory the binary requires
# Append -auth only when the rendered file exists (default-off path), and
# -join-as only when compose set RQLITE_JOIN_AS (cluster nodes: "joiner").
set -e
# docker-entrypoint.sh (the image ENTRYPOINT we replace) defaulted the
# advertise addresses to the container hostname when only -http-addr/-raft-addr
# were given; rqlite itself refuses "0.0.0.0" as an advertised address.
# Reproduce that fallback for the compose flag set (no -adv-addr anywhere).
case "$*" in
  *-http-adv-addr*) ;;
  *) set -- "$@" -http-adv-addr "$(hostname -f):4001" ;;
esac
case "$*" in
  *-raft-adv-addr*) ;;
  *) set -- "$@" -raft-adv-addr "$(hostname -f):4002" ;;
esac
if [ -f /auth/auth.json ]; then
  set -- "$@" -auth /auth/auth.json
  if [ -n "$RQLITE_JOIN_AS" ]; then
    set -- "$@" -join-as "$RQLITE_JOIN_AS"
  fi
fi
# compose commands are pure flags ("-fk", "-bootstrap-expect", "1", ...): the
# trailing value never starts with "-", so no heuristic can spot a positional.
# rqlited requires one, and docker-entrypoint.sh used to add it — append the
# same default unconditionally (compose never passes a data directory; the
# DATA_DIR env override still works).
set -- "$@" "${DATA_DIR:-/rqlite/file/data}"
exec rqlited "$@"
