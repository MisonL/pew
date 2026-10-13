# pew 私有化部署加固与运维（Plan 3）— 设计文档

**日期**：2026-10-13（v2，经三轮独立评审修订）
**状态**：设计稿，待评审确认
**前置**：Plan 1（`docs/superpowers/plans/2026-10-10-self-hosted-storage-runtime.md`）、Plan 2（`docs/superpowers/plans/2026-10-11-self-hosted-auth.md`）均已交付，分支 `feat/self-hosted-deployment`

**v2 修订摘要**（评审发现 → 修订位置）：
- `*` 通配用户权限被自己的 auth.json 击穿（匿名 join-read-only 复制全库）→ §3.1 权限收敛
- 失败矩阵「客户端有凭据/服务端未开 = 401」与实测相反（rqlite 忽略一切 Authorization 头）→ §3.1.4 改为静默成功 + 显式对账自检
- 调用点清单漏 `d1-http.ts` 自身（web 唯一写路径会全 401）→ §3.1.3
- cluster 三节点**全部**要 `-join-as` → §3.1.2
- 默认关闭路径两种天真实现都会崩（bind-mount 建目录 / 空参数元素）→ §3.1.2 明确 entrypoint 包装机制
- `.rqlite-auth.json` 会进两个镜像层 → §3.1.4 + 交付验收
- README 备份/恢复/破窗命令在鉴权下失效且备份失败留 0 字节假文件 → §3.1.4
- 限速窗口 SQL 侧生成 + 单条原子条件 INSERT（原设计的 COUNT+INSERT 竞态与格式混用两个 blocker）→ §3.2
- 限速双键（email+IP）→ §3.2；其余 5 处消费方显式保持 memory → §3.2
- compose proxy 覆盖文件 `!override` 语义 → §3.3；Nginx Host 头与 25M body → §3.3；cookie 四格矩阵 → §3.3
- verify-migrations EXPECTED/PLAN_TABLES 牵连、README 自相矛盾处、env 接线清单 → §4

---

## 1. 背景与目标

Plan 1/2 交付后，规格（`docs/superpowers/specs/2026-10-10-self-hosted-deployment-design.md`）§7 风险表与 README「安全注意事项」中遗留三项已识别但未做的强化项：

| # | 遗留项 | 现状 | 风险 |
|---|---|---|---|
| A | rqlite 无鉴权 | 实测 `/status` 返回 `http.auth = disabled`；compose 网络内任何容器可无凭据直连数据库读写 | 单容器被攻破即全库暴露（仅剩 compose 网络隔离一层） |
| B | 登录限速进程内 | `lib/rate-limit.ts` 的 `InMemoryRateLimiter` 是进程内 Map | 多 web 副本时限速按副本计，暴力破解窗口成倍放大 |
| C | 无反代/TLS 指南 | `NEXTAUTH_URL` 为 http 时 cookie 关闭 secure；反代头清洗无文档 | 部署者配错即 cookie 失效或 `X-Forwarded-For` 伪造 |

**目标**：A、B、C 各自独立可交付、独立验证，默认行为不破坏现有部署。

**非目标**（YAGNI）：
- 不做 rqlite 的 node-to-node mTLS（`-node-cert`/`-node-key`；注意 join/复制流量在 4002 端口明文传输凭据与数据——单机 compose 网络内可接受，**跨机部署需 WireGuard/私有网段**，README 注明）
- 不做登录限速的跨集群共享（自建场景单集群，rqlite 表驱动即覆盖多副本）
- 不做完整的 TLS 终结配置（只给反代示例与关键约束，配置本身属部署环境）

---

## 2. 关键实验结论（已验证）

### 2.1 rqlite 10.5.3 的鉴权机制

**实测环境**：`rqlite/rqlite:10.5.3`（镜像 digest `de385382ef6d`），docker 网络内实验（设计期 spike + 评审期 7 轮 30+ 容器复现）。

- **参数名**：`rqlited -auth <file>`。旧文档的 `-http-auth` 已不存在（`rqlited -h` 实测报 `flag provided but not defined`）。
- **文件格式**：**顶层 JSON 数组**，不是对象。错误格式（对象形）启动即 fatal：`failed to get credential store: json: cannot unmarshal string into Go value of type auth.Credential`。`perms` 缺失 = 全拒（fail-closed）；`*` 无 password 字段合法。
  ```json
  [
    { "username": "pew", "password": "secret", "perms": ["all"] },
    { "username": "joiner", "password": "join-secret", "perms": ["join"] },
    { "username": "*", "perms": ["status", "ready"] }
  ]
  ```
