import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentDonutChart, DeviceDonutChart } from "./compact-donut-charts";
import type { DeviceAggregate } from "@pew/core";

function device(id: string, tokens: number): DeviceAggregate {
  return {
    device_id: id,
    alias: null,
    first_seen: "2026-03-01T00:00:00Z",
    last_seen: "2026-03-02T00:00:00Z",
    total_tokens: tokens,
    input_tokens: tokens,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    estimated_cost: 0,
    sources: [],
    models: [],
  };
}

describe("AgentDonutChart", () => {
  it("computes each agent's share of all sources, not just the visible five", () => {
    const sourceTrend = [
      {
        date: "2026-03-01",
        sources: {
          "claude-code": 1000,
          codex: 500,
          opencode: 400,
          grok: 300,
          hermes: 200,
          pi: 100,
        },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(AgentDonutChart, { sourceTrend }),
    );
    // 1000 of 2500 = 40%. Slice-before-sum would report 1000/2400 = 42%.
    expect(html).toContain("40%");
    expect(html).not.toContain("42%");
    // The sixth source stays reachable through the collapsed legend.
    expect(html).toContain("Show all 6 series");
  });
});

describe("DeviceDonutChart", () => {
  it("keeps every device in the chart so arcs and percentages agree", () => {
    const devices = Array.from({ length: 6 }, (_, i) =>
      device(`device-${i + 1}`, 1000),
    );
    const html = renderToStaticMarkup(
      createElement(DeviceDonutChart, { devices }),
    );
    // 1 of 6 = 17% each.
    expect(html.match(/17%/g)).toHaveLength(5);
    // All six devices reach the chart; the legend collapses the sixth.
    expect(html).toContain("Show all 6 series");
  });
});
