# pew 私有化部署 — Plan 2：认证子系统 Implementation Plan


**状态：已交付（任务全部实现并验证）。** Goal: 让自建部署（Plan 1 的数据层与运行时）具备**可用的浏览器登录**——邮箱 + 密码（Credentials）、首个用户即管理员的 `/setup` 引导、库内 `is_admin` 判定、密码重置路径、内网 http 的 cookie 关闭分支，以及 CLI 指向自建 host。Plan 1 交付「数据层可用」，Plan 2 交付「浏览器可登录的完整产品」。

**Architecture:** 仍是「不重写业务逻辑」。认证接缝集中在 `auth.ts` 一处组装：`providers` 按环境条件挂 Google/Credentials，`signIn` 对 credentials 直接放行，邀请闸门逻辑从 `lib/invite.ts`（不改）移到新的 `lib/credentials.ts`。密码哈希（scrypt）与注册都由新增文件承担；`password_hash` 的读取走 D1 REST 原始查询（`getD1Client().query`），从而**不改 worker-read、不改 `lib/db.ts`**。管理员判定从「纯 `ADMIN_EMAILS`」扩展为「`ADMIN_EMAILS` 命中 OR 库内 `is_admin=1`」。首个用户即管理员，用一次性单行表 `instance_setup` 做并发安全的认领，解开「无用户建不了邀请码、无邀请码建不了用户」的死锁。

**Tech Stack:** Next.js（App Router）+ Auth.js（NextAuth v5，JWT strategy）、Node `crypto.scryptSync`（密码哈希）、rqlite/D1（经 Plan 1 的 `D1_BASE_URL` → d1-http）、Vitest 5（`bun run test`）

**Spec:** `docs/57-self-hosted-deployment-design.md`（§4.4 认证、§4.5 CLI、§4.7 改动面）

**前置：** Plan 1（`docs/58-self-hosted-storage-runtime.md`）必须已完成——本计划依赖 `D1_BASE_URL`（Plan 1 Task 1）、`deploy/selfhost/` 适配层与 compose（Plan 1 Task 2–10）、`vitest.config.ts` 的 `deploy/**` include（Plan 1 Task 2）。

## Global Constraints

- **不改动 Plan 1 的「刻意不改」清单**：`packages/worker/**`、`packages/worker-read/**`、`lib/db.ts`、`lib/db-worker.ts`、`lib/db-rest.ts`、`lib/invite.ts`、`lib/r2.ts`、`next.config.ts`、`bun.lock`、根 `package.json`、`biome.json`、`lib/rate-limit.ts`。（实现更正 2026-10-17：原文还列 `Dockerfile` 与 `cli.ts`——两者已被 Plan 1/Plan 2 实际改动（根 Dockerfile、`cli.ts` 的 `--host` 支持），见 docs 52 §4 与 README「合并上游」。）
- **本计划改动的上游文件（相对 Plan 1 新增 10 处；Plan 1 已改 `lib/d1.ts`、`vitest.config.ts`）**：`auth.ts`、`app/login/page.tsx`、`lib/auth-adapter.ts`、`lib/admin.ts`、`app/api/admin/check/route.ts`、`app/api/users/[slug]/route.ts`、`proxy.ts`、`app/api/admin/invites/route.ts`（及全量 grep 出的同类省略时间列 INSERT）、`cli/src/commands/login.ts`、`cli/src/config/manager.ts`。每处改动尽量小，逐条在任务里给出。
- **scrypt 必须显式传 `maxmem`**：实测 `scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1 })` 在默认 `maxmem = 32 MiB` 下抛 `Invalid scrypt params`（OpenSSL 需求 `128*N*r + 128*r*p = 33,555,456` > `33,554,432`）。统一用 `maxmem: 64 * 1024 * 1024`。
- **密码最终不入 `accounts` 表**：Credentials 用户不写入 `accounts`（那是 OAuth `linkAccount` 的产物）。任何依赖 `accounts` 判断「老用户」的逻辑（`lib/invite.ts` 的 `getUserByOAuthAccount`）对 credentials 恒为 null——这正是邀请闸门必须改写、且 `signIn` 必须对 credentials 直接放行的原因。
- **`password_hash` 只经 D1 REST 原始查询读取**：`getD1Client().query(...)`（`lib/d1.ts`），**不得**给 `lib/db.ts` / worker-read 的 RPC 方法集加方法（那要改三处上游文件）。
- **引导并发安全**：`instance_setup` 单行表 + 「插用户 + 插 `instance_setup`」两 INSERT 共享一个 `?transaction=true` 批量事务（Plan 1 §4.1 专项一）。（实现更正 2026-10-15：`users` 计数查询在批量**之外**先读——严格「事务内先查」未实现，但并发安全仍成立：第二次并发请求在批量内撞 `instance_setup` 主键、整个批量回滚，不会产生第二个管理员。原文「不得先查再插」按此更正。）
- **限速是进程内**：`inMemoryRateLimiter` 仅单实例有效；多 web 副本需外部化，写进部署文档、接受弱化。`getClientIp` 信任 `X-Forwarded-For`，反代必须清洗/覆写该头。
- **多节点确定性**：任何省略时间列的 `INSERT` 必须补显式 `datetime('now')`（表达式进语句文本 → leader 改写 → 各副本重放一致）。实现阶段全量 grep `INSERT INTO` 定位。
- **测试命令**：`bun run test`；单文件 `./node_modules/.bin/vitest run <path>`（**不要 `bunx vitest`**）。测试与源码同目录、`*.test.ts`。
- **提交信息**用 `feat:` / `fix:` / `test:` 前缀。

