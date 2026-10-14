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

### 启用 rqlite 鉴权（可选，固定序列）

默认无鉴权（上文 Quickstart 即无鉴权路径）。要启用时在 `.env` 填三个变量：
`RQLITE_USERNAME`、`RQLITE_PASSWORD`、`RQLITE_JOIN_PASSWORD`——**三要素缺一不可**，
任一为空 = 整体不启用（渲染脚本会拒绝产出并清掉残留文件）。read/scheduler 等所有
应用服务直接使用这对全权凭据（compose 已内置 `${RQLITE_USERNAME:-}`/`${RQLITE_PASSWORD:-}`
fallback）。

**必须严格按以下三步的顺序执行：**

1. **先渲染 auth.json**（读 `.env` 三个变量，产出 `deploy/selfhost/.rqlite-auth.json`，
   umask 077 / 权限 600——明文密码，同宿主其他用户不可读）。注意：脚本读的是**进程
   环境变量**，`.env` 不会被 compose 之外的命令自动导出，必须先 source：

   ```bash
   set -a; . ./.env; set +a; bash render-rqlite-auth.sh
   ```

   期望失败路径：若渲染脚本报「must all be set (or all empty)」退出 1，先核对 `.env`
   三个变量是否都已填写非空（且当前 shell 确实 source 了 `.env`），再重试。

2. **再启动**：

   ```bash
   docker compose up -d --build
   ```

3. **自检**（rqlite 未发布宿主端口，在容器内探测；auth.json 的 `*` 条目允许匿名读
   `/status`，所以匿名探测就能看出鉴权状态）：

   ```bash
   docker compose exec rqlite wget -qO- http://localhost:4001/status | grep -o '"auth":"[a-z]*"'  # single
   # cluster: 把 rqlite 换成 rqlite-1
   # Expected: "auth":"enabled"
   # 若显示 "auth":"disabled"：凭据已配置但服务端以无鉴权启动 —— 立即停下按上面序列重做
   ```

   带凭据复核（应 200 且 `enabled`）：`docker compose exec d1-http bun -e
   "fetch('http://rqlite:4001/status',{headers:{Authorization:'Basic '+btoa(process.env.RQLITE_USERNAME+':'+process.env.RQLITE_PASSWORD)}}).then(r=>r.json()).then(s=>console.log(s.http.auth))"`
   （d1-http 容器已从 `.env` 注入这对凭据）。

**⚠ 先 up 后 render 会以无鉴权静默启动。** rqlite 在无 `-auth` 时忽略一切 Authorization
头——客户端带凭据请求也是 200 静默成功（不是 401）。这是整个鉴权设计里最危险的失败模式：
migrate 启动时的对账自检会显式报错（「credentials configured but auth is disabled」），但
别指望它兜底，**render 必须先于 up**。

## 登录与初始化（Plan 2）

浏览器登录用**邮箱 + 密码**，无需外部 OAuth：

1. **首次部署**：访问 `/setup`（登录页在实例为空时会显示「Create the administrator
   account」入口）。第一个注册的用户自动成为管理员（库内 `is_admin=1`）。
2. **邀请后续用户**：管理员在后台生成邀请码，新用户带邀请码注册。
3. **密码重置**：管理员可为用户签发一次性重置令牌（无邮件能力，令牌线下交付）。
   若**管理员自己**也进不去，用破窗脚本直连 rqlite 改密。rqlite 不发布宿主端口，**必须
   在容器内跑**；鉴权开启时凭据经 `-e` 传入 exec 环境（脚本读 `RQLITE_USERNAME`/
   `RQLITE_PASSWORD` 自动发 Basic 头；无鉴权部署则两个 `-e` 都可省）：

   ```bash
   set -a; . ./.env; set +a   # 把 .env 凭据导出到当前 shell，供下方 $(...) 读取
   docker compose exec -T \
     -e RQLITE_URL=http://rqlite:4001 \
     -e RQLITE_USERNAME="$RQLITE_USERNAME" \
     -e RQLITE_PASSWORD="$RQLITE_PASSWORD" \
     d1-http \
     bun /app/deploy/selfhost/reset-password.ts \
       --email admin@corp.local --password 'new-secret-123'
   ```

   （脚本在 `pew-selfhost:local` 镜像内的路径是 `/app/deploy/selfhost/reset-password.ts`，
   `d1-http` 与 rqlite 同网络且 `RQLITE_URL` 默认就指 `http://rqlite:4001`。）

   改密后旧会话自动失效（JWT 携带密码版本号，不匹配即判无效）。

