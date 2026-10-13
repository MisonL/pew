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

## 登录与初始化（Plan 2）

浏览器登录用**邮箱 + 密码**，无需外部 OAuth：

1. **首次部署**：访问 `/setup`（登录页在实例为空时会显示「Create the administrator
   account」入口）。第一个注册的用户自动成为管理员（库内 `is_admin=1`）。
2. **邀请后续用户**：管理员在后台生成邀请码，新用户带邀请码注册。
3. **密码重置**：管理员可为用户签发一次性重置令牌（无邮件能力，令牌线下交付）。
   若**管理员自己**也进不去，用破窗脚本直连 rqlite 改密：

   ```bash
   RQLITE_URL=http://127.0.0.1:14001 bun deploy/selfhost/reset-password.ts \
     --email admin@corp.local --password 'new-secret-123'
   ```

   改密后旧会话自动失效（JWT 携带密码版本号，不匹配即判无效）。

**限速**：登录限速是**进程内**的（`inMemoryRateLimiter`），多 `web` 副本时退化为按副本
计；且它信任 `X-Forwarded-For`，反代必须清洗/覆写该头。单副本部署下按 IP + 邮箱限流。

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

## 反向代理

推荐形态：**Caddy 以 compose 服务加入**（`reverse_proxy web:7020`，在 compose 网络内解析上游；
发布 80/443）。次选宿主 Nginx（上游指向 `127.0.0.1:7020`，配合下述端口改绑）。

### Caddy（推荐）