- **通配用户红线（评审 blocker 修订）**：`*` 的权限即匿名可做的事。**实测确认 `join-read-only` 允许无凭据节点以 `-raft-non-voter` 匿名加入集群并把全库复制到自己卷上**（本地 db.sqlite 与 leader 字节一致）——设计目标被 auth.json 自己击穿。**`*` 只允许 `["status", "ready"]`**；数据权限全在具名用户上（实测 `*`/任意密码对 `/db/query`、`/db/execute` 均 401，红线守得住）。
- **行为实测**：无凭据 → `/readyz` 200（`*` 有 `ready`）、`/db/query` **401**；带 Basic 凭据 → 查询成功。匿名 `/status`、`/nodes` 可读（拓扑/版本暴露，compose 网络内可接受，已知并接受）。
- **集群 join**：joining 节点带 `-join-as <user>`（**voter join 需 `join` 权限**；`join-read-only` 只够 read-only replica join，voter 用它实测 401）。**密码取该节点自身 auth 文件里同名用户的 password**——所以单机三节点共享同一渲染文件天然一致；跨机部署必须保证 auth.json 同源逐字节一致（rqlite 不热加载 auth 文件，轮换需 recreate 全部节点，实测）。**cluster profile 的每个节点都要 `-join-as`**（三节点全部带 `-bootstrap-expect 3` + 同一 `-join` 列表，只给部分节点会 boot timeout 崩溃循环，实测）。
- **客户端**：现有 `d1-adapter.ts` / `rqlite-client.ts` 发的是 `Bearer ${token}` 头——rqlite 不识别，等于无鉴权。需改为 `Basic base64(user:pass)`。
- **健康检查**：匿名 `wget /readyz` 在 `*` 带 `ready` 时 200 可用（compose healthcheck 无需改）；但注意这隐式依赖 `*` 条目存在——auth 文件误删 `*` 即全栈瘫（migrate 的 depends_on 永不满足），文档明示。

### 2.2 数据目录坑（部署相关，非本设计改动）

镜像以 uid=1000 `rqlite` 用户运行，数据目录必须可写。compose 现用 `/rqlite/file`（镜像内已 `chown rqlite`）挂 named volume；`-fk` 时**不要**把宿主目录直接挂到 `/data`（`mkdir /data: permission denied`，实测）。

### 2.3 rqlite 未启用 -auth 时的客户端行为（实测 + 评审复现）

**rqlite 在无 `-auth` 时忽略一切 Authorization 头**（Bearer/Basic/垃圾头均 200，`/db/execute` 建表成功）。推论：**「客户端有凭据、服务端未开」= 静默成功、无鉴权运行**，不是 401。这是整个鉴权设计里最危险的静默场景，必须显式对账（§3.1.4）。

---

## 3. 设计

### 3.1 A：rqlite 鉴权层

**原则：默认不启用，零破坏**（实现机制见 §3.1.2——「逐字节一致」靠 entrypoint 包装达成，不是靠条件挂载）。

#### 3.1.1 配置

`.env` / `.env.example` 新增（均默认空 = 不启用）：

| 变量 | 传递给 |
|---|---|
| `RQLITE_USERNAME` | rqlite 节点（渲染 auth.json + `-join-as`）、migrate、d1-http、read、ingest、scheduler |
| `RQLITE_PASSWORD` | 同上 |
| `RATE_LIMIT_BACKEND` | 仅 web（`memory` 默认 / `rqlite`，见 §3.2） |

#### 3.1.2 服务端（compose）与「默认关闭」的实现机制

