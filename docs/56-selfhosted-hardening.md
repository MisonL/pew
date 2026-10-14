# pew 自建部署加固（Plan 3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：已交付（任务全部实现并验证）。**Goal:** 在不破坏现有部署的前提下交付三项独立强化：A rqlite 鉴权层（默认关闭）、B 登录限速外置到 rqlite（默认关闭）、C 反代/TLS 部署文档。

**Architecture:** A 用「无条件 bind-mount + entrypoint 包装脚本按文件存在性追加 `-auth`」实现零破坏开关；客户端凭据经 `d1-adapter` → `d1-http` 双层透传为 Basic 头。B 用单条原子 `INSERT...SELECT`（SQL 侧窗口运算）以 `meta.changes` 分支判定放行/拒绝，执行异常 fail-open。C 是纯文档 + 两个 compose 扩展文件。

**Tech Stack:** rqlite 10.5.3、Bun、Next.js/Auth.js（v5）、docker compose（`!override` 需 ≥ v2.24.4）、vitest（deploy/selfhost 与 packages/web 两套）。

**Spec:** `docs/55-selfhosted-hardening-design.md`（v3，f84e5f45）——本计划从它论证，执行者须同时读两者。

## Global Constraints

- 分支 `feat/self-hosted-deployment`；**不推上游** nocoo/pew。
- 每个提交信息以 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 结尾。
- pre-commit 门禁 = 全量 L1（4580 测试 + 95% 覆盖率 ×4 + tsc + biome）。已知 flake：`scripts/__tests__/(e2e-utils|local-e2e-bindings)` 高负载下启动超时/EADDRINUSE；用 `.git/commit-retry.sh <attempts> <message-file>` 重试（只对这两个文件重试，其他失败中止）。提交前若 17020/27020 端口被占（残留 next-server），先 `lsof -ti tcp:<port> | xargs kill`。
- 开关名全文唯一：`LOGIN_RATE_LIMIT_BACKEND`（不是 `RATE_LIMIT_BACKEND`）。
- 迁移 DDL 带 `?norwtime&norwrandom`、DML 不带（副本一致性，既有约定）。
- 凭据不得进任何 error message / 日志输出。
- 镜像运行 `NODE_ENV=production`（web 侧 secure cookie 默认真，`.env.example` 默认 `USE_SECURE_COOKIES=false` 显式覆盖）。
- 真机验证统一用 `rqlite/rqlite:10.5.3`；实验容器用完即删。

## Review Focus

规格暗示但无单测覆盖、最可能咬到部署者的五类输入（每行已落到所属任务的测试步骤）：

1. **`.env` 填了一半凭据**（只有用户名没密码）→ 渲染脚本必须报错退出且删残留，不得产出半残 auth.json → Task 4 Step 1 测试矩阵。
2. **先 `up` 后 render**（auth.json 不存在时 up）→ rqlite 以无鉴权静默启动 → migrate 对账自检必须显式报错 → Task 6 Step 1 测试 + Task 8 真机项 5。
3. **反代漏配 XFF** → 所有请求落 `login:ip:unknown` 共享桶，打满即全员登录 DoS → README 硬约束 + Task 12 README 步骤明确注明。
4. **IPv6 客户端**（隐私扩展每连接换地址）→ IP 键必须 /64 前缀归并，否则限速失效 → Task 10 Step 1 测试。
5. **rqlite 写超时但读正常**（攻击或网络抖动）→ 限速必须放行并 warn，不得误判为超限拒绝 → Task 10 Step 1 异常分支测试。

---

## Task 1: d1-adapter Basic 鉴权支持

**Files:**
- Modify: `deploy/selfhost/d1-adapter.ts`（`D1AdapterOptions` 与 `createD1Adapter` 头部构造）
- Test: `deploy/selfhost/d1-adapter.test.ts`

**Interfaces:**
- Consumes: 现有 `createD1Adapter(options: D1AdapterOptions)`。
- Produces: `D1AdapterOptions` 增加 `basicAuth?: { username: string; password: string }`。规则：设了 `basicAuth` → 所有请求带 `Authorization: Basic base64(user:pass)`；未设且 `token` 非空 → 现状 Bearer；两者都未设（token 为空）→ **不发任何 Authorization 头**（Task 3 的 verify/reset 依赖此行为）。后续 Task 2/3/6 依赖此签名。

- [ ] **Step 1: 写失败测试**（追加到 `deploy/selfhost/d1-adapter.test.ts`）

```ts
describe("basic auth", () => {
  const capture = () => {
    const calls: { headers: Record<string, string> }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return Response.json({ results: [{}] });
    };
    return { calls, fetchImpl };
  };

  it("sends Basic when basicAuth is set (overrides Bearer)", async () => {
    const { calls, fetchImpl } = capture();
    const db = createD1Adapter({
      baseUrl: "http://x", token: "tok",
      basicAuth: { username: "pew", password: "s:ecret" },
      fetchImpl,
    });
    await db.prepare("SELECT 1").all();
    const expected = `Basic ${Buffer.from("pew:s:ecret").toString("base64")}`;
    expect(calls[0]?.headers.Authorization).toBe(expected);
  });

  it("keeps Bearer when only token is set (existing behaviour)", async () => {
    const { calls, fetchImpl } = capture();
    const db = createD1Adapter({ baseUrl: "http://x", token: "tok", fetchImpl });
    await db.prepare("SELECT 1").all();
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
  });

  it("sends NO Authorization header when token is empty and basicAuth unset", async () => {
    const { calls, fetchImpl } = capture();
    const db = createD1Adapter({ baseUrl: "http://x", token: "", fetchImpl });
    await db.prepare("SELECT 1").all();
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("never includes the header value in an error message", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const db = createD1Adapter({
      baseUrl: "http://x", token: "",
      basicAuth: { username: "pew", password: "supersecret" }, fetchImpl,
    });
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(/401/);
    await expect(db.prepare("SELECT 1").all()).rejects.not.toThrow(/supersecret/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Volumes/Work/orca/pew && bun test deploy/selfhost/d1-adapter.test.ts`
Expected: FAIL — `basicAuth` 不在类型里（TS 报错）或 Authorization 值不符。

- [ ] **Step 3: 最小实现**（`d1-adapter.ts`）

```ts
export interface D1AdapterOptions {
  baseUrl: string;
  token: string;
  /** rqlite -auth credentials. When set, replaces the Bearer token header. */
  basicAuth?: { username: string; password: string };
  fetchImpl?: typeof fetch;
}
```

