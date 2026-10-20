# pew 私有化部署支持 — 设计文档

- 日期：2026-10-10
- 分支：`feat/self-hosted-deployment`（基线 `0d8f26bb`，官方 v3.3.0）
- 状态：已交付（Plan 1/2/3 全部实现，分支 feat/self-hosted-deployment）

## 1. 目标与背景

pew 官方形态依赖 Cloudflare：Web（Next.js）读写经两个 Cloudflare Worker，数据存 D1，登录用 Google OAuth。本设计让 pew 能部署在自有基础设施上，不依赖任何 Cloudflare 服务。

### 成功标准

1. 一套 compose 能在自有服务器/内网跑起完整 pew（Web + 读服务 + 写服务 + 数据库），功能与官方一致。
2. 局域网客户端（CLI）能指向自建服务完成登录与同步。**（实现更正 2026-10-20：交付时只做到了写入侧——`pew login --host X` 把 token 写进 per-host 文件，但 `pew sync` 仍读 `config.json`，该标准**当时并不成立**；已补齐见 §4.5「实现更正 2026-10-20」。同日补做了黑盒验收（隔离栈 `pew-cli-verify`、`WEB_PORT=7021`、随机密钥、复用当日 `pew-selfhost:local`/`pew:standalone` 镜像），全部通过：未登录时 `sync --host` 报 "Not logged in — skipping upload" 且不落任何 `config*.json`；`login --host --code` 成功且 `Token saved to config.localhost_7021.json`（不是 `config.json`）；入队 235 tokens → `sync --host` 上传 → rqlite `usage_records` 单行 235、归属引导管理员、device_id 与 `device.json` 一致；`/api/usage`、`/api/devices` 用该 token 各回 200；`logout --host` 清掉 per-host token 而**并存的 SaaS `config.json` token 原样保留**；logout 后再 `sync --host` 拒绝上传，库内容不增（幂等未被破坏）。验收用例 source 无效时报 `400 record[0]: invalid source "claude"` 时队列 offset/dirtyKeys **保留**，失败不留脏状态（附带观察）。）**
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
| 登录方式 | **邮箱 + 密码** | 自包含，无外部依赖；Google OAuth 不接受内网 http 回调（故 Plan 1 交付时**尚无可用登录方式**，见 §4.4 分期） |
| CLI 支持 | **加 `--host` / 环境变量** | 客户端才能真正指向自建服务 |
| 部署形态 | **多容器 compose，单节点默认 + 3 节点可选** | 同一 compose 用 profile 切换；两种模式共用同一套 SQL 行为（见 §4.1 专项二），单机可先单节点起步，扩容时加节点不改代码 |

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

**Web 逻辑零改动，但需 12 处上游文件的最小改动。** Web 的业务逻辑不变，但存储、认证与管理员判定的接缝必须动。按性质分五类（**逐文件清单见 §4.7**）：

| 类别 | 文件 | 改动 |
|---|---|---|
| **存储接缝** | `lib/d1.ts` | 新增可配置 base URL（现有 `PEW_LOCAL_D1_URL` 被生产守卫锁死，见 §4.1） |
| **认证接缝** | `auth.ts`、`app/login/page.tsx`、`app/api/auth/register`（新增）、`app/setup/`（新增） | Credentials provider、密码表单、注册向导 |
| **管理员判定** | `lib/admin.ts`、`app/api/admin/check/route.ts`、`app/api/users/[slug]/route.ts` | 判定并入库内 `is_admin`（首个用户即管理员，§4.4） |
| **多节点确定性** | （实现更正 2026-10-15：`lib/auth-adapter.ts`、`app/api/admin/invites/route.ts` 最终未改动——相关表均有 `DEFAULT datetime('now')`，专项五的 INSERT 场景无实际缺口） |
| **路由与 CLI** | `proxy.ts`、`cli/src/commands/login.ts`、`cli/src/config/manager.ts` | `/setup` 公开可达、`--host` 支持、凭据按 host 隔离 |

**不改动的上游文件**（刻意规避）：`bun.lock`、根 `package.json`、`biome.json`、`packages/worker/src/**`、`packages/worker-read/src/**`。规避方式见 §4.7。（实现更正 2026-10-14：为把 selfhost 适配层纳入编译期类型校验，两个 worker 包的 `tsconfig*.json`/`package.json` typecheck 脚本有 composite 声明构建改动——`src/` 业务代码与 SQL 仍零改动，见 `scripts/parallel-typecheck.sh`。另一处名单外改动：`.dockerignore` 增加 `**/.env` 与 `**/.rqlite-auth.json` 深度排除，防凭据进镜像层——安全修复，非规避对象。实现更正 2026-10-15：**`Dockerfile` 与 `cli.ts` 均已不在规避名单内**——`deploy/selfhost/Dockerfile` 已新增（见 §4.7 末段），根 `Dockerfile` 与 `packages/cli/src/cli.ts` 已按 Plan 2 交付项改动（`--host` / `PEW_HOST` 支持），与 §3.2 「路由与 CLI」行及 README「合并上游」小节的口径一致。）

**差异全部收敛在适配层。** 新增代码只存在于新目录 `deploy/selfhost/`，且**不注册为 workspace package**（避免改 `bun.lock` 与 `Dockerfile`）。（实现更正 2026-10-15：例外清单补一条——根 `Dockerfile` 也已按交付实现改动（builder 阶段改为 build-time 非密钥占位 ENV），不再属于零改动上游文件。）

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
| `prepare().run()` | `POST /db/request?transaction=true&associative` | 单语句写也走 request，与 batch 一致：`/db/execute` 会丢弃带 `RETURNING` 的行，且 `/db/query` 对写返回错误「attempt to change database via query operation」 |
| **`batch()`** | **`POST /db/request?transaction=true&associative`** | **两个参数都必需**，见下方专项说明 |
| `meta.changes` | `rows_affected` | **字段在值为 0 时被省略**（实测 `UPDATE` 影响 0 行时只返回 `last_insert_id`），必须 `?? 0` |
| `meta.duration` | rqlite 的 `time`（秒） | 需换算为毫秒；且需 `?timings` 才有值 |
| `meta.last_row_id` | `last_insert_id` | 只读语句上该值是上一条的残留值，需甄别 |
| DDL | `POST /db/execute?transaction=true&norwtime&norwrandom` | 见下方「DDL 冻结」专项；DDL 返回空对象 `{}`，无 `rows_affected`。`transaction=true` 使整个 DDL 批原子（实测：批内第二条失败则第一条不落库），避免迁移重放撞 `already exists` |
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

**专项二：非确定函数在多节点下的行为——实测三配置矩阵**

rqlite 用 statement-based replication（语句复制到各副本各自执行），并把 DDL/DML 文本里的非确定函数**替换成字面量**再写入 Raft 日志。这个改写**只作用于语句文本本身，不进入触发器体、也不进入列 DEFAULT 表达式**。因此在单节点与多节点下行为截然不同。

**测法说明（重要）**：rqlite 的 `weak` 与 `strong` 读在 follower 上**会转发给 leader**（响应头 `X-Rqlite-Served-By` 实证）。所以「在多节点分别读、看是否一致」用默认读是**测不出分叉的**——等于把 leader 读了三遍。唯一读各副本本地状态的是 `?level=none`，且需用 `docker pause` follower 制造复制延迟才能放大分叉。以下矩阵均用 `level=none` 直读本地 + 暂停 follower 跨秒重放得到。

| 配置 | 副本一致性 | 值正确性 | 说明 |
|---|---|---|---|
| **① 全冻结**（DDL/DML 都不带 norw） | ✓ | ✗ | `DEFAULT (datetime('now'))` 冻成迁移时刻的固定儒略日；12 个触发器体内的 `randomblob(16)` 冻成固定常量 → **触发器失效**（revision 永不变） |
| **② 全解冻**（都带 `?norwtime&norwrandom`） | ✗✗ | — | 触发器体与 DEFAULT 在各副本**各自求值**。实测暂停 follower 跨秒重放后：leader `09:18:56`、n2 `09:18:58`；revision 三副本得到 **3 种不同值** |
| **③ 解冻 + 确定性改造**（推荐） | ✓ | ✓ | 触发器改为 `seq` 计数器重放收敛；时间由应用层写显式字面量 |

