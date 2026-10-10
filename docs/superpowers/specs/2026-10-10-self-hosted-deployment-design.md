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
│ Next.js standalone（官方镜像，逻辑零改动）    │
│  · 读 → WORKER_READ_URL   （HTTP）           │
│  · 写 → CF_D1_API_TOKEN   （D1 REST 形状）   │
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

**Web 容器零改动。** 它仍以为自己在连 Cloudflare——实际连的是自建的 d1-http 与两个本地服务。这是「保同步」的核心：上游对 Web 的任何改动都能直接合并。

**Worker 业务逻辑零改动。** `packages/worker` 与 `packages/worker-read` 的 `fetch` 处理器是标准 `Request → Response` 形状，套一层 `node:http` 适配即可在 Node 运行，不触碰其内部实现。

**差异全部收敛在适配层。** 新增代码只存在于新目录，上游文件不被修改。

## 4. 组件设计

### 4.1 `deploy/selfhost/d1-adapter` — D1 形状适配层

实现 Cloudflare D1 绑定接口，底层接 rqlite。

```ts
interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results: T[]; meta: D1Meta }>;
      first<T>(column?: string): Promise<T | null>;
      run(): Promise<D1Meta>;
    };
  };
  batch(stmts: Array<{ sql: string; params?: unknown[] }>): Promise<Array<{ results: unknown[]; meta: D1Meta }>>;
}
```

**rqlite 映射**（每一条都是实测确认的坑）：

| D1 语义 | rqlite 实现 | 注意 |
|---|---|---|
| 参数编码 | **扁平数组 `[sql, p1, p2]`** | **不是**嵌套 `[sql, [p1,p2]]`。实测嵌套形式在 `/db/query` 下静默返回空结果、在 `/db/execute` 下报 `unsupported type string`——这是最容易静默出错的陷阱 |
| `prepare().all()` | `POST /db/query?associative` | 带 `associative` 时响应 `rows` 为对象数组，即 D1 的 `results`（不带时是 `columns`+`values` 数组形状） |
| `prepare().run()` | `POST /db/execute` | 写语句必须走 execute 或统一端点 `/db/request`；`/db/query` 对写语句返回错误「attempt to change database via query operation」 |
| `batch()` | `POST /db/execute?transaction=true` | **必须带 `transaction=true`**，否则语句间不原子（实测夹坏语句时前后两条照样落库） |
| `meta.changes` | `rows_affected` | **字段在值为 0 时被省略**（实测 `UPDATE` 影响 0 行时只返回 `last_insert_id`），必须 `?? 0` |
| `meta.duration` | rqlite 的 `time`（秒） | 需换算为毫秒 |
| `meta.last_row_id` | `last_insert_id` | 只读语句上该值是上一条的残留值，需甄别 |
| DDL | `POST /db/execute` | 实测 DDL 返回空对象 `{}`，无 `rows_affected` |
| 错误 | **HTTP 仍为 200** | 必须逐条检查 `results[i].error` 并抛错，否则静默吞错 |

**多节点与故障切换**：适配层维护节点地址池，遇 503 `leader not found` 或连接失败时轮换重试。rqlite 的 follower 会服务端透明转发写给 leader，客户端无需感知 leader 身份。

**版本要求**：**必须 ≥ v10**。v9.x 存在「batch 中带 RETURNING 的语句失败时事务不回滚」的缺陷，而本项目在 batch 中混用了 RETURNING（`packages/worker/src/accounting-sql.ts:24`、`packages/web/src/app/api/teams/[teamId]/route.ts:256,272`）。

### 4.2 `deploy/selfhost/kv-adapter` — KV 形状适配层

`worker-read` 使用 KV 的 5 个调用点（`env.CACHE`），用于动态定价缓存。用 SQLite 表实现同名接口：

```sql
CREATE TABLE kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT
);
```

需实现 `get(key, "json")` / `put(key, value)` / `delete(key)` / `list({prefix})`。放在同一 SQLite 库中，随 rqlite 一起复制。

### 4.3 `deploy/selfhost/node-runtime` — Worker 运行时宿主

把 `export default { fetch, scheduled }` 挂到 `node:http` 上：

- `fetch` → 标准 `Request`/`Response` 转换（Node 22 原生支持 Web 标准）
- `scheduled`（worker-read 的定价同步 cron）→ 进程内定时器或独立调度容器
- `env` 注入：`DB`（D1 形状适配）、`CACHE`（KV 形状适配）、各 secret

**Web 侧注意**：官方镜像的 `server.js` 硬写 `process.env.NODE_ENV = 'production'`，无法用环境变量覆盖。

### 4.4 认证：邮箱 + 密码

**新增 Auth.js Credentials provider**（`packages/web/src/auth.ts` 是上游文件，本项需小幅修改，属可接受的改动面）。

- 新增迁移：`users` 表加 `password_hash` 字段（`ALTER TABLE`，符合现有迁移风格）
- 哈希：`node:crypto` 的 `scrypt`，无需新增依赖
- 注册：沿用现有邀请码机制（`lib/invite.ts`），首个账号通过预置邀请码或关闭 `require_invite_code` 引导
- Google provider 保留，用环境变量控制启用（不配置即不显示）

