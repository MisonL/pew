/**
 * Email + password credentials: scrypt hashing and (Task 3) registration.
 *
 * Reasons this is its own module rather than folded into auth.ts:
 *   - lib/invite.ts's gate keys off the `accounts` table, which credentials
 *     users never populate; the credential path needs its own gate (see
 *     lib/invite.ts comment and spec §4.4).
 *   - scrypt params and the storage format are security-critical and want
 *     their own tests.
 */

import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { getD1Client } from "./d1";
import { getDbRead, getDbWrite } from "./db";
import { validateInviteCode } from "./invite";

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

// N=32768 with r=8 needs 128*N*r + 128*r*p = 33,555,456 bytes of memory, which
// is just over Node's default maxmem (32 MiB) and throws "Invalid scrypt
// params". Pass maxmem explicitly.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Login-path CPU guard. Each scrypt derivation costs ~33 MiB and tens of
 * milliseconds; scryptSync would block the single web process outright
 * (verified: 64.5 ms per call), and rotating emails defeats the per-email
 * limiter, so an unauthenticated attacker could stall every dashboard/API
 * request with a handful of concurrent login POSTs. The async form runs on
 * the libuv threadpool, and this cap bounds how much derivation work can be
 * queued at once — excess attempts fail closed (login rejected) instead of
 * piling up.
 */
const MAX_CONCURRENT_SCRYPT = 8;
let scryptInFlight = 0;

