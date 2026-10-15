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
  it("invokes scheduled on the interval and stops on demand", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockResolvedValue(undefined);
      const stop = runScheduled({ scheduled }, { A: 1 }, 1000);
      await vi.advanceTimersByTimeAsync(3500);
      expect(scheduled).toHaveBeenCalledTimes(3);
      expect(scheduled.mock.calls[0][1]).toEqual({ A: 1 });
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(scheduled).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ticking after a scheduled run rejects", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockRejectedValue(new Error("upstream down"));
      const stop = runScheduled({ scheduled }, {}, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(scheduled).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when the worker has no scheduled handler", () => {
    const stop = runScheduled({}, {}, 1000);
    expect(typeof stop).toBe("function");
    stop();
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
