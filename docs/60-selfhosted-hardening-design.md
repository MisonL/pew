# pew 私有化部署加固与运维（Plan 3）— 设计文档

**日期**：2026-10-13（v3，经四轮独立评审修订：v1 一轮 19 项 → v2；v2 二轮红队/可实施性/运维演练 → v3）
**状态**：设计稿，待评审确认
**前置**：Plan 1（`docs/58-self-hosted-storage-runtime.md`）、Plan 2（`docs/59-self-hosted-auth.md`）均已交付，分支 `feat/self-hosted-deployment`

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

**v3 修订摘要**（第二轮评审：可实施性 + 运维演练）：
- 规格算术错误：033 落地后 indexes 应为 **69**（67 + 2 个新索引），非 68 → §3.2
- entrypoint 包装机制只有一句话、不可实施 → §3.1.2 补完整脚本与 compose 片段（官方镜像 ENTRYPOINT 是 rqlited，须 `entrypoint: ["sh", "/entrypoint.sh"]` + bind-mount 脚本）
- joiner 用户密码来源未定义 → §3.1.1 新增 `RQLITE_JOIN_PASSWORD`（joiner 是独立用户，不复用应用凭据）
- 首次启用命令序列未定稿（`cp .env` → `up` 会把不存在的 auth.json 建成目录 + 无鉴权静默启动）→ §3.1.2「render → up → 自检」固定序列 + Quickstart 改写
- web 侧限速写路径 `/db/request` 的 `changes` 语义需真机验证项 → §3.2 测试
- 开关名三处不一致 → 全文统一 `LOGIN_RATE_LIMIT_BACKEND`
- `RateLimitResult` 语义明确：超限时 `current` 填 `maxRequests`，不加 COUNT 破坏原子性 → §3.2
- README 破窗命令 `RQLITE_URL=http://127.0.0.1:14001` 引用从未发布的端口（存量错误，Plan 2 现状即坏）→ §3.1.5 订正清单
- README 升级小节、回滚清理 checklist（.env 残留变量、磁盘明文 auth.json、dockerignore 回退再泄漏）、auth.json 丢失恢复 runbook、三节点降级信号、.env.example 注释 → §3.1.5 / §4 / §5

**v3 红队实验补充**（第三轮红队 7 组攻击，全部容器实测）：
- 「`*` 红线」机理修正：防住匿名 join 的真实堵点是 **`-join-as` 只匹配具名用户，`*` 通配条目不可引用**（非权限表判断）→ §2.1 表述修正；`*` 条目接受任意用户名+任意密码的 Basic 头（实测）→ §3.1.4 自检判据强化
- fail-open 必须区分「changes=0（超限，拒绝）」与「执行异常（故障，放行+日志告警）」——不区分则写超时攻击 = 限速静默失效 → §3.2
- IP 键的 IPv6 轮换绕过（隐私扩展每连接换地址）+ email 键可任意轮换 + `login:ip:unknown` 共享桶污染（反代漏配 XFF 时打满桶 = 全员登录 DoS）→ §3.2
- 全栈六容器共享同一 rqlite 写凭据是结构性弱点（单容器 RCE = 全库凭据）；read/scheduler 分离为只读用户 → §3.1.1
- 渲染脚本需 umask 077 + `chmod 600`；凭据不得进应用 error message；对账自检声明不做安全边界 → §3.1.2/§3.1.4
- README 备份端点须写明 **POST /db/backup**（GET /backup 在 10.5.3 是 404）；joiner 密码与主凭据同强度要求 → §3.1.5
- ~~Caddy XFF 假阳性~~：红队称「Caddy 默认透传+追加 XFF」经查官方文档不成立——v2.5 起默认忽略入站 XFF；规格补「需 Caddy ≥ 2.5」版本前提 → §3.3

---

## 1. 背景与目标

