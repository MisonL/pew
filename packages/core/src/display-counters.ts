import type { AccountingAnnotation, AccountingGroup, LegacyTokenCounts } from "./accounting-types.js";

/**
 * A usage row carrying the five legacy counters plus, optionally, the
 * reconciliation annotations that redistribute them.
 *
 * The counters stay the reconciliation basis: an annotation never replaces
 * them, it only proves how they split into recorded cache/reasoning parts.
 */
export interface AccountedCounts {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  accounting?: AccountingAnnotation[];
}

export interface AccountedParts {
  groups: AccountingGroup[];
  remaining: LegacyTokenCounts;
  /** The annotation does not reconcile with the row; callers must use `remaining` alone. */
  invalid: boolean;
  pending: boolean;
}

const ACCOUNTED_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

/** Derived rows may omit the stored total; it is the sum of the four recorded parts. */
export function accountedBasis(r: AccountedCounts): LegacyTokenCounts {
  return { input_tokens: r.input_tokens, cached_input_tokens: r.cached_input_tokens, output_tokens: r.output_tokens,
    reasoning_output_tokens: r.reasoning_output_tokens ?? 0,
    total_tokens: r.total_tokens ?? r.input_tokens + r.cached_input_tokens + r.output_tokens + (r.reasoning_output_tokens ?? 0) };
}

/** Only joined, mutually exclusive bases may be subtracted from an aggregate. */
export function accountedParts(r: AccountedCounts): AccountedParts {
  const original = accountedBasis(r); const remaining = { ...original }; const groups: AccountingGroup[] = [];
  const pending = r.accounting?.some((a) => a.status === "pending") ?? false;
  for (const a of r.accounting ?? []) {
    if (a.status !== "matched") continue;
    if (ACCOUNTED_FIELDS.some((f) => !Number.isSafeInteger(a.basis[f]) || a.basis[f] < 0 ||
      a.groups.reduce((n, g) => n + g.basis[f], 0) !== a.basis[f])) return { groups: [], remaining: original, invalid: true, pending };
    for (const f of ACCOUNTED_FIELDS) remaining[f] -= a.basis[f];
    groups.push(...a.groups);
  }
  if (ACCOUNTED_FIELDS.some((f) => remaining[f] < 0)) return { groups: [], remaining: original, invalid: true, pending };
  return { groups, remaining, invalid: false, pending };
}

/**
 * Disjoint display counters. Original API fields remain the reconciliation
 * basis.
 *
 * Idempotent by construction: a row without annotations parts into itself, so
 * a caller may project a value that was already projected.
 */
export function displayCounters(r: AccountedCounts): LegacyTokenCounts {
  const p = accountedParts(r); const out = { ...p.remaining };
  for (const g of p.groups) {
    const c = g.counts;
    if (!c) { for (const f of ACCOUNTED_FIELDS) out[f] += g.basis[f]; continue; }
    // Unknown read classification retains the legacy chart partition. It must
    // not turn Hermes' unsplit read/write cache bucket into uncached input.
    const read = c.cache_read_input_tokens ?? g.basis.cached_input_tokens;
    const reasoning = c.reasoning_output_tokens ?? g.basis.reasoning_output_tokens;
    out.input_tokens += c.input_total_tokens - read;
    out.cached_input_tokens += read;
    out.output_tokens += c.output_total_tokens - reasoning;
    out.reasoning_output_tokens += reasoning;
    out.total_tokens += c.input_total_tokens + c.output_total_tokens;
  }
  return out;
}

export const accountedTotal = (r: AccountedCounts): number => displayCounters(r).total_tokens;
