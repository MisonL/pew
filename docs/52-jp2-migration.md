# Railway to jp2 Migration

Status: staging preparation on 2026-10-22 (Asia/Shanghai); **not deployed yet**.
The owner authorized staging on jp2, not DNS changes or a Railway shutdown.
Baseline: `6c68c6637e1e72506dcc057c03e3a8643427956a`, Web `3.4.0`.
CLI/core/Workers remain `3.3.3`; this task does not publish npm or synchronize versions.

## Reference and Boundaries

Read Firefly's completed `docs/35-jp2-migration.md`, development guide, handbook,
retrospective, Dockerfile, Compose and CD caller. Reuse its inspected shared
`nocoo/base-ci/.github/workflows/deploy-docker.yml` at
`0394178ebcff0418c442d84a84119220f31f8987`, not a new deployment system.

- Keep Workers, D1, KV, R2, schema, credentials and canonical URLs unchanged.
- Keep Railway running. The owner approved removing only the main deployment
  trigger at 05:24 Beijing time; it has been removed and the original instance
  remains running. Main pushes must not restore the Railway trigger.
- No DNS, Cloudflare TLS/AOP or Railway domain changes during preparation.
- No CLI reset, queue clearing, source-log changes or synthetic production data.
- Validate shared Caddy, then hot reload with `SIGUSR1`. Never restart the proxy
  or alter other sites' routes/TLS policies.
- Railway production application values are authoritative; local `.env` files,
  replacement secrets and test identities are not substitutes.

## Read-Only Preflight

Observed at approximately `2026-10-21T20:21Z`:

| Item | Evidence |
| --- | --- |
| jp2 capacity | 2 CPUs, 15.56 GiB RAM, approximately 13 GiB available, 45 GiB root disk free |
| Load | 0.26 / 0.21 / 0.18; instantaneous evidence, not a load test |
| Docker / Compose | 29.7.2 / v5.5.0; external `edge` network |
| Containers | Nine running, no recorded restart/OOM; Firefly healthy at about 344 MiB |
| Proxy | `proxy-caddy`, started `2026-10-21T05:50:17.30329842Z`; file-backed `caddy run`, no `--resume`, admin API off |
| Caddy files | `/opt/proxy/Caddyfile` bind-mounted read-only; `/opt/proxy/certs` |
| Pew target | No `/opt/pew` or Pew container; host ports 7020/17020 not listening |
| Public application | `/api/live`: 200/no-store, 3.4.0, D1 connected, Railway response headers |
| DNS | Proxied apex CNAME -> `ry32rpn0.up.railway.app`, TTL auto |
| Cloudflare TLS | `ssl=full`, `tls_client_auth=off` |
| Origin TLS | Existing SANs cover hexly.ai, nocoo.cloud, tongji.net and lizheng.blog families, **not pew.md** |
| Railway API | CLI login expired; current deployment, trigger and variables could not be reverified |

The valid public edge certificate does not prove origin TLS. The owner approved
a dedicated `pew.md` Origin CA certificate at 05:24 Beijing time. It is installed
on jp2; the private key was generated there and remains root-owned, mode 0600.

## Planned Deployment

Target: `ghcr.io/nocoo/pew`, environment `pew / production`, directory `/opt/pew`,
Compose service `web`, container `pew-app`, one Node process on 7020. Stage on
`127.0.0.1:17020`, attach `edge`, proxy to `pew-app:7020` and add
`X-Pew-Origin: jp2` only on the Pew Caddy route. Railway's verified memory ceiling
is 8,000,000,000 bytes; no `NODE_OPTIONS` is configured. Preserve that ceiling
rather than imposing an unverified 1 GiB cap.

Remaining implementation:

1. Railway authentication, before-images and approved trigger removal are complete.
2. Add the pinned Firefly CD caller after successful same-repository main push
   CI. Preserve existing quality/API/browser lanes and all hooks; add a clean
   Linux container lane. Use caller-visible deployment controls separately from
   environment-scoped SSH/GHCR secrets, with explicit `precutover` verification.
3. Add single-service Compose, loopback-only staging port, verified memory limit,
   health check and bounded logs. Preserve non-root writable caches and Sharp.
4. Transfer application variables unchanged through SSH into private
   `.env.runtime` using raw Compose env-file semantics. Inspect references before
   omitting platform `RAILWAY_*` values. Fail on sealed values or values the format
   cannot represent losslessly. Compare source, file and running container in
   memory; output only aggregate equality, never values, cookies or secret hashes.
