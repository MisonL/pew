# pew 私有化部署

不依赖任何 Cloudflare 服务。数据存在 rqlite，两个 Worker 跑在 Node 进程里。

## 快速开始

```bash
cd deploy/selfhost
cp .env.example .env
chmod 600 .env        # 含明文密钥；同宿主其他用户不应能读（目录是 755 时 644 的 .env 谁都能读）
# 编辑 .env：至少填 AUTH_SECRET、NEXTAUTH_URL、三个密钥
# 纯 http 访问（本 Quickstart 默认）必须再填 USE_SECURE_COOKIES=false，
# 否则 __Secure- 前缀 cookie 被浏览器丢弃、登录全线失效（见「Cookie 与
# USE_SECURE_COOKIES」小节的四格表；https 部署留空即可）
# .env 里 COMPOSE_PROFILES=single（默认），等价于 --profile single
docker compose up -d --build
```

首次启动后访问 `http://<host>:7020`。

> **重要**：web 在**首次使用认证时**校验 `AUTH_SECRET`——缺失或仍是占位符（`replace-me`、
> `changeme`、`secret`、空值）会抛错拒绝签发会话，登录/认证接口全部报错。实测：占位值下
> **所有页面（含 `/setup`、`/login`）都返回 500**——proxy 的 auth 包装在每个请求上执行，
> `requireAuthSecret()` 直接抛错；容器进程本身存活，但页面不可用。会话 JWT 用公开已知密钥签名等于认证 bypass。若第一次 `up` 在填好三个 rqlite 密码之前执行，
> 后续启用鉴权时必须 `docker compose up -d --build --force-recreate` **整栈**——
> bind-mount 路径不变时 compose 不会重建容器，rqlite 会继续以无鉴权运行；
> 而且只 `--force-recreate rqlite` 不够：`RQLITE_USERNAME/PASSWORD` 是**容器创建时**注入
> read/ingest/scheduler/d1-http/migrate 的，只重建 rqlite 会让这些容器继续持有旧（空）
> 凭据，鉴权一开全部 401，栈起不来。

### 启用 rqlite 鉴权（可选，固定序列）

默认无鉴权（上文 Quickstart 即无鉴权路径）。要启用时在 `.env` 填三个变量：
`RQLITE_USERNAME`、`RQLITE_PASSWORD`、`RQLITE_JOIN_PASSWORD`——**三要素缺一不可**，
任一为空 = 整体不启用（渲染脚本会拒绝产出并清掉残留文件）。read/scheduler 等所有
应用服务直接使用这对全权凭据（compose 已内置 `${RQLITE_USERNAME:-}`/`${RQLITE_PASSWORD:-}`
fallback）。

**必须严格按以下三步的顺序执行：**

1. **先渲染 auth.json**（读 `.env` 三个变量，产出 `deploy/selfhost/.rqlite-auth.json`，
   umask 077 / 权限 600——明文密码，同宿主其他用户不可读）。需要宿主机有 `jq`（脚本
   启动即检查，缺失时报错退出）。注意：脚本读的是**进程
   环境变量**，`.env` 不会被 compose 之外的命令自动导出，必须先 source：

   ```bash
   set -a; . ./.env; set +a; bash render-rqlite-auth.sh
   ```

   期望失败路径：若渲染脚本报「must all be set (or all empty)」退出 1，先核对 `.env`
   三个变量是否都已填写非空（且当前 shell 确实 source 了 `.env`），再重试。

2. **再启动**：

   ```bash
   docker compose up -d --build --force-recreate
   ```
   （`--force-recreate` 不可省：如果此前有一次无鉴权的 `up`，bind-mount 路径未变时 compose
   不会重建 rqlite 容器，`-auth` 就不会生效。）

3. **自检**（rqlite 未发布宿主端口，在容器内探测；auth.json 的 `*` 条目允许匿名读
   `/status`，所以匿名探测就能看出鉴权状态）：

   ```bash
   docker compose exec rqlite wget -qO- http://localhost:4001/status | grep -o '"auth":"[a-z]*"'  # single
   # cluster: 把 rqlite 换成 rqlite-1
   # Expected: "auth":"enabled"
   # 若显示 "auth":"disabled"：凭据已配置但服务端以无鉴权启动 —— 立即停下，
   # 用上面的 --force-recreate 序列重做（普通 up -d 不会重建容器，重试无效）
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
   cd /path/to/pew/deploy/selfhost   # compose 只读 ./.env，必须在 compose 文件所在目录执行
   set -a; . ./.env; set +a   # 把 .env 凭据导出到当前 shell，供下方 -e 按名转发
   export RQLITE_RESET_PW='new-secret-123'   # export 后 -e 只写变量名：值不进 argv，也就不进宿主 ps 与 shell history
   docker compose exec -T \
     -e RQLITE_URL=http://rqlite:4001 \
     -e RQLITE_USERNAME -e RQLITE_PASSWORD -e RQLITE_RESET_PW \
     d1-http \
     bun /app/deploy/selfhost/reset-password.ts --email admin@corp.local
   ```

   新密码经 `RQLITE_RESET_PW` 环境变量传入（也支持 `--password-stdin` 管道输入）；
   **不要**用 `--password` 命令行参数——它会留在宿主 `ps`/shell history 里。同理，
   `-e VAR=值` 的**带值形式**会把值放进 `docker compose exec` 进程的 argv（宿主 `ps`
   在 exec 期间全程可见），所以凭据一律先 export 再用**只写变量名**的 `-e VAR` 形式
   （与 backup.sh 的凭据转发同款）。

   （脚本在 `pew-selfhost:local` 镜像内的路径是 `/app/deploy/selfhost/reset-password.ts`，
   `d1-http` 与 rqlite 同网络且 `RQLITE_URL` 默认就指 `http://rqlite:4001`。）

   改密后旧会话自动失效（JWT 携带密码版本号，不匹配即判无效）。

**限速**：登录限速默认**进程内**（`inMemoryRateLimiter`），多 `web` 副本时退化为按副本
计。默认路径按**邮箱单键**限流（`login:<email>`，无 IP 维度）；只有
`LOGIN_RATE_LIMIT_BACKEND=rqlite` 时才启用邮箱 + IP 双键。**登录侧**的 `X-Forwarded-For`
信任只在该后端下存在；auth-code 生成/校验与 CLI 登录的 IP 限速桶**无条件**使用
`getClientIp`（ingest 的 300/min 桶按 userId 计，仅在 userId 为空时回退到 IP——正常
路径不可达）——下文反代小节的"反代必须覆写 XFF"硬约束对这些桶同样必要，不限于登录。

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

## CLI 指向自建服务（`--host` / `PEW_HOST`）

### ★ 先拿到带 `--host` 的 CLI

**这一步不能跳过**：`--host` / `PEW_HOST` 只存在于本分支，npm 上的
`@nocoo/pew`（包名与本分支相同、版本同为 3.3.3）是**上游版本，没有这两个参数**。
直接 `npx @nocoo/pew sync --host ...` 会报 `Unknown argument: host`。

本分支不发布 npm 包，因此从本仓库构建：