Plan 1/2 交付后，规格（`docs/57-self-hosted-deployment-design.md`）§7 风险表与 README「安全注意事项」中遗留三项已识别但未做的强化项：

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
- **通配用户红线（两次实验结论冲突，取保守解）**：`*` 的权限即匿名可做的事，**`*` 只允许 `["status", "ready"]`**（无论下述机理如何，最小权限都是对的）。
  - v2 期实测：`*` 带 `join-read-only` 时无凭据节点 `-raft-non-voter` **加入成功**并把全库复制到本地卷（db.sqlite 与 leader 字节一致）。
  - v3 红队实测：`-join-as '*'` 被拒，日志 `unauthorized (did you forget to set -join-as?)`，据此主张真实堵点是「**`-join-as` 只匹配具名用户，`*` 不可引用**」，而非权限表。
  - **两实验差异未收敛**（疑似 `-join-as` 参数与无参匿名 join 走了不同分支）。**保守结论**：`*` 权限最小化 + 集群全部节点强制 `-join-as joiner`（具名用户）双管齐下，不依赖任一机理成立；验收项 4（匿名 join 必须被拒）保留。
  - 另一实测细节：**`*` 无 password 字段 = 任何 Basic 头（任意用户名+任意密码）都被当作 `*` 用户**——`*` 上只放 `status`/`ready` 正是为此。数据权限全在具名用户上（`*`/任意密码对 `/db/query`、`/db/execute` 均 401）。
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

| 变量 | 传递给 | 说明 |
|---|---|---|
| `RQLITE_USERNAME` | rqlite 节点（渲染 auth.json）、migrate、d1-http、read、ingest、scheduler | 应用侧全权用户 |
| `RQLITE_PASSWORD` | 同上 | |
| `RQLITE_JOIN_PASSWORD` | 渲染脚本（写入 joiner 用户条目）、rqlite 节点（`-join-as joiner` 的密码） | joiner 是**专用**集群互连用户，不复用应用凭据（最小权限）；**join 成功 = 拿到全库只读副本，密码强度要求与 `RQLITE_PASSWORD` 相同**（红队 Low13）；未设时渲染脚本报错退出（凭据模式下三要素缺一不可） |
| `LOGIN_RATE_LIMIT_BACKEND` | 仅 web（`memory` 默认 / `rqlite`，见 §3.2） | 全文唯一开关名（v2 中 §3.1.1/§4 曾误写 `RATE_LIMIT_BACKEND`，已统一） |

**凭据暴露面的结构性弱点（红队 High，接受并注明）**：同一 `RQLITE_PASSWORD` 注入六个容器 environment，单容器 RCE（`/proc/1/environ`、`docker inspect` 可读）= 全库写凭据。**缓解**：auth.json 增加第二个具名只读用户（`perms: ["select"]`，实测 perms 缺失 = 全拒、fail-closed），`read` 与 `scheduler` 用只读凭据（二者无写路径），缩小写凭据暴露面至 migrate/d1-http/ingest 三个必需容器；进一步拆分（每容器独立用户）属 YAGNI。
> **实现更正**：rqlite 10.5.3 实测无 `select` 权限名（`query` 有效但仅限 /db/query，/db/request 拒绝），且 read/scheduler 均有 `/db/request` 写路径——只读用户在此架构不可达，pew-ro 已移除，所有服务统一用全权凭据（Ruling 2026-10-14 多维审查）。

#### 3.1.2 服务端（compose）与「默认关闭」的实现机制

**渲染脚本** `deploy/selfhost/render-rqlite-auth.sh`：读 `RQLITE_USERNAME` / `RQLITE_PASSWORD` / `RQLITE_JOIN_PASSWORD`。三要素都非空 → 生成 `deploy/selfhost/.rqlite-auth.json`（§2.1 数组格式：`pew` 全权用户、`pew-ro` 只读用户 `["select"]`、`joiner` 用户 `[join]` 密码取 `RQLITE_JOIN_PASSWORD`、`*` 通配 `[status, ready]`）；任一为空 → **删除残留文件**（含误建的同名目录，`rm -rf`）并不产出。**实现更正（注记 2026-10-14，多维审查）**：上文 `pew-ro` 只读用户已移除（rqlite 10.5.3 无合法只读权限名，实际产出 `pew` 全权 / `joiner` / `*` 三条目）；渲染脚本以 `jq -n` 写临时文件后 `mv` 原子落盘，并在落盘前清除 `$OUT` 位置可能存在的同名目录（bind-mount 目录陷阱）、落盘后校验其为常规文件。**文件权限（红队 Medium 2.3）**：脚本开头 `umask 077`，产出后 `chmod 600`——文件是明文 JSON 含全部密码，同宿主其他用户不得读。密码用 `printf '%s'` 写入（不用 `echo`，避免 zsh 反斜杠转义差异），脚本对密码中的 `/` 等字符只要求 JSON 转义正确（用 `jq -n` 生成，不手拼字符串）。

