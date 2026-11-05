import { describe, expect, it, vi } from "vitest";
import { discoverOrSkip } from "../commands/session-sync-helpers";

describe("discoverOrSkip", () => {
  it("returns the discovered files unchanged", async () => {
    const files = await discoverOrSkip("codex", async () => ["a.jsonl", "b.jsonl"]);
    expect(files).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("returns null and warns instead of propagating a discovery failure", async () => {
    // One source's unreadable directory must not abort the whole session sync:
    // the caller skips this source, the others keep parsing, and the queue is
    // left untouched.
    const onProgress = vi.fn();
    const files = await discoverOrSkip(
      "codex",
      async () => {
        throw new Error("EACCES: permission denied");
      },
      onProgress,
    );

    expect(files).toBeNull();
    expect(onProgress).toHaveBeenCalledWith({
      source: "codex",
      phase: "warn",
      message: expect.stringMatching(/codex.*discovery failed.*EACCES/),
    });
  });

  it("distinguishes an empty result from a failure", async () => {
    // [] means "this source has nothing to parse" and must still flow through
    // the parse loop (which may prune cursors); null means "skip this source".
    expect(await discoverOrSkip("claude", async () => [])).toEqual([]);
  });

  it("works without a progress callback", async () => {
    await expect(
      discoverOrSkip("pi", async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeNull();
  });
});