**配置②的分叉是数据正确性级别，不只是缓存失效**：`leaderboard_revision` 各副本不同会持续扩散（各副本在不同状态上继续 apply 后续日志），且会打穿 `packages/web/src/app/api/leaderboard/route.ts:145-185` 的授权屏障——web 先读 revision 做授权判断、再比对快照里的 revision，不一致即拒绝返回 → **排行榜 API 在集群下抖动**。

**配置③的实测验证**（实验 K / 配置3）：暂停 follower，leader 连写 5 次（触发器每次递增 `seq`），恢复后三副本 `seq=5`、`revision=00000000000000000000000000000005` **完全一致**；时间列因由应用层以字面量写入，三副本也一致。

**因此本方案采用配置③，单节点与多节点共用同一套行为**：

1. **迁移 DDL 带 `?norwtime&norwrandom`**：schema 文本原样保留（实测三副本 schema 文本一致），触发器体不再被冻结成常量。
2. **触发器改为确定性**：新增一个**后置迁移文件**（不改上游 `029-leaderboard-revision.sql`），`DROP` 掉 12 个上游触发器，重建为 `seq` 计数器版本：
   ```sql
   CREATE TABLE leaderboard_revision_seq (id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
   INSERT INTO leaderboard_revision_seq VALUES (1, 0);
   -- 每个触发器的体改为：
   UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
   UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id=1)) WHERE id = 1;
   ```
   `printf('%032x', n)` 输出 32 位十六进制，满足 `leaderboard-snapshot.ts:18` 的 `/^[a-f0-9]{32}$/` 校验（实测通过）。语义变化：revision 从「随机」变为「单调递增」——调用方只做**相等比较**（`leaderboard-snapshot.ts:135,143`、`route.ts:185`），递增语义完全兼容。
3. **时间列由应用层写入**：见下方专项五。
4. **读一致性**：见下方「读一致性」段。

**单节点下这套方案无额外代价**：单节点无重放，配置③与配置①在单节点都「一致」，但配置③的值是正确的。因此**无需为单/多节点准备两套 SQL 或两套代码**，扩容只是加节点。

**专项三：REST 外形（d1-http）的响应必须合成 D1 形状**

`packages/web/src/lib/d1.ts:143-170` 要求顶层 `{success, result:[{success, results, meta}], errors}`，而 rqlite 既无顶层 `success`/`errors`，也无每语句 `success`。若 shim 直接透传：

- `data.success` 为 undefined → `d1.ts:163` 抛错
- 漏 `meta` 时 `d1.ts:100/124` 兜底 `{changes:0}` → `invite.ts:147`、`cli-upgrade-notice/route.ts:16` 的 `changes === 0` 判断会把**每个邀请码都当成已用**

另需处理：rqlite 在事务模式下出错时 **results 数组会被截断**（实测 3 条语句第 2 条坏，只回 2 条），而 `d1.ts:119` 校验 `data.result?.length !== statements.length` 会先抛 "Invalid D1 batch result"，真实 SQL 错误被掩盖。shim 必须补齐数组长度并透出错误信息。

**d1-http 必须鉴权（修正 §11 原先「token 仅需占位」的写法）**：d1-http 直接对 rqlite 读写，若不做校验，compose 网络内**任何**容器（含未来新增的、或被攻陷的 web）都能直写数据库。定位企业级部署，至少做**静态 Bearer 校验**：d1-http 校验 `Authorization` 与 `CF_D1_API_TOKEN` 相等（复用 web 已有的 Bearer 头机制，约 5 行），拒绝不符请求。`CF_D1_API_TOKEN` 因此是**真实密钥**（生成随机值），不再是占位。比较必须用**常量时间**（复用上游 `secureCompare` 模式），不要用 `!==`。

**rqlite 侧的「第二道屏障」在本计划（Plan 1）中未落地，如实记录**：本设计原写「rqlite 自身也配 `-http-auth` 或限制在 compose 网络内仅 d1-http 可达（双保险）」。实测两点均**未做**：

- 未配 `-http-auth`（compose 的 rqlite `command` 只有 `-fk`）；
- 也**不是**「仅 d1-http 可达」——`read`/`ingest`/`scheduler` 三个容器都**直连 rqlite**（不走 d1-http）。

即当前唯一屏障是「rqlite 不发布宿主端口 + d1-http 的静态 Bearer 保护 web→d1-http 这一跳」。若要真正加第二道屏障，需给 rqlite 配 `-http-auth` 并让上述三个直连服务同步带 token——列为后续强化项，不计入 Plan 1。

**token 投放范围据此收窄**：既然 `read`/`ingest`/`scheduler` 直连 rqlite、不经过 d1-http，compose 里这三个服务**不再注入 `CF_D1_API_TOKEN`**（原先照抄了 `web` 的 environment 块）。`CF_D1_API_TOKEN` 仅出现在 `d1-http`（校验方）、`web`（客户端）两处。（实现更正 2026-10-15：原文写三处、含 `migrate`——实际 migrate 已不消费该 token，只做 DDL，凭据走 `RQLITE_*`。）这同时缩小了密钥在容器内的暴露面。

**专项四：Web 写路径的可配置 base URL（对应 §4.7 的 `d1.ts` 改动）**

`D1Client` 构造时（`packages/web/src/lib/d1.ts:79-80`）只有两条路：设 `PEW_LOCAL_D1_URL`（生产下守卫直接 `throw`），或拼死 `api.cloudflare.com`。**没有任何环境变量能把写路径指到自建 d1-http**——这是「Web 零改动」不成立的根本原因。

需新增一个生产可用的覆盖（如 `D1_BASE_URL`），不放在 `localD1BaseUrl` 的测试守卫分支内。

**多节点与故障切换**：适配层维护节点地址池，遇 503 `leader not found` 或连接失败时轮换重试。rqlite 的 follower 会服务端透明转发写给 leader，客户端无需感知 leader 身份。

**读一致性（实测修正）**：原以为 rqlite 默认 `weak` 可能读到陈旧数据，**实测不成立**——`weak`/`strong` 在 follower 上都**转发给 leader** 应答（`X-Rqlite-Served-By` 实证），只有 `level=none` 才是本地读。因此规定：

- 适配层统一显式 `?level=weak`（读始终来自 leader，一致性等价 strong；写从 follower 也自动转发 leader，d1-http 可连地址池中任一节点）。（实现更正 2026-10-17：**两处例外走 strong**——KV 缓存 `get()`（`kv-adapter.ts:53-57`，read-after-write 契约）与迁移账本（`migrate.ts:171-172`，读陈旧账本会重跑不幂等迁移）。）
- **不使用 `none`**：排行榜「读 revision → 构建 → 再读 revision」（`leaderboard-snapshot.ts:123/143`）与 web 授权比对（`route.ts:145,185`）都依赖 revision 相等判断，本地陈旧读会反复触发 "Leaderboard changed during read"。
- 代价：任何节点都是「转发器」，读延迟 = 本地读 + 转发；无本地读横向扩展。未来若需读扩展，须先改造 revision 一致性逻辑——列为远期方向，不在本设计内。
- 副作用（正面）：follower 上的写与读都自动转发，**地址池轮换无需区分读写端点**；故障切换沿用已实测的 1.85s 自动切换。

**版本要求**：**必须 ≥ v10.3.3**。v10.3.3 才修复「事务请求中某条语句 **prepare** 失败时不回滚」（CHANGELOG PR #2792，2026-09-13）。本项目在 batch 中混用 RETURNING（`packages/worker/src/accounting-sql.ts:24`、`packages/web/src/app/api/teams/[teamId]/route.ts:256,272`），一旦某条语句在 prepare 阶段就报错（如缺表），旧版本会让同批已成功的语句**残留提交**。**实测**（事务请求中间夹一条缺表语句）：10.3.2 下 `INSERT(1)`、`INSERT(2)` **都提交**（未回滚）；10.3.3 下 p 表 0 行（正确回滚）。病因是 statement-**prepare** 错误，**不是** RETURNING。

**其它实测结论**：`CURRENT_TIMESTAMP` 会被 rqlite 引号化成字符串字面量，禁止在迁移与业务 SQL 中使用；rqlite HTTP 默认超时 30s；`D1Meta` 在 workers-types 里字段多为必填，适配层应 `as unknown as D1Database` 而非强造型。

