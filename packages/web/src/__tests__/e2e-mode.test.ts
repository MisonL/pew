import { describe, it, expect } from "vitest";
import { isE2EMode } from "../lib/e2e-mode";

/**
 * The single E2E bypass gate. Every consumer (API auth, admin bypass, invite
 * gate, page proxy) calls this, so these are the only places the three-variable
 * truth table needs to be asserted.
 */
describe("isE2EMode", () => {
  const base = { E2E_SKIP_AUTH: "true", RESOURCE_ENV: "test" };

  it("is true only when all three conditions hold", () => {
    expect(isE2EMode(base)).toBe(true);
  });

  it("is false when E2E_SKIP_AUTH is not exactly 'true'", () => {
    expect(isE2EMode({ ...base, E2E_SKIP_AUTH: "false" })).toBe(false);
    expect(isE2EMode({ ...base, E2E_SKIP_AUTH: "1" })).toBe(false);
    expect(isE2EMode({ ...base, E2E_SKIP_AUTH: undefined })).toBe(false);
  });

  it("is false when RESOURCE_ENV is not 'test' (no isolated runner environment)", () => {
    // This is the gate that keeps a production build from bypassing auth: a
    // deployed host never sets RESOURCE_ENV=test.
    expect(isE2EMode({ ...base, RESOURCE_ENV: "production" })).toBe(false);
    expect(isE2EMode({ ...base, RESOURCE_ENV: undefined })).toBe(false);
  });

  it("is false on Railway regardless of the other two (deployed-path veto)", () => {
    expect(isE2EMode({ ...base, RAILWAY_ENVIRONMENT: "production" })).toBe(false);
    // Even a fully-configured bypass is vetoed on a deployed host.
    expect(
      isE2EMode({ ...base, E2E_ADMIN_BYPASS: "true", RAILWAY_ENVIRONMENT: "production" })
    ).toBe(false);
  });

  it("defaults to process.env when no argument is given", () => {
    const saved = { ...process.env };
    try {
      process.env.E2E_SKIP_AUTH = "true";
      process.env.RESOURCE_ENV = "test";
      delete process.env.RAILWAY_ENVIRONMENT;
      expect(isE2EMode()).toBe(true);
      process.env.RESOURCE_ENV = "production";
      expect(isE2EMode()).toBe(false);
    } finally {
      process.env = saved;
    }
  });
});
