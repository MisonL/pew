# pew 私有化部署支持 — 设计文档

- 日期：2026-10-10
- 分支：`feat/self-hosted-deployment`（基线 `0d8f26bb`，官方 v3.3.0）
- 状态：待评审

## 1. 目标与背景

pew 官方形态依赖 Cloudflare：Web（Next.js）读写经两个 Cloudflare Worker，数据存 D1，登录用 Google OAuth。本设计让 pew 能部署在自有基础设施上，不依赖任何 Cloudflare 服务。

### 成功标准

1. 一套 compose 能在自有服务器/内网跑起完整 pew（Web + 读服务 + 写服务 + 数据库），功能与官方一致。
2. 局域网客户端（CLI）能指向自建服务完成登录与同步。
3. 数据可多副本、可故障切换、可备份。
4. **上游代码保持可同步**：不改动上游 SQL 与 Worker 业务逻辑，上游更新可合并。

### 非目标

- 不接入企业现有 PostgreSQL 运维体系（评估后选择保留 SQLite 方言）。
- 不构建「AI Agent 治理平台」所需的策略执行、RBAC、审计留痕等能力（另立项目）。
- 不改动数据模型与业务语义。

## 2. 约束（已确认决策）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 与上游关系 | **保同步** | 适配层吞差异，上游 SQL 一行不改 |
| 替换层次 | **运行时适配** | 不改 Worker 逻辑，只换运行时与存储 |
| 存储引擎 | **rqlite** | 实测 SQL 零改动、原生原子事务、HA 开箱可用、MIT、活跃维护 |
| 登录方式 | **邮箱 + 密码** | 自包含，无外部依赖；Google OAuth 不接受内网 http 回调 |
| CLI 支持 | **加 `--host` / 环境变量** | 客户端才能真正指向自建服务 |
| 部署形态 | **多容器 compose** | Web / 读服务 / 写服务 / rqlite 各自独立 |

### 存储选型的实测依据

rqlite 与 libSQL 的评估结论（实测 + 文档核验）：

| 维度 | rqlite | libSQL/sqld |
|---|---|---|
| SQL 兼容 | 133/133 迁移通过，12 触发器全建成 | 支持 |
| batch 原子性 | 原生 `?transaction=true`，实测真回滚 | 协议层仅保证顺序，需自行包事务 |
| 批量写吞吐 | 8,889–16,853 写/s | 3,413–6,061 写/s |
| 故障切换 | 实测 1.85s 自动切换 | 无自动 failover、无官方 operator |
| 维护状态 | v10.5.3（2026-10 发版），2014 至今活跃 | **功能冻结**：服务端最后 release 2025-02-14，近一年仅改注释；自托管文档 404 |
| 未修复缺陷 | 无同等级问题 | #2271 并发 checkpoint 下静默丢写、#2286 写锁卡死、#2254 掉电损坏 |

libSQL 因维护主体缺失与数据正确性缺陷被否决。

## 3. 架构

### 3.1 目标拓扑

```
┌─ web 容器 ──────────────────────────────────┐
│ Next.js standalone（本分支构建，业务逻辑零改动）│
│  · 读 → WORKER_READ_URL   （HTTP）           │
│  · 写 → D1_BASE_URL       （D1 REST 形状）   │
│  · 摄入 → WORKER_INGEST_URL（HTTP）          │
└──────────────────────────────────────────────┘
        │                  │                │
        ▼                  ▼                ▼
┌─ read 容器 ────┐  ┌─ ingest 容器 ─┐  ┌─ d1-http 容器 ─┐
│ worker-read    │  │ worker        │  │ D1 REST 形状   │
│ 原样运行        │  │ 原样运行       │  │ → rqlite      │
│ + node:http    │  │ + node:http   │  └────────────────┘
│ + D1 形状适配   │  │ + D1 形状适配  │           │
│ + KV→SQLite    │  └───────────────┘           │
└────────────────┘          │                   │
        └───────────────────┴───────────────────┘
                            ▼
                  ┌─ rqlite 集群（1 或 3 节点）─┐
                  │ 持久卷 + Raft 复制          │
                  └────────────────────────────┘
```

### 3.2 关键设计原则

**Worker 业务逻辑零改动。** `packages/worker` 与 `packages/worker-read` 的 `fetch` 处理器是标准 `Request → Response` 形状，套一层 `node:http` 适配即可在 Node 运行，不触碰其内部实现。

**Web 逻辑零改动，但需 6 处上游文件的最小改动。** Web 的业务逻辑不变，但存储与认证的接缝必须动（完整清单见 §4.7）：

| 上游文件 | 改动 | 原因 |
|---|---|---|
| `packages/web/src/lib/d1.ts` | 新增可配置 base URL（约 3 行） | 现有唯一本地开关 `PEW_LOCAL_D1_URL` 被生产守卫锁死，见 §4.1 |
| `packages/web/src/auth.ts` | 新增 Credentials provider；cookie 开关增加显式关闭分支；`session.maxAge` | 邮箱密码登录 |
| `packages/web/src/app/login/page.tsx` | 按 provider 可用性条件渲染 + 密码表单 | 现有页面硬编码 `signIn("google", …)`，不加表单则无登录入口 |
| `packages/cli/src/commands/login.ts` | `resolveHost` 增加 `--host` / `PEW_HOST` 优先级 | CLI 指向自建服务 |
| `packages/cli/src/config/manager.ts` | 自建 host 用独立配置文件 | 否则覆盖用户在 pew.md 的登录态（§4.5） |
| `scripts/migrations/` | **仅新增**一个迁移文件（`password_hash`），不改既有文件 | 凭据存储 |

