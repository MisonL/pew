import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  resolveDeploymentSecurity,
} from "../lib/security-headers";

const header = (headers: Array<{ key: string; value: string }>, key: string) =>
  headers.find((h) => h.key === key)?.value;

describe("security headers", () => {
  it("applies the clickjacking and sniffing headers on every deployment", () => {
    const headers = buildSecurityHeaders({ isHttpsDeployment: false, isDev: false });
    expect(header(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(headers, "X-Frame-Options")).toBe("DENY");
    expect(header(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header(headers, "X-DNS-Prefetch-Control")).toBe("on");
    expect(header(headers, "Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("omits HSTS and upgrade-insecure-requests on a plain-http deployment", () => {
    // An intranet http host must not claim HTTPS: HSTS would be ignored and
    // upgrade-insecure-requests would rewrite same-site subresources to https.
    const headers = buildSecurityHeaders({ isHttpsDeployment: false, isDev: false });
    expect(header(headers, "Strict-Transport-Security")).toBeUndefined();
    const csp = header(headers, "Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("sends HSTS and upgrade-insecure-requests on an HTTPS deployment", () => {
    const headers = buildSecurityHeaders({ isHttpsDeployment: true, isDev: false });
    expect(header(headers, "Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(header(headers, "Content-Security-Policy")).toContain("upgrade-insecure-requests");
  });

  it("locks down object, base-uri, form-action and framing", () => {
    const csp = buildContentSecurityPolicy({ isHttpsDeployment: false, isDev: false });
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "media-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    // Production never enables eval.
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("allows only the image hosts the app actually renders from", () => {
    // Team and organization logos are upload-only: putTeamLogo/putOrgLogo build
    // the URL here from the R2 prefix, and no route accepts a caller-supplied
    // logo URL. User avatars come from the Google provider only (Credentials
    // has none). A blanket `https:` would leave an image-pixel exfiltration
    // channel that connect-src cannot close.
    const csp = buildContentSecurityPolicy({ isHttpsDeployment: false, isDev: false });
    expect(csp).toContain(
      "img-src 'self' data: blob: https://s.zhe.to https://lh3.googleusercontent.com",
    );
    expect(csp).not.toMatch(/img-src[^;]*\shttps:\s*(;|$)/);
  });

  it("enables eval and HMR sockets only in development", () => {
    const csp = buildContentSecurityPolicy({ isHttpsDeployment: false, isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
  });

  it("emits exactly one Content-Security-Policy header", () => {
    const headers = buildSecurityHeaders({ isHttpsDeployment: true, isDev: false });
    expect(headers.filter((h) => h.key === "Content-Security-Policy")).toHaveLength(1);
  });
});

describe("resolveDeploymentSecurity", () => {
  // The cookie decision and the HSTS decision are the same question: does this
  // deployment claim HTTPS transport? Both auth.ts (runtime) and next.config
  // (build time, baked into routes-manifest) must answer identically or a build
  // memo ships HSTS/upgrade-insecure-requests to an http host.
  const cases: Array<[string, Record<string, string | undefined>, boolean, boolean]> = [
    ["production without an explicit opt-out claims HTTPS", { NODE_ENV: "production" }, true, false],
    ["USE_SECURE_COOKIES=false opts an http intranet deployment out", { NODE_ENV: "production", USE_SECURE_COOKIES: "false" }, false, false],
    ["USE_SECURE_COOKIES=true claims HTTPS even in development", { NODE_ENV: "development", USE_SECURE_COOKIES: "true" }, true, true],
    ["an https NEXTAUTH_URL claims HTTPS outside production", { NODE_ENV: "development", NEXTAUTH_URL: "https://pew.example.com" }, true, true],
    ["a plain-http NEXTAUTH_URL does not claim HTTPS outside production", { NODE_ENV: "development", NEXTAUTH_URL: "http://172.16.81.4:7020" }, false, true],
    ["development is flagged as dev for eval and HMR sockets", { NODE_ENV: "development" }, false, true],
    ["production is not flagged as dev", { NODE_ENV: "production" }, true, false],
  ];

  it.each(cases)("%s", (_label, env, isHttpsDeployment, isDev) => {
    expect(resolveDeploymentSecurity(env)).toEqual({ isHttpsDeployment, isDev });
  });

  it("treats an explicit false as winning over production", () => {
    // The image always runs with NODE_ENV=production, so a check that consults
    // the production branch first would make the opt-out unreachable.
    expect(resolveDeploymentSecurity({ NODE_ENV: "production", USE_SECURE_COOKIES: "false" }).isHttpsDeployment).toBe(false);
  });
});