**专项五：时间列由应用层写入（41 处 `DEFAULT (datetime('now'))` 的多节点正确性）**

机制（实测推演）：`INSERT INTO t(id) VALUES (1)` 语句文本本身**无**非确定函数，语句改写看不到藏在**列 DEFAULT 表达式**里的 `datetime('now'))`——每个副本重放时各自求值。单机与低延迟下「碰巧同秒」看似正常；但暂停/重启追赶、复制延迟过秒边界即分叉（实验 J 实测：leader `09:18:56`、恢复后的 n2 `09:18:58`）。这与实验 B 的「看似一致」并不矛盾——B 未暂停，各副本同秒重放，是假阴性。

处置（工作量已核验收窄）：

- 迁移里非确定 DEFAULT **仅 `datetime('now')` 一种**、共 41 处，无其它（已 grep 全量核验）。
- 上游语句里的 `UPDATE ... SET updated_at = datetime('now')` **不受影响**——非确定函数在语句文本里，leader 语句改写后各副本重放同一字面量。
- 受影响的只有**省略时间列的 INSERT**。生产路径核验：`INSERT INTO users` 仅 1 处（`auth-adapter.ts:36`），另有邀请码等少数 INSERT 省略 `created_at`（`api/admin/invites/route.ts:100` 一带）。实现阶段全量 grep `INSERT INTO` 与省略时间列的组合，逐处**补显式 `datetime('now')`**——表达式进语句文本后由 leader 改写，各副本重放一致。
- 这些改动是**对上游文件的小幅 SQL 改动**，计入 §4.7 改动面；单节点下行为不变（值同样正确），故单/多节点共用一份代码，无需模式开关。
- 迁移文件里的 41 处 `DEFAULT` **保留不改**（改上游迁移违反「不改上游 SQL」约束）——只保证生产写路径不再依赖它们；若未来有人手工 INSERT 省略时间列，多节点下有分叉风险，写入开发规约。

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

**归属决定：`kv_cache` 放在 rqlite 主库内（不是 read 容器本地）**。理由：

- **读服务要能水平扩**：多个 read 实例必须共享同一份缓存，否则同一 key 在多实例间各存一份、缓存失效把它们一起清空时行为不一致；放主库后 read 容器完全无状态，随便加副本。
- **备份单点**：缓存随 rqlite 一起进出快照，无第二个备份面。
- 代价：缓存写走 Raft 共识。但 KV 写只在**刷新时**发生（定价同步、seasons 列表刷新、快照重建），不是每请求，量级低；`cache.clear` 最多 10000 条删除需**压测**（可整批一个事务提交，减少 Raft 轮次）。
- 缓存读（`get`）默认走 `weak`（读 leader），与 §4.1 读一致性规定一致。（实现更正 2026-10-17：交付实现为 **strong**——`kv-adapter.ts:53-57` 为 read-after-write 契约显式 `.strong()`，与 §4.1 的例外说明一致。）

**读侧过期过滤**：`kv_cache.expires_at` 必须在 `get` 时过滤，否则 TTL 形同虚设。写入时把 `expirationTtl`（秒）换算为绝对时间戳。

**体积与超时**：KV 单值上限 24MB（`kv-store.ts:32`）需经 rqlite 传输；`cache.clear` 最多 10000 次删除需压测。

### 4.3 `deploy/selfhost/node-runtime` — Worker 运行时宿主

把 `export default { fetch, scheduled }` 挂到 `node:http` 上：

- `fetch` → 标准 `Request`/`Response` 转换（Node 22 原生支持 Web 标准）
- `scheduled`（worker-read 的定价同步 cron）→ **由独立 `scheduler` 容器执行**（同一宿主代码加 `--scheduled` 模式，固定 1 副本），避免多 read 副本重复触发同步（`worker/src/index.ts` 无 `scheduled`，仅 worker-read 有）
- `env` 注入：`DB`（D1 形状适配）、`CACHE`（KV 形状适配）、各 secret

**Web 侧注意**：官方镜像的 `server.js` 硬写 `process.env.NODE_ENV = 'production'`，无法用环境变量覆盖。这是 §4.4 中多个「生产守卫」问题的共同根因。

**请求体大小**：Cloudflare Workers 单请求体上限 100MB，Node 的 `node:http` 默认无上限但内存压力更大；CLI 批量上传（`runUpload`）单次可能很大，适配层需与 CLI 分批策略对齐，并限制单请求体（如 32MB）防止 OOM。

### 4.4 认证：邮箱 + 密码

> **状态：已实现（Plan 2）。** 本节原先是 Plan 2 的规格，现已落地：
> `lib/credentials.ts`（scrypt 哈希 + 注册 + bootstrap + 重置令牌）、
> `app/api/auth/register`（引导/邀请两模式）、`app/setup/`（首个管理员向导）、
> `auth.ts`（条件 providers、Credentials 直通、`USE_SECURE_COOKIES=false` 分支、
> JWT `pwd_v` 会话失效）、`lib/admin.ts` + 两处调用点（库内 `is_admin`）、
> `proxy.ts`（`/setup` 公开）、`app/api/admin/users/[userId]/reset-password` +
> `app/api/auth/reset-password` + `deploy/selfhost/reset-password.ts`（三重重置路径）。
> 实现细节见 `docs/59-self-hosted-auth.md` 与
> `deploy/selfhost/README.md` 的「登录与初始化」。
>
> 与本节规格的差异（实现期定稿）：密码重置表名为 `password_resets`（规格写作
> `password_reset_tokens`）；令牌有效期 60 分钟；邮件自助重置未做（无 SMTP），
> 改为管理员线下交付令牌 + 破窗脚本两条路径。

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
- 迁移：新增迁移文件包含 `ALTER TABLE users ADD COLUMN password_hash TEXT` 与 `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`（现有 `users` 无任何 password/role 字段，已核验）。

**password_hash 的读取路径（避免改 worker-read）**

`DbRead` 接口（`lib/db.ts:62-446`）没有任何返回 `password_hash` 的方法，worker-read 的 RPC 方法集也固定；给读路径加方法要同时改 `db.ts`、`db-worker.ts`、worker-read 三处。**改为走 D1 REST 原始查询**：`getD1Client().query("SELECT id,email,password_hash,name,is_public FROM users WHERE email = ?", [email])`（`lib/d1.ts:90-102`；自建下 `D1_BASE_URL` 指向 d1-http）。这样 `worker-read` 与 `db.ts` 均不改。

**首个用户即管理员 + 专用注册向导（替代原 `bootstrap-admin` 脚本方案）**

原「预置管理员」方案（部署时用脚本直接插库）已废弃——改为**首个注册者成为管理员**，并提供专用向导。这同时解开了原有的死锁：`invite_codes.created_by TEXT NOT NULL REFERENCES users(id)`（`001-init.sql:109`）导致「无用户则建不了邀请码、无邀请码则建不了用户」，而首个用户**不走邀请码闸门**，死锁自然消解，无需任何插库脚本。

**管理员判定需要扩展（现状只认环境变量）**：`lib/admin.ts:54` 的 `isAdmin(email)` 仅比对 `ADMIN_EMAILS`（`admin.ts:39-41`），库内无管理员概念。新增：

- 迁移加列 `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`（与 `password_hash` 同一迁移文件）。
- `lib/admin.ts` 的 `resolveAdmin`/`isAdminUser` 判定改为 **`ADMIN_EMAILS` 命中 OR 库内 `is_admin = 1`**。`ADMIN_EMAILS` 保留为**破窗/运维覆盖**（应急提升、脚本化场景），不再是唯一来源。
- 现有 `isAdmin(email)` 是**同步**函数、签名只收 email（`admin.ts:54`），直接改成查库会波及 38 处调用点。处置：保留其同步语义（纯 env 判定）供无需查库的路径使用；新增异步判定并入 `resolveAdmin`/`isAdminUser`（两者已是异步，是 38 处里的绝大多数入口）。**两处直接调用 `isAdmin(email)` 的路由需改为异步判定**（`api/admin/check/route.ts:44`、`api/users/[slug]/route.ts:53`），否则库内管理员在这两处会被误判为非管理员。

