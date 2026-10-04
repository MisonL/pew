import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensurePortFree, startLocalBindings } from "../e2e-utils";

describe("E2E process isolation", () => {
  it.each([false, true])("bounds no-IPC startup and disposal (abort=%s)", async (interrupt) => {
    let exit: (code: number) => void;
    const exited = new Promise<number>((done) => { exit = done; });
    const child = { pid: 123456, exitCode: null, exited, send: vi.fn() };
    const spawnChild = vi.fn(() => child);
    vi.stubGlobal("Bun", { spawn: spawnChild });
    vi.stubEnv("CI", "true");
    vi.stubEnv("PEW_SYNTHETIC_PARENT_SECRET", "must-not-forward");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { exit(137); return true; });
    try {
      const abort = new AbortController();
      const pending = startLocalBindings(abort.signal, 20);
      if (interrupt) abort.abort(new Error("synthetic interruption"));
      await expect(pending).rejects.toThrow("disposal timed out");
      expect(child.send).toHaveBeenCalledWith("dispose");
      expect(kill).toHaveBeenCalledExactlyOnceWith(-123456, "SIGKILL");
      expect(spawnChild).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ CI: "true" }) }));
      expect(spawnChild).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ env: expect.not.objectContaining({ PEW_SYNTHETIC_PARENT_SECRET: "must-not-forward" }) }));
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); kill.mockRestore(); }
  });

  it("refuses an occupied port without killing its owner", async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing bound test port");
      await expect(ensurePortFree(String(address.port))).rejects.toThrow();
      expect(server.listening).toBe(true);
      await expect(ensurePortFree("17020; unsafe")).rejects.toThrow("Invalid");
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });

  it("rejects daily environment files before creating a database", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-env-test-"));
    try {
      writeFileSync(join(root, ".env.local"), "AUTH_SECRET=synthetic-test-only\n");
      const child = spawn("bun", ["--no-env-file", "-e", `import {assertNoLocalEnv} from ${JSON.stringify(join(import.meta.dirname, "../e2e-utils.ts"))}; assertNoLocalEnv();`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      const code = await new Promise((done) => child.once("exit", done));
      expect(code).not.toBe(0);
      expect(stderr).toContain("refuses local environment files");
    } finally { rmSync(root, { recursive: true }); }
  });

  it("cleans migrated state when interrupted before binding startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-signal-test-"));
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, E2E_PORT: "37020" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    try {
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const started = Date.now();
      while (!readdirSync(root).some((name) => name.startsWith("pew-e2e-"))) {
        if (child.exitCode !== null || Date.now() - started > 10_000) throw new Error(`No owned state created: ${output}`);
        await new Promise((done) => setTimeout(done, 50));
      }
      child.kill("SIGTERM");
      expect(await exited, output).not.toBe(0);
      expect(readdirSync(root).filter((name) => name.startsWith("pew-e2e-")), output).toEqual([]);
      expect(existsSync(root)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
      rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);

  it("cleans D1 and the listener after a started server is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-started-test-"));
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, E2E_PORT: "37021" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    try {
      const started = Date.now();
      while (!output.includes("Local:")) {
        if (child.exitCode !== null || Date.now() - started > 70_000) throw new Error(`Server did not start: ${output}`);
        await new Promise((done) => setTimeout(done, 50));
      }
      child.kill("SIGTERM");
      expect(await exited, output).not.toBe(0);
      expect(readdirSync(root).filter((name) => name.startsWith("pew-e2e-")), output).toEqual([]);
      await expect(ensurePortFree("37021")).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
      rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 90_000);

  it("cleans D1 when the Next process fails to start", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-start-failure-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/bin/sh\ncase "$1" in */next/dist/bin/next) exit 23;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root, E2E_PORT: "37022" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    try {
      expect(await exited, output).not.toBe(0);
      expect(output).toContain("E2E server exited 23");
      expect(readdirSync(root).filter((name) => name.startsWith("pew-e2e-")), output).toEqual([]);
      await expect(ensurePortFree("37022")).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
      rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 90_000);
});
