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

**两套镜像，别混**：跑 bun 的适配层服务（migrate/d1-http/read/ingest/scheduler）用
`deploy/selfhost/Dockerfile` 构建的 `pew-selfhost:local`；`web` 用**仓库根 `Dockerfile`**
构建的 `pew:standalone`（Next standalone）。把 web 指到 `pew-selfhost:local` 会因无 Next
产物、无 CMD 而退出。

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
- 真实密钥只写在 `deploy/selfhost/.env`：`.gitignore` 的 `.env` 规则使其**不入库**；`.dockerignore`
  用 `**/.env` 匹配任意层级，使其**不进镜像**（注意必须是 `**/.env`——裸 `.env` 只排除构建上下文
  根目录，`deploy/selfhost/.env` 会被 `COPY deploy deploy` 带进 `pew-selfhost:local` 的最终层）。
  构建与 compose 里出现的 `CF_ACCOUNT_ID`/`CF_D1_DATABASE_ID` 是占位串，不是凭据。

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
# 1. 停应用（读写都停，避免恢复期间写入；d1-http 是写后端，必须一起停）
docker compose stop web read ingest scheduler d1-http
# 2. 把备份放进 rqlite 容器（rqlite 保持运行，.restore 不需要停它）
docker compose cp "./backup-2026-10-11.db" rqlite:/rqlite/file/restore.db
# 3. 用点命令恢复（经 Raft 应用，单节点/集群同一路径）
printf '.restore /rqlite/file/restore.db\n.exit\n' | docker compose exec -T rqlite rqlite -H localhost
# Expected: Database restored successfully
# 4. 起应用并验证
docker compose start d1-http read ingest scheduler web
docker compose exec web node -e "fetch('http://127.0.0.1:7020/api/live').then(r=>r.json()).then(console.log)"
```

## 交付边界

本计划（Plan 1）**不提供可用的交互式登录**。Google OAuth 不接受内网 http 回调，邮箱+密码在
Plan 2。Plan 1 交付的是「数据层与运行时可用、API 可经 CLI/密钥调用」。完整可用性以 Plan 2 为准。

## 合并上游

本分支与上游的接触面只有两处：`packages/web/src/lib/d1.ts`（新增 `D1_BASE_URL` 优先级）与
`vitest.config.ts`（`test.include` 增加 `deploy/**/*.test.ts`）。`packages/worker/**` 与
`packages/worker-read/**` 完全未改。

> 注意：这是 **Plan 1 的**接触面。Plan 2（认证子系统）还会改 `auth.ts`、`lib/admin.ts`、
> `proxy.ts` 等；合并回归时按 Plan 2 的清单重新确认。

```bash
git fetch upstream main
git merge upstream/main
bun run test
docker compose build web && docker compose up -d
curl -s http://127.0.0.1:7020/api/live
```

若上游改动触及 `lib/d1.ts` 的构造函数，重新确认 `D1_BASE_URL` 的优先级仍在 `localD1BaseUrl`
之前；若上游改到 `vitest.config.ts` 的 `include`，确认 `deploy/**/*.test.ts` 仍被收集。
新增上游迁移后，重跑 `verify-migrations.ts` 并更新其 `EXPECTED` 计数。

