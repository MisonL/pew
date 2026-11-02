import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountingRecord } from "@pew/core";
import { AccountingQueue, accountingKey } from "../storage/accounting-queue.js";
import { LocalQueue } from "../storage/local-queue.js";
import { executeUpload } from "../commands/upload.js";
import { DEFAULT_HOST } from "../config/manager.js";
import { accountingFixture } from "../../../core/src/__test-helpers__/accounting.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
// apiUrl must stay on a built-in SaaS host: the upload engine derives the
// credential file name from the host, so an arbitrary test host would read
// config.<host>.json instead of the config.json written below.
const API = DEFAULT_HOST;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pew-cache-upload-")); dirs.push(dir);
  await writeFile(join(dir, "config.json"), JSON.stringify({ token: "pk_synthetic" }));
  const record = accountingFixture() as AccountingRecord;
  const main = new LocalQueue(dir); const details = new AccountingQueue(dir);
  await main.overwrite([{ source: record.source, model: record.model, device_id: record.device_id, hour_start: record.hour_start, ...record.basis }]);
  await details.merge([record]);
  return { dir, record, main, details };
}
function ack(r: AccountingRecord, status: string) { return { details_version: 1, acknowledgments: [{ key: accountingKey(r),
  source_revision: r.source_revision, parser_revision: r.parser_revision, detail_revision: r.detail_revision, status }] }; }

