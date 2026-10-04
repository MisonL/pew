import { test, expect, watchPageReadiness } from "./fixtures";

test("period and harness navigation refetch populated rankings", async ({ page }) => {
  const health = watchPageReadiness(page);
  await page.goto("/leaderboard");
  await health.ready(["/api/leaderboard?period=week"]);
  await expect(page.getByText("E2E Test User", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Last 30 Days" }).click();
  await health.ready(["/api/leaderboard?period=month"]);
  await expect(page.getByText("1,800,000", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "All Time" }).click();
  await health.ready(["/api/leaderboard?period=all"]);
  await expect(page.getByText("Readiness Peer", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Harness", exact: true }).click();
  await health.ready(["/api/leaderboard?source=claude-code"]);
  await expect(page.getByText("900,000", { exact: true })).toHaveCount(2);
});