**rqlite 容器**：两个 bind-mount **无条件**存在（docker 对不存在的宿主路径做 bind-mount 会在宿主创建同名**目录**，实测；常驻挂载 + 文件由脚本按需产出/删除规避此坑）：
- `deploy/selfhost/.rqlite-auth.json` → `/auth/auth.json:ro`
- `deploy/selfhost/rqlite-entrypoint.sh` → `/entrypoint.sh:ro`

**entrypoint 包装脚本**（完整内容，v2 只有一句话不可实施）：

> **实现更正（注记 2026-10-14，多维审查）**：最终实现见 `deploy/selfhost/rqlite-entrypoint.sh`——除下述 -auth/-join-as 逻辑外，还补了官方 docker-entrypoint.sh 原本代办的 `-http-adv-addr`/`-raft-adv-addr` 兜底（rqlite 拒绝 0.0.0.0 作为 advertise 地址）与末尾数据目录位置参数（compose 不传，默认 `/rqlite/file/data`，`DATA_DIR` 仍可覆盖）。下述片段不含这两处，不可直接照抄。

```sh
#!/bin/sh
# Official image ENTRYPOINT is rqlited itself, so compose must override with
# entrypoint: ["sh", "/entrypoint.sh"]. Append -auth only when the file exists.
set -e
if [ -f /auth/auth.json ]; then
  set -- "$@" -auth /auth/auth.json
  if [ -n "$RQLITE_JOIN_AS" ]; then
    set -- "$@" -join-as "$RQLITE_JOIN_AS"
  fi
fi
exec rqlited "$@"
```

要点：
- `-join-as` 的密码不进脚本——rqlite 从**该节点自身 auth 文件**里同名用户的 password 取（§2.1 实测），所以脚本只需 `-join-as <username>`。cluster 节点在 compose 里直接写死 `RQLITE_JOIN_AS: joiner`（密码已在 joiner 自己的 auth.json 条目里，无需注入进程环境）；单节点服务不设该变量 = 不 join。
- **禁止**用 compose 列表插值做条件追加（`${VAR:-}` 未设时产生空 argv 元素，rqlited 报 `arguments after data directory () are not accepted` 退出 1，实测）。
- compose 片段（单节点 `rqlite` 服务，最终形态）：

  ```yaml
  rqlite:
    entrypoint: ["sh", "/entrypoint.sh"]
    volumes:
      - rqlite-file:/rqlite/file
      - ./rqlite-entrypoint.sh:/entrypoint.sh:ro
      - ./.rqlite-auth.json:/auth/auth.json:ro
    # 单节点不设 RQLITE_JOIN_AS（不 join）；cluster profile 三节点均设 RQLITE_JOIN_AS: joiner
  ```

  cluster profile 三节点各自同样包装，且**全部**带 `-join-as`（评审实测：部分节点缺失时未加者 boot timeout 崩溃循环）。joiner 是专用用户（`[join]` 权限），应用凭据不参与集群互连。
- **首次启用 = 固定序列**（v3 Blocker：部署者按旧 README「cp .env → up」操作时 auth.json 不存在 → up 前若文件缺失仍会以无鉴权静默启动，恰是 §2.3 最危险场景；且旧 README 的 Quickstart 必须改写）。README Quickstart 鉴权路径写死为三步：
  1. `docker compose run --rm render-auth`（把渲染脚本做成一次性 compose 服务，或直接 `bash deploy/selfhost/render-rqlite-auth.sh`）——**必须先于 up 执行**
  2. `docker compose --profile ... up -d`
  3. **自检**：`curl -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" http://127.0.0.1:<rqlite>/status` 得 200 且其中 `http.auth` 显示已启用；**匿名** `curl .../status` 若返回 200 且 `auth == disabled` → 显式报「凭据已配置但服务端未启用鉴权」（与 migrate 的对账自检 §3.1.4 同一判据，双保险）

