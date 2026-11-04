import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, buildSecurityHeaders } from "../lib/security-headers";

const header = (headers: Array<{ key: string; value: string }>, key: string) =>
  headers.find((h) => h.key === key)?.value;

describe("security headers", () => {
  it("applies the clickjacking and sniffing headers on every deployment", () => {
    const headers = buildSecurityHeaders({ isHttpsDeployment: false, isDev: false });
    expect(header(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(headers, "X-Frame-Options")).toBe("DENY");
    expect(header(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header(headers, "X-DNS-Prefetch-Control")).toBe("on");
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
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data: https:",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    // Production never enables eval.
    expect(csp).not.toContain("'unsafe-eval'");
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
