# pew 私有化部署加固与运维（Plan 3）— 设计文档

**日期**：2026-10-13
**状态**：设计已批准（对话内），待写实现计划
**前置**：Plan 1（`docs/superpowers/plans/2026-10-10-self-hosted-storage-runtime.md`）、Plan 2（`docs/superpowers/plans/2026-10-11-self-hosted-auth.md`）均已交付，分支 `feat/self-hosted-deployment`

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
- 不做 rqlite 的 node-to-node mTLS（`-node-cert`/`-node-key`，属容器网络信任域内，另有专项）
- 不做登录限速的跨集群共享（自建场景单集群，rqlite 表驱动即覆盖多副本）
- 不做完整的 TLS 终结配置（只给反代示例与关键约束，配置本身属部署环境）

---

## 2. 关键实验结论（已验证）

### 2.1 rqlite 10.5.3 的鉴权机制

**实测环境**：`rqlite/rqlite:10.5.3`（镜像 digest `de385382ef6d`，2026-10-07 构建），docker 网络内 3 节点实验。

- **参数名**：`rqlited -auth <file>`。旧文档的 `-http-auth` 已不存在（`rqlited -h` 实测报 `flag provided but not defined`）。
- **文件格式**：**顶层 JSON 数组**，不是对象。错误格式（对象形 `{"Authorization": {...}}`）启动即 fatal：`failed to get credential store: json: cannot unmarshal string into Go value of type auth.Credential`。
  ```json
  [
    { "username": "pew", "password": "secret", "perms": ["all"] },
    { "username": "*", "perms": ["status", "ready", "join-read-only"] }
  ]
  ```
  `"*"` 是通配用户（覆盖匿名请求）。**通配的权限即未鉴权可做的事**——绝不能给它 `query`/`write`。
- **行为实测**：无凭据 → `/readyz` 200（`*` 有 `ready`）、`/db/query` **401**；带 Basic 凭据 → 查询成功。
- **集群 join**：joining 节点须带 `-join-as <user>`（用户名），**密码取该节点自身 auth 文件里同名用户的 password**。实测 2 节点（A 先 bootstrap，B `-join-as pew`）join 成功、写读复制正常；B 无凭据读 401。
- **客户端**：现有 `d1-adapter.ts` / `rqlite-client.ts` 发的是 `Bearer ${token}` 头——rqlite 不识别，等于无鉴权。需改为 `Basic base64(user:pass)`。

### 2.2 数据目录坑（部署相关，非本设计改动）

镜像以 uid=1000 `rqlite` 用户运行，数据目录必须可写。compose 现用 `/rqlite/file`（镜像内已 `chown rqlite`）挂 named volume；`-fk` 时**不要**把宿主目录直接挂到 `/data`（`mkdir /data: permission denied`，实测）。

---

## 3. 设计

### 3.1 A：rqlite 鉴权层

**原则：默认不启用，零破坏。** 不设凭据时行为与现在完全一致。

#### 配置

`.env` 新增两项（均默认空 = 不启用）：

| 变量 | 说明 |
|---|---|
| `RQLITE_USERNAME` | 应用连接 rqlite 的用户名；空 = 不启用鉴权 |
| `RQLITE_PASSWORD` | 该用户密码 |

#### 服务端（compose）

- rqlite 节点（single profile 1 个 + cluster profile 3 个）新增 bind-mount：把渲染好的 auth.json 挂到容器。渲染由一个**启动前置脚本**完成（`deploy/selfhost/render-rqlite-auth.sh`），把 `RQLITE_USERNAME/PASSWORD` 写成上述数组格式到 `deploy/selfhost/.rqlite-auth.json`；两者任一为空则**不写文件、不加 `-auth`、不加 `-join-as`**，compose 行为与今天逐字节一致。
- 启用时 rqlite 命令追加 `-auth /auth/auth.json`；cluster 的 join 节点追加 `-join-as <RQLITE_USERNAME>`。
- **mount 形态**：直接 bind-mount `deploy/selfhost/.rqlite-auth.json`（单文件只读）。该文件**必须进 `.gitignore` 与 `.dockerignore`**（密码明文）。

#### 客户端（五个直连服务 + 三个脚本）

| 位置 | 改动 |
|---|---|
| `deploy/selfhost/d1-adapter.ts` | `createD1Adapter({..., basicAuth?: {username, password}})`：设了就发 `Authorization: Basic base64(user:pass)`，与现 Bearer 互斥（`basicAuth` 优先，Bearer 逻辑保留给无鉴权部署） |
| `deploy/selfhost/rqlite-client.ts` | 同上（它已支持 `token` 选项，扩展为支持 Basic） |
| `server-*.ts` ×3、`migrate-cli.ts` | 从 env 构造 `{username, password}` 并传入 |
| `verify-migrations.ts`、`reset-password.ts` | 同上（这俩目前 `token: ""`） |