#### 3.1.3 客户端改造（完整清单）

| 位置 | 改动 |
|---|---|
| `deploy/selfhost/d1-adapter.ts` | `createD1Adapter({..., basicAuth?: {username, password}})`：设了发 `Authorization: Basic base64(user:pass)`；未设保持现 Bearer（无鉴权部署现状不动） |
| `deploy/selfhost/rqlite-client.ts` | 同上扩展 |
| `deploy/selfhost/d1-http.ts` | **`D1HttpOptions` 增加 `basicAuth` 并透传给内部 `createD1Adapter`**（评审 B3：此处缺失则 web 全部写路径 401） |
| `server-d1-http.ts` / `server-ingest.ts` / `migrate-cli.ts` | 从 env 构造 `{username, password}`（全权凭据）传入（注意 `d1-http` 的 adapter 建在 `d1-http.ts` 内部，须双层透传） |
| `server-read.ts` / `server-scheduler.ts` | 用**只读**凭据（auth.json 的 `pew-ro`，经 `RQLITE_READ_USERNAME/PASSWORD` 或渲染脚本固定约定传入；二者无写路径，§3.1.1 红队 High 缓解） |
| `verify-migrations.ts`、`reset-password.ts` | 凭据**可选**（设了发 Basic，未设**不发任何 Authorization 头**——现有 Bearer 兜底逻辑对这两个脚本必须移除；对无鉴权节点行为与现状完全一致，本地验证流程不被硬失败卡住） |

`web` 不变：只经 `d1-http`，其入站校验仍是 `CF_D1_API_TOKEN`（Bearer）——与 rqlite 鉴权是叠加的两层，互不替代（评审确认互斥设计无冲突，冲突点只在透传缺失，已修）。

#### 3.1.4 失败模式（v2 实测修正）与自检

| 场景 | 实际行为 | 可见性 |
|---|---|---|
| 客户端无凭据、服务端已开 | 401 | migrate exit 1；read/ingest healthcheck 503（`/api/live` 真执行 `SELECT 1`） |
| 客户端有凭据、服务端未开 | **200 静默成功（无鉴权运行）** | **无任何告警**——需对账自检 |
| 客户端凭据错误、服务端已开 | 401 | 同第一行 |
| auth 文件误删 `*` 条目 | healthcheck 401 → rqlite 永不 healthy → migrate 永不跑 | 启动门卡死（可发现但难定位，文档明示） |
| scheduler 凭据错误 | 首次触库在 24h 后 | **静默潜伏一天**（无 healthcheck） |

**对账自检**（把最危险的静默场景变成显式失败）：`migrate` 启动时（鉴权模式下）除正常迁移外，额外执行两个匿名探测——①`GET /status`：返回 200 且 `http.auth == "disabled"` → 判定「配置了凭据但服务端未启用鉴权」，报错退出；②`GET /db/query?q=SELECT 1`：**必须 401**，若 200 同样报错退出（双判据，防 `*` 条目放权或 auth 文件异常；红队 4.1 指出该探测可被 compose 网络内 DNS/ARP 欺骗出假阴性——**文档明示：自检只防配置错误，不做安全边界**，「攻击者已在 compose 网络内」是更大的前提失守）。d1-http 的 `/health` 探针（`server-d1-http.ts:47`）从匿名 `/readyz` 改为**带凭据的 `SELECT 1`**（当前假阴性：`*` 有 ready 时凭据错也 200，web 照常启动直到首次写失败）；探针走与写同路径的线性一致读，不用弱读（红队 4.2①）。**凭据不得进应用 error message / 日志**（红队 2.5）——d1-adapter 报错时不得附带 Authorization 头内容，列入段 1 单测。

#### 3.1.5 连带文档订正（评审 M4/H4 + 运维演练报告）

- README 备份/恢复命令补 rqlite CLI 凭据（`-u user:pass`，实测可用），**端点写明 `POST /db/backup`**（红队 1.4：`GET /backup` 在 10.5.3 是 404，旧 README 若用 GET 须一并修），**并在备份后校验文件非空**——实测 `.backup` 失败仍创建 0 字节假备份。**备份端点鉴权行为需真机验证**（`/db/backup` 在 `-auth` 开启下对 `*` 用户匿名是否 401；§3.1.7 验收项 6 覆盖）。
  > **实现更正**：10.5.3 实测 **GET `/db/backup` = 200**（返回全库 SQLite 文件）、`POST /db/backup` = 405（Ruling 7fe93059）——与本条原写的 POST 端点相反，README 已按实测结果写为 GET。
