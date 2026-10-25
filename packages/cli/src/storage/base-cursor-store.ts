import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureSecureDir } from "./secure-mkdir.js";

/**
 * Generic base class for persisting cursor state to disk as JSON.
 *
 * Both `CursorStore` (token cursors) and `SessionCursorStore` (session cursors)
 * share identical load/save logic — only the filename and empty-state factory differ.
 */
export class BaseCursorStore<T> {
  readonly filePath: string;
  private readonly emptyState: () => T;

  constructor(filePath: string, emptyState: () => T) {
    this.filePath = filePath;
    this.emptyState = emptyState;
  }

  /** Load cursor state from disk. Returns empty state if file doesn't exist or is corrupted. */
  async load(): Promise<T> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return this.emptyState();
    }
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
