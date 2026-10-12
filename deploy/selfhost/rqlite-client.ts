/**
 * DDL executor for rqlite.
 *
 * Migration DDL must carry ?norwtime&norwrandom. Without them rqlite rewrites
 * non-deterministic functions in the DDL text into literals before writing to
 * sqlite_master — DEFAULT (datetime('now')) becomes a fixed Julian day and
 * randomblob(16) becomes a fixed constant, which silently disables all 12
 * leaderboard triggers. Business DML must NOT use these flags: the default
 * rewrite is what keeps ordinary writes identical across replicas.
 */

import type { DdlExecutor } from "./migrate";

export interface RqliteClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

interface RqliteResponse {
  results?: { error?: string }[];
  error?: string;
}

export function createRqliteDdlExecutor(options: RqliteClientOptions): DdlExecutor {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  return async (statements: string[]): Promise<void> => {
    if (statements.length === 0) return;
    const response = await doFetch(`${base}/db/execute?norwtime&norwrandom`, {
      method: "POST",
      headers,
      body: JSON.stringify(statements.map((sql) => [sql])),
    });
    const body = (await response.json()) as RqliteResponse;
    if (!response.ok) {
      throw new Error(body.error ?? `rqlite HTTP ${response.status}`);
    }
    const failure = body.results?.find((r) => r.error);
    if (failure?.error) throw new Error(failure.error);
  };
}
