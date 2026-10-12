/**
 * Cloudflare D1 binding shape over rqlite's HTTP API.
 *
 * The shape here is dictated by actual call sites in packages/worker and
 * packages/worker-read, not by the D1 type definitions:
 *   - prepare() must itself carry all/first/run (4 call sites skip bind)
 *   - batch() receives statement OBJECTS, some never bound
 *   - results must carry `success: true` (leaderboard-snapshot.ts:95 checks it)
 *   - sql/params must be public properties (count-response.ts proxies with
 *     Reflect.get, which does not see #private fields)
 */

export interface D1Result<T = unknown> {
  success: true;
  results: T[];
  meta: { changes: number; duration: number; last_row_id?: number };
}

export interface D1StatementLike {
  readonly sql: string;
  readonly params: unknown[];
  bind(...params: unknown[]): D1StatementLike;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch<T = unknown>(stmts: D1StatementLike[]): Promise<D1Result<T>[]>;
}

export interface D1AdapterOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

interface RqliteStatementResult {
  rows?: Record<string, unknown>[] | null;
  rows_affected?: number;
  last_insert_id?: number;
  time?: number;
  error?: string;
}

interface RqliteResponse {
  results?: RqliteStatementResult[];
  error?: string;
}

/** rqlite returns seconds under ?timings; D1 meta.duration is milliseconds. */
function toMillis(time: number | undefined): number {
  return typeof time === "number" ? Math.round(time * 1000) : 0;
}

function toD1Result(raw: RqliteStatementResult): D1Result {
  return {
    success: true,
    results: raw.rows ?? [],
    meta: {
      // rqlite omits rows_affected entirely when zero rows changed.
      changes: raw.rows_affected ?? 0,
      duration: toMillis(raw.time),
      ...(typeof raw.last_insert_id === "number"
        ? { last_row_id: raw.last_insert_id }
        : {}),
    },
  };
}

/** rqlite reports SQL failures inside an HTTP 200 body. */
function assertNoError(raw: RqliteStatementResult): void {
  if (raw.error) throw new Error(raw.error);
}

export function createD1Adapter(options: D1AdapterOptions): D1Like {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };

  async function call(path: string, statements: unknown[][]): Promise<RqliteStatementResult[]> {
    const response = await doFetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(statements),
      // Bound every rqlite round-trip: without a signal a wedged node would
      // hang the caller forever (Node's fetch has no default timeout).
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as RqliteResponse;
    if (!response.ok) {
      throw new Error(
        body.error ?? body.results?.[0]?.error ?? `rqlite HTTP ${response.status}`
      );
    }
    if (body.error) throw new Error(body.error);
    return body.results ?? [];
  }

  function makeStatement(sql: string, params: unknown[]): D1StatementLike {
    return {
      sql,
      params,
      bind: (...next: unknown[]) => makeStatement(sql, next),
      async all<T = unknown>(): Promise<D1Result<T>> {
        // Flat param encoding: [sql, p1, p2]. Nested arrays silently return
        // empty rows on /db/query.
        const rows = await call("/db/query?level=weak&associative&timings", [[sql, ...params]]);
        const first = rows[0] ?? {};
        assertNoError(first);
        return toD1Result(first) as D1Result<T>;
      },
      async first<T = unknown>(column?: string): Promise<T | null> {
        const { results } = await this.all<Record<string, unknown>>();
        const row = results[0];
        if (row === undefined) return null;
        return (column === undefined ? row : row[column]) as T;
      },
      async run(): Promise<D1Result> {
        // /db/request, not /db/execute: a single INSERT may carry RETURNING, and
        // /db/execute is documented to drop rows from such statements. Only
        // /db/request routes every statement through the query path, which is
        // also the path d1-http uses for the same statement.
        const rows = await call("/db/request?transaction=true&associative&timings", [[sql, ...params]]);
        const first = rows[0] ?? {};
        assertNoError(first);
        return toD1Result(first);
      },
    };
  }

  return {
    prepare(sql: string): D1StatementLike {
      return makeStatement(sql, []);
    },

    async batch<T = unknown>(stmts: D1StatementLike[]): Promise<D1Result<T>[]> {
      // rqlite answers an empty array with HTTP 400 "no statements".
      if (stmts.length === 0) return [];

      const payload = stmts.map((s) => [s.sql, ...s.params]);
      // /db/execute silently drops rows from plain SELECTs; only /db/request
      // routes every statement through the query path. transaction=true makes
      // the batch atomic.
      const rows = await call("/db/request?transaction=true&associative&timings", payload);

      // rqlite truncates `results` at the failing statement, so an error can
      // hide behind a short array. Surface it before anything else.
      const failure = rows.find((r) => r.error);
      if (failure?.error) throw new Error(failure.error);

      return rows.map((r) => toD1Result(r) as D1Result<T>);
    },
  };
}
