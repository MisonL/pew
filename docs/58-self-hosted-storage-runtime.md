# pew 私有化部署 — Plan 1：存储与运行时基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：已交付（任务全部实现并验证）。**Goal:** 让 pew 脱离 Cloudflare 运行——用 rqlite 承载数据、用 Node 进程承载两个 Worker，Web 仍走原有逻辑，用一套 compose 在本机/内网跑起完整可用的 pew。

**Architecture:** 不重写任何业务逻辑。新增 `deploy/selfhost/` 目录，内含三个适配层（D1 形状、KV 形状、node:http 宿主）与一个 d1-http 服务；`packages/worker` 与 `packages/worker-read` 的 `fetch` 处理器原样运行。Web 侧只改两处上游文件：`lib/d1.ts`（让写路径指向自建 d1-http）与 `vitest.config.ts`（让 vitest 收集 `deploy/**` 下的测试）。Web 容器用**仓库根 `Dockerfile`** 构建（Next standalone），适配层服务用新增的 `deploy/selfhost/Dockerfile` 构建——两套镜像，见 Task 10。

**Tech Stack:** Bun（运行适配层 TS 源码；适配层镜像自建，见 Task 10）、Node 22（`node:http`、Web 标准 Request/Response；web 容器为 Next standalone）、rqlite v10.5.3+、Docker Compose、Vitest 5（`bun run test`）

**Spec:** `docs/57-self-hosted-deployment-design.md`

## Global Constraints

- **rqlite 版本 ≥ v10.3.3**。v10.3.3 才修复「事务请求中某条语句 **prepare** 失败时不回滚」（CHANGELOG PR #2792，2026-09-13）。实测 10.3.2 下两条 INSERT 夹一条缺表语句，前两条仍提交；10.3.3 正确回滚为 0 行。compose 固定 `rqlite/rqlite:10.5.3`（≥ 下限）。
- **参数编码必须是扁平数组** `[sql, p1, p2]`，不是嵌套 `[sql, [p1,p2]]`。嵌套形式在 `/db/query` 下静默返回空结果。
- **batch 必须走 `/db/request?transaction=true&associative&timings`**，不能用 `/db/execute`（普通 SELECT 的行会静默丢失）。
- **读一律显式 `?level=weak`**（rqlite 会把 weak 读转发给 leader，等价强一致）。**禁止用 `none`**。
- **DDL 一律带 `?norwtime&norwrandom`**；**业务 DML 与迁移里的 DML 一律不带**（走默认改写，保证跨副本确定）。关键：**迁移文件里的 DDL 与 DML 绝不能放进同一个 `?norw*` 请求**——否则 DML 的各副本独立求值会分叉（实测 029 种子 `INSERT ... randomblob(16)` 在两副本得到不同值）。Task 5 的 `applyMigrations` 用 `isDdlStatement` 按语句分流。
- **rqlite 必须带 `-fk`**（外键默认关闭，schema 有 12 处 `ON DELETE CASCADE`）。
- **不改上游文件**：`packages/worker/**`、`packages/worker-read/**`、`lib/invite.ts`、`lib/r2.ts`、`next.config.ts`、`Dockerfile`、`bun.lock`、根 `package.json`、`biome.json`、`cli.ts`、`lib/rate-limit.ts`。本计划只改两个上游文件：`lib/d1.ts` 与 `vitest.config.ts`。
- **适配层镜像必须自建**：compose 里跑 `deploy/selfhost/*.ts` 的服务**不能**复用仓库根 `Dockerfile` 的 runner 阶段——该阶段 `FROM node:22-slim`，只 COPY `.next/standalone`/`.next/static`/`public`，**既无 bun 也无 `deploy/`、`packages/*/src`、`scripts/migrations`**（实测 `awk '/AS runner/,0' Dockerfile | grep -c bun` = 0）。Task 10 新增 `deploy/selfhost/Dockerfile`，以 bun 为基镜像显式 COPY 源码并构建 `@pew/core` 的 `dist`（`@pew/core` 的 `main` 指向 `./dist/index.js`，容器内必须 build）。
- **`deploy/selfhost/` 不注册为 workspace package**（避免改 `bun.lock` 与 `Dockerfile`），用 bun 直接运行 TS 源码。
- **测试命令**：`bun run test`（vitest run）；单文件一律用 `./node_modules/.bin/vitest run <path>`——**不要用 `bunx vitest`**，`bunx` 在本地可执行缺失时会走网络解析，本机实测曾因此落到临时缓存、加载不到 workspace 依赖。测试文件与源码同目录、命名 `*.test.ts`（vitest include 为 `packages/*/src/**/*.test.{ts,tsx}`、`scripts/**/*.test.{ts,tsx}` 与 `deploy/**/*.test.ts`）。
- **提交信息**用 `feat:` / `fix:` / `test:` 前缀；每个 commit 结尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## Review Focus

这些是 spec 隐含、但没有哪条任务的测试天然覆盖的输入类别。每条都在下面某个任务里有对应测试：

1. **rqlite 在 HTTP 200 里返回 SQL 错误**（`results[i].error`）——若只看 HTTP 状态码，坏 SQL 会被当成成功，数据静默丢失。→ Task 2 的测试。
2. **`rows_affected` 在影响 0 行时被省略**——若 `?? 0` 兜底缺失，`changes === 0` 判断会把每个邀请码当成已用。→ Task 2 的测试。
3. **batch 里混有未 `bind` 的语句对象**——若适配层只从 `params` 取 SQL，会拿到 `undefined`。→ Task 2 的测试。
4. **KV 的 `get(key, "text")` 与 `expirationTtl`**——若只实现 `get(key,"json")`，排行榜缓存永久失效；忽略 TTL 则缓存永不刷新。→ Task 3 的测试。
5. **迁移里的 `CREATE TRIGGER ... BEGIN ... END` 含分号**——若按 `;` 朴素切分，触发器会被切碎、迁移失败。→ Task 5 的测试。
6. **同一迁移重复执行**（`ALTER TABLE ADD COLUMN` 不幂等）——若无账本，第二次部署直接报 `duplicate column`。→ Task 5 的测试。
7. **`kv_cache` 表根本没有迁移创建**（实测确认）——单元测试用内存假库，永远测不出缺表；只有对真实 rqlite 跑一遍才会暴露，届时 worker-read 的每次缓存读写都是 500。→ Task 6 的迁移文件 + Task 8 的 `kv_cache` 存在性断言。
8. **触发器里的 `randomblob` 在多节点各自求值**——三副本会得到三种 revision，打穿排行榜的授权屏障（`api/leaderboard/route.ts:185`）。→ Task 7 的迁移（改确定性计数器）+ Task 8 的格式与递增断言。

---

### Task 1: `lib/d1.ts` 可配置 base URL

**Files:**
- Modify: `packages/web/src/lib/d1.ts:79-80`
- Test: `packages/web/src/__tests__/d1.test.ts`（已存在，追加用例）

**Interfaces:**
- Consumes: 无
- Produces: `D1Client` 在 `D1_BASE_URL` 存在时用它作为 base URL（生产环境亦生效）；`localD1BaseUrl` 行为不变。

**背景**：`d1.ts:79-80` 只有两条路——`PEW_LOCAL_D1_URL`（生产下守卫直接 throw）或拼死 `api.cloudflare.com`。这是「Web 零改动」不成立的根本原因。

- [ ] **Step 1: 写失败测试**

追加到 `packages/web/src/__tests__/d1.test.ts` 末尾：

```typescript
describe("D1_BASE_URL override", () => {
  const original = process.env.D1_BASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.D1_BASE_URL;
    else process.env.D1_BASE_URL = original;
  });

  it("uses D1_BASE_URL when set, even in production", async () => {
    process.env.D1_BASE_URL = "http://d1-http:8788";
    mockFetch.mockResolvedValueOnce(mockD1Response([{ ok: 1 }]));
    const client = new D1Client(TEST_CONFIG);
    await client.query("SELECT 1");
    expect(mockFetch.mock.calls[0][0]).toBe("http://d1-http:8788/query");
  });

  it("strips trailing slash from D1_BASE_URL", async () => {
    process.env.D1_BASE_URL = "http://d1-http:8788/";
    mockFetch.mockResolvedValueOnce(mockD1Response([{ ok: 1 }]));
    const client = new D1Client(TEST_CONFIG);
    await client.query("SELECT 1");
    expect(mockFetch.mock.calls[0][0]).toBe("http://d1-http:8788/query");
  });

  it("falls back to Cloudflare when D1_BASE_URL is unset", async () => {
    delete process.env.D1_BASE_URL;
    mockFetch.mockResolvedValueOnce(mockD1Response([{ ok: 1 }]));
    const client = new D1Client(TEST_CONFIG);
    await client.query("SELECT 1");
    expect(String(mockFetch.mock.calls[0][0])).toContain("api.cloudflare.com");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/d1.test.ts -t "D1_BASE_URL"`
Expected: FAIL —— 前两条断言失败（实际请求发往 `api.cloudflare.com`）

- [ ] **Step 3: 实现**

在 `packages/web/src/lib/d1.ts` 的 `localD1BaseUrl` 函数之后、`D1Meta` 接口之前，新增：

```typescript
/**
 * Production-usable D1 endpoint override for self-hosted deployments.
 *
 * Distinct from `localD1BaseUrl`, which is locked to an isolated loopback
 * test environment and throws in production. This override is deliberately
 * available in every environment so a self-hosted d1-http service can stand
 * in for the Cloudflare REST API.
 */
export function configuredD1BaseUrl(
  env: Record<string, string | undefined>
): string | undefined {
  const raw = env.D1_BASE_URL;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}
```

把构造函数里的 `this.baseUrl` 赋值改为：

```typescript
    this.baseUrl = configuredD1BaseUrl(process.env) ??
      localD1BaseUrl(config, process.env) ??
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/d1.test.ts`
Expected: PASS（全部，含既有用例）

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/d1.ts packages/web/src/__tests__/d1.test.ts
git commit -m "feat: add D1_BASE_URL override for self-hosted deployments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: D1 形状适配层（`deploy/selfhost/d1-adapter`）

**Files:**
- Modify: `vitest.config.ts`（`test.include` 增加 `deploy/**/*.test.ts`）
- Create: `deploy/selfhost/d1-adapter.ts`
- Test: `deploy/selfhost/d1-adapter.test.ts`

**Interfaces:**
- Consumes: 无（只依赖 `fetch`）
- Produces:
  - `createD1Adapter(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): D1Like`
  - `D1Like.prepare(sql: string): D1StatementLike` —— 同时具备 `bind` / `all` / `first` / `run`
  - `D1Like.batch(stmts: D1StatementLike[]): Promise<D1Result[]>`
  - `D1StatementLike` 暴露**公开可读属性** `sql` 与 `params`（不能用 `#private`，见下）
  - `D1Result = { success: true; results: unknown[]; meta: { changes: number; duration: number; last_row_id?: number } }`

**关键约束**（全部来自实测，违反即静默出错）：
1. 参数必须扁平：`[sql, p1, p2]`。
2. batch 与单语句写一律走 `/db/request?transaction=true&associative&timings`，单语句读走 `/db/query?level=weak&associative&timings`。`/db/execute` 只用于迁移 DDL 批（带 `?norwtime&norwrandom`），业务代码不用它——它对纯写虽可用，但会丢弃带 RETURNING 语句的行。
3. rqlite 出错时 HTTP 仍是 200，必须逐条检查 `results[i].error` 并抛错。
4. `rows_affected` 为 0 时字段被省略，必须 `?? 0`。
5. `batch([])` 必须短路返回 `[]`（rqlite 对空数组返回 HTTP 400）。
6. 语句对象必须把 `sql`/`params` 暴露为公开属性——`count-response.ts:28-44` 的 Proxy 用 `Reflect.get` 只透传公开属性。

- [ ] **Step 1: 让 vitest 收集 deploy 下的测试**

`vitest.config.ts` 当前的 `test.include` 是：

```typescript
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
    ],
```

`deploy/**` 不在其中，本计划新增的测试**一条都不会执行**。改为：

```typescript
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
      "deploy/**/*.test.ts",
    ],
```

（`vitest.config.ts` 不在 spec §4.7 的「刻意不改」清单里，改动可接受；已同步登记到 spec。）

- [ ] **Step 2: 写失败测试**

创建 `deploy/selfhost/d1-adapter.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { createD1Adapter } from "./d1-adapter";

const BASE = "http://rqlite:4001";
const TOKEN = "test-token";

function rqliteResponse(results: unknown[], status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve({ results }),
  } as unknown as Response;
}

function makeAdapter(fetchImpl: typeof fetch) {
  return createD1Adapter({ baseUrl: BASE, token: TOKEN, fetchImpl });
}

describe("d1-adapter reads", () => {
  it("sends flat params and associative + weak level", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ types: { a: "integer" }, rows: [{ a: 1 }] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("SELECT a FROM t WHERE b = ?").bind(7).all();
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/db/query?level=weak&associative&timings`);
    expect(JSON.parse(init.body)).toEqual([["SELECT a FROM t WHERE b = ?", 7]]);
    expect(res.results).toEqual([{ a: 1 }]);
    expect(res.success).toBe(true);
  });

  it("first() returns the first row or null", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rqliteResponse([{ rows: [{ a: 1 }, { a: 2 }] }]))
      .mockResolvedValueOnce(rqliteResponse([{ rows: [] }]));
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.prepare("SELECT a FROM t").first()).toEqual({ a: 1 });
    expect(await db.prepare("SELECT a FROM t").first()).toBeNull();
  });

  it("first(column) extracts that column", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows: [{ a: 1, b: 2 }] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.prepare("SELECT a, b FROM t").first("b")).toBe(2);
  });

  it("supports prepare().run() without bind (4 production call sites do this)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 5, rows_affected: 1 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("UPDATE t SET a = 1").run();
    expect(res.meta.changes).toBe(1);
    expect(res.meta.last_row_id).toBe(5);
  });

  it("routes run() through /db/request like batch()", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 5, rows_affected: 1 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.prepare("UPDATE t SET a = 1").run();
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toBe(`${BASE}/db/request?transaction=true&associative&timings`);
  });
});