**限速**：登录限速默认**进程内**（`inMemoryRateLimiter`），多 `web` 副本时退化为按副本
计；且它信任 `X-Forwarded-For`，反代必须清洗/覆写该头。默认路径按**邮箱单键**
限流（`login:<email>`，无 IP 维度）；只有 `LOGIN_RATE_LIMIT_BACKEND=rqlite` 时才
启用邮箱 + IP 双键。

**登录限速后端开关 `LOGIN_RATE_LIMIT_BACKEND`**（`.env`/compose，默认 `memory`）：
设为 `rqlite` 时登录失败计数外置到 rqlite 的 `rate_limit_hits` 表（单条原子
INSERT...SELECT，多 web 副本共享同一计数），双键 `login:email:<email>` 与 `login:ip:<ip>` 各查一次——email 键攻击者可任意轮换，**IP 键是唯一硬防线**（IPv6 按
  /64 前缀归并防隐私扩展轮换）。已知绕过（如实注明）：反代漏配 XFF 时全部请求落
`login:ip:unknown` 共享桶，打满即全员登录 DoS——按反代小节的 XFF 硬约束部署即可避免。
rqlite 后端写异常时 **fail-open 放行并告警**（不误判为超限拒绝）；仅 `meta.changes=0`
（计数满）才拒绝。已知绕过（如实注明）之二：双键的键值（随机 email / 伪造 IP 变体）
由攻击者任意构造，可直接向 `rate_limit_hits` 表洪注新行——**存储放大面**；缓解是每次
写入路径自带 1% 采样清理（DELETE 限 3600s 窗口），异常洪注不会无限累积，但长期运行的
实例应关注该表体积。

**仅登录限速受此开关影响。** 其余 5 处消费方**显式保持 memory 后端**，原因如下：

| 消费方 | 保持 memory 的原因 |
|---|---|
| auth-code 生成 | 高频短窗口，外置反而放大 DB 压力；泄露面在邮件/线下令牌交付，不在爆破 |
| auth-code 校验 | 同上；且校验失败有独立的人工重发路径兜底 |
| CLI auth | 单用户低频操作，进程内计数足够 |
| team join | 邀请码本身是低熵通道但已有邮箱域约束，访问量极低 |
| ingest 写入 | 限 300/min——走 rqlite 后端则每请求 2 次 DB 往返（计数+清理），把限速本身变成写放大源，得不偿失 |

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

**跨机部署的额外要求**：三节点的 auth.json 必须**同源渲染、逐字节一致**（joiner 校验看
文件里同名用户的密码，文件不一致则部分节点 join 失败）；任何凭据变更（含轮换）= **全部
节点 recreate**（rqlite 不热加载 auth）；节点间 join/复制流量走 **4002 明文**（无 TLS），
跨公网/不可信网段必须套 WireGuard 或限制在私有网段。

**三节点降级信号**：

- **单节点 down** → 集群仍有多数派（2/3 可写，可读），**不是只读**；但冗余已减一。
  信号：该节点容器退出/重启、`/status` 的 `leader` 字段仍非空（多数派正常）、web 读写
  均正常。恢复该节点即回到 3/3，无需人工干预。
- **两节点 down** → 集群只读不可写（多数派丢失，raft 拒写；weak 读同样打向 leader，
  也 fail）。恢复时**两台同时恢复**，不要逐台改配置——auth.json 不一致会导致
  recreate 后 join 失败。