**首次引导的并发安全**：两个请求同时打向空库时不能都成为管理员。新增单行表作为一次性认领：

```sql
CREATE TABLE instance_setup (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  admin_user_id TEXT NOT NULL,
  completed_at  TEXT NOT NULL
);
```

引导注册在**一个事务内**完成插入（`is_admin = 1` 用户 + `instance_setup` 单行），`users` 计数查询在批量外先读（实现更正 2026-10-15，见 docs/54 Global Constraints）。第二次并发请求会因 `instance_setup` 主键冲突在批量内失败并整体回滚。rqlite 写路径由单 leader 串行 + `?transaction=true` 原子（§4.1 专项一），因此该判定可靠。

**注册向导流程（`/setup`）**：

| 步骤 | 内容 |
|---|---|
| 1 | 实例检查——服务端确认 `users` 为空；非空则 302 到 `/login`（**向导仅首次可达**） |
| 2 | 管理员账号——邮箱、显示名、密码 + 确认；密码强度校验（长度/复杂度） |
| 3 | 实例选项（可选）——是否要求邀请码（写 `app_settings.require_invite_code`）、站点显示名等 |
| 4 | 完成——自动登录并进入仪表盘；此后 `/setup` 恒 302 到 `/login` |

> **实现更正 2026-10-15**：向导最终为单步表单（邮箱/显示名/密码/确认），步骤 3 省略——`require_invite_code` 等实例选项由管理后台（`/api/admin/settings`）承担；`/setup` 完成后不是 302 而是注册 API 返回 400（同等防护，机制不同）。

**向导路由必须对未登录用户开放**：`proxy.ts:48-58` 的 `isPublicRoute()` 不含 `/setup`，未登录访问会被 302 到 `/login` 而**永远进不了向导**。需把 `/setup` 加入公开路由（改动 `proxy.ts`，计入 §4.7 改动面）。登录页在「库内无用户」时也应显示「首次部署？前往初始化」入口。

**后续用户**：首个管理员建立后，`require_invite_code` 默认仍为 true，管理员在 `/admin/invites` 生成邀请码（此时 `created_by` 有真实用户可引用），后续注册走邀请码——链路完整闭环。

**注册端点的闸门差异**：`/api/auth/register` 在**引导模式**（库为空）下跳过邀请码校验；**常规模式**下必须校验并原子消费邀请码（沿用 `invite.ts:140-150` 的 `UPDATE ... WHERE used_by IS NULL` 原子消费模式，`changes === 0` 即视为无效码）。

**暴力破解防护**

Credentials 无内建限速。在 `authorize()` 内复用现有 `lib/rate-limit.ts`：`inMemoryRateLimiter.check()` + `getClientIp()`，按 `login:<ip>` 与 `login:<email>` 双键限速（如 5/min、20/h）。两个前提必须写进部署文档：

- `inMemoryRateLimiter` 是**进程内**状态（`rate-limit.ts:35-36` 注释明示「仅适用单实例」）——多 web 容器时限速不跨实例，需外部化或接受弱化。
- `getClientIp` 信任 `X-Forwarded-For`（`rate-limit.ts:180-194`）——反向代理必须**清洗/覆写**该头，否则可伪造绕过。

**账号生命周期（复核新发现的两个缺口）**

**缺口一：密码重置无路径。** 已核验项目**完全没有任何邮件发送能力**（`package.json` 与 `packages/*/package.json` 无 nodemailer/sendgrid/resend/ses/smtp 依赖，源码无发送调用）。而邮箱+密码认证的必然配套就是「忘记密码」——没有它，用户一旦忘记密码即彻底失去访问。处置（**不引入邮件依赖**，符合自包含前提）：

- **管理员发起重置**：`/admin/users` 生成一次性重置令牌（存库，带过期），管理员把链接/令牌**线下**交给用户（企业内网常见做法）；用户凭令牌设置新密码。
- **破窗路径**：提供 `deploy/selfhost/reset-password` 运维脚本（直连 rqlite 更新 `password_hash`），用于管理员自身也失联的极端情况。
- 邮件式自助重置列为**可选扩展**（需 SMTP 配置），不在本期范围。

**缺口二：JWT 会话无法在服务端失效。** `auth.ts` 用 JWT strategy 且**无 session 表**（`auth.ts:4,83-85` 注释明示）。因此**改密码/管理员重置密码后，已签发的旧 token 仍然有效直到过期**——对「管理员紧急吊销某账号」这类企业诉求是真实缺口。处置：

- 收紧 `session.maxAge`（见上）缩小窗口；
- 在 JWT 中携带 `pwd_v`（`password_hash` 的短哈希前缀），`sessionCallback` 比对库内当前值，不一致即视为失效——代价是每次会话校验多一次读（可接受，读走 §4.1 的 `weak` 级别）。
- 本期至少实现 `maxAge` 收紧；`pwd_v` 校验列入实现阶段（属增强，非阻塞）。（实现 2026-10-15：两项均已实现——`session.maxAge = 7 天`（auth.ts session 配置），`pwd_v` 校验已落地。）

**`email_verified` 语义**：Credentials 下无邮箱验证环节，该列保持 NULL。这不影响鉴权——`/setup` 首个管理员与邀请码注册的用户，其**授权来源是邀请码/首次认领**，而非邮箱验证。已核验代码中 `email_verified` 仅做映射（`auth-adapter.ts:23,43,102-104`），**无任何鉴权门禁依赖它**，故无需额外处理。

**`slug` 与注册无关**：`users.slug` 为可空列（`001-init.sql:15`，无 NOT NULL），注册时不必生成，用户后续在设置页设置——注册流程无需处理。

**AUTH_SECRET 与构建期密钥**

Dockerfile 在 **builder 阶段**以 `ARG/ENV` 注入 `AUTH_SECRET`（`Dockerfile:40,46`）；最终 **runner 阶段**（`59-72`）不含这些 ENV，故**最终镜像不带密钥**。但**构建期传入的真实密钥会留在构建层缓存/历史**。故：自建构建**不得**用真实密钥做 build arg，密钥一律运行期经 compose `env_file` 注入。另：Dockerfile 注释（`33-34`）称构建期需要这些变量做 page data collection——**哪些变量被内联进构建产物需实测确认**（列入验证项）。

> **实现更正 2026-10-15：** 交付实现已改为 build-time **非密钥占位 ENV**（build-time-placeholder-not-a-secret）：builder 阶段不再以 `ARG/ENV` 注入真实 `AUTH_SECRET`，只用无意义的占位值满足 Next 构建期读取；真实密钥**只走运行期注入**（compose `env_file`）。构建层缓存/历史随之不再有真实密钥泄漏面，本段「不得用真实密钥做 build arg」的告诫在当前实现下自动成立。

**HTTP 内网 cookie（必须处理）**

`shouldUseSecureCookies()`（`auth.ts:21-27`）在 production 下返回 true，镜像硬编码 production（Next standalone 生成的 `server.js` 写入 `process.env.NODE_ENV='production'`）→ 内网 http 下浏览器丢弃 `__Secure-` cookie → 登录态丢失。`USE_SECURE_COOKIES` 目前只能往「开」覆盖，需增加 `USE_SECURE_COOKIES === "false"` → 返回 false 的显式关闭分支。

**更正**：原草案称「需同步调整 `proxy.ts` 的 origin 推导」——**不成立**。`proxy.ts` 不依赖 cookie 名，只依赖 `NEXTAUTH_URL`（`proxy.ts:13-24` 的 `TRUSTED_ORIGIN`，协议取自 `NEXTAUTH_URL`，`buildRedirectUrl` 不读 `X-Forwarded-Proto`）。只要 `NEXTAUTH_URL` 设为实际访问地址（含 `http://`）即可，`proxy.ts` 无需改动。

### 4.5 CLI：支持指向自建服务

- `resolveHost(dev)`（`commands/login.ts:21-23`）改为接受选项对象，优先级：`--host` 参数 > `PEW_HOST` 环境变量 > 现有 `dev`/`DEFAULT_HOST` 逻辑
- 影响点：`packages/cli/src/cli.ts:389,556`（两处调用）、`packages/cli/src/commands/login.ts`
- 上传路径（`runUpload` / `runSessionUpload`）沿用同一 host 解析