**不改动的上游文件**（刻意规避）：`Dockerfile`、`bun.lock`、根 `package.json`、`.dockerignore`、`biome.json`、`cli.ts`、`proxy.ts`、`packages/worker/**`、`packages/worker-read/**`。规避方式见 §4.7。

**差异全部收敛在适配层。** 新增代码只存在于新目录 `deploy/selfhost/`，且**不注册为 workspace package**（避免改 `bun.lock` 与 `Dockerfile`）。

## 4. 组件设计

### 4.1 `deploy/selfhost/d1-adapter` — D1 形状适配层

实现 Cloudflare D1 绑定接口，底层接 rqlite。接口形状必须**按实际调用点**定义，不能按直觉简化：

```ts
interface D1PreparedStatementLike {
  bind(...params: unknown[]): D1PreparedStatementLike;
  all<T>(): Promise<D1Result<T>>;
  first<T>(column?: string): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
}

interface D1Like {
  prepare(sql: string): D1PreparedStatementLike;          // 必须自带 all/first/run
  batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1Result<T>[]>;  // 入参是语句对象
}

interface D1Result<T> {
  success: true;                    // 调用方会检查，必填
  results: T[];
  meta: { changes: number; duration: number; last_row_id?: number };
}
```

**接口形状的三个实测约束**（按直觉写会直接报错）：

1. `prepare()` 必须**同时**返回 `bind`/`all`/`first`/`run`——生产代码有 4 处直接 `db.prepare(sql).first()/.run()`，不经 `bind`（如 `packages/worker-read/src/index.ts:103`、`leaderboard-snapshot.ts:23`、`rpc/live.ts:196`、`packages/worker/src/index.ts:208`）。
2. `batch()` 入参是**语句对象数组**，不是 `{sql, params}` 字面量；且数组里**混有未 bind 的语句**（`packages/worker-read/src/leaderboard-snapshot.ts:77-94`）。适配层必须能从未 bind 的语句对象里取出 SQL。
3. 结果必须带 `success: true`——`leaderboard-snapshot.ts:95` 检查 `results.some((r) => !r.success)`，缺字段即抛 "Leaderboard query failed"。

另有 `packages/worker-read/src/count-response.ts:28-44` 用 Proxy 包裹 `prepare` 返回值，仅透传**公开属性**（`Reflect.get`）。适配层的语句对象必须把 `sql`/`params` 暴露为公开可读属性，不能用私有字段（`#sql`）。

**rqlite 映射**（每一条都是实测确认的坑）：

| D1 语义 | rqlite 实现 | 注意 |
|---|---|---|
| 参数编码 | **扁平数组 `[sql, p1, p2]`** | **不是**嵌套 `[sql, [p1,p2]]`。实测嵌套形式在 `/db/query` 下静默返回空结果、在 `/db/execute` 下报 `unsupported type string`——这是最容易静默出错的陷阱 |
| `prepare().all()` | `POST /db/query?associative` | 带 `associative` 时响应 `rows` 为对象数组，即 D1 的 `results`（不带时是 `columns`+`values`） |
| `prepare().run()` | `POST /db/execute?associative` | 写语句必须走 execute；`/db/query` 对写语句返回错误「attempt to change database via query operation」 |
| **`batch()`** | **`POST /db/request?transaction=true&associative`** | **两个参数都必需**，见下方专项说明 |
| `meta.changes` | `rows_affected` | **字段在值为 0 时被省略**（实测 `UPDATE` 影响 0 行时只返回 `last_insert_id`），必须 `?? 0` |
| `meta.duration` | rqlite 的 `time`（秒） | 需换算为毫秒；且需 `?timings` 才有值 |
| `meta.last_row_id` | `last_insert_id` | 只读语句上该值是上一条的残留值，需甄别 |
| DDL | `POST /db/execute?norwtime&norwrandom` | 见下方「DDL 冻结」专项；DDL 返回空对象 `{}`，无 `rows_affected` |
| 错误 | **HTTP 仍为 200** | 必须逐条检查 `results[i].error` 并抛错，否则静默吞错 |
| 空批 | 短路返回 `[]` | rqlite 对空数组返回 HTTP 400 `no statements`；D1 的 `batch([])` 返回 `[]`（`packages/web/src/lib/d1.ts:115` 也如此兜底） |

**专项一：`batch()` 必须用 `/db/request`，不能用 `/db/execute`**

这是最隐蔽的阻塞点。实测同一批（SELECT / INSERT / SELECT）走 `/db/execute?transaction=true` 的返回：

```
[{"last_insert_id":1,"rows_affected":1}, {"last_insert_id":2,"rows_affected":1}, {"last_insert_id":2,"rows_affected":1}]
```

**普通 SELECT 的行完全丢失且不报错**（rqlite 只对带 RETURNING/EXPLAIN 的语句走查询路径）。而走 `/db/request?transaction=true&associative`：

```
[{"types":{...},"rows":[{"k":"a","n":1},{"k":"b","n":2}]}, {"last_insert_id":3,"rows_affected":1,"rows":null}, {"types":{"c":"integer"},"rows":[{"c":3}]}]
```