- **渲染脚本** `deploy/selfhost/render-rqlite-auth.sh`：读 `RQLITE_USERNAME/PASSWORD`。两者都非空 → 生成 `deploy/selfhost/.rqlite-auth.json`（§2.1 数组格式，含 `pew` 全权用户、专用 `joiner` 用户 `[join]`、`*` 通配 `[status, ready]`）；任一为空 → **删除残留文件**（含误建的同名目录，`rm -rf`）并不产出。
- **rqlite 容器**：`deploy/selfhost/.rqlite-auth.json` 以 bind-mount 常驻挂载到 `/auth/auth.json:ro`（**无条件挂载**——docker 对不存在的宿主路径做 bind-mount 会在宿主创建同名**目录**，实测；常驻挂载 + 文件由脚本按需产出/删除规避此坑）。
- **条件启用**：rqlite 用 **entrypoint 包装脚本**（容器内 `[ -f /auth/auth.json ] && set -- "$@" -auth /auth/auth.json ${RQLITE_USERNAME:+-join-as "$RQLITE_USERNAME"}`）。**禁止**用 compose 列表插值做条件追加（`${VAR:-}` 未设时产生空 argv 元素，rqlited 报 `arguments after data directory () are not accepted` 退出 1，实测）。
- **cluster profile**：三个节点**全部**追加 `-join-as`（评审实测：部分节点缺失时未加者 boot timeout 崩溃循环）。joiner 用专用用户（`[join]` 权限），应用凭据不参与集群互连（最小权限，评审 M3）。
- 渲染脚本作为 compose 依赖链最早环节执行（rqlite 服务 `depends_on` 或手动两步：先 render 再 `up`；实现计划定稿）。

#### 3.1.3 客户端改造（完整清单）

| 位置 | 改动 |
|---|---|
| `deploy/selfhost/d1-adapter.ts` | `createD1Adapter({..., basicAuth?: {username, password}})`：设了发 `Authorization: Basic base64(user:pass)`；未设保持现 Bearer（无鉴权部署现状不动） |
| `deploy/selfhost/rqlite-client.ts` | 同上扩展 |
| `deploy/selfhost/d1-http.ts` | **`D1HttpOptions` 增加 `basicAuth` 并透传给内部 `createD1Adapter`**（评审 B3：此处缺失则 web 全部写路径 401） |
| `server-d1-http.ts` / `server-read.ts` / `server-ingest.ts` / `server-scheduler.ts` / `migrate-cli.ts` | 从 env 构造 `{username, password}` 传入（注意 `d1-http` 的 adapter 建在 `d1-http.ts` 内部，须双层透传） |
| `verify-migrations.ts`、`reset-password.ts` | 凭据**可选**（设了用 Basic，没设发 Basic 头对无鉴权节点无害——本地验证流程不被硬失败卡住） |

`web` 不变：只经 `d1-http`，其入站校验仍是 `CF_D1_API_TOKEN`（Bearer）——与 rqlite 鉴权是叠加的两层，互不替代（评审确认互斥设计无冲突，冲突点只在透传缺失，已修）。

#### 3.1.4 失败模式（v2 实测修正）与自检

| 场景 | 实际行为 | 可见性 |
|---|---|---|
| 客户端无凭据、服务端已开 | 401 | migrate exit 1；read/ingest healthcheck 503（`/api/live` 真执行 `SELECT 1`） |
| 客户端有凭据、服务端未开 | **200 静默成功（无鉴权运行）** | **无任何告警**——需对账自检 |
| 客户端凭据错误、服务端已开 | 401 | 同第一行 |
| auth 文件误删 `*` 条目 | healthcheck 401 → rqlite 永不 healthy → migrate 永不跑 | 启动门卡死（可发现但难定位，文档明示） |
| scheduler 凭据错误 | 首次触库在 24h 后 | **静默潜伏一天**（无 healthcheck） |

**对账自检**（把最危险的静默场景变成显式失败）：`migrate` 启动时（鉴权模式下）除正常迁移外，额外执行一次**匿名** `GET /status`——若返回 200 且 `http.auth == "disabled"`，判定「配置了凭据但服务端未启用鉴权」，报错退出。d1-http 的 `/health` 探针（`server-d1-http.ts:47`）从匿名 `/readyz` 改为**带凭据的 `SELECT 1`**（当前假阴性：`*` 有 ready 时凭据错错也 200，web 照常启动直到首次写失败）。

#### 3.1.5 连带文档订正（评审 M4/H4）

- README 备份/恢复命令补 rqlite CLI 凭据（`-u user:pass`，实测可用），**并在备份后校验文件非空**——实测 `.backup` 失败仍创建 0 字节假备份。
- README 破窗脚本命令补 `-e RQLITE_USERNAME/PASSWORD` 透传。
- README「安全注意事项」首段（「rqlite 默认无鉴权…本计划未做」）在 A 落地后改写为条件描述。
- README 跨机集群一节：auth.json 必须同源逐字节一致；轮换 = 全节点 recreate；join/复制流量 4002 明文，跨机需 WireGuard/私有网段。

#### 3.1.6 镜像泄漏面（评审 H3）

