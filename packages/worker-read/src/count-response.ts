const COUNT_FIELDS = new Set([
  "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens",
  "input_total_tokens", "output_total_tokens", "cache_read_input_tokens", "cache_write_input_tokens",
  "cache_write_5m_input_tokens", "cache_write_1h_input_tokens", "context_tokens_min", "context_tokens_max",
  "raw_total_tokens", "evidence_tokens", "approximate_tokens", "tokens_7d", "tokens_30d", "tokens_last_hour",
  "duration_seconds", "total_duration_seconds", "user_messages", "assistant_messages", "total_messages",
  "request_count", "call_count", "count", "cnt", "total_sessions", "session_count", "active_sessions",
  "total_users", "active_users_24h", "requests_last_hour", "unique_users_last_hour", "team_count",
  "device_count", "model_count", "usage_row_count", "evidence_snapshot_seq", "snapshot_seq",
  "source_revision", "parser_revision", "detail_revision",
].flatMap((name) => [name, name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())]));

class UnsafeCountError extends Error {}

// Runs on every RPC response body, and on an annotated usage window that body
// can be hundreds of MB, so the walk is allocation-free: `Object.entries`
// built an array of pairs per object and measured 2-8x slower than `for...in`
// over the same 255 MB payload.
function safeCounts(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!safeCounts(value[i])) return false;
    return true;
  }
  if (value === null || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const count = record[key];
    if (COUNT_FIELDS.has(key)) {
      if (!(count === null || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0))) return false;
    } else if (!safeCounts(count)) return false;
  }
  return true;
}

function requireSafeCounts(value: unknown): void {
  if (!safeCounts(value)) throw new UnsafeCountError("Count exceeds supported integer range");
}

const statementGuard: ProxyHandler<D1PreparedStatement> = {
  get(target, property) {
    if (property === "bind") return (...values: unknown[]) => new Proxy(target.bind(...values), statementGuard);
    if (property === "first") return async (column?: string) => {
      const result = column === undefined ? await target.first() : await target.first(column);
      requireSafeCounts(column === undefined ? result : { [column]: result });
      return result;
    };
    if (property === "all") return async () => {
      const result = await target.all();
      requireSafeCounts(result);
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
};

// Validate before Response.json can turn non-finite historical SQL counts into null.
export function checkedCountDatabase(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => new Proxy(target.prepare(sql), statementGuard);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function checkedCountResponse(result: Promise<Response>): Promise<Response> {
  try {
    const response = await result;
    if (!response.ok) return response;
    const body = await response.text();
    requireSafeCounts(JSON.parse(body));
    return new Response(body, response);
  } catch (error) {
    return Response.json({ error: error instanceof UnsafeCountError ? error.message : "Internal server error" }, { status: 500 });
  }
}
