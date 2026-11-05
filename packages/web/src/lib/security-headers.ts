/**
 * Response security headers for the Next.js app, built as a pure function so
 * `next.config.ts` can stay thin and the policy is unit-testable.
 *
 * Kept dependency-free: it runs inside the Next config loader (build time),
 * never in the browser or the Worker runtime.
 */

export interface SecurityHeaderOptions {
  /**
   * Whether the deployment is served over HTTPS. Mirrors
   * `shouldUseSecureCookies()` (src/auth.ts): the same decision that picks
   * `__Secure-` cookies decides whether to claim HTTPS-only transport. On a
   * plain-http intranet deployment HSTS and `upgrade-insecure-requests` are
   * both wrong — the browser would ignore the former and rewrite same-site
   * requests to https for the latter, breaking the app.
   */
  isHttpsDeployment: boolean;
  /** Development adds `'unsafe-eval'` (React's dev-mode eval) and HMR sockets. */
  isDev: boolean;
}

/** The env vars that decide transport security. Passed in, not read, so both
 * build-time (next.config) and runtime (auth.ts) callers share one rule. */
export interface DeploymentEnv {
  NODE_ENV?: string;
  USE_SECURE_COOKIES?: string;
  NEXTAUTH_URL?: string;
}

/**
 * The single source of truth for "does this deployment claim HTTPS transport?".
 *
 * `shouldUseSecureCookies()` (src/auth.ts) evaluates this at runtime and
 * `next.config.ts` evaluates it at build time (the result is baked into
 * routes-manifest.json), so a divergence would ship HSTS to an http host or
 * drop it from an https one. Both call this function with their own env.
 */
export function resolveDeploymentSecurity(env: DeploymentEnv): SecurityHeaderOptions {
  // Explicit opt-out wins: intranet http deployments cannot use __Secure-
  // prefixed cookies (the browser drops them), and the image always runs with
  // NODE_ENV=production, so the opt-out must be consulted before the
  // production branch.
  const isHttpsDeployment =
    env.USE_SECURE_COOKIES !== "false" &&
    (env.NODE_ENV === "production" ||
      env.NEXTAUTH_URL?.startsWith("https://") === true ||
      env.USE_SECURE_COOKIES === "true");
  return { isHttpsDeployment, isDev: env.NODE_ENV === "development" };
}

/**
 * Content-Security-Policy.
 *
 * Nonces are not viable for this app: the anti-FOUC inline script in
 * `app/layout.tsx` and the inline `style` attributes the dashboard and charts
 * set both need `'unsafe-inline'`, and a per-request nonce would force every
 * page to render dynamically — defeating the static caching the leaderboard
 * relies on. So `script-src`/`style-src` keep `'unsafe-inline'` and the value
 * comes from the remaining directives: `object-src 'none'`, `base-uri`,
 * `form-action`, `frame-ancestors`, and the origin allowlists, which still
 * close the common injection and exfiltration paths.
 */
export function buildContentSecurityPolicy(opts: SecurityHeaderOptions): string {
  const { isHttpsDeployment, isDev } = opts;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Only the hosts the app actually renders from. Team/organization logos
    // are upload-only — putTeamLogo/putOrgLogo build the URL from the R2 prefix
    // and no route accepts a caller-supplied logo URL — and user avatars come
    // from the Google provider alone (Credentials users have none). A blanket
    // `https:` would leave an image-pixel exfiltration channel that
    // connect-src cannot close.
    "img-src 'self' data: blob: https://s.zhe.to https://lh3.googleusercontent.com",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    // Nothing in the app embeds a frame, spawns a worker or plays media; pin
    // that down so a future dependency cannot introduce one unnoticed.
    "frame-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only claim HTTPS transport where HSTS is also sent (see the option doc).
    ...(isHttpsDeployment ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** The full security-header set applied to every response. */
export function buildSecurityHeaders(
  opts: SecurityHeaderOptions,
): Array<{ key: string; value: string }> {
  const { isHttpsDeployment } = opts;
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ...(isHttpsDeployment
      ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
      : []),
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    { key: "X-DNS-Prefetch-Control", value: "on" },
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(opts) },
  ];
}
