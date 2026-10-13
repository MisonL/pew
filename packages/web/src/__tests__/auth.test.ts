import { describe, it, expect, vi, afterEach } from "vitest";

// Mock heavy next-auth dependencies to avoid runtime errors
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock("next-auth/providers/google", () => ({ default: {} }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@/lib/auth-adapter", () => ({
  D1AuthAdapter: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
}));
vi.mock("@/lib/invite", () => ({
  handleInviteGate: vi.fn(() => true),
}));
vi.mock("@/lib/credentials", () => ({
  findCredentialUser: vi.fn(),
  verifyPassword: vi.fn(),
  verifyPasswordDummy: vi.fn(),
  passwordVersion: vi.fn(),
}));

import {
  shouldUseSecureCookies,
  jwtCallback,
  sessionCallback,
  authorizeCredentials,
  LOGIN_RATE_LIMIT,
} from "@/auth";
import { inMemoryRateLimiter } from "@/lib/rate-limit";
import { findCredentialUser, verifyPassword } from "@/lib/credentials";
import type { JWT } from "next-auth/jwt";
import type { Session, User } from "next-auth";

const mockFindCredentialUser = findCredentialUser as unknown as ReturnType<typeof vi.fn>;
const mockVerifyPassword = verifyPassword as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// shouldUseSecureCookies
// ---------------------------------------------------------------------------

