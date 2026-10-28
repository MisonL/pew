#!/bin/bash
# Parallel TypeScript type checking for all packages
# Properly captures exit codes from all background processes

set -e

PIDS=()
RESULTS=()

# Start all tsc processes in background
tsc --noEmit -p packages/core/tsconfig.json &
PIDS+=($!)

tsc --noEmit -p packages/cli/tsconfig.json &
PIDS+=($!)

bun run --cwd packages/web typecheck &
PIDS+=($!)

tsc -b packages/worker/tsconfig.build.json &
PIDS+=($!)

tsc -b packages/worker-read/tsconfig.build.json &
PIDS+=($!)

# Test files are excluded from every declaration build above (they cannot be
# part of a composite emit: they import helpers across package roots), so
# without these lanes vitest's esbuild transpile would be the only pass over
# them — it never checks types. worker-read's own config is standalone but its
# build still excludes tests, so it needs the explicit noEmit lane below.
# packages/worker does not: its tsconfig.json includes src/**/*.test.ts in the
# program already, so `bun run typecheck` (CI lint) checks its tests via the
# package's own `tsc -b`; this script only builds the test-free build config.
tsc --noEmit -p packages/worker-read/tsconfig.test.json &
PIDS+=($!)

tsc -b deploy/selfhost/tsconfig.json &
PIDS+=($!)

# Wait for each process and collect exit codes
EXIT_CODE=0
for PID in "${PIDS[@]}"; do
  wait $PID || EXIT_CODE=1
done

tsc --noEmit -p tsconfig.e2e.json || EXIT_CODE=1

exit $EXIT_CODE