`web` 不变：它只经 `d1-http`，而 d1-http 自身仍用 `CF_D1_API_TOKEN`（Bearer）校验 web 的请求——那是**另一层**鉴权，与 rqlite 鉴权叠加而非替代。

#### 失败模式

- 客户端有凭据、服务端未开 → 401（启动即暴露，fail-fast，不会静默降级）
- 客户端无凭据、服务端已开 → 401，同上
- 凭据进 env 不进命令行参数（`ps` 可见）——只经 auth.json 文件 + env 双通道

#### 测试

- 单测：Basic 头编码正确、无凭据时不发 Authorization（保持现状）、Bearer/Basic 互斥。
- 真机（compose，本设计验证标准）：
  1. 单节点 + cluster 两 profile 均正常起、迁移通过、`/api/live` 200
  2. 无凭据 `curl /db/query` → 401；带凭据 → 200
  3. cluster 三副本数据一致（`SELECT COUNT(*) FROM users`）
  4. **默认路径**：`.env` 不设 `RQLITE_USERNAME/PASSWORD` → 与 Plan 2 已验证行为逐项一致（回归）

### 3.2 B：登录限速外部化

#### 数据层

迁移 `033-rate-limit-hits.sql`：

```sql
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key      TEXT NOT NULL,
  hit_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key_at ON rate_limit_hits(key, hit_at);
```

（多副本并发 `INSERT` 无冲突；滑动窗口计数读 + 写，无需唯一约束。）

#### 实现层

`lib/rate-limit.ts` 的策略化：

- 现有 `InMemoryRateLimiter` 不动（默认后端，单副本快路径）。
- 新增 `RqliteRateLimiter`：`check(key, config)` = `SELECT COUNT(*) WHERE key=? AND hit_at > now-window`（弱读 `level=weak` 走 `getDbWrite` 的 D1 REST /query）+ 未超限则 `INSERT`。窗口边界用 ISO 字符串比较（与全库 `datetime('now')` 同源，避免时钟语义分歧）。
- 选择开关：`RATE_LIMIT_BACKEND=rqlite` 时 `authorizeCredentials` 用表驱动；默认 `memory`。
- **清理**：每次 `check` 以 1/100 概率执行 `DELETE FROM rate_limit_hits WHERE hit_at < now - 最长窗口`（复用现有 sweep 的 opportunism 思路，避免定时器）。

#### 取舍

- 一次登录 = 1 次弱读 + 1 次写（rqlite 单 leader 串行化）。登录是低频操作，可接受；若未来压力大可换 memory+Redis 类，但那超出自建范围。
- 表驱动限速在**时钟漂移**下依赖各 web 副本的 `hit_at` 写入值——用 SQLite 侧 `datetime('now')` 生成（leader 求值），副本只读，天然一致。

#### 测试

- 单测：mock D1 client，覆盖「窗口内计数、超限拒绝、过期不计、清理执行」。
- 真机：可选验证（本项目单 web 副本是默认部署形态），README 说明开关。

### 3.3 C：反代/TLS 部署文档

README 新增「反向代理」小节：

1. **Caddy（推荐）**：最小配置（`reverse_proxy web:7020` + 自动 HTTPS），注明 `NEXTAUTH_URL=https://域名`。
2. **Nginx**：`proxy_set_header X-Forwarded-For $remote_addr;`（**覆写**而非追加——`getClientIp` 信任该头）、`X-Forwarded-Proto https`。
3. **硬约束清单**：
   - 反代必须覆写/清洗 `X-Forwarded-For`（规格 §7「XFF 可伪造」项）
   - `NEXTAUTH_URL` 用 https → `USE_SECURE_COOKIES=true`（否则浏览器丢弃 `__Secure-` cookie；反之一律 http 则必须 `false`）
   - `TRUSTED_ORIGIN` 由 `NEXTAUTH_URL` 推导，无需单独配置（proxy.ts 已实现）
4. **可选**：`deploy/selfhost/docker-compose.proxy.yml` 覆盖文件，把 web 端口改绑 `127.0.0.1`（对外只露反代）。

---

## 4. 交付拆分（实现阶段）

| 段 | 内容 | 独立验证 |
|---|---|---|
| 1 | A：rqlite 鉴权 | compose 单节点 + cluster 真机；默认路径回归 |
| 2 | B：限速外置 | 单测 + 可选真机 |
| 3 | C：文档 | 无需测试，人工核对命令可用性 |

每段一个提交；全部完成后一轮完整回归（pre-commit 全量 + L3 94 例 + compose e2e 单节点/集群）。

---

## 5. 兼容性与回滚

- 三项均**默认关闭**（A：不设凭据；B：不设 `RATE_LIMIT_BACKEND`；C：纯文档），已有部署升级无需任何动作。
- 回滚 = revert 对应提交；迁移 033 是纯新增表，回滚无副作用（账本不回退，表留着无害）。
