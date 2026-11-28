/**
 * Message for a ledger that cannot be read or validated.
 *
 * Both durable ledgers (evidence, accounting) are deliberately strict: one
 * unreadable line refuses the whole command instead of silently dropping
 * history. The refusal is correct, but the bare "Invalid … ledger" left the
 * operator with no recovery path — `pew reset` keeps both files on purpose, so
 * every later sync/upload failed the same way with no hint of what to touch.
 */
export function ledgerRecoveryMessage(what: "usage evidence" | "accounting"): string {
  return `Invalid ${what} ledger. It is kept across \`pew reset\` on purpose, so the next sync fails the same way. ` +
    "Restore it from a backup, or move it aside to rebuild from the current logs " +
    `(you lose pending ${what} records the logs no longer contain).`;
}
