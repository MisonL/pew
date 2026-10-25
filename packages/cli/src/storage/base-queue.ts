import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { ensureSecureDir } from "./secure-mkdir.js";

/** Optional callback invoked when a corrupted JSONL line is skipped */
export type OnCorruptLine = (line: string, error: unknown) => void;

/** Persisted state for a queue (stored in the state JSON file) */
export interface QueueState {
  /** Byte offset into the queue file — records before this have been uploaded */
  offset: number;
  /**
   * Bucket keys that were modified since the last successful upload.
   *
   * - `undefined` → legacy state file (pre-dirty-keys), upload engine falls
   *   back to offset-based behavior.
   * - `[]` → nothing changed since last upload.
   * - `["source|model|hour|device", ...]` → only these buckets need uploading.
   */
  dirtyKeys?: string[];
  /**
   * Origin the queue was last drained to. The queue and this state file are
   * shared across hosts, so a pending backlog goes to whichever host the next
   * upload names; recording the previous target lets a host switch be
   * surfaced as a warning instead of silently re-routing pending records.
   */
  lastUploadTarget?: string;
}

/**
 * Generic append-only JSONL queue with byte-offset tracking.
 *
 * Records are stored as newline-delimited JSON. A separate state file
 * tracks how far the upload cursor has progressed (in bytes).
 *
 * Bug fixes over the original LocalQueue/SessionQueue:
 * - readFromOffset uses Buffer slicing (byte offset) instead of String.slice
 *   (character offset), which broke on non-ASCII content.
 * - Per-line JSON.parse error handling: corrupted lines are skipped instead
 *   of blocking all subsequent records.
 */
export class BaseQueue<T> {
  readonly queuePath: string;
  private readonly statePath: string;
  private readonly dir: string;
  private readonly onCorruptLine?: OnCorruptLine;

  constructor(
    storeDir: string,
    queueFile: string,
    stateFile: string,
    onCorruptLine?: OnCorruptLine,
  ) {
    this.dir = storeDir;
    this.queuePath = join(storeDir, queueFile);
    this.statePath = join(storeDir, stateFile);
    this.onCorruptLine = onCorruptLine;
  }

  /** Ensure the directory exists with secure permissions */
  private async ensureDir(): Promise<void> {
    await ensureSecureDir(this.dir, { recursive: true });
  }

  /** Append a single record to the queue */
  async append(record: T): Promise<void> {
    await this.ensureDir();
    await appendFile(this.queuePath, `${JSON.stringify(record)}\n`);
  }

  /** Append multiple records to the queue in a single write */
  async appendBatch(records: T[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureDir();
    const data = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    await appendFile(this.queuePath, data);
  }

  /**
   * Atomically overwrite the queue with new records (write tmp → rename).
   *
   * This replaces the entire queue file contents. Empty array clears the file.
   * The atomic write-then-rename prevents partial reads if the process crashes
   * mid-write.
   */
  async overwrite(records: T[]): Promise<void> {
    await this.ensureDir();
    const data =
      records.length > 0
        ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
        : "";
    const tmpPath = `${this.queuePath}.tmp`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, this.queuePath);
  }

  /**
   * Read records from the queue starting at a byte offset.
   * Returns parsed records and the new offset (end of file in bytes).
   *
   * - Uses Buffer for slicing to correctly handle multi-byte UTF-8 characters.
   * - Skips lines that fail JSON.parse and invokes the optional onCorruptLine
   *   callback so callers can surface a warning.  The offset still advances
   *   past corrupted data to prevent infinite re-reading.  Source data can
   *   always be rebuilt via `pew reset`.
   */
  async readFromOffset(offset: number): Promise<{
    records: T[];
    newOffset: number;
  }> {
    let buf: Buffer;
    try {
      buf = await readFile(this.queuePath);
    } catch {
      return { records: [], newOffset: 0 };
    }

    const slice = buf.subarray(offset);
    const text = slice.toString("utf-8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    const records: T[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as T);
      } catch (err: unknown) {
        // Corrupted lines are skipped to avoid blocking all subsequent records.
        // The onCorruptLine callback lets callers surface a user-visible warning.
        // Data is recoverable via `pew reset` which rebuilds from source files.
        this.onCorruptLine?.(line, err);
      }
    }

    const newOffset = buf.byteLength;
    return { records, newOffset };
  }

  // -------------------------------------------------------------------------
  // State persistence — unified { offset, dirtyKeys } object
  // -------------------------------------------------------------------------

  /** Load the full persisted state. Returns defaults on missing/corrupt file. */
  async loadState(): Promise<QueueState> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const state = JSON.parse(raw) as Partial<QueueState>;
      return {
        offset: state.offset ?? 0,
        // Preserve undefined vs [] distinction for legacy detection
        dirtyKeys: state.dirtyKeys,
        lastUploadTarget:
          typeof state.lastUploadTarget === "string" ? state.lastUploadTarget : undefined,
      };
    } catch {
      return { offset: 0 };
    }
  }

  /** Atomically persist the full state object (write tmp → rename). */
  async saveState(state: QueueState): Promise<void> {
    await this.ensureDir();
    // Direct writeFile leaves a torn file behind a crash or ENOSPC, and
    // loadState() treats any parse error as "no state" — which silently drops
    // the offset, the dirty set and the recorded upload target.
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state)}\n`);
    await rename(tmpPath, this.statePath);
  }

  /** Save the upload byte offset (preserves dirtyKeys). */
  async saveOffset(offset: number): Promise<void> {
    const state = await this.loadState();
    state.offset = offset;
    await this.saveState(state);
  }

  /** Load the upload byte offset. Returns 0 if not found or corrupted. */
  async loadOffset(): Promise<number> {
    const state = await this.loadState();
    return state.offset;
  }

  /**
   * Save dirty bucket keys (preserves offset).
   *
   * Pass `undefined` to remove the dirtyKeys field entirely (revert to
   * legacy state). Pass `[]` to indicate nothing is dirty.
   */
  async saveDirtyKeys(keys: string[] | undefined): Promise<void> {
    const state = await this.loadState();
    state.dirtyKeys = keys;
    await this.saveState(state);
  }

  /**
   * Load dirty bucket keys.
   *
   * Returns `undefined` for legacy state files (no dirtyKeys field),
   * or the array (possibly empty) if the field exists.
   */
  async loadDirtyKeys(): Promise<string[] | undefined> {
    const state = await this.loadState();
    return state.dirtyKeys;
  }

  /** Record the origin the queue was last drained to (preserves offset/dirtyKeys). */
  async saveLastUploadTarget(target: string): Promise<void> {
    const state = await this.loadState();
    state.lastUploadTarget = target;
    await this.saveState(state);
  }
}
