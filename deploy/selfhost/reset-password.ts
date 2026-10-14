/**
 * Break-glass password reset for a self-hosted pew instance.
 *
 * For when no admin can sign in (e.g. the only admin forgot their password).
 * Connects straight to rqlite and rewrites `users.password_hash`, bypassing
 * the web app entirely — the in-app reset flow (an admin issuing a token) is
 * useless precisely when there is no reachable admin.
 *
 * Usage:
 *   RQLITE_URL=http://127.0.0.1:14001 bun deploy/selfhost/reset-password.ts \
 *     --email admin@corp.local --password 'new-secret-123'
 *
 * Or, inside the compose network:
 *   docker compose exec -e RQLITE_URL=http://rqlite:4001 d1-http \
 *     bun /app/deploy/selfhost/reset-password.ts --email ... --password ...
 */

import { randomBytes, scryptSync } from "node:crypto";
import { resolveEnvBasicAuth } from "./basic-auth";
import { createD1Adapter } from "./d1-adapter";

// Must match lib/credentials.ts's SCRYPT parameters and storage format so a
// reset here produces a hash the web app's verifyPassword() accepts. The
// cross-check test in reset-password.test.ts fails if the two ever diverge.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

/** Hash a password into the `scrypt$N$r$p$salt$hash` storage format. */
export function hashPasswordForReset(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Parse `--flag value` / `--flag=value` from argv. */
export function parseArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const email = parseArg(argv, "--email");
  const password = parseArg(argv, "--password");
  const baseUrl = process.env.RQLITE_URL ?? "http://rqlite:4001";

  if (!email || !password) {
    console.error("usage: reset-password.ts --email <email> --password <new password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }

  const basicAuth = resolveEnvBasicAuth();
  const db = createD1Adapter({ baseUrl, token: "", ...(basicAuth ? { basicAuth } : {}) });

  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!existing) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(hashPasswordForReset(password), existing.id)
    .run();

  // Existing sessions are invalidated automatically: the JWT carries a
  // password-version tag that no longer matches (auth.ts sessionCallback).
  console.log(`password updated for ${email} (${existing.id})`);
}

// Only run when invoked directly, so the module can be imported by tests.
if (import.meta.main ?? process.argv[1]?.endsWith("reset-password.ts")) {
  main().catch((error: unknown) => {
    console.error("reset-password failed:", error);
    process.exit(1);
  });
}