`.rqlite-auth.json` 在构建上下文内，会被 `deploy/selfhost/Dockerfile:31`（`COPY deploy deploy`）与根 `Dockerfile:49`（`COPY . .`）打进镜像层——与 README 记载过的 `.env` 同类事故。`.gitignore` 加 `deploy/selfhost/.rqlite-auth.json`、`.dockerignore` 加 `**/.rqlite-auth.json`，作为段 1 验收项（构建后抽查镜像层）。

#### 3.1.7 测试

- 单测：Basic 头编码、无凭据不发 Authorization、Bearer/Basic 互斥、渲染脚本三种输入（空/半空/全）的输出矩阵。
- 真机（compose，验证标准）：
  1. 默认路径回归：不设凭据 → 与 Plan 2 已验证行为逐项一致
  2. 单节点 + cluster：起、迁移通过、`/api/live` 200、认证流全通
  3. 无凭据 `curl /db/query` → 401；带凭据 → 200
  4. **匿名 join 拒绝**：无凭据节点 `-raft-non-voter` join → unauthorized（评审 B1 的复现场景固化为验收项）
  5. 三副本数据一致；对账自检触发场景（服务端未开 + 客户端有凭据 → migrate 显式报错）
  6. 备份/恢复带凭据可用且备份非空

### 3.2 B：登录限速外部化

#### 数据层

迁移 `033-rate-limit-hits.sql`：

```sql
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key    TEXT NOT NULL,
  hit_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key_at ON rate_limit_hits(key, hit_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_at ON rate_limit_hits(hit_at);
```

**同步**：`verify-migrations.ts` 的 `EXPECTED` 改 `planTables: 6, indexes: 68`，`PLAN_TABLES` 集合加 `rate_limit_hits`（不加入则被算进 upstreamTables 同样报错）——与迁移**同一提交**。

#### 实现层

- 现有 `InMemoryRateLimiter` 不动（默认后端）。
- 新增 `RqliteRateLimiter`：`check(key, config)` = **单条原子语句**：

  ```sql
  INSERT INTO rate_limit_hits(key, hit_at)
  SELECT ?, datetime('now')
  WHERE (SELECT COUNT(*) FROM rate_limit_hits
         WHERE key = ? AND hit_at > datetime('now', ?)) < ?
  ```
  按 `meta.changes` 分支：1 = 放行，0 = 超限拒绝（`retryAfter` 由窗口常量算出）。评审修正三点：①**窗口运算全部 SQL 侧**（`datetime('now', '-60 seconds')`）——应用层 ISO 字符串与 SQLite 空格格式字典序不可比（实测 `sqlite > iso` 恒 false），单一时钟源（leader）消除漂移；②COUNT+INSERT 两步竞态合并为单语句，rqlite 单 leader 串行化下天然原子，多副本并发不放大爆破窗口；③自建链路 `getDbWrite` 实际走 `/db/request`（leader 线性一致），设计删除「弱读」措辞（若改走 worker-read 的 weak 读反而漏计他副本写入）。
- **双键**：`login:email:<email>` 与 `login:ip:<ip>` 各一次 check。IP 在 `NextAuth(async (req) => ...)` 闭包用 `getClientIp` 取（Auth.js `authorize` 拿不到 Request）——这是登录路径补上 IP 维度的同时，`auth.ts` 失实的 "Per-email and per-IP" docstring 一并修正（当前实际恒 per-email，评审 H3）。
- **清理**：每次 check 以 1/100 概率 `DELETE FROM rate_limit_hits WHERE hit_at < datetime('now', ?)`，阈值用**表级常量**（该表允许的最大窗口，不用各进程观测的 maxWindowMs——共享表中只见过 60s 窗口的副本会误删 3600s 窗口内的行）；`idx_rate_limit_hits_at` 单列索引支撑该 DELETE。
- **开关与范围**：`RATE_LIMIT_BACKEND=rqlite` 仅切换**登录**限速。其余 5 处消费方（auth-code 生成/校验、CLI auth、team join、ingest）显式保持 memory 并在 README 列出及原因（300/min 的 ingest 走表驱动每请求 2 次 DB 往返不划算；评审 M1——开关改名 `LOGIN_RATE_LIMIT_BACKEND` 以免误导，实现计划定稿）。rqlite 故障时登录限速**放行**（fail-open，登录本就依赖 DB，限速尽力而为，评审 L1）。

#### 测试

