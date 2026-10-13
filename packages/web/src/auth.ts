/**
 * Auth.js v5 configuration for pew.
 *
 * JWT session strategy (no session table). Sign-in is email + password
 * (Credentials, always available) plus Google OAuth when configured — a
 * self-hosted intranet box normally has only the former, because Google
 * rejects plain-http callback URLs.
 * User data stored in D1 via custom adapter (Cloudflare, or a self-hosted
 * d1-http service over rqlite — see deploy/selfhost).
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { D1AuthAdapter } from "@/lib/auth-adapter";
import { getDbRead, getDbWrite } from "@/lib/db";
import { handleInviteGate } from "@/lib/invite";
import { findCredentialUser, verifyPassword, verifyPasswordDummy, passwordVersion } from "@/lib/credentials";
import {
  getClientIp,
  inMemoryRateLimiter,
  ipv6PrefixKey,
  type RateLimitConfig,
} from "@/lib/rate-limit";
import type { JWT } from "next-auth/jwt";
import type { Session, User } from "next-auth";

/**
 * Login brute-force guard: 10 attempts / 60s. The default in-memory limiter
 * keys per-email only (single web replica; spec §4.4 known limitation); set
 * LOGIN_RATE_LIMIT_BACKEND=rqlite for dual-key (email + IP) limiting shared
 * across replicas.
 */
export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowSeconds: 60,
};

// ---------------------------------------------------------------------------
// Exported helpers (testable without next-auth runtime)
// ---------------------------------------------------------------------------

/** Determine whether to use __Secure- prefixed cookies. */
export function shouldUseSecureCookies(): boolean {
  // Explicit opt-out wins: intranet http deployments cannot use __Secure-
  // prefixed cookies (the browser drops them), and the image always runs with
  // NODE_ENV=production, so the opt-out must be checked before the prod branch.
  if (process.env.USE_SECURE_COOKIES === "false") return false;
  return (
    process.env.NODE_ENV === "production" ||
    process.env.NEXTAUTH_URL?.startsWith("https://") === true ||
    process.env.USE_SECURE_COOKIES === "true"
  );
}

/**
 * Verify an email + password credential set against the database.
 *
 * Returns the minimal user object Auth.js expects on success, or null on any
 * failure. Always runs a scrypt verification (dummy work when the user is
 * unknown) so timing does not leak whether an email is registered, and is
 * rate-limited by opaque key so a caller cannot distinguish the two paths.
 */
export async function authorizeCredentials(input: {
  email?: unknown;
  password?: unknown;
  rateKey?: string;
  ip?: string | undefined;
}): Promise<{ id: string; email: string; name: string; pwd_v: string } | null> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) return null;

  // Docstring fix: this function previously claimed per-IP limiting but only
  // ever keyed per-email (auth.ts:68). The IP dimension arrives with the
  // rqlite backend, which the NextAuth(req) closure feeds via getClientIp.
  if (process.env.LOGIN_RATE_LIMIT_BACKEND === "rqlite") {
    const limiter = await import("@/lib/rate-limit").then((m) => m.rqliteRateLimiter);
    const ipKey = `login:ip:${input.ip ? ipv6PrefixKey(input.ip) : "unknown"}`;
    for (const key of [`login:email:${email}`, ipKey]) {
      const result = await limiter.check(key, LOGIN_RATE_LIMIT);
      if (!result.allowed) return null;
    }
  } else {
    const limit = inMemoryRateLimiter.check(
      `login:${input.rateKey ?? email}`,
      LOGIN_RATE_LIMIT
    );
    if (!limit.allowed) return null;
  }

  const user = await findCredentialUser(email);
  if (!user?.password_hash) {
    // Unknown user (or an OAuth-only account with no password set): still
    // spend the same scrypt time, then fail.
    await verifyPasswordDummy(password);
    return null;
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    // Password version tag: a later password change makes existing JWTs stale
    // (checked in sessionCallback).
    pwd_v: user.password_hash.slice(-8),
  };
}


/** Persist user ID (and password version) into the JWT token. */
export function jwtCallback({
  token,
  user,
}: {
  token: JWT;
  user?: User;
}): JWT {
  if (user?.id) {
    token.userId = user.id;
  }
  // Carry the password version from the credentials authorize() result so a
  // later reset invalidates this token. OAuth logins carry none.
  const pwdV = (user as { pwd_v?: string } | undefined)?.pwd_v;
  if (pwdV) token.pwd_v = pwdV;
  return token;
}

/**
 * Expose the user ID in the session, and invalidate the session if the token's
 * password version no longer matches the database (i.e. the password was
 * reset). Auth.js's session callback type does not permit returning null, so
 * invalidation clears `session.user.id` — downstream `resolveUser` treats a
 * session without a user id as unauthenticated.
 */