行完整返回，且失败时真回滚。项目里有两处 batch 混用读写，都会因此静默失效：

- `packages/worker/src/accounting-sql.ts:44-51`：UPSERT 与普通 SELECT 交错，取 `results[i*2+1].results[0]` → 得 `undefined` → 解构 `state[k]` 抛 TypeError → `/ingest/details` 每条记录 500
- `packages/worker-read/src/leaderboard-snapshot.ts:77-95`：4 条全 SELECT → 行恒空，快照恒空

**专项二：DDL 中的非确定函数会被 rqlite 冻结成常量**

rqlite 为保证 Raft 各副本结果一致，会把 DDL 文本里的非确定函数**替换成字面量**再写入 `sqlite_master`。实测：

```sql
-- 迁移原文
created_at TEXT NOT NULL DEFAULT (datetime('now'))
CREATE TRIGGER ... BEGIN UPDATE ... SET v = lower(hex(randomblob(16))); END

-- 执行后 sqlite_master 里实际存的内容
created_at TEXT NOT NULL DEFAULT (datetime(2461323.790611))          -- 固定儒略日
CREATE TRIGGER ... BEGIN UPDATE ... SET v = lower(hex(x'25A0D378B54E643D65D72E4116F03450')); END   -- 固定常量
```

**后果是静默的、影响面很广**：

- `scripts/migrations/029-leaderboard-revision.sql` 的 12 个触发器体全用 `randomblob(16)` → revision 永不变 → 排行榜快照失效（`leaderboard-snapshot.ts:122-144` 的比对恒等，最长 10–30 分钟不刷新）
- 14 个迁移文件里的 41 处 `DEFAULT (datetime('now'))` 全部等于迁移时刻 → `users.created_at`、`invite_codes.created_at`、`season_teams.registered_at` 等全错（`auth-adapter.ts:36` 与 `api/admin/invites/route.ts:100` 都省略 created_at 依赖默认值）

**修法（实测有效）**：迁移执行时带 `?norwtime&norwrandom`，DDL 文本原样保留。

**但引入一个取舍**：解冻后触发器体内的 `randomblob()` 会在各副本**各自计算**，多节点间 revision 值不一致。单节点无影响；多节点下 rqlite 官方建议是「不要依赖默认时间戳与非确定函数」。因此：

- 单节点部署：用 `?norwtime&norwrandom`，行为与 D1 一致
- 多节点部署：需要改造（例如把 revision 生成移到应用层，或接受各副本 revision 不同）——**列为待决项**

**专项三：REST 外形（d1-http）的响应必须合成 D1 形状**

`packages/web/src/lib/d1.ts:143-170` 要求顶层 `{success, result:[{success, results, meta}], errors}`，而 rqlite 既无顶层 `success`/`errors`，也无每语句 `success`。若 shim 直接透传：

- `data.success` 为 undefined → `d1.ts:163` 抛错
- 漏 `meta` 时 `d1.ts:100/124` 兜底 `{changes:0}` → `invite.ts:147`、`cli-upgrade-notice/route.ts:16` 的 `changes === 0` 判断会把**每个邀请码都当成已用**

另需处理：rqlite 在事务模式下出错时 **results 数组会被截断**（实测 3 条语句第 2 条坏，只回 2 条），而 `d1.ts:119` 校验 `data.result?.length !== statements.length` 会先抛 "Invalid D1 batch result"，真实 SQL 错误被掩盖。shim 必须补齐数组长度并透出错误信息。

**专项四：Web 写路径的可配置 base URL（对应 §4.7 的 `d1.ts` 改动）**

`D1Client` 构造时（`packages/web/src/lib/d1.ts:79-80`）只有两条路：设 `PEW_LOCAL_D1_URL`（生产下守卫直接 `throw`），或拼死 `api.cloudflare.com`。**没有任何环境变量能把写路径指到自建 d1-http**——这是「Web 零改动」不成立的根本原因。

需新增一个生产可用的覆盖（如 `D1_BASE_URL`），不放在 `localD1BaseUrl` 的测试守卫分支内。

**多节点与故障切换**：适配层维护节点地址池，遇 503 `leader not found` 或连接失败时轮换重试。rqlite 的 follower 会服务端透明转发写给 leader，客户端无需感知 leader 身份。

**读一致性**：rqlite 默认 `weak`（可能读到约 1s 陈旧数据），D1 主库是强一致。写入原子性不受影响（Raft 单 leader 串行），但 `leaderboard-snapshot.ts:123/143` 的「读 revision → 构建 → 再读 revision」会因读不一致更容易走到 "Leaderboard changed during read"。需显式规定 `?level=` 取值。

**版本要求**：**必须 ≥ v10**。v9.x 存在「batch 中带 RETURNING 的语句失败时事务不回滚」的缺陷，而本项目在 batch 中混用了 RETURNING（`packages/worker/src/accounting-sql.ts:24`、`packages/web/src/app/api/teams/[teamId]/route.ts:256,272`）。

**其它实测结论**：`CURRENT_TIMESTAMP` 会被 rqlite 引号化成字符串字面量，禁止在迁移与业务 SQL 中使用；rqlite HTTP 默认超时 30s；`D1Meta` 在 workers-types 里字段多为必填，适配层应 `as unknown as D1Database` 而非强造型。

### 4.2 `deploy/selfhost/kv-adapter` — KV 形状适配层

