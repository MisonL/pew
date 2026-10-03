import { test, expect, DASHBOARD_USAGE_FIXTURE, DASHBOARD_PRICING_FIXTURE, mockDashboardApis } from "./fixtures";

test.describe("Feature: Compact usage information", () => {
  const pages = [
    ["/dashboard", "Overview information"], ["/daily-usage", "Usage information"],
    ["/hourly-usage", "Usage information"], ["/models", "Usage information"],
    ["/agents", "Usage information"], ["/devices", "Usage information"],
  ] as const;

  for (const [path, label] of pages) {
    test(`keeps explanatory text out of ${path} and offers hover/focus information`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
      const records = DASHBOARD_USAGE_FIXTURE.records.map((row) => ({ ...row,
        hour_start: "2026-09-15T00:00:00.000Z", approximate_tokens: 1644 }));
      await mockDashboardApis(page, { usage: { ...DASHBOARD_USAGE_FIXTURE, records }, pricing: DASHBOARD_PRICING_FIXTURE });
      await page.goto(path);
      const trigger = page.getByRole("button", { name: label, exact: true });
      await expect(trigger).toBeVisible();
      await expect(page.getByText("Costs are estimates, not invoices.", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/tokens have approximate timing|Public price snapshot|hermes:none|reported amount|Cache & cost details/)).toHaveCount(0);
      const main = page.locator("#main-content");
      const before = (await main.boundingBox())!;
      await trigger.hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText("Costs are estimates, not invoices.");
      if (path !== "/devices") await expect(tooltip).toContainText("Some usage times are estimated");
      await expect(tooltip).not.toContainText("1,644");
      expect((await main.boundingBox())!.height).toBe(before.height);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await page.mouse.move(0, 0);
      await trigger.focus();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });
  }

  test("supports tap and dismiss on a small screen without layout overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
    await mockDashboardApis(page, { usage: DASHBOARD_USAGE_FIXTURE, pricing: DASHBOARD_PRICING_FIXTURE });
    await page.goto("/dashboard");
    const trigger = page.getByRole("button", { name: "Overview information", exact: true });
    await trigger.click();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const popup = page.locator('[data-radix-popper-content-wrapper]').filter({ has: tooltip });
    const box = (await popup.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeLessThanOrEqual(780);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("public profiles offer a compact information control without billing diagnostics", async ({ page }) => {
    await mockDashboardApis(page, { usage: DASHBOARD_USAGE_FIXTURE, pricing: DASHBOARD_PRICING_FIXTURE });
    await page.route("**/api/users/info-fixture?*", (route) => route.fulfill({ json: {
      user: { name: "Profile Fixture", nickname: null, image: null, slug: "info-fixture", created_at: "2026-01-01", first_seen: "2026-01-01" },
      ...DASHBOARD_USAGE_FIXTURE,
      records: DASHBOARD_USAGE_FIXTURE.records.map((row) => ({ ...row, approximate_tokens: 1644 })),
    } }));
    await page.goto("/u/info-fixture");
    const trigger = page.getByRole("button", { name: "Usage information", exact: true });
    await expect(trigger).toBeVisible();
    await expect(page.getByText(/Usage, cache.*cost details|Public price snapshot|tokens have approximate timing/)).toHaveCount(0);
    await trigger.hover();
    await expect(page.getByRole("tooltip")).toContainText("Some usage times are estimated");
  });

  test("model prices hide backend state and error details while retaining freshness guidance", async ({ page }) => {
    await mockDashboardApis(page, { usage: DASHBOARD_USAGE_FIXTURE, pricing: DASHBOARD_PRICING_FIXTURE });
    await page.route("**/api/pricing/models", (route) => route.fulfill({ json: {
      entries: [], servedFrom: "baseline", meta: { lastSyncedAt: "2026-01-01", modelCount: 0,
        baselineCount: 0, openRouterCount: 0, modelsDevCount: 0,
        lastErrors: [{ source: "kv", message: "PRIVATE_BACKEND_ERROR", at: "2026-01-01" }] },
    } }));
    await page.goto("/model-prices");
    await expect(page.getByText(/worker-read|baseline JSON|KV cache|PRIVATE_BACKEND_ERROR|Last synced:/)).toHaveCount(0);
    await page.getByRole("button", { name: "Model price information", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toContainText("Some prices may be out of date");
    await expect(page.getByRole("tooltip")).not.toContainText("PRIVATE_BACKEND_ERROR");
  });
});
