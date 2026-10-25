import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSessionSync } from "../commands/session-sync.js";
import { SessionCursorStore } from "../storage/session-cursor-store.js";

// A parse failure must leave that file's cursor untouched: advancing it makes
// shouldSkip fast-skip the file forever, so one transient read error would
// permanently drop every session in it (until `pew reset`). The token pipeline
// already guards this with parseFailedPaths; this covers the session path.
describe("session sync cursor after a parse failure", () => {
  let root: string;
  let projects: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pew-session-cursor-"));
    projects = join(root, "projects", "proj-a");
    mkdirSync(projects, { recursive: true });
  });

  afterEach(() => {
    chmodSync(join(projects, "unreadable.jsonl"), 0o600);
    rmSync(root, { recursive: true, force: true });
  });

  async function sync() {
    const warnings: string[] = [];
    await executeSessionSync({
      stateDir: join(root, "state"),
      claudeDir: root,
      onProgress: (event: { phase: string; message?: string }) => {
        if (event.phase === "warn" && event.message) warnings.push(event.message);
      },
    } as never);
    const state = await new SessionCursorStore(join(root, "state")).load();
    return { warnings, cursors: state.files as Record<string, unknown> };
  }

  it("does not persist a cursor for the file whose parse threw", async () => {
    const readable = join(projects, "readable.jsonl");
    writeFileSync(readable, `${JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00Z", sessionId: "ses-a", message: { role: "user", content: "hi" } })}\n`);
    const unreadable = join(projects, "unreadable.jsonl");
    writeFileSync(unreadable, "{}\n");
    chmodSync(unreadable, 0o000);

    const { warnings, cursors } = await sync();

    // Non-vacuous: the unreadable file really did fail and produced a warning.
    expect(warnings.join(" ")).toContain("unreadable.jsonl");
    // The readable file still gets its cursor (the failure is per-file).
    expect(Object.keys(cursors)).toContain(readable);
    expect(Object.keys(cursors)).not.toContain(unreadable);
  }, 30_000);
});