5. Push through normal hooks from an env-free task clone. Record main CI/CD URLs,
   tested source SHA, GHCR digest and `.base-ci-releases/<SHA>.json`.
6. After certificate approval, validate the candidate Caddy configuration. Compare
   the starting config before writing to avoid overwriting concurrent work. Keep
   the active bind-mounted file's inode (rename can leave the container reading
   the old file), signal `SIGUSR1`, inspect loaded routes, unchanged proxy start
   time and other sites' normal responses/redirects. No proxy restart.
7. Complete direct-origin acceptance and rollback receipts, then stop for approval.

Unlike Firefly, Pew's typed `DbRead` calls the read Worker but `DbWrite` still
uses D1 REST. Runtime `CF_D1_API_TOKEN` remains required. Preserve
`NEXTAUTH_URL=https://pew.md`, Auth.js/Google values, Worker URLs/secrets and R2
values. Require production mode with no `E2E_*` bypass variables. Accounting
uploads allow 24 MiB; do not introduce a smaller shared-proxy request limit.

The shared workflow proves successful main CI, rechecks source and deploys by
digest. Verification failure does **not** automatically roll back. Capture the
previous digest before replacement; missing success receipts do not prove the
container stayed unchanged. Never restore using `latest` or a rebuild.

## Container Slice Evidence

Commit `9bd9fc8e` removes six credential build ARG/ENV pairs, restricts build
context and preserves SWC/static/public packaging. The final image runs as UID
1000 and verifies native Sharp with an actual PNG operation.

- Three new contract tests failed on the original files and passed after the fix.
- Normal staged-tree pre-commit passed 4,421 tests in 279 files. Coverage:
  98.15 / 95.38 / 98.39 / 99.09 (statements/branches/functions/lines). Strict types,
  Biome zero errors/warnings and both AST gates passed. Five existing Biome
  informational suggestions remain; these are not warnings.
- A clean source-only Linux amd64 image built without application variables or
  database credentials. Local installation used the approved Tencent mirror in
  a temporary Dockerfile; the tracked installer is unchanged. This is not an
  exact canonical-Dockerfile CI receipt.
- With `--network none`, the bare image proved UID 1000, production mode, version
  3.4.0, both public PNGs and writable Next cache. `/api/live` returned 503/no-store,
  database disconnected as required without runtime configuration. The baked
  environment contains no application secrets or test flags.
- Local image ID:
  `sha256:69c7f8ad25101b981abe635f937a0eda95a012144059b6b3b2fda458df9409f2`.
  This is neither a GHCR deployment digest nor a rollback image.

## Direct-Origin Acceptance

All production-origin checks remain pending. An old Railway response or a
configured callback URL does not count as new-origin acceptance.

- [ ] Container reference, resolved image ID, OCI revision and Web version match
      the tested source and release manifest.
- [ ] Direct jp2 `/api/live` proves no-store, D1 connectivity, version and origin
      marker without redirecting to Railway.
- [ ] Canonical hostname/TLS/Caddy forwarding are checked through isolated client
      routing, without DNS changes or weakening public client authentication.
- [ ] Public leaderboard/profile/assets/images and authenticated reads succeed;
      unauthorized read/write requests return the expected denial.
- [ ] Fresh real Google OAuth completes on jp2, including its callback, and
      existing sessions survive; not just a browser following Railway's callback.
- [ ] Device/CLI login and bearer uploads reach jp2 and the unchanged ingest
      Worker. Use an authorized real pending payload, not synthetic production
      records. Preserve cursor/queue bytes. Empty/malformed-body rejection is
      not a successful upload acknowledgment.
- [ ] Isolated regressions preserve token/session/evidence/accounting routes and
      the 24 MiB accounting body limit.
- [ ] Runtime values equal Railway, no test flags or leaked credentials, other
      Caddy sites unchanged and proxy start time unchanged.

## Proposed Cutover and Rollback

**Owner approval required. No record has been changed.**

| Field | Before | Proposed |
| --- | --- | --- |
| Record ID | `4302e3370f3de070a1a164c2a78972c4` | Same record |
| Name / type | `pew.md` / CNAME | Unchanged |
| Target | `ry32rpn0.up.railway.app` | `jp2.nocoo.cloud` |
| Proxy / TTL | Proxied / auto | Unchanged |

