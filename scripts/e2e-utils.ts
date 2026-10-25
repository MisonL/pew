import { readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyLocalMarker } from "./local-e2e-bindings";

async function deadline<Result>(promise: Promise<Result>, milliseconds: number, label: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Like deadline(), but resolves instead of rejecting and always clears its
// timer: Bun keeps the event loop alive for a pending Bun.sleep(), so racing
// one against a child that exits immediately delayed every lane's exit by the
// full 5s.
async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((done) => { timer = setTimeout(done, milliseconds); })]);
  } finally { clearTimeout(timer); }
}

// timeoutMs is the local-bindings STARTUP budget. The default is deliberately
// far above any observed cold-start time: the deadline exists to catch a
// wedged child, not to enforce a performance budget. Pre-push runs this lane in
// parallel with the browser E2E's production build and the security scan on a
// heavily loaded machine; timing is explicitly not part of the gate contract,
// so a slow start must never fail the lane. Disposal is instead capped at 30s
// (see disposeTimeoutMs below) because a child that ignores IPC will not
// start responding sooner just because startup was given a long budget.
export async function startLocalBindings(signal: AbortSignal, timeoutMs = 900_000, readiness = false) {
  signal.throwIfAborted();
  let receive: (value: { env: Record<string, string>; state: string }) => void;
  const ready = new Promise<{ env: Record<string, string>; state: string }>((done) => { receive = done; });
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/serve-local-e2e.ts"], {
    env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), WRANGLER_SEND_METRICS: "false", CI: process.env.CI ?? "", PEW_SEED_READINESS: readiness ? "true" : "false" },
    detached: true,
    ipc: (message) => receive(message as { env: Record<string, string>; state: string }),
    stdout: "inherit", stderr: "inherit",
  });
  let stop: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  // Dispose deadlines are capped independently of the (load-tolerant) startup
  // budget: a child that ignores IPC will not start responding sooner just
  // because startup was given a long budget. The cap keeps the failure path
  // short while still honoring a caller that passes a smaller explicit budget
  // (the no-IPC regression passes 20ms and expects disposal bounded by it).
  const disposeTimeoutMs = Math.min(timeoutMs, 30_000);
  const dispose = async () => {
    let code: number;
    try {
      if (child.exitCode === null) child.send("dispose");
      code = await deadline(child.exited, disposeTimeoutMs, "Local bindings disposal");
    } catch (error) {
      // exitCode stays null when the child was killed by a signal, so a dead
      // child must be recognized by signalCode too — otherwise this sends
      // SIGKILL to a gone process group and throws ESRCH, replacing the IPC
      // error that explains what actually happened.
      const dead = child.exitCode !== null || (child.signalCode ?? null) !== null;
      if (!dead) {
        try {
          process.kill(-child.pid, "SIGKILL");
          await deadline(child.exited, disposeTimeoutMs, "Local bindings forced exit");
        } catch (killError) {
          throw new AggregateError([error, killError], "Local bindings disposal failed and forced exit also failed");
        }
      }
      throw error;
    }
    if (code) throw new Error(`Local bindings process failed (${code})`);
  };
  try {
    const result = await deadline(Promise.race([ready, interrupted, child.exited.then((code) => { throw new Error(`Local bindings failed before ready (${code})`); })]), timeoutMs, "Local bindings startup");
    signal.throwIfAborted();
    return { ...result, dispose };
  } catch (error) {
    // Cleanup must never mask the original failure: a "disposal timed out"
    // surface here used to replace the real startup error, sending the next
    // debugging round after the wrong problem. Surface both when cleanup also
    // fails, and the original alone otherwise.
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Local bindings startup failed and cleanup also failed");
    }
    throw error;
  } finally { if (stop) signal.removeEventListener("abort", stop); }
}