describe("shouldUseSecureCookies", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return true when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("should return true when NEXTAUTH_URL starts with https", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXTAUTH_URL", "https://pew.example.com");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("should return true when USE_SECURE_COOKIES is true", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("USE_SECURE_COOKIES", "true");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("should return false when none of the conditions are met", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.NEXTAUTH_URL;
    delete process.env.USE_SECURE_COOKIES;
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("should return false when NEXTAUTH_URL is http", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:7020");
    delete process.env.USE_SECURE_COOKIES;
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("disables secure cookies when USE_SECURE_COOKIES is explicitly false, even in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("USE_SECURE_COOKIES", "false");
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("still forces secure cookies in production by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.USE_SECURE_COOKIES;
    expect(shouldUseSecureCookies()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// authorizeCredentials
// ---------------------------------------------------------------------------

describe("authorizeCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    inMemoryRateLimiter.reset();
  });

  it("returns null for missing email or password", async () => {
    expect(await authorizeCredentials({ email: "", password: "x" })).toBeNull();
    expect(await authorizeCredentials({ email: "a@b.c", password: "" })).toBeNull();
    expect(await authorizeCredentials({})).toBeNull();
    expect(mockFindCredentialUser).not.toHaveBeenCalled();
  });

  it("returns the user on a correct password", async () => {
    mockFindCredentialUser.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.c",
      name: "A",
      password_hash: "scrypt$32768$8$1$AAAA$BBBBCCCC",
      is_public: 1,
      is_admin: 0,
    });
    mockVerifyPassword.mockResolvedValueOnce(true);
    expect(await authorizeCredentials({ email: "A@B.C", password: "pw" })).toEqual({
      id: "u1",
      email: "a@b.c",
      name: "A",
      pwd_v: "BBBBCCCC",
    });
  });

  it("returns null on a wrong password", async () => {
    mockFindCredentialUser.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.c",
      name: "A",
      password_hash: "scrypt$...",
      is_public: 1,
      is_admin: 0,
    });
    mockVerifyPassword.mockResolvedValueOnce(false);
    expect(await authorizeCredentials({ email: "a@b.c", password: "wrong" })).toBeNull();
  });

  it("runs a dummy verify for an unknown user (no timing leak)", async () => {
    mockFindCredentialUser.mockResolvedValueOnce(null);
    const { verifyPasswordDummy } = await import("@/lib/credentials");
    expect(await authorizeCredentials({ email: "nobody@x.y", password: "pw" })).toBeNull();
    expect(verifyPasswordDummy).toHaveBeenCalledWith("pw");
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it("returns null once the per-key rate limit is exceeded", async () => {
    mockFindCredentialUser.mockResolvedValue({
      id: "u1",
      email: "a@b.c",
      name: "A",
      password_hash: "scrypt$...",
      is_public: 1,
      is_admin: 0,
    });
    mockVerifyPassword.mockResolvedValue(true);
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxRequests; i++) {
      expect(await authorizeCredentials({ email: "a@b.c", password: "pw", rateKey: "ip:1" })).not.toBeNull();
    }
    expect(await authorizeCredentials({ email: "a@b.c", password: "pw", rateKey: "ip:1" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// login limiter backend switch
// ---------------------------------------------------------------------------

describe("login limiter backend switch", () => {
  afterEach(() => {
    delete process.env.LOGIN_RATE_LIMIT_BACKEND;
    vi.restoreAllMocks();
    inMemoryRateLimiter.reset();
  });

  it("uses the rqlite backend with dual keys when LOGIN_RATE_LIMIT_BACKEND=rqlite", async () => {
    process.env.LOGIN_RATE_LIMIT_BACKEND = "rqlite";
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const spy = vi.spyOn(rqliteRateLimiter, "check").mockResolvedValue({ allowed: true, current: 1, limit: 5, retryAfter: 0 });
    mockFindCredentialUser.mockResolvedValue(null);
    await authorizeCredentials({ email: "a@b.c", password: "x", ip: "203.0.113.9" });
    const keys = spy.mock.calls.map((c) => c[0]);
    expect(keys).toContain("login:email:a@b.c");
    expect(keys).toContain("login:ip:203.0.113.9");
  });

  it("keeps the in-memory per-email limiter by default", async () => {
    delete process.env.LOGIN_RATE_LIMIT_BACKEND;
    const { rqliteRateLimiter } = await import("@/lib/rate-limit");
    const spy = vi.spyOn(rqliteRateLimiter, "check");
    await authorizeCredentials({ email: "default@b.c", password: "x" });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jwtCallback
// ---------------------------------------------------------------------------

describe("jwtCallback", () => {
  it("should persist user.id into token.userId", () => {
    const token = { sub: "abc" } as JWT;
    const result = jwtCallback({ token, user: { id: "user-123" } });
    expect(result.userId).toBe("user-123");
  });

  it("should not overwrite existing token when no user", () => {
    const token = { sub: "abc", userId: "existing" } as JWT;
    const result = jwtCallback({ token });
    expect(result.userId).toBe("existing");
  });

  it("should not set userId when user has no id", () => {
    const token = { sub: "abc" } as JWT;
    const result = jwtCallback({ token, user: {} });
    expect(result.userId).toBeUndefined();
  });

  it("carries pwd_v from the credentials authorize result", () => {
    const token = {} as JWT;
    const result = jwtCallback({
      token,
      user: { id: "u1", pwd_v: "VERSION1" } as unknown as User,
    });
    expect(result.pwd_v).toBe("VERSION1");
  });
});

// ---------------------------------------------------------------------------
// sessionCallback
// ---------------------------------------------------------------------------

describe("sessionCallback", () => {
  it("should expose token.userId in session.user.id", async () => {
    const session = { user: { id: "", name: "Alice" }, expires: "2026-12-31" } as Session;
    const token = { userId: "user-123" } as JWT;
    const result = await sessionCallback({ session, token });
    expect(result?.user?.id).toBe("user-123");
  });

  it("should not modify session when token has no userId", async () => {
    const session = { user: { id: "old", name: "Bob" }, expires: "2026-12-31" } as Session;
    const token = {} as JWT;
    const result = await sessionCallback({ session, token });
    expect(result?.user?.id).toBe("old");
  });

  it("should not crash when session.user is undefined", async () => {
    const session = { expires: "2026-12-31" } as Session;
    const token = { userId: "user-123" } as JWT;
    const result = await sessionCallback({ session, token });
    expect(result?.user).toBeUndefined();
  });

  it("invalidates the session when the password version changed", async () => {
    const session = { user: { id: "", name: "A" }, expires: "2026-12-31" } as Session;
    const token = { userId: "u1", pwd_v: "OLDOLDOL" } as JWT;
    const { passwordVersion } = await import("@/lib/credentials");
    vi.mocked(passwordVersion).mockResolvedValueOnce("NEWNEWNE");
    const result = await sessionCallback({ session, token });
    // Auth.js forbids returning null; dropping the user id makes resolveUser
    // treat the session as unauthenticated.
    expect(result?.user?.id).toBe("");
  });

  it("keeps the session when the password version matches", async () => {
    const session = { user: { id: "", name: "A" }, expires: "2026-12-31" } as Session;
    const token = { userId: "u1", pwd_v: "SAMESAME" } as JWT;
    const { passwordVersion } = await import("@/lib/credentials");
    vi.mocked(passwordVersion).mockResolvedValueOnce("SAMESAME");
    const result = await sessionCallback({ session, token });
    expect(result?.user?.id).toBe("u1");
  });

  it("does not version-check OAuth tokens (no pwd_v)", async () => {
    const session = { user: { id: "", name: "A" }, expires: "2026-12-31" } as Session;
    const token = { userId: "u1" } as JWT;
    const { passwordVersion } = await import("@/lib/credentials");
    vi.mocked(passwordVersion).mockClear();
    const result = await sessionCallback({ session, token });
    expect(result?.user?.id).toBe("u1");
    expect(passwordVersion).not.toHaveBeenCalled();
  });
});
