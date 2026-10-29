/**
 * Break-glass password reset for a self-hosted pew instance.
 *
 * For when no admin can sign in (e.g. the only admin forgot their password).
 * Connects straight to rqlite and rewrites `users.password_hash`, bypassing
 * the web app entirely — the in-app reset flow (an admin issuing a token) is
 * useless precisely when there is no reachable admin.
 *
 * Usage:
 *   RQLITE_URL=http://127.0.0.1:14001 RQLITE_RESET_PW='new-secret-123' bun deploy/selfhost/reset-password.ts \
 *     --email admin@corp.local
 *
 * Or, inside the compose network:
 *   docker compose exec -e RQLITE_URL=http://rqlite:4001 -e RQLITE_RESET_PW=... d1-http \
 *     bun /app/deploy/selfhost/reset-password.ts --email ...
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

/**
 * Resolve the new password by source priority: env (safest — invisible to
 * `ps` and shell history), then --password-stdin, then the legacy argv
 * channel. Exported for tests; `readStdin` is injectable.
 */
export async function resolvePassword(
  argv: string[],
  env: Record<string, string | undefined>,
  readStdin: () => Promise<string>
): Promise<string | undefined> {
  if (env.RQLITE_RESET_PW) return env.RQLITE_RESET_PW;
  if (argv.includes("--password-stdin")) return (await readStdin()).trimEnd();
  return parseArg(argv, "--password");
}

function readAllStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

/**
 * The break-glass write, extracted so a test can pin its exact effect.
 *
 * `api_key = NULL` is not decoration: this script exists for the case where the
 * operator believes the account is compromised or simply unreachable. Changing
 * `password_hash` kills every JWT session (the token carries a password-version
 * tag), but the Bearer `api_key` is compared against its own column and no
 * other code path rotates it, so a stolen CLI key would keep full write access
 * to `/api/ingest` and `/api/sessions` through the reset meant to lock its
 * holder out. The in-app flow already revokes it for exactly this reason
 * (`packages/web/src/lib/credentials.ts` consumeResetToken); the two reset
 * paths must not diverge. The legitimate owner re-runs `pew login`.
 */
export async function applyPasswordReset(
  db: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } },
  userId: string,
  password: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET password_hash = ?, api_key = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(hashPasswordForReset(password), userId)
    .run();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const email = parseArg(argv, "--email");
  // Prefer the env/stdin channel over argv: a password on the command line
  // is visible in host `ps` output for the life of the process and lands in
  // shell history. --password stays accepted for backwards compatibility.
  const password = await resolvePassword(argv, process.env, readAllStdin);
  const baseUrl = process.env.RQLITE_URL ?? "http://rqlite:4001";

  if (!email || !password) {
    console.error(
      "usage: reset-password.ts --email <email> (--password-stdin | RQLITE_RESET_PW=... | --password <new password>)",
    );
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

  await applyPasswordReset(db, existing.id, password);

  // Existing sessions are invalidated automatically (the JWT carries a
  // password-version tag that no longer matches, auth.ts sessionCallback) and
  // the Bearer api_key is revoked by applyPasswordReset. The CLI must re-login.
  console.log(`password updated for ${email} (${existing.id}); the CLI api key was revoked, run \`pew login\` again`);
}

// Only run when invoked directly, so the module can be imported by tests.
if (import.meta.main ?? process.argv[1]?.endsWith("reset-password.ts")) {
  main().catch((error: unknown) => {
    console.error("reset-password failed:", error);
    process.exit(1);
  });
}
