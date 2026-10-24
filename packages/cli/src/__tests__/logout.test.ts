import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLogout } from "../commands/logout.js";

// Mock ConfigManager to test error path
vi.mock("../config/manager.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/manager.js")>();
  return {
    ...original,
    ConfigManager: original.ConfigManager,
  };
});

describe("executeLogout", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-logout-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns alreadyLoggedOut when no token exists", async () => {
    const result = await executeLogout({ configDir: tempDir });
    expect(result.success).toBe(true);
    expect(result.alreadyLoggedOut).toBe(true);
  });

  it("clears token from config", async () => {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ token: "zb_test123" }),
    );

    const result = await executeLogout({ configDir: tempDir });
    expect(result.success).toBe(true);
    expect(result.alreadyLoggedOut).toBeUndefined();
  });

  it("uses dev config when dev=true", async () => {
    await writeFile(
      join(tempDir, "config.dev.json"),
      JSON.stringify({ token: "zb_dev456" }),
    );

    const result = await executeLogout({ configDir: tempDir, dev: true });
    expect(result.success).toBe(true);
    expect(result.alreadyLoggedOut).toBeUndefined();
  });

  it("clears the per-host token file for a self-hosted host", async () => {
    // `pew login --host X` stores the token under config.<host>.json; logout
    // must clear THAT file, not config.json.
    await writeFile(
      join(tempDir, "config.pew.corp_7020.json"),
      JSON.stringify({ token: "pk_selfhosted" }),
    );

    const result = await executeLogout({
      configDir: tempDir,
      host: "http://pew.corp:7020",
    });

    expect(result.success).toBe(true);
    expect(result.alreadyLoggedOut).toBeUndefined();
    // The CLI message names the scope so an operator with several instances
    // can tell WHICH set of credentials was cleared.
    expect(result.scope).toBe("http://pew.corp:7020");
    const saved = JSON.parse(
      await readFile(join(tempDir, "config.pew.corp_7020.json"), "utf-8"),
    ) as { token?: string };
    expect(saved.token).toBeUndefined();
  });

  it("leaves the SaaS token alone when logging out of a self-hosted host", async () => {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ token: "pk_saas" }),
    );
    await writeFile(
      join(tempDir, "config.pew.corp_7020.json"),
      JSON.stringify({ token: "pk_selfhosted" }),
    );

    await executeLogout({ configDir: tempDir, host: "http://pew.corp:7020" });

    const saas = JSON.parse(
      await readFile(join(tempDir, "config.json"), "utf-8"),
    ) as { token?: string };
    expect(saas.token).toBe("pk_saas");
  });

  it("treats an explicit SaaS host as the shared config file", async () => {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({ token: "pk_saas" }),
    );

    const result = await executeLogout({
      configDir: tempDir,
      host: "https://pew.md",
    });

    expect(result.alreadyLoggedOut).toBeUndefined();
    const saved = JSON.parse(
      await readFile(join(tempDir, "config.json"), "utf-8"),
    ) as { token?: string };
    expect(saved.token).toBeUndefined();
  });

  it("returns error with message when an Error is thrown", async () => {
    const { ConfigManager } = await import("../config/manager.js");
    vi.spyOn(ConfigManager.prototype, "load").mockRejectedValueOnce(
      new Error("disk exploded"),
    );

    const result = await executeLogout({ configDir: tempDir });
    expect(result.success).toBe(false);
    expect(result.error).toBe("disk exploded");
  });

  it("returns generic error for non-Error throws", async () => {
    const { ConfigManager } = await import("../config/manager.js");
    vi.spyOn(ConfigManager.prototype, "load").mockRejectedValueOnce(
      "string error",
    );

    const result = await executeLogout({ configDir: tempDir });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to clear credentials");
  });
});
