/**
 * Shared resolution of the optional rqlite Basic-auth credentials
 * (spec Plan 3 §3.1.2). Used by server-read / server-scheduler (read-only
 * pair with fallback) and server-ingest (full pair).
 *
 * Empty string counts as unset: compose injects `${VAR:-}` defaults as EMPTY
 * STRINGS, so a `.env` that leaves a variable blank must behave exactly like
 * one that omits it. `||`-style truthiness, not `??`.
 */

export interface BasicAuth {
  username: string;
  password: string;
}

/** Full credentials: both must be non-empty, else undefined (no auth). */
export function resolveBasicAuth(
  username: string | undefined,
  password: string | undefined
): BasicAuth | undefined {
  return username && password ? { username, password } : undefined;
}

/** resolveBasicAuth over the RQLITE_USERNAME / RQLITE_PASSWORD env pair. */
export function resolveEnvBasicAuth(): BasicAuth | undefined {
  return resolveBasicAuth(process.env.RQLITE_USERNAME, process.env.RQLITE_PASSWORD);
}

/**
 * Read-only credentials: prefer the READ_* pair, falling back to the FULL
 * pair as a unit. There is deliberately no pew-ro user (rqlite 10.5.3 has no
 * "select" permission name, and read/scheduler carry /db/request write paths,
 * so a read-only user is unreachable here) — the READ_* vars are a deprecated
 * compatibility surface and in practice this always resolves to the full
 * user. One READ_* var alone never mixes users — the pair falls back together.
 */
export function resolveReadBasicAuth(
  readUsername: string | undefined,
  readPassword: string | undefined,
  username: string | undefined,
  password: string | undefined
): BasicAuth | undefined {
  if (readUsername && readPassword) return { username: readUsername, password: readPassword };
  return resolveBasicAuth(username, password);
}