**凭据隔离（复核新发现）**：`ConfigManager` 生产写 `~/.config/pew/config.json`、dev 写 `config.dev.json`（`config/manager.ts:4-5`），**没有按 host 区分**。自建 host 若复用 `config.json`，会**覆盖**用户在 pew.md 的登录态（反之亦然）。→ 自建 host 使用独立配置文件（如 `config.<host>.json`），需小幅修改 `config/manager.ts`（上游文件）或在 host 解析处派生文件名。

**实现更正 2026-10-20（凭据隔离只做了一半，已补齐）**：上面这条只落到 `login`（写入侧）。读取侧漏了——`commands/upload-engine.ts` 用 `new ConfigManager(stateDir, dev)` 读 `config.json`，`commands/logout.ts` 同样。后果有两个方向：`pew sync` 对自建实例报 "Not logged in"；或用户同时登录了 SaaS，自建采集的数据会**带着 SaaS token 上传到 pew.md**。此外 `sync` 只认 `PEW_HOST` 环境变量，没有 `--host` 参数（原「影响点」只列了 `cli.ts:389,556` 两处调用，实际 `sync` 那条不接 override）。现统一为 `config/manager.ts` 导出的 `credentialHostScope(apiUrl)`：归一化 URL，对内置 SaaS host 返回 `undefined`（文件名不变），其余返回该 host——`login`、`upload-engine`、`logout` 共用同一条规则；`sync` 与 `logout` 补上 `--host`（优先级高于 `PEW_HOST`）；`login` 的「Token saved to」改印真实路径。设备身份不受影响：base-cli 的 `ensureDeviceId()` 用独立的 `device.json`，不随 host 分文件——这是刻意的，多设备去重需要同一 ID。

**登录流程本身无需改动**：浏览器流程经 `/api/auth/cli`（`route.ts`）——要求浏览器已有会话，然后下发 `pk_` 前缀的 `api_key`（`route.ts:104-113`）。凭据登录建立的会话同样满足，流程照旧。注意 `/api/auth/cli` 的回调 origin 取自 `NEXTAUTH_URL`（`route.ts:31-37`），自建下必须正确设置。限速 `AUTH_CLI_RATE_LIMIT`（10 次/时/IP）沿用。

### 4.6 部署编排

`deploy/selfhost/docker-compose.yml`：

| 服务 | 说明 | 端口 |
|---|---|---|
| `rqlite` | **profile `single`：1 节点**（默认，`-bootstrap-expect 1`）；**profile `cluster`：3 节点**（**三节点都带 `-bootstrap-expect 3` + 完整 `-join` 列表**，`-node-id` 稳定；否则首节点会自任 leader、写成功，healthcheck 门控失效）持久卷，**必须带 `-fk`** | 仅内网 4001/4002 |
| `d1-http` | D1 REST 形状 HTTP 服务（无状态） | 仅内网 |
| `read` | worker-read 宿主（无状态，可 `--scale`） | 仅内网 |
| `scheduler` | **只跑 `scheduled()`** 的独立容器（1 副本；多 read 副本时避免 N 份重复定价同步） | 仅内网 |
| `ingest` | worker 宿主（无状态，可 `--scale`） | 仅内网 |
| `web` | **本分支构建的镜像**（仓库根 `Dockerfile`，产出 Next standalone），注入指向上述服务的环境变量 | 对外 7020 |

**更正**：web 不是 Docker Hub 上的「官方镜像」——本方案改了 `auth.ts` 等上游文件，必须用本分支源码构建（仍复用上游 `Dockerfile`）。

> **两套镜像，不要混用**：`web` 是 Next standalone（根 `Dockerfile`，`CMD ["node","packages/web/server.js"]`）；
> 跑 bun 的适配层服务（migrate/d1-http/read/ingest/scheduler）是另一套 `deploy/selfhost/Dockerfile`
> （`oven/bun` 基镜像、无 `.next`、无 `CMD`）。把 web 指到后者会因无 Next 产物、无 `CMD` 而立即退出。

**横向扩展路径（呼应「单节点起步、可扩规模」）**：

- **起步**：profile `single`，全部 5 个服务 + 1 个 rqlite。
- **读/写应用层扩容**：`web`/`read`/`ingest` 均无状态（KV 缓存在 rqlite 共享、会话为 JWT），`docker compose up --scale read=2` 即可，无代码改动。注意 web 多副本时**登录限速退化为按副本计**（`inMemoryRateLimiter` 进程内，§4.4），生产多副本需外部化或接受弱化。
- **数据层扩容**：单 rqlite → 3 节点 Raft 集群。**单→3 在线扩容已实测支持**：向已运行的 `-bootstrap-expect 1` 单节点直接 `-join <单节点>:4002`（join 节点**不带** `-bootstrap-expect`）→ 3 节点全部 voter/reachable，新节点能读到扩容前写入的数据。
  注意这是**两条互斥路线**，不能混用：`-join` 扩容不走 compose 的 cluster profile（那三个服务写死了 `-bootstrap-expect 3` 与互相 `-join`，没有「join 进旧单节点」的位置），需要手工 `docker run` 或临时 compose 覆盖文件；而切到 cluster profile 会起一套**空集群**，数据要靠「备份 → `.restore`」带过去。运维步骤见 `deploy/selfhost/README.md` 的「集群模式」一节。
- **失败域**：同机 3 容器只防**进程**故障，不防磁盘/主机故障；跨机部署（compose 部署到 3 台）写入部署文档，属运维配置不进设计。
- 调度：定价同步 cron 从 read 容器拆到独立 `scheduler` 容器（单副本），多 read 副本不重复同步。

**rqlite 关键启动参数**：

```
-fk                       # 必须：外键默认关闭，而 schema 有 12 处 ON DELETE CASCADE
-bootstrap-expect=3       # 集群：三节点都带，配合下面的 -join 互相发现
-join <peers>             # 集群：三节点都列全（如 rqlite-1:4002,rqlite-2:4002,rqlite-3:4002）
-node-id <stable-id>      # 集群模式下不可变
```

> **为什么三个节点都要 `-bootstrap-expect 3` 且都列全 `-join`**：若只给 `rqlite-1` 带 `-bootstrap-expect 3`
> 而 `rqlite-2/3` 用 `-join`，实测 `rqlite-1` 会**立即自任 leader 并接受写入**（`state=Leader, num_peers=0,
> voter=true`），此时写还能成功——`rqlite-2` 加入后虽然最终一致，但 migrate 可能已经跑在一个「假集群」上。
> 三节点都带 `-bootstrap-expect 3` + 完整 `-join` 时，任一首节点在 quorum 前处于 `Follower/voter=false`，
> **写返回 503 "leader not found"**，直到三节点互相发现才选主。这才让 healthcheck 真正门控。
> （以上均为 rqlite 10.5.3 实测。）

**编排必须补齐的工程项（复核新增，原草案缺失）**：

- **资源限制**：`deploy.resources.limits`（memory/cpus）。rqlite 与 d1-http 内存占用随批量写入增长；web 是 Node standalone。
- **健康检查 + 依赖顺序**：`web`→`/api/live`；`read`→`/api/live`；`rqlite`→**`/readyz`（不是 `/status`）**；`d1-http`→`/health`。`depends_on` 用 `condition: service_healthy`，避免 web 在 rqlite 就绪前启动导致迁移/健康检查失败。

  > **必须用 `/readyz`**：实测 `/status` 在节点尚未加入集群（`-bootstrap-expect 3` 未满足 quorum）时**仍返回 HTTP 200**，
  > 只是 `raft.state=Follower, num_peers=0, voter=false`——只看状态码无法区分「未就绪」与「就绪」，healthcheck 会恒真。
  > `/readyz` 在无 leader 时返回 **503**（`[+]leader does not exist`），就绪后返回 200，故用它门控。
  > migrate 的一次性容器同样必须探 `/readyz`（`waitForRqlite`），否则会在集群就绪前抢跑。
