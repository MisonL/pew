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
});