- **README 破窗命令端口错误（存量 bug，运维演练 Blocker 2）**：`README.md:28` 的 `RQLITE_URL=http://127.0.0.1:14001` 引用的端口从未在 compose 发布（rqlite 不发布宿主端口）——Plan 2 现状下这条灾难恢复命令就跑不通。订正为 `docker compose exec -e RQLITE_USERNAME=... -e RQLITE_PASSWORD=... rqlite ...` 形态或经 d1-http 容器内访问；与「补凭据透传」一并改写。
- README「安全注意事项」首段（「rqlite 默认无鉴权…本计划未做」）在 A 落地后改写为条件描述——**同时删掉与已交付功能矛盾的措辞**。
- README 跨机集群一节：auth.json 必须同源逐字节一致；轮换 = 全节点 recreate；join/复制流量 4002 明文，跨机需 WireGuard/私有网段。
- **README Quickstart 改写**（运维演练 Blocker 1）：鉴权路径按 §3.1.2 固定序列「render → up → 自检」重写，并加粗警告「先 up 后 render 会以无鉴权静默启动」。
- **新增「升级」小节**：拉新版本 → `docker compose pull` → `up -d`；迁移在 migrate 服务启动时自动跑（账本按文件名幂等）；auth 相关变更（rqlite 版本升级）前先备份 + 确认 auth.json 兼容。
- **新增 auth.json 丢失恢复 runbook**（运维演练 Medium）：分两种情形——①文件仍在磁盘但误删内容 → 从 §3.1.2 渲染脚本重新渲染（凭据在 `.env`，节点 recreate 即可）；②节点 recreate 且 `.env` 丢失 → **数据仍在卷上但无人能连**，唯一出路是从同源备份的 auth.json / 凭据管理器恢复 `.env`；都没有则只能放弃实例数据重建。强调：rqlite 不热加载 auth，任何凭据变更 = 全节点 recreate。
- **回滚清理 checklist**（段 1 回滚时执行，运维演练 Medium）：`.env` 中 `RQLITE_USERNAME/PASSWORD/JOIN_PASSWORD` 删除；宿主磁盘上 `deploy/selfhost/.rqlite-auth.json`（明文密码）删除；确认 `.dockerignore` 回退不会把 auth.json 再泄进镜像层；rqlite 数据卷无需清理（数据本身无敏感情形由部署者判断）。

#### 3.1.6 镜像泄漏面（评审 H3）

`.rqlite-auth.json` 在构建上下文内，会被 `deploy/selfhost/Dockerfile:31`（`COPY deploy deploy`）与根 `Dockerfile:49`（`COPY . .`）打进镜像层——与 README 记载过的 `.env` 同类事故。`.gitignore` 加 `deploy/selfhost/.rqlite-auth.json`、`.dockerignore` 加 `**/.rqlite-auth.json`，作为段 1 验收项（构建后抽查镜像层）。

#### 3.1.7 测试

- 单测：Basic 头编码、无凭据不发 Authorization、Bearer/Basic 互斥、渲染脚本三种输入（空/半空/全）的输出矩阵。
- 真机（compose，验证标准）：
  1. 默认路径回归：不设凭据 → 与 Plan 2 已验证行为逐项一致
  2. 单节点 + cluster：起、迁移通过、`/api/live` 200、认证流全通
  3. 无凭据 `curl /db/query` → 401；带凭据 → 200
  4. **匿名 join 拒绝**：无凭据节点 `-raft-non-voter` join → unauthorized（评审 B1 的复现场景固化为验收项；§2.1 两次实验冲突下此项是最终裁决）
  5. 三副本数据一致；对账自检触发场景（服务端未开 + 客户端有凭据 → migrate 显式报错）
  6. 备份/恢复带凭据可用且备份非空
  7. **镜像层抽查（红队 W2，必须执行）**：`git grep rqlite-auth` 确认 ignore 规则存在后，构建两个镜像（根 + deploy/selfhost），`docker history` + 导出层 grep `.rqlite-auth.json` 无命中

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

