import { describe, it, expect } from "vitest";
import { createSingleFlight, resolveDailyIntervalMs, MAX_TIMER_DELAY_MS, DEFAULT_DAILY_INTERVAL_MS } from "./scheduler-guard";

describe("resolveDailyIntervalMs", () => {
  it("defaults to 24h when the variable is absent", () => {
    expect(resolveDailyIntervalMs(undefined)).toEqual({ intervalMs: DEFAULT_DAILY_INTERVAL_MS, error: null });
  });

  it("treats an empty value as absent (compose injects an empty string for unset)", () => {
    expect(resolveDailyIntervalMs("")).toEqual({ intervalMs: DEFAULT_DAILY_INTERVAL_MS, error: null });
    expect(resolveDailyIntervalMs("  ")).toEqual({ intervalMs: DEFAULT_DAILY_INTERVAL_MS, error: null });
  });

  it("accepts an explicit interval", () => {
    expect(resolveDailyIntervalMs("3600000")).toEqual({ intervalMs: 3_600_000, error: null });
  });

  it("accepts the largest delay setInterval can represent", () => {
    expect(resolveDailyIntervalMs(String(MAX_TIMER_DELAY_MS))).toEqual({ intervalMs: MAX_TIMER_DELAY_MS, error: null });
  });

  it("rejects a delay beyond 2^31-1 ms instead of letting setInterval coerce it to 1 ms", () => {
    // Node and Bun store the delay in a 32-bit signed int; a larger value is
    // silently replaced with 1 ms (verified on Bun 1.4.4:
    // TimeoutOverflowWarning, then a tick every millisecond). A "monthly"
    // 2592000000 would turn the daily pricing sync into a tight loop.
    const result = resolveDailyIntervalMs("2592000000");
    expect(result.intervalMs).toBe(DEFAULT_DAILY_INTERVAL_MS);
    expect(result.error).toContain("2592000000");
  });

  it("rejects a non-positive, non-integer or non-numeric value", () => {
    for (const raw of ["abc", "0", "-5", "1.5", "NaN", "Infinity"]) {
      const result = resolveDailyIntervalMs(raw);
      expect(result.intervalMs, raw).toBe(DEFAULT_DAILY_INTERVAL_MS);
      expect(result.error, raw).not.toBeNull();
    }
  });
});

describe("createSingleFlight", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("does not start a second run while the first is still in flight", async () => {
    const first = deferred();
    let calls = 0;
    const job = async () => {
      calls += 1;
      await first.promise;
    };
    const flight = createSingleFlight();

    const a = flight.trigger(job);
    const b = flight.trigger(job);
    // Both callers wait on the run that is actually in flight.
    expect(calls).toBe(1);
    expect(flight.skipped()).toBe(1);
    expect(flight.running()).toBe(true);

    first.resolve();
    await Promise.all([a, b]);
    expect(flight.running()).toBe(false);
    expect(flight.skipped()).toBe(0);
  });

  it("reports the first skipped run of a burst once", async () => {
    const first = deferred();
    const seen: number[] = [];
    const flight = createSingleFlight(() => seen.push(1));
    const job = async () => {
      await first.promise;
    };
    const a = flight.trigger(job);
    void flight.trigger(job);
    void flight.trigger(job);
    expect(seen).toEqual([1]);
    first.resolve();
    await a;
    expect(flight.skipped()).toBe(0);
  });

  it("starts a new run after the previous one settled", async () => {
    let calls = 0;
    const flight = createSingleFlight();
    const job = async () => {
      calls += 1;
    };
    await flight.trigger(job);
    await flight.trigger(job);
    expect(calls).toBe(2);
    expect(flight.skipped()).toBe(0);
  });

  it("releases the slot when the run rejects, and surfaces the rejection", async () => {
    let calls = 0;
    const flight = createSingleFlight();
    const job = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    };
    await expect(flight.trigger(job)).rejects.toThrow("boom");
    expect(flight.running()).toBe(false);
    await expect(flight.trigger(job)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