describe("accounting outbox capability acknowledgment", () => {
  it.each([404, 200])("keeps details pending with an old server responding %s", async (code) => {
    const { dir, record, details } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ ingested: 1 }))
      .mockResolvedValueOnce(Response.json({ ingested: 1 }, { status: code }));
    const result = await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0 });
    expect(result.uploaded).toBe(1);
    expect(await details.loadDirtyKeys()).toEqual([accountingKey(record)]);
    expect(result.warning).toContain("pending");
  });

  it.each(["applied", "duplicate", "superseded"])("clears an explicitly acknowledged %s snapshot", async (status) => {
    const { dir, record, details } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ ingested: 1 })).mockResolvedValueOnce(Response.json(ack(record, status)));
    const result = await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0 });
    expect(result.success).toBe(true); expect(await details.loadDirtyKeys()).toEqual([]);
    expect((await details.readFromOffset(0)).records).toHaveLength(1);
  });

  it.each(["base_mismatch", "conflict"])("retains %s for reconciliation", async (status) => {
    const { dir, record, details } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ ingested: 1 })).mockResolvedValueOnce(Response.json(ack(record, status)));
    await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0 });
    expect(await details.loadDirtyKeys()).toEqual([accountingKey(record)]);
  });

  it("does not let a record the server cannot apply block the ones behind it", async () => {
    // `pew reset && pew sync` replays every surviving ledger key, including
    // annotations whose raw logs were rotated away. On a fresh server those
    // have no token base and are answered `base_mismatch` forever. The batch
    // that carries one used to abort the whole stage, so every later
    // annotation — including ones whose base does exist — never shipped on
    // any run. Refused keys must stay pending; acknowledged ones must clear.
    const { dir, record, details } = await setup();
    const blocked = { ...record, hour_start: "2026-09-01T00:30:00.000Z" };
    const behind = { ...record, hour_start: "2026-09-01T01:00:00.000Z" };
    await details.merge([blocked, behind]);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as AccountingRecord[];
      if (!String(url).endsWith("/api/ingest/details")) return Response.json({ ingested: body.length });
      return Response.json({ details_version: 1, acknowledgments: body.map((r) => ({
        key: accountingKey(r), source_revision: r.source_revision, parser_revision: r.parser_revision,
        detail_revision: r.detail_revision,
        status: accountingKey(r) === accountingKey(blocked) ? "base_mismatch" : "applied" })) });
    });
    const result = await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0, batchSize: 1 });
    expect(result.warning).toContain("pending");
    expect(await details.loadDirtyKeys()).toEqual([accountingKey(blocked)]);
  });

  it("does not let an acknowledgment for a different revision discard the pending snapshot", async () => {
    const { dir, record, details } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ ingested: 1 }))
      .mockResolvedValueOnce(Response.json(ack({ ...record, detail_revision: 2 }, "applied")));
    await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0 });
    expect(await details.loadDirtyKeys()).toEqual([accountingKey(record)]);
  });

  it("ships the annotations behind a record too large for a batch and sends it in a batch of its own", async () => {
    // The details stage caps a batch at 600 KB, and an AccountingRecord has no
    // independent size bound: 256 groups × 4 reported costs, each carrying a
    // 128-char label and a 60-digit amount, is a *valid* record (the local gate
    // and core's validateAccountingRecord both accept it) that still measures
    // ~617 KB. The endpoint accepts 24 MB, so the record is sendable — it just
    // cannot share a batch. It used to `return` out of the stage before any
    // batch was built, so the offset never advanced and every later annotation
    // was re-read and re-blocked on every run forever: the outbox stopped
    // without ever reporting a failure.
    const { dir, record, details } = await setup();
    const label = `a${"b".repeat(127)}`;
    // The top-level basis has to be the exact sum of the 256 cloned group
    // bases; the local gate re-derives it and rejects the whole ledger if the
    // two disagree.
    const hundreds = (n: number) => n * 256;
    const huge = {
      ...record, hour_start: "2026-09-01T00:30:00.000Z",
      basis: {
        input_tokens: hundreds(record.basis.input_tokens), cached_input_tokens: hundreds(record.basis.cached_input_tokens),
        output_tokens: hundreds(record.basis.output_tokens), reasoning_output_tokens: hundreds(record.basis.reasoning_output_tokens),
        total_tokens: hundreds(record.basis.total_tokens),
      },
      groups: Array.from({ length: 256 }, () => ({
        ...record.groups[0], origin: label, model: label, provider: label, route: label, service_tier: label,
        reported_costs: Array.from({ length: 4 }, () => ({
          units: "9".repeat(60), scale: 18, currency: "USD", kind: "actual", status: "complete", source: label,
        })),
        diagnostics: [
          { code: "total_mismatch", raw_total_tokens: 0 },
          { code: "invalid_counts", raw_total_tokens: 0 },
          { code: "aggregate_context", raw_total_tokens: 0 },
        ],
      })),
    } as AccountingRecord;
    const behind = { ...record, hour_start: "2026-09-01T01:00:00.000Z" } as AccountingRecord;
    expect(Buffer.byteLength(JSON.stringify(huge)) + 1).toBeGreaterThan(600_000);
    await details.merge([huge, behind]);

    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as AccountingRecord[];
      if (!String(url).endsWith("/api/ingest/details")) return Response.json({ ingested: body.length });
      return Response.json({ details_version: 1, acknowledgments: body.map((r) => ({
        key: accountingKey(r), source_revision: r.source_revision, parser_revision: r.parser_revision,
        detail_revision: r.detail_revision, status: "applied" })) });
    });
    const result = await executeUpload({ stateDir: dir, apiUrl: API, fetch, maxRetries: 0, batchSize: 1 });

    expect(result.success).toBe(true);
    const detailBatches = fetch.mock.calls.filter(([u]) => String(u).endsWith("/api/ingest/details"))
      .map(([, init]) => JSON.parse(String(init?.body)) as AccountingRecord[]);
    const sentDetails = detailBatches.flat().map(accountingKey);
    // Both records reached the wire, and the 617 KB one did not drag a
    // neighbour into a request of its own.
    expect(sentDetails).toContain(accountingKey(huge));
    expect(sentDetails).toContain(accountingKey(behind));
    const hugeBatch = detailBatches.find((b) => b.some((r) => accountingKey(r) === accountingKey(huge)));
    expect(hugeBatch).toHaveLength(1);
    // Everything was acknowledged, so nothing stays pending.
    expect(await details.loadDirtyKeys()).toEqual([]);
  });
});