`createD1Adapter` 内替换 headers 构造：

```ts
  const authorization = options.basicAuth
    ? `Basic ${Buffer.from(
        `${options.basicAuth.username}:${options.basicAuth.password}`
      ).toString("base64")}`
    : options.token
      ? `Bearer ${options.token}`
      : undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(authorization ? { Authorization: authorization } : {}),
  };
```

（错误路径不变——现有 `assertNoError`/HTTP 错误只透出 body.error 或状态码，不含 headers，天然满足"凭据不进错误信息"。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test deploy/selfhost/d1-adapter.test.ts`
Expected: PASS（含原有用例，无回归）。

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/d1-adapter.ts deploy/selfhost/d1-adapter.test.ts
git commit -m "feat: basic-auth support in d1-adapter (spec Plan 3 §3.1.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

（若门禁遇已知 e2e flake，用 `.git/commit-retry.sh 4 <msgfile>`；下同。）

---

## Task 2: d1-http 双层透传 + 健康探针改带凭据 SELECT 1

**Files:**
- Modify: `deploy/selfhost/d1-http.ts`（`D1HttpOptions` 透传）、`deploy/selfhost/server-d1-http.ts`（探针，`:47` 附近）
- Test: `deploy/selfhost/d1-http.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `basicAuth`。
- Produces: `D1HttpOptions.basicAuth?: { username: string; password: string }`，透传给内部 `createD1Adapter`。Task 6 的 compose 接线依赖：`server-d1-http.ts` 从 `RQLITE_USERNAME/RQLITE_PASSWORD` 构造。

- [ ] **Step 1: 写失败测试**（追加到 `d1-http.test.ts`）

```ts
describe("basicAuth passthrough", () => {
  it("forwards basicAuth to the inner adapter", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(new Request(input as string, init));
      return Response.json({ results: [{}] });
    };
    const server = createD1HttpServer({
      baseUrl: "http://x", token: "tok",
      basicAuth: { username: "pew", password: "pw" },
      fetchImpl,
    });
    const res = await server.handle(new Request("http://localhost/query", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    }));
    expect(res.status).toBe(200);
    const expected = `Basic ${Buffer.from("pew:pw").toString("base64")}`;
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(expected);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `bun test deploy/selfhost/d1-http.test.ts`
Expected: FAIL（类型缺 `basicAuth`）。

- [ ] **Step 3: 实现**

`d1-http.ts`：

```ts
export interface D1HttpOptions {
  baseUrl: string;
  token: string;
  /** rqlite -auth credentials, forwarded to the inner d1 adapter. */
  basicAuth?: { username: string; password: string };
  fetchImpl?: typeof fetch;
}
// createD1HttpServer 内：
  const db: D1Like = createD1Adapter({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.basicAuth ? { basicAuth: options.basicAuth } : {}),
    fetchImpl: options.fetchImpl,
  });
```

`server-d1-http.ts`（构造处 + 探针）：

```ts
const BASIC = process.env.RQLITE_USERNAME && process.env.RQLITE_PASSWORD
  ? { username: process.env.RQLITE_USERNAME, password: process.env.RQLITE_PASSWORD }
  : undefined;
const server = createD1HttpServer({ baseUrl: RQLITE_URL, token: TOKEN, ...(BASIC ? { basicAuth: BASIC } : {}) });
```

探针（`/health` 处理器，替换匿名 `/readyz` fetch）：

```ts
        // Credentialed probe on the SAME linearizable path as writes. The old
        // anonymous /readyz probe stayed green when credentials were wrong
        // (the '*' user grants ready), so web only failed at first write.
        const authHeader = BASIC
          ? { Authorization: `Basic ${Buffer.from(`${BASIC.username}:${BASIC.password}`).toString("base64")}` }
          : {};
        const probe = await fetch(`${RQLITE_URL}/db/request?transaction=true&associative`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify([["SELECT 1"]]),
        });
        const probeBody = (await probe.json()) as { results?: { error?: string }[] };
        if (!probe.ok || probeBody.results?.[0]?.error) throw new Error("db probe failed");
```

- [ ] **Step 4: 确认通过** — `bun test deploy/selfhost/d1-http.test.ts && bun test deploy/selfhost/server-d1-http* 2>/dev/null || bun test deploy/selfhost/`，PASS 无回归。

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/d1-http.ts deploy/selfhost/d1-http.test.ts deploy/selfhost/server-d1-http.ts
git commit -m "feat: d1-http basicAuth passthrough + credentialed health probe (spec §3.1.3/§3.1.4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: rqlite-client 透传 + migrate 对账自检 + verify/reset 可选凭据

**Files:**
- Modify: `deploy/selfhost/rqlite-client.ts`、`deploy/selfhost/migrate-cli.ts`、`deploy/selfhost/verify-migrations.ts`、`deploy/selfhost/reset-password.ts`
- Test: `deploy/selfhost/rqlite-client.test.ts`、`deploy/selfhost/reset-password.test.ts`、新 `deploy/selfhost/auth-reconcile.test.ts`

**Interfaces:**
- Consumes: Task 1 的 adapter 规则（token 空且无 basicAuth → 不发头）。
- Produces: `createRqliteDdlExecutor({ baseUrl, basicAuth? })`；`migrate-cli` 在凭据模式下先跑对账自检（导出 `assertAuthReconciled(fetchImpl, baseUrl, expectAuth: boolean)` 供测试）。

- [ ] **Step 1: 写失败测试**（新文件 `deploy/selfhost/auth-reconcile.test.ts`）

```ts
import { describe, expect, it, vi } from "vitest";
import { assertAuthReconciled } from "./migrate-cli";

const URL = "http://rqlite:4001";

