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
    // Team logos are user-supplied external URLs (public leaderboard), and
    // Google avatars plus the s.zhe.to image host are external too. Allow
    // https: rather than any scheme; data:/blob: cover inline and object URLs.
    "img-src 'self' blob: data: https:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
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