**HTTP 内网部署的 cookie 问题（必须处理）**：`shouldUseSecureCookies()` 在 `NODE_ENV === "production"` 时返回 true，而镜像硬编码 production，导致内网 HTTP 下浏览器不回传 `__Secure-` cookie、登录失效。`USE_SECURE_COOKIES` 只能往「开」覆盖。需增加显式关闭开关（如 `USE_SECURE_COOKIES=false` 生效），并同步调整 `proxy.ts` 的 origin 推导。

### 4.5 CLI：支持指向自建服务

- `resolveHost()` 增加来源优先级：`--host` 参数 > `PEW_HOST` 环境变量 > 现有 `dev`/`DEFAULT_HOST` 逻辑
- 影响点：`packages/cli/src/cli.ts:389,556`（两处 `resolveHost` 调用）、`packages/cli/src/commands/login.ts`
- 上传路径（`runUpload` / `runSessionUpload`）沿用同一 host 解析

### 4.6 部署编排

`deploy/selfhost/docker-compose.yml`：

| 服务 | 说明 |
|---|---|
| `rqlite` | 1 节点（默认）或 3 节点（profile 切换），持久卷，**必须带 `-fk`** |
| `d1-http` | D1 REST 形状 HTTP 服务 |
| `read` | worker-read 宿主 |
| `ingest` | worker 宿主 |
| `web` | 官方镜像，注入指向上述服务的环境变量 |

**rqlite 关键启动参数**：

```
-fk                       # 必须：外键默认关闭，而 schema 有 12 处 ON DELETE CASCADE
-bootstrap-expect=3       # 仅首次集群启动设置一次
-join <peers>             # 集群模式
-node-id <stable-id>      # 集群模式下不可变
```

## 5. 数据流

**写入（CLI 上传）**：CLI → `web:/api/ingest` → `ingest 容器` → `d1-http` → rqlite（批量 upsert，事务原子）

**读取（仪表盘）**：`web` → `read 容器` → `d1-http` → rqlite

**登录**：浏览器 → `web:/api/auth/*` → Credentials provider → 校验 scrypt 哈希 → JWT 会话

**定时任务**：`read 容器` 内定时触发动态定价同步（替代 CF cron trigger）

## 6. 测试策略

| 层级 | 内容 |
|---|---|
| 适配层单元测试 | D1 形状映射（含 `rows_affected` 缺失、错误在 200 内、duration 换算） |
| 迁移兼容测试 | 全部 30 个迁移（33 个文件中跳过 3 个被 squash 的）apply 到 rqlite，断言 schema 对象数（23 表 / 62 索引 / 12 触发器 / 2 视图） |
| 原子性测试 | batch 中夹坏语句，断言零残留 |
| 端到端 | compose 起全栈，跑通「CLI 登录 → 同步 → 仪表盘可见」 |
| 上游同步回归 | 合并上游 main 后，上述测试全部通过 |

迁移执行方式变更：从 `wrangler d1 execute --file` 改为「读文件 → 按语句切分（正确处理 `CREATE TRIGGER ... BEGIN ... END`）→ 整批事务执行」。

## 7. 风险与待决项

| 风险 | 说明 | 处置 |
|---|---|---|
| **无静态加密** | rqlite 不支持落盘加密 | 依赖加密文件系统（LUKS / 云盘加密）兜底；若合规硬性要求加密，需重新选型 |
| **无原生 Prometheus** | 2018 年的 issue 仍 open | 自写 exporter 抓 `/status`、`/debug/vars` |
| **无审计日志** | 无内建审计 | 靠 CDC 外接外部日志系统；属后续工作 |
| **RBAC 粗粒度** | 仅按端点的权限位 | 多租户隔离在应用层做 |
| **bus factor = 1** | 单人维护，无商业支持 | 接受；MIT 许可下可自行 fork |
| **写不水平扩展** | Raft 单 leader 串行 | 批量路径实测数万行/秒，量级足够 |
| **Web 需小幅改动** | 认证与 cookie 开关需改上游文件 | 改动面尽量小，便于后续合并 |

### 待决项

1. **rqlite 节点数**：单节点（简单，无 HA）还是 3 节点（需 3 台机器或同机 3 容器，后者只防进程故障）。默认单节点 + 备份，生产建议 3 节点。
2. **首个管理员引导**：预置邀请码，还是部署时关闭 `require_invite_code` 后由首个注册者自动成为管理员（`ADMIN_EMAILS`）。
3. **上游合并策略**：本分支改动集中在新增目录，但认证与 cookie 改动触及上游文件——需定期 rebase 验证。

## 8. 超出本设计范围

- 企业级 AI Agent 治理能力（策略、RBAC、审计、合规报表）
- 数据层迁往 PostgreSQL
- 多租户与组织级隔离增强
- 从 Cloudflare 形态迁移已有数据（如需，另行设计导出/导入）
