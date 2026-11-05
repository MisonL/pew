import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/auth to avoid pulling in next-auth runtime
vi.mock("@/auth", () => ({
  auth: vi.fn((handler: unknown) => handler),
}));

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Helper: create a minimal NextRequest
// ---------------------------------------------------------------------------

function makeReq(
  pathname: string,
  headers: Record<string, string> = {},
): NextRequest {
  const url = `https://pew.example.com${pathname}`;
  return new NextRequest(url, { headers });
}

// ---------------------------------------------------------------------------
// Helper: re-import proxy module with fresh NEXTAUTH_URL
// ---------------------------------------------------------------------------

async function importProxy(nextauthUrl?: string) {
  vi.resetModules();

  if (nextauthUrl !== undefined) {
    vi.stubEnv("NEXTAUTH_URL", nextauthUrl);
  } else {
    delete process.env.NEXTAUTH_URL;
  }

  return import("@/proxy");
}

// ---------------------------------------------------------------------------
// buildRedirectUrl
// ---------------------------------------------------------------------------

describe("buildRedirectUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("should use origin when no forwarded headers", async () => {
    const { buildRedirectUrl } = await importProxy("https://pew.example.com");
    const req = makeReq("/dashboard");
    const url = buildRedirectUrl(req, "/login");
    expect(url.pathname).toBe("/login");
    expect(url.origin).toBe("https://pew.example.com");
  });

  it("should use trusted host with pinned proto when forwarded host matches NEXTAUTH_URL", async () => {
    const { buildRedirectUrl } = await importProxy("https://proxy.example.com");
    const req = makeReq("/dashboard", {
      "x-forwarded-host": "proxy.example.com",
      "x-forwarded-proto": "http", // attacker tries to downgrade — should be ignored
    });
    const url = buildRedirectUrl(req, "/login");
    // Protocol pinned to https (from NEXTAUTH_URL), NOT http from header
    expect(url.href).toBe("https://proxy.example.com/login");
  });

  it("should use pinned origin when forwarded host does not match NEXTAUTH_URL", async () => {
    const { buildRedirectUrl } = await importProxy("https://legit.example.com");
    const req = makeReq("/dashboard", {
      "x-forwarded-host": "evil.example.com",
    });
    const url = buildRedirectUrl(req, "/login");
    // Always uses pinned origin when NEXTAUTH_URL is configured (CWE-601)
    expect(url.origin).toBe("https://legit.example.com");
  });

  it("should ignore forwarded host when NEXTAUTH_URL is not set", async () => {
    const { buildRedirectUrl } = await importProxy();
    const req = makeReq("/dashboard", {
      "x-forwarded-host": "proxy.example.com",
    });
    const url = buildRedirectUrl(req, "/");
    // Falls back to request origin
    expect(url.origin).toBe("https://pew.example.com");
  });

  it("should default protocol to https when NEXTAUTH_URL is not set", async () => {
    // Ensures trustedProto fallback is "https" (not from any header)
    const { buildRedirectUrl } = await importProxy();
    const req = makeReq("/dashboard");
    const url = buildRedirectUrl(req, "/login");
    expect(url.protocol).toBe("https:");
  });

  it("should pin protocol from NEXTAUTH_URL even when X-Forwarded-Proto differs", async () => {
    const { buildRedirectUrl } = await importProxy("http://localhost:3000");
    const req = makeReq("/dashboard", {
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "https",
    });
    const url = buildRedirectUrl(req, "/login");
    // Protocol pinned to http (from NEXTAUTH_URL), NOT https from header
    expect(url.href).toBe("http://localhost:3000/login");
  });
});

// ---------------------------------------------------------------------------
// isPublicRoute — import once (no env dependency)
// ---------------------------------------------------------------------------

const { isPublicRoute, resolveProxyAction } = await importProxy();

