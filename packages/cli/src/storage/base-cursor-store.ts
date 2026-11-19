import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureSecureDir } from "./secure-mkdir.js";

/**
 * Generic base class for persisting cursor state to disk as JSON.
 *
 * Both `CursorStore` (token cursors) and `SessionCursorStore` (session cursors)
 * share identical load/save logic — only the filename, empty-state factory and
 * shape check differ.
 */
export class BaseCursorStore<T> {
  readonly filePath: string;
  private readonly emptyState: () => T;
  private readonly revive: (state: Record<string, unknown>) => T | null;

  /**
   * `revive` turns a parsed JSON object into the store's state, or returns
   * null when the object cannot be trusted. A rejected file is treated exactly
   * like a torn one: the state is gone, so the caller's recovery path (a full
   * rescan for cursors) runs instead of every reader tripping over the same
   * wrong-typed field.
   */
  constructor(filePath: string, emptyState: () => T, opts: { revive?: (state: Record<string, unknown>) => T | null } = {}) {
    this.filePath = filePath;
    this.emptyState = emptyState;
    this.revive = opts.revive ?? ((state) => state as T);
  }

  /**
   * Load cursor state from disk.
   *
   * A missing file is a fresh state directory and a file that does not parse
   * is the torn tail of a crashed save — both fall back to `emptyState()`.
   * Two other outcomes must NOT be mistaken for either:
   *
   * - Valid JSON that is not an object ("null", an array, a bare string).
   *   Handing that back crashed every consumer reading a field off it
   *   (`Object.entries(cursors.files)`), taking down the sync of every source
   *   rather than the one truncated state file.
   * - Any read error that is not ENOENT (EACCES, EIO, EMFILE). Reading it as
   *   "no cursors yet" makes the next sync a first run, which replaces
   *   queue.jsonl with only what it can rediscover — pending records whose raw
   *   logs have since rotated are dropped without a warning.
   */
  async load(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return this.emptyState();
      // Name the file and keep the cause: the operator sees "EACCES" without
      // knowing which state file blocked the sync, and the usual advice
      // (`pew reset`) does not apply when the file cannot even be read.
      throw new Error(
        `Cannot read cursor state ${this.filePath}: ${(error as Error | undefined)?.message ?? String(error)}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.emptyState();
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.emptyState();
    }
    return this.revive(parsed as Record<string, unknown>) ?? this.emptyState();
  }

  /** Save cursor state atomically (write tmp → rename), creating the directory if needed. */
  async save(state: T): Promise<void> {
    const dir = dirname(this.filePath);
    await ensureSecureDir(dir, { recursive: true });
    // A torn cursor file reads back as emptyState(), so a crash mid-write
    // would silently turn into a full re-scan of every source.
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state)}\n`);
    await rename(tmpPath, this.filePath);
  }
}