```bash
git clone --branch feat/self-hosted-deployment --single-branch <本仓库地址> pew
cd pew
bun --version                   # ★ 必须与仓库固定的 1.4.0 同次版本
bun install --frozen-lockfile
bun run build                    # 先构建 @pew/core（web 与 CLI 都依赖）
bun run --cwd packages/cli build # 产出 packages/cli/dist/bin.js
node packages/cli/dist/bin.js --version   # 自检：应打印 3.3.3
node packages/cli/dist/bin.js sync --help | grep -- --host   # 自检：必须能看到 --host
```

★ **Bun 必须装 1.4.0**：两个 Dockerfile 都 pin 了 `oven/bun:1.4.0`（根 `Dockerfile:7`
的注释写明「floating `oven/bun:1` broke frozen-lockfile across Bun minors」）。换用别的
小版本，`bun install --frozen-lockfile` 会直接报 `lockfile had changes, but lockfile is
frozen`——实测 1.3.14 必失败、1.4.0 通过。系统已有旧版时装一份用户级副本，不要覆盖系统
那份（可能被其它项目依赖）：

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"   # 装到 ~/.bun/bin/bun
export PATH="$HOME/.bun/bin:$PATH"                          # 仅本步骤需要；写进 shell rc 则全局生效
bun --version                                               # 确认 1.4.0 后再执行上面的 install
```

（只跑 `bun run build` / `bun run --cwd packages/cli build` 时用哪个 bun 都行，
锁定只影响 `install`。）

然后把 `packages/cli/dist/bin.js` 放进 PATH（或建个包装脚本）：

```bash
# 方式一：软链到用户 bin（推荐，升级时重新 build 即可生效）
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/cli/dist/bin.js" ~/.local/bin/pew
export PATH="$HOME/.local/bin:$PATH"     # 写进 ~/.bashrc 或 ~/.zshrc

# 方式二：直接以绝对路径调用，适合只在一台机器上偶尔同步
node /path/to/pew/packages/cli/dist/bin.js sync --host http://pew.corp:7020
```

需要 Node 或 Bun 运行时（`bin.js` 自带 `#!/usr/bin/env node` shebang；build 产物默认无
可执行位，软链方式先 `chmod +x packages/cli/dist/bin.js`）。**升级**：`git pull && bun
install && bun run build && bun run --cwd packages/cli build`，软链无需重建。

### 登录与同步

局域网客户端要完成登录与同步（设计成功标准 2），三步都走**同一 host**：

```bash
pew login --host http://pew.corp:7020     # 浏览器流程，凭据落 config.pew.corp_7020.json
pew sync  --host http://pew.corp:7020     # 解析并上传到自建服务
pew logout --host http://pew.corp:7020    # 清掉的是自建那份，SaaS 的 config.json 不动
```

不想每条命令都带参数，就导出环境变量：`export PEW_HOST=http://pew.corp:7020`。
优先级是 `--host` > `PEW_HOST` > `--dev` > 内置 SaaS 地址，所以显式参数能盖掉
shell 里残留的 `PEW_HOST`。

**凭据按 host 隔离，三条命令共用同一条规则**（`cli/src/config/manager.ts` 的
`credentialHostScope`）：自建 host 的 token 存独立文件 `config.<host[:port]>.json`，
内置 SaaS 地址（`https://pew.md` / `https://pew.dev.hexly.ai`）仍用原来的
`config.json` / `config.dev.json`——已签发的 SaaS token 文件名不变。**未加 `--host`
的命令行为也完全不变。**

这是 2026-10-20 补的缺口，记在这里因为合并上游时会碰到：`login` 早已按 host 写，
但 `sync` 读凭据时没带 host——结果要么对自建实例报 "Not logged in"，要么
**把自建采集的数据带着 SaaS token 传到 pew.md**。`logout` 同样会清错文件、
把自建 token 留在盘上。现在 `login` / `sync` / `logout` 三处都过 `credentialHostScope`，
`sync` / `logout` 补上了 `--host` 参数，`login` 的 "Token saved to" 打印真实路径。
设备身份不受影响（base-cli 的 `device.json` 跨 host 共享，多设备去重要求如此）。

**导出的队列记录不区分目标 host**：队列里没有「这条属于哪个实例」的概念，
`pew sync --host A` 和 `pew sync --host B` 会把同一批待传记录先后推给两个实例。
只指向一个实例就没这个问题；真要同时喂两个自建实例，请分两套 `~/.config/pew`
（改 `HOME` 或 `XDG_CONFIG_HOME`）。

## 架构

| 容器 | 作用 |
|---|---|
| `rqlite` | 数据库（Raft 复制，单节点默认） |
| `migrate` | 一次性迁移执行器，跑完退出 |
| `d1-http` | 把 D1 REST 形状翻译成 rqlite 调用 |
| `read` | worker-read（读路径 + `/api/live`） |
| `ingest` | worker（写入路径） |
| `scheduler` | 定价同步定时器（固定 1 副本；默认每 24h，`DAILY_INTERVAL_MS` 可调。间隔从容器启动起算，重启会重置计时——flapping 主机可能反复顺延同步） |
| `web` | Next.js 前端，唯一对外端口 |

只有 `web` 发布宿主端口，其余仅在 compose 网络内可达。

**两套镜像，别混**：跑 bun 的适配层服务（migrate/d1-http/read/ingest/scheduler）用
`deploy/selfhost/Dockerfile` 构建的 `pew-selfhost:local`；`web` 用**仓库根 `Dockerfile`**
构建的 `pew:standalone`（Next standalone）。把 web 指到 `pew-selfhost:local` 会因无 Next
产物、无 CMD 而退出。

## 集群模式

> **从单节点切换过来时，旧 `rqlite` 容器必须先下线**（见下方步骤）。profile 只是
> compose 的「是否创建」开关：inactive profile 的服务**不会被 `up` 启动，也不会被 `down`
> 停止**。直接改 `.env` 再 `up` 会让旧的单节点 `rqlite` 继续运行，它与三个集群节点共享
> 同一个网络别名 `rqlite`，应用服务的 DNS 会在四个容器间轮询——写可能落到那个独立的
> Raft 实例上并「成功」，数据随即分叉。**而且集群的三个卷是全新的空卷：单节点的数据不会
> 自动带过去。**

```bash
# 0) 先备份：第 4 步的恢复路径以这份归档为前提。第 1 步的 rm 不带 -v，卷会保留，
#    但没有备份就得多绕一圈临时起回单节点。
bash ./backup.sh /var/backups/pew/pre-cluster-$(date +%F).db

# 1) 下线并删除旧的单节点容器（不带 -v，保留 rqlite-data 卷以便回退）
docker compose --profile single stop rqlite
docker compose --profile single rm -f rqlite

# 2) 把 .env 的 COMPOSE_PROFILES 改为 cluster（--profile 只对本次调用生效，后续任何
#    裸 `docker compose up -d`——升级、排障、恢复——都会按 .env 选择服务；backup.sh
#    也按 .env 选服务）
# 3) 起集群
docker compose up -d --build

# 4) 迁移数据：按下方「恢复」runbook 把第 0 步的备份 .restore 进集群
#    （compose 的 cluster profile 建的是空集群，数据不会自动带过去）
```