- read 副本 down 不影响写路径，故障信号仅在容器日志。

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
- 多 web 副本时登录限速（默认 memory 后端）会退化为按副本计，见 spec §7 风险表；
  可用 `LOGIN_RATE_LIMIT_BACKEND=rqlite` 外置（见「登录与初始化」小节）。

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
# caddy overlay 已通过 ports: !override [] 移除 web 的 0.0.0.0:7020 发布
# （即自动满足硬约束清单的「7020 不对外发布」），无需再叠加 proxy overlay。
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
        proxy_set_header X-Real-IP $remote_addr;            # 不覆写则攻击者伪造的 X-Real-IP 穿透到 web，IP 限速键可伪造
        proxy_set_header CF-Connecting-IP "";               # 同理：getClientIp 依次信任 XFF/X-Real-IP/CF-Connecting-IP
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

- **rqlite 鉴权是可选开关，默认关**（`.env` 三变量 `RQLITE_USERNAME`/`RQLITE_PASSWORD`/
  `RQLITE_JOIN_PASSWORD` 全非空即启用，见 Quickstart 的固定序列）。默认路径下 compose
  网络内任何容器都可无凭据直连数据库读写，唯一防线是网络隔离（rqlite 不发布宿主端口、
  仅 compose 网络内可达）。启用后：rqlite 以 `-auth` 启动；应用侧所有服务（migrate/
  d1-http/ingest/read/scheduler）都用同一对全权凭据——**不设只读用户**（rqlite 10.5.3
  无 `select` 权限名，且 read/scheduler 有 `/db/request` 写路径，只读用户在此架构
  不可达）；`*` 通配条目仅有 `[status, ready]` 权限，消费者是 rqlite 自身 `/readyz`
  探针与 migrate 自检的匿名探测——**不要删除该条目**（见下方 runbook 的误删后果），
  也不要给它加写权限。cluster 模式下 joiner 是专用 `[join]` 用户，集群互连不复用应用
  凭据；`-join-as` 依赖 auth.json 已渲染并挂载（entrypoint 只在文件存在时追加
  `-auth`，未渲染时 join 无凭据可用）。注意：容器内凭据仍可经 `/proc/1/environ`
  或 `docker inspect` 读出（同宿主 RCE 即全库凭据），这是已接受并如实注明的结构性弱点；
  网络内的 migrate 对账自检只防配置错误，不做安全边界。
- **`CF_D1_API_TOKEN` 只保护 web → d1-http 这一跳**。read/ingest/scheduler 直连 rqlite，不需要
  这个 token，因此 compose **只把它下发给 `migrate`、`d1-http`、`web`**（`d1-http` 是校验方、
  `web` 是客户端、`migrate` 建表初始化）；`read`/`ingest`/`scheduler` 的 `environment` 不含它，
  收窄了密钥在容器内的暴露面。
- 真实密钥只写在 `deploy/selfhost/.env`：`.gitignore` 的 `.env` 规则使其**不入库**；`.dockerignore`
  用 `**/.env` 匹配任意层级，使其**不进镜像**（注意必须是 `**/.env`——裸 `.env` 只排除构建上下文
  根目录，`deploy/selfhost/.env` 会被 `COPY deploy deploy` 带进 `pew-selfhost:local` 的最终层）。
  同理 `.dockerignore` 也有 `**/.rqlite-auth.json`（auth.json 是明文密码 JSON，同样会经
  `COPY deploy deploy` 进层）。构建与 compose 里出现的 `CF_ACCOUNT_ID`/`CF_D1_DATABASE_ID` 是占位串，不是凭据。

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
# verify-migrations 对账真实实例（rqlite 未发布宿主端口，在容器内跑；鉴权开启时凭据经 -e 传入）：
set -a; . ./.env; set +a
docker compose exec -T \
  -e RQLITE_URL=http://rqlite:4001 \
  -e RQLITE_USERNAME="$RQLITE_USERNAME" \
  -e RQLITE_PASSWORD="$RQLITE_PASSWORD" \
  d1-http \
  bun /app/deploy/selfhost/verify-migrations.ts --base-url http://rqlite:4001