`worker-read` 通过 `env.CACHE` 使用 KV。**实测真实调用点是 13 处**（不是 5 处——`index.ts:161,175,177,183,257` 那 5 处只是把 `env.CACHE` 传递下去的赋值，真正的方法调用分布在 `cache.ts`、`sync/kv-store.ts`、`leaderboard-snapshot.ts`）。

用 SQLite 表实现：

```sql
CREATE TABLE kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT
);
```

**接口必须覆盖的实际用法**（按简化接口实现会静默出错）：

| 实际调用 | 位置 | 只用简化接口的后果 |
|---|---|---|
| `get(key, "json")` | `cache.ts:58`、`kv-store.ts:43` | — |
| **`get(key, "text")`** | `leaderboard-snapshot.ts:127` | 不支持 "text" 则返回对象，`JSON.parse` 抛错被吞 → **排行榜缓存永久失效**（每请求重建） |
| `put(key, value)` | `kv-store.ts:54,69,84` | — |
| **`put(key, value, { expirationTtl })`** | `cache.ts:72`、`kv-store.ts:114`、`leaderboard-snapshot.ts:139` | 忽略 options → **TTL 不生效**：seasons 列表 10 分钟缓存变永久（改赛季名永不刷新）、pricing last-fetch 7 天兜底永不失效 |
| **`list({prefix, limit: 1000, cursor})` → 必须返回 `{keys:[{name}], list_complete, cursor}`** | `cache.ts:101-127,152-178` | 缺 `list_complete`/`cursor` → 翻页循环反复取同一页：`clearAllCache`/`listAllCacheKeys` 的 `deleted` 计数恒等、`truncated` 判错 |
| `delete(key)` | `cache.ts:164,195` | — |

**未使用的部分**（确认无需实现）：`getWithMetadata`、`arrayBuffer`、`stream`。

**读侧过期过滤**：`kv_cache.expires_at` 必须在 `get` 时过滤，否则 TTL 形同虚设。写入时把 `expirationTtl`（秒）换算为绝对时间戳。

**体积与超时**：KV 单值上限 24MB（`kv-store.ts:32`）需经 rqlite 传输；`cache.clear` 最多 10000 次逐条 Raft 写，需压测。

### 4.3 `deploy/selfhost/node-runtime` — Worker 运行时宿主

把 `export default { fetch, scheduled }` 挂到 `node:http` 上：

- `fetch` → 标准 `Request`/`Response` 转换（Node 22 原生支持 Web 标准）
- `scheduled`（worker-read 的定价同步 cron）→ 进程内定时器或独立调度容器
- `env` 注入：`DB`（D1 形状适配）、`CACHE`（KV 形状适配）、各 secret

**Web 侧注意**：官方镜像的 `server.js` 硬写 `process.env.NODE_ENV = 'production'`，无法用环境变量覆盖。这是 §4.4 中多个「生产守卫」问题的共同根因。

**请求体大小**：Cloudflare Workers 单请求体上限 100MB，Node 的 `node:http` 默认无上限但内存压力更大；CLI 批量上传（`runUpload`）单次可能很大，适配层需与 CLI 分批策略对齐，并限制单请求体（如 32MB）防止 OOM。

### 4.4 认证：邮箱 + 密码

**为什么不能复用现有邀请闸门（复核新发现，原草案判断错误）**

`handleInviteGate`（`lib/invite.ts:94-154`）用 `getUserByOAuthAccount(account.provider, account.providerAccountId)` 判断「老用户」（`invite.ts:119`）。但 `accounts` 表（`001-init.sql:23-28`）只由 OAuth 的 `linkAccount` 写入（`auth-adapter.ts:64-83`），**凭据用户从不写 accounts**。于是 `provider="credentials"` 时该查询恒为 null → 每次登录都被当作新用户 → 要求邀请码 → **老用户第二次登录即被锁死**。且 `signIn` 回调只能从 cookie 读 `pew-invite-code`，而凭据登录的邀请码在**表单体**里，读不到。

结论：**注册与登录都在 Credentials 自己的路径内完成**，`signIn` 回调对 `provider === "credentials"` 直接放行，邀请闸门逻辑重写在新文件里，不改 `lib/invite.ts`。

**改动点（`packages/web/src/auth.ts`，上游文件）**

1. `providers` 由字面量 `[Google]`（`auth.ts:82`）改为按环境条件组装：`AUTH_GOOGLE_ID` 缺失则不挂 Google，另挂 `Credentials`。
2. `signIn` 回调（`auth.ts:143-157`）开头增加 `if (account?.provider === "credentials") return true;`。
3. `shouldUseSecureCookies()`（`auth.ts:21-27`）增加显式关闭分支（见下）。
4. `session.maxAge` 收紧（当前未配置 = Auth.js 默认 30 天）。

**新增文件（不改上游）**

- `packages/web/src/lib/credentials.ts` — scrypt 生成/校验、注册逻辑
- `packages/web/src/app/api/auth/register/route.ts` — 注册端点（校验并消费邀请码 → 建用户 → 写 `password_hash`）

**密码哈希（scrypt，实测参数陷阱）**