export async function ensurePortFree(port: string): Promise<void> {
  const numeric = Number(port);
  if (!/^\d+$/.test(port) || numeric < 1024 || numeric > 65535) throw new Error("Invalid E2E port");
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once("error", reject);
    probe.listen(numeric, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
}

export function assertNoLocalEnv(): void {
  for (const directory of [".", "packages/web"]) {
    const files = readdirSync(directory).filter((name) => /^\.env(?:$|\.)/.test(name) && !name.endsWith(".example"));
    if (files.length) throw new Error(`Isolated E2E refuses local environment files in ${directory}: ${files.join(", ")}`);
  }
}

const WARMUP_SEGMENT = "e2e-warmup";
// Per-request budget. A hang detector, not a performance budget: the lane
// runs beside the ui tier's production build, where a cold compile of the
// not-found boundary has been observed past 120s. Only a server that never
// answers trips it.
export const WARMUP_TIMEOUT_MS = 600_000;
// Concurrent warmup requests: `next dev` compiles each route in its own
// worker, so a few in flight at once overlap the compiles instead of paying
// them end to end. Kept small — the lane runs beside the ui tier's production
// build, and a wide fan-out would trade the compile wall-clock for CPU
// contention on an already-loaded machine.
const WARMUP_CONCURRENCY = 4;

/**
 * Map every `route.*` file under an `src/app/api` tree to the URL a warmup
 * GET should hit. Dynamic segments are replaced with a placeholder: Next
 * compiles the concrete route module for any request to it, while a literal
 * `[slug]` path would match no route and compile nothing.
 */
export function apiRouteWarmupPaths(apiDir: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string, url: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && /^route\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name))) paths.push(url);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Route groups `(group)` and named slots `@slot` are organizational
      // folders: they contribute no URL segment, so probing them under a
      // literal name would compile the not-found boundary instead of the
      // route and leave it cold for the tests. Recurse at the same URL.
      if (/^\(.+\)$/.test(entry.name) || entry.name.startsWith("@")) {
        walk(join(dir, entry.name), url);
        continue;
      }
      // Any dynamic form — `[slug]`, `[...nextauth]`, `[[...slug]]`.
      const segment = entry.name.startsWith("[") ? WARMUP_SEGMENT : entry.name;
      walk(join(dir, entry.name), `${url}/${segment}`);
    }
  };
  walk(apiDir, "/api");
  return paths.sort();
}

