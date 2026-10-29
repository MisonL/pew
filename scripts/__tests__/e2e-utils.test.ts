import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { apiRouteWarmupPaths, ensurePortFree, resolveE2eDistDir, runLocalE2e, startLocalBindings, warmApiRoutes, WARMUP_TIMEOUT_MS } from "../e2e-utils";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync), readdirSync: vi.fn(fs.readdirSync) };
});

/** Reserve and release a loopback port, so a stubbed E2E_PORT cannot collide
 * with a real lane (17020/27020) running in parallel.
 *
 * listen(0) hands back a port from the OS ephemeral range (49152+), which is
 * exactly the pool every other process on the machine draws from — so releasing
 * it and then letting runLocalE2e re-bind races anything that grabs it in the
 * gap (measured: one EADDRINUSE in six full runs, reported as "expected E2E
 * interrupted"). Draw from a private range instead and verify the port is
 * actually bindable before returning it.
 *
 * Random picks within that range still collided across the suite's parallel
 * workers (a full run produced listen EADDRINUSE from ensurePortFree). Give
 * each vitest worker its own 100-port slice of the range and walk it
 * sequentially, so two workers never hand the same port to their lanes. */
const PORT_SLICE_BASE =
  21_000 + ((Number(process.env.VITEST_WORKER_ID ?? process.pid) || 1) % 100) * 100;
let nextPort = PORT_SLICE_BASE;

async function freePort(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = nextPort++;
    const probe = createServer();
    const bound = await new Promise<boolean>((done) => {
      probe.once("error", () => done(false));
      probe.listen(candidate, "127.0.0.1", () => done(true));
    });
    await new Promise<void>((done) => (bound ? probe.close(() => done()) : done()));
    if (bound) return String(candidate);
  }
  throw new Error(`could not find a free port in the worker's slice from ${PORT_SLICE_BASE}`);
}

// The module-level fs mock exists for the runner tests; the warmup walker
// reads the real route tree, so restore the passthrough implementation first.
async function realReaddir(): Promise<void> {
  vi.mocked((await import("node:fs")).readdirSync).mockRestore();
}