- **必须显式传 `maxmem`**。实测 `scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1 })` 在默认 `maxmem = 32 MiB` 下抛 `Invalid scrypt params`：OpenSSL 需求 `128*N*r + 128*r*p = 33,555,456` 字节 > `33,554,432`。修法：`maxmem: 64*1024*1024`，或降到 `N = 16384`。
- 存储格式 `scrypt$N$r$p$<salt_b64>$<hash_b64>` 单列，便于日后调参。
- **用户不存在时也做一次等价 dummy 校验**，避免通过响应时间枚举邮箱。
- 迁移：`ALTER TABLE users ADD COLUMN password_hash TEXT`（现有 `users` 无任何 password 字段，已核验）。

**password_hash 的读取路径（避免改 worker-read）**

`DbRead` 接口（`lib/db.ts:62-446`）没有任何返回 `password_hash` 的方法，worker-read 的 RPC 方法集也固定；给读路径加方法要同时改 `db.ts`、`db-worker.ts`、worker-read 三处。**改为走 D1 REST 原始查询**：`getD1Client().query("SELECT id,email,password_hash,name,is_public FROM users WHERE email = ?", [email])`（`lib/d1.ts:90-102`；自建下 `D1_BASE_URL` 指向 d1-http）。这样 `worker-read` 与 `db.ts` 均不改。

**注册与引导的死锁（chicken-egg）**

`invite_codes.created_by TEXT NOT NULL REFERENCES users(id)`（`001-init.sql:109`）→ 无用户则建不了邀请码；`require_invite_code` 默认 true 则无邀请码建不了用户。**死锁**。处置：新增 `deploy/selfhost/bootstrap-admin`，部署时直接插入首个用户（含 `password_hash`）与首个邀请码，绕过闸门；首个管理员由 `ADMIN_EMAILS` 邮箱匹配识别（`lib/admin.ts`）。

**暴力破解防护**

Credentials 无内建限速。在 `authorize()` 内复用现有 `lib/rate-limit.ts`：`inMemoryRateLimiter.check()` + `getClientIp()`，按 `login:<ip>` 与 `login:<email>` 双键限速（如 5/min、20/h）。两个前提必须写进部署文档：

- `inMemoryRateLimiter` 是**进程内**状态（`rate-limit.ts:35-36` 注释明示「仅适用单实例」）——多 web 容器时限速不跨实例，需外部化或接受弱化。
- `getClientIp` 信任 `X-Forwarded-For`（`rate-limit.ts:180-194`）——反向代理必须**清洗/覆写**该头，否则可伪造绕过。

**AUTH_SECRET 与构建期密钥**

Dockerfile 在 **builder 阶段**以 `ARG/ENV` 注入 `AUTH_SECRET`（`Dockerfile:40,46`）；最终 **runner 阶段**（`59-72`）不含这些 ENV，故**最终镜像不带密钥**。但**构建期传入的真实密钥会留在构建层缓存/历史**。故：自建构建**不得**用真实密钥做 build arg，密钥一律运行期经 compose `env_file` 注入。另：Dockerfile 注释（`33-34`）称构建期需要这些变量做 page data collection——**哪些变量被内联进构建产物需实测确认**（列入验证项）。

**HTTP 内网 cookie（必须处理）**

`shouldUseSecureCookies()`（`auth.ts:21-27`）在 production 下返回 true，镜像硬编码 production（Next standalone 生成的 `server.js` 写入 `process.env.NODE_ENV='production'`）→ 内网 http 下浏览器丢弃 `__Secure-` cookie → 登录态丢失。`USE_SECURE_COOKIES` 目前只能往「开」覆盖，需增加 `USE_SECURE_COOKIES === "false"` → 返回 false 的显式关闭分支。

**更正**：原草案称「需同步调整 `proxy.ts` 的 origin 推导」——**不成立**。`proxy.ts` 不依赖 cookie 名，只依赖 `NEXTAUTH_URL`（`proxy.ts:13-24` 的 `TRUSTED_ORIGIN`，协议取自 `NEXTAUTH_URL`，`buildRedirectUrl` 不读 `X-Forwarded-Proto`）。只要 `NEXTAUTH_URL` 设为实际访问地址（含 `http://`）即可，`proxy.ts` 无需改动。

### 4.5 CLI：支持指向自建服务

- `resolveHost(dev)`（`commands/login.ts:21-23`）改为接受选项对象，优先级：`--host` 参数 > `PEW_HOST` 环境变量 > 现有 `dev`/`DEFAULT_HOST` 逻辑
- 影响点：`packages/cli/src/cli.ts:389,556`（两处调用）、`packages/cli/src/commands/login.ts`
- 上传路径（`runUpload` / `runSessionUpload`）沿用同一 host 解析

**凭据隔离（复核新发现）**：`ConfigManager` 生产写 `~/.config/pew/config.json`、dev 写 `config.dev.json`（`config/manager.ts:4-5`），**没有按 host 区分**。自建 host 若复用 `config.json`，会**覆盖**用户在 pew.md 的登录态（反之亦然）。→ 自建 host 使用独立配置文件（如 `config.<host>.json`），需小幅修改 `config/manager.ts`（上游文件）或在 host 解析处派生文件名。

**登录流程本身无需改动**：浏览器流程经 `/api/auth/cli`（`route.ts`）——要求浏览器已有会话，然后下发 `pk_` 前缀的 `api_key`（`route.ts:104-113`）。凭据登录建立的会话同样满足，流程照旧。注意 `/api/auth/cli` 的回调 origin 取自 `NEXTAUTH_URL`（`route.ts:31-37`），自建下必须正确设置。限速 `AUTH_CLI_RATE_LIMIT`（10 次/时/IP）沿用。