function stub(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("assertAuthReconciled (expectAuth=true)", () => {
  it("passes when /status shows auth enabled and anonymous query is 401", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(401, { error: "unauthorized" }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true)).resolves.toBeUndefined();
  });

  it("fails when auth is disabled (credentials configured but server open)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "disabled" } }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true))
      .rejects.toThrow(/credentials configured but auth is disabled/);
  });

  it("fails when anonymous query succeeds (200 instead of 401)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(200, { results: [{ rows: [] }] }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true))
      .rejects.toThrow(/anonymous query succeeded/);
  });

  it("is a no-op when expectAuth is false", async () => {
    const f = vi.fn();
    await expect(assertAuthReconciled(f as typeof fetch, URL, false)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 确认失败** — `bun test deploy/selfhost/auth-reconcile.test.ts`，Expected: FAIL（导出不存在）。

- [ ] **Step 3: 实现自检**（`migrate-cli.ts`）

```ts
/**
 * Reconciliation probe (spec §3.1.4): rqlite IGNORES every Authorization
 * header when started without -auth (verified), so a fully-configured client
 * would silently run unauthenticated. Guards against config mistakes only —
 * NOT a security boundary (in-network spoofing is out of scope).
 */
export async function assertAuthReconciled(
  fetchImpl: typeof fetch,
  baseUrl: string,
  expectAuth: boolean
): Promise<void> {
  if (!expectAuth) return;
  const status = await fetchImpl(`${baseUrl}/status`);
  const body = (await status.json()) as { http?: { auth?: string } };
  if (status.ok && body.http?.auth !== "enabled") {
    throw new Error(
      "auth reconciliation failed: credentials configured but auth is disabled on the server"
    );
  }
  // '*' grants status/ready to everyone; data endpoints must still 401.
  const probe = await fetchImpl(`${baseUrl}/db/query?q=${encodeURIComponent("SELECT 1")}`);
  if (probe.ok) {
    throw new Error("auth reconciliation failed: anonymous query succeeded (auth misconfigured)");
  }
}
```

`main()` 里在 `applyMigrations` 之前：

```ts
  const expectAuth = Boolean(process.env.RQLITE_USERNAME && process.env.RQLITE_PASSWORD);
  await assertAuthReconciled(fetch, BASE_URL, expectAuth);
```

并把 adapter 构造改为（凭据模式 Basic，否则无头——`CF_D1_API_TOKEN` 不再兜底成 Bearer）：

```ts
  const basicAuth = process.env.RQLITE_USERNAME && process.env.RQLITE_PASSWORD
    ? { username: process.env.RQLITE_USERNAME, password: process.env.RQLITE_PASSWORD }
    : undefined;
  const db = createD1Adapter({ baseUrl: BASE_URL, token: "", ...(basicAuth ? { basicAuth } : {}) });
  const ddlExecutor = createRqliteDdlExecutor({ baseUrl: BASE_URL, ...(basicAuth ? { basicAuth } : {}) });
```

- [ ] **Step 4: rqlite-client 同样加 `basicAuth?`**（模式同 Task 1：设了发 Basic；**删除**现有对空 token 的 Bearer 兜底，未设不发头）。`verify-migrations.ts` 与 `reset-password.ts` 的构造改为 `token: ""` + 可选 `basicAuth`（从 `RQLITE_USERNAME/RQLITE_PASSWORD` 读，未设则两键都缺省）。测试：在 `rqlite-client.test.ts` 与 `reset-password.test.ts` 各加一个「未设凭据 → 不发 Authorization」用例（模式抄 Task 1 Step 1 第三个用例）。

- [ ] **Step 5: 确认通过** — `bun test deploy/selfhost/`，Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add deploy/selfhost/rqlite-client.ts deploy/selfhost/rqlite-client.test.ts deploy/selfhost/migrate-cli.ts deploy/selfhost/auth-reconcile.test.ts deploy/selfhost/verify-migrations.ts deploy/selfhost/reset-password.ts deploy/selfhost/reset-password.test.ts
git commit -m "feat: auth reconciliation self-check + optional credentials in ops scripts (spec §3.1.3/§3.1.4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: 渲染脚本 + entrypoint 包装脚本

**Files:**
- Create: `deploy/selfhost/render-rqlite-auth.sh`、`deploy/selfhost/rqlite-entrypoint.sh`
- Test: 新 `deploy/selfhost/render-auth.test.ts`（对脚本做黑盒矩阵测试）

**Interfaces:**
- Produces: `render-rqlite-auth.sh`（读 `RQLITE_USERNAME/RQLITE_PASSWORD/RQLITE_JOIN_PASSWORD`，产出/删除 `deploy/selfhost/.rqlite-auth.json`，含 pew 全权、pew-ro 只读 `["select"]`、joiner `[join]`、`*` `[status,ready]` 四条目）；`rqlite-entrypoint.sh`（spec §3.1.2 原文照抄）。Task 5 的 compose 挂载这两个文件；Task 8 真机验证依赖其行为。

- [ ] **Step 1: 写失败测试**（`render-auth.test.ts`，用 `Bun.spawn` 跑脚本）

```ts
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "render-rqlite-auth.sh");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(env: Record<string, string>, outDir: string) {
  return Bun.spawn(["bash", SCRIPT], {
    env: { ...process.env, ...env, AUTH_OUT_FILE: join(outDir, ".rqlite-auth.json") },
    stdout: "pipe", stderr: "pipe",
  });
}

describe("render-rqlite-auth.sh", () => {
  it("renders all four entries with 0600 perms when all three vars are set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2" }, dir);
    expect(await p.exited).toBe(0);
    const file = join(dir, ".rqlite-auth.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((u: { username: string }) => u.username);
    expect(names).toEqual(["pew", "pew-ro", "joiner", "*"]);
    expect(parsed.find((u: { username: string }) => u.username === "pew-ro").perms).toEqual(["select"]);
    expect(parsed.find((u: { username: string }) => u.username === "*").perms).toEqual(["status", "ready"]);
    expect(parsed.find((u: { username: string }) => u.username === "joiner").password).toBe("pw2");
    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("errors and removes any stale file when a variable is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    // Pre-create a stale file AND a stale directory (the bind-mount trap).
    writeFileSync(file, "stale");
    mkdirSync(join(dir, ".rqlite-auth.json"));
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1" }, dir); // no JOIN password
    expect(await p.exited).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("removes leftovers when all vars are empty (default-off path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    writeFileSync(file, "stale");
    const p = run({}, dir);
    expect(await p.exited).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
```

（测试顶部 import 需补 `writeFileSync, mkdirSync`；`Bun.file().stat` 行若无必要可删，以 `statSync` 断言为准。）

- [ ] **Step 2: 确认失败** — `bun test deploy/selfhost/render-auth.test.ts`，Expected: FAIL（脚本不存在）。

- [ ] **Step 3: 写脚本**

`deploy/selfhost/render-rqlite-auth.sh`：

```sh
#!/bin/sh
# Renders deploy/selfhost/.rqlite-auth.json (spec Plan 3 §3.1.2).
# Three vars must ALL be set (RQLITE_USERNAME / RQLITE_PASSWORD /
# RQLITE_JOIN_PASSWORD) or nothing is produced and leftovers are removed —
# a half-configured .env must never yield a partial credential file.
set -eu
umask 077
OUT="${AUTH_OUT_FILE:-$(dirname "$0")/.rqlite-auth.json}"

if [ -z "${RQLITE_USERNAME:-}" ] || [ -z "${RQLITE_PASSWORD:-}" ] || [ -z "${RQLITE_JOIN_PASSWORD:-}" ]; then
  rm -rf "$OUT"   # rm -rf also removes the directory docker may have created for a missing bind-mount
  if [ -n "${RQLITE_USERNAME:-}${RQLITE_PASSWORD:-}${RQLITE_JOIN_PASSWORD:-}" ]; then
    echo "render-rqlite-auth: RQLITE_USERNAME, RQLITE_PASSWORD and RQLITE_JOIN_PASSWORD must all be set (or all empty)" >&2
    exit 1
  fi
  exit 0
fi

jq -n \
  --arg u "$RQLITE_USERNAME" --arg p "$RQLITE_PASSWORD" --arg jp "$RQLITE_JOIN_PASSWORD" \
  '[
    { username: $u, password: $p, perms: ["all"] },
    { username: "pew-ro", password: $p, perms: ["select"] },
    { username: "joiner", password: $jp, perms: ["join"] },
    { username: "*", perms: ["status", "ready"] }
  ]' > "$OUT"
chmod 600 "$OUT"
```

（注意：`pew-ro` 复用 `RQLITE_PASSWORD`——只读用户与写用户同密码是可接受的折衷，规格 §3.1.1 只要求「进一步拆分属 YAGNI」；如需独立密码，实现时加 `RQLITE_READ_PASSWORD` 并同步 compose。默认不复用也行：`--arg p2 "${RQLITE_READ_PASSWORD:-$RQLITE_PASSWORD}"`。**实现采用后者**，即 `pew-ro` 用 `RQLITE_READ_PASSWORD`，缺省回落 `RQLITE_PASSWORD`。）

`deploy/selfhost/rqlite-entrypoint.sh`：spec §3.1.2 的脚本原文逐字照抄（含注释），`chmod +x` 两个脚本。

- [ ] **Step 4: 确认通过** — `bun test deploy/selfhost/render-auth.test.ts`，PASS。

- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/render-rqlite-auth.sh deploy/selfhost/rqlite-entrypoint.sh deploy/selfhost/render-auth.test.ts
git commit -m "feat: auth.json render script + rqlite entrypoint wrapper (spec §3.1.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: compose 接线（单节点 + cluster）与 ignore 规则

**Files:**
- Modify: `deploy/selfhost/docker-compose.yml`、`deploy/selfhost/.env.example`、`.gitignore`、`.dockerignore`
- Test: `deploy/selfhost/selfhost-infrastructure.test.ts`（既有 compose 结构断言文件，追加）

**Interfaces:**
- Consumes: Task 3 的 env 约定（`RQLITE_USERNAME/RQLITE_PASSWORD/RQLITE_READ_USERNAME/RQLITE_READ_PASSWORD`）、Task 4 的两个脚本。
- Produces: compose 的 rqlite 全部四服务挂 `/entrypoint.sh` 与 `/auth/auth.json`、`entrypoint: ["sh", "/entrypoint.sh"]`；migrate/d1-http/ingest 注入全权凭据、read/scheduler 注入只读凭据、cluster 节点 `RQLITE_JOIN_AS: joiner`。Task 8 真机验证与 Task 12 README 依赖此最终形态。

- [ ] **Step 1: 写失败结构断言**（追加到 `selfhost-infrastructure.test.ts`）

```ts
describe("rqlite auth wiring (spec Plan 3 §3.1.2)", () => {
  const compose = readFileSync(join(import.meta.dir, "docker-compose.yml"), "utf8");

  it("wraps every rqlite service with the entrypoint script and auth mount", () => {
    expect(compose).toContain('entrypoint: ["sh", "/entrypoint.sh"]');
    expect(compose.match(/\.\/rqlite-entrypoint\.sh:\/entrypoint\.sh:ro/g)?.length).toBe(4);
    expect(compose.match(/\.\/\.rqlite-auth\.json:\/auth\/auth\.json:ro/g)?.length).toBe(4);
  });

  it("cluster nodes join as the dedicated joiner user; single node does not", () => {
    const cluster = compose.slice(compose.indexOf("rqlite-1:"), compose.indexOf("migrate:"));
    expect(cluster.match(/RQLITE_JOIN_AS: joiner/g)?.length).toBe(3);
    const single = compose.slice(compose.indexOf("  rqlite:"), compose.indexOf("  rqlite-1:"));
    expect(single).not.toContain("RQLITE_JOIN_AS");
  });

  it("write services get full credentials; read/scheduler get read-only ones", () => {
    expect(compose).toContain("RQLITE_USERNAME: ${RQLITE_USERNAME:-}");
    expect(compose).toContain("RQLITE_READ_USERNAME: ${RQLITE_READ_USERNAME:-}");
    const sched = compose.slice(compose.indexOf("  scheduler:"), compose.indexOf("  web:"));
    expect(sched).toContain("RQLITE_READ_USERNAME");
    expect(sched).not.toContain("RQLITE_USERNAME: ${RQLITE_USERNAME:-}");
  });

  it("ignores the rendered auth file in git and docker contexts", () => {
    expect(readFileSync(join(import.meta.dir, "../../.gitignore"), "utf8"))
      .toContain("deploy/selfhost/.rqlite-auth.json");
    expect(readFileSync(join(import.meta.dir, "../../.dockerignore"), "utf8"))
      .toContain("**/.rqlite-auth.json");
  });
});
```

- [ ] **Step 2: 确认失败** — `bun test deploy/selfhost/selfhost-infrastructure.test.ts`，FAIL。

- [ ] **Step 3: 改 compose**。要点（全按 spec §3.1.2 片段）：

  - `x-rqlite-common` 增：

    ```yaml
      entrypoint: ["sh", "/entrypoint.sh"]
      volumes:
        - ./rqlite-entrypoint.sh:/entrypoint.sh:ro
        - ./.rqlite-auth.json:/auth/auth.json:ro
    ```

    （`rqlite-data*:/rqlite/file` 保持在各服务自己的 volumes 下；YAML merge key 会把 common 的 volumes 与服务自身的合并吗？——**不会**，`<<:` 对序列是整体替换。所以把两个 bind-mount 放进 `x-rqlite-common` 的 `volumes`，各服务自己的 `rqlite-data-N:/rqlite/file` 必须**并入 common 列表**或在各服务里重列全部三项。实现时：common 里只放 entrypoint 两个 bind-mount，各服务 `volumes` 写全三项。）
  - 四个 rqlite 服务 `command` 不变（`-fk ...` 照旧；entrypoint 脚本会把 `-auth` 追加在它们后面）。
  - cluster 三节点各加 `environment: { RQLITE_JOIN_AS: joiner }`；单节点不加。
  - migrate/d1-http/ingest 的 `environment` 加：

    ```yaml
      RQLITE_USERNAME: ${RQLITE_USERNAME:-}
      RQLITE_PASSWORD: ${RQLITE_PASSWORD:-}
    ```

  - read/scheduler 加（只读，缺省回落全权——未启用鉴权时两套都空，行为不变）：

    ```yaml
      RQLITE_READ_USERNAME: ${RQLITE_READ_USERNAME:-${RQLITE_USERNAME:-}}
      RQLITE_READ_PASSWORD: ${RQLITE_READ_PASSWORD:-${RQLITE_PASSWORD:-}}
    ```

  - `.env.example` 追加（带注释，注释即 Task 12 README 的素材）：

    ```bash
    # --- rqlite authentication (optional, Plan 3) ---
    # Set ALL THREE to enable; leave ALL empty to run without auth (default).
    # The join password belongs to the dedicated cluster-join user — treat it
    # with the same strength as RQLITE_PASSWORD (a successful join yields a
    # full read-only copy of the database).
    # RQLITE_READ_PASSWORD optionally gives read/scheduler their own user.
    RQLITE_USERNAME=
    RQLITE_PASSWORD=
    RQLITE_JOIN_PASSWORD=
    RQLITE_READ_PASSWORD=
    ```

  - `.gitignore` 加 `deploy/selfhost/.rqlite-auth.json`；`.dockerignore` 加 `**/.rqlite-auth.json`（紧挨现有 `**/.env` 组）。

- [ ] **Step 4: server-read / server-scheduler / server-ingest 接 env**（Task 2 已做 d1-http；这里同模式）：

  ```ts
  const RQLITE_USERNAME = process.env.RQLITE_READ_USERNAME ?? process.env.RQLITE_USERNAME;
  // server-ingest/migrate 用 RQLITE_USERNAME；server-read/scheduler 用 RQLITE_READ_USERNAME
  ```

  构造 adapter 时同 Task 3 模式（设了发 Basic、未设无头）。同时删除 compose 注释里已失实的「rqlite has no auth」两处（read/scheduler 的 `# No CF_D1_API_TOKEN` 注释改写为「direct rqlite access; uses optional read-only rqlite credentials」）。
- [ ] **Step 5: 确认通过** — `bun test deploy/selfhost/ && bun run tsc`（web 侧不受影响），PASS。
- [ ] **Step 6: 提交**

```bash
git add deploy/selfhost/docker-compose.yml deploy/selfhost/.env.example deploy/selfhost/server-read.ts deploy/selfhost/server-scheduler.ts deploy/selfhost/server-ingest.ts deploy/selfhost/selfhost-infrastructure.test.ts .gitignore .dockerignore
git commit -m "feat: compose auth wiring for rqlite + service credentials (spec §3.1.1/§3.1.2/§3.1.6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: 段 1 真机验证（compose 单节点 + cluster）

**Files:** 无代码改动（验证任务；发现问题回改对应 Task 后重跑）。

**Interfaces:** Consumes 全部前序任务。Produces: 段 1 验收记录（写进提交信息或 PR 描述）。

- [ ] **Step 1: 默认路径回归**（不设凭据）
  `cd deploy/selfhost && docker compose up -d --build` → migrate 完成、`/api/live` 200、Plan 2 认证流抽样（登录成功）。确认 `.rqlite-auth.json` 未产出、rqlite 进程 argv 无 `-auth`（`docker compose exec rqlite sh -c 'cat /proc/1/cmdline | tr "\0" " "'`）。
- [ ] **Step 2: 鉴权路径单节点**。`.env` 写三要素 → `bash deploy/selfhost/render-rqlite-auth.sh` → `docker compose up -d --force-recreate rqlite && docker compose up -d` → 真机项 1-3、5：
  1. migrate 通过、`/api/live` 200、登录成功
  2. 无凭据 `docker compose exec web node -e "fetch('http://rqlite:4001/db/query?q=SELECT%201').then(r=>console.log(r.status))"` → `401`；带凭据（Basic 头）→ `200`
  3. **对账自检触发**：另起一个无 `-auth` 的裸 rqlite 容器同网络，把 migrate 指过去（或临时删 auth.json 后 recreate rqlite 保持客户端凭据）→ migrate 显式报「credentials configured but auth is disabled」exit 1
- [ ] **Step 3: cluster**。`--profile cluster` 重复 Step 2（三节点全部 `-join-as joiner`），真机项 2/4/5：迁移通过、数据一致（写一条 leaderboard 记录三副本可读）；**匿名 join 拒绝**：同网络起 `rqlite/rqlite:10.5.3 -raft-non-voter -join rqlite-1:4002`（无 `-join-as`）→ 日志 unauthorized。
- [ ] **Step 4: 备份**（真机项 6）：带凭据 `POST /db/backup` 到宿主文件，文件非空；恢复到临时节点可读。
- [ ] **Step 5: 镜像层抽查**（真机项 7）：`git grep rqlite-auth .gitignore .dockerignore` 确认规则在；`docker build` 两个镜像后 `docker history pew-selfhost:local` 逐层确认无 auth.json，`docker save` 导出 grep 无命中。
- [ ] **Step 6: 清理实验容器/卷；提交**（若有回改，逐文件提交并引用对应 Task）。

---

## Task 7: 迁移 033 + verify-migrations 同步

**Files:**
- Create: `scripts/migrations/033-rate-limit-hits.sql`
- Modify: `deploy/selfhost/verify-migrations.ts`（`EXPECTED`、`PLAN_TABLES`、注释）

**Interfaces:**
- Produces: `rate_limit_hits(key TEXT NOT NULL, hit_at TEXT NOT NULL)` + `idx_rate_limit_hits_key_at` + `idx_rate_limit_hits_at`。Task 8 依赖表存在；`planTables: 6, indexes: 69`。

- [ ] **Step 1: 写迁移文件**（`033-rate-limit-hits.sql`，DDL 注释头带 `?norwtime&norwrandom` 说明，与 032 文件头同格式）

```sql
-- Sliding-window hit log for the rqlite-backed login rate limiter (Plan 3 §3.2).
-- Rows are bounded by the limiter's table-level cleanup constant (3600s window).
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key    TEXT NOT NULL,
  hit_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key_at ON rate_limit_hits(key, hit_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_at ON rate_limit_hits(hit_at);
```

- [ ] **Step 2: verify-migrations 同步**（同一提交）：`EXPECTED.planTables = 6`、`EXPECTED.indexes = 69`，`PLAN_TABLES` 加 `"rate_limit_hits"`，注释同步（033 一行）。
- [ ] **Step 3: 真机验证计数**：`docker run -d --name rq-verify -p 14001:4001 rqlite/rqlite:10.5.3 -fk` → `bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001` → PASSED（schema 打印 indexes=69）。`docker rm -f rq-verify`。
- [ ] **Step 4: 提交**

```bash
git add scripts/migrations/033-rate-limit-hits.sql deploy/selfhost/verify-migrations.ts
git commit -m "feat: rate_limit_hits migration + expected schema 69 indexes (spec §3.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: RqliteRateLimiter

**Files:**
- Modify: `packages/web/src/lib/rate-limit.ts`（新增导出，不动 `InMemoryRateLimiter`）
- Test: `packages/web/src/lib/__tests__/rate-limit.test.ts`（既有文件追加）

**Interfaces:**
- Consumes: `packages/web/src/lib/d1.ts` 的 `getD1Client()`（返回 `{ query, execute, batch }`；写路径经 d1-http → `/db/request`，`meta.changes` 由 d1-http 信封携带）。表与窗口常量来自 Task 7。
- Produces:
  - `RQLITE_RATE_LIMIT_WINDOW_SECONDS = 3600`（表级清理常量，模块级导出）
  - `function ipv6PrefixKey(ip: string): string`（IPv6 取前 4 组 hextet + `::/64`；IPv4/其他原样返回）
  - `class RqliteRateLimiter { check(key: string, config: RateLimitConfig): Promise<RateLimitResult> }` 与单例 `rqliteRateLimiter`
  - Task 9 的 `auth.ts` 依赖 `rqliteRateLimiter.check()` 与 `ipv6PrefixKey`。

- [ ] **Step 1: 写失败测试**

```ts
describe("RqliteRateLimiter", () => {
  const mockQuery = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/d1", () => ({
      getD1Client: () => ({ query: mockQuery, execute: vi.fn(), batch: vi.fn() }),
      resetD1Client: vi.fn(),
    }));
    mockQuery.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // never cleanup
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows when the atomic INSERT reports changes=1", async () => {
    mockQuery.mockResolvedValueOnce({ results: [], meta: { changes: 1 } });
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const r = await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(true);
    expect(r.current).toBe(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO rate_limit_hits/);
    // window math is SQL-side: the negative offset is a bound parameter
    expect(mockQuery.mock.calls[0][1]).toContain("-60 seconds");
  });

  it("rejects with current === limit when changes=0 (over-limit, NOT failure)", async () => {
    mockQuery.mockResolvedValueOnce({ results: [], meta: { changes: 0 } });
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const r = await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(false);
    expect(r.current).toBe(r.limit);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it("fails OPEN with a console.warn on execution error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("timeout"));
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const r = await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(r.allowed).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain("secret"); // no creds in logs
  });

  it("merges IPv6 addresses to /64 prefixes", async () => {
    const { ipv6PrefixKey } = await import("@/lib/rate-limit");
    expect(ipv6PrefixKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipv6PrefixKey("192.168.1.5")).toBe("192.168.1.5");
  });

  it("runs the bounded cleanup DELETE at the 1/100 probability", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.001);
    mockQuery.mockResolvedValue({ results: [], meta: { changes: 1 } });
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    await rqliteRateLimiter.check("login:ip:1.2.3.4", LOGIN_RATE_LIMIT);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toMatch(/DELETE FROM rate_limit_hits/);
    expect(mockQuery.mock.calls[1][1]).toContain("-3600 seconds");
  });
});
```

- [ ] **Step 2: 确认失败** — `cd packages/web && bun vitest run src/lib/__tests__/rate-limit.test.ts`，FAIL。

- [ ] **Step 3: 实现**（追加到 `rate-limit.ts`）

```ts
// ---------------------------------------------------------------------------
// rqlite-Backed Login Rate Limiter (Plan 3 §3.2)
// ---------------------------------------------------------------------------

/**
 * Table-level cleanup horizon: the largest window any consumer of this SHARED
 * table may use, plus margin. Per-process maxWindowMs is wrong here — a peer
 * that has only ever seen the 60s login window would delete rows another
 * consumer is still counting (3600s auth-code windows would vanish).
 */
export const RQLITE_RATE_LIMIT_WINDOW_SECONDS = 3600;

/** IPv6 privacy extensions rotate addresses per connection; collapse to /64. */
export function ipv6PrefixKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const groups = ip.split(":").filter(Boolean);
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * One atomic statement decides allow/deny: the INSERT happens only while the
 * window count is below the cap, so a single leader-side statement is the
 * whole decision (no COUNT-then-INSERT race across replicas). Window math is
 * SQL-side — app-side ISO strings do not compare against SQLite's
 * 'YYYY-MM-DD HH:MM:SS' format (space < 'T', verified).
 */
class RqliteRateLimiter {
  async check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    try {
      const db = getD1Client();
      // d1.ts query signature: query<T>(sql, params: unknown[]) - params as
      // one array arg, NOT rest args. Same for execute(sql, params).
      const { meta } = await db.query(
        `INSERT INTO rate_limit_hits(key, hit_at)
         SELECT ?, datetime('now')
         WHERE (SELECT COUNT(*) FROM rate_limit_hits
                WHERE key = ? AND hit_at > datetime('now', ?)) < ?`,
        [key, key, `-${config.windowSeconds} seconds`, config.maxRequests]
      );
      if ((meta?.changes ?? 0) === 0) {
        // Over-limit: the DB is healthy, the bucket is full. Not an error.
        return { allowed: false, current: config.maxRequests, limit: config.maxRequests, retryAfter: config.windowSeconds };
      }
      this.maybeCleanup(db, config);
      return { allowed: true, current: 1, limit: config.maxRequests, retryAfter: 0 };
    } catch (error) {
      // Fail-open (spec §3.2): a login limiter must not out-wait the login DB.
      // Distinguishable from over-limit precisely because it THROWS here.
      console.warn(`login rate limiter degraded (allowing): ${error instanceof Error ? error.message : error}`);
      return { allowed: true, current: 0, limit: config.maxRequests, retryAfter: 0 };
    }
  }

  /** 1/100 sampled DELETE bounded by the table-level constant. */
  private maybeCleanup(db: ReturnType<typeof getD1Client>, config: RateLimitConfig): void {
    if (Math.random() >= 0.01) return;
    void db.execute(
      `DELETE FROM rate_limit_hits WHERE hit_at < datetime('now', ?)`,
      `-${RQLITE_RATE_LIMIT_WINDOW_SECONDS} seconds`
    ).catch(() => { /* best effort */ });
  }
}

export const rqliteRateLimiter = new RqliteRateLimiter();
```

（import `getD1Client` 加到文件头；`db.query(sql, params[])` 签名已按 `packages/web/src/lib/d1.ts:102-121` 核实。真机项 2 会最终裁决 `changes` 经 d1-http 信封的解析路径。）

- [ ] **Step 4: 确认通过** — 同 Step 2 命令，PASS（含既有 InMemory 用例无回归）。
- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/rate-limit.ts packages/web/src/lib/__tests__/rate-limit.test.ts
git commit -m "feat: rqlite-backed login rate limiter (spec §3.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: auth.ts 双键接线 + 后端开关

**Files:**
- Modify: `packages/web/src/auth.ts`（`authorizeCredentials`、NextAuth 闭包、docstring）
- Test: `packages/web/src/__tests__/auth.test.ts`（追加）

**Interfaces:**
- Consumes: Task 8 的 `rqliteRateLimiter` / `ipv6PrefixKey`、既有 `getClientIp` / `LOGIN_RATE_LIMIT`。
- Produces: `authorizeCredentials` 签名不变；新增可选 `ip?: string` 参数（调用方 NextAuth 闭包传 `getClientIp(req)`）。开关：`LOGIN_RATE_LIMIT_BACKEND === "rqlite"` 时双键走 rqlite 后端，否则现状 memory 单键。

- [ ] **Step 1: 写失败测试**（追加到 `auth.test.ts`；该文件已 mock `@/lib/d1`，需同时 mock 环境开关）

```ts
describe("login limiter backend switch", () => {
  it("uses the rqlite backend with dual keys when LOGIN_RATE_LIMIT_BACKEND=rqlite", async () => {
    process.env.LOGIN_RATE_LIMIT_BACKEND = "rqlite";
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const spy = vi.spyOn(rqliteRateLimiter, "check").mockResolvedValue({ allowed: true, current: 1, limit: 5, retryAfter: 0 });
    await authorizeCredentials({ email: "a@b.c", password: "x", ip: "203.0.113.9" });
    const keys = spy.mock.calls.map((c) => c[0]);
    expect(keys).toContain("login:email:a@b.c");
    expect(keys).toContain("login:ip:203.0.113.9");
  });

  it("keeps the in-memory per-email limiter by default", async () => {
    delete process.env.LOGIN_RATE_LIMIT_BACKEND;
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const spy = vi.spyOn(rqliteRateLimiter, "check");
    await authorizeCredentials({ email: "default@b.c", password: "x" });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

（若 `auth.test.ts` 对 `@/lib/rate-limit` 是真模块而非 mock，`vi.spyOn` 直接可用；若 mock 了则在其 factory 里暴露 `rqliteRateLimiter` 假对象并断言调用——实现时以该文件现有 mock 结构为准。）

- [ ] **Step 2: 确认失败** — `bun vitest run src/__tests__/auth.test.ts`，FAIL。

- [ ] **Step 3: 实现**。`authorizeCredentials` 内替换限速段：

```ts
  // Docstring fix: this function previously claimed per-IP limiting but only
  // ever keyed per-email (auth.ts:68). The IP dimension arrives with the
  // rqlite backend, which the NextAuth(req) closure feeds via getClientIp.
  if (process.env.LOGIN_RATE_LIMIT_BACKEND === "rqlite") {
    const limiter = await import("@/lib/rate-limit").then((m) => m.rqliteRateLimiter);
    const ipKey = `login:ip:${input.ip ? ipv6PrefixKey(input.ip) : "unknown"}`;
    for (const key of [`login:email:${email}`, ipKey]) {
      const result = await limiter.check(key, LOGIN_RATE_LIMIT);
      if (!result.allowed) return null;
    }
  } else {
    const limit = inMemoryRateLimiter.check(`login:${input.rateKey ?? email}`, LOGIN_RATE_LIMIT);
    if (!limit.allowed) return null;
  }
```

（`limiterPrefix` 即 Task 8 的 `ipv6PrefixKey`——顶部静态 import 它与 `rqliteRateLimiter` 均可，动态 import 仅当需要避免循环依赖；实现时优先静态 import，确认无环。）NextAuth 闭包 `authorize:` 改为：

```ts
      authorize: (creds) =>
        authorizeCredentials({
          email: creds?.email,
          password: creds?.password,
          ip: req ? getClientIp(req as Request) : undefined,
        }),
```

（`getClientIp` 已从 `@/lib/rate-limit` 导出；`req` 是 NextRequest，`headers.get` 兼容。）

- [ ] **Step 4: 确认通过** — `bun vitest run src/__tests__/auth.test.ts`，PASS；`bun run tsc` 干净。
- [ ] **Step 5: 提交**

```bash
git add packages/web/src/auth.ts packages/web/src/__tests__/auth.test.ts
git commit -m "feat: dual-key login limiting via rqlite backend switch (spec §3.2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: 段 2 真机验证

**Files:** 无代码改动（验证任务）。

- [ ] **Step 1: 端到端双键**。单节点鉴权部署 + web 加 `LOGIN_RATE_LIMIT_BACKEND=rqlite` → 连续 6 次错误密码登录同一邮箱同一 IP → 第 6 次被拒（422/redirect 含 error）、`rqlite` 内 `SELECT COUNT(*) FROM rate_limit_hits WHERE key LIKE 'login:%'` 有 12 行（双键）→ 换 IP（curl 带 XFF）登录成功不误伤。
- [ ] **Step 2: `meta.changes` 裁决**。直接对 rqlite 执行 Task 8 的原子语句确认 `rows_affected` 在 `/db/request` 响应中的字段路径与 d1-adapter 映射一致；若不一致，按规格回退方案改读 `results[0].meta` 或 `SELECT changes()` 后置查询，重跑单测 + 本步。
- [ ] **Step 3: 清理验证**。手动 `INSERT` 一条 `hit_at = datetime('now','-7200 seconds')` 老行，把 Math.random 触发不了的 1/100 概率改为临时调 `maybeCleanup`（或直接对该 DELETE 语句手跑）确认删除。
- [ ] **Step 4: 记录结果并提交（如有回改）。**

---

## Task 11: compose 扩展文件 + README 反代小节

**Files:**
- Create: `deploy/selfhost/docker-compose.proxy.yml`、`deploy/selfhost/docker-compose.caddy.yml`、`deploy/selfhost/Caddyfile`
- Modify: `deploy/selfhost/README.md`（新增「反向代理」小节）

**Interfaces:** Consumes Task 5 的 compose。Produces: 三个新文件 + README 小节。纯文档与配置，无代码接口。

- [ ] **Step 1: 写 `docker-compose.proxy.yml`**

```yaml
# Overlay: bind web's port to loopback only when a reverse proxy fronts it.
# Usage: docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
# !override replaces (not appends) the base ports list; needs Compose >= v2.24.4.
services:
  web:
    ports: !override ["127.0.0.1:${WEB_PORT:-7020}:7020"]
```

- [ ] **Step 2: 写 `docker-compose.caddy.yml` + `Caddyfile`**（spec §3.3 骨架逐字）

```yaml
# Optional extension: Caddy terminates TLS in front of web.
# Usage: docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [web]
volumes:
  caddy-data: {}
  caddy-config: {}
```

```
# Replace with your intranet hostname. Public DNS + ports 80/443 reachable:
# automatic HTTPS. Otherwise uncomment tls internal (self-signed).
example.intranet.corp {
    reverse_proxy web:7020
    # tls internal
}
```

- [ ] **Step 3: README「反向代理」小节**——内容=spec §3.3 全部要点：Caddy 推荐（≥2.5 默认忽略入站 XFF，引官方文档）、Nginx 完整 server 块示例（`proxy_set_header Host $host;`、`proxy_set_header X-Forwarded-For $remote_addr;` 覆写非追加、`proxy_set_header X-Forwarded-Proto https;`、`client_max_body_size 25m;`）、★ 三条硬约束、cookie 四格矩阵（强调 https 部署必须显式 `USE_SECURE_COOKIES=true`）、`-f` 叠加调用 + `docker compose config` 冒烟、`login:ip:unknown` 共享桶与漏配 XFF 的 DoS 关联注明。
- [ ] **Step 4: 冒烟**：`cd deploy/selfhost && docker compose -f docker-compose.yml -f docker-compose.proxy.yml config >/dev/null && docker compose -f docker-compose.yml -f docker-compose.caddy.yml config >/dev/null && echo OK`。Expected: OK（无 merge 错误、`!override` 生效）。
- [ ] **Step 5: 提交**

```bash
git add deploy/selfhost/docker-compose.proxy.yml deploy/selfhost/docker-compose.caddy.yml deploy/selfhost/Caddyfile deploy/selfhost/README.md
git commit -m "docs: reverse-proxy deployment guide + compose overlays (spec §3.3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: README 段 1/2 连带订正

**Files:**
- Modify: `deploy/selfhost/README.md`

**Interfaces:** 纯文档。Consumes Task 4/5/7/8 的既成事实。

- [ ] **Step 1: Quickstart 改写**——鉴权路径三步固定序列（render → up → 自检），加粗警告「**先 up 后 render 会以无鉴权静默启动**」；无鉴权路径保持现状一行。
- [ ] **Step 2: 备份/恢复订正**——带凭据 `-u user:pass`、端点 `POST /db/backup`（注明 GET /backup 在 10.5.3 是 404）、备份后校验非空（`[ -s file ]`）、恢复命令同凭据。
- [ ] **Step 3: 破窗命令订正**——替换 `README.md:28` 的 `RQLITE_URL=http://127.0.0.1:14001`（端口从未发布）为 `docker compose exec -e RQLITE_USERNAME -e RQLITE_PASSWORD rqlite ...` 形态，凭据从 `.env` 读入 exec 环境。
- [ ] **Step 4: 新增「升级」小节 + auth.json 丢失恢复 runbook**（spec §3.1.5 两种情形逐字落地；runbook 注明：auth 文件误删 `*` 条目 → healthcheck 401 → rqlite 永不 healthy → migrate 永不跑，启动门卡死难定位，spec §2.1 要求明示）+ 回滚清理 checklist（.env 三变量、磁盘 auth.json、dockerignore 回退）。
- [ ] **Step 5: 安全注意事项改写**——「rqlite 默认无鉴权…本计划未做」改为条件描述（默认关、三变量开启）；跨机集群段补 auth.json 逐字节一致 / 轮换 = 全节点 recreate / 4002 明文需 WireGuard；三节点降级信号（单节点 down = 只读、两节点 down 须同时恢复）；限速段改写为 `LOGIN_RATE_LIMIT_BACKEND` 双后端描述 + 其余 5 处消费方保持 memory 的原因清单。
- [ ] **Step 6: 提交**

```bash
git add deploy/selfhost/README.md
git commit -m "docs: README auth runbooks, backup/break-glass fixes, upgrade section (spec §3.1.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: 全量回归

**Files:** 无新改动（回归门）。

- [ ] **Step 1**: `bun run test:coverage` 全绿（含 95% 覆盖率 ×4）。
- [ ] **Step 2**: L3 全量 e2e（94 用例）。
- [ ] **Step 3**: compose e2e 单节点 + cluster（Task 6 步骤复跑一遍作为终态确认，含 Task 10 真机项 1-3）。
- [ ] **Step 4**: 全部通过后向用户汇报；如用户要求再推 fork origin。