**同步**：`verify-migrations.ts` 的 `EXPECTED` 改 `planTables: 6, indexes: 69`（v2 误写 68；现值 67 见 `deploy/selfhost/verify-migrations.ts:44`，+2 个新索引 = 69），`PLAN_TABLES` 集合加 `rate_limit_hits`（不加入则被算进 upstreamTables 同样报错）——与迁移**同一提交**。

#### 实现层

- 现有 `InMemoryRateLimiter` 不动（默认后端）。
- 新增 `RqliteRateLimiter`：`check(key, config)` = **单条原子语句**：

  ```sql
  INSERT INTO rate_limit_hits(key, hit_at)
  SELECT ?, datetime('now')
  WHERE (SELECT COUNT(*) FROM rate_limit_hits
         WHERE key = ? AND hit_at > datetime('now', ?)) < ?
  ```

  按 `meta.changes` 分支：1 = 放行，0 = 超限拒绝（`retryAfter` 由窗口常量算出；已知 `datetime('now')` 秒级粒度 + 严格 `>` 使窗口边界有 ±1 次抖动，红队 Low 3.2，接受不修——爆破窗口的秒级边缘不改变安全结论）。**`RateLimitResult.current` 语义（可实施性报告）**：放行时返回实际计数需要第二次 COUNT——不在原子语句里加，超限（changes=0）时 `current` 直接填 `maxRequests`（语义「已满」，UI 显示用，够用），避免破坏单语句原子性。评审修正三点：①**窗口运算全部 SQL 侧**（`datetime('now', '-60 seconds')`）——应用层 ISO 字符串与 SQLite 空格格式字典序不可比（实测 `sqlite > iso` 恒 false），单一时钟源（leader）消除漂移；②COUNT+INSERT 两步竞态合并为单语句，rqlite 单 leader 串行化下天然原子，多副本并发不放大爆破窗口；③自建链路 `getDbWrite` 实际走 `/db/request`（leader 线性一致），设计删除「弱读」措辞（若改走 worker-read 的 weak 读反而漏计他副本写入）。**`meta.changes` 在 `/db/request` 响应里的确切字段路径需真机确认**（d1-http 对 statements 数组响应的解析已有先例，但 INSERT...SELECT 的 changes 返回未见实测——列入 §3.2 真机验证项，若为 0 则回退方案是读 `results[0].meta` 或改用 `SELECT changes()` 后置查询）。
- **双键与已知绕过（v3 红队 High 3.1，如实注明而非假装堵住）**：`login:email:<email>` 与 `login:ip:<ip>` 各一次 check。email 键攻击者可任意轮换（`victim+1@x.com`…），**IP 键是唯一硬防线**。已知绕过：①IPv6 隐私扩展每连接换地址 = 无限 IP 池——IP 键对 IPv6 做 **/64 前缀归并**（`getClientIp` 返回 IPv6 时取前 8 字节前缀作键）；②反代漏配 XFF 时全部请求落 `login:ip:unknown` 共享桶（`rate-limit.ts:193` 兜底 "unknown"），攻击者可打满该桶造成**全员登录 DoS**（fail-closed 方向）——缓解是 §3.3 的 XFF 硬约束 + `unknown` 桶不适用于有反代的标准部署（文档注明）。IP 在 `NextAuth(async (req) => ...)` 闭包用 `getClientIp` 取（Auth.js `authorize` 拿不到 Request）——这是登录路径补上 IP 维度的同时，`auth.ts` 失实的 "Per-email and per-IP" docstring 一并修正（当前实际恒 per-email，评审 H3）。
- **清理**：每次 check 以 1/100 概率 `DELETE FROM rate_limit_hits WHERE hit_at < datetime('now', ?)`，阈值用**表级常量**——该表全局最大窗口（登录 60s + 未来可能的口内扩展，取 3600s 余量，写成模块级常量并注释依据；不用各进程观测的 maxWindowMs——共享表中只见过 60s 窗口的副本会误删 3600s 窗口内的行）；`idx_rate_limit_hits_at` 单列索引支撑该 DELETE。
- **开关与范围**：`LOGIN_RATE_LIMIT_BACKEND=rqlite` 仅切换**登录**限速（全文唯一名——v2 三处拼写不一致已统一，可实施性报告）。其余 5 处消费方（auth-code 生成/校验、CLI auth、team join、ingest）显式保持 memory 并在 README 列出及原因（300/min 的 ingest 走表驱动每请求 2 次 DB 往返不划算；评审 M1）。
- **fail-open 语义精确化（红队 High W4）**：两种「没放行成功」必须区分——①`changes === 0` = **超限，拒绝**（DB 工作正常，只是计数满）；②语句**执行异常**（网络错误/超时）= **放行**（fail-open）+ `console.warn` 告警日志。不区分则攻击者制造限速写超时即可静默绕过限速而读路径正常。两个分支路径在单测里各自覆盖。