两行配置自动 HTTPS；**需 Caddy ≥ 2.5**——[官方文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
确认 v2.5 起 `reverse_proxy` **默认忽略入站 `X-Forwarded-For`** 并自行设置该头以防伪造
（"the proxy will ignore their values from incoming requests, to prevent spoofing"），
天然满足我们的 XFF 覆写硬约束，无需额外 `header_up`。无公网 DNS 的内网域名需在站点块里
取消注释 `tls internal`（自签证书）或走 DNS-01。

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

接入骨架见 `docker-compose.caddy.yml` + `Caddyfile`（把 `Caddyfile` 里的
`example.intranet.corp` 换成你的内网域名）。

### Nginx（宿主，次选）

完整 server 块示例——三条 `proxy_set_header` 与 `client_max_body_size` **都不可省**：

```nginx
server {
    listen 443 ssl;
    server_name pew.example.corp;
    # ssl_certificate ...; ssl_certificate_key ...;

    client_max_body_size 25m;   # worker 允许 /ingest/details 至 24MB；默认 1m 会直接 413

    location / {
        proxy_pass http://127.0.0.1:7020;
        proxy_set_header Host $host;                        # 默认 $proxy_host 会让 Auth.js 的 trustHost origin 校验失败、登录全挂
        proxy_set_header X-Forwarded-For $remote_addr;      # 覆写，不是 $proxy_add_x_forwarded_for（追加，保留攻击者伪造段）
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### ★ 硬约束清单

- ★ **web 的 7020 端口只绑 `127.0.0.1` 或不发布**：任何能直连 7020 的客户端都可以整体伪造
  `X-Forwarded-For` 第一段，反代清洗形同虚设（`getClientIp` 取第一段）。用 `docker-compose.proxy.yml`
  覆盖文件把端口改绑到回环：

  ```bash
  # !override 替换（而非追加）基础 compose 的 ports 列表，需 Compose >= v2.24.4
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml config   # 冒烟核对合并结果
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
  ```

  注意：此约束防的是**网络外**直连；同宿主其他本地用户进程仍可达 `127.0.0.1:7020`（多租户宿主
  属部署者自担），compose 网络内攻击者本就绕过 web 直达数据层，7020 收紧不改变该模型。
- ★ **`NEXTAUTH_URL` 必须与反代对外访问 URL 逐字符一致**（协议+域名+端口；`TRUSTED_ORIGIN`
  永远 pinned 到它，不一致则重定向/回调指向错误主机）。CLI 侧 `PEW_HOST` 同步。
- ★ **反代必须覆写 `X-Forwarded-For`**（pew 取第一段），同时覆写 `X-Real-IP`、清空
  `CF-Connecting-IP`（`getClientIp` 依次信任三者）。Caddy ≥ 2.5 默认满足；Nginx 按上面
  `$remote_addr` 覆写。
- **漏配 XFF 的后果**：`X-Forwarded-For` 缺失时所有登录请求都落到 `login:ip:unknown`
  **共享限速桶**，攻击者打满该桶即造成**全员登录 DoS**（fail-closed 方向）——这是上面
  XFF 覆写为硬约束的直接原因。

### Cookie 与 USE_SECURE_COOKIES

镜像以 `NODE_ENV=production` 运行，secure cookie 默认开启；`.env.example`/compose 默认
`USE_SECURE_COOKIES=false` 显式覆盖。**https 部署必须显式改 `USE_SECURE_COOKIES=true`**。

| 部署协议 | USE_SECURE_COOKIES | 结果 |
|---|---|---|
| https | true | ✓ 正常（`__Secure-` 前缀 cookie） |
| https | false | 可登录，但无 `__Secure-` 前缀（**降级可用**，不是浏览器丢弃） |
| http | true（或未显式 false） | **登录坏**——`__Secure-` cookie 被 http origin 拒收（镜像 `NODE_ENV=production` 下这是默认行为） |
| http | false | ✓ 正常 |

`TRUSTED_ORIGIN` 由 `NEXTAUTH_URL` 推导，无需单独配置。

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
bun run test                                    # 单元测试（含 deploy/selfhost 的适配层用例）
bun run deploy/selfhost/verify-migrations.ts --base-url http://127.0.0.1:14001
```

> **已知类型检查缺口**：`deploy/selfhost/` 不在 `bun run typecheck` 范围内（它只覆盖
> `packages/*` 与 e2e 清单），因此适配层与上游 `D1Database`/`KVNamespace` 的类型兼容性没有编译期
> 校验。原因：`deploy/` 通过**源码**导入两个 worker，而 worker 的 `@cloudflare/workers-types`
> 是 per-package 安装、不从仓库根解析；用一份独立 tsconfig 拉入 worker 源码会与 worker 自身的
> workers-types 实例冲突（`KVNamespace` 双重身份，5 处假报错）。运行时由 75 个 vitest 用例覆盖。
> 若要补齐，正确做法是给 worker 包加 `composite: true` 并输出声明、用 project references——但那要改
> 上游 `tsconfig`，超出 Plan 1 的「只改两个上游文件」约束，列为后续项。


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

Plan 1 交付「数据层与运行时可用、API 可经 CLI/密钥调用」。Plan 2（认证子系统）补齐
**完整的浏览器登录闭环**：`/setup` 首个管理员 → 邀请码邀请后续用户 → 邮箱密码登录 →
管理员重置密码。**外网/邮件自助重置**不在本期（无 SMTP），密码重置为管理员线下交付
令牌，或用破窗脚本。多 `web` 副本时登录限速退化为按副本计（见上）。

## 合并上游

上游接触面分两批：

**Plan 1（数据层）**：`packages/web/src/lib/d1.ts`（新增 `D1_BASE_URL` 优先级）与
`vitest.config.ts`（`test.include` 增加 `deploy/**/*.test.ts`）。

**Plan 2（认证）**：`auth.ts`（条件 providers、Credentials、`pwd_v`、`USE_SECURE_COOKIES`
分支）、`app/login/page.tsx`（邮箱密码表单）、`lib/admin.ts` + `api/admin/check` +
`api/users/[slug]`（库内 `is_admin` 判定）、`proxy.ts`（`/setup` 公开）、`cli.ts` +
`cli/src/commands/login.ts` + `cli/src/config/manager.ts`（`--host`/`PEW_HOST` 与按 host
隔离凭据）。新增文件（`lib/credentials.ts`、`app/setup/`、`app/api/auth/register|reset-password|
login-options`、`api/admin/users/[userId]/reset-password` 等）不与上游冲突。

`packages/worker/**` 与 `packages/worker-read/**` 完全未改。

```bash
git fetch upstream main
git merge upstream/main
bun run test
docker compose build web && docker compose up -d
curl -s http://127.0.0.1:7020/api/live
# 认证回归：/setup 可达、登录成功、改密后旧会话失效
```

若上游改动触及 `lib/d1.ts` 的构造函数，重新确认 `D1_BASE_URL` 的优先级仍在 `localD1BaseUrl`
之前；若上游改到 `vitest.config.ts` 的 `include`，确认 `deploy/**/*.test.ts` 仍被收集；
若上游改到 `auth.ts` 的 `signIn` 回调或 `admin.ts` 的 `isAdmin`/`resolveAdmin`，重新确认
Credentials 放行分支与库内管理员判定仍在。新增上游迁移后，重跑 `verify-migrations.ts` 并
更新其 `EXPECTED` 计数。

