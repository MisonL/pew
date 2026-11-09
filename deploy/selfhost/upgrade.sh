#!/usr/bin/env bash
# One-shot selfhost upgrade: back up, rebuild with provenance, restart, verify.
#
# Usage: bash upgrade.sh [--dry-run] [--skip-backup]
#
# Why a script: the upgrade is three commands that must be run together and in
# order, and one of them (the build) silently produces a useless image if its
# provenance build args are omitted — the OCI revision/version labels come out
# empty, so `docker image inspect` can no longer map a running container back
# to a commit. That omission has already shipped once. Folding the steps into
# one entry point removes the "read the README correctly" dependency.
#
# Steps, in order:
#   1. rqlite backup into ~/pew-backups (skipped with --skip-backup)
#   2. docker compose build with PEW_REVISION/PEW_VERSION
#   3. docker compose up -d
#   4. wait for web to report healthy
#   5. verify the running image carries the revision label, and exit non-zero
#      if it does not — a build that lost its build args must not be treated
#      as a successful deploy.
#
# Set PEW_UPGRADE_NO_RESTART=1 to build and verify the labels without
# touching running containers (useful to pre-warm an image during a window).
set -eu
umask 077

cd "$(dirname "$0")"

DRY_RUN=0
SKIP_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "upgrade.sh: unknown argument: $arg" >&2
      exit 1 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN:'
    printf ' %s' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# Resolve provenance values from the repository, not from the caller's cwd.
REPO_ROOT=$(cd .. && cd .. && pwd)
REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) \
  || { echo "upgrade.sh: cannot read the git revision of the repository" >&2; exit 1; }
VERSION=$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null) \
  || { echo "upgrade.sh: cannot read package.json version" >&2; exit 1; }

if [ "$SKIP_BACKUP" -eq 0 ]; then
  BACKUP_DIR="${PEW_BACKUP_DIR:-$HOME/pew-backups}"
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%F-%H%M%S)
  echo "==> backing up rqlite to $BACKUP_DIR/backup-$STAMP.db"
  run bash backup.sh "$BACKUP_DIR/backup-$STAMP.db"
fi

# The two preconditions the manual procedure documents. Both are warnings or
# hard stops rather than silent conditions, because each one has produced a
# broken deploy: a missing .rqlite-auth.json makes rqlite start without auth,
# and a world-readable .env exposes every secret on the host.
if [ -f .env ]; then
  perms=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)
  [ "$perms" = "600" ] || echo "WARNING: .env is $perms, expected 600 — chmod 600 .env" >&2
fi
if grep -qE '^RQLITE_USERNAME=.+' .env 2>/dev/null && [ ! -f .rqlite-auth.json ]; then
  echo "upgrade.sh: RQLITE_USERNAME is set but .rqlite-auth.json is missing." >&2
  echo "  Re-render it first (see the Quickstart sequence in README.md), or rqlite" >&2
  echo "  will start without authentication." >&2
  exit 1
fi

echo "==> building images (revision $REVISION, version $VERSION)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: PEW_REVISION=$REVISION PEW_VERSION=$VERSION docker compose build"
else
  PEW_REVISION="$REVISION" PEW_VERSION="$VERSION" docker compose build
fi

if [ "${PEW_UPGRADE_NO_RESTART:-0}" = "1" ]; then
  echo "==> PEW_UPGRADE_NO_RESTART=1 — not restarting containers"
  exit 0
fi

echo "==> starting the stack"
run docker compose up -d

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN complete"
  exit 0
fi

# Wait for the web container to report healthy. The healthcheck interval is
# 10s (see docker-compose.yml), so 5 minutes is generous for a normal start
# without hanging forever on a wedged one. PEW_UPGRADE_HEALTH_TIMEOUT_S
# overrides it for tests.
HEALTH_TIMEOUT_S="${PEW_UPGRADE_HEALTH_TIMEOUT_S:-300}"
case "$HEALTH_TIMEOUT_S" in
  ''|*[!0-9]*) echo "upgrade.sh: PEW_UPGRADE_HEALTH_TIMEOUT_S must be a positive integer" >&2; exit 1 ;;
esac
echo "==> waiting for the web container to become healthy"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
while :; do
  status=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep '^selfhost-web-1 ' | awk '{print $2}')
  [ "$status" = "healthy" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "upgrade.sh: web did not become healthy within ${HEALTH_TIMEOUT_S}s (last status: ${status:-unknown})" >&2
    exit 1
  fi
  sleep 3
done

# The provenance check. This is the reason the script exists: an image built
# without PEW_REVISION still starts and passes its healthcheck, so nothing
# downstream notices that it cannot be traced back to a commit.
echo "==> verifying image provenance"
actual=$(docker inspect selfhost-web-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
if [ "$actual" != "$REVISION" ]; then
  echo "upgrade.sh: running image revision is '${actual:-<empty>}', expected '$REVISION'" >&2
  echo "  The image was probably built without PEW_REVISION. Rebuild and redeploy:" >&2
  echo "    PEW_REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD) PEW_VERSION=$VERSION docker compose build && docker compose up -d" >&2
  exit 1
fi

actual_version=$(docker inspect selfhost-web-1 --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)
if [ "$actual_version" != "$VERSION" ]; then
  echo "upgrade.sh: image version is '${actual_version:-<empty>}', expected '$VERSION'" >&2
  exit 1
fi

echo "✅ upgraded to $REVISION ($VERSION); web healthy, provenance verified"
