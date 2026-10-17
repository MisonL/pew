import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ensurePortFree, runLocalE2e, startLocalBindings } from "../e2e-utils";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync), readdirSync: vi.fn(fs.readdirSync) };
});

/** Reserve and release a loopback port, so a stubbed E2E_PORT cannot collide
 * with a real lane (17020/27020) running in parallel. */
async function freePort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return String(port);
}

describe("E2E process isolation", () => {
  it.each(["api", "ui"] as const)("tolerates missing %s output without hiding other cleanup errors", async (tier) => {
    const root = mkdtempSync(join(tmpdir(), "pew-output-cleanup-"));
    const fs = await import("node:fs");
    const removePath = (await vi.importActual<typeof import("node:fs")>("node:fs")).rmSync;
    const missing = join(root, "already-removed");
    const denied = Object.assign(new Error("synthetic cleanup permission denied"), { code: "EACCES" });
    const listeners = new Map(["SIGINT", "SIGTERM"].map((event) => [event, new Set(process.listeners(event))]));
    let failRemoval = false;
    const remove = vi.mocked(fs.rmSync).mockImplementation((_path, options) => {
      if (failRemoval) throw denied;
      removePath(missing, options);
    });
    const list = vi.mocked(fs.readdirSync).mockReturnValue([]);
    // runLocalE2e() checks the real lane port for occupancy before spawning.
    // Pin a freshly released port per tier so this unit test can never race a
    // concurrent pre-push L2/L3 lane on 17020/27020 (that was a deterministic
    // EADDRINUSE, not load-related flake).
    vi.stubEnv(tier === "api" ? "E2E_PORT" : "E2E_UI_PORT", await freePort());
    const env = {
      NODE_ENV: "development", RESOURCE_ENV: "test", E2E_SKIP_AUTH: "true",
      CF_ACCOUNT_ID: "pew-local-test", CF_D1_DATABASE_ID: "pew-local-test", CF_D1_API_TOKEN: "synthetic",
      PEW_LOCAL_D1_URL: "http://127.0.0.1:12345", WORKER_INGEST_URL: "http://127.0.0.1:12345/ingest",
      WORKER_READ_URL: "http://127.0.0.1:12345", PEW_TEST_RUN_ID: "owned-run",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true, result: [{ results: [{ key: "env", value: "test" }, { key: "run", value: "owned-run" }] }],
    })));
    let buildExitCode = 0;
    vi.stubGlobal("Bun", {
      spawn: vi.fn((command: string[], options: { ipc?: (message: unknown) => void }) => {
        const exit = Promise.withResolvers<number>();
        const child = {
          pid: 123456, exitCode: null as number | null, exited: exit.promise,
          kill() { this.exitCode = 0; exit.resolve(0); },
          send() { this.kill(); },
        };
        if (options.ipc) queueMicrotask(() => options.ipc?.({ env, state: root }));
        // ui lane: `next build` succeeds and exits 0, then `next start` is
        // the long-lived server. api lane: `next dev` is the server. Both
        // servers stay alive (exitCode null); only the test-runner command
        // is "killed" with code 0.
        else if (command.includes("build")) exit.resolve(buildExitCode);
        else if (!command.includes("dev") && !command.includes("start")) child.kill();
        return child;
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      await expect(runLocalE2e(tier)).resolves.toBe(0);
      expect(remove).toHaveBeenCalledExactlyOnceWith(join("packages/web", tier === "api" ? ".next-e2e" : ".next-e2e-ui"), { recursive: true, force: true });
      if (tier === "ui") {
        // A failing `next build` must abort the run and still clean the
        // isolated dist dir (the removal happens in the finally chain).
        buildExitCode = 1;
        await expect(runLocalE2e(tier)).rejects.toThrow("next build failed (1)");
        expect(remove).toHaveBeenCalledTimes(2);
        buildExitCode = 0;
      }
      failRemoval = true;
      await expect(runLocalE2e(tier)).rejects.toBe(denied);
    } finally {
      for (const [event, original] of listeners) {
        for (const listener of process.listeners(event)) if (!original.has(listener)) process.removeListener(event, listener);
      }
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals();
      removePath(root, { recursive: true });
    }
  });

  it("stops before spawning tests when interrupted during the post-readiness marker check", async () => {
    // A SIGTERM in the window between readiness and Bun.spawn(tests) kills the
    // server via killChildren; without the throwIfAborted gate the test
    // process was still spawned against a dead server and the interrupt
    // surfaced as connection errors instead of "E2E interrupted".
    const root = mkdtempSync(join(tmpdir(), "pew-interrupt-window-"));
    const remove = vi.mocked((await import("node:fs")).rmSync).mockImplementation(() => {});
    const list = vi.mocked((await import("node:fs")).readdirSync).mockReturnValue([]);
    vi.stubEnv("E2E_PORT", await freePort());
    const env = {
      NODE_ENV: "development", RESOURCE_ENV: "test", E2E_SKIP_AUTH: "true",
      CF_ACCOUNT_ID: "pew-local-test", CF_D1_DATABASE_ID: "pew-local-test", CF_D1_API_TOKEN: "synthetic",
      PEW_LOCAL_D1_URL: "http://127.0.0.1:12345", WORKER_INGEST_URL: "http://127.0.0.1:12345/ingest",
      WORKER_READ_URL: "http://127.0.0.1:12345", PEW_TEST_RUN_ID: "owned-run",
    };
    let markerChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/api/live")) return Response.json({ status: "ok" });
      markerChecks += 1;
      // Second marker check is the post-readiness one (line ~193): interrupt
      // while it is in flight, exactly the window the finding describes.
      if (markerChecks === 2) process.emit("SIGTERM");
      return Response.json({ success: true, result: [{ results: [{ key: "env", value: "test" }, { key: "run", value: "owned-run" }] }] });
    }));
    const spawned: string[][] = [];
    vi.stubGlobal("Bun", {
      spawn: vi.fn((command: string[], options: { ipc?: (message: unknown) => void }) => {
        spawned.push(command);
        const exit = Promise.withResolvers<number>();
        const child = {
          pid: 123456, exitCode: null as number | null, exited: exit.promise,
          kill() { this.exitCode = 0; exit.resolve(0); },
          send() { this.kill(); },
        };
        if (options.ipc) queueMicrotask(() => options.ipc?.({ env, state: root }));
        return child;
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      await expect(runLocalE2e("api")).rejects.toThrow("E2E interrupted");
      expect(spawned.some((command) => command.includes("test"))).toBe(false);
    } finally {
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the run failure when dispose also fails (bindings child died mid-run)", async () => {
    // A bindings child that died mid-run makes dispose throw (send on a
    // closed IPC channel, then kill on a gone process group). The finally
    // must surface both errors with the real run failure first — the old
    // shape replaced "E2E server exited 1" with "kill() failed: ESRCH".
    const root = mkdtempSync(join(tmpdir(), "pew-dispose-fail-"));
    const remove = vi.mocked((await import("node:fs")).rmSync).mockImplementation(() => {});
    const list = vi.mocked((await import("node:fs")).readdirSync).mockReturnValue([]);
    vi.stubEnv("E2E_PORT", await freePort());
    const env = {
      NODE_ENV: "development", RESOURCE_ENV: "test", E2E_SKIP_AUTH: "true",
      CF_ACCOUNT_ID: "pew-local-test", CF_D1_DATABASE_ID: "pew-local-test", CF_D1_API_TOKEN: "synthetic",
      PEW_LOCAL_D1_URL: "http://127.0.0.1:12345", WORKER_INGEST_URL: "http://127.0.0.1:12345/ingest",
      WORKER_READ_URL: "http://127.0.0.1:12345", PEW_TEST_RUN_ID: "owned-run",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true, result: [{ results: [{ key: "env", value: "test" }, { key: "run", value: "owned-run" }] }],
    })));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("kill() failed: ESRCH"), { code: "ESRCH" }); });
    vi.stubGlobal("Bun", {
      spawn: vi.fn((_command: string[], options: { ipc?: (message: unknown) => void }) => {
        if (options.ipc) {
          // Bindings child: alive (exitCode null) but its IPC channel is gone.
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123456, exitCode: null as number | null, exited: exit.promise,
            kill() {},
            send() { throw Object.assign(new Error("ERR_IPC_CHANNEL_CLOSED"), { code: "ERR_IPC_CHANNEL_CLOSED" }); },
          };
          queueMicrotask(() => options.ipc?.({ env, state: root }));
          return child;
        }
        // Server dies immediately -> readiness loop throws "E2E server exited 1".
        return { pid: 123457, exitCode: 1, exited: Promise.resolve(1), kill() {}, send() {} };
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      const error = await runLocalE2e("api").then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("E2E run failed and cleanup also failed");
      expect((aggregate.errors[0] as Error).message).toContain("E2E server exited 1");
      // dispose itself aggregates its IPC error and the ESRCH kill failure, so
      // neither the channel error nor the kill error is lost.
      const cleanup = aggregate.errors[1] as AggregateError;
      expect(cleanup.message).toContain("disposal failed and forced exit also failed");
      expect((cleanup.errors[0] as Error).message).toContain("ERR_IPC_CHANNEL_CLOSED");
      expect((cleanup.errors[1] as Error).message).toContain("ESRCH");
    } finally {
      remove.mockRestore(); list.mockRestore(); kill.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      // Cleanup also times out here, so both errors must surface: the original
      // startup/interruption error first, the disposal failure second. The
      // original must never be replaced by "disposal timed out" (that was the
      // pre-fix behavior and sent debugging after the wrong problem).
      const error = await pending.then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("Local bindings startup failed and cleanup also failed");
      expect((aggregate.errors[0] as Error).message).toContain(interrupt ? "synthetic interruption" : "startup timed out");
      expect((aggregate.errors[1] as Error).message).toContain("disposal timed out");
      expect(child.send).toHaveBeenCalledWith("dispose");
      expect(kill).toHaveBeenCalledExactlyOnceWith(-123456, "SIGKILL");
      expect(spawnChild).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ CI: "true" }) }));
      expect(spawnChild).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ env: expect.not.objectContaining({ PEW_SYNTHETIC_PARENT_SECRET: "must-not-forward" }) }));
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); kill.mockRestore(); }
  });

  it("preserves the startup error when cleanup succeeds", async () => {
    // A child that exits cleanly before readiness: the startup race rejects
    // with "failed before ready", and dispose() completes without throwing
    // (exit code 0), so the original error must be thrown as-is — no
    // AggregateError wrapper.
    const child = { pid: 123456, exitCode: null as number | null, exited: Promise.resolve(0), send: vi.fn() };
    vi.stubGlobal("Bun", { spawn: vi.fn(() => child) });
    try {
      const error = await startLocalBindings(new AbortController().signal, 5_000).then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AggregateError);
      expect((error as Error).message).toContain("failed before ready (0)");
    } finally { vi.unstubAllGlobals(); }
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
    // Outer budget must exceed the inner legal worst case: 10s state poll +
    // SIGTERM cleanup (5s server kill wait + 30s dispose + 30s forced exit).
    // A wedged child would otherwise fail this test on vitest's timeout
    // instead of producing its own diagnostic.
  }, 90_000);

  it("cleans D1 and the listener after a started server is interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-started-test-"));
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, E2E_PORT: "37021" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    try {
      // Poll budget matches the readiness timeout raised in e2e-utils
      // (both were 60s under the old flake-prone budget).
      const started = Date.now();
      while (!output.includes("Local:")) {
        if (child.exitCode !== null || Date.now() - started > 180_000) throw new Error(`Server did not start: ${output}`);
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
    // Outer budget above the inner legal worst case: 180s readiness poll +
    // SIGTERM cleanup (5s kill wait + 30s dispose + 30s forced exit) = 245s.
  }, 300_000);

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
    // Inner worst case: 180s startup + 30s dispose + 30s forced exit = 240s;
    // keep the outer budget strictly above it so a wedged child surfaces its
    // own "startup timed out" diagnostic instead of a vitest timeout.
  }, 300_000);
});