### 4.6 部署编排

`deploy/selfhost/docker-compose.yml`：

| 服务 | 说明 | 端口 |
|---|---|---|
| `rqlite` | 1 节点（默认）或 3 节点（profile 切换），持久卷，**必须带 `-fk`** | 仅内网 4001/4002 |
| `d1-http` | D1 REST 形状 HTTP 服务（无状态） | 仅内网 |
| `read` | worker-read 宿主 | 仅内网 |
| `ingest` | worker 宿主 | 仅内网 |
| `web` | **本分支构建的镜像**（同一 `Dockerfile`），注入指向上述服务的环境变量 | 对外 7020 |

**更正**：web 不是 Docker Hub 上的「官方镜像」——本方案改了 `auth.ts` 等上游文件，必须用本分支源码构建（仍复用上游 `Dockerfile`）。

**rqlite 关键启动参数**：

```
-fk                       # 必须：外键默认关闭，而 schema 有 12 处 ON DELETE CASCADE
-bootstrap-expect=3       # 仅首次集群启动设置一次
-join <peers>             # 集群模式
-node-id <stable-id>      # 集群模式下不可变
```

**编排必须补齐的工程项（复核新增，原草案缺失）**：

- **资源限制**：`deploy.resources.limits`（memory/cpus）。rqlite 与 d1-http 内存占用随批量写入增长；web 是 Node standalone。
- **健康检查 + 依赖顺序**：`web`→`/api/live`；`read`→`/api/live`；`rqlite`→`/status`；`d1-http`→`/health`。`depends_on` 用 `condition: service_healthy`，避免 web 在 rqlite 就绪前启动导致迁移/健康检查失败。
- **端口暴露**：只有 web 的 7020 对外；read/ingest/d1-http/rqlite 一律不发布到宿主，仅 compose 网络内可达（服务名解析）。
- **日志**：`json-file`，`max-size: 10m`、`max-file: 3`（官方部署已验证此配置）。
- **密钥注入**：`env_file`（不入版本库）或 docker secret；见 §4.4 关于 AUTH_SECRET 的约束。
- **迁移执行**：web 启动前需先对 rqlite 应用迁移（见 §6），可用一次性 init 容器。
- **数据卷**：仅 rqlite 需要持久卷（数据）；d1-http/read/ingest/web 无状态。
- **网络**：单 bridge 网络。

**外部依赖（自建下需要出网或降级的能力，详见 §9）**：R2/S3（团队与组织 logo）、`hexly.ai`（首页分享数据 SSR）、OpenRouter 与 models.dev（动态定价同步）、npm registry（构建 `@nocoo/*` 依赖）。

### 4.7 改动面（上游文件清单）

**修改的上游文件（6 个，改动尽量小）**

| 文件 | 改动 |
|---|---|
| `packages/web/src/lib/d1.ts` | 新增生产可用的 D1 base URL 覆盖（约 3 行，见 §4.1 专项四） |
| `packages/web/src/auth.ts` | providers 条件组装、`signIn` 对 credentials 放行、cookie 显式关闭分支、`session.maxAge` |
| `packages/web/src/app/login/page.tsx` | 按 provider 条件渲染 + 邮箱/密码注册登录表单 |
| `packages/cli/src/commands/login.ts` | `resolveHost` 支持 `--host` / `PEW_HOST` |
| `packages/cli/src/config/manager.ts` | 自建 host 使用独立配置文件（见 §4.5） |
| `scripts/migrations/` | **新增**一个迁移文件（加 `password_hash`），不改既有文件 |

**新增文件（全部在既定目录，不触碰上游代码）**

- `packages/web/src/lib/credentials.ts`、`packages/web/src/app/api/auth/register/route.ts`
- `deploy/selfhost/`：`d1-adapter`、`kv-adapter`、`node-runtime`、`d1-http`、`docker-compose.yml`、`bootstrap-admin`、迁移执行器

**刻意不改的上游文件**：`packages/worker/**`、`packages/worker-read/**`、`lib/db.ts`、`lib/db-worker.ts`、`lib/db-rest.ts`、`lib/invite.ts`、`lib/auth-adapter.ts`、`proxy.ts`、`lib/r2.ts`、`next.config.ts`、`Dockerfile`、`bun.lock`、根 `package.json`、`biome.json`、`cli.ts`、`lib/rate-limit.ts`。

**适配层的运行方式**：`deploy/selfhost/*` 用 **bun 直接运行 TS 源码**（基础镜像已含 bun，`Dockerfile:7`），不引入新的构建工具或依赖——因而无需改 `bun.lock` 与 `package.json`。适配层通过相对路径导入 `packages/worker` / `packages/worker-read` 的入口。

## 5. 数据流

**写入（CLI 上传）**：CLI → `web:/api/ingest` → `ingest 容器` → `d1-http` → rqlite（批量 upsert，事务原子）

**读取（仪表盘）**：`web` → `read 容器` → `d1-http` → rqlite

**注册（首次）**：浏览器 → `web:/api/auth/register` → 校验并原子消费邀请码 → `INSERT users`（含 `password_hash`）→ 完成

**登录**：浏览器 → `web:/api/auth/callback/credentials` → Credentials `authorize()` → D1 REST 查 `password_hash` → scrypt 校验（+ 限速 + dummy 校验）→ JWT 会话

