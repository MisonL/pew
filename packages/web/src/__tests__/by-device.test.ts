import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/usage/by-device/route";
import * as dbModule from "@/lib/db";
import { createMockDbRead, loadMockedAuthHelpers, makeGetRequest } from "./test-utils";
import { resetPricingMapCache } from "@/lib/load-pricing-map";
import { accountingFixture } from "../../../core/src/__test-helpers__/accounting";
import { displayCounters } from "@/lib/accounting";

// Mock DB
vi.mock("@/lib/db", () => ({
  getDbRead: vi.fn(),
  getDbWrite: vi.fn(),
  resetDb: vi.fn(),
}));

// Mock resolveUser
vi.mock("@/lib/auth-helpers", () => ({
  resolveUser: vi.fn(),
}));

const { resolveUser } = await loadMockedAuthHelpers();

// loadPricingMap serves from a per-process cache; without a reset between
// tests each case would inherit the stub a previous case installed.
beforeEach(() => {
  resetPricingMapCache();
});

describe("GET /api/usage/by-device", () => {
  let mockDbRead: ReturnType<typeof createMockDbRead>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead = createMockDbRead();
    // Default dynamic pricing stub: empty (so loadPricingMap falls through to
    // safety net unless the test overrides it).
    mockDbRead.getDynamicPricing.mockResolvedValue({
      entries: [],
      servedFrom: "baseline",
    });
    vi.mocked(dbModule.getDbRead).mockResolvedValue(mockDbRead as any);
  });

  it.each([null, 90])("retains raw bases and exposes estimate assumptions (write=%s)", async (write) => {
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    const r = accountingFixture();
    const accounting = [{ status: "matched", basis: r.basis, groups: [{ ...r.groups[0],
      counts: { ...r.groups[0]!.counts, cache_write_input_tokens: write } }] }];
    const row = { ...r.basis, source: r.source, model: r.model, device_id: r.device_id, accounting };
    mockDbRead.getDeviceSummary.mockResolvedValue([{ ...row, alias: null, first_seen: r.hour_start, last_seen: r.hour_start,
      sources: r.source, models: r.model }]);
    mockDbRead.getDeviceCostDetails.mockResolvedValue([row]);
    mockDbRead.getDeviceTimeline.mockResolvedValue([{ ...row, date: "2026-09-01" }]);
    mockDbRead.getDynamicPricing.mockResolvedValue({ servedFrom: "kv", entries: [{ model: "openai/gpt-6-astra", provider: "OpenAI",
      displayName: "GPT-6 Astra", inputPerMillion: 10, outputPerMillion: 50, cachedPerMillion: 1, cacheWritePerMillion: 12.5,
      route: "direct", contextWindow: 1000000, origin: "models.dev", updatedAt: r.hour_start }] });
    const response = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.devices[0]).toMatchObject({ ...r.basis, accounting, estimated_cost_complete: write !== null });
    expect(body.devices[0].estimated_cost).toBeGreaterThan(0);
    expect(body.timeline[0]).toMatchObject({ ...r.basis, accounting });
    expect(body.deviceDetails[0]).toMatchObject({ ...r.basis, accounting });
  });

  it("omits the drill-down rows when includeDetails=0, keeping devices and timeline intact", async () => {
    // The dashboard's breakdown charts read only `devices` and `timeline`;
    // deviceDetails is ~1/3 of the response, so they opt out.
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    const r = accountingFixture();
    const row = { ...r.basis, source: r.source, model: r.model, device_id: r.device_id };
    mockDbRead.getDeviceSummary.mockResolvedValue([{ ...row, alias: null, first_seen: r.hour_start, last_seen: r.hour_start,
      sources: r.source, models: r.model }]);
    mockDbRead.getDeviceCostDetails.mockResolvedValue([row]);
    mockDbRead.getDeviceTimeline.mockResolvedValue([{ ...row, date: "2026-09-01" }]);

    const response = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02", includeDetails: "0" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.devices).toHaveLength(1);
    expect(body.timeline).toHaveLength(1);
    expect(body.deviceDetails).toEqual([]);
    // Cost estimation still runs — it reads the cost rows server-side.
    expect(body.devices[0].estimated_cost).toBeGreaterThanOrEqual(0);
  });

  it("omits the annotation payload when includeAccounting=0 and pre-splits the counters", async () => {
    // The dashboard breakdown charts pass includeAccounting=0: on an all-time
    // window the annotations are 10.8 MB of an 11 MB response. The counters
    // must still be the same display split the client would have derived.
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    const r = accountingFixture();
    const accounting = [{ status: "matched" as const, basis: r.basis, groups: [r.groups[0]!] }];
    const row = { ...r.basis, source: r.source, model: r.model, device_id: r.device_id, accounting };
    mockDbRead.getDeviceSummary.mockResolvedValue([{ ...row, alias: null, first_seen: r.hour_start, last_seen: r.hour_start,
      sources: r.source, models: r.model }]);
    mockDbRead.getDeviceCostDetails.mockResolvedValue([row]);
    mockDbRead.getDeviceTimeline.mockResolvedValue([{ ...row, date: "2026-09-01" }]);

    const full = await (await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02" }))).json();
    const lean = await (await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02", includeAccounting: "0" }))).json();

    expect(full.devices[0].accounting).toBeDefined();
    expect(full.timeline[0].accounting).toBeDefined();
    expect(lean.devices[0].accounting).toBeUndefined();
    expect(lean.timeline[0].accounting).toBeUndefined();
    // Same counted values, only the evidence annotations are gone.
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
      expect(lean.devices[0][field]).toBe(full.devices[0][field]);
      expect(lean.timeline[0][field]).toBe(full.timeline[0][field]);
    }
    expect(lean.devices[0].estimated_cost).toBe(full.devices[0].estimated_cost);
  });

  it("pre-splits the drill-down rows too when includeAccounting=0", async () => {
    // deviceDetails used to keep the raw legacy counters while devices and
    // timeline were projected, so summing a device's drill-down rows disagreed
    // with the device row it was drilled from.
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    const r = accountingFixture();
    const group = r.groups[0]!;
    // A group whose explicit cache split differs from the legacy basis: the
    // projection moves 200 tokens from input to cached.
    const accounting = [{ status: "matched" as const, basis: r.basis,
      groups: [{ ...group, counts: { ...group.counts, cache_read_input_tokens: 600, cache_write_input_tokens: 300 } }] }];
    const row = { ...r.basis, source: r.source, model: r.model, device_id: r.device_id, accounting };
    mockDbRead.getDeviceSummary.mockResolvedValue([{ ...row, alias: null, first_seen: r.hour_start, last_seen: r.hour_start,
      sources: r.source, models: r.model }]);
    mockDbRead.getDeviceCostDetails.mockResolvedValue([row]);
    mockDbRead.getDeviceTimeline.mockResolvedValue([{ ...row, date: "2026-09-01" }]);

    const lean = await (await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02", includeAccounting: "0" }))).json();
    const projected = displayCounters(row as Parameters<typeof displayCounters>[0]);

    expect(projected.input_tokens).not.toBe(row.input_tokens); // the fixture is discriminating
    expect(lean.deviceDetails[0]).toMatchObject({
      input_tokens: projected.input_tokens,
      cached_input_tokens: projected.cached_input_tokens,
      output_tokens: projected.output_tokens,
      total_tokens: projected.total_tokens,
    });
    // And the drill-down agrees with the device row it belongs to.
    expect(lean.deviceDetails[0].total_tokens).toBe(lean.devices[0].total_tokens);
  });

  it("keeps annotations only on the drill-down rows when includeAccounting=details", async () => {
    // /devices reads labels, totals and its UsageInformation coverage notes:
    // the notes need the per-(device,source,model) evidence, while the device
    // and timeline annotations (10.8 MB on an all-time window) are unread.
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    const r = accountingFixture();
    const accounting = [{ status: "matched" as const, basis: r.basis, groups: [r.groups[0]!] }];
    const row = { ...r.basis, source: r.source, model: r.model, device_id: r.device_id, accounting };
    mockDbRead.getDeviceSummary.mockResolvedValue([{ ...row, alias: null, first_seen: r.hour_start, last_seen: r.hour_start,
      sources: r.source, models: r.model }]);
    mockDbRead.getDeviceCostDetails.mockResolvedValue([row]);
    mockDbRead.getDeviceTimeline.mockResolvedValue([{ ...row, date: "2026-09-01" }]);

    const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02", includeAccounting: "details" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceDetails[0].accounting).toBeDefined();
    expect(body.devices[0].accounting).toBeUndefined();
    expect(body.timeline[0].accounting).toBeUndefined();
    // Pre-split counters match what the client would have derived.
    const projected = displayCounters(row as Parameters<typeof displayCounters>[0]);
    expect(body.devices[0].total_tokens).toBe(projected.total_tokens);
    expect(body.timeline[0].total_tokens).toBe(projected.total_tokens);
  });

  describe("authentication", () => {
    it("should reject unauthenticated requests", async () => {
      vi.mocked(resolveUser).mockResolvedValueOnce(null);

      const res = await GET(makeGetRequest("/api/usage/by-device"));

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });
  });

  describe("date and parameter validation", () => {
    beforeEach(() => {
      vi.mocked(resolveUser).mockResolvedValue({
        userId: "u1",
        email: "test@example.com",
      });
    });

    it("should return 400 for invalid from date format", async () => {
      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "not-a-date" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid date format");
    });

    it("should return 400 for invalid to date format", async () => {
      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "bad" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid date format");
    });

    it("should return 400 for invalid tzOffset (NaN)", async () => {
      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11", tzOffset: "abc" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid tzOffset value");
    });

    it("should return 400 for tzOffset > 840", async () => {
      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11", tzOffset: "900" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid tzOffset value");
    });

    it("should use defaults when from/to not provided", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devices).toEqual([]);
    });

    it("should pass half-hour granularity to DB", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11", granularity: "half-hour" }));
      expect(res.status).toBe(200);
      expect(mockDbRead.getDeviceTimeline).toHaveBeenCalledWith(
        "u1",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ granularity: "half-hour" }),
      );
    });

    // Silently answering a request for hourly buckets with daily ones is worse
    // than refusing it: /api/usage already 400s an unknown granularity.
    it("should reject an unknown granularity instead of downgrading it", async () => {
      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11", granularity: "hour" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid granularity parameter");
      expect(mockDbRead.getDeviceTimeline).not.toHaveBeenCalled();
    });

    it("should handle bare date (YYYY-MM-DD) in to param by bumping +1 day", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-10" }));
      expect(res.status).toBe(200);
    });

    it("should handle full ISO to param without bumping", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-10T23:59:59Z" }));
      expect(res.status).toBe(200);
    });
  });

  describe("deviceDetails and empty sources", () => {
    beforeEach(() => {
      vi.mocked(resolveUser).mockResolvedValue({
        userId: "u1",
        email: "test@example.com",
      });
    });

    it("should return deviceDetails in response", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: null,
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 50000,
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
          reasoning_output_tokens: 0,
          sources: "",
          models: "",
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          source: "claude-code",
          model: "claude-sonnet-4-20250514",
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
        },
      ]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      // deviceDetails should be present
      expect(body.deviceDetails).toHaveLength(1);
      expect(body.deviceDetails[0].device_id).toBe("aaaa-1111");
      expect(body.deviceDetails[0].source).toBe("claude-code");
      expect(body.deviceDetails[0].total_tokens).toBe(30000 + 15000 + 5000);
      // Empty sources/models should produce empty arrays
      expect(body.devices[0].sources).toEqual([]);
    });

    it("should handle device with no cost rows (estimated_cost = 0)", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: null,
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
          sources: null,
          models: null,
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.devices[0].estimated_cost).toBe(0);
      // null sources/models → empty array
      expect(body.devices[0].sources).toEqual([]);
    });
  });

  describe("response format", () => {
    beforeEach(() => {
      vi.mocked(resolveUser).mockResolvedValue({
        userId: "u1",
        email: "test@example.com",
      });
    });

    it("should return devices and timeline for valid date range", async () => {
      // Summary RPC
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: "MacBook Pro",
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 50000,
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
          reasoning_output_tokens: 0,
          sources: "claude-code",
          models: "claude-sonnet-4-20250514",
        },
        {
          device_id: "bbbb-2222",
          alias: null,
          first_seen: "2026-03-05T00:00:00Z",
          last_seen: "2026-03-10T10:00:00Z",
          total_tokens: 20000,
          input_tokens: 12000,
          output_tokens: 6000,
          cached_input_tokens: 2000,
          reasoning_output_tokens: 500,
          sources: "opencode",
          models: "o3",
        },
      ]);
      // Cost detail RPC
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          source: "claude-code",
          model: "claude-sonnet-4-20250514",
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
        },
        {
          device_id: "bbbb-2222",
          source: "opencode",
          model: "o3",
          input_tokens: 12000,
          output_tokens: 6000,
          cached_input_tokens: 2000,
        },
      ]);
      // Timeline RPC
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([
        {
          date: "2026-03-01",
          device_id: "aaaa-1111",
          total_tokens: 10000,
          input_tokens: 6000,
          output_tokens: 3000,
          cached_input_tokens: 1000,
        },
        {
          date: "2026-03-01",
          device_id: "bbbb-2222",
          total_tokens: 5000,
          input_tokens: 3000,
          output_tokens: 1500,
          cached_input_tokens: 500,
        },
      ]);
      // Pricing RPC (no overrides)

      const res = await GET(
        makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devices).toHaveLength(2);
      expect(body.timeline).toHaveLength(2);
      expect(body.devices[0].device_id).toBe("aaaa-1111");
      expect(body.devices[1].device_id).toBe("bbbb-2222");
    });

    it("should include estimated_cost per device", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: null,
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 50000,
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
          reasoning_output_tokens: 0,
          sources: "claude-code",
          models: "claude-sonnet-4-20250514",
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          source: "claude-code",
          model: "claude-sonnet-4-20250514",
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
        },
      ]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));
      const body = await res.json();

      expect(body.devices[0].estimated_cost).toBeTypeOf("number");
      expect(body.devices[0].estimated_cost).toBeGreaterThan(0);
    });

    it("should join alias from device_aliases", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: "MacBook",
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 50000,
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
          reasoning_output_tokens: 0,
          sources: "claude-code",
          models: "claude-sonnet-4-20250514",
        },
        {
          device_id: "bbbb-2222",
          alias: null,
          first_seen: "2026-03-05T00:00:00Z",
          last_seen: "2026-03-10T10:00:00Z",
          total_tokens: 20000,
          input_tokens: 12000,
          output_tokens: 6000,
          cached_input_tokens: 2000,
          reasoning_output_tokens: 0,
          sources: "opencode",
          models: "o3",
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));
      const body = await res.json();

      expect(body.devices[0].alias).toBe("MacBook");
      expect(body.devices[1].alias).toBeNull();
    });

    it("should include device_id = 'default' in results", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "default",
          alias: null,
          first_seen: "2026-01-01T00:00:00Z",
          last_seen: "2026-02-28T23:59:00Z",
          total_tokens: 200000,
          input_tokens: 120000,
          output_tokens: 60000,
          cached_input_tokens: 20000,
          reasoning_output_tokens: 0,
          sources: "claude-code",
          models: "claude-sonnet-4-20250514",
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([
        {
          device_id: "default",
          source: "claude-code",
          model: "claude-sonnet-4-20250514",
          input_tokens: 120000,
          output_tokens: 60000,
          cached_input_tokens: 20000,
        },
      ]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-01-01", to: "2026-03-01" }));
      const body = await res.json();

      expect(body.devices).toHaveLength(1);
      expect(body.devices[0].device_id).toBe("default");
    });

    it("should return sources and models as arrays", async () => {
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: null,
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 50000,
          input_tokens: 30000,
          output_tokens: 15000,
          cached_input_tokens: 5000,
          reasoning_output_tokens: 0,
          sources: "claude-code,opencode",
          models: "claude-sonnet-4-20250514,o3",
        },
      ]);
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([]);
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));
      const body = await res.json();

      expect(Array.isArray(body.devices[0].sources)).toBe(true);
      expect(body.devices[0].sources).toEqual(["claude-code", "opencode"]);
      expect(Array.isArray(body.devices[0].models)).toBe(true);
      expect(body.devices[0].models).toEqual(["claude-sonnet-4-20250514", "o3"]);
    });

    it("should return 500 on D1 error", async () => {
      mockDbRead.getDeviceSummary.mockRejectedValueOnce(new Error("D1 down"));

      const res = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" }));

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Failed to query");
    });
  });

  describe("pricing integration", () => {
    beforeEach(() => {
      vi.mocked(resolveUser).mockResolvedValue({
        userId: "u1",
        email: "test@example.com",
      });
    });

    it("should use static pricing for known models", async () => {
      // Summary
      mockDbRead.getDeviceSummary.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          alias: null,
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-03-10T12:00:00Z",
          total_tokens: 2_000_000,
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
          sources: "claude-code",
          models: "claude-sonnet-4-20250514",
        },
      ]);
      // Cost detail
      mockDbRead.getDeviceCostDetails.mockResolvedValueOnce([
        {
          device_id: "aaaa-1111",
          source: "claude-code",
          model: "claude-sonnet-4-20250514",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cached_input_tokens: 0,
        },
      ]);
      // Timeline
      mockDbRead.getDeviceTimeline.mockResolvedValueOnce([]);

      const res = await GET(
        makeGetRequest("/api/usage/by-device", { from: "2026-03-01", to: "2026-03-11" })
      );
      const body = await res.json();

      // Static pricing for claude-sonnet-4: (1M * $3/1M) + (1M * $15/1M) = $18
      expect(res.status).toBe(200);
      expect(body.devices[0].estimated_cost).toBe(18);
    });
  });
});

