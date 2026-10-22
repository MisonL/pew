import { defineConfig } from "@playwright/test";

const E2E_UI_PORT = process.env.E2E_UI_PORT || "27020";

export default defineConfig({
  testDir: "./bdd",
  // Hang detectors, not performance budgets: the lane runs beside the API
  // lane on a shared machine and timing is explicitly not part of the gate
  // contract. A wedged page still fails.
  timeout: 180_000,
  // Chart hydration can exceed the default 5 seconds (page load itself is
  // milliseconds: the L3 lane serves a production build, see scripts/e2e-utils.ts).
  expect: { timeout: 30_000 },
  // One local retry to ride out machine-load spikes (a navigation over
  // navigationTimeout is retried on a warm server and usually passes); CI
  // keeps the same value. A deterministic failure fails twice and stays red.
  retries: 1,
  workers: process.env.CI ? 2 : 1,
  use: {
    baseURL: `http://localhost:${E2E_UI_PORT}`,
    headless: true,
    navigationTimeout: 120_000,
  },
  // No webServer — scripts/e2e-utils.ts (runLocalE2e) builds and serves the
  // production bundle, then invokes this config.
});