**CLI 登录**：CLI 打开浏览器 → `web:/api/auth/cli?callback=...`（需已有会话）→ 下发 `pk_` api_key → CLI 存本地

**定时任务**：`read 容器` 内定时触发动态定价同步（替代 CF cron trigger）；需出网访问 OpenRouter / models.dev，否则降级到 bundled baseline

## 6. 测试策略

| 层级 | 内容 |
|---|---|
| 适配层单元测试 | D1 形状映射（`rows_affected` 缺失兜底、错误在 HTTP 200 内、`duration` 换算、空批返回 `[]`）；KV `get(key,"text")`、`put` 带 TTL、`list` 分页 |
| 迁移兼容测试 | 全部 30 个迁移（33 个文件中跳过 3 个被 squash 的）apply 到 rqlite，断言 schema 对象数（23 表 / 62 索引 / 12 触发器 / 2 视图） |
| 迁移确定性测试 | 断言 DDL 执行后 `sqlite_master` 中 `datetime('now')` / `randomblob()` **未被冻结**（用 `?norwtime&norwrandom`） |
| 原子性测试 | batch 中夹坏语句，断言零残留 |
| 端到端 | compose 起全栈，跑通「注册 → 登录 → CLI 登录 → 同步 → 仪表盘可见」 |
| 上游同步回归 | 合并上游 main 后，上述测试全部通过 |

**迁移执行方式变更**：从 `wrangler d1 execute --file` 改为「读文件 → 按语句切分（正确处理 `CREATE TRIGGER ... BEGIN ... END`）→ 整批事务执行」，且 DDL 批必须带 `?norwtime&norwrandom`（见 §4.1 专项二）。

**迁移账本（复核新发现：上游无账本、无 down 迁移）**：上游没有迁移记录表，靠 `wrangler d1 migrations` 的本地状态文件跟踪。自建执行器必须自建 `_migrations(id TEXT PRIMARY KEY, applied_at TEXT)`，按文件名排序、跳过已应用项，保证**可重复执行**。注意多数迁移用 `CREATE TABLE IF NOT EXISTS` 幂等，但 `ALTER TABLE ADD COLUMN`（如本方案新增的 `password_hash`）**不幂等**，重复执行会报 `duplicate column`——账本正是为它而设。

**对上游既有测试的影响**：本分支新增 `password_hash` 列与 `deploy/selfhost/*`，不改上游行为，理论上现有测试不受影响；但 `auth.ts` 的 providers/回调改动会影响 `__tests__/auth*.test.ts`（6 个 auth 测试文件）——需在改 `auth.ts` 时同步验证这些测试仍通过（列为实现阶段的第一道回归）。

## 7. 风险与待决项

| 风险 | 说明 | 处置 |
|---|---|---|
| **无静态加密** | rqlite 不支持落盘加密 | 依赖加密文件系统（LUKS / 云盘加密）兜底；若合规硬性要求加密，需重新选型 |
| **无原生 Prometheus** | 2018 年的 issue 仍 open | 自写 exporter 抓 `/status`、`/debug/vars` |
| **无审计日志** | 无内建审计 | 靠 CDC 外接外部日志系统；属后续工作 |
| **RBAC 粗粒度** | 仅按端点的权限位 | 多租户隔离在应用层做 |
| **bus factor = 1** | 单人维护，无商业支持 | 接受；MIT 许可下可自行 fork |
| **写不水平扩展** | Raft 单 leader 串行 | 批量路径实测数万行/秒，量级足够 |
| **Web 需小幅改动** | 认证与 cookie 开关需改上游文件 | 改动面收敛为 §4.7 的 6 个文件，便于后续合并 |
| **多节点 DDL 非确定性**（§4.1 专项二） | 解冻 `randomblob` 后各副本 revision 不一致 | 单节点无此问题；多节点方案列为待决项 4 |
| **限速不跨实例**（§4.4） | `inMemoryRateLimiter` 是进程内状态 | 多 web 副本时限速弱化；需外部化（如 rqlite 表驱动）或保持单 web 实例 |
| **`X-Forwarded-For` 可伪造**（§4.4） | 信任代理头取 IP | 反向代理必须清洗/覆写该头，写入部署文档 |
| **构建期密钥泄漏面**（§4.4） | AUTH_SECRET 作为 build arg 留在构建层 | 密钥只经运行期注入；构建用占位值 |
| **外网依赖不达时降级**（§9） | 首页 SSR、动态定价同步、logo 上传依赖外网 | 明确降级路径（见 §9），或断网时禁用对应功能 |

### 待决项

1. **rqlite 节点数**：单节点（简单，无 HA）还是 3 节点（需 3 台机器或同机 3 容器，后者只防进程故障）。默认单节点 + 备份，生产建议 3 节点。
2. **首个管理员引导**：预置邀请码，还是部署时关闭 `require_invite_code` 后由首个注册者自动成为管理员（`ADMIN_EMAILS`）。（注：无论哪种，都需先解决 `invite_codes.created_by` 死锁，见 §4.4。）
3. **上游合并策略**：本分支改动集中在 `deploy/selfhost/` + 6 个上游文件小改动——需定期 rebase 验证；§4.7 的「不改文件」清单随上游更新需复核。
4. **多节点下的 DDL 非确定性**（§4.1 专项二）：`?norwtime&norwrandom` 解冻后，触发器体的 `randomblob()` 在各副本各自计算，revision 不一致。单节点无影响。选项：(a) 单节点用解冻、多节点保持冻结并改写 revision 生成到应用层；(b) 接受副本间 revision 不同（排行榜快照以读到的为准，可能多刷）。**需决策**。
5. **构建期变量是否被内联进构建产物**（§4.4）：Dockerfile 注释称 page data collection 需要 `CF_*`/`AUTH_SECRET`——哪些被 Next 内联需实测；确认前一律用占位值构建。

