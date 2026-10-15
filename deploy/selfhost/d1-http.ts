/**
 * Serves the Cloudflare D1 REST API shape that packages/web/src/lib/d1.ts
 * expects, backed by rqlite.
 *
 * lib/d1.ts:143-170 requires { success, result: [{ success, results, meta }],
 * errors }. rqlite supplies none of the envelope fields and omits `meta`
 * entirely, so this module synthesises them. Two consequences if it did not:
 *   - data.success undefined throws at d1.ts:163
 *   - a missing meta falls back to { changes: 0 } at d1.ts:100/124, which
 *     makes invite.ts:147 treat every invite code as already used
 *
 * Batch responses also pad the result array to the statement count: rqlite
 * truncates it at the failing statement, and d1.ts:119 rejects a short array
 * with "Invalid D1 batch result" before the real SQL error can surface.
 */

import { createD1Adapter, type D1Like, type D1Result } from "./d1-adapter";

export interface D1HttpOptions {
  baseUrl: string;
  token: string;
  /** rqlite -auth credentials, forwarded to the inner d1 adapter. */
  basicAuth?: { username: string; password: string };
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

interface D1HttpBody {
  sql?: string;
  params?: unknown[];
  batch?: { sql: string; params?: unknown[] }[];
}

const EMPTY_RESULT: D1Result = {
  success: true,
  results: [],
  meta: { changes: 0, duration: 0 },
};

export function createD1HttpServer(options: D1HttpOptions) {
  const db: D1Like = createD1Adapter({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.basicAuth ? { basicAuth: options.basicAuth } : {}),
    fetchImpl: options.fetchImpl,
  });
  const expectedAuth = `Bearer ${options.token}`;

  // Constant-time compare: `!==` short-circuits, so a leaked prefix could be
  // used to guess the token character by character. The upstream workers
  // already compare their shared secrets this way (packages/worker/src/index.ts
  // secureCompare; worker-read/src/index.ts). Lengths are padded, not early-
  // returned, so the comparison also does not leak the token length (same as
  // worker-read's secureCompare).
  function secureEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const ba = enc.encode(a);
    const bb = enc.encode(b);
    const max = Math.max(ba.length, bb.length);
    let diff = ba.length ^ bb.length;
    for (let i = 0; i < max; i++) {
      diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
    }
    return diff === 0;
  }

  function envelope(result: D1Result[], errors: { message: string }[]) {
    return Response.json({
      success: errors.length === 0,
      result,
      errors,
    });
  }

  return {
    async handle(request: Request): Promise<Response> {
      if (!secureEqual(request.headers.get("Authorization") ?? "", expectedAuth)) {
        return Response.json(
          { success: false, result: [], errors: [{ message: "Unauthorized" }] },
          { status: 401 }
        );
      }

      let body: D1HttpBody;
      try {
        body = (await request.json()) as D1HttpBody;
      } catch {
        return Response.json(
          { success: false, result: [], errors: [{ message: "Invalid JSON" }] },
          { status: 400 }
        );
      }

      try {
        // Everything goes through batch(). lib/d1.ts posts BOTH query() and
        // execute() to <mount>/query, so a single statement arriving here may
        // well be an INSERT/UPDATE/DELETE. The adapter's prepare().all() hits
        // rqlite's /db/query, which rejects any write with
        // "attempt to change database via query operation" (verified). Only
        // /db/request routes every statement through the query path, so
        // wrapping single statements in a one-element batch is what makes the
        // write path work at all.
        const batch = Array.isArray(body.batch)
          ? body.batch
          : [{ sql: body.sql ?? "", params: body.params ?? [] }];
        if (batch.length === 0) return envelope([], []);
        const stmts = batch.map((s) => db.prepare(s.sql).bind(...(s.params ?? [])));
        const results = await db.batch(stmts);
        return envelope(results, []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Keep the array long enough for d1.ts:119's length check to pass so
        // the real error message reaches the caller.
        const expectedLength = Array.isArray(body.batch) ? body.batch.length : 1;
        const padded = Array.from({ length: expectedLength }, () => EMPTY_RESULT);
        return envelope(padded, [{ message }]);
      }
    },
  };
}
