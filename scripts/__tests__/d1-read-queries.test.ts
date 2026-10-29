import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { handleLeaderboardRpc } from "../../packages/worker-read/src/rpc/leaderboard";
import { handleUsageRpc, type UsageRpcRequest } from "../../packages/worker-read/src/rpc/usage";
import { handleDevicesRpc } from "../../packages/worker-read/src/rpc/devices";
import { withAccounting } from "../../packages/worker-read/src/rpc/accounting";
import { handleAdminRpc } from "../../packages/worker-read/src/rpc/admin";
import { handleSeasonsRpc } from "../../packages/worker-read/src/rpc/seasons";
import { handleLiveRpc } from "../../packages/worker-read/src/rpc/live";

describe("D1 read queries against real SQLite", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let queries: Array<{ sql: string; params: unknown[] }>;
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}) } as unknown as KVNamespace;
  const fromDate = "2026-09-01T00:00:00.000Z";
  const toDate = "2026-09-02T00:00:00.000Z";

  beforeEach(() => {
    vi.mocked(kv.get).mockReset();
    vi.mocked(kv.get).mockResolvedValue(null);
    sqlite = new DatabaseSync(":memory:");
    for (const name of ["001-init", "006b-seasons", "007b-season-team-members", "009-device-aliases", "013-season-datetime", "019-organizations", "022-usage-evidence", "026-usage-accounting", "029-leaderboard-revision"]) {
      sqlite.exec(readFileSync(`scripts/migrations/${name}.sql`, "utf8"));
    }
    sqlite.exec(`INSERT INTO users(id,email,name,is_public) VALUES ('u1','a@test.invalid','A',1), ('u2','b@test.invalid','B',1), ('private','c@test.invalid','C',0);
      INSERT INTO usage_records(user_id,device_id,source,model,hour_start,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens)
      VALUES ('u1','d1','codex','m1','${fromDate}',10,20,30,5,65), ('u1','d2','claude-code','m2','${fromDate}',100,0,0,0,100),
        ('u1','d1','codex','m1','${toDate}',999,0,0,0,999), ('u2','d1','codex','m1','${fromDate}',200,0,0,0,200),
        ('private','d1','codex','m1','${fromDate}',9999,0,0,0,9999), ('u1','zero','codex','m1','${fromDate}',0,0,0,0,0);
      INSERT INTO device_aliases(user_id,device_id,alias) VALUES ('u1','alias-only','Spare');
      INSERT INTO usage_evidence(user_id,device_id,event_id,group_id,source,model,hour_start,timestamp,call_type,origin,provider,granularity,time_precision,snapshot_seq,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens)
      VALUES ('u1','d1','e1','g','codex','m1','${fromDate}','${fromDate}','request','test','test','operation','exact',1,3,4,5,6,18),
        ('u1','checkpoint','e0','g','codex','m1','${fromDate}','${fromDate}','request','test','test','operation','exact',1,0,0,0,0,0);
      INSERT INTO usage_details(user_id,device_id,source,model,hour_start,event_id,evidence_snapshot_seq,details_version,source_revision,parser_revision,detail_revision,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,groups_json)
      VALUES ('u1','d1','codex','m1','${fromDate}','',NULL,1,1,1,1,10,20,30,5,65,'[]'),
        ('u1','d1','codex','m1','${fromDate}','e1',2,1,1,1,1,3,4,5,6,18,'[]');`);
    queries = [];
    const prepare = (sql: string, params: unknown[] = []) => ({
      bind: (...values: unknown[]) => prepare(sql, values),
      all: async () => {
        queries.push({ sql, params });
        return { success: true, results: sqlite.prepare(sql).all(...params as never[]) };
      },
      first: async () => { queries.push({ sql, params }); return sqlite.prepare(sql).get(...params as never[]) ?? null; },
    });
    db = { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map((s) => s.all())) } as unknown as D1Database;
  });
  afterEach(() => sqlite.close());

  it("ranks additive legacy and evidence counters without reading accounting details", async () => {
    const body = await (await handleLeaderboardRpc({ method: "leaderboard.getSnapshot" }, db, kv)).json();
    expect(body.result.rows.map((r: { user_id: string; total_tokens: number }) => [r.user_id, r.total_tokens])).toEqual([["u1", 1182], ["u2", 200]]);
    const { sql, params } = queries.find((q) => q.sql.includes("WITH totals"))!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]);
    expect(JSON.stringify(plan)).not.toMatch(/usage_details|SEARCH d /);
    const filtered = await (await handleLeaderboardRpc({ method: "leaderboard.getSnapshot", source: "codex", model: "m1", fromDate }, db, kv)).json();
    expect(filtered.result.rows.slice(1, 2)).toMatchObject([{ user_id: "u2", total_tokens: 200 }]);
  });

  it("paginates current public users after a cached-page user becomes private or is deleted", async () => {
    const insert = sqlite.prepare("INSERT INTO users(id,email,name,is_public) VALUES (?,?,?,1)");
    const usage = sqlite.prepare("INSERT INTO usage_records(user_id,device_id,source,model,hour_start,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens) VALUES (?,'d','codex','m',?, ?,0,0,0,?)");
    for (let i = 0; i < 101; i++) {
      insert.run(`page${i}`, `page${i}@test.invalid`, `Page ${i}`);
      usage.run(`page${i}`, fromDate, 10000 - i, 10000 - i);
    }
    const request = { method: "leaderboard.getSnapshot" } as const;
    const original = await (await handleLeaderboardRpc(request, db, kv)).json();
    vi.mocked(kv.get).mockResolvedValue(original.result);
    sqlite.exec("UPDATE users SET is_public=0 WHERE id='page0'");
    const first = await (await handleLeaderboardRpc(request, db, kv)).json();
    const next = await (await handleLeaderboardRpc(request, db, kv)).json();
    expect(first.result.rows.slice(0, 21)).toHaveLength(21);
    expect(first.result.rows[0].user_id).toBe("page1");
    expect(next.result.rows[20].user_id).toBe("page21");
    sqlite.exec("DELETE FROM usage_records WHERE user_id='page1'; DELETE FROM users WHERE id='page1'");
    const full = await (await handleLeaderboardRpc(request, db, kv)).json();
    expect(full.result.rows).toHaveLength(101);
    expect(full.result.rows[0].user_id).toBe("page2");
    expect(full.result.rows.some((row: { user_id: string }) => ["page0", "page1"].includes(row.user_id))).toBe(false);
    expect(queries.every(({ params }) => params.length <= 100)).toBe(true);
  });

  it("applies team and organization membership before pagination without exposing private users", async () => {
    sqlite.exec(`INSERT INTO teams(id,name,slug,invite_code,created_by,created_at) VALUES ('t1','T','t','invite','u1','${fromDate}');
      INSERT INTO team_members(id,team_id,user_id,joined_at) VALUES ('tm1','t1','u2','${fromDate}'), ('tm2','t1','private','${fromDate}');
      INSERT INTO organizations(id,name,slug,created_by) VALUES ('o1','O','o','u1');
      INSERT INTO organization_members(id,org_id,user_id) VALUES ('om1','o1','u1'), ('om2','o1','private');`);
    for (const [scope, user] of [[{ teamId: "t1" }, "u2"], [{ orgId: "o1" }, "u1"]] as const) {
      const body = await (await handleLeaderboardRpc({ method: "leaderboard.getSnapshot", ...scope }, db, kv)).json();
      expect(body.result.rows.map((r: { user_id: string }) => r.user_id)).toEqual([user]);
    }
  });

  it.each([
    { method: "usage.get", granularity: "half-hour" },
    { method: "usage.get", granularity: "day", tzOffset: -480, source: "codex", deviceId: "d1" },
    { method: "usage.getDeviceSummary" },
    { method: "usage.getDeviceCostDetails" },
    { method: "usage.getDeviceTimeline", granularity: "day", tzOffset: -480 },
  ] as const)("preserves accounting and uses user/time indexes for $method $granularity", async (options) => {
    const req: UsageRpcRequest = { ...options, userId: "u1", fromDate, toDate };
    const body = await (await handleUsageRpc(req, db)).json();
    const totals = body.result.reduce((n: number, r: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number }) =>
      n + r.input_tokens + r.cached_input_tokens + r.output_tokens + r.reasoning_output_tokens, 0);
    expect(totals).toBe("deviceId" in options ? 83 : 183);
    const annotations = body.result.flatMap((r: { accounting?: unknown[] }) => r.accounting ?? []);
    const reference = withAccounting(sqlite.prepare("SELECT json_group_array(json(accounting_json)) AS accounting_json FROM usage_totals WHERE user_id='u1' AND device_id='d1' AND hour_start >= ? AND hour_start < ?").get(fromDate, toDate) as { accounting_json: string });
    expect(annotations).toEqual(expect.arrayContaining(reference.accounting!));
    expect(annotations).toHaveLength(2);
    const { sql, params } = queries[0];
    const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]));
    expect(plan).toContain("SEARCH usage_records USING INDEX idx_usage_user_time");
    expect(plan).toContain("SEARCH usage_evidence USING INDEX idx_evidence_user_time");
  });

  it("keeps zero legacy buckets and alias-only devices, but excludes evidence checkpoints", async () => {
    const body = await (await handleDevicesRpc({ method: "devices.list", userId: "u1" }, db)).json();
    expect(body.result.map((r: { device_id: string }) => r.device_id)).toEqual(["d1", "d2", "alias-only", "zero"]);
    for (const [deviceId, expected] of [["zero", true], ["checkpoint", false], ["alias-only", false]] as const) {
      expect(await (await handleDevicesRpc({ method: "devices.hasRecords", userId: "u1", deviceId }, db)).json()).toEqual({ result: { hasRecords: expected } });
    }
    for (const [deviceId, exists] of [["zero", true], ["checkpoint", false], ["alias-only", true]] as const) {
      expect(await (await handleDevicesRpc({ method: "devices.exists", userId: "u1", deviceId }, db)).json()).toEqual({ result: { exists } });
    }
    const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[0].sql}`).all(...queries[0].params as never[]));
    expect(plan).not.toContain("usage_details");
  });

  it("reports storage stats identical to the usage_totals view it replaces", async () => {
    sqlite.exec(`INSERT INTO teams(id,name,slug,invite_code,created_by,created_at) VALUES ('t9','T9','t9','invite','u1','${fromDate}');
      INSERT INTO team_members(id,team_id,user_id,role,joined_at) VALUES ('tm1','t9','u1','owner','${fromDate}');
      INSERT INTO session_records(user_id,session_key,source,kind,started_at,last_message_at,duration_seconds,total_messages,snapshot_at)
      VALUES ('u1','s1','codex','session','${fromDate}','${toDate}',120,4,'${toDate}');`);
    const body = await (await handleAdminRpc({ method: "admin.getStorageStats" }, db)).json();
    const byUser = new Map((body.result as Array<{ user_id: string }>).map((r) => [r.user_id, r]));

    // u1: legacy 65 + 100 + 999 and evidence 18 (the zero-token checkpoint is
    // excluded), so 1182 over four buckets across d1, d2 and the zero-token
    // legacy device — the alias-only device holds no usage bucket and is not
    // counted here, unlike in devices.list. u2 and `private` carry legacy rows
    // only, and a user with neither usage nor sessions is absent.
    expect(byUser.get("u1")).toMatchObject({
      device_count: 3, total_tokens: 1182, usage_row_count: 4,
      team_count: 1, session_count: 1, total_messages: 4, total_duration_seconds: 120,
    });
    expect(byUser.get("u2")).toMatchObject({ device_count: 1, total_tokens: 200, usage_row_count: 1 });
    expect(byUser.get("private")).toMatchObject({ total_tokens: 9999 });
    expect(byUser.has("u3")).toBe(false);

    // The rewrite must not change any column, so compare it to the view it
    // replaces on the same data rather than to hand-written numbers alone.
    const sql = queries.at(-1)!.sql;
    expect(sql).not.toContain("usage_totals");
    const reference = sqlite.prepare(sql.replace("WITH bucket AS (", "WITH bucket AS (")).all() as Array<Record<string, unknown>>;
    const viewStamp = new Map<string, unknown[]>();
    for (const row of sqlite.prepare("SELECT user_id, COUNT(DISTINCT device_id) dc, SUM(total_tokens) tt, COUNT(*) n, SUM(evidence_tokens) ev FROM usage_totals GROUP BY user_id").all() as Array<Record<string, unknown>>) {
      viewStamp.set(row.user_id as string, [row.dc, row.tt, row.n]);
    }
    for (const row of reference) {
      const [dc, tt, n] = viewStamp.get(row.user_id as string) ?? [0, 0, 0];
      expect([row.device_count, row.total_tokens, row.usage_row_count]).toEqual([dc, tt, n]);
    }
  });

  it("reports live stats identical to the usage_totals references it replaces", async () => {
    const stamp = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();
    sqlite.exec(`INSERT INTO usage_records(user_id,device_id,source,model,hour_start,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens)
      VALUES ('u1','d1','codex','m1','${stamp(10 * 60_000)}',10,0,0,0,10),
             ('u2','d1','codex','m1','${stamp(20 * 60_000)}',20,0,0,0,20),
             ('u1','d1','codex','m1','${stamp(90 * 60_000)}',999,0,0,0,999);
      INSERT INTO usage_evidence(user_id,device_id,event_id,group_id,source,model,hour_start,timestamp,call_type,origin,provider,granularity,time_precision,snapshot_seq,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens)
      VALUES ('u1','d1','' || '${"9".repeat(63)}','${"8".repeat(64)}','codex','m1','${stamp(15 * 60_000)}','${stamp(15 * 60_000)}','request','test','test','operation','exact',1,5,0,0,0,5);`);
    const body = await (await handleLiveRpc({ method: "live.getStats" } as never, db)).json();
    const reference = sqlite.prepare(`SELECT
      (SELECT COALESCE(SUM(total_tokens),0) FROM usage_totals WHERE julianday(hour_start) >= julianday('now','-1 hour')) AS tokens_last_hour,
      (SELECT COUNT(*) FROM usage_totals WHERE julianday(hour_start) >= julianday('now','-1 hour')) AS requests_last_hour,
      (SELECT COUNT(DISTINCT user_id) FROM usage_totals WHERE julianday(hour_start) >= julianday('now','-1 hour')) AS unique_users_last_hour`).get();

    expect(body.result.tokens_last_hour).toBe(reference.tokens_last_hour);
    expect(body.result.requests_last_hour).toBe(reference.requests_last_hour);
    expect(body.result.unique_users_last_hour).toBe(reference.unique_users_last_hour);
    expect(body.result.tokens_last_hour).toBe(35);
    expect(body.result.requests_last_hour).toBe(3);

    const own = await (await handleLiveRpc({ method: "live.getUserStats", userId: "u1" } as never, db)).json();
    const ownRef = sqlite.prepare(`SELECT
      (SELECT COALESCE(SUM(total_tokens),0) FROM usage_totals WHERE user_id = ? AND julianday(hour_start) >= julianday('now','-1 hour')) AS tokens_last_hour,
      (SELECT COUNT(*) FROM usage_totals WHERE user_id = ? AND julianday(hour_start) >= julianday('now','-1 hour')) AS requests_last_hour`).get("u1", "u1");
    expect(own.result.tokens_last_hour).toBe(ownRef.tokens_last_hour);
    expect(own.result.requests_last_hour).toBe(ownRef.requests_last_hour);
    expect(queries.at(-1)!.sql).not.toContain("usage_totals");
  });

  it("reports season token totals identical to the usage_totals join it replaces", async () => {
    sqlite.exec(`INSERT INTO seasons(id,name,slug,start_date,end_date,created_by) VALUES ('s1','S','s','2026-01-01T00:00:00Z','2026-12-31T00:00:00Z','u1');
      INSERT INTO teams(id,name,slug,invite_code,created_by,created_at) VALUES ('st1','T1','st1','i','u1','${fromDate}');
      INSERT INTO season_teams(season_id,team_id,registered_by) VALUES ('s1','st1','u1');
      INSERT INTO season_team_members(season_id,team_id,user_id) VALUES ('s1','st1','u1'),('s1','st1','u2');`);
    const body = await (await handleSeasonsRpc({
      method: "seasons.getTeamTokens", seasonId: "s1", fromDate, toDate,
    } as never, db, kv)).json();

    const expected = sqlite.prepare(`SELECT COALESCE(SUM(ur.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(ur.input_tokens), 0) AS input_tokens
      FROM season_teams st
      LEFT JOIN season_team_members tm ON tm.team_id = st.team_id AND tm.season_id = st.season_id
      LEFT JOIN usage_totals ur ON ur.user_id = tm.user_id AND ur.hour_start >= ? AND ur.hour_start < ?
      WHERE st.season_id = ? GROUP BY st.team_id`).get(fromDate, toDate, "s1") as { total_tokens: number; input_tokens: number };

    expect(body.result).toHaveLength(1);
    expect(body.result[0].total_tokens).toBe(expected.total_tokens);
    expect(body.result[0].input_tokens).toBe(expected.input_tokens);
    // u1 contributes 65 + 100 + 18 (the zero-token evidence checkpoint is
    // filtered) and u2 another 200; the 999 bucket sits at `toDate` and is
    // outside the half-open window.
    expect(body.result[0].total_tokens).toBe(383);
    expect(queries.at(-1)!.sql).not.toContain("usage_totals");

    // The member aggregate is the same shape over the same window.
    const members = await (await handleSeasonsRpc({
      method: "seasons.getMemberTokens", seasonId: "s1", teamIds: ["st1"], fromDate, toDate,
    } as never, db, kv)).json();
    const memberExpected = sqlite.prepare(`SELECT tm.user_id, COALESCE(SUM(ur.total_tokens), 0) AS total_tokens
      FROM season_team_members tm
      LEFT JOIN usage_totals ur ON ur.user_id = tm.user_id AND ur.hour_start >= ? AND ur.hour_start < ?
      WHERE tm.season_id = ? GROUP BY tm.team_id, tm.user_id`).all(fromDate, toDate, "s1") as Array<{ user_id: string; total_tokens: number }>;
    expect(members.result.map((r: { user_id: string; total_tokens: number }) => [r.user_id, r.total_tokens]).sort())
      .toEqual(memberExpected.map((r) => [r.user_id, r.total_tokens]).sort());
  });
});
