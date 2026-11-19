import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// The authenticated leaderboard shell: a session, a team the user belongs to,
// and a stored team scope in localStorage. Only the membership endpoints are
// mocked; the board itself is whatever /api/leaderboard answers.
const SESSION_USER = { id: "scope-user", name: "Scope User", email: "scope@local.invalid", image: null };

async function mockShell(page: Page, opts: { teamsStatus: number }) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const shell: Record<string, unknown> = {
      "/api/auth/session": { user: SESSION_USER, expires: "2099-01-01T00:00:00Z" },
      "/api/admin/check": { isAdmin: false },
      "/api/settings": { ...SESSION_USER, slug: "scope-user", is_public: 1, cli_upgrade_notice_seen_at: "2026-01-01T00:00:00Z" },
      "/api/cli-upgrade-notice": { show: false },
      "/api/organizations/mine": { organizations: [] },
      "/api/teams": opts.teamsStatus === 200
        ? { teams: [{ id: "team-1", name: "Scope Team", slug: "scope-team", invite_code: "aaaa1111", created_by: "scope-user", member_count: 1, logoUrl: null }] }
        : { error: "Failed to load teams" },
      "/api/pricing/models": { entries: [], meta: null, servedFrom: "baseline" },
    };
    if (Object.hasOwn(shell, path)) {
      return route.fulfill({ status: path === "/api/teams" ? opts.teamsStatus : 200, json: shell[path] });
    }
    await route.fulfill({ status: 200, json: { period: "week", scope: "global", entries: [], hasMore: false } });
  });
}

async function storeTeamScope(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("pew:leaderboard:scope", JSON.stringify({ type: "team", id: "team-1" }));
  });
}

test.describe("Feature: Leaderboard scope", () => {
  test("a stored team scope survives a failed membership request and says so", async ({ page }) => {
    // The membership lists are the evidence for "this scope still exists".
    // When they fail both are empty, and treating that as evidence silently
    // downgraded the stored team board to the global one and removed the
    // control. The scope must survive, and the page must admit it is
    // unverified rather than showing a different board without explanation.
    await page.clock.setFixedTime(new Date("2026-11-01T12:00:00Z"));
    await storeTeamScope(page);
    await mockShell(page, { teamsStatus: 500 });

    const boardUrls: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/leaderboard") boardUrls.push(url.toString());
    });

    await page.goto("/leaderboard");
    await expect(page.getByText(/Could not load your teams and organizations/)).toBeVisible();
    // The board is requested for the stored team, not for global.
    await expect.poll(() => boardUrls.map((url) => new URL(url).searchParams.get("team")))
      .toContain("team-1");
  });

  test("a team scope that loads normally shows the team's name in the control", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-01T12:00:00Z"));
    await storeTeamScope(page);
    await mockShell(page, { teamsStatus: 200 });

    await page.goto("/leaderboard");
    await expect(page.getByRole("button", { name: /Scope Team/ })).toBeVisible();
    await expect(page.getByText(/Could not load your teams and organizations/)).toHaveCount(0);
  });
});
