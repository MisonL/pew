import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalBindings } from "../e2e-utils";

function stubChild(pid: number, signalCode: string | null = null) {
  let exit: (code: number) => void;
  const exited = new Promise<number>((done) => { exit = done; });
  return { pid, exitCode: null as number | null, signalCode, exited, send: vi.fn(), exit: () => exit(137) };
}

function stubBun(child: ReturnType<typeof stubChild>) {
  vi.stubGlobal("Bun", { spawn: vi.fn(() => child) });
}

describe("Local bindings startup budget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lets PEW_E2E_BINDINGS_TIMEOUT_MS widen the default startup budget", async () => {
    // The override is a STARTUP budget only. With 50ms the startup deadline
    // fires at 50ms; disposal then runs to its own 30s cap (the child never
    // exits), so the call settles with an AggregateError at ~60s rather than
    // at ~5s — proving both that the override reached startup and that it
    // did not shorten disposal.
    vi.useFakeTimers();
    const child = stubChild(123457);
    stubBun(child);
    vi.stubEnv("PEW_E2E_BINDINGS_TIMEOUT_MS", "50");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const settled = vi.fn();
    const pending = startLocalBindings(new AbortController().signal)
      .catch((error: unknown) => { settled(error); return error; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(70_000);
    const error = await pending;
    expect(settled).toHaveBeenCalled();
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e) => (e as Error).message).join(" ")
      .match(/startup timed out/g)).toHaveLength(1);
    expect(kill).toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith("dispose");
  });

  it("lets a small override shorten startup without shortening disposal", async () => {
    // Disposal is capped separately: a tiny startup budget (the env override)
    // must not compress cleanup to the same value, or a child that is slow to
    // exit is SIGKILLed mid-shutdown. The startup deadline still fires at the
    // override, and disposal then runs to its own 30s ceiling — so with a
    // 20ms override the SIGKILL lands at ~30s, not at ~40ms.
    vi.useFakeTimers();
    const child = stubChild(123458);
    stubBun(child);
    vi.stubEnv("PEW_E2E_BINDINGS_TIMEOUT_MS", "20");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const pending = startLocalBindings(new AbortController().signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    const error = await pending;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e) => (e as Error).message).join(" ")).toContain("startup timed out");
    expect(kill).toHaveBeenCalledWith(-123458, "SIGKILL");
  });

  it("keeps the default startup budget when the override is malformed", async () => {
    // A malformed value must not switch the deadline off — the child here
    // never reports ready, so only the default (900s) can settle it. If the
    // bad value were used the call would reject far sooner.
    vi.useFakeTimers();
    for (const value of ["0", "-1", "abc", ""]) {
      // Re-apply the stub each round: the loop restores in the finally.
      const child = stubChild(123459);
      stubBun(child);
      vi.stubEnv("PEW_E2E_BINDINGS_TIMEOUT_MS", value);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const settled = vi.fn();
      void startLocalBindings(new AbortController().signal)
        .catch((error: unknown) => { settled(error); return error; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).not.toHaveBeenCalled();
      // The 900s startup fires, then dispose (30s) + forced exit (30s).
      await vi.advanceTimersByTimeAsync(965_000);
      expect(settled).toHaveBeenCalled();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      kill.mockRestore();
    }
  });

  it("caps the disposal deadline below a long startup budget", async () => {
    // A child that ignores IPC will not start responding sooner because
    // startup was given a long budget, and the 900s default would make every
    // failure path wait 15 minutes per disposal step.
    vi.useFakeTimers();
    const child = stubChild(123460);
    stubBun(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const abort = new AbortController();
    const pending = startLocalBindings(abort.signal).catch((error: unknown) => error);
    abort.abort(new Error("synthetic interruption"));
    // Interrupt settles startup; the capped 30s disposal deadline then fires,
    // as does the equally capped forced-exit deadline after the SIGKILL.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await pending).toBeInstanceOf(AggregateError);
    expect(kill).toHaveBeenCalledWith(-123460, "SIGKILL");
  });
});

describe("Local bindings disposal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not signal-kill a child that already died from a signal", async () => {
    // A child killed by a signal keeps exitCode null, so an exitCode-only
    // liveness check sends SIGKILL to a gone process group and throws ESRCH
    // over the IPC error that explains what happened.
    stubBun(stubChild(123459, "SIGTERM"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const error = await startLocalBindings(new AbortController().signal, 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(((error as AggregateError).errors[1] as Error).message).toContain("disposal timed out");
    expect(kill).not.toHaveBeenCalled();
  });
});