describe("GET /api/usage/by-device — request fan-out", () => {
  let mockDbRead: ReturnType<typeof createMockDbRead>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead = createMockDbRead();
    mockDbRead.getDynamicPricing.mockResolvedValue({ entries: [], servedFrom: "baseline" });
    vi.mocked(dbModule.getDbRead).mockResolvedValue(mockDbRead as any);
  });

  // Four independent reads on one page load. Awaiting them one at a time
  // costs four round trips where one does; a Promise.all leaves all four in
  // flight at once. Asserting on the peak in-flight count is deterministic,
  // unlike a wall-clock threshold.
  it("keeps every independent RPC in flight at the same time", async () => {
    vi.mocked(resolveUser).mockResolvedValue({ userId: "u1", email: "test@example.com" });
    let inFlight = 0;
    let peak = 0;
    const track = <T>(value: T) =>
      new Promise<T>((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          resolve(value);
        }, 5);
      });
    mockDbRead.getDeviceSummary.mockImplementation(() => track([] as never));
    mockDbRead.getDeviceCostDetails.mockImplementation(() => track([] as never));
    mockDbRead.getDeviceTimeline.mockImplementation(() => track([] as never));
    mockDbRead.getDynamicPricing.mockImplementation(() => track({ entries: [], servedFrom: "baseline" } as never));

    const response = await GET(makeGetRequest("/api/usage/by-device", { from: "2026-09-01", to: "2026-09-02" }));
    expect(response.status).toBe(200);
    expect(peak).toBe(4);
  });
});
