import { defineConfig } from "@playwright/test";

const E2E_UI_PORT = process.env.E2E_UI_PORT || "27020";

export default defineConfig({
  testDir: "./bdd",
  timeout: 60_000,
  // Development compilation and chart hydration can exceed the default 5 seconds.
  expect: { timeout: 15_000 },
  // One local retry to ride out machine-load spikes (a navigation over
  // navigationTimeout is retried on a warm server and usually passes); CI
  // keeps the same value. A deterministic failure fails twice and stays red.
  retries: 1,
  workers: process.env.CI ? 2 : 1,
  use: {
    baseURL: `http://localhost:${E2E_UI_PORT}`,
    headless: true,
    navigationTimeout: 30_000,
  },
  // No webServer — scripts/run-e2e-ui.ts manages the dev server lifecycle.
});
