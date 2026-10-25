import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSecureDir } from "../storage/secure-mkdir.js";
import { LocalQueue } from "../storage/local-queue.js";

describe("state directory permissions", () => {
  let root: string;

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("tightens a pre-existing world-readable directory", async () => {
    // The state directory is often created first by a writer that passes no
    // mode (base-cli's ConfigManager), and mkdir({ mode }) is ignored for a
    // directory that already exists — it stayed 0755, exposing cursor files
    // that list absolute project paths to other local users.
    root = mkdtempSync(join(tmpdir(), "pew-perm-"));
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o755 });
    expect(statSync(state).mode & 0o777).toBe(0o755);
    await ensureSecureDir(state, { recursive: true });
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });

  it("creates a new directory restricted from the start", async () => {
    root = mkdtempSync(join(tmpdir(), "pew-perm-"));
    const state = join(root, "fresh");
    await ensureSecureDir(state, { recursive: true });
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });

  it("applies when a queue writes into an existing loose directory", async () => {
    root = mkdtempSync(join(tmpdir(), "pew-perm-"));
    const state = join(root, "loose");
    mkdirSync(state, { mode: 0o755 });
    expect(statSync(state).mode & 0o777).toBe(0o755);
    await new LocalQueue(state).saveOffset(0);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });
});
