import { describe, it, expect } from "vitest";
import { executeUpdate } from "../commands/update.js";

describe("executeUpdate", () => {
  // Every pre-existing case injects latestVersionFn so no test touches the
  // registry; the guard tests below pin the version gate itself.
  const ok = (stdout = "added 1 package\n") => async () => ({ stdout, stderr: "" });

  it("should return success when command succeeds", async () => {
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: ok(),
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("added 1 package");
    expect(result.error).toBeUndefined();
  });

  it("should return failure when command throws Error", async () => {
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("EACCES");
  });

  it("should return failure when command throws non-Error", async () => {
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: async () => {
        throw "string error";
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("string error");
  });

  it("should combine stdout and stderr in output", async () => {
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: async () => ({
        stdout: "added 1 package\n",
        stderr: "npm warn deprecated\n",
      }),
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("added 1 package");
    expect(result.output).toContain("npm warn deprecated");
  });

  // -------------------------------------------------------------------------
  // Version guard — refuses a downgrade to the published npm package
  // -------------------------------------------------------------------------

  it("skips when the published version equals the running one (no install runs)", async () => {
    let ranInstall = false;
    const result = await executeUpdate({
      currentVersion: "3.3.3",
      latestVersionFn: async () => "3.3.3",
      execFn: async () => {
        ranInstall = true;
        return { stdout: "added 1 package\n", stderr: "" };
      },
    });

    expect(ranInstall).toBe(false);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.latestVersion).toBe("3.3.3");
  });

  it("skips when the running build is newer than the published package (downgrade guard)", async () => {
    // The real 2026-10-20 incident: a fork build at 3.3.3 with `pew update`
    // installed upstream 3.3.0 globally, which shadows the local binary and
    // silently ignores --host — self-hosted uploads then go to the SaaS.
    let ranInstall = false;
    const result = await executeUpdate({
      currentVersion: "3.3.3",
      latestVersionFn: async () => "3.3.0",
      execFn: async () => {
        ranInstall = true;
        return { stdout: "", stderr: "" };
      },
    });

    expect(ranInstall).toBe(false);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.output).toContain("3.3.0");
    expect(result.output).toContain("3.3.3");
  });

  it("compares versions numerically, not lexicographically", async () => {
    let ranInstall = false;
    const result = await executeUpdate({
      currentVersion: "3.3.9",
      latestVersionFn: async () => "3.3.10",
      execFn: async () => {
        ranInstall = true;
        return { stdout: "", stderr: "" };
      },
    });

    expect(ranInstall).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("fails closed when the latest version cannot be determined", async () => {
    let ranInstall = false;
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => undefined,
      execFn: async () => {
        ranInstall = true;
        return { stdout: "", stderr: "" };
      },
    });

    expect(ranInstall).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("could not determine");
  });

  it("bypasses the version check entirely under force", async () => {
    let ranInstall = false;
    let askedLatest = false;
    const result = await executeUpdate({
      currentVersion: "3.3.3",
      force: true,
      latestVersionFn: async () => {
        askedLatest = true;
        return "3.3.0";
      },
      execFn: async () => {
        ranInstall = true;
        return { stdout: "added 1 package\n", stderr: "" };
      },
    });

    expect(askedLatest).toBe(false);
    expect(ranInstall).toBe(true);
    expect(result.success).toBe(true);
    // The caller must be able to warn: a forced install can replace a local
    // build with a published one that does not know --host.
    expect(result.forced).toBe(true);
  });

  it("does not mark a normal update as forced", async () => {
    const result = await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: ok(),
    });
    expect(result.forced).toBe(false);
  });

  it("should execute a valid update command string", async () => {
    let capturedCmd = "";

    await executeUpdate({
      currentVersion: "1.0.0",
      latestVersionFn: async () => "1.1.0",
      execFn: async (cmd) => {
        capturedCmd = cmd;
        return { stdout: "", stderr: "" };
      },
    });

    // detectPackageManager may return null (fallback) or an actual pm
    // The command should be one of: npm install -g, bun update -g, pnpm update -g, yarn global upgrade
    expect(capturedCmd).toMatch(/@nocoo\/pew/);
    expect(capturedCmd).toMatch(/(npm|bun|pnpm|yarn)/);
  });
});
