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

/**
 * Read-only credentials: prefer the READ_* pair, falling back to the FULL
 * pair as a unit (pew-ro defaults to RQLITE_PASSWORD in the render script,
 * so the full user is always a valid read-only principal there). One READ_*
 * var alone never mixes users — the pair falls back together.
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