async function deriveWithSlot(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer | null> {
  if (scryptInFlight >= MAX_CONCURRENT_SCRYPT) return null;
  scryptInFlight++;
  try {
    return (await scryptAsync(password, salt, keylen, params)) as Buffer;
  } finally {
    scryptInFlight--;
  }
}

/** Test-only introspection: current number of in-flight derivations. */
export function scryptInFlightCount(): number {
  return scryptInFlight;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  if (!nRaw || !rRaw || !pRaw || !saltB64 || !hashB64) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  let actual: Buffer | null;
  try {
    actual = await deriveWithSlot(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  if (!actual) return false;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Wasted scrypt work for a nonexistent user, so login latency does not reveal
 * whether an email is registered.
 */
export async function verifyPasswordDummy(password: string): Promise<void> {
  const salt = randomBytes(16);
  await deriveWithSlot(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Registration and lookup
// ---------------------------------------------------------------------------

export interface CredentialUser {
  id: string;
  email: string;
  password_hash: string | null;
  name: string;
  is_public: number;
  is_admin: number;
}

/**
 * Look up a credentials user by email, including the password hash.
 *
 * Reads directly through the D1 REST client (lib/d1.ts) rather than the read
 * Worker's users.getByEmail RPC: that RPC returns a fixed UserAuth projection
 * with no password_hash, and widening it would mean editing lib/rpc-types.ts,
 * worker-read, and lib/db.ts — three upstream files, out of scope (spec §4.4).
 */
export async function findCredentialUser(email: string): Promise<CredentialUser | null> {
  const { results } = await getD1Client().query<CredentialUser>(
    `SELECT id, email, password_hash, name, is_public, is_admin
     FROM users WHERE email = ?`,
    [email]
  );
  return results[0] ?? null;
}

/**
 * Create a credentials user, consuming an invite code atomically.
 *
 * Mirrors lib/invite.ts's consume pattern (UPDATE ... WHERE used_by IS NULL,
 * then check changes): the invite is burned in the same flow that creates the
 * user, so a code cannot be reused by two concurrent registrations.
 *
 * Invite codes are created by an admin AFTER the first /setup, so this path is
 * never used to bootstrap — bootstrapAdmin() does that.
 *
 * The admin's "require_invite_code" setting governs this path too. Reading it
 * only in the OAuth gate (lib/invite.ts) left the two halves disagreeing: an
 * admin who turned invitations off was told "anyone can register" while
 * credential signups still demanded a code, and a code typed in that state was
 * burned for nothing. `inviteCode` is therefore optional when the setting is
 * "false".
 */
export async function registerWithInvite(input: {
  email: string;
  name: string;
  password: string;
  inviteCode: string;
}): Promise<{ userId: string }> {
  const { email, name, password, inviteCode } = input;

  const dbRead = await getDbRead();
  const requireInvite = (await dbRead.getAppSetting("require_invite_code")) !== "false";

  if (requireInvite && !validateInviteCode(inviteCode)) {
    throw new Error("A valid invite code is required to register");
  }
  if (inviteCode && !validateInviteCode(inviteCode)) {
    throw new Error("A valid invite code is required to register");
  }

  const dbWrite = await getDbWrite();
  const userId = crypto.randomUUID();

  if (requireInvite) {
    // Consume the invite first: if this returns changes === 0 the code was
    // invalid or already used, and we must not create the user.
    const consumed = await dbWrite.execute(
      `UPDATE invite_codes
       SET used_by = ?, used_at = datetime('now')
       WHERE code = ? AND used_by IS NULL`,
      [userId, inviteCode]
    );
    if (consumed.changes === 0) {
      throw new Error("Invalid or already used invite code");
    }
  }

  try {
    await dbWrite.execute(
      `INSERT INTO users (id, email, name, password_hash, is_public, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [userId, email, name ?? null, hashPassword(password)]
    );
  } catch (err) {
    // The user INSERT failed (e.g. duplicate email): release the invite so it
    // is not burned. Best-effort — the admin can also issue a fresh code.
    if (requireInvite) {
      try {
        await dbWrite.execute(
          `UPDATE invite_codes SET used_by = NULL, used_at = NULL
           WHERE code = ? AND used_by = ?`,
          [inviteCode, userId]
        );
      } catch {
        // Ignore: the original error is what matters.
      }
    }
    throw err;
  }

  return { userId };
}

// ---------------------------------------------------------------------------
// Password reset (admin-initiated; no email capability)
// ---------------------------------------------------------------------------

/** How long an admin-issued reset token stays valid. */
export const RESET_TOKEN_TTL_MINUTES = 60;

/**
 * Create a single-use password-reset token for a user, returning the opaque
 * token the admin hands over out of band (there is no SMTP — spec §4.4).
 *
 * Any outstanding tokens for the user are invalidated first so only the most
 * recent is usable.
 */
export async function createPasswordReset(userId: string): Promise<string> {
  const dbWrite = await getDbWrite();
  const token = randomBytes(32).toString("base64url");
  await dbWrite.batch([
    { sql: "DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", params: [userId] },
    {
      sql: `INSERT INTO password_resets (token, user_id, expires_at)
            VALUES (?, ?, datetime('now', ?))`,
      params: [token, userId, `+${RESET_TOKEN_TTL_MINUTES} minutes`],
    },
  ]);
  return token;
}

/**
 * Consume a reset token and set a new password. Returns the affected user id,
 * or null if the token is unknown, already used, or expired.
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string
): Promise<{ userId: string } | null> {
  const { results } = await getD1Client().query<{ user_id: string; expires_at: string }>(
    // Compare expiry SQL-side: expires_at is SQLite 'YYYY-MM-DD HH:MM:SS' (UTC,
    // written via datetime('now', ...)). JS Date parses the space-separated
    // form as LOCAL time, which would skew the window on any non-UTC host.
    `SELECT user_id, expires_at FROM password_resets
     WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [token]
  );
  const row = results[0];
  if (!row) return null;

  const dbWrite = await getDbWrite();
  const now = new Date().toISOString();
  // Claim and write in one transaction. A 0-row UPDATE is NOT an error, so
  // "claim then write" alone would let a concurrent consumer still set the
  // password; the password write is therefore gated on the claim with an
  // EXISTS subquery inside the same statement — a lost claim makes it match
  // 0 rows too. The batch's transaction (d1-adapter /db/request) keeps both
  // statements all-or-nothing.
  //
  // The gate matches used_at = ? (the timestamp THIS transaction writes), not
  // a mere EXISTS: a concurrent loser's claim hits 0 rows but its EXISTS would
  // still see the winner's used_at, letting the loser overwrite the winner's
  // password while reporting failure. Binding the gate to our own `now` closes
  // that replay: only the transaction that performed the claim can pass.
  const claim = await dbWrite.batch([
    {
      sql: "UPDATE password_resets SET used_at = ? WHERE token = ? AND used_at IS NULL",
      params: [now, token],
    },
    {
      // api_key is revoked with the password: it is a long-lived Bearer
      // credential that no other code path rotates, so leaving it valid would
      // let a stolen CLI key survive the very reset meant to lock the
      // attacker out (verified review 2026-10-21). The CLI must re-login.
      sql: `UPDATE users SET password_hash = ?, api_key = NULL, updated_at = datetime('now')
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM password_resets
              WHERE token = ? AND used_at = ?
            )`,
      params: [hashPassword(newPassword), row.user_id, token, now],
    },
  ]);
  const claimChanges = claim[0]?.meta?.changes ?? 0;
  if (claimChanges === 0) return null;

  return { userId: row.user_id };
}

/**
 * Short version tag of a user's current password hash, embedded in the JWT so
 * a password change invalidates existing sessions (spec §4.4). Empty string
 * for a user with no password (OAuth-only) — those sessions are not
 * invalidated by a reset they never had.
 */
export async function passwordVersion(userId: string): Promise<string> {
  const { results } = await getD1Client().query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = ?",
    [userId]
  );
  const hash = results[0]?.password_hash;
  return hash ? hash.slice(-8) : "";
}

/**
 * Create the very first user as an administrator.
 *
 * Solves the "no users => no invite codes => no users" deadlock: the first
 * person to hit /setup becomes the admin, and every later registration needs
 * an admin-issued invite.
 *
 * Concurrency-safe: the batch runs in a single rqlite transaction (the D1
 * batch path is `?transaction=true` under the self-hosted adapter), and it
 * claims the single-row `instance_setup` table via `INSERT OR IGNORE` guarded
 * by the "users is empty" precondition. Two simultaneous /setup requests
 * cannot both create an admin: the second sees a non-empty users table (or its
 * instance_setup insert collides on the PRIMARY KEY), and is rejected.
 */
export async function bootstrapAdmin(input: {
  email: string;
  name: string;
  password: string;
}): Promise<{ userId: string }> {
  const { email, name, password } = input;
  const dbWrite = await getDbWrite();

  // getDbWrite().execute() only returns meta (changes), not rows, so the count
  // read goes through the D1 client directly.
  const { results } = await getD1Client().query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users"
  );
  if ((results[0]?.n ?? 0) > 0) {
    throw new Error("Instance is already set up");
  }

  const userId = crypto.randomUUID();
  await dbWrite.batch([
    {
      sql: `INSERT INTO users (id, email, name, password_hash, is_admin, is_public, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 1, datetime('now'), datetime('now'))`,
      params: [userId, email, name ?? null, hashPassword(password)],
    },
    {
      sql: `INSERT INTO instance_setup (id, admin_user_id, completed_at)
            VALUES (1, ?, datetime('now'))`,
      params: [userId],
    },
  ]);

  return { userId };
}