export async function sessionCallback({
  session,
  token,
}: {
  session: Session;
  token: JWT;
}): Promise<Session> {
  if (!token.userId) return session;

  const tokenV = token.pwd_v as string | undefined;
  // Only tokens that carry a version are subject to the check; OAuth tokens
  // (no pwd_v) are unaffected.
  if (tokenV !== undefined) {
    const current = await passwordVersion(token.userId as string);
    if (current !== tokenV) {
      // Stale password — drop the user so the session is no longer valid.
      if (session.user) session.user.id = "";
      return session;
    }
  }

  if (session.user) {
    session.user.id = token.userId as string;
  }
  return session;
}

// ---------------------------------------------------------------------------
// NextAuth configuration — lazy init pattern
// ---------------------------------------------------------------------------
//
// Using `NextAuth((req) => config)` gives us access to the request object
// inside callbacks. This is required for the invite gate: the signIn callback
// must read the `pew-invite-code` cookie, which is only available on `req`.
//
// `req` is a NextRequest when called from route handlers / proxy, or
// undefined when called from Server Components (no request context).
// ---------------------------------------------------------------------------

const useSecureCookies = shouldUseSecureCookies();

export const { handlers, auth, signIn, signOut } = NextAuth(async (req) => {
  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  // Google is registered only when credentials are configured: a self-hosted
  // intranet box typically has none, and an unconfigured provider makes
  // Auth.js build an authorize URL against an empty client ID.
  const providers: Provider[] = [];
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    providers.push(Google);
  }
  // Email + password is always available (spec §4.4).
  providers.push(
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: (creds) =>
        authorizeCredentials({
          email: creds?.email,
          password: creds?.password,
          ip: req ? getClientIp(req as Request) : undefined,
        }),
    })
  );

  return {
    // Must be true for Railway reverse proxy: Auth.js needs to read
    // X-Forwarded-Host to match the session cookie domain. Setting this to
    // false breaks session validation (auth() returns null → 401 on /api/*).
    // Open-redirect risk is mitigated separately in proxy.ts via TRUSTED_ORIGIN.
    trustHost: true,
    adapter: D1AuthAdapter(dbRead, dbWrite),
    providers,
    session: {
      strategy: "jwt",
    },
    // Cookie configuration for reverse proxy environments
    cookies: {
      pkceCodeVerifier: {
        name: useSecureCookies
          ? "__Secure-authjs.pkce.code_verifier"
          : "authjs.pkce.code_verifier",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      state: {
        name: useSecureCookies ? "__Secure-authjs.state" : "authjs.state",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      callbackUrl: {
        name: useSecureCookies
          ? "__Secure-authjs.callback-url"
          : "authjs.callback-url",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      sessionToken: {
        name: useSecureCookies
          ? "__Secure-authjs.session-token"
          : "authjs.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
      csrfToken: {
        name: useSecureCookies
          ? "__Host-authjs.csrf-token"
          : "authjs.csrf-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies,
        },
      },
    },
    callbacks: {
      async signIn({ account, profile }) {
        // Credentials sign-in is gated by authorizeCredentials() (rate limit +
        // password), and — unlike OAuth — creates no `accounts` row, so
        // handleInviteGate's "existing OAuth user" check would treat every
        // returning credentials user as new and demand an invite code. Let it
        // through here; registration (lib/credentials.ts) is where the invite
        // is actually consumed.
        if (account?.provider === "credentials") return true;

        // Gate new user registration behind invite codes.
        // Close over `req` to read the pew-invite-code cookie.
        // Pass profile.email so the pending placeholder is human-readable.
        return handleInviteGate(
          req,
          account
            ? {
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                email: profile?.email ?? null,
              }
            : null
        );
      },
      jwt: jwtCallback,
      session: sessionCallback,
    },
    events: {
      async createUser({ user }: { user: User }) {
        // After adapter creates the user, backfill the real user ID
        // on the invite code (replacing the temporary 'pending:...' value).
        if (req) {
          const code = req.cookies.get("pew-invite-code")?.value;
          if (code && user.id) {
            try {
              await dbWrite.execute(
                "UPDATE invite_codes SET used_by = ? WHERE code = ? AND used_by LIKE 'pending:%'",
                [user.id, code]
              );
            } catch {
              // Best-effort backfill — code is already consumed, admin sees
              // pending:<providerAccountId> instead of UUID. Not critical.
            }
          }
        }
      },
    },
    pages: {
      signIn: "/login",
      error: "/login",
    },
  };
});