> 不要在这里改用 `-join` 在线扩容：compose 的 cluster 节点固定带
> `-bootstrap-expect 3` 与互相 `-join` 的参数，没有位置表达「join 进旧单节点」。
> `-join` 是另一条**互斥路线**（见下方「单节点在线扩容」），需要手工 `docker run`
> 或临时改 compose，与本节的三步切换不能混用。

**从单节点迁到集群的数据路径**：compose 的 cluster profile 建的是**空集群**。要保留数据，
必须先在切换前用 `backup.sh` 备份（见上方第 0 步），切到集群并让 migrate 跑通后，按「恢复」
runbook 把归档 `.restore` 进集群。`-join` 在线扩容则是另一条互斥路径（把新节点 join 进
**已有数据**的单节点，而不是另起一套空集群），见下方。

三个 rqlite 节点通过 Raft 复制。**同机三容器只防进程故障，不防磁盘/主机故障**；跨机部署请把 compose 分发到三台机器并调整 `-join` 地址。

**跨机部署的额外要求**：三节点的 auth.json 必须**同源渲染、逐字节一致**（joiner 校验看
文件里同名用户的密码，文件不一致则部分节点 join 失败）；任何凭据变更（含轮换）= **全部
节点 recreate**（rqlite 不热加载 auth）；节点间 join/复制流量走 **4002 明文**（无 TLS），
跨公网/不可信网段必须套 WireGuard 或限制在私有网段。

**三节点降级信号**：

- **单节点 down** → 集群仍有多数派（2/3 可写，可读），**不是只读**；但冗余已减一。
  信号：该节点容器退出/重启、`/status` 的 `leader` 字段仍非空（多数派正常）、web 读写
  均正常。恢复该节点即回到 3/3，无需人工干预。
- **两节点 down** → 集群**读写都不可用**（多数派丢失，raft 拒写；读也不能幸免——业务读
  是 weak，但 rqlite 把 weak 读转发给 leader，无 leader 时同样失败）。恢复时**两台同时
  恢复**，不要逐台改配置——auth.json 不一致会导致 recreate 后 join 失败。
- read 副本 down 不影响写路径，但**不是只在日志里可见**：read 有 healthcheck，
  `docker compose ps` 直接显示它 unhealthy（且 web 的 `/api/live` 探针经 read 查库，
  read 挂掉时 web 也会 unhealthy）。

**单节点在线扩容为 3 节点已验证可行**：向已运行的单节点 `-bootstrap-expect 1` 直接
`-join <单节点>:4002`（join 节点**不要**带 `-bootstrap-expect`）即可，实测 3 节点全部
voter/reachable，且新节点能读到扩容前写入的数据。这条路把新节点加进**已有数据**的单节点，
数据随 Raft 复制过去；而直接切 compose 的 cluster profile 是另起一套空集群，两者不能
混为一谈（切换前务必按上一节先下线旧单节点容器）。

> 这条路**不走** compose 的 cluster profile：那三个服务写死了
> `-bootstrap-expect 3` 与互相 `-join`，没有「join 进旧单节点」的位置。要在线扩容得手工
> `docker run` 起节点（或用临时 compose 覆盖文件改 `-join`/`-bootstrap-expect`），
> 本文不提供现成命令——请据上述参数自行构造，并在动手前备份单节点卷。

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
        proxy_set_header Host $host;                        # 保证生成的 URL/redirect 正确；真实 origin 由 NEXTAUTH_URL (TRUSTED_ORIGIN) 锚定，误配 Host 不会破登录但会生成错误链接
        proxy_set_header X-Forwarded-For $remote_addr;      # 覆写，不是 $proxy_add_x_forwarded_for（追加，保留攻击者伪造段）
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;            # 不覆写则攻击者伪造的 X-Real-IP 穿透到 web，IP 限速键可伪造
        proxy_set_header CF-Connecting-IP "";               # 同理：getClientIp 依次信任 XFF/X-Real-IP/CF-Connecting-IP
    }
}
```

### ★ 硬约束清单

- ★ **web 的 7020 端口只绑 `127.0.0.1` 或不发布**：任何能直连 7020 的客户端都可以整体伪造
  `X-Forwarded-For`（无反代时它就是唯一的 IP 信任来源）。**绕过后果**：攻击者每个请求带
  不同的自造 XFF 即可获得无限个新的 IP 限速桶，IP 维度登录限速形同虚设（邮箱桶仍有效）。
  用 `docker-compose.proxy.yml`
  覆盖文件把端口改绑到回环；直接暴露 7020 的部署（如纯内网无反代）应视为**不受支持的
  公网拓扑**，IP 限速不可依赖。

  ```bash
  # !override 替换（而非追加）基础 compose 的 ports 列表，需 Compose >= v2.24.4。
  # 注意：-f 叠加只作用于本次调用。之后任何裸 `docker compose up -d`（升级、排障）
  # 都会回到基础 compose 的 0.0.0.0:7020 发布——要么每次调用都带两个 -f，要么在
  # .env 里设 COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml 固化。
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml config   # 冒烟核对合并结果
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
  ```

  注意：此约束防的是**网络外**直连；同宿主其他本地用户进程仍可达 `127.0.0.1:7020`（多租户宿主
  属部署者自担），compose 网络内攻击者本就绕过 web 直达数据层，7020 收紧不改变该模型。
- ★ **`NEXTAUTH_URL` 必须与反代对外访问 URL 逐字符一致**（协议+域名+端口；`TRUSTED_ORIGIN`
  永远 pinned 到它，不一致则重定向/回调指向错误主机）。CLI 侧 `PEW_HOST` 同步——且
  这个 host 串同时决定凭据文件名（`config.<host[:port]>.json`），所以换了写法（加尾斜杠
  无所谓，改端口或 http/https 不影响——文件名只取 `host:port`）就等于换了另一个登录态。
- ★ **反代必须覆写 `X-Forwarded-For`**（`getClientIp` 取**最后一段**——自己代理追加的那个；客户端可注入前面的段，覆写型配置是硬要求而非建议），同时覆写 `X-Real-IP`、清空
  `CF-Connecting-IP`（`getClientIp` 依次信任三者）。Caddy ≥ 2.5 默认满足；Nginx 按上面
  `$remote_addr` 覆写。
- **漏配 XFF 的后果**（`LOGIN_RATE_LIMIT_BACKEND=rqlite` 时）：`X-Forwarded-For` 缺失时所有
  登录请求都落到 `login:ip:unknown` **共享限速桶**，攻击者打满该桶即造成**全员登录 DoS**
  （fail-closed 方向）。默认的 `memory` 后端登录只按邮箱单键（`login:<email>`，无 IP 桶），
  但 auth-code 生成/校验与 CLI 登录的 IP 桶**无条件**存在，同样依赖这一覆写——这是上面
  XFF 覆写为硬约束的直接原因。

### Cookie 与 USE_SECURE_COOKIES

镜像以 `NODE_ENV=production` 运行，secure cookie **默认开启**：`.env.example` 与 compose 的
`USE_SECURE_COOKIES` 默认都是**空值**，空值交给 `packages/web/src/auth.ts` 推导，production
下结果为 true（`auth.ts:45-55` 只在显式 `false` 时才关闭）。因此：

- **纯 http 内网部署必须显式填 `USE_SECURE_COOKIES=false`**，否则 `__Secure-` cookie 被
  http origin 拒收，登录全线失效。
- **https 部署留空即可**（默认已安全）；显式填 `true` 与留空等价。

| 部署协议 | USE_SECURE_COOKIES | 结果 |
|---|---|---|
| https | 留空（默认）或 true | ✓ 正常（`__Secure-` 前缀 cookie） |
| https | false | 可登录，但无 `__Secure-` 前缀（**降级可用**，不是浏览器丢弃） |
| http | 留空（默认）或 true | **登录坏**——`__Secure-` cookie 被 http origin 拒收（空值在 production 下的推导结果就是 true） |
| http | false | ✓ 正常（**http 部署必须显式填 false**） |

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
  这个 token，因此 compose **只把它下发给 `d1-http`、`web`**（`d1-http` 是校验方、`web` 是
  客户端；migrate 只做 DDL，凭据走 `RQLITE_USERNAME`/`RQLITE_PASSWORD`）；`read`/`ingest`/
  `scheduler`/`migrate` 的 `environment` 不含它，收窄了密钥在容器内的暴露面。
- **web 在首次使用认证时校验 `AUTH_SECRET`**（NextAuth 惰性初始化，非进程启动期）：缺失或仍是 `.env.example` 的 `replace-me` 占位符会在首次
  使用认证时抛错拒绝签发会话——用仓库公开的密钥签 JWT 等于允许任何访问者伪造会话。
- **rqlite 的 SQL 错误文本会透传到 web 客户端**（如 `no such table: ...`），可能泄漏表名/列名。
  这是已接受的信息泄漏面：d1-http 只在 compose 网络内可达、调用方只有 web 自身的参数化查询，
  构造出 SQL 错误的输入受 web 路由校验约束。如需收窄，在 d1-http 的错误封套处做通用化映射。
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
- 读的默认一致性是 `?level=weak`（业务读路径）。rqlite 会把 weak 读转发给 leader，因此读
  一致性等价强一致；`none` 会读到陈旧数据，禁止使用。**两处例外走强读**：KV 缓存的
  `get()`（`kv-adapter.ts` 的 read-after-write 契约）与迁移账本（`migrate.ts`——读到
  陈旧账本会重跑不幂等迁移），各自注释里写了理由。

## 验证

```bash
bun run test                                    # 单元测试（含 deploy/selfhost 的适配层用例；仓库根执行）
# verify-migrations 对账真实实例（rqlite 未发布宿主端口，在容器内跑；鉴权开启时凭据经 -e 传入）：
# 注意它会**先应用缺失迁移再做对账**（不是只读检查）——恢复旧备份后跑它会顺带补齐迁移。
cd /path/to/pew/deploy/selfhost                  # compose 只读 ./.env，以下必须在 compose 目录执行
set -a; . ./.env; set +a
docker compose exec -T \
  -e RQLITE_URL=http://rqlite:4001 \
  -e RQLITE_USERNAME="$RQLITE_USERNAME" \
  -e RQLITE_PASSWORD="$RQLITE_PASSWORD" \
  d1-http \
  bun /app/deploy/selfhost/verify-migrations.ts --base-url http://rqlite:4001
