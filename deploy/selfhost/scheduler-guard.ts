/**
 * Guards for the self-hosted scheduler's interval timer.
 *
 * Node and Bun store a timer's delay in a 32-bit signed integer. A larger
 * value is not rejected: both emit `TimeoutOverflowWarning` and replace the
 * delay with 1 ms (verified on Bun 1.4.4 — 2592000000 produced a tick every
 * millisecond). Without an upper bound, a documented "monthly" setting turns
 * the daily pricing sync into a tight loop that floods rqlite and the upstream
 * pricing APIs, so any value outside the representable range falls back to the
 * default instead.
 */

export const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** One minute: below this the daily sync stops being daily and starts polling. */
export const MIN_DAILY_INTERVAL_MS = 60_000;

export interface ResolvedInterval {
  intervalMs: number;
  /** Set when the configured value was rejected; the caller logs it. */
  error: string | null;
}

export function resolveDailyIntervalMs(raw: string | undefined): ResolvedInterval {
  // `docker compose` injects an empty string when the variable is unset
  // (`${DAILY_INTERVAL_MS:-default}` only defaults inside compose itself), so
  // empty must mean "use the default", not "0 ms".
  if (raw === undefined || raw.trim() === "") return { intervalMs: DEFAULT_DAILY_INTERVAL_MS, error: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_DAILY_INTERVAL_MS || value > MAX_TIMER_DELAY_MS) {
    return {
      intervalMs: DEFAULT_DAILY_INTERVAL_MS,
      error: `invalid DAILY_INTERVAL_MS "${raw}", falling back to 24h`,
    };
  }
  return { intervalMs: value, error: null };
}

export interface SingleFlight {
  /** Run the job, or join the one already in flight. */
  trigger(run: () => Promise<void>): Promise<void>;
  /** Runs skipped since the last completed one. */
  skipped(): number;
  running(): boolean;
}

/**
 * Serializes scheduled runs. The timer fires on its own schedule, so a run that
 * outlasts the interval would otherwise start a second pricing sync on top of
 * the first; both read `pricing:dynamic`, merge independently and write it
 * back, so whichever finishes last can drop entries the other just fetched. A
 * skipped trigger resolves with the in-flight run, which is also what shutdown
 * draining waits for.
 */
export function createSingleFlight(onSkip?: () => void): SingleFlight {
  let inFlight: Promise<void> | null = null;
  let skipped = 0;
  return {
    trigger(run: () => Promise<void>): Promise<void> {
      if (inFlight) {
        // Log the first skip of a run, not every millisecond of a misconfigured
        // interval that somehow slipped past the range check.
        if (skipped === 0) onSkip?.();
        skipped += 1;
        return inFlight;
      }
      const started = run().finally(() => {
        if (inFlight === started) inFlight = null;
        skipped = 0;
      });
      inFlight = started;
      return started;
    },
    skipped: () => skipped,
    running: () => inFlight !== null,
  };
}

/** Interval for the kv_cache sweep: far shorter than the daily pricing sync. */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface Sweeper {
  /** Run a sweep now, joining one already in flight. Never rejects. */
  run(): Promise<void>;
  /** Invocations that actually ran (a joined call does not count). */
  runs(): number;
}

/**
 * Serialize kv_cache sweeps and swallow their failures.
 *
 * The sweep removes expired cache rows, and rqlite does not expire them
 * itself. It used to ride the daily pricing tick, which is the wrong period:
 * leaderboard snapshots live 10–30 minutes, so a day-long cadence left half a
 * day of dead rows on average — and because the daily timer restarts with the
 * container, a deployment more frequent than `DAILY_INTERVAL_MS` postponed the
 * sweep indefinitely (verified in the live backups: a snapshot that expired on
 * the 13th was still present on the 14th and 15th). Running it on its own
 * short timer keeps the table near-clean and decouples it from the sync, so a
 * wedge in one never stalls the other.
 */
export function createSweeper(sweep: () => Promise<number>, onError?: (error: unknown) => void): Sweeper {
  let inFlight: Promise<void> | null = null;
  let runs = 0;
  return {
    run(): Promise<void> {
      if (inFlight) return inFlight;
      runs += 1;
      inFlight = sweep()
        .then(() => undefined)
        .catch((error: unknown) => { onError?.(error); })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
    runs: () => runs,
  };
}