Leave MX/SPF/DKIM/DMARC and both `_railway-verify` TXT records unchanged. For
Firefly-style TLS, propose `ssl=strict` and `tls_client_auth=on` after verifying
the dedicated certificate and shared origin-pull CA. The custom-certificate
zone-level AOP toggle is different; do not substitute it for the shared setting.

Before cutover approval, capture fresh private before-images of this DNS record,
TLS/AOP, Caddy, Railway deployment/image, runtime equality and accepted
current/previous jp2 digests. Reconcile staging caches, define a bounded write
pause and which origin accepts writes. Railway stays running throughout this
pre-cutover task; any later shutdown requires separate authorization.

After an approved switch, verify the public jp2 marker, version/digest, D1,
login/session/device flows, real CLI acknowledgment, images and existing
monitoring. Only then change CD verification to the canonical production target.

Rollback of staging affects only Pew's new container/Caddy block; Railway remains
the production path. An approved image rollback uses an accepted previous digest
with the same runtime values and a cold start, preserving required Compose image
interpolation. An approved routing rollback restores only the apex target and,
where necessary, captured TLS settings (`full`, shared AOP off at this checkpoint).
Verify the retained Railway deployment before routing traffic back. Isolate the
failed jp2 write origin; do not restart shared Caddy or restore unrelated backup
routes. Routing/image rollback does not undo database writes; no schema changes
are part of this migration.

No previous jp2 Pew digest exists: this would be its first deployment. The Railway
rollback deployment is `1f593cdc-398c-473f-a78c-9d934b019bf2`, source
`6c68c6637e1e72506dcc057c03e3a8643427956a`, image digest
`sha256:33ad82409ec299399ea54b3b13ce062d86b596303171aef800be9daf9b9c416d`.
Its original instance `c43d9a3e-c28d-404b-8c66-00a73dbab99a` is still RUNNING,
with `deploymentStopped=false` and both restore capability flags true.

## Authorized Staging Preparation

The 05:24 Beijing approval permits removing only the verified main trigger and
issuing/installing a certificate covering only `pew.md`. DNS, Cloudflare TLS/AOP
settings and Railway shutdown remain separate hard stops.

- Removed trigger `1266b86e-07d4-4267-8f79-6179a58fe20a`. Re-query proved identical
  active deployment/instance state and unchanged repository source. No restart,
  redeploy, domain detach or service stop was requested.
- Stored Railway rollback metadata at `/opt/pew/railway-rollback.json`; DNS,
  SSL/AOP, Caddy and certificate receipts are in `/opt/pew/precutover-20261022/`.
  The deployment directory and runtime file are private (0700/0600).
- All 17 application values were transferred from Railway and compared equal
  against `/opt/pew/.env.runtime`, without printing values. The 11 platform-managed
  `RAILWAY_*` values were not copied. There are no E2E flags. Equality against
  the running container is still pending until deployment.
- Certificate SAN is exactly `pew.md`, valid until 2041-10-17. Public certificate
  and private key are `/opt/proxy/certs/pew-origin.pem` and `pew-origin.key`;
  matching public keys were verified without exporting the private key.
- Configured `pew / production` deployment credentials and repository controls
  `DEPLOY_PHASE=precutover`, `DEPLOY_URL=https://pew.md`, `DEPLOY_ORIGIN_MARKER=jp2`.

`deploy/Caddyfile.staging` proposes two distinct listeners: the public 443 Pew
host only denies requests; the actual staging route uses container-internal TLS
port 17443, which must not be published to the host. An SSH forward targets the
verified Caddy edge IP and that internal port. Do not use Docker gateway-IP
allowlisting: userland-proxy can collapse externally arriving source addresses.
Before claiming privacy, verify loaded routes, Docker port mappings, host
listeners and external denial; these checks remain pending until the candidate
is applied. Origin CA validates the certificate for explicitly trusting test
clients; no local trust-store changes are required. This is not production
Cloudflare ingress or AOP proof. At a separately approved cutover, replace the
public denial with Firefly's shared-CA client authentication and application
upstream, remove the private listener and coordinate zone TLS/AOP settings.

At this preparation checkpoint there is still no GHCR image or running jp2 Pew
container. Certificate installation and runtime-file transfer do not prove
deployment or authenticated acceptance. DNS, TLS/AOP, the running Railway
deployment, existing proxy routes and real CLI state remain unchanged.