```

> **类型检查**：`deploy/selfhost/` 由 `scripts/parallel-typecheck.sh` 的
> `tsc -b deploy/selfhost/tsconfig.json` lane 编译期校验（project references 指向 core 与两个
> worker 的 composite 声明构建 `tsconfig.build.json`），适配层与上游 `D1Database`/`KVNamespace`
> 的类型兼容性由此获得保证；入口是 `bun run lint:typecheck`（`bun run typecheck` 本身只覆盖
> `packages/*` 与 e2e 清单，不含 deploy/）。运行时另由 deploy/selfhost 的 15 个 vitest 测试文件覆盖（用例数随交付增长，以 `bunx vitest run deploy/selfhost` 实际输出为准）。


## 备份

rqlite 的 CLI **没有** `backup` 子命令；备份是交互式 REPL 里的 `.backup` 点命令
（非交互场景经 stdin 管道喂 `.backup` + `.exit`，如下例）。
直接 `cp` 活跃的数据库文件会拿到损坏的副本，不要那样做。

替代通道是 HTTP 端点 **`GET /db/backup` 带 `-u user:pass`**（10.5.3 实测 200，返回全库
SQLite 文件；`POST /db/backup` 是 405；`GET /backup`（少 `/db` 前缀）是 404）。
鉴权开启时凭据即 `.env` 的 `RQLITE_USERNAME`/`RQLITE_PASSWORD`；rqlite 未发布宿主端口，
HTTP 方式需在容器内执行。注意：HTTP 通道的 `-u` 凭据**在宿主 argv 可见**，是排障用的一次性
通道，不要用于定时任务——定时备份用下文的 `backup.sh`（环境变量转发）。

**备份后务必校验文件非空**：实测 `.backup` 失败仍会创建 0 字节假文件，`[ -s ]` 是必须的
最后一道检查。

**定时备份用 `backup.sh`**（仓库交付的可执行脚本，cron/systemd timer 友好）：读 `.env`
凭据、按 profile 自动选 `rqlite`/`rqlite-1`、在**目标旁一个 0700 的暂存目录**里接收副本并
`chmod 600`（`docker compose cp` 按容器侧 0644 落地、无视 umask；暂存目录保证哪怕脚本被
SIGKILL——此时 trap 无法执行——归档也不可被其他用户读取）、要求 REPL 打出成功行并校验产物、
校验通过后再原子 `mv` 覆盖目标、空归档/截断归档/非 SQLite 产物一律非零退出、退出时清理
暂存目录与容器内临时文件。
脚本会 `cd` 到自身所在目录，所以默认产物落在 **`deploy/selfhost/backup-YYYY-MM-DD.db`**，
不是当前工作目录；**相对路径参数也按脚本目录解析**（`bash deploy/selfhost/backup.sh out.db`
会写到 `deploy/selfhost/out.db`，不是调用方 cwd——非 `backup-*.db` 的命名不在 gitignore
覆盖内，生产部署建议直接指定 `/var/backups/` 下的绝对路径）。默认产物已被 `.gitignore`
覆盖，归档不会误入 git 历史。以 `-` 开头的输出路径会被拒绝（GNU 下 `dirname`/`mv` 会把它
当选项，实测 `--help` 会静默丢档并 rc=0）。

**`.env` 会被当作 shell 脚本执行**（脚本 `set -a; . ./.env`）：密码值必须用**单引号**包裹
（不加引号时 `$` 会展开——实测 `pa$$word` 变成 `pa<PID>word`——反斜杠会被吞）；`.env` 里
不能出现裸 `exit`（会让备份静默跳过且退出码为 0）。`.env` 本身请 `chmod 600`：它含明文
`AUTH_SECRET`/`CF_D1_API_TOKEN`/`WORKER_SECRET`/`RQLITE_PASSWORD`，且可写它=可劫持以你
身份运行的备份 cron。不要把任何不可信来源的文件放进这个路径。

```bash
# 手动一次（默认写到 deploy/selfhost/backup-YYYY-MM-DD.db）
bash deploy/selfhost/backup.sh
# 指定路径（父目录不存在会自动创建）
bash deploy/selfhost/backup.sh /var/backups/pew/pew.db
# cron（每天 03:17，失败退出码非零，可接告警）
17 3 * * * cd /path/to/pew && bash deploy/selfhost/backup.sh /var/backups/pew/backup-$(date +\%F).db
```

注意事项：

- **成功时日志只有一行 `backup written to <路径>`**。REPL 的转录（banner、`Connected to ...`、
  成功行）只在**失败**时打到 stderr——成功路径上重复打印这段噪声会把 timer 日志里真正
  的失败淹没，所以脚本只在需要人看诊断时输出它。期望每次 cron 日志都极短；看到多行输出
  即意味着有失败要排查。
- **cron 的 `PATH` 通常不含 docker**。用 `docker: command not found` 报错时，请在 crontab
  顶部显式设置 `PATH=/usr/local/bin:/usr/bin:/bin`（或 `command -v docker` 查到的目录）。
- **不要在多个 timer 上并发跑备份**：脚本内 `.backup` 写的是固定容器路径
  `/rqlite/file/backup.db`，与宿主输出路径无关，所以并发运行必然互相覆盖，且先结束者的
  EXIT trap 会 `rm -f` 掉另一个正在使用的归档。**指向不同输出路径并不能避免冲突**——必须
  错开时间，或用 `flock`（如 `flock -n /var/lock/pew-backup.lock bash backup.sh ...`）串行化。
- **凭据经环境变量传入容器**（`docker exec -e RQLITE_USERNAME -e RQLITE_PASSWORD`）：宿主
  `ps` 里可见 argv，环境变量不可见，所以密码含空格也无需引号技巧。脚本不接受把
  `-u user:pass` 放进 argv。
- **校验是白名单式的**：不仅非空，还要求 REPL 打出成功行 `backup file written successfully`
  且前 16 字节是 `SQLite format 3\0` 魔数。成功行是必需的一道：磁盘写满时 `.backup` 打出
  `ERR! write ... no space left on device`（stdout，退出码仍是 0）并留下一个**截断**文件，
  它同时通过非空与魔数检查（10.5.3 实测）。**这仍不是完整性门**：恢复演练时建议在可信宿主
  上补 `sqlite3 <archive> 'PRAGMA integrity_check'`。
- **`.backup` 本身的退出状态不可信**：REPL 打出 `ERR!`（如凭据错误、磁盘写满）后仍以 0
  退出（rqlite 10.5.3 实测），所以脚本不依赖 REPL 的退出码——`.backup` 前先清掉容器内可能
  残留的旧归档（SIGKILL 会跳过清理 trap），完成后要求 REPL 打出成功行、再用 `test -s`
  断言容器内归档真实存在，两道门都过才继续 cp。没有这些门时，一次失败的备份会安静地复制
  上一轮的陈旧归档、或把截断文件覆盖到完好归档上，并以退出码 0 "成功"。

灾难恢复 runbook 见下文「**恢复**」部分（本节内的恢复步骤）；备份产物只含数据，`.env` 与
`.rqlite-auth.json` 需另行保管（见下）。

<details>
<summary>等效的手工片段（保留供排查对照；脚本即由它演变而来）</summary>

```bash
cd /path/to/pew/deploy/selfhost   # compose 只读 ./.env，必须在 compose 文件所在目录执行
set -a; . ./.env; set +a   # 备份小节命令读 $RQLITE_USERNAME/$RQLITE_PASSWORD，先导出

# 单节点（REPL 点命令通道；鉴权开启时必须带 -u，匿名 .backup 会 401；无鉴权部署直接省略 -u）
# 凭据走容器环境变量而非 argv：宿主 ps 里 argv 世界可读，环境变量不可读。
printf '.backup /rqlite/file/backup.db\n.exit\n' | \
  docker compose exec -T -e RQLITE_USERNAME -e RQLITE_PASSWORD rqlite \
    sh -c 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost'
docker compose cp rqlite:/rqlite/file/backup.db "./backup-$(date +%F).db"
chmod 600 "./backup-$(date +%F).db"   # 备份含全部 password_hash/api_key，禁止 world-readable
# 非空校验必须退出非零：包进 cron/systemd timer 时，0 字节假文件否则只会留一条 stderr、退出码仍为 0，无人告警。
[ -s "./backup-$(date +%F).db" ] || { echo "备份为空，失败！" >&2; exit 1; }

# 集群模式（.backup 可在任一节点执行——REPL 请求会转发给 leader，已实测；产物落在
# **执行节点**本地卷上，Raft 复制的是 SQL 日志而非文件——所以必须在同一个节点上先
# .backup 再 cp，不能在 A 节点 .backup 后到 B 节点 cp。把上面的 rqlite 换成任一
# rqlite-N 即可；leader 不固定，用容器内 /status 的 leader 字段确认实际节点。）
#
# ⚠ follower 在内部连接池**冷**时，第一次备份可能返回 `ERR! server responded with:
#   503 Service Unavailable`，重跑一次即成功。机制：follower 经内部连接池向 leader
#   转发 /db/backup，rqlite 在 30s 无数据后关闭池内连接（cluster connReadTimeout），
#   而 Client.Backup 不像 Execute/Query/Load 那样换新连接重试；leader 走本地快照，
#   不受影响。
#   但**正常部署里池不会冷**：compose 给 rqlite 配了 healthcheck，每 10s 打一次
#   /readyz，而 /readyz 内部就走同一个 cluster client 池（GetNodeMeta）。三节点
#   10.5.3 实测：带 healthcheck 的 follower 在 40s 空闲下 6 轮 0 次失败；把心跳
#   流量去掉后同一节点 6 轮中有 3 次首击失败、重试成功。所以这条重试防的是「池真的
#   是冷的」窗口（手工排障、healthcheck 被关、节点刚重启），不是每次 cron 都会踩到
#   的故障。遇到时重跑一次即可；backup.sh 已对这一确切特征自动重试一次，第二次仍
#   503 则照常 fail-closed（真正的无 leader 故障仍是错误）。
# ⚠ 本片段是排障对照，不是 backup.sh 的等价物：它没有 0700 暂存目录，cp 与 chmod 600
# 之间被 SIGKILL 会留下 world-readable 的归档（cp 落地 0644、无视 umask），不要把它
# 放进 cron。
```
</details>

产物是标准 SQLite 文件（已实测：`SQLite format 3` 魔数、含全部表与 `kv_cache`）。

**`.env` 与 `.rqlite-auth.json` 不在 rqlite 备份产物里**：数据库备份恢复不了鉴权。把
`deploy/selfhost/.env` 与（如存在）`.rqlite-auth.json` 复制到与 `.db` 备份相同的位置——
灾难恢复 runbook 的凭据重建（「auth.json 丢失恢复 runbook」情形 ②）依赖它们；丢了它们意味着重走完整的鉴权渲染序列。
同时建议备份命令以 `umask 077` 执行：`.db` 内含全部 `password_hash`。

**恢复（必须用 `.restore` 点命令，不能换文件）**：实测直接替换数据文件无效——实际数据文件在
`/rqlite/file/data/db.sqlite`（不是 `pew.db`），且 rqlite 启动时会用 `raft.db` 重放日志，
备份后的写入会「复活」；清空整个卷再放文件则走 bootstrap 忽略预置文件。`.restore` 走 REPL、
经 Raft 正常应用（已实测：恢复后备份后的写入行消失，只剩备份时点的数据）。鉴权开启时凭据
同样经容器环境变量传入（`-e VAR`），不要把 `-u user:pass` 放进 argv（宿主 `ps` 可见）。
备份文件路径按 backup.sh 的实际产物位置写：默认在 `deploy/selfhost/` 下，或你 cron 指定的
目录——下例假设 `/var/backups/pew/`。

```bash
# compose 文件与 .env 都在 deploy/selfhost/；compose 不会向下搜索，先 cd 过来。
cd /path/to/pew/deploy/selfhost
set -a; . ./.env; set +a   # 恢复命令带 -u，需先导出 .env 凭据
# cluster profile 下没有 rqlite 服务：下文所有 rqlite 服务名（第 2 步的 rm exec、cp、
# chown exec，第 3 步的 restore exec，第 5 步的清理 exec，共 5 处）全部换成任一
# rqlite-N（请求会转发给 leader，.restore 经 Raft 应用到全部节点）；backup.sh 是按
# COMPOSE_PROFILES 自动选的，本 runbook 是人手执行，不会自动换。
# 0. 恢复前先给当前库做一次备份：恢复会覆盖现有数据，这一步是唯一回退点。
bash ./backup.sh /var/backups/pew/pre-restore-$(date +%F-%H%M).db
# 1. 停应用（读写都停，避免恢复期间写入；d1-http 是写后端，必须一起停）
docker compose stop web read ingest scheduler d1-http
# 2. 把备份放进 rqlite 容器（rqlite 保持运行，.restore 不需要停它）。
#    a) 先清掉容器内目标：cp 会覆盖文件内容，但 cp 失败时清理先行可确保不会沿用
#       上次失败尝试留下的陈旧 restore.db；
#    b) docker cp 把文件复制进容器时落地为 root:root（并保留源文件的 0600），容器内
#       rqlite 以 uid 1000(rqlite) 运行，读不了 0600 的 root 文件——不 chown 直接
#       .restore 必然 permission denied（实测 rqlite:10.5.3 + compose cp 复现）。
docker compose exec -T rqlite rm -f /rqlite/file/restore.db
docker compose cp /var/backups/pew/backup-2026-10-11.db rqlite:/rqlite/file/restore.db
docker compose exec -T -u root rqlite chown rqlite:rqlite /rqlite/file/restore.db
# 3. 用点命令恢复（鉴权开启时必须带 -u user:pass）。REPL 失败也返回 0（与 backup 同款：
#    ERR! 后仍 exit 0），必须断言输出含成功字样，否则下面的"起应用"会在未恢复的库上运行。
restore_out=$(printf '.restore /rqlite/file/restore.db\n.exit\n' | \
  docker compose exec -T -e RQLITE_USERNAME -e RQLITE_PASSWORD rqlite \
    sh -c 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost')
printf '%s\n' "$restore_out"
echo "$restore_out" | grep -q "Database restored successfully" || { echo "restore FAILED" >&2; exit 1; }
# 无鉴权部署把第 3 步整条 exec 换成：docker compose exec -T rqlite rqlite -H localhost
#    （同样要对 $restore_out 断言成功字样）
# 4. 先补迁移再起应用：恢复的库可能来自旧 schema，而 `start` 只启动已存在的容器，
#    不会执行 migrate 服务（它是一次性任务，只有 `up` 才会按依赖跑）。缺迁移直接起
#    web 会得到缺列/缺表的运行时错误。
docker compose run --rm migrate
docker compose start d1-http read ingest scheduler web
docker compose exec web node -e "fetch('http://127.0.0.1:7020/api/live').then(r=>r.json()).then(console.log)"
# 5. 清理临时文件（不清理会常驻 rqlite 卷、计入磁盘占用）
docker compose exec rqlite rm -f /rqlite/file/restore.db
```

## 升级

```bash
cd /path/to/pew                                    # git 操作在仓库根
git fetch upstream main && git merge upstream/main   # 或拉取自有 fork 的对应分支
cd deploy/selfhost                                 # compose 只读 ./.env，不向下搜索；以下都在这里执行
# 鉴权部署下先确认 .rqlite-auth.json 在磁盘（升级不删卷，但若宿主目录被清理，
# rqlite 容器 recreate 后 entrypoint 找不到 /auth/auth.json 会以无鉴权启动）。
# 用 test -f 而不是 docker compose run 检测：bind-mount 源缺失时 compose 会创建同名
# 目录，检测命令本身会写出 .rqlite-auth.json/ 目录，让下一次检查误报"存在"。
# 守卫按 .env 是否配置了 rqlite 凭据条件化：无鉴权部署（RQLITE_USERNAME 为空）本来
# 就没有该文件，不应被这里拦下。
set -a; . ./.env; set +a
if [ -n "${RQLITE_USERNAME:-}" ]; then
  test -f .rqlite-auth.json || { echo "auth file missing — re-render before up:"; exit 1; }
fi
# 缺失则先重新渲染（见「Quickstart」固定序列），再 up。
# .env 权限：升级不改变文件权限，但若从别处拷入过 .env，先确认它仍是 0600
# （含明文密钥；宿主目录 755 时 644 的 .env 对同机其他用户可读）。
[ "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" = "600" ] || echo "WARNING: .env is not 0600 — chmod 600 .env"
docker compose build                                 # 镜像本地构建，无远端可 pull
docker compose up -d
```

- 迁移在 `migrate` 服务启动时自动跑（`_migrations` 账本按文件名幂等，已跑过的不会重跑）。
- **migrate 失败的排障入口**：migrate 非零退出时 `read`/`ingest`/`scheduler`/`web` 都不会启动
  （`service_completed_successfully` 门），这是刻意的 fail-closed。修好原因后重跑
  `docker compose up -d --build migrate`，**成功后再补一次 `docker compose up -d`**
  （只 up migrate 不会拉起依赖它的 read/ingest/web——那些门只在整栈 up 时按依赖顺序展开；
  跳过这步会把栈留在"migrate 成功但应用层全停"的假象里）。
  瞬态错误（如慢启动的 60s 就绪超时）直接重跑即可，已应用的迁移会被账本跳过。
- **rqlite 版本升级前**先做一次备份（见上），并确认新版本的 auth.json 格式兼容
  （凭据条目数组格式自 8.x 起稳定，跨大版本升级后先在测试实例验证一遍
  「自检三步」再动生产）。
- 升级后跑一次 `verify-migrations.ts` 对账表/索引计数（rqlite 未发布宿主端口，用「验证」小节的 `docker compose exec d1-http` 形态，不要在宿主直接 `bun run`）。
- **应用回滚**：迁移只进不退（`_migrations` 无 down migration），回滚前先备份 `.db`。在
  `docker compose build` 之前给**两个镜像**都打旧标签——
  `docker tag pew-selfhost:local pew-selfhost:previous && docker tag pew:standalone pew:standalone.previous`；
  回滚时两条都要恢复：
  `docker tag pew-selfhost:previous pew-selfhost:local && docker tag pew:standalone.previous pew:standalone && docker compose up -d`
  （只回退 pew-selfhost 会把 web 留在新的坏镜像上）。历史迁移多为加列/建表，旧代码 + 新 schema 大体兼容，但这一
  兼容性**没有契约承诺**——重大 schema 变更的迁移文件会在提交说明中标注破坏性，回滚前核对。

## auth.json 丢失恢复 runbook

rqlite **不热加载 auth**：任何 auth.json 内容变更都必须以 recreate 收尾，仅换文件不重启
不生效。但重建范围取决于是否改了 `.env` 凭据：

- **修复/重建（`.env` 的 RQLITE_* 未变）** → 只 recreate rqlite 节点即可
  （`docker compose up -d --force-recreate rqlite`；cluster 下
  `rqlite-1 rqlite-2 rqlite-3` 全部）。
- **轮换（`.env` 凭据变了）** → **整栈 recreate**（`docker compose up -d --force-recreate`）：
  `RQLITE_USERNAME/PASSWORD` 是容器创建时注入 read/ingest/scheduler/d1-http/migrate 的，
  只重建 rqlite 会让应用容器继续持有旧密码，鉴权一开全部 401（与 Quickstart 的警告同源）。

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

### 最小排障入口

上述任何一步之后服务行为异常，先看两处再动配置：

```bash
docker compose ps          # 哪个容器在 restarting / unhealthy / exited
docker compose logs --tail=100 <svc>   # svc = web / rqlite / migrate / read / ...
```

rqlite 容器反复 unhealthy 时优先怀疑 auth.json **损坏**（`*` 条目缺失、文件被改坏——
匿名探针拿 401 才会让 unhealthy）。注意两类**不会**让 rqlite unhealthy 的 auth.json
问题：文件未渲染、半填凭据——这两种情况下 entrypoint 根本不加 `-auth`，rqlite 以无鉴权
启动且匿名 `/readyz` 返回 200，容器 healthy；卡住的是 `migrate` 的对账自检
（"credentials configured but auth is disabled"，exit 1），进而 read/ingest/web 全部不
启动。详见上文「auth.json 丢失恢复 runbook」的警告块，按"rqlite unhealthy"还是
"migrate 失败"分流排查。若日志出现的是
`not part of stable configuration, aborting election` 循环则不是 auth 问题：节点 ID
不在持久化的 raft 配置里。当前 compose 已为 rqlite 固定 `-node-id`/`-adv-addr`
（recreate 安全）；只有**旧版本 compose 部署过、且 recreate 过 rqlite 容器**的实例
会卡在这里——卷里记录的是旧容器 ID 派生的节点。恢复（rqlite 支持从 peers.json
强制重建配置，已对照 10.5.3 源码验证）：

```bash
docker compose stop rqlite
docker volume ls --format '{{.Name}}' | grep rqlite-data   # 确认承载数据的卷名（供备份/核对）
# rqlite 读的是**数据目录**下的 raft/peers.json（DATA_DIR 默认 /rqlite/file/data，
# 见 rqlite 源码 store.go 的 peersPath 与官方 entrypoint 的 DATA_DIR 默认值），
# 不是 /rqlite/file/raft/。compose 把卷挂在 /rqlite/file，因此落点是
# <卷>/data/raft/peers.json。`run` 已继承服务的卷挂载：**不要**再加
# `-v <卷名>:/rqlite/file/data`——那会把卷根当成数据目录，peers.json 落到
# <卷>/raft/peers.json，rqlite 永远读不到，节点照旧卡在选举循环。
docker compose run --rm --entrypoint sh rqlite \
  -c 'mkdir -p /rqlite/file/data/raft && printf "[{\"id\":\"rqlite\",\"address\":\"rqlite:4002\",\"non_voter\":false}]\n" > /rqlite/file/data/raft/peers.json'
docker compose up -d rqlite
# Expected: 日志出现 "attempting node recovery using ..."，随后 healthy
```

**集群部署（`COMPOSE_PROFILES=cluster`）不能用上面这份 peers.json**：节点 id 是
`1`/`2`/`3`，地址是 `rqlite-1:4002` 等，且每个节点的文件要列出**全部三个** voter。
单节点的那份只适用于 `rqlite` 服务；对集群套用会让节点以错误的配置启动。集群的
peers.json 重建属于破坏性操作，先备份三个卷再逐个节点处理。

**`unhealthy` 不等于自动重启**：`restart: unless-stopped` 只对进程退出生效；进程活着但
服务僵死（探针持续失败）时 Docker 不会重启容器。处置靠人工 `docker compose restart <svc>`；
本栈无自动告警通道，长期部署建议把 `docker compose ps` 纳入外部巡检。

若希望 unhealthy 自动处置，可在**宿主**加一个 compose 之外的看护（本仓库不交付，避免引入
特权容器与额外攻击面）。cron 每 5 分钟重启 unhealthy 的容器：

```bash
# 宿主 cron：只匹配 health=unhealthy（starting/healthy 都不会命中）
*/5 * * * * docker ps --filter health=unhealthy --format '{{.Names}}' | while read -r c; do docker restart "$c"; done
```

注意三点：① 该命令作用于宿主上**所有**容器；宿主还跑着别的 compose 栈时用
`--filter "label=com.docker.compose.project=<项目名>"` 收窄（项目名默认是 compose 文件所在目录名）；
② rqlite 重启后需重新选主，等于一次短暂写中断（选主完成前 weak 读同样不可用——
   weak 读会转发给 leader，而此刻没有 leader；单节点部署则是读写一起中断）；
③ 反复 unhealthy 应先按上文排障（auth.json / 节点 ID / 磁盘），自动重启只会掩盖根因——
   看护必须同时接**告警**（把 restart 的输出写入日志/通知），否则持续的 unhealthy 会被
   静默地每 5 分钟重启一次，掩盖正在进行的篡改或磁盘故障。

**数据层故障的健康面（已按实测探针行为更正）**：d1-http 的探针（`/health`）与
read/ingest 的探针（`/api/live`）都会对 rqlite 执行真实 `SELECT 1`，rqlite 宕机时
这三个服务会转 **unhealthy**（`restart: unless-stopped` 只在进程退出时重启，探针失败不触发，
见上文）。**web 的探针同样依赖数据层**：它的 `/api/live` 经 read 服务（`WORKER_READ_URL`）
发 `live.ping`（对 rqlite 执行 `SELECT 1`），失败时返回 503 → web 也转 unhealthy。因此
rqlite 宕机时**四个应用服务全部 unhealthy**；`web` 保持 healthy 的例外场景只有
**d1-http（写后端）单独故障**——读路径（read 服务）不经它，rqlite 正常时 web 页面读仍可用，
唯一症状是所有写操作失败。排查先看 `docker compose logs rqlite`。
注：宿主磁盘满时读探针通常仍能应答（SQLite 读不需新空间），健康门可能全绿——磁盘满的标准
症状是**所有写路径 500**，见下一段。

**宿主磁盘满**：rqlite 是唯一有状态组件，`rqlite-data` 卷写满后 Raft 无法提交日志，
症状是**所有写路径 500**（无任何指向磁盘的报错）。恢复：清理宿主空间后
`docker compose restart rqlite`；若 SQLite 卷已损坏则走备份恢复 runbook。
建议对 `rqlite-data` 卷做容量告警（如 `docker system df -v` 纳入巡检）。

**overlay 互斥注**：`docker-compose.proxy.yml` 与 `docker-compose.caddy.yml` 都对
`web` 服务声明 `ports: !override`（前者改绑 127.0.0.1，后者清空发布端口），二者
**不可同时叠加**（后者覆盖前者），三套文件两两组合时只叠一个。

## 交付边界

Plan 1 交付「数据层与运行时可用、API 可经 CLI/密钥调用」。Plan 2（认证子系统）补齐
**完整的浏览器登录闭环**：`/setup` 首个管理员 → 邀请码邀请后续用户 → 邮箱密码登录 →
管理员重置密码。**外网/邮件自助重置**不在本期（无 SMTP），密码重置为管理员线下交付
令牌，或用破窗脚本。多 `web` 副本时登录限速退化为按副本计（见上）。

## 合并上游

上游接触面分三批：

**Plan 1（数据层）**：`packages/web/src/lib/d1.ts`（新增 `D1_BASE_URL` 优先级）与
`vitest.config.ts`（`test.include` 增加 `deploy/**/*.test.ts`）。

**Plan 2（认证）**：`auth.ts`（条件 providers、Credentials、`pwd_v`、`USE_SECURE_COOKIES`
分支）、`app/login/page.tsx`（邮箱密码表单）、`lib/admin.ts` + `api/admin/check` +
`api/users/[slug]`（库内 `is_admin` 判定）、`proxy.ts`（`/setup` 公开）、`cli.ts` +
`cli/src/commands/login.ts` + `cli/src/config/manager.ts`（`--host`/`PEW_HOST` 与按 host
隔离凭据；2026-10-20 补：`cli/src/commands/upload-engine.ts` 与 `cli/src/commands/logout.ts`
读凭据时过 `credentialHostScope`，`cli.ts` 的 `sync`/`logout` 也补了 `--host`——见
「CLI 指向自建服务」小节）。新增文件（`lib/credentials.ts`、`app/setup/`、`app/api/auth/register|reset-password|
login-options`、`api/admin/users/[userId]/reset-password` 等）不与上游冲突。

**Plan 3（加固）**：`lib/rate-limit.ts`（`RqliteRateLimiter` 共享后端、`getClientIp` 取
XFF 最后一段、IPv6 前缀归并）、`lib/invite.ts` 与 `lib/auth-helpers.ts`（E2E 门改为调用
新增的共享 `lib/e2e-mode.ts`，三处手写副本收敛为单一 `isE2EMode`）。

`packages/worker-read` 的 **`src/` 业务代码与 SQL 零改动**（仅 `WORKER_VERSION` 常量随版本
bump）。`packages/worker` 另有 `secureCompare` 一处改动：长度不等时不再提前 return，而是把
两边零填充到等长再比较（行为等价，纯时序侧信道加固——`worker-read` 与 selfhost 的 d1-http
早就是这种形状）。该改动没有任何黑盒测试能区分，合并冲突时**不能**按「worker 零改动」的
直觉取上游版本，否则会静默丢掉填充。为把
selfhost 适配层纳入编译期类型校验，两个包的 `tsconfig.json`/`package.json` 与新增的
`tsconfig.build.json` 有 composite 声明构建配置（不影响 Cloudflare 部署路径，见
`scripts/parallel-typecheck.sh` 的 selfhost lane）。

```bash
git fetch upstream main
git merge upstream/main
bun run test
cd deploy/selfhost                              # compose 只读 ./.env，不向下搜索
docker compose build && docker compose up -d   # 两个镜像（web + pew-selfhost）都要重建，只 build web 会带着旧的 worker/deploy 代码
curl -s http://127.0.0.1:7020/api/live
# 认证回归：/setup 可达、登录成功、改密后旧会话失效
```

若上游改动触及 `lib/d1.ts` 的构造函数，重新确认 `D1_BASE_URL` 的优先级仍在 `localD1BaseUrl`
之前；若上游改到 `vitest.config.ts` 的 `include`，确认 `deploy/**/*.test.ts` 仍被收集；
若上游改到 `auth.ts` 的 `signIn` 回调或 `admin.ts` 的 `isAdmin`/`resolveAdmin`，重新确认
Credentials 放行分支与库内管理员判定仍在；若上游改到 `packages/worker/src/index.ts` 的
`secureCompare`，重新确认零填充定长比较仍在（测试无法覆盖，见该函数注释）。新增上游迁移后，
重跑 `verify-migrations.ts` 并更新其 `EXPECTED` 计数。

**最近一次回归（2026-10-20）**：`git fetch upstream main` 后 `git rev-list --count HEAD..upstream/main`
= **0**（上游 main 仍停在 v3.3.3 的 `28144795`，已是本分支 `0d46434d` 的父之一），**没有新
`git merge` 需要执行**；本分支领先上游 93 个提交。检查清单逐项复核（读码为证）：
`d1.ts:100` 仍是 `D1_BASE_URL → localD1BaseUrl` 优先、`vitest.config.ts:19` 仍含
`deploy/**/*.test.ts`、`auth.ts:308` Credentials 放行在、`admin.ts` `isAdmin/isAdminInDb/
resolveAdmin/isAdminUser` 齐、`worker/src/index.ts:184-201` secureCompare 零填充定长比较在。

compose 全量回归（`pew-regress` 隔离栈、7021、随机密钥，复用 `deploy/selfhost/docker-compose.yml`
原样副本 + `.env.example` 变体，与运维流程同构）：`docker compose build` **两个镜像都重建**，
`up -d` 六容器就绪，`/api/live` 200；认证回归 4/4——`/setup` 未登录 200；引导管理员注册
200、库非空后二次注册 400；会话 cookie 登录 302 → `/api/usage` 200；管理员签发重置令牌
→ 改密 200 → **旧 cookie 访问 `/api/usage` 立即 401**（pwd_v 失效）、新密码重新登录 200、
旧密码登录得 302 但**会话无权限**（`/api/usage` 401，auth.js 对失败登录也回 302 的既有行为）。
验收后 `down -v` 拆栈、卷与端口 7021 释放。镜像构建命中已知的 virtiofs
`IntegrityCheckFailed` 抖动（宿主直连 sha512 与 lockfile 一致，网络损坏非锁文件损坏），
用验证副本 Dockerfile 的 `bun install --network-concurrency=4` 绕过——**正式 `Dockerfile`
未改动**。