- 单测（mock D1）：单语句 INSERT...SELECT 的 changes 分支、SQL 侧窗口参数、双键、fail-open、清理阈值。
- 真机：可选（默认部署单 web 副本），README 说明开关与场景。

### 3.3 C：反代/TLS 部署文档

README 新增「反向代理」小节，推荐形态：**Caddy 以 compose 服务加入**（`reverse_proxy web:7020`，网络内解析；发布 80/443），次选宿主 Nginx（上游 `127.0.0.1:7020`，配合下述端口改绑）。

1. **Caddy（推荐）**：2 行配置自动 HTTPS；注明无公网 DNS 的内网域名需 `tls internal` 或 DNS-01。Caddy 默认忽略入站 XFF 并自行设置（满足覆写要求），无需额外 header_up。
2. **Nginx**：除 XFF 覆写外**必须**——`proxy_set_header Host $host;`（默认 `$proxy_host` 会让 Auth.js 的 trustHost origin 校验失败、登录全挂，评审 B2）、`client_max_body_size 25m;`（worker 允许 `/ingest/details` 至 24MB，默认 1m 直接 413，评审 H1）、`X-Forwarded-Proto https`。
3. **硬约束清单**（升级为硬约束的标 ★）：
   - ★ web 的 7020 端口只绑 `127.0.0.1` 或不发布（直连可整体伪造 XFF 第一段，清洗形同虚设——`getClientIp` 取第一段）
   - ★ `NEXTAUTH_URL` 必须与反代对外访问 URL **逐字符一致**（协议+域名+端口；`TRUSTED_ORIGIN` 永远 pinned 到它，不一致则重定向/回调指向错误主机）；CLI 侧 `PEW_HOST` 同步
   - ★ 反代覆写 `X-Forwarded-For`（pew 取第一段），同时覆写 `X-Real-IP`、清空 `CF-Connecting-IP`（`getClientIp` 依次信任三者）
   - cookie 四格矩阵：https+`USE_SECURE_COOKIES=true` ✓；**https+false → 可登录但无 `__Secure-` 前缀（降级可用，不是「浏览器丢弃」）**；**http+true（或未显式 false）→ `__Secure-` cookie 被 http origin 拒收 → 登录坏**（镜像 `NODE_ENV=production` 恒真，这是默认行为）；http+false ✓。强调 compose/`.env.example` 默认 false，https 部署必须显式改 true
   - `TRUSTED_ORIGIN` 由 `NEXTAUTH_URL` 推导，无需单独配置（proxy.ts 已实现）
4. **`docker-compose.proxy.yml` 覆盖文件**：`ports: !override ["127.0.0.1:${WEB_PORT:-7020}:7020"]`——**普通追加合并下两条映射并存或端口冲突**（compose ports 唯一键含 ip，`!override` 需 Compose ≥ v2.24.4，评审 B1）；文档写明显式 `-f docker-compose.yml -f docker-compose.proxy.yml` 调用与 `docker compose config` 冒烟核对。

---

## 4. 交付拆分（实现阶段）

| 段 | 内容 | 独立验证 |
|---|---|---|
| 1 | A：rqlite 鉴权（含 §3.1.4 自检、§3.1.5 文档订正、§3.1.6 ignore 规则、env 接线清单 §3.1.1） | compose 单节点 + cluster 真机 6 项；默认路径回归 |
| 2 | B：限速外置（含 verify-migrations EXPECTED 同步、`.env.example`/compose 的 `RATE_LIMIT_BACKEND` 接线） | 单测 + 真机可选 |
| 3 | C：文档（新增反代小节 + README 四处既有内容订正 + proxy 覆盖文件 `!override` + `compose config` 冒烟） | 人工核对 + `compose config` |

每段一个提交；全部完成后一轮完整回归（pre-commit 全量 + L3 全量 + compose e2e 单节点/集群）。

---

## 5. 兼容性与回滚

- 三项均**默认关闭**（A：不设凭据；B：不设 `RATE_LIMIT_BACKEND`；C：纯文档），已有部署升级无需任何动作。
- 回滚 = revert 对应提交；迁移 033 是纯新增表，回滚无副作用（账本只增不删，表与旧行冻结无害——revert 后无人读写且有界）。
- **注意**：`_migrations` 账本按文件名跳过——revert 后若以**同名文件**重做 033 且内容变更会被静默跳过，重做必须换文件名；`EXPECTED` 计数更新须与迁移同提交，避免部分回滚时计数错配。