describe("apiRouteWarmupPaths", () => {
  it("maps route files to warmup URLs and replaces dynamic segments", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-warmup-paths-"));
    try {
      const routes = [
        ["live"],
        ["usage", "by-device"],
        ["users", "[slug]"],
        ["auth", "[...nextauth]"],
        ["nested", "deep", "[id]"],
      ];
      for (const segments of routes) {
        mkdirSync(join(root, ...segments), { recursive: true });
        writeFileSync(join(root, ...segments, "route.ts"), "");
      }
      // Neither of these is a route: a stray file and a directory without one.
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, "notes", "readme.md"), "");
      mkdirSync(join(root, "empty"), { recursive: true });

      await realReaddir();
      expect(apiRouteWarmupPaths(root)).toEqual([
        "/api/auth/e2e-warmup",
        "/api/live",
        "/api/nested/deep/e2e-warmup",
        "/api/usage/by-device",
        "/api/users/e2e-warmup",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats route groups and slots as no URL segment instead of a literal path", async () => {
    // `(group)` and `@slot` folders are organizational only: probing them as a
    // literal URL segment would compile the not-found boundary and leave the
    // actual route cold for the tests.
    const root = mkdtempSync(join(tmpdir(), "pew-warmup-groups-"));
    try {
      mkdirSync(join(root, "(dashboard)", "usage"), { recursive: true });
      writeFileSync(join(root, "(dashboard)", "usage", "route.ts"), "");
      mkdirSync(join(root, "@modal", "live"), { recursive: true });
      writeFileSync(join(root, "@modal", "live", "route.ts"), "");

      await realReaddir();
      expect(apiRouteWarmupPaths(root)).toEqual(["/api/live", "/api/usage"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for an empty tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-warmup-empty-"));
    try {
      await realReaddir();
      expect(apiRouteWarmupPaths(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("warmApiRoutes", () => {
  /** A fetch that answers after a macrotask, recording in-flight count and
   * every requested path — enough to prove coverage, no duplicates and the
   * concurrency bound without depending on worker scheduling order. */
  function trackingFetch(options: { failOn?: (path: string) => boolean } = {}) {
    let inFlight = 0;
    const state = { maxInFlight: 0, paths: [] as string[] };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url).replace("http://127.0.0.1:17020", "");
      state.paths.push(path);
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      await new Promise((done) => setTimeout(done, 0));
      inFlight -= 1;
      if (options.failOn?.(path)) throw new Error("synthetic connection refused");
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return state;
  }

  it("covers every route plus the not-found boundary, once each, within the concurrency bound", async () => {
    await realReaddir();
    const routes = apiRouteWarmupPaths(resolve("packages/web/src/app/api"));
    // Guard the guard: a tree with a couple of routes would not exercise the
    // fan-out or the duplicate check meaningfully.
    expect(routes.length).toBeGreaterThan(10);

    const state = trackingFetch();
    try {
      await expect(warmApiRoutes("17020", new AbortController().signal)).resolves.toBeUndefined();
      // Every probe carries the marker so quota-charging routes (auth/cli)
      // recognize it as a warmup and skip accounting inside the E2E env.
      expect(state.paths.every((path) => path.endsWith("?pew-warmup=1"))).toBe(true);
      const bare = state.paths.map((path) => path.replace("?pew-warmup=1", ""));
      expect([...bare].sort()).toEqual([...routes, "/api/e2e-warmup-not-found"].sort());
      expect(new Set(bare).size).toBe(bare.length);
      // The not-found boundary compiles the slowest, so it must be in the
      // first wave rather than serialized at the end.
      expect(bare.slice(0, 4)).toContain("/api/e2e-warmup-not-found");
      expect(state.maxInFlight).toBeGreaterThan(1);
      expect(state.maxInFlight).toBeLessThanOrEqual(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the route and stops warming after the first failure", async () => {
    await realReaddir();
    const routes = apiRouteWarmupPaths(resolve("packages/web/src/app/api"));
    const doomed = routes[0] as string;
    const state = trackingFetch({ failOn: (path) => path.startsWith(`${doomed}?`) });
    try {
      const rejection = await warmApiRoutes("17020", new AbortController().signal)
        .then(() => undefined, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      const error = rejection as Error;
      expect(error.message).toBe(`API route warmup failed for ${doomed} (no answer within ${WARMUP_TIMEOUT_MS / 1000}s)`);
      expect((error.cause as Error).message).toContain("synthetic connection refused");
      // The failure stops the workers from taking on new work, but the
      // requests already in flight can still complete. What matters is that
      // the warmup stops early instead of walking the whole route list.
      expect(state.paths.length).toBeLessThan(routes.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the abort instead of a warmup failure when the run is interrupted", async () => {
    await realReaddir();
    const abort = new AbortController();
    const state = trackingFetch();
    try {
      const pending = warmApiRoutes("17020", abort.signal);
      abort.abort(new Error("E2E interrupted"));
      await expect(pending).rejects.toThrow("E2E interrupted");
      expect(state.paths.length).toBeLessThanOrEqual(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveE2eDistDir", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("defaults to the tier's shared dist dir", () => {
    expect(resolveE2eDistDir("api")).toBe(".next-e2e");
    expect(resolveE2eDistDir("ui")).toBe(".next-e2e-ui");
  });

  it("honours a relative override so the unit suite can build beside a running lane", () => {
    // The suite's real-lane cases and a pre-push L2 lane share a worktree; with
    // one dist dir, whichever finishes first deletes the other's output.
    vi.stubEnv("PEW_E2E_DIST_DIR", ".next-e2e-unit");
    expect(resolveE2eDistDir("api")).toBe(".next-e2e-unit");
    expect(resolveE2eDistDir("ui")).toBe(".next-e2e-unit");
  });

  it.each(["", "/tmp/pew-build", "..", "../elsewhere", "a/../../b", "a//b", "a/./b", "a\\b"])(
    "refuses %s: the value reaches rmSync(join('packages/web', dist))",
    (override) => {
      vi.stubEnv("PEW_E2E_DIST_DIR", override);
      expect(() => resolveE2eDistDir("api")).toThrow(/relative path inside packages\/web/);
    },
  );
});

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
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      removePath(root, { recursive: true });
    }
  });

  it.each([1, 2])("stops before spawning work when interrupted at marker check %i", async (interruptAt) => {
    // Two windows: the first marker check (before any child is spawned) and
    // the post-readiness one (after the server is up). A SIGTERM in either
    // must abort before the next spawn — otherwise the lane starts a
    // `next dev` / `next build` only to kill it in the finally. Only the
    // second window had a regression test; deleting the first check left the
    // suite green.
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
      if (markerChecks === interruptAt) process.emit("SIGTERM");
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
      if (interruptAt === 1) {
        // Nothing beyond the bindings child (which carries the ipc option)
        // may start: no `next dev`.
        expect(spawned.some((command) => command.includes("dev"))).toBe(false);
      }
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

  it("keeps the run failure when the dist cleanup also fails", async () => {
    // The finally's rmSync used to run unprotected: an EACCES there replaced
    // the real run failure and skipped the listener removal entirely. The run
    // error must stay errors[0], the removal error second, and the process
    // listeners must still be gone afterwards.
    const root = mkdtempSync(join(tmpdir(), "pew-rm-fail-"));
    const denied = Object.assign(new Error("synthetic dist cleanup denied"), { code: "EACCES" });
    const remove = vi.mocked((await import("node:fs")).rmSync).mockImplementation(() => { throw denied; });
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
    const listeners = new Map(["SIGINT", "SIGTERM"].map((event) => [event, new Set(process.listeners(event))]));
    vi.stubGlobal("Bun", {
      spawn: vi.fn((_command: string[], options: { ipc?: (message: unknown) => void }) => {
        if (options.ipc) {
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123456, exitCode: null as number | null, exited: exit.promise,
            kill() { this.exitCode = 0; exit.resolve(0); },
            send() { this.kill(); },
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
      expect(aggregate.errors[1]).toBe(denied);
      for (const [event, original] of listeners) {
        expect(process.listeners(event).filter((listener) => !original.has(listener))).toEqual([]);
      }
    } finally {
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aggregates multiple cleanup failures in order behind the run failure", async () => {
    // Three independent cleanup steps fail (kill, dispose, dist removal).
    // The multi-error branch used to be unexercised: every existing case had
    // exactly one cleanup error, so deleting the aggregation left the suite
    // green.
    const root = mkdtempSync(join(tmpdir(), "pew-multi-cleanup-"));
    const denied = Object.assign(new Error("synthetic dist cleanup denied"), { code: "EACCES" });
    const remove = vi.mocked((await import("node:fs")).rmSync).mockImplementation(() => { throw denied; });
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
    vi.stubGlobal("Bun", {
      spawn: vi.fn((command: string[], options: { ipc?: (message: unknown) => void }) => {
        if (options.ipc) {
          // Bindings child: alive, but its IPC channel is gone.
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123456, exitCode: null as number | null, exited: exit.promise,
            kill() {},
            send() { throw Object.assign(new Error("ERR_IPC_CHANNEL_CLOSED"), { code: "ERR_IPC_CHANNEL_CLOSED" }); },
          };
          queueMicrotask(() => options.ipc?.({ env, state: root }));
          return child;
        }
        if (command.includes("test")) {
          // The test run itself crashes, and its process cannot be signalled.
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123458, exitCode: null as number | null, exited: exit.promise,
            kill() { throw Object.assign(new Error("kill denied"), { code: "EPERM" }); },
            send() {},
          };
          queueMicrotask(() => exit.reject(new Error("synthetic test crash")));
          return child;
        }
        // Server stays alive until the finally kills it.
        const serverExit = Promise.withResolvers<number>();
        return {
          pid: 123457, exitCode: null as number | null, exited: serverExit.promise,
          kill() { this.exitCode = 0; serverExit.resolve(0); }, send() {},
        };
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      const error = await runLocalE2e("api").then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("E2E run failed and cleanup also failed");
      expect((aggregate.errors[0] as Error).message).toContain("synthetic test crash");
      const cleanup = aggregate.errors[1] as AggregateError;
      expect(cleanup).toBeInstanceOf(AggregateError);
      expect(cleanup.message).toBe("E2E cleanup failed");
      expect(cleanup.errors[0] as Error).toMatchObject({ message: "kill denied" });
      // dispose itself aggregates the closed IPC channel and the failed
      // forced-exit kill (the fake pid does not exist, so process.kill throws).
      const dispose = cleanup.errors[1] as AggregateError;
      expect(dispose.message).toContain("disposal failed and forced exit also failed");
      expect((dispose.errors[0] as Error).message).toContain("ERR_IPC_CHANNEL_CLOSED");
      expect(cleanup.errors[2]).toBe(denied);
    } finally {
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an interrupt that lands after the tests exited", async () => {
    // SIGTERM during cleanup used to leave the return value at the tests'
    // exit code, so an aborted run reported success to pre-push.
    const root = mkdtempSync(join(tmpdir(), "pew-late-interrupt-"));
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
    vi.stubGlobal("Bun", {
      spawn: vi.fn((command: string[], options: { ipc?: (message: unknown) => void }) => {
        if (options.ipc) {
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123456, exitCode: null as number | null, exited: exit.promise,
            // Dispose arrives after the tests already passed: the interrupt
            // must still be reported, not swallowed by the clean exit code.
            kill() { this.exitCode = 0; exit.resolve(0); },
            send() { process.emit("SIGTERM"); this.kill(); },
          };
          queueMicrotask(() => options.ipc?.({ env, state: root }));
          return child;
        }
        if (command.includes("test")) return { pid: 123458, exitCode: 0, exited: Promise.resolve(0), kill() {}, send() {} };
        const serverExit = Promise.withResolvers<number>();
        return {
          pid: 123457, exitCode: null as number | null, exited: serverExit.promise,
          kill() { this.exitCode = 0; serverExit.resolve(0); }, send() {},
        };
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      await expect(runLocalE2e("api")).rejects.toThrow("E2E interrupted");
    } finally {
      remove.mockRestore(); list.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a cleanup failure alone when the run itself succeeded", async () => {
    // Cleanup-only path: the tests pass, but dispose throws (bindings child's
    // IPC channel died). The dispose error must be the rejection — not
    // swallowed, and not wrapped in the both-failed AggregateError.
    const root = mkdtempSync(join(tmpdir(), "pew-cleanup-only-"));
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
      spawn: vi.fn((command: string[], options: { ipc?: (message: unknown) => void }) => {
        if (options.ipc) {
          const exit = Promise.withResolvers<number>();
          const child = {
            pid: 123456, exitCode: null as number | null, exited: exit.promise,
            kill() {},
            send() { throw Object.assign(new Error("ERR_IPC_CHANNEL_CLOSED"), { code: "ERR_IPC_CHANNEL_CLOSED" }); },
          };
          queueMicrotask(() => options.ipc?.({ env, state: root }));
          return child;
        }
        // Tests pass (exit 0); the server stays alive until the finally kills
        // it — its kill() resolves exited so the SIGKILL fallback can finish.
        if (command.includes("test")) return { pid: 123458, exitCode: 0, exited: Promise.resolve(0), kill() {}, send() {} };
        const serverExit = Promise.withResolvers<number>();
        return {
          pid: 123457, exitCode: null as number | null, exited: serverExit.promise,
          kill() { this.exitCode = 0; serverExit.resolve(0); }, send() {},
        };
      }),
      sleep: vi.fn(async () => {}),
    });
    try {
      const error = await runLocalE2e("api").then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(AggregateError);
      const cleanup = error as AggregateError;
      expect(cleanup.message).toBe("Local bindings disposal failed and forced exit also failed");
      expect((cleanup.errors[0] as Error).message).toContain("ERR_IPC_CHANNEL_CLOSED");
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
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, E2E_PORT: "37020", PEW_E2E_DIST_DIR: ".next-e2e-unit" }, stdio: ["ignore", "pipe", "pipe"] });
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
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, E2E_PORT: "37021", PEW_E2E_DIST_DIR: ".next-e2e-unit" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    try {
      // Poll budget is a hang detector, not a performance budget — `next dev`
      // can take minutes to print "Local:" on a loaded machine.
      const started = Date.now();
      while (!output.includes("Local:")) {
        if (child.exitCode !== null || Date.now() - started > 900_000) throw new Error(`Server did not start: ${output}`);
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
    // Outer budget above the inner legal worst case: 900s readiness poll +
    // SIGTERM cleanup (5s kill wait + 30s dispose + 30s forced exit).
  }, 1_200_000);

  it("cleans D1 when the Next process fails to start", async () => {
    const root = mkdtempSync(join(tmpdir(), "pew-start-failure-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/bin/sh\ncase "$1" in */next/dist/bin/next) exit 23;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const child = spawn("bun", ["--no-env-file", "scripts/run-e2e.ts"], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root, E2E_PORT: "37022", PEW_E2E_DIST_DIR: ".next-e2e-unit" }, stdio: ["ignore", "pipe", "pipe"] });
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
    // Inner worst case: the startup budget (900s) + 30s dispose + 30s forced
    // exit; keep the outer budget strictly above it so a wedged child surfaces
    // its own "startup timed out" diagnostic instead of a vitest timeout.
  }, 1_200_000);
});
