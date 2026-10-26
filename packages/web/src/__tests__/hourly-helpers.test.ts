import { describe, it, expect } from "vitest";
import { toHourlyByDevice, toHourlyByModel, toHourlyByAgent } from "@/lib/usage-helpers";
import type { UsageRow } from "@/hooks/use-usage-data";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    source: "claude-code",
    model: "claude-sonnet-4-20250514",
    hour_start: "2026-03-07T10:00:00Z",
    input_tokens: 1000,
    cached_input_tokens: 200,
    output_tokens: 500,
    reasoning_output_tokens: 0,
    total_tokens: 1700,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toHourlyByDevice
// ---------------------------------------------------------------------------

describe("toHourlyByDevice", () => {
  const defaultDateRange = { from: "2026-03-07", to: "2026-03-07" };

  function point(date: string, device_id: string, total_tokens: number) {
    return { date, device_id, total_tokens };
  }

  it("should return 24-hour structure with empty devices for empty input", () => {
    const result = toHourlyByDevice([], defaultDateRange, 0);

    expect(result).toHaveLength(24);
    expect(result[0]!.hour).toBe(0);
    expect(result[23]!.hour).toBe(23);
    expect(Object.keys(result[0]!.devices)).toHaveLength(0);
  });

  it("should group tokens by hour and device", () => {
    const timeline = [
      point("2026-03-07T10:00:00Z", "device-1", 1000),
      point("2026-03-07T10:30:00Z", "device-1", 500),
      point("2026-03-07T14:00:00Z", "device-2", 2000),
    ];

    const result = toHourlyByDevice(timeline, defaultDateRange, 0);

    expect(result).toHaveLength(24);
    // Hour 10: device-1 = 1500, device-2 = 0
    expect(result[10]!.devices["device-1"]).toBe(1500);
    expect(result[10]!.devices["device-2"]).toBe(0);
    // Hour 14: device-1 = 0, device-2 = 2000
    expect(result[14]!.devices["device-1"]).toBe(0);
    expect(result[14]!.devices["device-2"]).toBe(2000);
  });

  it("should keep devices separate when they share a source and model", () => {
    // The previous (source, model) join attributed both devices' usage to the
    // first device that reported the pair, leaving the second flat at zero.
    const timeline = [
      point("2026-03-07T10:00:00Z", "device-1", 1000),
      point("2026-03-07T10:00:00Z", "device-2", 4000),
    ];

    const result = toHourlyByDevice(timeline, defaultDateRange, 0);

    expect(result[10]!.devices["device-1"]).toBe(1000);
    expect(result[10]!.devices["device-2"]).toBe(4000);
    expect(result[10]!.devices.unknown).toBeUndefined();
  });

  it("should compute daily average over date range", () => {
    // 2 days in range: Mar 7 and Mar 8
    const dateRange = { from: "2026-03-07", to: "2026-03-08" };
    const timeline = [
      point("2026-03-07T10:00:00Z", "device-1", 2000),
      point("2026-03-08T10:00:00Z", "device-1", 4000),
    ];

    const result = toHourlyByDevice(timeline, dateRange, 0);

    // Hour 10: total 6000 / 2 days = 3000 average
    expect(result[10]!.devices["device-1"]).toBe(3000);
  });

  it("should shift hours with timezone offset (UTC-8)", () => {
    // 2026-03-07T18:00Z → PST local = 2026-03-07T10:00 → hour 10
    const timeline = [point("2026-03-07T18:00:00Z", "device-1", 1000)];

    const result = toHourlyByDevice(timeline, defaultDateRange, 480);

    expect(result[10]!.devices["device-1"]).toBe(1000);
    expect(result[18]!.devices["device-1"]).toBe(0);
  });

  it("should zero-fill every known device in hours it has no usage", () => {
    const timeline = [
      point("2026-03-07T10:00:00Z", "device-1", 1000),
      point("2026-03-07T14:00:00Z", "device-2", 2000),
    ];

    const result = toHourlyByDevice(timeline, defaultDateRange, 0);

    expect(Object.keys(result[10]!.devices).sort()).toEqual([
      "device-1",
      "device-2",
    ]);
    expect(result[10]!.devices["device-2"]).toBe(0);
    expect(result[14]!.devices["device-1"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toHourlyByModel
// ---------------------------------------------------------------------------

describe("toHourlyByModel", () => {
  const defaultDateRange = { from: "2026-03-07", to: "2026-03-07" };

  it("should return 24-hour structure with empty models for empty input", () => {
    const result = toHourlyByModel([], defaultDateRange, 0, 5);

    expect(result).toHaveLength(24);
    expect(result[0]!.hour).toBe(0);
    expect(result[23]!.hour).toBe(23);
    expect(Object.keys(result[0]!.models)).toHaveLength(0);
  });

  it("should group tokens by hour and model", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "sonnet", total_tokens: 1000 }),
      makeRow({ hour_start: "2026-03-07T10:30:00Z", model: "sonnet", total_tokens: 500 }),
      makeRow({ hour_start: "2026-03-07T14:00:00Z", model: "opus", total_tokens: 2000 }),
    ];

    const result = toHourlyByModel(rows, defaultDateRange, 0, 5);

    expect(result).toHaveLength(24);
    // Hour 10: sonnet = 1500, opus = 0
    expect(result[10]!.models.sonnet).toBe(1500);
    expect(result[10]!.models.opus).toBe(0);
    // Hour 14: sonnet = 0, opus = 2000
    expect(result[14]!.models.sonnet).toBe(0);
    expect(result[14]!.models.opus).toBe(2000);
  });

  it("should bucket models beyond topN as 'Other'", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-1", total_tokens: 5000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-2", total_tokens: 4000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-3", total_tokens: 3000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-4", total_tokens: 1000 }),
    ];

    // topN=2: model-1 and model-2 are top, model-3 and model-4 go to "Other"
    const result = toHourlyByModel(rows, defaultDateRange, 0, 2);

    expect(result[10]!.models["model-1"]).toBe(5000);
    expect(result[10]!.models["model-2"]).toBe(4000);
    expect(result[10]!.models.Other).toBe(4000); // 3000 + 1000
    expect(result[10]!.models["model-3"]).toBeUndefined();
    expect(result[10]!.models["model-4"]).toBeUndefined();
  });

  it("should compute daily average over date range", () => {
    const dateRange = { from: "2026-03-07", to: "2026-03-08" };
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "sonnet", total_tokens: 2000 }),
      makeRow({ hour_start: "2026-03-08T10:00:00Z", model: "sonnet", total_tokens: 4000 }),
    ];

    const result = toHourlyByModel(rows, dateRange, 0, 5);

    // Hour 10: total 6000 / 2 days = 3000 average
    expect(result[10]!.models.sonnet).toBe(3000);
  });

  it("uses the same recent model selection for hourly averages without dropping older usage", () => {
    const rows = [
      makeRow({ model: "retired", hour_start: "2026-03-01T10:00:00Z", total_tokens: 30_000 }),
      makeRow({ model: "current", hour_start: "2026-03-30T10:30:00Z", total_tokens: 300 }),
    ];
    const result = toHourlyByModel(rows, { from: "2026-03-01", to: "2026-03-30" }, 0, 1);
    expect(result[10]?.models).toEqual({ current: 10, Other: 1000 });
  });

  it("should shift hours with timezone offset (UTC+9 JST)", () => {
    // 2026-03-07T01:00Z → JST local = 2026-03-07T10:00 → hour 10
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T01:00:00Z", model: "sonnet", total_tokens: 1000 }),
    ];

    const result = toHourlyByModel(rows, defaultDateRange, -540, 5);

    expect(result[10]!.models.sonnet).toBe(1000);
    expect(result[1]!.models.sonnet).toBe(0);
  });

  it("should not create 'Other' bucket when models <= topN", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-1", total_tokens: 1000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", model: "model-2", total_tokens: 2000 }),
    ];

    const result = toHourlyByModel(rows, defaultDateRange, 0, 5);

    expect(result[10]!.models["model-1"]).toBe(1000);
    expect(result[10]!.models["model-2"]).toBe(2000);
    expect(result[10]!.models.Other).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toHourlyByAgent