describe("d1-adapter error and edge handling", () => {
  it("throws when rqlite reports an error inside HTTP 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ error: "no such table: nope" }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await expect(db.prepare("SELECT * FROM nope").all()).rejects.toThrow(
      /no such table/
    );
  });

  it("defaults changes to 0 when rows_affected is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 3 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("UPDATE t SET a = 1 WHERE 0").run();
    expect(res.meta.changes).toBe(0);
  });

  it("returns [] for an empty batch without calling rqlite", async () => {
    const fetchImpl = vi.fn();
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.batch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("d1-adapter batch", () => {
  it("uses /db/request with transaction=true and associative", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows: [{ k: "a" }] },
        { last_insert_id: 1, rows_affected: 1 },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.batch([db.prepare("SELECT 1"), db.prepare("INSERT INTO t VALUES (1)")]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/db/request?transaction=true&associative&timings`);
    expect(JSON.parse(init.body)).toEqual([
      ["SELECT 1"],
      ["INSERT INTO t VALUES (1)"],
    ]);
  });

  it("preserves rows from a plain SELECT mixed into a write batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows: [{ k: "a" }, { k: "b" }] },
        { last_insert_id: 1, rows_affected: 1 },
        { rows: [{ c: 3 }] },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const out = await db.batch([
      db.prepare("SELECT 1"),
      db.prepare("INSERT INTO t VALUES (1)"),
      db.prepare("SELECT 3"),
    ]);
    expect(out[0].results).toEqual([{ k: "a" }, { k: "b" }]);
    expect(out[2].results).toEqual([{ c: 3 }]);
    expect(out.every((r) => r.success)).toBe(true);
  });

  it("reads SQL and params from statement objects that were never bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows: [] }, { rows: [] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual([["SELECT 1"], ["SELECT 2"]]);
  });

  it("exposes sql and params as public properties for Proxy-based consumers", () => {
    const db = makeAdapter(vi.fn() as unknown as typeof fetch);
    const stmt = db.prepare("SELECT 1").bind(9);
    expect(Reflect.get(stmt, "sql")).toBe("SELECT 1");
    expect(Reflect.get(stmt, "params")).toEqual([9]);
  });

  it("pads the results array when rqlite truncates it on error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows_affected: 1 },
        { error: "UNIQUE constraint failed" },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await expect(
      db.batch([
        db.prepare("INSERT INTO t VALUES (1)"),
        db.prepare("INSERT INTO t VALUES (1)"),
        db.prepare("INSERT INTO t VALUES (2)"),
      ])
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/d1-adapter.test.ts`
Expected: FAIL —— `Failed to resolve import "./d1-adapter"`

- [ ] **Step 3: 实现**

创建 `deploy/selfhost/d1-adapter.ts`：

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/d1-adapter.test.ts`
Expected: PASS（全部 13 条）

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/d1-adapter.ts deploy/selfhost/d1-adapter.test.ts
git commit -m "feat: add D1-shape adapter over rqlite HTTP API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: KV 形状适配层（`deploy/selfhost/kv-adapter`）

**Files:**
- Create: `deploy/selfhost/kv-adapter.ts`
- Test: `deploy/selfhost/kv-adapter.test.ts`

**Interfaces:**
- Consumes: `D1Like`（Task 2）
- Produces: `createKvAdapter(options: { db: D1Like; now?: () => number }): KVLike`，其中
  - `get(key: string, type?: "text" | "json"): Promise<unknown>`
  - `put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>`
  - `delete(key: string): Promise<void>`
  - `list(options: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>`
- `kv_cache` 表的建表语句由 Task 6 的迁移文件负责；本任务假定表已存在。

**为什么接口必须完整**：实测真实调用点 13 处。`leaderboard-snapshot.ts:127` 用 `get(key, "text")`——不支持则返回对象、`JSON.parse` 抛错被吞、排行榜缓存永久失效。三处 `put` 传 `expirationTtl`——忽略则 seasons 列表缓存永不刷新。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/kv-adapter.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { createKvAdapter } from "./kv-adapter";
import type { D1Like, D1Result, D1StatementLike } from "./d1-adapter";

interface Row {
  key: string;
  value: string;
  expires_at: string | null;
}

/**
 * In-memory D1Like double that interprets the four SQL shapes kv-adapter
 * issues. It deliberately evaluates expiry itself so the TTL tests exercise
 * the adapter's contract rather than the fake's leniency.
 */
function makeFakeDb() {
  const rows = new Map<string, Row>();

  const live = (row: Row, stamp: string) =>
    row.expires_at === null || row.expires_at > stamp;

  const db: D1Like = {
    prepare(sql: string): D1StatementLike {
      let params: unknown[] = [];
      const stmt: D1StatementLike = {
        sql,
        get params() {
          return params;
        },
        bind: (...next: unknown[]) => {
          params = next;
          return stmt;
        },
        all: async <T,>(): Promise<D1Result<T>> => {
          if (sql.includes("SELECT key FROM kv_cache")) {
            // Bind order is (pattern, after, stamp, limit).
            const [pattern, after, stamp, limit] = params as [string, string, string, number];
            const prefix = pattern.replace(/%$/, "").replace(/\\(.)/g, "$1");
            const matched = [...rows.values()]
              .filter((r) => r.key.startsWith(prefix) && r.key > after && live(r, stamp))
              .sort((a, b) => a.key.localeCompare(b.key))
              .slice(0, limit)
              .map((r) => ({ key: r.key }) as unknown as T);
            return { success: true, results: matched, meta: { changes: 0, duration: 0 } };
          }
          return { success: true, results: [], meta: { changes: 0, duration: 0 } };
        },
        first: async <T,>(): Promise<T | null> => {
          const [key, stamp] = params as [string, string];
          const row = rows.get(key);
          if (!row || !live(row, stamp)) return null;
          return { value: row.value } as unknown as T;
        },
        run: async (): Promise<D1Result> => {
          if (sql.startsWith("INSERT INTO kv_cache")) {
            const [key, value, expiresAt] = params as [string, string, string | null];
            rows.set(key, { key, value, expires_at: expiresAt });
            return { success: true, results: [], meta: { changes: 1, duration: 0 } };
          }
          if (sql.startsWith("DELETE FROM kv_cache")) {
            const existed = rows.delete(params[0] as string);
            return { success: true, results: [], meta: { changes: existed ? 1 : 0, duration: 0 } };
          }
          return { success: true, results: [], meta: { changes: 0, duration: 0 } };
        },
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { db, rows };
}

const NOW = 1_700_000_000_000;

describe("kv-adapter", () => {
  it("round-trips a JSON value with get(key, 'json')", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", JSON.stringify({ a: 1 }));
    expect(await kv.get("k", "json")).toEqual({ a: 1 });
  });

  it("returns raw text for get(key, 'text')", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", JSON.stringify({ a: 1 }));
    expect(await kv.get("k", "text")).toBe('{"a":1}');
  });

  it("returns null for a missing key", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    expect(await kv.get("missing", "json")).toBeNull();
  });

  it("honours expirationTtl by filtering expired rows on read", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("k", '"v"', { expirationTtl: 60 });
    expect(await kv.get("k", "json")).toBe("v");
    clock += 61_000;
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("treats a row without expires_at as non-expiring", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("k", '"v"');
    clock += 10_000_000;
    expect(await kv.get("k", "json")).toBe("v");
  });

  it("delete removes the key", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", '"v"');
    await kv.delete("k");
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("list returns list_complete true when all keys fit", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("p:a", "1");
    await kv.put("p:b", "2");
    await kv.put("q:c", "3");
    const page = await kv.list({ prefix: "p:", limit: 1000 });
    expect(page.keys.map((k) => k.name).sort()).toEqual(["p:a", "p:b"]);
    expect(page.list_complete).toBe(true);
  });

  it("list paginates with a cursor and never repeats a page", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    for (const k of ["p:a", "p:b", "p:c"]) await kv.put(k, "1");

    const first = await kv.list({ prefix: "p:", limit: 2 });
    expect(first.keys).toHaveLength(2);
    expect(first.list_complete).toBe(false);
    expect(first.cursor).toBeTruthy();

    const second = await kv.list({ prefix: "p:", limit: 2, cursor: first.cursor });
    expect(second.list_complete).toBe(true);
    const names = [...first.keys, ...second.keys].map((k) => k.name);
    expect(new Set(names).size).toBe(3);
  });

  it("list survives delete-while-listing (the clearAllCache loop)", async () => {
    // cache.ts:152-186 deletes each page before asking for the next one. With
    // an OFFSET cursor that loses one page per page (verified: 10 keys, page
    // size 3, 4 keys silently left behind). Keyset cursors must delete all 10.
    const { db, rows } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    for (let i = 0; i < 10; i++) await kv.put(`p:${String(i).padStart(2, "0")}`, "1");

    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await kv.list({ prefix: "p:", limit: 3, cursor });
      for (const k of page.keys) await kv.delete(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
      guard += 1;
      if (guard > 10) throw new Error("cursor did not advance");
    } while (cursor);
    expect(rows.size).toBe(0);
  });

  it("list skips expired entries", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("p:a", "1");
    await kv.put("p:b", "2", { expirationTtl: 30 });
    clock += 31_000;
    const page = await kv.list({ prefix: "p:" });
    expect(page.keys.map((k) => k.name)).toEqual(["p:a"]);
  });

  it("get(key, 'json') returns null for malformed JSON instead of throwing", async () => {
    // Cloudflare KV yields null on bad JSON (memory-kv.ts models this); a throw
    // here would diverge from the contract the workers are written against.
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", "not json{");
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("list with limit 0 terminates instead of looping forever", async () => {
    // limit 0 previously produced list_complete=false with no cursor, which
    // would spin a caller like clearAllCache forever. Clamped to a page of 1.
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("p:a", "1");
    const page = await kv.list({ prefix: "p:", limit: 0 });
    expect(page.keys.length).toBeLessThanOrEqual(1);
    if (!page.list_complete) expect(page.cursor).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/kv-adapter.test.ts`
Expected: FAIL —— `Failed to resolve import "./kv-adapter"`

- [ ] **Step 3: 实现**

创建 `deploy/selfhost/kv-adapter.ts`：

```typescript
/**
 * Cloudflare KV namespace shape over the rqlite-backed D1 adapter.
 *
 * Only the operations worker-read actually performs are implemented:
 *   get(key, "json" | "text")   cache.ts, sync/kv-store.ts, leaderboard-snapshot.ts
 *   put(key, value, {expirationTtl})   three call sites rely on the TTL
 *   delete(key)                 cache.ts:164,195
 *   list({prefix, limit, cursor})  cache.ts pagination loops
 *
 * getWithMetadata, arrayBuffer and stream are unused by worker-read.
 */

import type { D1Like } from "./d1-adapter";

export interface KVListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

export interface KVLike {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult>;
}

export interface KvAdapterOptions {
  db: D1Like;
  now?: () => number;
}

const SELECT_SQL =
  "SELECT value, expires_at FROM kv_cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)";
const UPSERT_SQL =
  "INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";
const DELETE_SQL = "DELETE FROM kv_cache WHERE key = ?";

export function createKvAdapter(options: KvAdapterOptions): KVLike {
  const { db } = options;
  const now = options.now ?? (() => Date.now());

  /** Cursors carry the last key of the previous page (keyset, not offset). */
  function parseCursor(cursor: string | undefined): string {
    if (!cursor) return "";
    return cursor;
  }

  return {
    async get(key: string, type: "text" | "json" = "text"): Promise<unknown> {
      const stamp = new Date(now()).toISOString();
      const row = await db.prepare(SELECT_SQL).bind(key, stamp).first<{ value: string }>();
      if (!row) return null;
      if (type === "json") {
        // Mirror Cloudflare KV: malformed JSON yields null, not a throw. The
        // callers already guard (cache.ts:62 wraps in try/catch; kv-store.ts:46
        // maps to null), but the adapter should match the contract directly.
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      const ttl = putOptions?.expirationTtl;
      const expiresAt =
        typeof ttl === "number" && ttl > 0
          ? new Date(now() + ttl * 1000).toISOString()
          : null;
      await db.prepare(UPSERT_SQL).bind(key, value, expiresAt).run();
    },

    async delete(key: string): Promise<void> {
      await db.prepare(DELETE_SQL).bind(key).run();
    },

    async list(listOptions?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
    }): Promise<KVListResult> {
      const prefix = listOptions?.prefix ?? "";
      // Clamp to a positive page size: with limit = 0 the old code computed
      // hasMore = (any rows exist) and returned no cursor, which would make
      // callers like clearAllCache loop forever on an empty page.
      const limit = Math.max(1, listOptions?.limit ?? 1000);
      const after = parseCursor(listOptions?.cursor);
      const stamp = new Date(now()).toISOString();

      // Keyset pagination: the cursor is the last key of the previous page.
      // An OFFSET cursor silently skips keys when the caller deletes as it
      // lists (cache.ts:152-186 clearAllCache does exactly that) — every page
      // of deletions shifts the remaining rows left and the loop loses one
      // page per page (verified: 10 keys, page 3, deleted 6 of 10).
      const { results } = await db
        .prepare(
          "SELECT key FROM kv_cache WHERE key LIKE ? ESCAPE '\\' AND key > ? " +
            "AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?"
        )
        .bind(`${prefix.replace(/[%_\\]/g, "\\$&")}%`, after, stamp, limit + 1)
        .all<{ key: string }>();

      const hasMore = results.length > limit;
      const page = hasMore ? results.slice(0, limit) : results;
      const last = page[page.length - 1];
      return {
        keys: page.map((r) => ({ name: r.key })),
        list_complete: !hasMore,
        ...(hasMore && last ? { cursor: last.key } : {}),
      };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/kv-adapter.test.ts`
Expected: PASS（全部 12 条）

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/kv-adapter.ts deploy/selfhost/kv-adapter.test.ts
git commit -m "feat: add KV-shape adapter with TTL and cursor pagination

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Worker 运行时宿主（`deploy/selfhost/node-runtime`）

**Files:**
- Create: `deploy/selfhost/node-runtime.ts`
- Test: `deploy/selfhost/node-runtime.test.ts`

**Interfaces:**
- Consumes: `D1Like`、`KVLike`
- Produces:
  - `createWorkerServer(options: { worker: { fetch(request: Request, env: any): Promise<Response> }; env: Record<string, unknown>; port: number; hostname?: string }): { listen(): Promise<{ port: number; close(): Promise<void> }> }`
  - `runScheduled(worker: { scheduled?: (event: unknown, env: any) => Promise<void> }, env: Record<string, unknown>, intervalMs: number): () => void` —— 返回停止函数

**背景**：两个 Worker 的 `fetch` 是标准 `Request → Response`（`worker-read/src/index.ts:204`、`worker/src/index.ts:325`），Node 22 原生支持 Web 标准，套一层 `node:http` 即可。worker-read 有 `scheduled`（`index.ts:255`），worker 没有。

**D1 API 子集核对（实测 grep）**：`packages/worker/**` 与 `packages/worker-read/**` 对 D1 的调用**只用到** `prepare()`、`bind()`、`first()`、`all()`、`run()`、`batch()` 六种方法（`env.DB.prepare` 5 处、`env.DB.batch` 4 处，另有 `prepare().first()/.run()` 的链式调用）；没有出现 `D1Database` 独有、适配层未实现的 `.exec()`/`.raw()`/`.dump()`/`.withSession()`（grep 仅命中 `models-dev.ts` 里对字符串的 `RegExp.exec`，无关）。因此 Task 2 的 `D1Like` 已覆盖运行时实际用到的全部方法。Task 10 的端到端验证（起真实 read/ingest + 打 `/api/live` 与一次只读 RPC）即覆盖这条核对。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/node-runtime.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { createWorkerServer, runScheduled } from "./node-runtime";

describe("createWorkerServer", () => {
  it("bridges node:http requests into the worker fetch handler", async () => {
    const seen: string[] = [];
    const worker = {
      async fetch(request: Request): Promise<Response> {
        seen.push(new URL(request.url).pathname);
        return Response.json({ ok: true, method: request.method });
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, method: "GET" });
      expect(seen).toEqual(["/api/live"]);
    } finally {
      await handle.close();
    }
  });

  it("forwards the request body for POST", async () => {
    const worker = {
      async fetch(request: Request): Promise<Response> {
        const body = await request.json();
        return Response.json({ received: body });
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "ping" }),
      });
      expect(await res.json()).toEqual({ received: { method: "ping" } });
    } finally {
      await handle.close();
    }
  });

  it("passes env through to the worker", async () => {
    const worker = {
      async fetch(_request: Request, env: { SECRET: string }): Promise<Response> {
        return Response.json({ secret: env.SECRET });
      },
    };
    const server = createWorkerServer({ worker, env: { SECRET: "s3cr3t" }, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`);
      expect(await res.json()).toEqual({ secret: "s3cr3t" });
    } finally {
      await handle.close();
    }
  });

  it("answers 500 instead of crashing when the worker throws", async () => {
    const worker = {
      async fetch(): Promise<Response> {
        throw new Error("boom");
      },
    };
    const server = createWorkerServer({ worker, env: {}, port: 0 });
    const handle = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/live`);
      expect(res.status).toBe(500);
    } finally {
      await handle.close();
    }
  });
});

describe("runScheduled", () => {
  it("invokes scheduled on the interval and stops on demand", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockResolvedValue(undefined);
      const stop = runScheduled({ scheduled }, { A: 1 }, 1000);
      await vi.advanceTimersByTimeAsync(3500);
      expect(scheduled).toHaveBeenCalledTimes(3);
      expect(scheduled.mock.calls[0][1]).toEqual({ A: 1 });
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(scheduled).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ticking after a scheduled run rejects", async () => {
    vi.useFakeTimers();
    try {
      const scheduled = vi.fn().mockRejectedValue(new Error("upstream down"));
      const stop = runScheduled({ scheduled }, {}, 1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(scheduled).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when the worker has no scheduled handler", () => {
    const stop = runScheduled({}, {}, 1000);
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("registerShutdownSignals", () => {
  it("closes the server on SIGTERM and SIGINT", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation((signal: string | symbol, handler: (...args: unknown[]) => void) => {
        handlers[String(signal)] = handler as () => void;
        return process;
      });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      registerShutdownSignals(close);
      expect(typeof handlers.SIGTERM).toBe("function");
      expect(typeof handlers.SIGINT).toBe("function");
      handlers.SIGTERM!();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("createWorkerServer.listen", () => {
  it("rejects when the port is already in use", async () => {
    const worker = { fetch: async () => new Response("ok") };
    const first = await createWorkerServer({ worker, env: {}, port: 0 }).listen();
    try {
      const port = first.port;
      await expect(createWorkerServer({ worker, env: {}, port }).listen()).rejects.toThrow();
    } finally {
      await first.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/node-runtime.test.ts`
Expected: FAIL —— `Failed to resolve import "./node-runtime"`

- [ ] **Step 3: 实现**

创建 `deploy/selfhost/node-runtime.ts`：

```typescript
/**
 * Hosts a Cloudflare Worker's `export default { fetch, scheduled }` on
 * node:http. Both pew workers expose a standard Request -> Response fetch
 * handler, and Node 22 implements those Web types natively, so no Worker
 * runtime emulation is needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface WorkerLike {
  fetch(request: Request, env: never): Promise<Response>;
  scheduled?: (event: unknown, env: never) => Promise<void>;
}

export interface WorkerServerOptions<E> {
  worker: { fetch(request: Request, env: E): Promise<Response> };
  env: E;
  port: number;
  hostname?: string;
}

export interface WorkerServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Cloudflare caps request bodies at 100MB; keep headroom below that. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body !== undefined;
  return new Request(url, { method, headers, body: hasBody ? body : undefined });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  // appendHeader, not setHeader: Headers.forEach yields each Set-Cookie as its
  // own entry, and setHeader would overwrite all but the last. The workers
  // return JSON only today, but this keeps the host faithful to fetch().
  response.headers.forEach((value, name) => {
    res.appendHeader(name, value);
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function createWorkerServer<E>(options: WorkerServerOptions<E>) {
  return {
    async listen(): Promise<WorkerServerHandle> {
      const server = createServer((req, res) => {
        void (async () => {
          try {
            const body = await readBody(req);
            const response = await options.worker.fetch(toRequest(req, body), options.env);
            await sendResponse(res, response);
          } catch (error) {
            console.error("worker request failed", error);
            if (!res.headersSent) res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        })();
      });

      // Port collision raises a (port, error) callback, so listen can reject
      // here. Port collisions are the most common runtime failure.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.hostname ?? "0.0.0.0", resolve);
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;

      return {
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            // closeIdleConnections first: keep-alive sockets that are not
            // serving a request would otherwise keep close() pending.
            server.closeIdleConnections();
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    },
  };
}

/**
 * Drives `scheduled` on a fixed interval, standing in for Cloudflare cron
 * triggers. Run this in exactly one container so replicas do not all sync.
 */
export function runScheduled<E>(
  worker: { scheduled?: (event: unknown, env: E) => Promise<void> },
  env: E,
  intervalMs: number
): () => void {
  if (!worker.scheduled) return () => {};
  const handler = worker.scheduled.bind(worker);
  const timer = setInterval(() => {
    void handler({ scheduledTime: Date.now() }, env).catch((error: unknown) => {
      console.error("scheduled run failed", error);
    });
  }, intervalMs);
  // Deliberately NOT unref'd: the scheduler container's only work is this
  // timer, and an unref'd timer does not hold the event loop — a Node process
  // whose only handle is unref'd exits immediately with code 0 before the
  // first tick (verified), so pricing sync would silently never run. The
  // stop() function is the way to release the loop.
  return () => clearInterval(timer);
}

/**
 * Register SIGTERM/SIGINT handlers so the server closes gracefully when
 * docker compose stops the container. Without this, the default Node behavior
 * is to terminate immediately, dropping in-flight requests.
 *
 * A hard timeout guards against a wedged close (e.g. a keep-alive connection
 * that never ends): after 10s we exit regardless.
 */
export function registerShutdownSignals(close: () => Promise<void>): void {
  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down gracefully`);
    const forced = setTimeout(() => {
      console.error("graceful shutdown timed out; forcing exit");
      process.exit(0);
    }, 10_000);
    forced.unref();
    close()
      .catch((error: unknown) => console.error("shutdown error", error))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/node-runtime.test.ts`
Expected: PASS（全部 9 条）

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/node-runtime.ts deploy/selfhost/node-runtime.test.ts
git commit -m "feat: host Worker fetch/scheduled handlers on node:http

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 迁移执行器与账本（`deploy/selfhost/migrate`）

**Files:**
- Create: `deploy/selfhost/migrate.ts`
- Test: `deploy/selfhost/migrate.test.ts`

**Interfaces:**
- Consumes: `D1Like`（Task 2）
- Produces:
  - `splitStatements(sql: string): string[]` —— 正确保留 `CREATE TRIGGER ... BEGIN ... END` 整体
  - `applyMigrations(options: { db: D1Like; dir: string; readFile?: (path: string) => Promise<string>; readDir?: (dir: string) => Promise<string[]>; log?: (msg: string) => void }): Promise<{ applied: string[]; skipped: string[] }>`

**关键约束**：
1. 迁移 DDL 必须带 `?norwtime&norwrandom`，否则 rqlite 会把 DDL 文本里的 `datetime('now')` 与 `randomblob()` 冻结成常量（实测：不带 norw 建表，`DEFAULT (datetime('now'))` 被改写成 `DEFAULT (datetime(2461324.951610))` 这样的固定儒略日，静默废掉所有时间默认值）。适配层（Task 2）不带这两个参数，所以 DDL **不能走 `db.prepare()`**，需要自己发请求。为此 `applyMigrations` 额外接受一个 `ddlExecutor`。
2. **但 `norw*` 只能用在 DDL 上，绝不能罩住迁移文件里的 DML**。实测（rqlite 10.5.3，两副本）：把 `INSERT ... randomblob(16)` 与建表语句放进**同一个** `?norwtime&norwrandom` 请求，leader 与 follower 各自求值 → **两个副本得到不同的值**（分叉）。而同一 INSERT 不带 norw 时两副本一致（rqlite 把它改写成字面量再复制）。因此 `applyMigrations` 必须**按语句分流**：DDL 语句走 `ddlExecutor`（带 norw），DML 语句走 `db.prepare().run()`（不带 norw，走默认改写）。
3. 上游无迁移账本；`ALTER TABLE ADD COLUMN` 不幂等，重复执行报 `duplicate column`。必须自建 `_migrations` 表。
4. 触发器体含分号，按 `;` 朴素切分会切碎。

**Interfaces（补充）**：
- `DdlExecutor = (statements: string[]) => Promise<void>` —— 由调用方提供，负责带 `?norwtime&norwrandom` 发 `/db/execute`。
- `applyMigrations` 用 `isDdlStatement(sql)` 把切分后的语句分成两类：以 `CREATE`/`ALTER`/`DROP` 开头的走 `ddlExecutor`（保持 norw），其余（`INSERT`/`UPDATE`/`DELETE`）走 `db.prepare(sql).run()`（默认改写）。两类都执行完才记账本。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/migrate.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { splitStatements, applyMigrations } from "./migrate";
import type { D1Like, D1Result, D1StatementLike } from "./d1-adapter";

describe("splitStatements", () => {
  it("splits plain statements on semicolons", () => {
    const out = splitStatements("CREATE TABLE a(x);\nCREATE INDEX i ON a(x);");
    expect(out).toEqual(["CREATE TABLE a(x)", "CREATE INDEX i ON a(x)"]);
  });

  it("keeps a CREATE TRIGGER body intact across internal semicolons", () => {
    const sql = [
      "CREATE TABLE t(id INTEGER);",
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN",
      "  UPDATE t SET id = 1;",
      "  UPDATE t SET id = 2;",
      "END;",
      "CREATE INDEX i ON t(id);",
    ].join("\n");
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[1]).toContain("UPDATE t SET id = 1;");
    expect(out[1]).toContain("UPDATE t SET id = 2;");
    expect(out[1].trimEnd().endsWith("END")).toBe(true);
    expect(out[2]).toBe("CREATE INDEX i ON t(id)");
  });

  it("ignores semicolons inside string literals", () => {
    const out = splitStatements("INSERT INTO t VALUES ('a;b');");
    expect(out).toEqual(["INSERT INTO t VALUES ('a;b')"]);
  });

  it("keeps a CREATE TRIGGER body intact even when BEGIN is on the same line as the first statement", () => {
    // The splitter used to key off "BEGIN at end of line", so an inlined body
    // ("CREATE TRIGGER ... BEGIN UPDATE t SET id = 1; END;") was shredded into
    // separate statements. Track the body by the BEGIN keyword itself.
    const sql = "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET id = 1; END;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("BEGIN UPDATE t SET id = 1; END");
  });

  it("drops comment-only and blank fragments", () => {
    const out = splitStatements("-- a comment\n\nCREATE TABLE a(x);\n");
    expect(out).toEqual(["CREATE TABLE a(x)"]);
  });

  it("keeps a trigger body intact across a WHEN clause with its own newlines", () => {
    // 029 shapes AFTER UPDATE ... ON users WHEN OLD.x IS NOT NEW.x ... across
    // several lines before BEGIN. Those line boundaries must not split the body.
    const sql = [
      "CREATE TRIGGER w AFTER UPDATE OF id, name ON users",
      "WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name",
      "BEGIN",
      "  UPDATE x SET y = 1;",
      "END;",
    ].join("\n");
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("WHEN OLD.id IS NOT NEW.id");
    expect(out[0]).toContain("UPDATE x SET y = 1;");
    expect(out[0].trimEnd().endsWith("END")).toBe(true);
  });

  it("handles a trigger whose body ends on the same line as its last statement", () => {
    const out = splitStatements("CREATE TRIGGER t AFTER INSERT ON u BEGIN UPDATE r SET x = 1; END;\nCREATE INDEX i ON u(id);");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("UPDATE r SET x = 1; END");
    expect(out[1]).toBe("CREATE INDEX i ON u(id)");
  });
});

/** Fake D1Like recording executed SQL, plus an in-memory _migrations table. */
function makeFakeDb() {
  const applied: string[] = [];
  const executed: string[] = [];
  const db: D1Like = {
    prepare(sql: string): D1StatementLike {
      let params: unknown[] = [];
      const stmt: D1StatementLike = {
        sql,
        get params() {
          return params;
        },
        bind: (...next: unknown[]) => {
          params = next;
          return stmt;
        },
        all: async <T,>(): Promise<D1Result<T>> =>
          ({ success: true, results: applied.map((id) => ({ id })) as unknown as T[], meta: { changes: 0, duration: 0 } }),
        first: async <T,>(): Promise<T | null> => null,
        run: async (): Promise<D1Result> => {
          executed.push(sql);
          if (sql.startsWith("INSERT INTO _migrations")) applied.push(params[0] as string);
          return { success: true, results: [], meta: { changes: 1, duration: 0 } };
        },
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { db, applied, executed };
}

describe("applyMigrations", () => {
  const files = ["001-init.sql", "002-add-col.sql"];

  it("applies pending migrations in filename order", async () => {
    const { db, applied } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => [...files].reverse(),
      readFile: async (p) => `CREATE TABLE ${p.replace(/\W/g, "_")}(x);`,
    });
    expect(result.applied).toEqual(files);
    expect(result.skipped).toEqual([]);
    expect(applied).toEqual(files);
    // One DDL call per migration, plus the initial ledger DDL.
    expect(ddl).toHaveBeenCalledTimes(3);
  });

  it("skips migrations already recorded in the ledger", async () => {
    const { db, applied } = makeFakeDb();
    applied.push("001-init.sql"); // simulate a previous run
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => files,
      readFile: async () => "CREATE TABLE x(y);",
    });
    expect(result.applied).toEqual(["002-add-col.sql"]);
    expect(result.skipped).toEqual(["001-init.sql"]);
    // Ledger DDL + only the one pending migration.
    expect(ddl).toHaveBeenCalledTimes(2);
  });

  it("creates the ledger table before consulting it", async () => {
    const { db } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => [],
      readFile: async () => "",
    });
    const firstCall = ddl.mock.calls[0][0] as string[];
    expect(firstCall.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS _migrations"))).toBe(true);
  });

  it("ignores non-sql files", async () => {
    const { db } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["001-init.sql", "README.md"],
      readFile: async () => "CREATE TABLE x(y);",
    });
    expect(result.applied).toEqual(["001-init.sql"]);
  });

  it("sends DDL to the ddlExecutor and DML to prepare().run() — never both", async () => {
    // A migration file can mix DDL and DML (029 has CREATE TABLE + INSERT + 12
    // CREATE TRIGGER). DDL must keep ?norwtime&norwrandom; DML must not, or
    // replicas evaluate it independently and diverge (verified on 10.5.3).
    const { db, executed } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    const result = await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["029.sql"],
      readFile: async () =>
        [
          "CREATE TABLE leaderboard_revision (id INTEGER PRIMARY KEY, revision TEXT NOT NULL);",
          "INSERT INTO leaderboard_revision VALUES (1, lower(hex(randomblob(16))));",
          "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET z = 1; END;",
        ].join("\n"),
    });
    expect(result.applied).toEqual(["029.sql"]);
    // DDL (CREATE TABLE + CREATE TRIGGER) to the executor, DML (INSERT) to run()
    expect(ddl).toHaveBeenCalledTimes(1);
    const ddlSql = ddl.mock.calls[0][0].join("\n");
    expect(ddlSql).toContain("CREATE TABLE leaderboard_revision");
    expect(ddlSql).toContain("CREATE TRIGGER t");
    expect(ddlSql).not.toContain("INSERT INTO leaderboard_revision");
    expect(executed.some((s) => s.startsWith("INSERT INTO leaderboard_revision"))).toBe(true);
  });

  it("preserves file order across mixed DDL/DML statements", async () => {
    // A later DML may depend on an earlier DDL; routing must not reorder them.
    const { db, executed } = makeFakeDb();
    const ddl = vi.fn().mockResolvedValue(undefined);
    await applyMigrations({
      db,
      dir: "/migrations",
      ddlExecutor: ddl,
      readDir: async () => ["m.sql"],
      readFile: async () =>
        "CREATE TABLE a(x);\nINSERT INTO a VALUES (1);\nCREATE INDEX i ON a(x);\nINSERT INTO a VALUES (2);",
    });
    const order: string[] = [];
    for (const [sql] of ddl.mock.calls) order.push("DDL:" + sql[0]);
    for (const s of executed) order.push("DML:" + s);
    expect(order).toEqual([
      "DDL:CREATE TABLE a(x)",
      "DML:INSERT INTO a VALUES (1)",
      "DDL:CREATE INDEX i ON a(x)",
      "DML:INSERT INTO a VALUES (2)",
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/migrate.test.ts`
Expected: FAIL —— `Failed to resolve import "./migrate"`

- [ ] **Step 3: 实现**

创建 `deploy/selfhost/migrate.ts`：

```typescript
/**
 * Applies scripts/migrations/*.sql to rqlite.
 *
 * Upstream tracks migrations through wrangler's local state file, which does
 * not exist here, so this module keeps its own ledger. The ledger matters
 * because most upstream migrations are idempotent (CREATE TABLE IF NOT EXISTS)
 * but ALTER TABLE ADD COLUMN is not — replaying one fails with
 * "duplicate column name".
 */

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Like } from "./d1-adapter";

export type DdlExecutor = (statements: string[]) => Promise<void>;

export interface ApplyMigrationsOptions {
  db: D1Like;
  dir: string;
  /** Runs DDL with rqlite's ?norwtime&norwrandom so non-deterministic
   *  functions survive into sqlite_master instead of being frozen. */
  ddlExecutor: DdlExecutor;
  readDir?: (dir: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  log?: (message: string) => void;
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

const LEDGER_DDL = [
  "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
];

/**
 * True for statements that define schema (CREATE/ALTER/DROP). Those must run
 * with rqlite's ?norwtime&norwrandom so their non-deterministic text is kept
 * verbatim. DML (INSERT/UPDATE/DELETE) must NOT: rqlite's default rewrite is
 * what makes those statements identical across replicas. Putting a DML row in
 * the same norw* request makes every replica evaluate it independently, which
 * diverges (verified on 10.5.3: two replicas stored different randomblob
 * values for one INSERT when it shared a norw* request with a CREATE TABLE).
 */
export function isDdlStatement(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|REINDEX|VACUUM)\b/i.test(sql);
}

/**
 * Split a migration file into statements.
 *
 * A naive split on ";" breaks CREATE TRIGGER, whose body contains semicolons
 * between BEGIN and END. String literals may also contain semicolons, and line
 * comments may contain both.
 *
 * The trigger body is tracked by the BEGIN/END keywords themselves (word
 * boundaries), NOT by "BEGIN at end of line": an inlined body such as
 * "CREATE TRIGGER ... BEGIN UPDATE t SET id = 1; END;" must stay in one piece.
 * A ";" inside a body belongs to the body and is kept; one that ends the body
 * (or sits outside any body) terminates the statement and is dropped.
 *
 * Verified two ways: the unit tests below, and by splitting all 30 applied
 * migration files (133 statements) and executing every statement in a real
 * SQLite in-memory database — 0 errors, yielding 22 tables and 12 triggers.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  let quote: "'" | '"' | null = null;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  // BEGIN opens a trigger body, END closes it; both matched at word boundaries
  // so identifiers like "endpoint" or "beginning" do not trip the state.
  const applyState = (chunk: string) => {
    if (!inTrigger && /\bBEGIN\b/i.test(chunk)) inTrigger = true;
    if (inTrigger && /\bEND\b/i.test(chunk)) inTrigger = false;
  };

  const lines = sql.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let i = 0;
    let start = 0;
    let end = line.length; // content stops here (line comment cut)
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      // Line comment: discard the rest of the line.
      if (ch === "-" && line[i + 1] === "-") {
        end = i;
        break;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === ";") {
        const body = line.slice(start, i);
        // Update trigger state from the body *before* deciding: a ";" inside a
        // body is kept; one that closes the body (or is outside one) is the
        // statement terminator and is dropped.
        applyState(body);
        current += inTrigger ? body + ";" : body;
        start = i + 1;
        if (!inTrigger) flush();
        i += 1;
        continue;
      }
      i += 1;
    }
    const tail = line.slice(start, end) + (li < lines.length - 1 ? "\n" : "");
    applyState(tail);
    current += tail;
  }

  flush();
  return statements;
}

export async function applyMigrations(
  options: ApplyMigrationsOptions
): Promise<ApplyMigrationsResult> {
  const readDirImpl = options.readDir ?? ((dir: string) => readdir(dir));
  const readFileImpl = options.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const log = options.log ?? (() => {});

  await options.ddlExecutor(LEDGER_DDL);

  const { results } = await options.db
    .prepare("SELECT id FROM _migrations")
    .all<{ id: string }>();
  const done = new Set(results.map((r) => r.id));

  const files = (await readDirImpl(options.dir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = await readFileImpl(join(options.dir, name));
    const statements = splitStatements(sql);
    // Route each statement by class, preserving file order (a later DML may
    // depend on an earlier DDL). DDL keeps ?norwtime&norwrandom so its text is
    // stored verbatim; DML must not, or replicas diverge (see isDdlStatement).
    // Consecutive DDL runs are coalesced into one ddlExecutor call.
    let pendingDdl: string[] = [];
    const flushDdl = async () => {
      if (pendingDdl.length > 0) {
        await options.ddlExecutor(pendingDdl);
        pendingDdl = [];
      }
    };
    for (const stmt of statements) {
      if (isDdlStatement(stmt)) {
        pendingDdl.push(stmt);
      } else {
        await flushDdl();
        await options.db.prepare(stmt).run();
      }
    }
    await flushDdl();
    await options.db
      .prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))")
      .bind(name)
      .run();
    applied.push(name);
    log(`applied ${name} (${statements.length} statements)`);
  }

  return { applied, skipped };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/migrate.test.ts`
Expected: PASS（全部 13 条）

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/migrate.ts deploy/selfhost/migrate.test.ts
git commit -m "feat: add migration runner with ledger and trigger-aware splitter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 基础设施迁移（`031-selfhost-infrastructure.sql`）

**Files:**
- Create: `scripts/migrations/031-selfhost-infrastructure.sql`
- Test: `deploy/selfhost/selfhost-infrastructure.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `applyMigrations`、Task 2 的 `createD1Adapter`
- Produces: 数据库内的 `kv_cache` 表（含 `expires_at` 索引）

**为什么单独一个任务**：`kv_cache` 是 Task 3 的 KV 适配层的存储后端，但 Task 3 只写代码不建表——**实测确认：没有任何上游迁移创建 `kv_cache`**（`grep -rn "kv_cache" scripts/migrations/` 为空）。缺了这张表，`worker-read` 的每次缓存读写都会 500，但单元测试用的是内存假库，**测不出来**。本任务补上这个缺口。

**为什么不用 `CREATE TABLE` 放在 `_migrations` 账本里**：`_migrations` 是执行器的基础设施（Task 5 直接建），而 `kv_cache` 属于业务 schema，应走标准迁移文件、被账本记录，这样上游新增迁移时顺序与幂等性都由同一套机制保证。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/selfhost-infrastructure.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitStatements } from "./migrate";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/migrations/031-selfhost-infrastructure.sql"
);

describe("031-selfhost-infrastructure.sql", () => {
  it("creates the kv_cache table the KV adapter depends on", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const statements = splitStatements(sql).join("\n");
    expect(statements).toMatch(/CREATE TABLE IF NOT EXISTS\s+kv_cache/i);
    expect(statements).toMatch(/key\s+TEXT\s+PRIMARY KEY/i);
    expect(statements).toMatch(/value\s+TEXT\s+NOT NULL/i);
    expect(statements).toMatch(/expires_at\s+TEXT/i);
  });

  it("is idempotent so re-running the migration set is safe", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const statements = splitStatements(sql);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, `not idempotent: ${statement.slice(0, 60)}`).toMatch(
        /IF NOT EXISTS/i
      );
    }
  });

  it("does not use non-deterministic defaults", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).not.toMatch(/DEFAULT\s*\(\s*datetime\s*\(\s*'now'/i);
    expect(sql).not.toMatch(/randomblob\s*\(/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/selfhost-infrastructure.test.ts`
Expected: FAIL —— `ENOENT` 找不到迁移文件

- [ ] **Step 3: 实现**

创建 `scripts/migrations/031-selfhost-infrastructure.sql`：

```sql
-- Self-hosted deployment infrastructure.
--
-- worker-read uses env.CACHE as a Cloudflare KV namespace. In the self-hosted
-- deployment that binding is backed by this table (deploy/selfhost/kv-adapter.ts),
-- so every read replica shares one cache and the cache is included in the
-- rqlite backup. Nothing upstream creates this table — without it every cache
-- read and write in worker-read fails.
--
-- expires_at holds an absolute ISO-8601 timestamp; kv-adapter filters on it at
-- read time and treats NULL as "never expires".

CREATE TABLE IF NOT EXISTS kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_kv_cache_expires ON kv_cache(expires_at);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/selfhost-infrastructure.test.ts`
Expected: PASS（全部 3 条）

- [ ] **Step 5: 提交**

```bash
git add scripts/migrations/031-selfhost-infrastructure.sql deploy/selfhost/selfhost-infrastructure.test.ts
git commit -m "feat: add kv_cache table for the self-hosted KV adapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 确定性触发器后置迁移

**Files:**
- Create: `scripts/migrations/030-deterministic-leaderboard-revision.sql`

> **注**：本任务**只做迁移文件与迁移侧验证**。`auth-adapter.ts` 等生产 INSERT 的时间列补写属于 Plan 2（认证子系统），因为那些改动与凭据注册同批交付更安全。本任务交付的是「多节点下 revision 不再分叉」。

**Interfaces:**
- Consumes: Task 5 的 `applyMigrations`
- Produces: 数据库内 12 个确定性触发器 + `leaderboard_revision_seq` 表；`leaderboard_revision.revision` 仍为 32 位小写 hex

**背景**（实测）：解冻后触发器体内的 `randomblob(16)` 在各副本各自求值，三副本得到 3 种不同 revision（暂停 follower 跨秒重放实测）。改为 `seq` 计数器后重放收敛（实测三副本 `seq=5`、revision 一致）。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/deterministic-revision.test.ts`：

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// vitest runs ESM here, so __dirname is not defined.
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/migrations/030-deterministic-leaderboard-revision.sql"
);

describe("030-deterministic-leaderboard-revision.sql", () => {
  let sql: string;

  beforeAll(async () => {
    sql = await readFile(MIGRATION, "utf8");
  });

  it("adds a monotonic counter table", () => {
    expect(sql).toMatch(/CREATE TABLE[^;]*leaderboard_revision_seq/i);
  });

  it("replaces every upstream trigger that used randomblob", () => {
    const names = [
      "leaderboard_user_insert",
      "leaderboard_user_delete",
      "leaderboard_user_update",
      "leaderboard_team_insert",
      "leaderboard_team_delete",
      "leaderboard_team_update",
      "leaderboard_team_member_insert",
      "leaderboard_team_member_delete",
      "leaderboard_team_member_update",
      "leaderboard_org_member_insert",
      "leaderboard_org_member_delete",
      "leaderboard_org_member_update",
    ];
    for (const name of names) {
      expect(sql, `missing DROP for ${name}`).toMatch(
        new RegExp(`DROP TRIGGER IF EXISTS\\s+${name}\\b`, "i")
      );
      expect(sql, `missing CREATE for ${name}`).toMatch(
        new RegExp(`CREATE TRIGGER\\s+${name}\\b`, "i")
      );
    }
  });

  it("contains no non-deterministic functions in trigger bodies", () => {
    const bodies = sql.split(/CREATE TRIGGER/i).slice(1);
    expect(bodies.length).toBeGreaterThanOrEqual(12);
    for (const body of bodies) {
      expect(body).not.toMatch(/randomblob\s*\(/i);
      expect(body).not.toMatch(/datetime\s*\(\s*'now'/i);
    }
  });

  it("formats the revision as 32 lowercase hex digits", () => {
    expect(sql).toMatch(/printf\(\s*'%032x'/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/deterministic-revision.test.ts`
Expected: FAIL —— `ENOENT` 找不到迁移文件

- [ ] **Step 3: 实现**

创建 `scripts/migrations/030-deterministic-leaderboard-revision.sql`：

```sql
-- Make leaderboard revision generation deterministic.
--
-- 029 uses lower(hex(randomblob(16))) inside trigger bodies. rqlite replicates
-- statements, not effects: each replica re-evaluates randomblob() when it
-- applies the trigger, so replicas diverge (measured: three replicas produced
-- three different revisions after a paused follower replayed the log). A
-- counter replayed from the same log converges on every replica.
--
-- printf('%032x', n) keeps the 32-lowercase-hex shape that
-- leaderboard-snapshot.ts validates with /^[a-f0-9]{32}$/.
--
-- Semantics change from "random" to "monotonic". Every consumer only tests
-- equality (leaderboard-snapshot.ts:135,143 and api/leaderboard/route.ts:185),
-- so monotonicity is compatible.

CREATE TABLE IF NOT EXISTS leaderboard_revision_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT OR IGNORE INTO leaderboard_revision_seq (id, n) VALUES (1, 0);

-- 029 seeds leaderboard_revision with lower(hex(randomblob(16))). That DML
-- runs through the default rewrite path (see Task 5: DML must NOT carry
-- ?norwtime&norwrandom), so every replica stores the same literal — but the
-- value is still a random blob, not a counter. Overwrite it here so the
-- revision starts at a deterministic 0 and only ever moves via the triggers
-- below. Without this, a read-only instance would keep the random seed.
UPDATE leaderboard_revision SET revision = printf('%032x', 0) WHERE id = 1;

DROP TRIGGER IF EXISTS leaderboard_user_insert;
DROP TRIGGER IF EXISTS leaderboard_user_delete;
DROP TRIGGER IF EXISTS leaderboard_user_update;
DROP TRIGGER IF EXISTS leaderboard_team_insert;
DROP TRIGGER IF EXISTS leaderboard_team_delete;
DROP TRIGGER IF EXISTS leaderboard_team_update;
DROP TRIGGER IF EXISTS leaderboard_team_member_insert;
DROP TRIGGER IF EXISTS leaderboard_team_member_delete;
DROP TRIGGER IF EXISTS leaderboard_team_member_update;
DROP TRIGGER IF EXISTS leaderboard_org_member_insert;
DROP TRIGGER IF EXISTS leaderboard_org_member_delete;
DROP TRIGGER IF EXISTS leaderboard_org_member_update;

CREATE TRIGGER leaderboard_user_insert AFTER INSERT ON users BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_delete AFTER DELETE ON users BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_update
AFTER UPDATE OF id, name, nickname, image, slug, is_public ON users
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.nickname IS NOT NEW.nickname
  OR OLD.image IS NOT NEW.image OR OLD.slug IS NOT NEW.slug OR OLD.is_public IS NOT NEW.is_public
BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_insert AFTER INSERT ON teams BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_delete AFTER DELETE ON teams BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_update AFTER UPDATE OF id, name, logo_url ON teams
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.logo_url IS NOT NEW.logo_url
BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_member_insert AFTER INSERT ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_delete AFTER DELETE ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_update AFTER UPDATE ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_insert AFTER INSERT ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_delete AFTER DELETE ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_update AFTER UPDATE ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/deterministic-revision.test.ts`
Expected: PASS（全部 4 条）

- [ ] **Step 5: 提交**

> **注**：对真实 rqlite 的端到端验证（应用全部迁移并断言 schema）依赖 `verify-migrations.ts`——由 **Task 8 创建**。按编号顺序执行时本步跳过，Task 8 完成后回补一次（Task 8 Step 3 即覆盖该验证，含本任务的 030 迁移）。

```bash
git add scripts/migrations/030-deterministic-leaderboard-revision.sql deploy/selfhost/deterministic-revision.test.ts
git commit -m "feat: replace leaderboard triggers with deterministic counter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 迁移端到端验证脚本（`deploy/selfhost/verify-migrations`）

**Files:**
- Create: `deploy/selfhost/verify-migrations.ts`
- Create: `deploy/selfhost/rqlite-client.ts`（带 `?norwtime&norwrandom` 的 DDL 执行器）

**Interfaces:**
- Consumes: Task 2 的 `createD1Adapter`、Task 5 的 `applyMigrations`、Task 5 的 `DdlExecutor` 类型
- Produces:
  - `createRqliteDdlExecutor(options: { baseUrl: string; token?: string; fetchImpl?: typeof fetch }): DdlExecutor`
  - CLI：`bun run deploy/selfhost/verify-migrations.ts --base-url <url>` —— 应用全部迁移，断言 schema 对象数，失败时非零退出

**为什么需要**：spec §6 的「迁移兼容测试」要求断言 schema 对象数。这是把「解冻 DDL 后全部迁移能跑通」从推断变成证据的唯一手段。

**实测基线（rqlite 10.5.3，2026-10-11，全部迁移应用后）**：上游表 22 张，本方案新增 3 张（`_migrations`、`kv_cache`、`leaderboard_revision_seq`）；索引 65 个（**含** SQLite 为 PRIMARY KEY / UNIQUE 自动创建的 39 个 `sqlite_autoindex_*`）；触发器 12 个；视图 2 个（`usage_bases`、`usage_totals`）。

spec §6 原写的「23 表 / 62 索引」是估计值，**实测不成立**，已按实测更正：显式索引只有 26 个，因为 `023-retire-features`、`024-retire-badges`、`025-retire-budgets` 三个迁移把 `projects`、`project_tags`、`showcases`、`badges`、`budgets` 五张表 DROP 了，其索引随之消失。

- [ ] **Step 1: 实现 DDL 执行器**

创建 `deploy/selfhost/rqlite-client.ts`：

```typescript
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
```

- [ ] **Step 2: 实现验证脚本**

创建 `deploy/selfhost/verify-migrations.ts`：

```typescript
/**
 * Applies every migration to a live rqlite instance and asserts the resulting
 * schema shape. Run against a throwaway node:
 *
 *   docker run -d --name rq-verify -p 14001:4001 rqlite/rqlite:10.5.3 -fk
 *   bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001
 *
 * Also idempotency-checks by running the migration set a second time: the
 * ledger must report everything as skipped and nothing may throw.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Adapter } from "./d1-adapter";
import { createRqliteDdlExecutor } from "./rqlite-client";
import { applyMigrations } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");

/** Migrations squashed into later files; wrangler skips them, so must we. */
const SQUASHED = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);

/**
 * Measured against rqlite 10.5.3 after applying every migration on 2026-10-11.
 *
 * `upstreamTables` counts tables the upstream migrations create; the plan adds
 * three more (_migrations, kv_cache, leaderboard_revision_seq).
 *
 * `indexes` counts every sqlite_master entry of type 'index', which includes
 * the 39 auto-indexes SQLite creates for PRIMARY KEY and UNIQUE constraints.
 * The explicit count is lower because 023/024/025 retire features and drop
 * their tables (badges, budgets, projects, showcases, project_tags), taking
 * their indexes with them.
 */
const EXPECTED = {
  upstreamTables: 22,
  planTables: 3,
  indexes: 65,
  triggers: 12,
  views: 2,
};

/** Tables this plan creates, on top of what upstream migrations define. */
const PLAN_TABLES = new Set(["_migrations", "kv_cache", "leaderboard_revision_seq"]);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const baseUrl = arg("base-url") ?? "http://127.0.0.1:14001";
  const db = createD1Adapter({ baseUrl, token: "" });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl });

  const readDir = async (dir: string) => {
    const { readdir } = await import("node:fs/promises");
    const all = await readdir(dir);
    return all.filter((f) => f.endsWith(".sql") && !SQUASHED.has(f));
  };

  const first = await applyMigrations({ db, dir: MIGRATIONS_DIR, ddlExecutor, readDir, log: console.log });
  console.log(`applied ${first.applied.length} migrations`);

  const second = await applyMigrations({ db, dir: MIGRATIONS_DIR, ddlExecutor, readDir, log: () => {} });
  if (second.applied.length !== 0) {
    throw new Error(`ledger not idempotent: reapplied ${second.applied.join(", ")}`);
  }
  console.log(`idempotency ok: skipped ${second.skipped.length}`);

  // Counts every entry of the given type, including SQLite's implicit
  // sqlite_autoindex_* rows, so the numbers match a plain
  // `SELECT name FROM sqlite_master WHERE type='index'` (65 measured).
  const count = async (type: string): Promise<number> => {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ?")
      .bind(type)
      .all<{ n: number }>();
    return results[0]?.n ?? 0;
  };

  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all<{ name: string }>();
  const names = tables.results.map((r) => r.name);
  const planTables = names.filter((n) => PLAN_TABLES.has(n));
  const upstreamTables = names.length - planTables.length;

  const actual = {
    upstreamTables,
    planTables: planTables.length,
    indexes: await count("index"),
    triggers: await count("trigger"),
    views: await count("view"),
  };
  console.log("schema:", actual, "expected:", EXPECTED);

  for (const [key, expected] of Object.entries(EXPECTED)) {
    const got = actual[key as keyof typeof actual];
    if (got !== expected) {
      throw new Error(`schema mismatch for ${key}: got ${got}, expected ${expected}`);
    }
  }

  // The KV adapter is useless without its backing table; a missing table only
  // shows up at runtime, never in the unit tests (they use an in-memory fake).
  if (!names.includes("kv_cache")) {
    throw new Error("kv_cache table missing — worker-read cache would fail at runtime");
  }

  // Non-determinism guard: DDL must not have been frozen by rqlite.
  const { results: revisionRows } = await db
    .prepare("SELECT revision FROM leaderboard_revision WHERE id = 1")
    .all<{ revision: string }>();
  const revision = revisionRows[0]?.revision ?? "";
  if (!/^[a-f0-9]{32}$/.test(revision)) {
    throw new Error(`leaderboard revision malformed: ${revision}`);
  }
  console.log(`leaderboard revision ok: ${revision}`);

  console.log("migration verification PASSED");
}

main().catch((error: unknown) => {
  console.error("migration verification FAILED:", error);
  process.exit(1);
});
```

- [ ] **Step 3: 对真实 rqlite 运行**

```bash
docker run -d --name rq-verify -p 14001:4001 rqlite/rqlite:10.5.3 -fk
sleep 3
bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001
```

Expected: 打印 `migration verification PASSED`。

**若 schema 计数与预期不符**：不要改脚本去迁就实际值。先确认计数是否把 `_migrations`、`kv_cache`、`leaderboard_revision_seq` 等本方案新增对象也算进去了——预期值需要相应调整（新增表计入 tables）。把实际值与差异记录到 spec §6，再更新 `EXPECTED`。

- [ ] **Step 4: 清理并提交**

```bash
docker rm -f rq-verify
git add deploy/selfhost/verify-migrations.ts deploy/selfhost/rqlite-client.ts
git commit -m "feat: add migration verification script against live rqlite

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: d1-http 服务（D1 REST 形状）

**Files:**
- Create: `deploy/selfhost/d1-http.ts`
- Test: `deploy/selfhost/d1-http.test.ts`

**Interfaces:**
- Consumes: `createD1Adapter`（Task 2）
- Produces: `createD1HttpServer(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): { handle(request: Request): Promise<Response> }`
  - `token` 是入站 Bearer（`CF_D1_API_TOKEN`）；同时作为访问 rqlite 的 Bearer 转发给 `createD1Adapter`（rqlite 当前无鉴权，故运行期无影响；若将来给 rqlite 开 `-auth`，需另加独立的 `rqliteToken`）
  - `POST <mount>/query` —— 接受 `{ sql, params }` 或 `{ batch: [{sql, params}] }`，返回 `{ success, result: [{ success, results, meta }], errors: [] }`
  - 未带正确 Bearer 时返回 401

**关键约束**（来自 `lib/d1.ts:112-170` 的实际要求）：
1. 顶层必须有 `success`；每语句必须有 `success`。
2. 每语句必须有 `meta`——缺了则 `d1.ts:100/124` 兜底 `{changes:0}`，`invite.ts:147` 会把每个邀请码当成已用。
3. batch 结果的**数组长度必须等于语句数**——rqlite 出错时截断数组，`d1.ts:119` 会先抛 "Invalid D1 batch result"，真实错误被掩盖。

- [ ] **Step 1: 写失败测试**

创建 `deploy/selfhost/d1-http.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { createD1HttpServer } from "./d1-http";

const TOKEN = "d1-http-token";

function rqliteResponse(results: unknown[], status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve({ results }),
  } as unknown as Response;
}

function post(body: unknown, token = TOKEN) {
  return new Request("http://d1-http:8788/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("d1-http", () => {
  it("rejects requests without the bearer token", async () => {
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: vi.fn() as never });
    const res = await server.handle(
      new Request("http://d1-http:8788/query", { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token that shares a prefix with the real one", async () => {
    // Guards the constant-time compare: a shorter/longer or prefix-matching
    // Authorization must still be rejected.
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: vi.fn() as never });
    for (const bad of [TOKEN.slice(0, -1), `${TOKEN}x`, "x"]) {
      const res = await server.handle(post({ sql: "SELECT 1", params: [] }, bad));
      expect(res.status).toBe(401);
    }
  });

  it("wraps a single query in the D1 envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ rows: [{ a: 1 }], time: 0.002 }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "SELECT a FROM t", params: [] }));
    expect(await res.json()).toEqual({
      success: true,
      result: [{ success: true, results: [{ a: 1 }], meta: { changes: 0, duration: 2 } }],
      errors: [],
    });
  });

  it("routes a single INSERT through /db/request so writes are not rejected", async () => {
    // /db/query rejects every write ("attempt to change database via query
    // operation", verified against rqlite 10.5.3). lib/d1.ts posts execute()
    // to the same <mount>/query endpoint as query(), so a bare {sql} body can
    // absolutely be a write — it must land on /db/request.
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 4, rows_affected: 1, time: 0.001 }])
    );
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "INSERT INTO t (v) VALUES (?)", params: ["x"] }));
    const body = await res.json();
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://rqlite:4001/db/request?transaction=true&associative&timings");
    expect(body.result[0].meta.changes).toBe(1);
  });

  it("reports changes 0 rather than omitting meta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ last_insert_id: 9 }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "UPDATE t SET a = 1 WHERE 0", params: [] }));
    const body = await res.json();
    expect(body.result[0].meta.changes).toBe(0);
  });

  it("keeps the batch result array length equal to the statement count on error", async () => {
    // rqlite truncates results at the failing statement.
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows_affected: 1 }, { error: "UNIQUE constraint failed" }])
    );
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(
      post({
        batch: [
          { sql: "INSERT INTO t VALUES (1)", params: [] },
          { sql: "INSERT INTO t VALUES (1)", params: [] },
          { sql: "INSERT INTO t VALUES (2)", params: [] },
        ],
      })
    );
    const body = await res.json();
    expect(body.result).toHaveLength(3);
    expect(body.success).toBe(false);
    expect(body.errors[0].message).toMatch(/UNIQUE constraint failed/);
  });

  it("returns success false when a statement fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ error: "no such table: nope" }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "SELECT * FROM nope", params: [] }));
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].message).toMatch(/no such table/);
  });

  it("returns an empty result array for an empty batch", async () => {
    const fetchImpl = vi.fn();
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ batch: [] }));
    expect(await res.json()).toEqual({ success: true, result: [], errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run deploy/selfhost/d1-http.test.ts`
Expected: FAIL —— `Failed to resolve import "./d1-http"`

- [ ] **Step 3: 实现**

创建 `deploy/selfhost/d1-http.ts`：

```typescript
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
  fetchImpl?: typeof fetch;
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
    fetchImpl: options.fetchImpl,
  });
  const expectedAuth = `Bearer ${options.token}`;

  // Constant-time compare: `!==` short-circuits, so a leaked prefix could be
  // used to guess the token character by character. The upstream workers
  // already compare their shared secrets this way (packages/worker/src/index.ts
  // secureCompare; worker-read/src/index.ts).
  function secureEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const ba = enc.encode(a);
    const bb = enc.encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run deploy/selfhost/d1-http.test.ts`
Expected: PASS（全部 8 条）

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/d1-http.ts deploy/selfhost/d1-http.test.ts
git commit -m "feat: add D1 REST-shape HTTP service over rqlite

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 进程入口与 compose 编排

**Files:**
- Create: `deploy/selfhost/Dockerfile`
- Create: `deploy/selfhost/server-d1-http.ts`
- Create: `deploy/selfhost/server-read.ts`
- Create: `deploy/selfhost/server-ingest.ts`
- Create: `deploy/selfhost/server-scheduler.ts`
- Create: `deploy/selfhost/migrate-cli.ts`
- Create: `deploy/selfhost/docker-compose.yml`
- Create: `deploy/selfhost/.env.example`
- Create: `deploy/selfhost/README.md`

**Interfaces:**
- Consumes: Tasks 2–8 的全部导出
- Produces: 可运行的五个服务；`docker compose up -d`（`.env` 里 `COMPOSE_PROFILES=single`）起全栈

**注意**：本任务无单元测试——它的交付物是「容器起来且互相能通」，由 Step 5 的手工端到端验证覆盖。

> **两套镜像，别混**：跑 bun 的适配层服务（migrate/d1-http/read/ingest/scheduler）用本任务的 `deploy/selfhost/Dockerfile` 构建的 `pew-selfhost:local`；**web 用仓库根 `Dockerfile` 构建的 `pew:standalone`**（Next standalone，根 `Dockerfile:72` 的 `CMD ["node","packages/web/server.js"]`）。把 web 指到 `pew-selfhost:local` 会因无 Next 产物、无 CMD 而退出。

- [ ] **Step 1: 写自建镜像 Dockerfile**

> **为什么不能复用根 `Dockerfile`**：它的 runner 阶段 `FROM node:22-slim`，只 COPY
> `.next/standalone`/`.next/static`/`public`——**没有 bun、没有 `deploy/`、没有
> `packages/*/src`、没有 `scripts/migrations`**（实测 runner 阶段 bun 出现次数为 0）。
> 用它构建的镜像跑 `bun run deploy/selfhost/*.ts` 会五个容器全部起不来，进而
> migrate 失败 → read/ingest/scheduler 被 `service_completed_successfully` 挡住 →
> web 被 `service_healthy` 挡住，整套 compose 无法启动。

创建 `deploy/selfhost/Dockerfile`（compose 里跑 bun 服务的 `migrate` 引用它构建；
**web 不用它**——web 走仓库根 `Dockerfile` 构建 Next standalone，见下方 compose）：

```dockerfile
// Image for every deploy/selfhost service that runs TS via bun (migrate,
// d1-http, read, ingest, scheduler). The repo-root Dockerfile's runner stage
// cannot run them: it is a node:22-slim Next.js standalone image with no bun,
// no deploy/, no package sources and no migrations.
//
// This is NOT the image for `web` — web is a Next.js standalone build and uses
// the repo-root Dockerfile (see compose: web's build points at ./Dockerfile).
FROM oven/bun:1.4.0 AS build

WORKDIR /app

# Workspace metadata first so dependency layers cache independently of source.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY packages/worker-read/package.json packages/worker-read/
COPY packages/cli/package.json packages/cli/
RUN bun install --frozen-lockfile

# Source for @pew/core — its package.json "main" is ./dist/index.js, so the
# dist must exist even when bun runs TS entrypoints directly.
COPY tsconfig.json ./
COPY packages/core packages/core
RUN bun run --filter @pew/core build

COPY packages/web packages/web
COPY packages/worker packages/worker
COPY packages/worker-read packages/worker-read
COPY scripts scripts
COPY deploy deploy

ENV NODE_ENV=production
```

**自检**（写完立刻跑，防止又造出一个「没有 bun 的镜像」）：

```bash
# Context is the repo root, so `COPY package.json ...` resolves. Run from /Volumes/Work/orca/pew.
docker build -f deploy/selfhost/Dockerfile -t pew-selfhost:local .
docker run --rm --entrypoint bun pew-selfhost:local --version
docker run --rm --entrypoint sh pew-selfhost:local   -c 'test -f deploy/selfhost/d1-http.ts && test -f scripts/migrations/001-init.sql && test -d packages/core/dist'
# Expected: 三条命令全部 exit 0
```

- [ ] **Step 2: 写 d1-http 入口**

创建 `deploy/selfhost/server-d1-http.ts`：

```typescript
/**
 * Entry point for the d1-http container.
 *
 * Serves the D1 REST shape on PORT (default 8788). Only the web container
 * needs to reach it; it is never published to the host.
 */

import { createServer } from "node:http";
import { createD1HttpServer } from "./d1-http";
import { registerShutdownSignals } from "./node-runtime";

const PORT = Number(process.env.PORT ?? 8788);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const TOKEN = process.env.CF_D1_API_TOKEN ?? "";

if (!TOKEN) {
  console.error("CF_D1_API_TOKEN is required (it authenticates d1-http)");
  process.exit(1);
}

const server = createD1HttpServer({ baseUrl: RQLITE_URL, token: TOKEN });

const nodeServer = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
      body: body.length > 0 ? body : undefined,
    });

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const response = await server.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch((error: unknown) => {
    console.error("d1-http request failed", error);
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ success: false, errors: [{ message: "Internal error" }] }));
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`d1-http listening on :${PORT} -> ${RQLITE_URL}`);
});

registerShutdownSignals(async () => nodeServer.close());
```

- [ ] **Step 3: 写 read / ingest / scheduler 入口**

创建 `deploy/selfhost/server-read.ts`：

```typescript
/**
 * Hosts packages/worker-read on node:http, wired to the rqlite-backed
 * D1 and KV adapters. Serves /api/live (no auth) and /api/rpc (Bearer).
 */

import worker from "../../packages/worker-read/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createKvAdapter } from "./kv-adapter";
import { createWorkerServer, registerShutdownSignals } from "./node-runtime";

const PORT = Number(process.env.PORT ?? 8787);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN });
const env = {
  DB: db,
  CACHE: createKvAdapter({ db }),
  WORKER_READ_SECRET: process.env.WORKER_READ_SECRET ?? "",
};

if (!env.WORKER_READ_SECRET) {
  console.error("WORKER_READ_SECRET is required");
  process.exit(1);
}

createWorkerServer({ worker, env, port: PORT })
  .listen()
  .then((handle) => {
    console.log(`worker-read listening on :${handle.port}`);
    registerShutdownSignals(handle.close);
  })
  .catch((error: unknown) => {
    console.error("failed to start worker-read", error);
    process.exit(1);
  });
```

创建 `deploy/selfhost/server-ingest.ts`：

```typescript
/**
 * Hosts packages/worker (the ingest worker) on node:http. This worker has no
 * scheduled handler, so only fetch is wired up.
 */

import worker from "../../packages/worker/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createWorkerServer, registerShutdownSignals } from "./node-runtime";

const PORT = Number(process.env.PORT ?? 8786);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";

const env = {
  DB: createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN }),
  WORKER_SECRET: process.env.WORKER_SECRET ?? "",
};

if (!env.WORKER_SECRET) {
  console.error("WORKER_SECRET is required");
  process.exit(1);
}

createWorkerServer({ worker, env, port: PORT })
  .listen()
  .then((handle) => {
    console.log(`worker-ingest listening on :${handle.port}`);
    registerShutdownSignals(handle.close);
  })
  .catch((error: unknown) => {
    console.error("failed to start worker-ingest", error);
    process.exit(1);
  });
```

创建 `deploy/selfhost/server-scheduler.ts`：

```typescript
/**
 * Runs worker-read's scheduled handler (dynamic pricing sync) on a timer.
 *
 * Kept as its own container and scaled to exactly one replica: if every read
 * replica ran the timer they would all sync concurrently.
 *
 * DAILY_INTERVAL_MS defaults to 24h, matching the upstream Cloudflare cron
 * "0 3 * * *".
 */

import worker from "../../packages/worker-read/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createKvAdapter } from "./kv-adapter";
import { registerShutdownSignals, runScheduled } from "./node-runtime";

const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
const INTERVAL_MS = Number(process.env.DAILY_INTERVAL_MS ?? 24 * 60 * 60 * 1000);

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN });
const env = {
  DB: db,
  CACHE: createKvAdapter({ db }),
  WORKER_READ_SECRET: process.env.WORKER_READ_SECRET ?? "",
};

console.log(`scheduler running every ${INTERVAL_MS}ms`);
const stop = runScheduled(worker, env, INTERVAL_MS);
registerShutdownSignals(async () => {
  stop();
});
```

- [ ] **Step 4: 写 compose 与配置样例**

创建 `deploy/selfhost/docker-compose.yml`：

```yaml
# pew self-hosted deployment — no Cloudflare services involved.
#
# Profiles:
#   single   default profile (set via COMPOSE_PROFILES in .env) — one rqlite node
#   cluster  three rqlite nodes joined over Raft — run with --profile cluster
#
# Usage:
#   cp .env.example .env   # COMPOSE_PROFILES=single by default
#   docker compose up -d
#   docker compose --profile cluster up -d
#
# Only `web` publishes a host port. Everything else is reachable solely on
# the compose network.

x-rqlite-common: &rqlite-common
  image: rqlite/rqlite:10.5.3
  restart: unless-stopped
  # -fk is mandatory: foreign keys are off by default in SQLite and the schema
  # relies on 12 ON DELETE CASCADE clauses.
  command: ["-fk", "-http-addr", "0.0.0.0:4001", "-raft-addr", "0.0.0.0:4002"]
  healthcheck:
    # Probe /readyz, NOT /status. /status returns HTTP 200 even when the node
    # is not part of a cluster yet (verified on 10.5.3: with -bootstrap-expect 3
    # and no peers, /status is 200 with raft.state=Follower, num_peers=0,
    # voter=false; a write then fails with HTTP 503 "leader not found").
    # /readyz returns 503 until a leader exists, so the health gate — and the
    # migrate container waiting on it — only proceed once the cluster is up.
    test: ["CMD", "wget", "-q", "-T", "2", "-O-", "http://localhost:4001/readyz"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
  networks:
    default:
      # A stable alias so every app service can keep RQLITE_URL=http://rqlite:4001
      # in BOTH profiles. In the cluster profile the real service is rqlite-1;
      # without this alias `rqlite` does not resolve (DNS_FAIL, verified).
      aliases: ["rqlite"]
  logging:
    driver: json-file
    options: { max-size: "10m", max-file: "3" }

services:
  rqlite:
    <<: *rqlite-common
    profiles: ["single"]
    command: ["-fk", "-http-addr", "0.0.0.0:4001", "-raft-addr", "0.0.0.0:4002", "-bootstrap-expect", "1"]
    volumes:
      - rqlite-data:/rqlite/file
    deploy:
      resources:
        limits: { memory: 2g }

  rqlite-1:
    <<: *rqlite-common
    profiles: ["cluster"]
    # All three nodes carry -bootstrap-expect 3 plus the same -join list, so a
    # node that starts before its peers waits as a non-voter (raft.voter=false,
    # writes return 503 "leader not found") until quorum forms. A single node
    # with -bootstrap-expect 3 and NO -join list would instead bootstrap itself
    # alone and accept writes immediately (verified) — which would let migrate
    # run against a one-node "cluster".
    command: ["-fk", "-node-id", "1", "-http-addr", "0.0.0.0:4001", "-raft-addr", "0.0.0.0:4002", "-http-adv-addr", "rqlite-1:4001", "-raft-adv-addr", "rqlite-1:4002", "-bootstrap-expect", "3", "-join", "rqlite-1:4002,rqlite-2:4002,rqlite-3:4002"]
    volumes:
      - rqlite-data-1:/rqlite/file
    deploy:
      resources:
        limits: { memory: 2g }

  rqlite-2:
    <<: *rqlite-common
    profiles: ["cluster"]
    command: ["-fk", "-node-id", "2", "-http-addr", "0.0.0.0:4001", "-raft-addr", "0.0.0.0:4002", "-http-adv-addr", "rqlite-2:4001", "-raft-adv-addr", "rqlite-2:4002", "-bootstrap-expect", "3", "-join", "rqlite-1:4002,rqlite-2:4002,rqlite-3:4002"]
    volumes:
      - rqlite-data-2:/rqlite/file
    deploy:
      resources:
        limits: { memory: 2g }

  rqlite-3:
    <<: *rqlite-common
    profiles: ["cluster"]
    command: ["-fk", "-node-id", "3", "-http-addr", "0.0.0.0:4001", "-raft-addr", "0.0.0.0:4002", "-http-adv-addr", "rqlite-3:4001", "-raft-adv-addr", "rqlite-3:4002", "-bootstrap-expect", "3", "-join", "rqlite-1:4002,rqlite-2:4002,rqlite-3:4002"]
    volumes:
      - rqlite-data-3:/rqlite/file
    deploy:
      resources:
        limits: { memory: 2g }

  # Applies migrations once, then exits. Web depends on it completing.
  migrate:
    build:
      context: ../..
      dockerfile: deploy/selfhost/Dockerfile
    image: pew-selfhost:local
    entrypoint: ["bun", "run", "deploy/selfhost/migrate-cli.ts"]
    environment:
      RQLITE_URL: http://rqlite:4001
      CF_D1_API_TOKEN: ${CF_D1_API_TOKEN}
    depends_on:
      rqlite:
        condition: service_healthy
        required: false
      rqlite-1:
        condition: service_healthy
        required: false
    restart: "no"

  d1-http:
    image: pew-selfhost:local
    command: ["bun", "run", "deploy/selfhost/server-d1-http.ts"]
    restart: unless-stopped
    environment:
      PORT: "8788"
      RQLITE_URL: http://rqlite:4001
      CF_D1_API_TOKEN: ${CF_D1_API_TOKEN}
    depends_on:
      rqlite: { condition: service_healthy, required: false }
      rqlite-1: { condition: service_healthy, required: false }
    healthcheck:
      # Read PORT from the env so a changed port does not silently break the probe.
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits: { memory: 512m }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  read:
    image: pew-selfhost:local
    command: ["bun", "run", "deploy/selfhost/server-read.ts"]
    restart: unless-stopped
    environment:
      PORT: "8787"
      RQLITE_URL: http://rqlite:4001
      # No CF_D1_API_TOKEN: this service talks to rqlite directly, and rqlite
      # has no auth. Only d1-http (verifier) and web (client) need the token.
      WORKER_READ_SECRET: ${WORKER_READ_SECRET}
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits: { memory: 512m }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  ingest:
    image: pew-selfhost:local
    command: ["bun", "run", "deploy/selfhost/server-ingest.ts"]
    restart: unless-stopped
    environment:
      PORT: "8786"
      RQLITE_URL: http://rqlite:4001
      # No CF_D1_API_TOKEN: direct rqlite access, no auth needed.
      WORKER_SECRET: ${WORKER_SECRET}
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8786)+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits: { memory: 512m }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  scheduler:
    image: pew-selfhost:local
    command: ["bun", "run", "deploy/selfhost/server-scheduler.ts"]
    restart: unless-stopped
    # No healthcheck: the scheduler exposes no HTTP port — it is only an
    # interval timer. Liveness is the removed-unref timer (it keeps the
    # process running) plus the restart policy above; a crashed scheduler
    # comes back via `restart: unless-stopped` instead of a probe.
    environment:
      RQLITE_URL: http://rqlite:4001
      # No CF_D1_API_TOKEN: direct rqlite access, no auth needed.
      WORKER_READ_SECRET: ${WORKER_READ_SECRET}
      DAILY_INTERVAL_MS: ${DAILY_INTERVAL_MS:-86400000}
    depends_on:
      migrate: { condition: service_completed_successfully }
    deploy:
      replicas: 1
      resources:
        limits: { memory: 256m }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  web:
    # web is a Next.js standalone build — the repo-root Dockerfile, not the
    # bun image the adapter services use. Building it here is required: this
    # branch carries auth.ts and other web changes that the upstream image
    # does not have.
    build:
      context: ../..
      dockerfile: Dockerfile
    image: pew:standalone
    restart: unless-stopped
    environment:
      PORT: "7020"
      HOSTNAME: "0.0.0.0"
      NEXTAUTH_URL: ${NEXTAUTH_URL}
      AUTH_SECRET: ${AUTH_SECRET}
      AUTH_GOOGLE_ID: ${AUTH_GOOGLE_ID}
      AUTH_GOOGLE_SECRET: ${AUTH_GOOGLE_SECRET}
      ADMIN_EMAILS: ${ADMIN_EMAILS}
      # Intranet http deployments must be able to turn __Secure- cookies off
      # (spec §11 / §4.4); absent this the browser drops the session cookie.
      USE_SECURE_COOKIES: ${USE_SECURE_COOKIES:-true}
      # CLI login callback + resolveHost (spec §4.5/§11).
      PEW_HOST: ${PEW_HOST:-}
      # Read path: worker-read
      WORKER_READ_URL: ${WORKER_READ_URL:-http://read:8787}
      WORKER_READ_SECRET: ${WORKER_READ_SECRET}
      # Ingest path: worker
      WORKER_INGEST_URL: ${WORKER_INGEST_URL:-http://ingest:8786}
      WORKER_SECRET: ${WORKER_SECRET}
      # Write path: d1-http. CF_* IDs only need to be non-empty now that
      # D1_BASE_URL takes precedence in lib/d1.ts.
      D1_BASE_URL: ${D1_BASE_URL:-http://d1-http:8788}
      CF_ACCOUNT_ID: selfhost
      CF_D1_DATABASE_ID: selfhost
      CF_D1_API_TOKEN: ${CF_D1_API_TOKEN}
      # Optional: team/org logo upload (lib/r2.ts throws without these).
      CF_R2_ENDPOINT: ${CF_R2_ENDPOINT:-}
      CF_R2_ACCESS_KEY_ID: ${CF_R2_ACCESS_KEY_ID:-}
      CF_R2_SECRET_ACCESS_KEY: ${CF_R2_SECRET_ACCESS_KEY:-}
      CF_R2_BUCKET: ${CF_R2_BUCKET:-}
    ports:
      - "${WEB_PORT:-7020}:7020"
    depends_on:
      read: { condition: service_healthy }
      ingest: { condition: service_healthy }
      d1-http: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7020/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    deploy:
      resources:
        limits: { memory: 1g }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  rqlite-data:
  rqlite-data-1:
  rqlite-data-2:
  rqlite-data-3:
```

创建 `deploy/selfhost/migrate-cli.ts`：

```typescript
/**
 * One-shot migration runner used by the `migrate` compose service.
 *
 * Waits for rqlite to accept writes, applies every pending migration, then
 * exits 0 so dependent services can start.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Adapter } from "./d1-adapter";
import { createRqliteDdlExecutor } from "./rqlite-client";
import { applyMigrations } from "./migrate";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/migrations");
const SQUASHED = new Set(["004-is-public.sql", "006-device-id.sql", "006c-team-logo-url.sql"]);
const BASE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";

async function waitForRqlite(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Probe /readyz, not /status. In the cluster profile rqlite-1 is started
      // with -bootstrap-expect 3 and a full -join list; /status returns HTTP
      // 200 while it is still waiting for quorum (verified on 10.5.3), so a
      // /status probe would let migrate run before a leader exists and fail.
      // /readyz only turns 200 once a leader is up. /readyz is also right for
      // the single profile (-bootstrap-expect 1 elects immediately).
      const res = await fetch(`${BASE_URL}/readyz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`rqlite at ${BASE_URL} did not become ready`);
}

async function main(): Promise<void> {
  await waitForRqlite();
  const db = createD1Adapter({ baseUrl: BASE_URL, token: process.env.CF_D1_API_TOKEN ?? "" });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl: BASE_URL });
  const result = await applyMigrations({
    db,
    dir: MIGRATIONS_DIR,
    ddlExecutor,
    readDir: async (dir) => {
      const { readdir } = await import("node:fs/promises");
      return (await readdir(dir)).filter((f) => f.endsWith(".sql") && !SQUASHED.has(f));
    },
    log: console.log,
  });
  console.log(`migrations done: applied ${result.applied.length}, skipped ${result.skipped.length}`);
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
```

创建 `deploy/selfhost/.env.example`：

```bash
# Copy to .env and fill in. Never commit the real .env.

# --- Auth.js ---
# Generate: openssl rand -base64 32
AUTH_SECRET=replace-me
# Public base URL of this deployment. Must match how browsers reach it,
# including the scheme (http:// on an intranet).
NEXTAUTH_URL=http://localhost:7020
# Comma-separated admin emails. In THIS plan (Plan 1) there is no /setup
# wizard yet, so this is the only way to have an admin — set it to a real
# address before first use. (Plan 2 adds "first registered user is admin".)
ADMIN_EMAILS=you@example.com

# --- Google OAuth (optional) ---
# Leave blank to hide the Google button. NOTE: Google rejects http:// callback
# URLs, so on a plain-http intranet this cannot be used — email+password
# (Plan 2) is the supported login there.
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# --- Shared secrets between services ---
# Generate each with: openssl rand -hex 32
CF_D1_API_TOKEN=replace-me
WORKER_READ_SECRET=replace-me
WORKER_SECRET=replace-me

# --- Host port for the web UI ---
WEB_PORT=7020

# --- Deployment profile ---------------------------------------------------
# Compose reads this from ./.env, so `docker compose up -d` needs no --profile.
# `single` is one rqlite node; `cluster` is three Raft-joined nodes.
COMPOSE_PROFILES=single

# --- Cookie security ------------------------------------------------------
# NOTE: this switch only takes effect once the auth.ts branch that reads it
# lands (Plan 2). Until then the Next standalone server's NODE_ENV=production
# still forces __Secure- cookies. Kept here so the value is in place.
# Set true only when NEXTAUTH_URL is https.
USE_SECURE_COOKIES=false

# --- CLI / worker wiring --------------------------------------------------
# Host the CLI should point at (scheme + host + port), used by `pew ... --host`.
PEW_HOST=http://localhost:7020
# Read / write / ingest endpoints the web container talks to on the compose
# network. Change only if you rename the services.
WORKER_READ_URL=http://read:8787
WORKER_INGEST_URL=http://ingest:8786
D1_BASE_URL=http://d1-http:8788

# --- Object storage (optional; team/org logos) ---------------------------
# lib/r2.ts throws when these are missing, so logo upload returns 500 unless
# set. Point them at any S3-compatible store (e.g. MinIO).
# CF_R2_ENDPOINT=
# CF_R2_ACCESS_KEY_ID=
# CF_R2_SECRET_ACCESS_KEY=
# CF_R2_BUCKET=

# --- Optional ---
# Daily pricing sync interval in ms (default 24h). Passed to the scheduler.
DAILY_INTERVAL_MS=86400000
```

> 说明：`CF_ACCOUNT_ID` / `CF_D1_DATABASE_ID` 在 compose 里已硬编码为占位串 `selfhost`（写路径走 `D1_BASE_URL`，这两个值只需非空），不放进 `.env.example`。`PEW_LOCAL_D1_URL` 是测试专用变量，生产部署不设置。

创建 `deploy/selfhost/README.md`：

```markdown
# pew 私有化部署

不依赖任何 Cloudflare 服务。数据存在 rqlite，两个 Worker 跑在 Node 进程里。

## 快速开始

```bash
cd deploy/selfhost
cp .env.example .env
# 编辑 .env：至少填 AUTH_SECRET、NEXTAUTH_URL、三个密钥
# .env 里 COMPOSE_PROFILES=single（默认），等价于 --profile single
docker compose up -d --build
```

首次启动后访问 `http://<host>:7020`。

## 架构

| 容器 | 作用 |
|---|---|
| `rqlite` | 数据库（Raft 复制，单节点默认） |
| `migrate` | 一次性迁移执行器，跑完退出 |
| `d1-http` | 把 D1 REST 形状翻译成 rqlite 调用 |
| `read` | worker-read（读路径 + `/api/live`） |
| `ingest` | worker（写入路径） |
| `scheduler` | 定价同步定时器（固定 1 副本） |
| `web` | Next.js 前端，唯一对外端口 |

只有 `web` 发布宿主端口，其余仅在 compose 网络内可达。

## 集群模式

```bash
docker compose --profile cluster up -d --build
```

三个 rqlite 节点通过 Raft 复制。**同机三容器只防进程故障，不防磁盘/主机故障**；跨机部署请把 compose 分发到三台机器并调整 `-join` 地址。

**单节点在线扩容为 3 节点已验证可行**：向已运行的单节点 `-bootstrap-expect 1` 直接
`-join <单节点>:4002`（join 节点**不要**带 `-bootstrap-expect`）即可，实测 3 节点全部
voter/reachable，且新节点能读到扩容前写入的数据。若要走 compose 集群 profile，先
`.env` 里改 `COMPOSE_PROFILES=cluster`，再 `docker compose up -d`。

## 扩展（scale）

- **可水平扩展**：`read`、`ingest`（无状态，缓存共享在 rqlite 的 `kv_cache` 表里）——
  `docker compose up -d --scale read=2 --scale ingest=2`。
- **单副本，勿扩展**：`web`（绑定固定宿主端口 `${WEB_PORT}`，多副本端口冲突；需要多副本时
  前置反代 + 负载均衡）、`scheduler`（定时器，多副本会重复触发定价同步）、`rqlite-*`
  （Raft 节点数由 profile 决定，不走 `--scale`）。
- 多 web 副本时登录限速（进程内 `inMemoryRateLimiter`）会退化为按副本计，见 spec §7 风险表。

## 安全注意事项

- **rqlite 默认无鉴权**（实测 `/status` 返回 `http.auth = disabled`）：compose 网络内任何容器都可
  无凭据直连数据库读写。**当前方案只做了「网络隔离」这一层**：rqlite 不发布宿主端口、仅 compose
  网络内可达。规格 §4.1 专项三提到的另一层（给 rqlite 配 `-http-auth`）**本计划未做**——因为
  read/ingest/scheduler 三个容器是**直连 rqlite** 的（不走 d1-http），一旦给 rqlite 加鉴权，
  这三个服务也要同步带 token。若生产要求该层，需一并改造，列为后续强化项。
- **`CF_D1_API_TOKEN` 只保护 web → d1-http 这一跳**。read/ingest/scheduler 直连 rqlite，不需要
  这个 token，因此 compose **只把它下发给 `migrate`、`d1-http`、`web`**（`d1-http` 是校验方、
  `web` 是客户端、`migrate` 建表初始化）；`read`/`ingest`/`scheduler` 的 `environment` 不含它，
  收窄了密钥在容器内的暴露面。
- 真实密钥只写在 `deploy/selfhost/.env`（被 `.gitignore` 的 `.env` 规则覆盖，不入库、不进镜像：
  `.dockerignore` 也含 `.env`）；构建与 compose 里出现的 `CF_ACCOUNT_ID`/`CF_D1_DATABASE_ID`
  是占位串，不是凭据。

## 数据库行为（重要）

- **迁移 DDL 带 `?norwtime&norwrandom`，迁移 DML 不带**。这是为了在集群下保持各副本一致：DDL 里的
  `datetime('now')` 与 `randomblob()` 若被 rqlite 改写成常量，会静默禁用 12 个排行榜触发器；而
  DML（如 029 的种子 `INSERT`）必须**不带** norw——带 norw 时各副本独立求值会**分叉**（实测两副本得到
  不同 randomblob），不带时 rqlite 把它改写成字面量再复制，各副本一致。详见 Task 5 的 `isDdlStatement`。
- 排行榜 revision 用计数器（`leaderboard_revision_seq`）而非随机数，保证副本间收敛。
- 读一律 `?level=weak`。rqlite 会把 weak 读转发给 leader，因此读一致性等价强一致；`none` 会读到陈旧数据，禁止使用。

## 验证

```bash
bun run test                                    # 单元测试
bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001
```

## 备份

rqlite 的 CLI **没有** `backup` 子命令；备份是交互式 REPL 里的 `.backup` 点命令。
直接 `cp` 活跃的数据库文件会拿到损坏的副本，不要那样做。

```bash
# 单节点
printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T rqlite rqlite -H localhost
docker compose cp rqlite:/rqlite/file/backup.db "./backup-$(date +%F).db"

# 集群模式（节点名是 rqlite-1）
printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T rqlite-1 rqlite -H localhost
docker compose cp rqlite-1:/rqlite/file/backup.db "./backup-$(date +%F).db"
```

产物是标准 SQLite 文件（已实测：`SQLite format 3` 魔数、含全部表与 `kv_cache`）。

**恢复（必须用 `.restore` 点命令，不能换文件）**：实测直接替换数据文件无效——实际数据文件在
`/rqlite/file/data/db.sqlite`（不是 `pew.db`），且 rqlite 启动时会用 `raft.db` 重放日志，
备份后的写入会「复活」；清空整个卷再放文件则走 bootstrap 忽略预置文件。`.restore` 走 REPL、
经 Raft 正常应用（已实测：恢复后备份后的写入行消失，只剩备份时点的数据）。

```bash
# 1. 停应用（读写都停，避免恢复期间写入）
docker compose stop web read ingest scheduler
# 2. 把备份放进 rqlite 容器（rqlite 保持运行，.restore 不需要停它）
docker compose cp "./backup-2026-10-11.db" rqlite:/rqlite/file/restore.db
# 3. 用点命令恢复（经 Raft 应用，单节点/集群同一路径）
printf '.restore /rqlite/file/restore.db\n.exit\n' | docker compose exec -T rqlite rqlite -H localhost
# Expected: Database restored successfully
# 4. 起应用并验证
docker compose start web read ingest scheduler
docker compose exec web node -e "fetch('http://127.0.0.1:7020/api/live').then(r=>r.json()).then(console.log)"
```
```

- [ ] **Step 5: 构建并启动**

```bash
cd deploy/selfhost
cp .env.example .env
# 5. 用真实值替换四个 replace-me、NEXTAUTH_URL 与 ADMIN_EMAILS
sed -i '' "s|AUTH_SECRET=replace-me|AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i '' "s|CF_D1_API_TOKEN=replace-me|CF_D1_API_TOKEN=$(openssl rand -hex 32)|" .env
sed -i '' "s|WORKER_READ_SECRET=replace-me|WORKER_READ_SECRET=$(openssl rand -hex 32)|" .env
sed -i '' "s|WORKER_SECRET=replace-me|WORKER_SECRET=$(openssl rand -hex 32)|" .env
sed -i '' "s|ADMIN_EMAILS=you@example.com|ADMIN_EMAILS=$(whoami)@localhost|" .env
# web 用仓库根 Dockerfile（Next standalone），其余适配层服务用 bun 镜像
docker compose build web
docker compose up -d   # .env 里 COMPOSE_PROFILES=single 即默认单节点
docker compose ps
```

Expected: `rqlite`、`d1-http`、`read`、`ingest`、`web` 显示 `healthy`；`migrate` 显示 `exited (0)`。

- [ ] **Step 6: 端到端验证**

> rqlite **不发布宿主端口**，所以 1–6 步经 d1-http 或容器内执行验证，不打 `127.0.0.1:14001`。

```bash
# 1. 迁移账本已写入（经 d1-http 的只读路径）
docker compose exec web node -e "
fetch('http://d1-http:8788/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CF_D1_API_TOKEN },
  body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM _migrations', params: [] }),
}).then(r=>r.json()).then(b=>{ console.log(JSON.stringify(b.result[0].results)); process.exit(b.success?0:1); });
"
# Expected: [[32]]（33 个上游 .sql 去掉 3 个 squash 的，加 030、031）

# 2. web 健康检查
curl -s http://127.0.0.1:7020/api/live
# Expected: {"status":"ok",...}

# 3. read 容器健康检查
docker compose exec web node -e "fetch('http://read:8787/api/live').then(r=>r.json()).then(console.log)"
# Expected: {"status":"ok",...}

# 4. 触发器是确定性版本（不是 randomblob）——经 d1-http 读 sqlite_master
docker compose exec web node -e "
fetch('http://d1-http:8788/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CF_D1_API_TOKEN },
  body: JSON.stringify({ sql: \"SELECT sql FROM sqlite_master WHERE name = 'leaderboard_user_insert'\", params: [] }),
}).then(r=>r.json()).then(b=>{ const n = (b.result[0].results[0].sql.match(/randomblob/g)||[]).length; console.log('randomblob count:', n); process.exit(n===0?0:1); });
"
# Expected: randomblob count: 0

# 5. 写路径可用：经 d1-http 打一条单语句 INSERT（这正是 web 的 execute() 走的路）
#    若 d1-http 把单语句送去 /db/query，这里会返回 success:false
#    "attempt to change database via query operation"。
docker compose exec web node -e "
fetch('http://d1-http:8788/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CF_D1_API_TOKEN },
  body: JSON.stringify({ sql: \"INSERT INTO app_settings (key, value) VALUES ('smoke2','2') ON CONFLICT (key) DO UPDATE SET value = excluded.value\", params: [] }),
}).then(r => r.json()).then(b => { console.log(JSON.stringify(b)); process.exit(b.success && b.result[0].meta.changes === 1 ? 0 : 1); });
"
# Expected: {"success":true,...,"meta":{"changes":1,...}}，exit 0

# 6. 回读刚写入的行
docker compose exec web node -e "
fetch('http://d1-http:8788/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CF_D1_API_TOKEN },
  body: JSON.stringify({ sql: 'SELECT value FROM app_settings WHERE key = \\'smoke2\\'', params: [] }),
}).then(r=>r.json()).then(b=>{ console.log(JSON.stringify(b.result[0].results)); process.exit(b.success?0:1); });
"
# Expected: [["2"]]
```

- [ ] **Step 7: 提交**

```bash
git add deploy/selfhost/
git commit -m "feat: add self-hosted compose stack and service entry points

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: 上游同步回归

**Files:**
- Modify: `deploy/selfhost/README.md`（追加「合并上游」小节）

**Interfaces:**
- Consumes: Tasks 1–9 的全部产物
- Produces: 一份可重复执行的回归清单

**为什么单列**：spec 成功标准 4 是「上游代码保持可同步」。这是唯一验证该标准的任务。

- [ ] **Step 1: 跑全量单元测试**

```bash
bun run test
```

Expected: 全部通过。**若失败**，先判断是本方案引入还是上游既有失败：`git stash && bun run test && git stash pop` 对比。既有失败记录下来，不要在本计划里修。

- [ ] **Step 2: 跑类型检查与 lint**

```bash
bun run typecheck
bun run lint
```

Expected: 通过。`deploy/selfhost/` 不在 workspace 内，若被 lint 扫到报错，在 `biome.json` 里排除——**但这是改上游文件，需先确认是否真的必要**（`biome.json` 在 spec 的「刻意不改」清单里）。若确需排除，记录到 spec §4.7 并说明原因。

- [ ] **Step 3: 合并上游并验证**

```bash
git remote -v | grep upstream || git remote add upstream https://github.com/nocoo/pew.git
git fetch upstream main
git log --oneline HEAD..upstream/main | head
git merge upstream/main
# 解决冲突（预期只在 lib/d1.ts 与 vitest.config.ts 两处）
bun run test
docker compose -f deploy/selfhost/docker-compose.yml up -d --build
curl -s http://127.0.0.1:7020/api/live
docker compose -f deploy/selfhost/docker-compose.yml down
```

Expected: 合并无冲突（或仅 `lib/d1.ts`、`vitest.config.ts` 冲突且易解），测试通过，健康检查返回 ok。

- [ ] **Step 4: 把回归清单写进 README**

在 `deploy/selfhost/README.md` 追加：

```markdown
## 合并上游

**本分支与上游的接触面只有两处**：`packages/web/src/lib/d1.ts`（新增 `D1_BASE_URL` 优先级）与
`vitest.config.ts`（`test.include` 增加 `deploy/**/*.test.ts`）。`packages/worker/**` 与
`packages/worker-read/**` 完全未改。

> 注意：这是 **Plan 1 的**接触面。Plan 2（认证子系统）还会改 `auth.ts`、`lib/admin.ts`、
> `proxy.ts` 等（见 spec §4.7 的 12 处清单）；合并回归时按 Plan 2 的清单重新确认。

```bash
git fetch upstream main
git merge upstream/main
bun run test
docker compose build web && docker compose up -d
curl -s http://127.0.0.1:7020/api/live
```

若上游改动触及 `lib/d1.ts` 的构造函数，重新确认 `D1_BASE_URL` 的优先级仍在
`localD1BaseUrl` 之前；若上游改到 `vitest.config.ts` 的 `include`，确认 `deploy/**/*.test.ts`
仍被收集。

新增上游迁移后，重跑 `verify-migrations.ts` 并更新其 `EXPECTED` 计数。
```

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/README.md
git commit -m "docs: document upstream merge regression procedure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 交付边界

本计划完成后，pew 可在内网运行、数据存 rqlite、可单节点或三节点部署。

> **关于登录**：本计划**不提供可用的交互式登录**。Google OAuth 不接受内网 http 回调（spec §2），
> 邮箱+密码在 Plan 2。因此 Plan 1 交付的是「数据层与运行时可用、API 可经 CLI/密钥调用」，
> 而不是「浏览器可登录的完整产品」——完整可用性以 Plan 2 完成为准。

**不在本计划内**（Plan 2，认证子系统）：

- 邮箱 + 密码 Credentials provider（`auth.ts`、`login/page.tsx`）
- `/setup` 注册向导与 `instance_setup` 首次认领
- `is_admin` 列与 `lib/admin.ts` 判定扩展
- `USE_SECURE_COOKIES=false` 显式关闭分支（内网 HTTP 部署必需）
- 密码重置（管理员发起令牌 + `reset-password` 破窗脚本）
- CLI `--host` / `PEW_HOST` 与凭据按 host 隔离
- 生产 INSERT 的时间列补写（`auth-adapter.ts` 等，多节点确定性）

**Plan 2 的前置**：本计划的 Task 1–10 必须全部完成并通过验证（Task 11 是回归流程，可并行）。
