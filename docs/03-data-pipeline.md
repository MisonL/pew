# Data Pipeline & Token Collection

> Reference for pew's token collection pipeline: raw log formats, unified
> types, aggregation, upload protocol and storage.
>
> **Status: reference.** §1.1–1.4 document the original four sources as they
> were when this doc was written; two of those identities are now retired
> (`gemini-cli`; OpenCode's JSON storage was superseded by its SQLite
> database). The current source set, per-source parsers and their contracts
> live in the per-source docs and [49-agent-operations.md](49-agent-operations.md).
> The pipeline invariants below — half-hour bucketing, client-side
> aggregation, overwrite upsert — still hold for every active source.

## Pipeline Overview

```
Stage 1          Stage 2           Stage 3          Stage 4           Stage 5
Raw Logs    -->  ParsedDelta[]  --> QueueRecord[]  --> HTTP Upload  --> Database
(per source)     (unified)         (half-hour       (batched)         (overwrite
                                    buckets)                           upsert)
```

Four independent lanes share this shape — token usage (`/api/ingest`),
sessions (`/api/ingest/sessions`), evidence (`/api/ingest/evidence`) and
accounting details (`/api/ingest/details`) — each with its own queue and
upload state files.

State files (full contract: [49-agent-operations.md](49-agent-operations.md)):

| File | Location | Purpose |
|------|----------|---------|
| `config.json` | `~/.config/pew/` | Prod API key (`pk_...`) |
| `config.dev.json` | `~/.config/pew/` | Dev API key |
| `config.<host>.json` | `~/.config/pew/` | Self-hosted instance API key (one file per host) |
| `cursors.json` / `session-cursors.json` | `~/.config/pew/` | Per-file parse cursors + directory mtimes |
| `queue.jsonl` / `queue.state.json` | `~/.config/pew/` | Token records + upload offset |
| `session-queue.jsonl` / `.state.json` | `~/.config/pew/` | Session records |
| `evidence-queue.jsonl` / `.state.json` | `~/.config/pew/` | Usage evidence (never removed by reset) |
| `accounting-queue.jsonl` / `.state.json` | `~/.config/pew/` | Accounting details |
| `sync-commit.json` | `~/.config/pew/` | Crash-recovery journal |
| `state.lock` | `~/.config/pew/` | Mutation lock (stale PID reclaimed) |

---

## Stage 1 — Raw Log Files

Each AI tool writes logs in its own format. pew discovers and parses them
incrementally using per-file cursors. §1.1–1.4 are the four formats this doc
was written around; §1.5 lists every source active today.

### 1.1 Claude Code

- **Path**: `~/.claude/projects/**/*.jsonl`
- **Format**: JSONL, one JSON object per line, tokens are **absolute** per-event
- **Incremental strategy**: Byte offset (`ByteOffsetCursor`)
- **Raw record**:
  ```jsonc
  {
    "type": "assistant",
    "timestamp": "2026-03-07T10:15:30.000Z",
    "sessionId": "ses-001",
    "model": "claude-sonnet-4-20250514",       // fallback source
    "message": {
      "model": "claude-sonnet-4-20250514",     // primary source
      "stop_reason": "end_turn",
      "usage": {
        "input_tokens": 5000,
        "cache_creation_input_tokens": 100,    // billed at full input rate
        "cache_read_input_tokens": 2000,       // billed at reduced rate
        "output_tokens": 800
      }
    }
  }
  ```
- **Skip conditions**: line missing `"usage"` string (fast-path), malformed JSON,
  missing `model`/`timestamp`, all-zero tokens
- **Quirks**: `cache_creation_input_tokens` added to `inputTokens` (not cached);
  `reasoningOutputTokens` hardcoded to 0

### 1.2 Gemini CLI

- **Path**: `~/.gemini/tmp/*/chats/session-*.json`
- **Format**: Single JSON file per session with `messages[]` array, tokens are
  **cumulative** across messages
- **Incremental strategy**: Array index + cumulative diff (`GeminiCursor`)
- **Raw record** (per message in array):
  ```jsonc
  {
    "id": "msg-001",
    "timestamp": "2026-03-07T10:15:00.000Z",
    "type": "gemini",
    "model": "gemini-2.5-pro",
    "tokens": {
      "input": 5000,
      "output": 200,
      "cached": 3000,
      "thoughts": 100,        // reasoning tokens
      "tool": 50,             // merged into outputTokens
      "total": 8350
    }
  }
  ```
- **Skip conditions**: missing `tokens` object, missing `timestamp` (totals still
  advance but no delta emitted), all-zero diff