#### 测试

- 单测（mock D1）：单语句 INSERT...SELECT 的 changes 分支（超限拒绝）、执行异常分支（fail-open + warn 日志）、SQL 侧窗口参数、双键（含 IPv6 /64 归并）、超限时 `current === maxRequests`、清理阈值。
- **真机验证项（必须做，非可选）**：
  1. `LOGIN_RATE_LIMIT_BACKEND=rqlite` 下连续登录失败 6 次 → 第 6 次被拒、`retryAfter` 合理、另一 IP 正常登录（双键互不误伤）
  2. `meta.changes` 经 `/db/request` 的实际返回值（§3.2 上述疑问）——若解析路径不对，回退方案落地后重测
  3. 清理概率触发时旧行确实被删（可用极短窗口 + 手动插老行验证）

### 3.3 C：反代/TLS 部署文档

README 新增「反向代理」小节，推荐形态：**Caddy 以 compose 服务加入**（`reverse_proxy web:7020`，网络内解析；发布 80/443），次选宿主 Nginx（上游 `127.0.0.1:7020`，配合下述端口改绑）。

1. **Caddy（推荐）**：2 行配置自动 HTTPS；注明无公网 DNS 的内网域名需 `tls internal` 或 DNS-01。**需 Caddy ≥ 2.5**（红队 W3 争议后查证：[官方文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)确认 v2.5 起 reverse_proxy 默认忽略入站 XFF 并自行设置以防伪造——"the proxy will ignore their values from incoming requests, to prevent spoofing"），满足覆写要求，无需额外 header_up。compose 接入骨架（运维演练 High：最终形态片段进规格，实现时照抄）：

   ```yaml
   # docker-compose.caddy.yml（独立扩展文件，-f 叠加，不动基础 compose）
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

   `Caddyfile` 骨架：`<内网域名> { reverse_proxy web:7020 }`（单行正文 + `tls internal` 注释示例）。
2. **Nginx**：除 XFF 覆写外**必须**——`proxy_set_header Host $host;`（默认 `$proxy_host` 会让 Auth.js 的 trustHost origin 校验失败、登录全挂，评审 B2）、`client_max_body_size 25m;`（worker 允许 `/ingest/details` 至 24MB，默认 1m 直接 413，评审 H1）、`X-Forwarded-Proto https`。**XFF 给出确切指令防误配（红队 5.1）**：`proxy_set_header X-Forwarded-For $remote_addr;`（覆写）——不是 `$proxy_add_x_forwarded_for`（追加，保留攻击者伪造段）。
3. **硬约束清单**（升级为硬约束的标 ★）：
   - ★ web 的 7020 端口只绑 `127.0.0.1` 或不发布（直连可整体伪造 XFF 第一段，清洗形同虚设——`getClientIp` 取第一段）。**注意（红队 5.2）**：此约束防的是网络外直连；同宿主其他本地用户进程仍可达 127.0.0.1:7020（多租户宿主属部署者自担），compose 网络内攻击者本就绕过 web 直达数据层（7020 收紧不改变该模型）。
   - ★ `NEXTAUTH_URL` 必须与反代对外访问 URL **逐字符一致**（协议+域名+端口；`TRUSTED_ORIGIN` 永远 pinned 到它，不一致则重定向/回调指向错误主机）；CLI 侧 `PEW_HOST` 同步
   - ★ 反代覆写 `X-Forwarded-For`（pew 取第一段），同时覆写 `X-Real-IP`、清空 `CF-Connecting-IP`（`getClientIp` 依次信任三者）
   - cookie 四格矩阵：https+`USE_SECURE_COOKIES=true` ✓；**https+false → 可登录但无 `__Secure-` 前缀（降级可用，不是「浏览器丢弃」）**；**http+true（或未显式 false）→ `__Secure-` cookie 被 http origin 拒收 → 登录坏**（镜像 `NODE_ENV=production` 恒真，这是默认行为）；http+false ✓。强调 compose/`.env.example` 默认 false，https 部署必须显式改 true
   - `TRUSTED_ORIGIN` 由 `NEXTAUTH_URL` 推导，无需单独配置（proxy.ts 已实现）
4. **`docker-compose.proxy.yml` 覆盖文件**：`ports: !override ["127.0.0.1:${WEB_PORT:-7020}:7020"]`——**普通追加合并下两条映射并存或端口冲突**（compose ports 唯一键含 ip，`!override` 需 Compose ≥ v2.24.4，评审 B1）；文档写明显式 `-f docker-compose.yml -f docker-compose.proxy.yml` 调用与 `docker compose config` 冒烟核对。

---

## 4. 交付拆分（实现阶段）

| 段 | 内容 | 独立验证 |
|---|---|---|
| 1 | A：rqlite 鉴权。**新增文件**：`render-rqlite-auth.sh`、`rqlite-entrypoint.sh`、（可选）compose 一次性 `render-auth` 服务；**修改**：`d1-adapter.ts`/`rqlite-client.ts`/`d1-http.ts` Basic 透传、四个 server-*/migrate-cli 接线、`verify-migrations.ts`/`reset-password.ts` 可选凭据、compose 单节点 + cluster 三节点 entrypoint/volumes/environment、`.gitignore`/`.dockerignore`、README（Quickstart 固定序列、备份/恢复/破窗/升级/恢复 runbook/安全注意事项改写） | compose 单节点 + cluster 真机 6 项（§3.1.7）；默认路径回归 |
| 2 | B：限速外置。**新增**：`033-rate-limit-hits.sql`、`RqliteRateLimiter`；**修改**：`auth.ts`（双键 + docstring 修正）、`verify-migrations.ts`（planTables:6 / indexes:69）、`.env.example`/compose 的 `LOGIN_RATE_LIMIT_BACKEND` 接线（含注释说明仅作用于登录） | 单测 + 真机 3 项（§3.2 测试） |
| 3 | C：文档。**新增**：反代小节、`docker-compose.proxy.yml`（`!override`）、`docker-compose.caddy.yml` + `Caddyfile` 骨架；**修改**：README 现有四处订正 | 人工核对 + `docker compose -f ... config` 冒烟核对所有叠加组合 |

每段一个提交；全部完成后一轮完整回归（pre-commit 全量 + L3 全量 + compose e2e 单节点/集群）。

---

## 5. 兼容性与回滚

- 三项均**默认关闭**（A：不设凭据；B：不设 `LOGIN_RATE_LIMIT_BACKEND`；C：纯文档），已有部署升级无需任何动作。
- 回滚 = revert 对应提交；迁移 033 是纯新增表，回滚无副作用（账本只增不删，表与旧行冻结无害——revert 后无人读写且有界）。
- **注意**：`_migrations` 账本按文件名跳过——revert 后若以**同名文件**重做 033 且内容变更会被静默跳过，重做必须换文件名；`EXPECTED` 计数更新须与迁移同提交，避免部分回滚时计数错配。回滚后按 §3.1.5 清理 checklist 处理 `.env` 残留变量与磁盘明文 auth.json。
- **三节点降级信号与升级判据**（运维演练 Low，写进 README 集群小节）：单节点 down → 集群**仍有多数派，可写**（3 节点 down 1 后 2/3 多数派存活，raft 正常选主）——事实更正：本节原稿「单节点 down → 集群只读（无多数派）」错误，单节点 down 不影响写可用性；真正的只读/不可用阈值是两节点 down（无多数派）→ 全不可用；只允许**同时**恢复，不要逐台改配置（auth.json 不一致会导致 recreate 后 join 失败）。read 副本 down 不影响写路径（weak 读自动重试其他节点），信号仅在日志。
