import { describe, expect, it } from "vitest";
import { accountedBasis, accountedParts, accountedTotal, displayCounters } from "./display-counters.js";
import { accountingFixture } from "./__test-helpers__/accounting.js";
import type { AccountingGroup } from "./accounting-types.js";

const fixture = () => {
  const r = accountingFixture();
  const annotation = [{ status: "matched" as const, basis: r.basis, groups: [r.groups[0]!] }];
  return { ...r.basis, accounting: annotation };
};

describe("shared display counters", () => {
  it("splits the legacy counters along the annotated cache and reasoning parts", () => {
    const row = fixture();
    // The group accounts for the whole row, and its recorded 900 input is 800
    // cached reads plus 100 uncached, against a legacy basis of 100 + 800.
    expect(displayCounters(row)).toEqual({
      input_tokens: 100, cached_input_tokens: 800, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 940,
    });
    expect(accountedTotal(row)).toBe(940);
  });

  it("subtracts a partial annotation and keeps the unannotated remainder", () => {
    const r = accountingFixture();
    const half = { ...r.basis, input_tokens: 40, cached_input_tokens: 400, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 465 };
    const group = { ...r.groups[0]!, basis: half,
      counts: { ...r.groups[0]!.counts!, input_total_tokens: 440, cache_read_input_tokens: 400, output_total_tokens: 25 } };
    const row = { ...r.basis, accounting: [{ status: "matched" as const, basis: half, groups: [group] }] };
    // 60 uncached input, 400 cached, 10 output and 5 reasoning remain outside
    // the annotation; the annotated half projects to 40 + 400 in / 25 out,
    // 10 of which the counts call reasoning.
    expect(displayCounters(row)).toEqual({
      input_tokens: 100, cached_input_tokens: 800, output_tokens: 25, reasoning_output_tokens: 15, total_tokens: 940,
    });
  });

  it("projects a row without annotations to itself", () => {
    const { accounting: _drop, ...bare } = fixture();
    expect(displayCounters(bare)).toEqual(accountedBasis(bare));
    // The route projects rows the worker already projected, so idempotence is
    // part of the contract, not a coincidence.
    expect(displayCounters(displayCounters(bare))).toEqual(displayCounters(bare));
    expect(displayCounters(displayCounters(fixture()))).toEqual(displayCounters(fixture()));
  });

  it("derives a missing total from the recorded parts", () => {
    expect(accountedBasis({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 3 }))
      .toEqual({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 6 });
  });

  it("rejects an annotation that does not reconcile with the row it annotates", () => {
    const row = fixture();
    row.accounting[0]!.basis = { ...row.accounting[0]!.basis, total_tokens: 1 };
    expect(accountedParts(row).invalid).toBe(true);
    expect(displayCounters(row)).toEqual(accountedBasis(row));

    const negative = fixture();
    negative.accounting[0]!.basis = { ...accountedBasis(negative), input_tokens: 101, total_tokens: 941 };
    expect(accountedParts(negative).invalid).toBe(true);
    expect(displayCounters(negative)).toEqual(accountedBasis(negative));
  });

  it("surfaces a group with no recorded counts through its legacy basis", () => {
    const row = fixture();
    const group: AccountingGroup = { ...row.accounting[0]!.groups[0]!, counts: null, quality: "legacy" };
    row.accounting[0]!.groups = [group];
    const parts = accountedParts(row);
    expect(parts.invalid).toBe(false);
    expect(displayCounters(row)).toEqual(accountedBasis(row));
  });

  it("retains the legacy cache partition when the read classification is unknown", () => {
    const row = fixture();
    const group = row.accounting[0]!.groups[0]!;
    // Hermes merges reads and writes in one unsplit cache bucket; a null read
    // must not be read as an uncached miss.
    group.counts = { ...group.counts!, cache_read_input_tokens: null, reasoning_output_tokens: null };
    const counters = displayCounters(row);
    expect(counters.cached_input_tokens).toBe(group.basis.cached_input_tokens);
    expect(counters.reasoning_output_tokens).toBe(group.basis.reasoning_output_tokens);
  });

  it("ignores a pending annotation and reports it", () => {
    const row = fixture();
    row.accounting[0]!.status = "pending";
    const parts = accountedParts(row);
    expect(parts.pending).toBe(true);
    expect(parts.groups).toEqual([]);
    expect(displayCounters(row)).toEqual(accountedBasis(row));
  });
});