- **端口暴露**：只有 web 的 7020 对外；read/ingest/d1-http/rqlite 一律不发布到宿主，仅 compose 网络内可达（服务名解析）。
- **日志**：`json-file`，`max-size: 10m`、`max-file: 3`（官方部署已验证此配置）。
- **密钥注入**：`env_file`（不入版本库）或 docker secret；见 §4.4 关于 AUTH_SECRET 的约束。
- **迁移执行**：web 启动前需先对 rqlite 应用迁移（见 §6），可用一次性 init 容器。
- **数据卷**：仅 rqlite 需要持久卷（数据）；d1-http/read/ingest/web 无状态。
- **网络**：单 bridge 网络。

**外部依赖（自建下需要出网或降级的能力，详见 §9）**：R2/S3（团队与组织 logo）、`hexly.ai`（首页分享数据 SSR）、OpenRouter 与 models.dev（动态定价同步）、npm registry（构建 `@nocoo/*` 依赖）。

### 4.7 改动面（上游文件清单）

**修改的上游文件（12 处，改动尽量小）**

> **实现更正 2026-10-17（改动面口径）：** 上表是计划时点的清单，交付时又增加了 Plan 3 的接触面：`packages/web/src/lib/rate-limit.ts`（`RqliteRateLimiter`、`getClientIp` 取 XFF 最后一段、IPv6 前缀归并）与 `packages/web/src/lib/invite.ts` + `lib/auth-helpers.ts` + 新增 `lib/e2e-mode.ts`（三处手写 E2E 门收敛为单一 `isE2EMode`）。因此「12 处」只应理解为**计划时点的估算**，实际合并上游的权威清单是 README「合并上游」小节（Plan 1 / Plan 2 / Plan 3 三批）。下文与 §7 中出现的「12 个上游文件」均按此口径阅读。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/web/src/lib/d1.ts` | 新增生产可用的 D1 base URL 覆盖（约 3 行，见 §4.1 专项四） |
| 2 | `packages/web/src/auth.ts` | providers 条件组装、`signIn` 对 credentials 放行、cookie 显式关闭分支、`session.maxAge` |
| 3 | `packages/web/src/app/login/page.tsx` | 按 provider 条件渲染 + 邮箱/密码登录表单 + 「首次部署」入口 |
| 4 | `packages/web/src/lib/auth-adapter.ts` | （实现更正 2026-10-15：未改动——相关表 `001-init.sql` 已定义 `created_at DEFAULT datetime('now')`，确定性无缺口） |
| 5 | `packages/web/src/lib/admin.ts` | `resolveAdmin`/`isAdminUser` 判定扩展为 `ADMIN_EMAILS` OR 库内 `is_admin`；保留同步 `isAdmin(email)` 的纯 env 语义 |
| 6 | `packages/web/src/app/api/admin/check/route.ts`、`packages/web/src/app/api/users/[slug]/route.ts` | 直接调用同步 `isAdmin(email)` 的两处改为异步判定（否则库内管理员被误判） |
| 7 | `packages/web/src/proxy.ts` | `isPublicRoute()` 增加 `/setup`（未登录必须能进向导） |
| 8 | `packages/web/src/app/api/admin/invites/route.ts` 等 | 省略时间列的 INSERT 补 `datetime('now')`（全量 grep 定位，实测已知 2 处起）。（实现更正 2026-10-17：`invites/route.ts` 最终**未改动**——该表 INSERT 均有 `DEFAULT datetime('now')`，与 §3.2 更正一致。） |
| 9 | `packages/cli/src/commands/login.ts` | `resolveHost` 支持 `--host` / `PEW_HOST`。（实现更正 2026-10-20：同一批还把读取侧补齐——`upload-engine.ts`、`logout.ts`、`cli.ts` 的 `sync`/`logout` `--host`，见 §4.5） |
| 10 | `packages/cli/src/config/manager.ts` | 自建 host 使用独立配置文件（见 §4.5） |
| 11 | `scripts/migrations/` | **新增**：① `password_hash` + `is_admin` 列；② 确定性触发器后置迁移（专项二）；③ `kv_cache` 基础设施表（实测：无任何上游迁移创建它，缺表只在运行时暴露）——均为**新增文件**。（实现更正 2026-10-20：上句原写「不改既有迁移」，与事实不符——为支持迁移重放，`scripts/migrations/029-leaderboard-revision.sql` 的种子 INSERT 已改为 `INSERT OR IGNORE`（提交 `607455db`），这是**对上游既有迁移的唯一修改**。） |
| 12 | `vitest.config.ts` | `test.include` 增加 `deploy/**/*.test.ts`——否则 `deploy/selfhost/` 下的适配层测试**一条都不会执行** |

**新增文件（全部在既定目录，不触碰上游代码）**

- `packages/web/src/lib/credentials.ts`、`packages/web/src/app/api/auth/register/route.ts`、`packages/web/src/app/setup/`（注册向导）、`packages/web/src/app/api/admin/users/[...]/reset-password`（管理员发起重置，§4.4）
- `deploy/selfhost/`：`d1-adapter`、`kv-adapter`、`node-runtime`、`d1-http`、`docker-compose.yml`、迁移执行器、`reset-password`（破窗脚本）

**刻意不改的上游文件**：`packages/worker/src/**`、`packages/worker-read/src/**`、`lib/db.ts`、`lib/db-worker.ts`、`lib/db-rest.ts`、`lib/r2.ts`、`next.config.ts`、`bun.lock`、根 `package.json`、`biome.json`。（注意：`proxy.ts` 与 `lib/auth-adapter.ts` **不在**此列——前者已在改动清单内、后者最终未改动；`lib/invite.ts` 与 `lib/rate-limit.ts` **已从本清单移出**——实现更正 2026-10-17：`invite.ts` 的 E2E 门改为调用共享 `lib/e2e-mode.ts`，`rate-limit.ts` 承载 Plan 3 的 `RqliteRateLimiter` 与 XFF 最后一段逻辑，两者均已改动；worker 包的 `tsconfig*.json`/`package.json` 例外见 §3.2 实现更正。实现更正 2026-10-15：**`cli.ts` 与根 `Dockerfile` 均已从本清单移出**——`packages/cli/src/cli.ts` 已按 Plan 2 交付项改动（`--host` / `PEW_HOST` 支持），根 `Dockerfile` 亦已改（builder 阶段 build-time 占位 ENV）；正确口径见 README「合并上游」小节。）

**适配层的运行方式**：`deploy/selfhost/*` 用 **bun 直接运行 TS 源码**，但**不能复用仓库根的 `Dockerfile`**——实测其 `runner` 阶段是 `FROM node:22-slim`，只 COPY `.next/standalone`/`.next/static`/`public`，`awk '/AS runner/,0' Dockerfile | grep -c bun` = **0**、含 `deploy|packages/worker` 的行数 = **0**：最终镜像内**既无 bun 也无适配层源码**。而 compose 的 migrate/d1-http/read/ingest/scheduler 全部 `image: pew-selfhost:local` + `bun run deploy/selfhost/*.ts`，会全部启动失败。因此**必须新建 `deploy/selfhost/Dockerfile`**（从 `oven/bun:1.4.0` 出发，COPY 根 `package.json`/锁文件/`tsconfig.json`/`packages/`/`deploy/`/`scripts/migrations/`，并 build `@pew/core` 的 `dist`）。这也是**唯一新增的顶层目录 `deploy`**（其下 `selfhost/` 含本目录全部文件——整体不计入 12 处上游改动）里的专用镜像入口；仓内没有第二处新建顶层目录。

## 5. 数据流

**写入（CLI 上传）**：CLI → `web:/api/ingest` → `ingest 容器` → rqlite（批量 upsert，事务原子）

**读取（仪表盘）**：`web` → `read 容器` → rqlite

> 实现更正 2026-10-17：本节初稿把这两跳写成经 `d1-http`——实际只有 **web 的写路径**经
> d1-http（`D1_BASE_URL` 指向它）；`ingest`/`read`（以及 `scheduler`）都经 `RQLITE_URL`
> **直连 rqlite**，compose 不给这三个服务注入 `CF_D1_API_TOKEN`（见 §4.1 专项三的实现
> 更正，与本节原稿同源的过时表述）。

**注册（首次引导）**：浏览器 → `web:/setup` 向导 → `web:/api/auth/register` → 事务内认领（`users` 为空 + 写 `instance_setup`）→ `INSERT users`（`is_admin=1` + `password_hash`）→ 自动登录

**注册（常规）**：浏览器 → `web:/login` → 邀请码 → `web:/api/auth/register` → 原子消费邀请码 → `INSERT users` → 登录

**登录**：浏览器 → `web:/api/auth/callback/credentials` → Credentials `authorize()` → D1 REST 查 `password_hash` → scrypt 校验（+ 限速 + dummy 校验）→ JWT 会话

**CLI 登录**：CLI 打开浏览器 → `web:/api/auth/cli?callback=...`（需已有会话）→ 下发 `pk_` api_key → CLI 存本地

**定时任务**：`scheduler 容器` 内定时触发动态定价同步（替代 CF cron trigger）；需出网访问 OpenRouter / models.dev，否则降级到 bundled baseline（实现更正 2026-10-17：交付为独立 `scheduler` 服务，非 read 容器内定时器，与 §4.3/§4.6 一致）

## 6. 测试策略

| 层级 | 内容 |
|---|---|
| 适配层单元测试 | D1 形状映射（`rows_affected` 缺失兜底、错误在 HTTP 200 内、`duration` 换算、空批返回 `[]`）；KV `get(key,"text")`、`put` 带 TTL、`list` 分页 |
| 迁移兼容测试 | 全部迁移（磁盘 `scripts/migrations/` 实测 **37 个 .sql**：33 个上游文件 + 本方案新增的 030–033；其中 3 个上游文件被 squash 跳过，故**应用 34 个**）apply 到 rqlite。**基线以 `deploy/selfhost/verify-migrations.ts` 的 `EXPECTED` 为准**（实现更正 2026-10-17：本节原写的「35 个 .sql / 应用 32 个 / 本方案 3 表 / 索引 65」是 2026-10-11 的快照，Plan 2 的 032 与 Plan 3 的 033 之后已变为 **上游表 22 张 + 本方案 6 张**（`_migrations`、`kv_cache`、`leaderboard_revision_seq`、`instance_setup`、`password_resets`、`rate_limit_hits`）、**索引 69 个**、触发器 12 个、视图 2 个）。索引中 40 个是 SQLite 自动创建的 `sqlite_autoindex_*`（含 password_resets 的 TEXT PRIMARY KEY），显式索引 29 个——023/024/025 三个迁移 DROP 了 projects/showcases/badges/budgets 等表并带走其索引，032 新增 `idx_password_resets_user`，033 新增两个 rate-limit 索引。断言 12 触发器已替换为确定性版本，且 `kv_cache` 存在（缺表只在运行时暴露，单元测试用内存假库测不出）。原写「23 表 / 62 索引」为估计值，实测不成立，已更正 |
| 多节点确定性测试 | **三节点集群 + `docker pause` follower 制造重放**，用 `level=none` 直读各副本本地状态断言收敛：触发器 revision 三副本一致、应用层写入的 `created_at` 一致（这是配置①②与配置③的判别实验，见 §4.1 专项二） |
| 迁移确定性测试 | 断言 DDL 执行后 `sqlite_master` 中 `datetime('now')` / `randomblob()` **未被冻结**（用 `?norwtime&norwrandom`）。**注意 `norw*` 只能用于 DDL**：迁移文件里的 DML（如 029 的种子 `INSERT ... randomblob(16)`、008b 的 `UPDATE ... datetime('now')`）必须走不带 norw 的默认改写路径，否则各副本独立求值会**分叉**（实测两副本得到不同 randomblob）。执行器按 `isDdlStatement` 分流 |
| 原子性测试 | batch 中夹坏语句，断言零残留 |
| 端到端 | compose 起全栈，跑通「注册 → 登录 → CLI 登录 → 同步 → 仪表盘可见」 |
| 上游同步回归 | 合并上游 main 后，上述测试全部通过 |

**迁移执行方式变更**：从 `wrangler d1 execute --file` 改为「读文件 → 按语句切分（正确处理 `CREATE TRIGGER ... BEGIN ... END`，含内联写法 `BEGIN ...; END;`）→ **按语句类别分流**：DDL 批带 `?transaction=true&norwtime&norwrandom`（原子且保持文本原样，见 §4.1 专项二），DML 走默认改写（不带 norw，避免副本分叉）」。切分器的正确性已用两法核验：单元测试 + 把当时全部 30 个上游迁移文件切成 133 条语句并在真实 SQLite 中逐条执行（0 错误，产出 22 表 / 12 触发器；上游文件现已 33 个，该方法未变）。**断点恢复**：文件级无法用单次请求做到 DDL+DML 原子（二者 norw 语义互斥），故 `applyMigrations` 在账本记账前逐条执行；若某 DDL 批失败，改为逐条重试并**跳过「已存在 / 重复列」这类幂等错误**（保护 029 等含裸 `CREATE TABLE`/`CREATE TRIGGER` 的上游文件），真正的错误（缺表、语法、约束）仍中止。

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
| **Web 需小幅改动** | 认证与 cookie 开关需改上游文件 | 改动面以 README「合并上游」的 Plan 1/2/3 清单为准（计划时点估算为 §4.7 的 12 处，见该节实现更正），另加 1 个新增 `deploy/selfhost/Dockerfile`，便于后续合并 |
| **多节点分叉**（§4.1 专项二） | 解冻后触发器体/DEFAULT 在各副本各自求值 | **已解决**：确定性触发器（seq）+ 应用层写时间列，实测三副本收敛。残余风险见下条 |
| **限速不跨实例**（§4.4） | `inMemoryRateLimiter` 是进程内状态 | 多 web 副本时限速弱化；需外部化（如 rqlite 表驱动）或保持单 web 实例 |
| **`X-Forwarded-For` 可伪造**（§4.4） | 信任代理头取 IP | 反向代理必须清洗/覆写该头，写入部署文档 |
| **构建期密钥泄漏面**（§4.4） | AUTH_SECRET 作为 build arg 留在构建层 | 密钥只经运行期注入；构建用占位值 |
| **外网依赖不达时降级**（§9） | 首页 SSR、动态定价同步、logo 上传依赖外网 | 明确降级路径（见 §9），或断网时禁用对应功能 |

### 待决项

1. **上游合并策略**：本分支改动集中在 `deploy/selfhost/` + 上游文件小改动（清单见 README「合并上游」的 Plan 1/2/3）——需定期 rebase 验证；§4.7 的「不改文件」清单随上游更新需复核。
2. **构建期变量是否被内联进构建产物**（§4.4）：Dockerfile 注释称 page data collection 需要 `CF_*`/`AUTH_SECRET`——哪些被 Next 内联需实测；确认前一律用占位值构建。
3. **单→3 在线扩容**（§4.6）：**已实测支持，关闭**。向已运行的单节点 `-join` 是 rqlite 支持的路径：`-bootstrap-expect 1` 单节点写入数据后，起两个新节点 `-join s1:4002`（**不带** `-bootstrap-expect`）→ 集群 3 节点全部 voter/reachable，新节点上能查到单节点时期写入的行。注意 `-join` 与 compose 的 cluster profile 是**两条互斥路线**：切 profile 起的是空集群，数据要靠「备份 → `.restore`」带过去，见 `deploy/selfhost/README.md`「集群模式」一节。
4. **手工 SQL 规约**（§4.1 专项五）：解冻后若有人手工 INSERT 省略时间列（多节点下有分叉风险），需写进开发规约——属实现阶段产物。
5. **向导的实例选项范围**（§4.4）：已决——向导省略步骤 3，实例选项走管理后台（见 §4.4 实现更正）。
6. **密码重置的令牌形态**（§4.4）：一次性令牌存库表结构（`password_reset_tokens`）、有效期、单次使用语义在实现阶段定稿；邮件自助重置是否本期做需决策。
7. **JWT 会话失效增强**（§4.4）：`pwd_v` 比对（改密后旧 token 立即失效）属增强项，本期是否随 `session.maxAge` 收紧一起做需决策。

（已按决策关闭的待决项：**rqlite 节点数**——架构同时支持单节点与扩展规模，默认 profile 单节点、扩容走 cluster profile，两种模式共用同一套代码路径；**多节点 DDL 非确定性**——配置③三副本收敛，实测关闭；**首个管理员引导**——首个注册用户即管理员 + 专用 `/setup` 向导，不再需要插库脚本。）

## 8. 备份与恢复

数据全部在 rqlite 单一 SQLite（持久卷），备份即备份这个文件。

**恢复已实测订正**：原写「恢复快照文件（替换 `.db`）」是**静默无效**的——实际数据文件是 `/rqlite/file/data/db.sqlite`（另有 `raft.db`/`-wal`/`-shm`/`wsnapshots/`）；且 rqlite 会用 `raft.db` **重放日志**，备份后的写入会「复活」；清空整目录再放 `db.sqlite` 则走 **bootstrap 忽略预置文件**。正确机制是 REPL 点命令 `.restore`。

- **备份方式**：`.backup` 点命令产出一份一致性快照（不能直接 `cp` 活跃文件）。定时任务（cron / systemd timer）导出到宿主目录或对象存储。非交互形式：`printf '.backup /rqlite/file/backup.db\n.exit\n' | docker compose exec -T rqlite rqlite -H localhost`。
- **恢复**：把备份拷进容器后用 `.restore` 点命令（**不可**通过替换 db 文件恢复——raft 会重放日志使恢复静默失效）：

  ```bash
  docker compose cp "./backup-2026-10-11.db" rqlite:/rqlite/file/restore.db
  printf '.restore /rqlite/file/restore.db\n.exit\n' | docker compose exec -T rqlite rqlite -H localhost
  ```

  恢复后需验证 schema 对象数与迁移账本一致。（实现更正 2026-10-15：**恢复前必须一并停止 `d1-http`**——它是写后端，恢复期间继续接收写入会把备份数据混入 raft 日志；恢复完成后再启动。上例命令也缺 `-u` 鉴权参数，启用 `-http-auth` 后需带 `-u "user:password"`。**本小节以 `deploy/selfhost/README.md` 的备份/恢复步骤为准。**）
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

1. **构建两套镜像**：`web` 用仓库根 `Dockerfile`（`docker build -f Dockerfile -t pew:standalone .`，AUTH_SECRET 等用占位值）；适配层服务（migrate/d1-http/read/ingest/scheduler）用 `deploy/selfhost/Dockerfile`（`docker build -f deploy/selfhost/Dockerfile -t pew-selfhost:local .`）。两者构建上下文都是**仓库根**。
2. 准备 `.env`（§11 清单，真实密钥只写这里）
3. `docker compose up -d rqlite` → 健康后执行迁移（一次性 init 容器，DDL 带 `?norwtime&norwrandom`、DML 不带，幂等账本）→ 应用**后置迁移**（确定性触发器，§4.1 专项二）
4. 首个访问者打开 `/setup` → 注册向导 → 首个账号自动成为管理员（绕过邀请码，见 §4.4）——此步骤由 Plan 2（认证子系统）实现，现已可用。
5. `docker compose up -d`（d1-http / read / scheduler / ingest / web）
6. 验证：`/api/live` → 登录（**Plan 2**）→ CLI `--host` 登录 → 上传 → 仪表盘可见

## 10b. 升级与回滚

**升级**：拉新镜像 → 停 web/read/ingest/scheduler（rqlite 保持运行）→ 执行新增迁移（幂等账本自动跳过已应用项）→ 起新容器 → 跑 §6 端到端。数据库层向后兼容的前提是**迁移只增不改**（上游风格如此）。

**回滚**（升级后发现问题）：
1. 停应用容器 → 用**升级前的 rqlite 快照**恢复数据（见 §8）
2. 回退到旧镜像 tag
3. 起容器 → 验证
   注意：若新版本已执行**破坏性迁移**（改列/删表），回滚必须依赖快照，不能只回退镜像——这是「升级前先备份」的硬理由。

**rqlite 版本升级**：单独升级 rqlite 前需查其 release note 的存储格式兼容性；rqlite 支持滚动升级（逐节点重启）。版本**必须 ≥ v10.3.3**（§4.1）。

**迁移账本与回滚的关系**：账本记录「已应用」，但**不提供 down 迁移**（上游也没有）。回滚数据一律走快照，不走反向 SQL。

## 11. 配置清单（`env_file` 必填项）

| 变量 | 说明 |
|---|---|
| `AUTH_SECRET` | 会话加密密钥，**运行期注入**，不入版本库 |
| `NEXTAUTH_URL` | 外部访问基址（`http://` 或 `https://`，决定 cookie 前缀；`TRUSTED_ORIGIN` 由它推导，无需单独配置） |
| `USE_SECURE_COOKIES` | 内网 http 部署设 `false`。**注意**：读取该值 `==="false"` 的分支属 Plan 2，Plan 1 下此变量暂不生效（实现更正 2026-10-17：Plan 2 已交付，`auth.ts:45-55` 已实现显式 false 分支；`.env.example`/compose 默认**空值**，由 auth.ts 推导——production 下即 true，**http 部署必须显式填 `false`**） |
| `D1_BASE_URL` | 指向 `d1-http` 的地址（新增的写路径覆盖） |
| `WORKER_READ_URL` / `WORKER_READ_SECRET` | 读路径（`read` 容器服务名 + 密钥） |
| `WORKER_INGEST_URL` / `WORKER_SECRET` | 写路径（`ingest` 容器服务名 + 密钥）。**实现更正 2026-10-18**：四条 ingest 路由统一经 `resolveIngestUrl()` 推导——变量带不带 `/ingest` 后缀、带不带尾斜杠都可；此前 token 路由直接使用原值，自托管默认值（无后缀）会让每次 token 上传打到 worker 根路径并 404（E2E 注入的是带后缀形态，掩盖了该缺陷） |
| `ADMIN_EMAILS` | 管理员邮箱列表（`lib/admin.ts`）。**可选**：库内 `is_admin` 与它取或——首个 `/setup` 用户即管理员（`lib/admin.ts:67-74,113-115,136`）；无 `/setup` 的旧部署才依赖它 |
| `PEW_HOST` | （CLI 侧）指向自建服务。**已生效**（Plan 2 交付：`cli/src/commands/login.ts` 的 `--host` / `PEW_HOST` 支持）。**实现更正 2026-10-20**：`pew sync` / `pew logout` 此前只认这个环境变量，现也接受 `--host`（优先级高于 `PEW_HOST`），与 `pew login` 一致；三者共用 `credentialHostScope()` 决定读哪个凭据文件 |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 可选；不配置则隐藏 Google 登录按钮。**内网 http 下 Google OAuth 不可用**（回调须 https） |
| `CF_R2_ENDPOINT` / `CF_R2_ACCESS_KEY_ID` / `CF_R2_SECRET_ACCESS_KEY` / `CF_R2_BUCKET` | 团队/组织 logo 上传；缺则 `lib/r2.ts` throw（logo API 500）。可用 MinIO |
| `CF_ACCOUNT_ID` / `CF_D1_DATABASE_ID` | 自建下仅需非空占位（写路径已切 `D1_BASE_URL`）；构建用占位值 |
| `CF_D1_API_TOKEN` | **真实密钥**（d1-http 的 Bearer 校验，见 §4.1 专项三）；**仅 `d1-http`/`web` 两个服务持有**——`read`/`ingest`/`scheduler` 直连 rqlite、不经 d1-http，不需要也不应拿到它；构建期用占位值。（实现更正 2026-10-17：原文写"`migrate`/`d1-http`/`web` 三个"——交付 compose 的 `migrate` 只注入 `RQLITE_*`，不持有该 token，与 §4.1 的实现更正一致。） |
| `COMPOSE_PROFILES` | compose profile 默认值：`single`（单节点，默认）或 `cluster`（3 节点）。放 compose 目录 `.env`，使裸 `docker compose up -d` 起单节点 |
| `DAILY_INTERVAL_MS` | scheduler 定价同步间隔（ms），默认 86400000（24h）；由 compose 透传给 `scheduler` 容器 |

## 12. 超出本设计范围

- 企业级 AI Agent 治理能力（策略、RBAC、审计、合规报表）
- 数据层迁往 PostgreSQL
- 多租户与组织级隔离增强
- 从 Cloudflare 形态迁移已有数据（如需，另行设计导出/导入）
- 完整的反向代理 / TLS 终结配置（写入部署文档，不进设计）