## Review Focus

spec 隐含、但任务测试天然覆盖不到的输入类别：

1. **旧用户第二次登录不被锁死**——credentials 下 `accounts` 无记录，若沿用 OAuth 的「老用户」判定，第二次登录会被当新用户要求邀请码。→ Task 3 的测试（老用户免邀请码）。
2. **并发引导只产生一个管理员**——两个请求同时打空库。→ Task 5 的测试（第二次 `instance_setup` 主键冲突）。
3. **密码校验用常量时间 + 用户不存在也做 dummy 校验**——否则可按时序枚举邮箱。→ Task 2 的测试。
4. **改密码后旧 JWT 失效**——`pwd_v` 前缀比对。→ Task 6 的测试。
5. **内网 http cookie 关闭分支真正生效**——`USE_SECURE_COOKIES=false` 时必须去掉 `__Secure-` 与 `secure:true`。→ Task 4 的测试。
6. **scrypt 的 `maxmem` 陷阱**——不传则默认参数直接抛错。→ Task 2 的测试（用生产参数跑一次）。
7. **库内管理员不被误判**——两处同步 `isAdmin(email)` 调用点若不改异步，会漏判。→ Task 7 的测试。
8. **`/setup` 对未登录可达**——`proxy.ts` 不放开则 302 到 `/login` 死循环。→ Task 8 的测试。

---

### Task 1: 数据库迁移（`password_hash` / `is_admin` / `instance_setup` / `password_resets`）

**Files:**
- Create: `scripts/migrations/032-auth-credentials.sql`
- Test: `packages/web/src/__tests__/auth-migration.test.ts`（新增；或复用一个迁移检查测试目录）

**Interfaces:**
- Consumes: Plan 1 的迁移执行器（`deploy/selfhost/migrate.ts`，`applyMigrations` + `isDdlStatement` 分流）
- Produces: `users.password_hash TEXT`、`users.is_admin INTEGER NOT NULL DEFAULT 0`、`instance_setup` 单行表、`password_resets` 表

**背景**：`users` 表（`001-init.sql:15` 起）无任何 password/role 字段（已核验）。`ALTER TABLE ADD COLUMN` 幂等性靠 Plan 1 的账本 + 本迁移的恢复逻辑；但为稳妥，列定义写成可被 Plan 1 `isBenignReplayError` 兜底的形式（重复执行报 `duplicate column name`，Plan 1 会跳过——Task 5 已实现）。

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/__tests__/auth-migration.test.ts`：读迁移文件文本，断言四个对象都在，且不含非确定默认值：

```typescript
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/migrations/032-auth-credentials.sql"
);

