import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { resetDatabase } from "../fixtures/grant-role";
import { registerAdmin, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * An admin's access token expires while the template library is polling ingestion, on a slow connection: the next poll
 * tick and a Publish click each get a 401 and need a refresh. Refresh tokens rotate and a replayed one burns its whole
 * family, so a second refresh sent before the first one's new cookie arrives used to log the admin out mid-publish.
 * Expiry is simulated by swapping the stale access token for an invalid one on its way out, so the real API answers
 * 401; refreshes are real and untouched.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const INGEST_POLL_MS = 2000;

/** From now on every request still carrying the current access token gets a real 401, and each response takes longer than a poll tick to arrive. */
async function expireAccessTokenOnSlowNetwork(page: Page, context: BrowserContext) {
  let stale: string | undefined;
  const rejected = new Set<string>();
  let refreshes = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/auth/refresh")) refreshes++;
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/v1/") && !url.pathname.endsWith("/auth/refresh"),
    (route) => {
      const req = route.request();
      const auth = req.headers()["authorization"];
      stale ??= auth;
      if (!auth || auth !== stale) return route.continue();
      rejected.add(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.continue({ headers: { ...req.headers(), authorization: "Bearer expired" } });
    },
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: INGEST_POLL_MS, downloadThroughput: -1, uploadThroughput: -1 });

  return {
    stats: () => ({ refreshes, rejected: [...rejected] }),
    restore: async () => {
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    },
  };
}

test("an expired access token doesn't log the admin out when a poll and Publish refresh at once", async ({ page, context }) => {
  test.setTimeout(120_000);
  await registerAdmin(page, context, "refresh-race@example.com");
  await uploadTemplate(page, "Ready Badge");
  const publish = templateCard(page, "Ready Badge").getByRole("button", { name: "Publish Ready Badge version 1" });
  await expect(publish).toBeVisible({ timeout: 20_000 });

  // A second upload keeps the library polling while the first is published.
  await uploadTemplate(page, "Ingesting Badge");
  const network = await expireAccessTokenOnSlowNetwork(page, context);
  await publish.click();

  await expect(templateCard(page, "Ready Badge").locator(".badge", { hasText: "current" })).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toMatch(/\/admin\/templates$/);
  const { refreshes, rejected } = network.stats();
  expect(rejected).toEqual(expect.arrayContaining(["POST /api/v1/auth/step-up/options", "GET /api/v1/templates/admin/all"]));
  expect(refreshes).toBe(1);

  // The refresh cookie is still good: a full reload restores the session instead of landing on the login page.
  await network.restore();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Template library" })).toBeVisible({ timeout: 10_000 });
  expect(page.url()).toMatch(/\/admin\/templates$/);
});

test("tabs that load at the same moment, as on a browser session restore, all stay signed in", async ({ page, context }) => {
  test.setTimeout(90_000);
  await registerAdmin(page, context, "many-tabs@example.com");
  const tabs = [page, await context.newPage(), await context.newPage()];
  const library = (tab: Page) => expect(tab.getByRole("heading", { name: "Template library" })).toBeVisible({ timeout: 20_000 });
  const latency = async (tab: Page, ms: number) =>
    (await context.newCDPSession(tab)).send("Network.emulateNetworkConditions", { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });

  // Every tab sends its refresh before any other tab's rotated cookie has come back.
  for (const tab of tabs) await latency(tab, 500);
  await Promise.all(tabs.map((tab) => tab.goto("/admin/templates")));
  for (const tab of tabs) await library(tab);

  for (const tab of tabs) await latency(tab, 0);
  await page.reload();
  await library(page);
});