- **Quirks**: Cumulative values require `diffTotals()` to compute per-event
  deltas; if cumulative total decreases, treated as session reset (full current
  emitted as delta); model is inherited from previous message if missing

### 1.3 OpenCode

- **Path**: `~/.local/share/opencode/storage/message/ses_*/msg_*.json`
- **Format**: One standalone JSON file per message, tokens are **cumulative**
- **Incremental strategy**: File stat triple-check (inode + size + mtime) +
  cumulative diff (`OpenCodeCursor`), with directory-level mtime optimization
- **Raw record**:
  ```jsonc
  {
    "id": "msg_001",
    "sessionID": "ses_001",
    "role": "assistant",          // only "assistant" messages processed
    "modelID": "claude-opus-4.6", // primary source
    "model": "gpt-4o",            // fallback source
    "time": {
      "created": 1771120749059,   // epoch ms (auto-coerced from seconds if < 1e12)
      "completed": 1771120822000  // preferred timestamp source
    },
    "tokens": {
      "total": 15404,
      "input": 14967,
      "output": 437,
      "reasoning": 0,
      "cache": {
        "read": 0,
        "write": 0              // added to inputTokens (not cached)
      }
    }
  }
  ```
- **Skip conditions**: `role !== "assistant"`, missing `tokens` object, unchanged
  file stat (triple-check), all-zero diff, missing timestamp
- **Quirks**: Directory mtime skip avoids scanning ~66K+ files; `cache.write`
  added to `inputTokens`; `diffTotals()` shared with Gemini parser

### 1.4 OpenClaw

- **Path**: `~/.openclaw/agents/*/sessions/*.jsonl`
- **Format**: JSONL, tokens are **absolute** per-event
- **Incremental strategy**: Byte offset (`ByteOffsetCursor`)
- **Raw record**:
  ```jsonc
  {
    "type": "message",              // only "message" type processed
    "timestamp": "2026-03-07T10:15:00.000Z",
    "message": {
      "model": "claude-sonnet-4",
      "usage": {
        "input": 5000,
        "cacheRead": 1000,
        "cacheWrite": 200,          // both added to cachedInputTokens
        "output": 800,
        "totalTokens": 7000         // required for fast-path filter
      }
    }
  }
  ```
- **Skip conditions**: line missing `"usage"` OR `"totalTokens"` (dual fast-path),
  malformed JSON, `type !== "message"`, missing `timestamp`, all-zero tokens
- **Quirks**: `cacheRead + cacheWrite` both map to `cachedInputTokens`
  (different from Claude where `cacheWrite` maps to `inputTokens`);
  `reasoningOutputTokens` hardcoded to 0

### 1.5 Current source set

Active sources (`SOURCES` in `packages/core/src/constants.ts`, 9):

| Source | Doc | Storage |
|--------|-----|---------|
| `antigravity` | [51](51-antigravity-support.md) | snapshot model (full replace + tombstones) |
| `claude-code` | this doc §1.1 | JSONL, byte offset + `seenIds` dedup ring |
| `codex` | — | JSONL, byte offset + cumulative-edge dedup |
| `copilot-cli` | — | JSONL, byte offset |
| `grok` | [42](42-grok-support.md) | JSONL `inference_done` events |
| `hermes` | [35](35-hermes-support.md) | SQLite, per-session diff |
| `opencode` | [07](07-opencode-sqlite-migration.md) | SQLite `message` table (JSON files are legacy) |
| `openclaw` | this doc §1.4 | JSONL, byte offset |
| `pi` | [05](05-token-accounting.md) | JSONL messages + compaction events |

Six identities are retired (`RETIRED_SOURCES`): `gemini-cli`, `kosmos`,
`omp`, `pmstudio`, `vscode-copilot`, `zcode`. They stay readable and count
toward historical rankings, but never accept new writes; ingest acknowledges
and ignores exact retired identities so old mixed-source batches do not block
active uploads. `VALID_SOURCES` is the union of both lists.

**Skip-and-warn contract:** a usage event dropped for a missing timestamp is
counted per file-backed source (`skippedNoTimestamp`) and reported as a
warning once per source at the end of the run; silently dropping it was how
a writer that stopped emitting the field lost usage with no signal. Events
with no usage keep their old silent skip, and raw logs are never touched.
See [49-agent-operations.md](49-agent-operations.md) for the full state and
warning contract.

### Cursor Types