## 8. 备份与恢复

数据全部在 rqlite 单一 SQLite（持久卷），备份即备份这个文件。

- **备份方式**：rqlite 的 `backup` CLI / API 生成一致性快照（不能直接 `cp` 活跃文件）。定时任务（cron / systemd timer）导出到宿主目录或对象存储。
- **恢复**：停 rqlite → 恢复快照文件 → 启动。恢复后需验证 schema 对象数与迁移账本一致。
- **恢复演练**：纳入端到端测试——用备份恢复到空实例，跑通「登录 → 仪表盘可见」。
- **保留策略**：建议 7 天滚动 + 每月归档（待定，取决于数据量与合规要求）。
- **KV 适配层数据**（`kv_cache` 表）**在同一个库里**，随 rqlite 一起备份，无额外备份点；缓存类数据可容忍丢失。

## 9. 外部依赖清单（自建下的出网需求与降级）

| 依赖 | 用途 | 不可达时的降级 |
|---|---|---|
| R2 / S3（`CF_R2_*`） | 团队与组织 logo 上传（`lib/r2.ts`） | `parseConfig()` 在缺 env 时 **throw**（`r2.ts:43-47`）→ 需提供自建 S3（MinIO）或改「未配置即禁用上传」的降级分支，否则 logo 相关 API 500 |
| `next.config.ts` `images.remotePatterns` | 只允许 `s.zhe.to` 与 `lh3.googleusercontent.com`（`next.config.ts:18-27`） | 自建对象存储域名会被 `next/image` 拒绝 → 需按自建域名扩充 patterns（属 `next.config.ts` 改动，列入 §4.7 或改为运行期配置） |
| `hexly.ai/api/share/pew.json` | 首页 SSR 分享数据（`layout.tsx:43`） | fetch 失败需降级到默认值（复核时确认其容错）；断网部署需验证首页不崩 |
| `hexly.ai/og/pew.jpg`、`pew.md` metadata | OG 图与 canonical（`layout.tsx:53,66,73`） | 元数据失效，仅影响分享卡片 |
| OpenRouter `models.dev` API | worker-read 定价同步（`sync/orchestrator.ts:37-38`，20s 超时） | 回落 bundled baseline（`getDynamicPricing` 的 `servedFrom: "baseline"` 分支）——**已确认存在降级路径** |
| npm registry | 构建 `@nocoo/*` 依赖（`bun install`） | 构建期依赖，需预置 vendor 或内网镜像 |

## 10. 部署步骤（概要）

1. 构建：`docker build`（AUTH_SECRET 用占位值，其余 `CF_*` 同样占位）→ 得 `pew` 镜像
2. 准备 `.env`（§11 清单，真实密钥只写这里）
3. `docker compose up -d rqlite` → 健康后执行迁移（一次性 init 容器，`?norwtime&norwrandom`，幂等账本）
4. 执行 `bootstrap-admin`（建首个管理员 + 首个邀请码，绕过 `created_by` 死锁）
5. `docker compose up -d`（d1-http / read / ingest / web）
6. 验证：`/api/live` → 注册页 → CLI `--host` 登录 → 上传 → 仪表盘可见

## 11. 配置清单（`env_file` 必填项）

| 变量 | 说明 |
|---|---|
| `AUTH_SECRET` | 会话加密密钥，**运行期注入**，不入版本库 |
| `NEXTAUTH_URL` | 外部访问基址（`http://` 或 `https://`，决定 cookie 前缀与 `TRUSTED_ORIGIN`） |
| `USE_SECURE_COOKIES` | 内网 http 部署设 `false`（新增的显式关闭分支） |
| `D1_BASE_URL` | 指向 `d1-http` 的地址（新增的写路径覆盖） |
| `WORKER_READ_URL` / `WORKER_READ_SECRET` | 读路径（`read` 容器服务名 + 密钥） |
| `WORKER_INGEST_URL` / `WORKER_SECRET` | 写路径（`ingest` 容器服务名 + 密钥） |
| `ADMIN_EMAILS` | 管理员邮箱列表（`lib/admin.ts`） |
| `PEW_HOST` | （CLI 侧）指向自建服务 |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 可选；不配置则隐藏 Google 登录按钮 |
| `CF_R2_*` | 见 §9，可用 MinIO 替代 |
| `CF_ACCOUNT_ID` / `CF_D1_DATABASE_ID` / `CF_D1_API_TOKEN` | 自建下仅需非空占位（写路径已切 `D1_BASE_URL`）；构建占位值 |

## 12. 超出本设计范围

- 企业级 AI Agent 治理能力（策略、RBAC、审计、合规报表）
- 数据层迁往 PostgreSQL
- 多租户与组织级隔离增强
- 从 Cloudflare 形态迁移已有数据（如需，另行设计导出/导入）
- 完整的反向代理 / TLS 终结配置（写入部署文档，不进设计）