export async function warmApiRoutes(port: string, signal: AbortSignal): Promise<void> {
  const paths = apiRouteWarmupPaths(resolve("packages/web/src/app/api"));
  // First, not last: a path no route matches makes Next compile its not-found
  // boundary — the single most expensive compile here (120s+ observed beside
  // the ui build) — and the retired-endpoint tests hit it first. Putting it
  // in the initial batch overlaps it with three route compiles instead of
  // paying for it alone at the end.
  const warmups = [`/api/${WARMUP_SEGMENT}-not-found`, ...paths];
  // Mark every probe: routes that would otherwise charge the caller (e.g.
  // /api/auth/cli's per-IP limiter) recognize the marker inside the isolated
  // E2E environment and skip accounting, so warming up cannot consume the
  // quota the tests themselves rely on.
  const probeUrl = (path: string): string =>
    `${path}${path.includes("?") ? "&" : "?"}pew-warmup=1`;
  const started = Date.now();
  let next = 0;
  // A wedged server must fail the lane with one clear message instead of
  // timing out test by test for the rest of the run, so the first failure
  // aborts its siblings and wins over whatever they would report.
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < warmups.length) {
      const path = warmups[next++] as string;
      signal.throwIfAborted();
      try {
        // The response status is irrelevant — a 401/404/405 still proves the
        // route compiled.
        await fetch(`http://127.0.0.1:${port}${probeUrl(path)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(WARMUP_TIMEOUT_MS)]) });
      } catch (error) {
        failure ??= new Error(`API route warmup failed for ${path} (no answer within ${WARMUP_TIMEOUT_MS / 1000}s)`, { cause: error });
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WARMUP_CONCURRENCY, warmups.length) }, worker));
  signal.throwIfAborted();
  if (failure !== undefined) throw failure;
  console.log(`API route warmup: ${warmups.length} routes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

export async function runLocalE2e(tier: "api" | "ui", args: string[] = []): Promise<number> {
  assertNoLocalEnv();
  const port = tier === "api" ? process.env.E2E_PORT ?? "17020" : process.env.E2E_UI_PORT ?? "27020";
  await ensurePortFree(port);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("E2E interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let local: Awaited<ReturnType<typeof startLocalBindings>> | undefined;
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let tests: ReturnType<typeof Bun.spawn> | undefined;
  let build: ReturnType<typeof Bun.spawn> | undefined;
  const killChildren = () => {
    server?.kill(); tests?.kill();
    // The build must not outlive the run: an interrupted build would keep
    // writing into the dist dir that the finally block is about to remove.
    build?.kill();
    void build?.exited.catch(() => {
      // Ignore: an aborted build's exit code is irrelevant to cleanup.
    });
  };
  abort.signal.addEventListener("abort", killChildren);
  // Rejects when SIGINT/SIGTERM aborts the run, so deadline() races can lose
  // to interruption. Only the ui tier races it (the build deadline); without a
  // consumer here the rejection would surface as an unhandled rejection on
  // SIGINT/SIGTERM in the api tier and flip a clean exit code to 1.
  const interrupted = new Promise<never>((_, reject) => {
    abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
  });
  void interrupted.catch(() => {
    // Consumed by the ui-tier build race when applicable; otherwise the abort
    // path is already handled through killChildren and the finally block.
  });
  const dist = tier === "api" ? ".next-e2e" : ".next-e2e-ui";
  // Captured so a cleanup failure in the finally cannot replace the error
  // that actually failed the run (same rule as startLocalBindings): without
  // this, a crashed bindings child turns "test failed" into "kill() failed:
  // ESRCH" from dispose.
  let failure: unknown;
  let failed = false;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  let exitCode: number | undefined;
  try {
    local = await startLocalBindings(abort.signal, undefined, tier === "ui");
    abort.signal.throwIfAborted();
    const env: Record<string, string> = {
      ...local.env,
      NEXT_DIST_DIR: dist,
      E2E_TEST_USER_ID: `e2e-test-user-${local.env.PEW_TEST_RUN_ID}`,
      E2E_TEST_USER_EMAIL: `e2e-${local.env.PEW_TEST_RUN_ID}@test.invalid`,
      E2E_ADMIN_BYPASS: tier === "ui" ? "true" : "false",
      E2E_PORT: port,
      E2E_UI_PORT: port,
      // The lane's requests run beside a production build on a loaded machine;
      // the in-app watchdogs (leaderboard RPC today) are production values and
      // must not turn load into a harness failure.
      LEADERBOARD_RPC_TIMEOUT_MS: "300000",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"),
    };
    if (tier === "ui") {
      // `next build` prerenders with React; a development NODE_ENV makes the
      // static pass crash (`useContext` on null — React's dev branch needs a
      // renderer during prerender). The E2E auth gates key off RESOURCE_ENV,
      // not NODE_ENV, so production here costs the lane nothing and matches
      // what `next start` serves.
      env.NODE_ENV = "production";
    }
    await verifyLocalMarker(env);
    // Same window as the post-readiness check below: a signal that arrives
    // while the marker query is in flight must not let the lane spawn a
    // `next dev` / `next build` that the interrupt then has to kill.
    abort.signal.throwIfAborted();
    if (tier === "api") {
      // L2 exercises route handlers in-process; a dev server gives the
      // fastest iteration and full runtime diagnostics.
      server = Bun.spawn(["node", resolve("packages/web/node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", port], {
        cwd: "packages/web", env, stdout: "inherit", stderr: "inherit",
      });
    } else {
      // L3 runs the production build: `next dev` compiles each page on first
      // navigation, so under machine load the first goto of a page can blow
      // past navigationTimeout (the recurring single-test timeout flakes).
      // A prod server answers every navigation in milliseconds, and the
      // journeys then exercise the deployed shape of the app. The build runs
      // in the same isolated NEXT_DIST_DIR that `next start` reads below.
      build = Bun.spawn(["node", resolve("packages/web/node_modules/next/dist/bin/next"), "build"], {
        cwd: "packages/web", env, stdout: "inherit", stderr: "inherit",
      });
      const buildCode = await deadline(Promise.race([build.exited, interrupted]), 1_800_000, "next build");
      // Await exit before the finally rmSync races a still-writing process.
      await build.exited.catch(() => {
        // A rejected exited promise (killed mid-build) must not fail the run.
      });
      build = undefined;
      if (buildCode !== 0) throw new Error(`next build failed (${buildCode})`);
      server = Bun.spawn(["node", resolve("packages/web/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", port], {
        cwd: "packages/web", env, stdout: "inherit", stderr: "inherit",
      });
    }
    const started = Date.now();
    while (true) {
      abort.signal.throwIfAborted();
      if (server.exitCode !== null) throw new Error(`E2E server exited ${server.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]) });
        if (response.ok) break;
      } catch {
        abort.signal.throwIfAborted();
      }
      // Same rationale as startLocalBindings' timeout: this guards against a
      // wedged server, not slow load. The api tier boots `next dev`, whose
      // first compile can exceed a minute when the gate runs beside the
      // browser lane's production build.
      if (Date.now() - started > 900_000) throw new Error("E2E server readiness timed out");
      await Bun.sleep(200);
    }
    await verifyLocalMarker(env);
    // A signal in the readiness window has already killed the server via
    // killChildren; without this check the test process would still be
    // spawned against a dead server and the interrupt would surface as
    // connection errors instead of "E2E interrupted".
    abort.signal.throwIfAborted();
    if (tier === "api") {
      // `next dev` compiles each route on the first request to it; a cold
      // compile takes 25-35s under machine load and blew past the lane's
      // per-test timeout (the recurring single-test timeout flakes on
      // /api/auth/cli, /api/users and the retired 404s: always the first hit,
      // always followed by fast responses; the per-test budget is 120s, raised
      // from 30s for the same reason). Warm every route before the test clock
      // starts — the same reasoning that has the ui tier pre-build — so the
      // per-test timeout stays a hang detector.
      await warmApiRoutes(port, abort.signal);
    }
    tests = Bun.spawn(tier === "api"
      ? [process.execPath, "--no-env-file", "test", "packages/web/src/__tests__/e2e", "--timeout", "120000"]
      : ["node", resolve("node_modules/@playwright/test/cli.js"), "test", "--config", "packages/web/e2e/playwright.config.ts", ...args],
    { env, stdout: "inherit", stderr: "inherit" });
    exitCode = await tests.exited;
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    // Every cleanup step records instead of throwing: a throw inside finally
    // would replace the in-flight failure (Biome noUnsafeFinally, and the
    // masking this block exists to prevent). Surfaced after the finally.
    const cleanupErrors: unknown[] = [];
    // build is included deliberately: if the 1800s build deadline (or any
    // error after spawn) fires, build is still running here, and letting it
    // outlive the run would race the dist-dir rmSync below and leave an
    // orphan. The abort path kills it earlier via killChildren; killing a
    // dead child again is harmless.
    for (const child of [tests, server, build]) {
      if (child && child.exitCode === null) {
        try {
          child.kill();
          await settleWithin(child.exited, 5000);
          // A child killed by a signal keeps exitCode === null and reports it
          // through signalCode (Bun: SIGTERM → exited resolves 143). Without
          // this check every signal-killed child looked alive and took a
          // redundant SIGKILL — harmless on Bun, an ESRCH throw elsewhere,
          // which would now turn a clean run into "cleanup failed".
          const dead = child.exitCode !== null || (child.signalCode ?? null) !== null;
          if (!dead) { child.kill("SIGKILL"); await child.exited; }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      await local?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (local) rmSync(join("packages/web", dist), { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    abort.signal.removeEventListener("abort", killChildren);
    if (cleanupErrors.length === 1) {
      cleanupFailure = cleanupErrors[0];
      cleanupFailed = true;
    } else if (cleanupErrors.length > 1) {
      cleanupFailure = new AggregateError(cleanupErrors, "E2E cleanup failed");
      cleanupFailed = true;
    }
  }
  // Keep the original failure visible: a bindings child that died mid-run
  // makes dispose throw (send on a closed IPC channel, kill on a gone process
  // group), and that must not replace the real cause.
  if (abort.signal.aborted) {
    // An interrupt outranks every other failure cause: it is the reason the
    // run was cut short, and it must not be reported as a cleanup fault (a
    // SIGTERM during cleanup with a slow dispose used to surface as
    // "Local bindings disposal failed", hiding the interruption).
    const reason = abort.signal.reason;
    const errors = [reason];
    // throwIfAborted() throws the signal reason itself; do not list it twice.
    if (failed && failure !== reason) errors.push(failure);
    if (cleanupFailed) errors.push(cleanupFailure);
    if (errors.length === 1) throw reason;
    throw new AggregateError(errors, "E2E interrupted and the run did not finish cleanly");
  }
  if (cleanupFailed && failed) throw new AggregateError([failure, cleanupFailure], "E2E run failed and cleanup also failed");
  if (cleanupFailed) throw cleanupFailure;
  if (failed) throw failure;
  return exitCode ?? 1;
}
