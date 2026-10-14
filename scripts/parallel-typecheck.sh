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

tsc -b deploy/selfhost/tsconfig.json &
PIDS+=($!)

# Wait for each process and collect exit codes
EXIT_CODE=0
for PID in "${PIDS[@]}"; do
  wait $PID || EXIT_CODE=1
done

tsc --noEmit -p tsconfig.e2e.json || EXIT_CODE=1

exit $EXIT_CODE