One cursor family per incremental strategy, all in
`packages/core/src/types.ts`: byte-offset (`ByteOffsetCursor`; Claude adds a
bounded `seenIds` dedup ring, Codex adds cumulative-edge state), file-stat +
cumulative diff (`OpenCodeCursor`), SQLite watermarks (`OpenCodeSqliteCursor`
with `pendingIds` + `lastProcessedIds` boundary dedup, `HermesSqliteCursor`),
and mtime-based `SessionFileCursor` for session collectors. JSONL cursors
carry `continuityAnchors` (privacy-safe `{sha256, length}` markers) so a
same-inode trim/rewrite can be rebased instead of double-counted;
`continuityBroken` parks a file at a stamped offset when replay safety cannot
be proven. Cursor `size`/`offset`/anchor `length` must be non-negative
integers — a bad entry is discarded so the file goes through the
known-path full rescan instead of parking at an unreachable EOF.

---

## Stage 2 — Unified ParsedDelta

All parsers normalize into a common intermediate structure. The `source`
union is the 9 active identities of `SOURCES` (retired sources only appear in
historical data, never in new deltas).

```typescript
// packages/core/src/types.ts
interface TokenDelta {
  inputTokens: number;           // total input tokens consumed
  cachedInputTokens: number;     // input tokens served from cache (subset)
  outputTokens: number;          // total output tokens generated
  reasoningOutputTokens: number; // reasoning/thinking tokens reported separately
}

// packages/cli/src/parsers/claude.ts (shared by all parsers)
interface ParsedDelta {
  source: "antigravity" | "claude-code" | "codex" | "copilot-cli" | "grok"
        | "hermes" | "opencode" | "openclaw" | "pi";
  model: string;           // e.g. "claude-sonnet-4-20250514", "gemini-2.5-pro"
  timestamp: string;       // ISO 8601
  tokens: TokenDelta;
}
```

### Normalization Mapping (original four sources)

Gemini CLI and OpenCode-JSON rows are historical formats; the table keeps
them because old queued records and the `diffTotals()` helper still follow
these rules.

| Unified Field | Claude Code | Gemini CLI | OpenCode | OpenClaw |
|---------------|-------------|------------|----------|----------|
| `inputTokens` | `input_tokens` + `cache_creation` | `input` | `input` + `cache.write` | `input` |
| `cachedInputTokens` | `cache_read` | `cached` | `cache.read` | `cacheRead` + `cacheWrite` |
| `outputTokens` | `output_tokens` | `output` + `tool` | `output` | `output` |
| `reasoningOutputTokens` | 0 (hardcoded) | `thoughts` | `reasoning` | 0 (hardcoded) |

All token values pass through `toNonNegInt()`: negative -> 0, float -> `Math.floor()`.

---

## Stage 3 — Half-Hour Bucket Aggregation

`ParsedDelta[]` are bucketed by UTC half-hour boundaries, then written to the
local queue as `QueueRecord[]`.

```typescript
// packages/cli/src/utils/buckets.ts
function toUtcHalfHourStart(ts: string | number): string | null
// Floors to :00 or :30 -> "2026-03-07T10:00:00.000Z" or "...T10:30:00.000Z"

function bucketKey(source, model, hourStart): string
// Returns "source|model|hourStart"
```

Bucket key = `source|model|hourStart`. Tokens within the same bucket are summed.

```typescript
// packages/core/src/types.ts
interface QueueRecord {
  source: Source;
  model: string;
  hour_start: string;                // ISO 8601 half-hour boundary
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;              // = input + cached + output + reasoning
}
```

Written to `~/.config/pew/queue.jsonl` (append-only JSONL).
Upload progress tracked in `queue.state.json` as byte offset.

---

## Stage 4 — Upload Protocol

### CLI -> Next.js

```
POST /api/ingest
Content-Type: application/json
Authorization: Bearer <api_key>

Body: QueueRecord[]  (max MAX_INGEST_BATCH_SIZE = 50 per request;
                      accounting details: max 25 and a 24 MiB body cap,
                      token/session/evidence: 1 MiB body cap)
Response: { "ingested": 50, "dropped_devices": [] }
```

`ingested` counts only rows that actually applied, and `dropped_devices`
names revoked devices whose records the device guard discarded — the CLI
keeps exactly those records pending instead of clearing them. Session
uploads carry no device id and are unaffected.

Pre-upload, `aggregateRecords()` merges any `QueueRecord`s sharing the same
`(source, model, hour_start)` key by summing all token fields.

Retry logic: exponential backoff on 5xx (max 3 attempts), honor `Retry-After`
on 429, no retry on 4xx.

### Next.js -> Cloudflare Worker

