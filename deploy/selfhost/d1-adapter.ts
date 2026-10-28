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

import { toAuthorizationHeader, type BasicAuth } from "./basic-auth";

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
  /**
   * Linearizable read (`level=strong`). Unlike all(), this always reflects the
   * latest committed write, at the cost of an extra round-trip to the leader.
   * The migration ledger uses it: reading a stale `_migrations` could re-run an
   * already-applied (and non-idempotent) migration.
   */
  strong<T = unknown>(): Promise<D1Result<T>>;
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
  /** rqlite -auth credentials. When set, replaces the Bearer token header. */
  basicAuth?: BasicAuth;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
      // rqlite omits rows_affected entirely when zero rows changed (correct:
      // D1 also reports changes 0). But rqlite ALSO omits it for a write with a
      // RETURNING clause even when rows were affected — so `meta.changes` is 0
      // there while Cloudflare D1 would report 1. Callers that branch on
      // `changes === 0` must not do so after a RETURNING write (use the
      // returned rows instead).
      changes: raw.rows_affected ?? 0,
      duration: toMillis(raw.time),
      // rqlite reports last_insert_id on SELECTs too (it carries over from the
      // previous write on that connection), while D1 only provides it after an
      // insert. No consumer reads meta.last_row_id today; a future one must not
      // trust it for read statements.
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
  const authorization = options.basicAuth
    ? toAuthorizationHeader(options.basicAuth)
    : options.token
      ? `Bearer ${options.token}`
      : undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(authorization ? { Authorization: authorization } : {}),
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
    // Non-JSON body (e.g. a proxy's plain-text 401) must surface the status
    // code, not a parse error — and must never include request credentials.
    const body = (await response.json().catch(() => null)) as RqliteResponse | null;
    if (!response.ok || !body) {
      throw new Error(
        body?.error ?? body?.results?.[0]?.error ?? `rqlite HTTP ${response.status}`
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
      async strong<T = unknown>(): Promise<D1Result<T>> {
        const rows = await call("/db/query?level=strong&associative&timings", [[sql, ...params]]);
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

      // rqlite also silently drops empty statements (verified on 10.5.3), so
      // a short array without an error means results[i] no longer describes
      // stmts[i]. Positional consumers (leaderboard-snapshot results[1..3],
      // accounting results[i*2+1]) would read another statement's result.
      if (rows.length !== stmts.length) {
        throw new Error(`rqlite returned ${rows.length} results for ${stmts.length} statements`);
      }

      return rows.map((r) => toD1Result(r) as D1Result<T>);
    },
  };
}