// ---------------------------------------------------------------------------

describe("toHourlyByAgent", () => {
  const defaultDateRange = { from: "2026-03-07", to: "2026-03-07" };

  it("should return 24-hour structure with empty sources for empty input", () => {
    const result = toHourlyByAgent([], defaultDateRange, 0);

    expect(result).toHaveLength(24);
    expect(result[0]!.hour).toBe(0);
    expect(result[23]!.hour).toBe(23);
    expect(Object.keys(result[0]!.sources)).toHaveLength(0);
  });

  it("should group tokens by hour and source", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "claude-code", total_tokens: 1000 }),
      makeRow({ hour_start: "2026-03-07T10:30:00Z", source: "claude-code", total_tokens: 500 }),
      makeRow({ hour_start: "2026-03-07T14:00:00Z", source: "opencode", total_tokens: 2000 }),
    ];

    const result = toHourlyByAgent(rows, defaultDateRange, 0);

    expect(result).toHaveLength(24);
    // Hour 10: claude-code = 1500, opencode = 0
    expect(result[10]!.sources["claude-code"]).toBe(1500);
    expect(result[10]!.sources.opencode).toBe(0);
    // Hour 14: claude-code = 0, opencode = 2000
    expect(result[14]!.sources["claude-code"]).toBe(0);
    expect(result[14]!.sources.opencode).toBe(2000);
  });

  it("should compute daily average over date range", () => {
    const dateRange = { from: "2026-03-07", to: "2026-03-08" };
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "claude-code", total_tokens: 2000 }),
      makeRow({ hour_start: "2026-03-08T10:00:00Z", source: "claude-code", total_tokens: 4000 }),
    ];

    const result = toHourlyByAgent(rows, dateRange, 0);

    // Hour 10: total 6000 / 2 days = 3000 average
    expect(result[10]!.sources["claude-code"]).toBe(3000);
  });

  it("should shift hours with timezone offset (UTC-8)", () => {
    // 2026-03-07T18:00Z → PST local = 2026-03-07T10:00 → hour 10
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T18:00:00Z", source: "claude-code", total_tokens: 1000 }),
    ];

    const result = toHourlyByAgent(rows, defaultDateRange, 480);

    expect(result[10]!.sources["claude-code"]).toBe(1000);
    expect(result[18]!.sources["claude-code"]).toBe(0);
  });

  it("should sort source keys alphabetically", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "opencode", total_tokens: 1000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "claude-code", total_tokens: 2000 }),
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "gemini-cli", total_tokens: 3000 }),
    ];

    const result = toHourlyByAgent(rows, defaultDateRange, 0);

    const sourceKeys = Object.keys(result[10]!.sources);
    expect(sourceKeys).toEqual(["claude-code", "gemini-cli", "opencode"]);
  });

  it("should zero-fill missing hours", () => {
    const rows: UsageRow[] = [
      makeRow({ hour_start: "2026-03-07T10:00:00Z", source: "claude-code", total_tokens: 1000 }),
    ];

    const result = toHourlyByAgent(rows, defaultDateRange, 0);

    // Hour 0 should have claude-code = 0 (zero-filled)
    expect(result[0]!.sources["claude-code"]).toBe(0);
    // Hour 10 should have the actual value
    expect(result[10]!.sources["claude-code"]).toBe(1000);
  });
});
