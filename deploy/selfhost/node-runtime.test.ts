import { describe, it, expect, vi } from "vitest";
import { createWorkerServer, registerShutdownSignals, requireSecret, runScheduled } from "./node-runtime";

describe("createWorkerServer", () => {
  it("bridges node:http requests into the worker fetch handler", async () => {
    const seen: string[] = [];
    const worker = {
      async fetch(request: Request): Promise<Response> {
        seen.push(new URL(request.url).pathname);
        return Response.json({ ok: true, method: request.method });
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, method: "GET" });
      expect(seen).toEqual(["/api/live"]);
    } finally {
      await handle.close();
    }
  });

  it("forwards the request body for POST", async () => {
    const worker = {
      async fetch(request: Request): Promise<Response> {
        const body = await request.json();
        return Response.json({ received: body });
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "ping" }),
      });
      expect(await res.json()).toEqual({ received: { method: "ping" } });
    } finally {
      await handle.close();
    }
  });

  it("passes env through to the worker", async () => {
    const worker = {
      async fetch(_request: Request, env: { SECRET: string }): Promise<Response> {
        return Response.json({ secret: env.SECRET });
      },
    };
    const server = createWorkerServer({ worker, env: { SECRET: "s3cr3t" }, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`);
      expect(await res.json()).toEqual({ secret: "s3cr3t" });
    } finally {
      await handle.close();
    }
  });

  it("answers 500 instead of crashing when the worker throws", async () => {
    const worker = {
      async fetch(): Promise<Response> {
        throw new Error("boom");
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/live`);
      expect(res.status).toBe(500);
      // The 500 path must close the connection: the request body of an
      // aborted read would otherwise be re-parsed as the next keep-alive
      // request (same trap the d1-http 413 path fixes, wire-asserted here).
      expect(res.headers.get("connection")).toBe("close");
    } finally {
      await handle.close();
    }
  });
});

describe("runScheduled", () => {
  it("runs once immediately at startup, before the first interval elapses", async () => {
    // setInterval does not fire until one full period has elapsed. With the
    // production DAILY_INTERVAL_MS (24h) that meant the first pricing sync and
    // kv_cache sweep landed a day after every restart — and a container
    // recreated more often than the interval never ran them at all (verified
    // on the live deployment: 3h uptime, zero ticks, expired cache rows left).
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockResolvedValue(undefined);
      const handle = runScheduled({ scheduled }, {}, 86_400_000);
      expect(scheduled).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).toHaveBeenCalledTimes(1);
      // The immediate run must not shorten the interval cadence.
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(scheduled).toHaveBeenCalledTimes(2);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokes scheduled on the interval and stops on demand", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockResolvedValue(undefined);
      const scheduledHandle = runScheduled({ scheduled }, { A: 1 }, 1000);
      await vi.advanceTimersByTimeAsync(3500);
      // 1 immediate run + 3 interval ticks.
      expect(scheduled).toHaveBeenCalledTimes(4);
      expect(scheduled.mock.calls[0][1]).toEqual({ A: 1 });
      scheduledHandle.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(scheduled).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ticking after a scheduled run rejects", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockRejectedValue(new Error("upstream down"));
      const scheduledHandle = runScheduled({ scheduled }, {}, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      // 1 immediate run + 2 interval ticks.
      expect(scheduled).toHaveBeenCalledTimes(3);
      scheduledHandle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a handler that throws synchronously", async () => {
    // The immediate run executes outside a timer callback, so a synchronous
    // throw would otherwise reject the module-level call and crash the
    // scheduler container before any tick is ever scheduled.
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn(() => {
        throw new Error("boom");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const handle = runScheduled({ scheduled }, {}, 1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(scheduled).toHaveBeenCalledTimes(2);
        expect(errorSpy).toHaveBeenCalled();
        handle.stop();
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when the worker has no scheduled handler", () => {
    const handle = runScheduled({}, {}, 1000);
    expect(typeof handle.stop).toBe("function");
    handle.stop();
    return expect(handle.drain()).resolves.toBeUndefined();
  });

  it("drain waits for an in-flight run instead of letting shutdown cut it off", async () => {
    // A pricing sync writes D1 and KV in sequence; process.exit during it
    // would leave the cache half-updated. drain() must resolve only after the
    // running tick finishes.
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const scheduled = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const handle = runScheduled({ scheduled }, {}, 86_400_000);
      // The immediate startup run is already in flight.
      expect(scheduled).toHaveBeenCalledTimes(1);
      let drained = false;
      const drain = handle.drain().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      finish();
      await drain;
      expect(drained).toBe(true);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain waits for every overlapping tick, not only the newest", async () => {
    // A run that outlasts the interval overlaps the next tick. Tracking a
    // single "latest promise" let drain() resolve as soon as the newest tick
    // settled, while older runs were still writing D1/KV.
    vi.useFakeTimers();
    try {
      const finishes: Array<() => void> = [];
      const scheduled = vi.fn(() => new Promise<void>((resolve) => { finishes.push(resolve); }));
      const handle = runScheduled({ scheduled }, {}, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      // 1 startup run + 2 interval ticks, all still pending.
      expect(scheduled).toHaveBeenCalledTimes(3);

      let drained = false;
      const drain = handle.drain().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);

      // Settle the NEWEST tick first: the older two must still hold drain.
      finishes[2]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);

      finishes[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);

      finishes[1]!();
      await drain;
      expect(drained).toBe(true);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerShutdownSignals", () => {
  it("closes the server on SIGTERM and SIGINT", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((signal: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers[String(signal)] = handler as () => void;
        return process;
      }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      registerShutdownSignals(close);
      expect(typeof handlers.SIGTERM).toBe("function");
      expect(typeof handlers.SIGINT).toBe("function");
      handlers.SIGTERM!();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits non-zero when the drain fails so restart policies fire", async () => {
    const close = vi.fn().mockRejectedValue(new Error("port still bound"));
    const handlers: Record<string, () => void> = {};
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((signal: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers[String(signal)] = handler as () => void;
        return process;
      }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      registerShutdownSignals(close);
      handlers.SIGINT!();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("createWorkerServer.listen", () => {
  it("rejects when the port is already in use", async () => {
    const worker = { fetch: async () => new Response("ok") };
    const first = await createWorkerServer({ worker, env: {}, port: 0 }).listen();
    try {
      const port = first.port;
      await expect(createWorkerServer({ worker, env: {}, port }).listen()).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});

describe("requireSecret", () => {
  it("returns the value when it is a real secret", () => {
    expect(requireSecret("X", "s3cr3t")).toBe("s3cr3t");
  });

  it.each(["", "replace-me", "changeme", "secret"])("exits when the value is %j", (value) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      requireSecret("CF_D1_API_TOKEN", value);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