describe("isPublicRoute", () => {
  it.each([
    "/api/auth/callback/google",
    "/api/auth/signin",
    "/api/ingest",
    "/api/ingest/batch",
    "/api/users/john",
    "/api/leaderboard",
    "/api/leaderboard?period=week",
    "/u/john",
    "/",
    "/setup",
  ])("should return true for public route: %s", (path) => {
    expect(isPublicRoute(path)).toBe(true);
  });

  it.each([
    "/dashboard",
    "/settings",
    "/login",
    "/api/usage",
    "/leaderboard",
    "/leaderboard/seasons",
    "/leaderboard/seasons/2026-spring",
    "/leaderboard/models",
  ])("should return false for protected route: %s", (path) => {
    expect(isPublicRoute(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveProxyAction
// ---------------------------------------------------------------------------

describe("resolveProxyAction", () => {
  it("should return 'next' when skipAuth is true", () => {
    expect(resolveProxyAction("/dashboard", false, true)).toBe("next");
  });

  it("should return 'next' for public routes", () => {
    expect(resolveProxyAction("/api/auth/signin", false, false)).toBe("next");
    expect(resolveProxyAction("/api/ingest", false, false)).toBe("next");
    expect(resolveProxyAction("/u/john", false, false)).toBe("next");
  });

  it("should redirect logged-in user away from login page to dashboard", () => {
    expect(resolveProxyAction("/login", true, false)).toBe("redirect:/dashboard");
  });

  it("should redirect unauthenticated user to login", () => {
    expect(resolveProxyAction("/dashboard", false, false)).toBe(
      "redirect:/login",
    );
  });

  it("should redirect unauthenticated user away from /leaderboard to login", () => {
    expect(resolveProxyAction("/leaderboard", false, false)).toBe(
      "redirect:/login",
    );
  });

  it("should allow logged-in user on /leaderboard", () => {
    expect(resolveProxyAction("/leaderboard", true, false)).toBe("next");
  });

  it("should allow unauthenticated user on /u/<slug> (public profile gated by is_public in API)", () => {
    expect(resolveProxyAction("/u/john", false, false)).toBe("next");
  });

  it("should allow unauthenticated user on landing page (/)", () => {
    expect(resolveProxyAction("/", false, false)).toBe("next");
  });

  it("should return 'next' for logged-in user on protected page", () => {
    expect(resolveProxyAction("/dashboard", true, false)).toBe("next");
  });

  it("should return 'next' for unauthenticated user on login page", () => {
    expect(resolveProxyAction("/login", false, false)).toBe("next");
  });
});

// ---------------------------------------------------------------------------
// CSRF cookies vs shared caching
// ---------------------------------------------------------------------------
//
// NextAuth writes a fresh authjs.csrf-token on every request that runs the
// auth wrapper, while these pages are prerendered with Cache-Control:
// s-maxage (a shared-cache directive). Behind a proxy_cache/CDN the pair would
// be replayed to every visitor, so two invariants must hold:
//   1. pages whose proxy action never depends on auth state do not run it
//   2. any response that does carry Set-Cookie is not shared-cacheable

describe("public pages and CSRF cookies", () => {
  it("skips the auth wrapper for pages whose action never depends on auth state", async () => {
    const proxy = await importProxy("https://pew.example.com");
    const { auth } = await import("@/auth");
    const authMock = auth as unknown as ReturnType<typeof vi.fn>;
    authMock.mockClear();

    for (const path of ["/", "/privacy", "/setup"]) {
      const res = (await proxy.proxy(makeReq(path))) as Response;
      expect(res.status, path).toBe(200);
    }
    expect(authMock).not.toHaveBeenCalled();
  });

  it("marks a response that sets cookies as uncacheable by shared caches", async () => {
    const proxy = await importProxy("https://pew.example.com");
    const { auth } = await import("@/auth");
    (auth as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (handler: (req: unknown) => Response) => (req: unknown) => {
        const res = handler(req) as Response;
        res.headers.append("set-cookie", "authjs.csrf-token=token%7Chash; Path=/; HttpOnly");
        return res;
      },
    );

    const res = (await proxy.proxy(makeReq("/login"))) as Response;
    expect(res.headers.get("set-cookie")).toContain("authjs.csrf-token");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("leaves the caching headers of a cookie-free response alone", async () => {
    const proxy = await importProxy("https://pew.example.com");
    const res = (await proxy.proxy(makeReq("/dashboard"))) as Response;
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