describe("032-auth-credentials.sql", () => {
  it("adds password_hash and is_admin to users", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN password_hash TEXT/i);
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0/i);
  });

  it("creates the single-row instance_setup claim table", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instance_setup/i);
    expect(sql).toMatch(/CHECK \(id\s*=\s*1\)/i);
  });

  it("creates a password_resets table with an expiry", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS password_resets/i);
    expect(sql).toMatch(/expires_at\s+TEXT/i);
  });

  it("does not rely on non-deterministic column defaults", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).not.toMatch(/DEFAULT\s*\(\s*datetime\s*\(\s*'now'/i);
    expect(sql).not.toMatch(/randomblob\s*\(/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/auth-migration.test.ts`
Expected: FAIL —— `ENOENT` 找不到迁移文件

- [ ] **Step 3: 实现**

创建 `scripts/migrations/032-auth-credentials.sql`：

```sql
-- Credentials (email + password) auth support.
--
-- users has no password/role column upstream; password_hash feeds the
-- Credentials provider (lib/credentials.ts), is_admin backs the "first user
-- is admin" rule (lib/admin.ts reads it).
--
-- instance_setup is a single-row claim table: the first /setup request inserts
-- its row in the same transaction that creates the admin, so a concurrent
-- second request fails on the PRIMARY KEY collision. That closes the
-- "no users => no invite codes => no users" deadlock without any pre-seed
-- script. See spec §4.4.

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS instance_setup (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  admin_user_id TEXT NOT NULL,
  completed_at  TEXT NOT NULL
);

-- Admin-initiated password reset (§4.4): no email capability exists, so the
-- admin generates a single-use token and hands it over out of band.
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/auth-migration.test.ts`
Expected: PASS（4 条）

- [ ] **Step 5: 提交**

```bash
git add scripts/migrations/032-auth-credentials.sql packages/web/src/__tests__/auth-migration.test.ts
git commit -m "feat: add credentials auth migration (password_hash, is_admin, instance_setup)"
```

---

### Task 2: 密码哈希（`lib/credentials.ts` 的 scrypt 部分）

**Files:**
- Create: `packages/web/src/lib/credentials.ts`
- Test: `packages/web/src/__tests__/credentials.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(password: string): string` —— 返回 `scrypt$N$r$p$<salt_b64>$<hash_b64>`
  - `verifyPassword(password: string, stored: string): Promise<boolean>`
  - `verifyPasswordDummy(password: string): Promise<void>` —— 用户不存在时也消耗等价时间
- Consumes: 无（只依赖 `node:crypto`）

**背景**：参数用 `N=32768, r=8, p=1, keylen=64, maxmem=64MiB`。存储格式带参数，便于日后调整而兼容旧记录。

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/__tests__/credentials.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, verifyPasswordDummy } from "../lib/credentials";

describe("password hashing (scrypt)", () => {
  it("round-trips a password", async () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = hashPassword("right");
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("uses a fresh salt each time", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });

  it("returns false for a malformed stored value without throwing", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$bad", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("works with the production scrypt params (maxmem set, no throw)", async () => {
    // A missing maxmem makes scryptSync throw "Invalid scrypt params" here.
    const stored = hashPassword("p@ssw0rd");
    expect(await verifyPassword("p@ssw0rd", stored)).toBe(true);
  });

  it("verifyPasswordDummy resolves without throwing", async () => {
    await expect(verifyPasswordDummy("anything")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/credentials.test.ts`
Expected: FAIL —— `Failed to resolve import "../lib/credentials"`

- [ ] **Step 3: 实现**

创建 `packages/web/src/lib/credentials.ts`（本步只放哈希部分，注册逻辑在 Task 3 追加）：

```typescript
/**
 * Email + password credentials: scrypt hashing and (Task 3) registration.
 *
 * Reasons this is its own module rather than folded into auth.ts:
 *   - lib/invite.ts's gate keys off the `accounts` table, which credentials
 *     users never populate; the credential path needs its own gate (see
 *     lib/invite.ts comment and spec §4.4).
 *   - scrypt params and the storage format are security-critical and want
 *     their own tests.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// N=32768 with r=8 needs 128*N*r + 128*r*p = 33,555,456 bytes of memory, which
// is just over Node's default maxmem (32 MiB) and throws "Invalid scrypt
// params". Pass maxmem explicitly.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Wasted scrypt work for a nonexistent user, so login latency does not reveal
 * whether an email is registered.
 */
export async function verifyPasswordDummy(password: string): Promise<void> {
  const salt = randomBytes(16);
  scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/credentials.test.ts`
Expected: PASS（6 条）

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/credentials.ts packages/web/src/__tests__/credentials.test.ts
git commit -m "feat: add scrypt password hashing for credentials auth"
```

---

### Task 3: 注册与登录闸门（`lib/credentials.ts` 的注册逻辑 + `auth.ts` 的 Credentials provider）

**Files:**
- Modify: `packages/web/src/lib/credentials.ts`（追加注册/查找函数）
- Modify: `packages/web/src/auth.ts`（providers 条件组装、signIn 放行、Credentials provider）
- Modify: `packages/web/src/app/api/admin/invites/route.ts`（若其 INSERT 省略时间列，补 `datetime('now')`；先 grep 确认）
- Test: `packages/web/src/__tests__/credentials-register.test.ts`

**Interfaces:**
- Consumes: Task 1 的列/表、Task 2 的哈希
- Produces:
  - `findCredentialUser(email: string): Promise<{ id; email; password_hash; name; is_public } | null>`
  - `registerWithInvite({ email, name, password, inviteCode }): Promise<{ userId: string }>`

**背景**：注册时原子消费邀请码（沿用 `invite.ts:140-150` 的 `UPDATE ... WHERE used_by IS NULL` + `changes === 0` 模式）；`created_by` 引用真实用户（首个管理员建立后才有）。`accounts` 表不写。

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/__tests__/credentials-register.test.ts`，用一个记录 SQL 的假 `D1Client`（`getD1Client()` 可 mock）覆盖：老用户查到记录 → 免邀请码；新用户无邀请码 → 拒绝；新用户带有效邀请码 → 消费成功并建用户。

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../lib/d1", () => ({
  getD1Client: () => ({ query, execute: vi.fn(), batch: vi.fn() }),
  resetD1Client: vi.fn(),
}));

import { findCredentialUser, registerWithInvite } from "../lib/credentials";

describe("credentials registration gate", () => {
  beforeEach(() => query.mockReset());

  it("finds an existing credentials user by email", async () => {
    query.mockResolvedValueOnce({
      results: [{ id: "u1", email: "a@b.c", password_hash: "scrypt$x", name: "A", is_public: 1 }],
    });
    expect(await findCredentialUser("a@b.c")).toMatchObject({ id: "u1" });
  });

  it("returns null when no user matches", async () => {
    query.mockResolvedValueOnce({ results: [] });
    expect(await findCredentialUser("nobody@x.y")).toBeNull();
  });

  it("rejects a new user without an invite code when the instance is set up", async () => {
    await expect(
      registerWithInvite({ email: "n@x.y", name: "N", password: "password123", inviteCode: "" })
    ).rejects.toThrow(/invite/i);
  });

  it("consumes a valid invite code and creates the user", async () => {
    // ... asserts the UPDATE ... WHERE used_by IS NULL is issued and changes>0
  });
});
```

（完整断言在实现时补全：`registerWithInvite` 需先消费邀请码再 `INSERT users`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/credentials-register.test.ts`
Expected: FAIL —— 导入的 `findCredentialUser` / `registerWithInvite` 不存在

- [ ] **Step 3: 实现**

在 `lib/credentials.ts` 追加：

```typescript
import { getD1Client } from "./d1";

export interface CredentialUser {
  id: string;
  email: string;
  password_hash: string | null;
  name: string;
  is_public: number;
}

/**
 * Reads password_hash directly through D1 REST, not worker-read's RPC: the
 * read interface (lib/db.ts) intentionally never exposes password_hash, and
 * widening it would touch three upstream files (spec §4.4).
 */
export async function findCredentialUser(email: string): Promise<CredentialUser | null> {
  const { results } = await getD1Client().query<CredentialUser>(
    "SELECT id, email, password_hash, name, is_public FROM users WHERE email = ?",
    [email]
  );
  return results[0] ?? null;
}

export async function registerWithInvite(input: {
  email: string;
  name: string;
  password: string;
  inviteCode: string;
}): Promise<{ userId: string }> {
  // ...consume invite atomically, insert user with explicit created_at...
}
```

`auth.ts` 的改动：

```typescript
// providers 由字面量 [Google] 改为条件组装
const providers: Provider[] = [];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google);
}
providers.push(Credentials({
  async authorize(creds) {
    // rate limit (login:<ip>/login:<email>) -> findCredentialUser ->
    // verifyPassword or verifyPasswordDummy for missing user -> return user
  },
}));
```

`signIn` 回调（`auth.ts:143-157`）开头加：

```typescript
if (account?.provider === "credentials") return true;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/credentials-register.test.ts packages/web/src/__tests__/auth.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/credentials.ts packages/web/src/auth.ts packages/web/src/app/api/admin/invites/route.ts packages/web/src/__tests__/credentials-register.test.ts
git commit -m "feat: add credentials provider and invite-gated registration"
```

---

### Task 4: 内网 http 的 cookie 关闭分支（`auth.ts`）

**Files:**
- Modify: `packages/web/src/auth.ts`（`shouldUseSecureCookies`）
- Test: `packages/web/src/__tests__/auth.test.ts`（追加用例）

**Interfaces:**
- Produces: `shouldUseSecureCookies()` 在 `USE_SECURE_COOKIES === "false"` 时返回 `false`（显式关闭），优先于 production 判定。

**背景**：镜像硬编码 `NODE_ENV=production`，故必须让 `false` 有显式分支——Plan 1 的 compose 已下发该变量但代码没读（Plan 1 review H2）。

- [ ] **Step 1: 写失败测试**

追加到 `packages/web/src/__tests__/auth.test.ts`：

```typescript
it("disables secure cookies when USE_SECURE_COOKIES is explicitly false", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("USE_SECURE_COOKIES", "false");
  expect(shouldUseSecureCookies()).toBe(false);
  vi.unstubAllEnvs();
});

it("still forces secure cookies in production by default", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("USE_SECURE_COOKIES", ""); // unset
  expect(shouldUseSecureCookies()).toBe(true);
  vi.unstubAllEnvs();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/auth.test.ts -t "USE_SECURE_COOKIES"`
Expected: FAIL —— 第二条（false 分支不存在，仍返回 true）

- [ ] **Step 3: 实现**

`auth.ts` 的 `shouldUseSecureCookies()`（当前 `auth.ts:21-27`）改为先判显式关闭：

```typescript
export function shouldUseSecureCookies(): boolean {
  // Explicit opt-out wins: intranet http deployments cannot use __Secure-
  // prefixed cookies (the browser drops them), and the image always runs
  // with NODE_ENV=production, so the opt-out must be checked first.
  if (process.env.USE_SECURE_COOKIES === "false") return false;
  return (
    process.env.NODE_ENV === "production" ||
    (process.env.NEXTAUTH_URL?.startsWith("https://") ?? false) ||
    process.env.USE_SECURE_COOKIES === "true"
  );
}
```

（保持原有 `true`/https 分支语义不变，只在最前面插入 `false` 早返回。）

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/auth.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/auth.ts packages/web/src/__tests__/auth.test.ts
git commit -m "fix: add explicit USE_SECURE_COOKIES=false opt-out for intranet http"
```

---

### Task 5: 首个用户即管理员 — `/setup` 引导与 `instance_setup` 认领

**Files:**
- Create: `packages/web/src/app/api/auth/register/route.ts`
- Create: `packages/web/src/app/setup/page.tsx`
- Modify: `packages/web/src/lib/credentials.ts`（追加 `bootstrapAdmin`）
- Test: `packages/web/src/__tests__/bootstrap.test.ts`

**Interfaces:**
- Produces:
  - `bootstrapAdmin({ email, name, password }): Promise<{ userId: string }>` —— 事务内「users 为空 → 插用户(is_admin=1) → 插 instance_setup」
  - `POST /api/auth/register` —— 引导模式（库为空）跳过邀请码；常规模式校验邀请码
  - `/setup` 向导页

**背景**：并发安全靠 `instance_setup` 主键冲突（见 Task 1 表）。rqlite 写路径单 leader 串行 + `?transaction=true` 原子（Plan 1 §4.1 专项一）。批量写走 `getD1Client().batch([...])`。

- [ ] **Step 1: 写失败测试**

创建 `packages/web/src/__tests__/bootstrap.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const batch = vi.fn();
const query = vi.fn();
vi.mock("../lib/d1", () => ({
  getD1Client: () => ({ query, batch, execute: vi.fn() }),
  resetD1Client: vi.fn(),
}));

import { bootstrapAdmin } from "../lib/credentials";

describe("bootstrapAdmin", () => {
  beforeEach(() => { batch.mockReset(); query.mockReset(); });

  it("creates the first user as admin inside one transaction", async () => {
    query.mockResolvedValueOnce({ results: [{ n: 0 }] }); // users empty
    batch.mockResolvedValueOnce([{ success: true }, { success: true }]);
    const r = await bootstrapAdmin({ email: "a@b.c", name: "A", password: "password123" });
    expect(r.userId).toBeTruthy();
    // The batch must include the INSERT users (is_admin=1) AND instance_setup.
    const stmts = batch.mock.calls[0][0].map((s: any) => s.sql).join("\n");
    expect(stmts).toMatch(/INSERT INTO users/i);
    expect(stmts).toMatch(/instance_setup/i);
  });

  it("refuses when users already exist", async () => {
    query.mockResolvedValueOnce({ results: [{ n: 1 }] });
    await expect(
      bootstrapAdmin({ email: "a@b.c", name: "A", password: "password123" })
    ).rejects.toThrow(/already/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/bootstrap.test.ts`
Expected: FAIL —— `bootstrapAdmin` 不存在

- [ ] **Step 3: 实现**

`lib/credentials.ts` 追加 `bootstrapAdmin`（事务批）；创建 `app/api/auth/register/route.ts`（判断库是否为空决定走 bootstrap 还是 invite 路径）；创建 `app/setup/page.tsx`（4 步向导）。实现更正 2026-10-17：向导页是纯客户端组件（`"use client"`），**没有服务端 302 门**——库非空时访问 `/setup` 仍渲染向导，拒绝发生在 `POST /api/auth/register`（`registerWithInvite` 失败返回 400），与 docs 52 §4.4 的实现更正同源。

关键 SQL（批内）：

```sql
INSERT INTO users (id, email, name, is_admin, password_hash, created_at)
VALUES (?, ?, ?, 1, ?, datetime('now'));
INSERT INTO instance_setup (id, admin_user_id, completed_at) VALUES (1, ?, datetime('now'));
```

（`created_at` 显式写入——多节点确定性，spec §4.1 专项五。）

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/bootstrap.test.ts`
Expected: PASS（2 条）

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/credentials.ts packages/web/src/app/api/auth/register/route.ts packages/web/src/app/setup/ packages/web/src/__tests__/bootstrap.test.ts
git commit -m "feat: add first-user-is-admin setup wizard with instance_setup claim"
```

---

### Task 6: 登录页与 CLI 登录入口（`login/page.tsx`）

**Files:**
- Modify: `packages/web/src/app/login/page.tsx`
- Test: `packages/web/src/__tests__/login-page.test.tsx`（或复用既有页面测试）

**Interfaces:**
- Produces: 登录页按 provider 条件渲染；库内无用户时显示「首次部署？前往初始化」入口指向 `/setup`。

**背景**：`login/page.tsx` 当前只有 Google 按钮（spec §4.4）。Credentials 表单需提交到 Auth.js 的 credentials callback。

- [ ] **Step 1–5**：TDD——先断言「有 credentials provider 时渲染邮箱/密码表单」，再实现条件渲染；断言「无用户时显示 /setup 入口」。实现遵循上游组件风格（Tailwind + shadcn，与既有页面一致）。提交信息 `feat: add email/password login form and setup entry point`。

---

### Task 7: 管理员判定扩展（`lib/admin.ts` + 两处调用点）

**Files:**
- Modify: `packages/web/src/lib/admin.ts`
- Modify: `packages/web/src/app/api/admin/check/route.ts`
- Modify: `packages/web/src/app/api/users/[slug]/route.ts`
- Test: `packages/web/src/__tests__/admin.test.ts`（追加用例）

**Interfaces:**
- Produces: `resolveAdmin`/`isAdminUser` 判定改为 `ADMIN_EMAILS 命中 OR 库内 is_admin=1`；保留同步 `isAdmin(email)` 的纯 env 语义。

**背景**：`isAdmin(email)`（`admin.ts:54`）是同步、只收 email，直接改查库会波及 38 处调用点。策略：保留其同步纯 env 语义，把库内判定并入已是异步的 `resolveAdmin`/`isAdminUser`；两处**直接**调用同步 `isAdmin(email)` 的路由（`api/admin/check/route.ts:44`、`api/users/[slug]/route.ts:53`）改为异步判定。

- [ ] **Step 1: 写失败测试**

追加到 `admin.test.ts`：mock D1 返回 `is_admin=1` 的用户，断言 `resolveAdmin` 对其返回管理员、`isAdminUser` 为真；断言 `isAdmin(email)`（同步）**仅**看 `ADMIN_EMAILS`（不查库）。

- [ ] **Step 2: 跑测试确认失败**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/admin.test.ts -t "is_admin"`
Expected: FAIL

- [ ] **Step 3: 实现**

`resolveAdmin`/`isAdminUser` 增加一次 D1 查询（`SELECT is_admin FROM users WHERE email = ?`）；命中 `ADMIN_EMAILS` 时短路（不查库，保留破窗语义）。两处调用点改 `await`。

- [ ] **Step 4: 跑测试确认通过**

Run: `./node_modules/.bin/vitest run packages/web/src/__tests__/admin.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git commit -m "feat: recognize in-database admins alongside ADMIN_EMAILS"
```

---

### Task 8: `/setup` 加入公开路由（`proxy.ts`）

**Files:**
- Modify: `packages/web/src/proxy.ts`
- Test: `packages/web/src/__tests__/proxy.test.ts`（追加用例）

**Interfaces:**
- Produces: `isPublicRoute("/setup")` 为真。

**背景**：`isPublicRoute`（`proxy.ts:48-58`）不含 `/setup`，未登录访问会被 302 到 `/login`，向导永远进不去。

- [ ] **Step 1: 写失败测试**

追加：`expect(isPublicRoute("/setup")).toBe(true);` 且断言 `/setup/anything` 也为真（前缀匹配）。

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（在 `isPublicRoute` 的公开前缀集合里加 `/setup`）→ **Step 4: 确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "fix: allow /setup through the auth proxy for first-run onboarding"
```

---

### Task 9: 密码重置路径

**Files:**
- Create: `packages/web/src/app/api/admin/users/[userId]/reset-password/route.ts`
- Create: `deploy/selfhost/reset-password.ts`（破窗脚本）
- Modify: `packages/web/src/auth.ts`（JWT 携带 `pwd_v`，`sessionCallback` 比对）
- Test: `packages/web/src/__tests__/reset-password.test.ts`

**Interfaces:**
- Produces: 管理员生成一次性重置令牌（写 `password_resets`）；用户凭令牌设新密码；破窗脚本直连 rqlite 更新 `password_hash`。

**背景**：项目无任何邮件能力（已核验无 nodemailer 等依赖）。故令牌由管理员**线下**交付。`pwd_v`（`password_hash` 短前缀）进 JWT，改密后旧 token 失效（spec §4.4 缺口二）。

- [ ] **Step 1–5**：TDD——断言令牌写入/校验/过期/一次性；断言 `sessionCallback` 在 `pwd_v` 不匹配时判会话失效。破窗脚本 `deploy/selfhost/reset-password.ts` 用 `createD1Adapter` + `hashPassword`，参数 `--email`。提交 `feat: add admin-initiated password reset and pwd_v session invalidation`。

---

### Task 10: CLI 指向自建 host（`--host` / `PEW_HOST` / 凭据隔离）

**Files:**
- Modify: `packages/cli/src/commands/login.ts`
- Modify: `packages/cli/src/config/manager.ts`
- Test: `packages/cli/src/commands/__tests__/login.test.ts`（或既有）

**Interfaces:**
- Produces: `resolveHost` 优先级 `--host` > `PEW_HOST` > 现有 dev/DEFAULT；自建 host 用独立配置文件（`config.<host>.json`），不覆盖 `config.json`。

**背景**：`ConfigManager` 生产/开发共用 `config.json`/`config.dev.json`，不按 host 区分（spec §4.5）。

- [ ] **Step 1–5**：TDD——断言 `--host` 覆盖、`PEW_HOST` 次之；断言不同 host 落到不同配置文件。提交 `feat: cli --host/PEW_HOST support with per-host credential isolation`。

---

### Task 11: 端到端验证与部署文档

**Files:**
- Modify: `deploy/selfhost/README.md`（登录流程、`/setup`、密码重置、限速前提）
- Modify: `docs/57-self-hosted-deployment-design.md`（把 §4.4 从「Plan 2 规格」改为「已实现」）

**Step 1: 全栈端到端**（真实 compose）：

```bash
cd deploy/selfhost && cp .env.example .env  # 替换密钥，AUTH_SECRET 等
docker compose up -d --build
# 1. /setup 可达（未登录 200，非 302）
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7020/setup
# 2. 完成向导后用新凭据访问 /login；库非空时再次 POST /api/auth/register 返回 400（无 302 门，见 Task 3 实现更正）
# 3. 用管理员登录，验证 __Secure- 在 USE_SECURE_COOKIES=false 下不出现
# 4. 生成邀请码 -> 第二个用户注册 -> 登录
```

**Step 2: 文档**：README 增「登录与初始化」小节；记录限速进程内限制与 `X-Forwarded-For` 前提。

**Step 3: 提交** `docs: document Plan 2 login, setup and password reset`

---

### Task 12: 上游同步回归（同 Plan 1 Task 11）

**Files:**
- Modify: `deploy/selfhost/README.md`（更新「合并上游」小节的接触面清单）

**Step 1–3**：更新接触面为 Plan 1（2 文件）+ Plan 2（10 文件）的并集；跑 `bun run test` 与 `docker compose build web && up -d` + `/api/live` 验证；确认 `packages/worker*` 仍零改动。提交 `docs: update upstream merge surface for Plan 2`。

---

## 交付边界

本计划完成后，自建部署具备**完整的浏览器登录闭环**：`/setup` 首个管理员 → 邀请码邀请后续用户 → 邮箱密码登录 → 管理员重置密码。**外网/邮件自助重置**不在本期（无 SMTP），密码重置为管理员线下交付令牌。多 web 副本时登录限速退化为按副本计（进程内状态），需外部化或接受弱化。`pwd_v` 校验每次会话多一次 weak 读。