```

> **已知类型检查缺口**：`deploy/selfhost/` 不在 `bun run typecheck` 范围内（它只覆盖
> `packages/*` 与 e2e 清单），因此适配层与上游 `D1Database`/`KVNamespace` 的类型兼容性没有编译期
> 校验。原因：`deploy/` 通过**源码**导入两个 worker，而 worker 的 `@cloudflare/workers-types`
> 是 per-package 安装、不从仓库根解析；用一份独立 tsconfig 拉入 worker 源码会与 worker 自身的
> workers-types 实例冲突（`KVNamespace` 双重身份，5 处假报错）。运行时由 75 个 vitest 用例覆盖。
> 若要补齐，正确做法是给 worker 包加 `composite: true` 并输出声明、用 project references——但那要改
> 上游 `tsconfig`，超出 Plan 1 的「只改两个上游文件」约束，列为后续项。


## 备份

rqlite 的 CLI **没有** `backup` 子命令；备份是交互式 REPL 里的 `.backup` 点命令
（非交互场景经 stdin 管道喂 `.backup` + `.exit`，如下例）。
直接 `cp` 活跃的数据库文件会拿到损坏的副本，不要那样做。

替代通道是 HTTP 端点 **`GET /db/backup` 带 `-u user:pass`**（10.5.3 实测 200，返回全库
SQLite 文件；`POST /db/backup` 是 405；`GET /backup`（少 `/db` 前缀）是 404）。
鉴权开启时凭据即 `.env` 的 `RQLITE_USERNAME`/`RQLITE_PASSWORD`；rqlite 未发布宿主端口，
HTTP 方式需在容器内执行。

**备份后务必校验文件非空**：实测 `.backup` 失败仍会创建 0 字节假文件，`[ -s ]` 是必须的
最后一道检查。

```bash
set -a; . ./.env; set +a   # 备份小节命令读 $RQLITE_USERNAME/$RQLITE_PASSWORD，先导出

# 单节点（REPL 点命令通道；鉴权开启时必须带 -u，匿名 .backup 会 401）
printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T rqlite rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost
docker compose cp rqlite:/rqlite/file/backup.db "./backup-$(date +%F).db"
[ -s "./backup-$(date +%F).db" ] || echo "备份为空，失败！" >&2

# 集群模式（对 leader 节点执行即可，默认 rqlite-1；.backup 读本地文件但产物经 Raft 复制）
printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T rqlite-1 rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost
docker compose cp rqlite-1:/rqlite/file/backup.db "./backup-$(date +%F).db"
[ -s "./backup-$(date +%F).db" ] || echo "备份为空，失败！" >&2
```

产物是标准 SQLite 文件（已实测：`SQLite format 3` 魔数、含全部表与 `kv_cache`）。

**恢复（必须用 `.restore` 点命令，不能换文件）**：实测直接替换数据文件无效——实际数据文件在
`/rqlite/file/data/db.sqlite`（不是 `pew.db`），且 rqlite 启动时会用 `raft.db` 重放日志，
备份后的写入会「复活」；清空整个卷再放文件则走 bootstrap 忽略预置文件。`.restore` 走 REPL、
经 Raft 正常应用（已实测：恢复后备份后的写入行消失，只剩备份时点的数据）。鉴权开启时同样
带 `-u "$RQLITE_USERNAME:$RQLITE_PASSWORD"`。

```bash
set -a; . ./.env; set +a   # 恢复命令带 -u，需先导出 .env 凭据
# 1. 停应用（读写都停，避免恢复期间写入；d1-http 是写后端，必须一起停）
docker compose stop web read ingest scheduler d1-http
# 2. 把备份放进 rqlite 容器（rqlite 保持运行，.restore 不需要停它）
docker compose cp "./backup-2026-10-11.db" rqlite:/rqlite/file/restore.db
# 3. 用点命令恢复（经 Raft 应用，单节点/集群同一路径；鉴权开启时必须带 -u user:pass，
#    集群对 leader（rqlite-1）执行即可，.restore 经 Raft 复制到其余节点）
printf '.restore /rqlite/file/restore.db\n.exit\n' | \
  docker compose exec -T rqlite rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost
# Expected: Database restored successfully
# 4. 起应用并验证
docker compose start d1-http read ingest scheduler web
docker compose exec web node -e "fetch('http://127.0.0.1:7020/api/live').then(r=>r.json()).then(console.log)"
```

## 升级

```bash
git fetch upstream main && git merge upstream/main   # 或拉取自有 fork 的对应分支
docker compose build                                 # 镜像本地构建，无远端可 pull
docker compose up -d
```

- 迁移在 `migrate` 服务启动时自动跑（`_migrations` 账本按文件名幂等，已跑过的不会重跑）。
- **rqlite 版本升级前**先做一次备份（见上），并确认新版本的 auth.json 格式兼容
  （凭据条目数组格式自 8.x 起稳定，跨大版本升级后先在测试实例验证一遍
  「自检三步」再动生产）。
- 升级后跑一次 `bun run deploy/selfhost/verify-migrations.ts` 对账表/索引计数（见「验证」小节）。

## auth.json 丢失恢复 runbook

rqlite **不热加载 auth**：任何 auth.json 内容变更（重建、轮换、修复）都必须以
**全节点 recreate**（`docker compose up -d --force-recreate rqlite`；cluster 下
`rqlite-1 rqlite-2 rqlite-3` 全部）收尾，仅换文件不重启不生效。

**警告：`*` 通配条目不可删除。** `*` 条目的消费者是 rqlite 自身 `/readyz` 探针
（compose healthcheck 无凭据访问）与 migrate 启动对账自检的匿名探测；误删 `*` 条目 →
healthcheck 401 → rqlite 容器永不 healthy → migrate（依赖
`service_healthy`）永不运行 → 启动门卡死。症状只是容器反复「unhealthy/starting」，
日志里没有明显错误，极难定位。修复：按情形 ① 重新渲染（渲染脚本总会产出含 `*` 的
完整三条目文件：全权/joiner/`*`）并 recreate。

### 情形 ①：文件还在磁盘，但内容被误删/改坏

凭据在 `.env` 里，重新渲染即可：

```bash
cd deploy/selfhost
set -a; . ./.env; set +a; bash render-rqlite-auth.sh   # 读 .env 三变量重新产出 .rqlite-auth.json
docker compose up -d --force-recreate rqlite   # cluster: rqlite-1 rqlite-2 rqlite-3 全部 recreate
```

### 情形 ②：节点/卷 recreate 且 `.env` 丢失

**数据仍在卷上但无人能连**（rqlite 开着 `-auth` 而全部凭据丢失）：

1. 从同源备份恢复 `.env`：备份的 auth.json（明文含密码，可直接反推）或部署者的凭据
   管理器。把 `RQLITE_USERNAME`/`RQLITE_PASSWORD`/`RQLITE_JOIN_PASSWORD` 找回来，
   再走情形 ①。
2. 都没有 → **只能放弃实例数据重建**：删卷重建（数据仍在但永久不可读），走 Quickstart
   固定序列重新初始化，再从 SQLite 备份文件经 `.restore` 恢复数据（备份产物是标准
   SQLite，不依赖 auth.json）。

## 回滚清理 checklist（回退 Plan 3 鉴权/限速提交时执行）

- [ ] `.env` 中删除 `RQLITE_USERNAME`、`RQLITE_PASSWORD`、`RQLITE_JOIN_PASSWORD`
      （以及若设过：`RQLITE_READ_USERNAME`、`RQLITE_READ_PASSWORD`、`LOGIN_RATE_LIMIT_BACKEND`）。
- [ ] 删除宿主磁盘上的 `deploy/selfhost/.rqlite-auth.json`（明文密码文件，不留盘）。
- [ ] 回退若触及 `.dockerignore`，确认 `**/.rqlite-auth.json` 与 `**/.env` 规则仍在或已
      一并移除——回退后若规则消失而文件残留，下一次 `docker build` 会把明文密码泄进镜像层。
- [ ] rqlite 数据卷无需清理（`rate_limit_hits` 表为冻结无害的纯新增；数据敏感性由部署者判断）。
- [ ] 迁移账本注意：`_migrations` 按文件名跳过——revert 后若以**同名文件**重做 033 且内容
      变更会被静默跳过，重做必须换文件名。

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