```
POST <WORKER_INGEST_URL>
Content-Type: application/json
Authorization: Bearer <WORKER_SECRET>

Body: {
  "userId": "auth-user-id",
  "records": [QueueRecord, ...]
}
```

Next.js validates all records before forwarding:
- Source must be in `VALID_SOURCES` (the 9 active identities plus the 6
  retired ones; exact retired identities are acknowledged and ignored, so an
  old mixed-source batch never blocks active uploads)
- Model must be a non-empty string (accounting details additionally require
  an ASCII label of ≤128 chars)
- `hour_start` must be a canonical ISO 8601 instant
- Token fields must be non-negative integers, and
  `total_tokens = input + cached + output + reasoning`
- **All-or-nothing**: one invalid record rejects the entire batch

---

## Stage 5 — Database Schema (D1 / rqlite)

The same schema and upsert SQL run in both deployments: Cloudflare D1 for the
hosted instance, rqlite behind the Node runtime in `deploy/selfhost/`
([57–61](57-self-hosted-deployment-design.md)). Web reads do not touch the
database directly — every read goes through typed `DbRead` RPC methods served
by the read Worker over `/api/rpc`; there is no generic SQL endpoint.

### `usage_records` table

```sql
CREATE TABLE usage_records (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 TEXT NOT NULL REFERENCES users(id),
  source                  TEXT NOT NULL,
  model                   TEXT NOT NULL,
  hour_start              TEXT NOT NULL,       -- ISO 8601 half-hour boundary
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, source, model, hour_start)   -- upsert key
);

CREATE INDEX idx_usage_user_time ON usage_records(user_id, hour_start);
CREATE INDEX idx_usage_source ON usage_records(source);
```

### Upsert SQL (Worker)

```sql
INSERT INTO usage_records
  (user_id, source, model, hour_start,
   input_tokens, cached_input_tokens, output_tokens,
   reasoning_output_tokens, total_tokens)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, source, model, hour_start) DO UPDATE SET
   input_tokens = excluded.input_tokens,
   cached_input_tokens = excluded.cached_input_tokens,
   output_tokens = excluded.output_tokens,
   reasoning_output_tokens = excluded.reasoning_output_tokens,
   total_tokens = excluded.total_tokens
```

**Overwrite upsert** — last upload wins. Idempotency guaranteed by CLI-side
pre-aggregation: multiple syncs of the same source data always produce the same
aggregated totals.

### `users` table

```sql
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  image      TEXT,
  slug       TEXT UNIQUE,           -- public profile (e.g. "nocoo")
  api_key    TEXT UNIQUE,           -- CLI auth (pk_* prefix)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## End-to-End Flow Diagram

The diagram follows the four original formats of §1.1–1.4; later sources plug
into the same stages with their own cursor family (§1.5).

```
~/.claude/projects/**/*.jsonl          ByteOffsetCursor    (absolute tokens)
~/.gemini/tmp/*/chats/session-*.json   GeminiCursor        (cumulative -> diffed)
~/.local/share/opencode/.../msg_*.json OpenCodeCursor      (cumulative -> diffed)
~/.openclaw/agents/*/sessions/*.jsonl  ByteOffsetCursor    (absolute tokens)
        |
        v  parsers (per-file, incremental)
    ParsedDelta[]  { source, model, timestamp, tokens: TokenDelta }
        |
        v  toUtcHalfHourStart() + bucket aggregation
    QueueRecord[]  { source, model, hour_start, 5 token fields }
        |
        v  append to ~/.config/pew/queue.jsonl
    Local Queue (JSONL, byte-offset tracked)
        |
        v  aggregateRecords() + batches of <= 50
    POST /api/ingest  [QueueRecord[]]  (Bearer api_key)
        |
        v  Next.js validates, resolves userId
    POST <Worker URL>  { userId, records }  (Bearer WORKER_SECRET)
        |
        v  worker batch -- overwrite upsert (atomic on rqlite; the hosted
    Storage: usage_records   D1 REST path has no cross-statement batch
     (UNIQUE on user_id,     guarantee, so single-statement guards are used
      source, model,         where atomicity matters)
      hour_start)
        |
        v  read Worker: typed DbRead RPC via /api/rpc
    Web UI: charts, leaderboard, public profiles
```

### Design Properties

1. **Per-source incremental strategies** adapt to different log formats (byte
   offset / array index diff / file stat diff / SQLite watermarks)
2. **Half-hour window aggregation** compresses data volume
3. **Overwrite upsert + client-side pre-aggregation** = natural idempotency;
   repeated sync is safe
4. **Append-only local queue** decouples parsing from uploading; offline-capable
