import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { resetDatabase } from "../fixtures/grant-role";
import { canvas, openWorkspace, pixelAt, registerUser } from "../fixtures/workspace";

/**
 * The admin-configured site watermark: a faint tiled overlay shown over the live composited canvas in both the
 * admin template workspace and the end-user project editor, at the configured opacity — and never, under any
 * circumstance, present in an exported/downloaded file. Scene coordinates refer to make-test-psd.ts (600x380); the
 * background paints solid [28, 78, 128, 255] at (300, 20).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const BLUE_BG = [28, 78, 128, 255];
const watermarkLayer = (page: Page) => page.locator(".scene-canvas-watermark");
const loaded = (page: Page) => expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });

/** A small, fully opaque red PNG, tiled by the overlay — easy to tell apart from the template's own artwork. */
function watermarkPngPath(): string {
  const c = createCanvas(40, 40);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 40, 40);
  const path = join(tmpdir(), `psd-studio-watermark-${Date.now()}.png`);
  writeFileSync(path, c.toBuffer("image/png"));
  return path;
}

/** `locator.fill()` doesn't support <input type="range">, so set its value and fire the events React listens for. */
async function setRange(page: Page, selector: string, value: string) {
  await page.locator(selector).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Asserts a canvas layer's pixel at (x, y) is the tiled red watermark blended at roughly `opacity`. */
async function expectWatermarked(page: Page, x: number, y: number, opacity: number, layer = watermarkLayer(page)) {
  const [r, g, b, a] = await pixelAt(page, x, y, layer);
  expect(r, "watermark red channel").toBeGreaterThan(200);
  expect(g, "watermark green channel").toBeLessThan(40);
  expect(b, "watermark blue channel").toBeLessThan(40);
  expect(a, "watermark alpha channel").toBeGreaterThan(Math.round(opacity * 255) - 35);
  expect(a, "watermark alpha channel").toBeLessThan(Math.round(opacity * 255) + 35);
}

test("site watermark: shown live on both editing canvases at the configured opacity, absent from every export", async ({ page, context, browser }) => {
  test.setTimeout(300_000);
  page.on("dialog", (dialog) => dialog.accept());

  await test.step("admin opens the template workspace; no watermark configured yet, so nothing renders and nothing is fetched", async () => {
    await openWorkspace(page, context, { email: "watermark-admin@example.com", template: "Watermark Badge" });
    await expect(watermarkLayer(page)).toHaveCount(0);
    let imageRequested = false;
    page.on("request", (req) => {
      if (req.url().includes("/settings/watermark/image")) imageRequested = true;
    });
    await page.reload();
    await loaded(page);
    await expect(watermarkLayer(page)).toHaveCount(0);
    expect(imageRequested).toBe(false);
  });
  const workspaceUrl = page.url();

  await test.step("admin uploads a site watermark with a strong opacity from the Settings page", async () => {
    // The template workspace hides the main nav (it owns the whole viewport like any creative tool), so go directly.
    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { name: "Site watermark" })).toBeVisible();
    await expect(page.getByText("No watermark is configured")).toBeVisible();
    await setRange(page, "#watermark-opacity", "0.5");
    await page.getByLabel("Choose a watermark PNG").setInputFiles(watermarkPngPath());
    await expect(page.locator(".watermark-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Remove watermark" })).toBeVisible();
  });

  await test.step("it now shows, tiled, over the admin's own template-workspace canvas", async () => {
    await page.goto(workspaceUrl);
    await loaded(page);
    await expect(watermarkLayer(page)).toBeVisible();
    await expectWatermarked(page, 20, 20, 0.5);
    await expectWatermarked(page, 500, 300, 0.5);
    // Purely a screen overlay: the composited scene underneath is untouched by it.
    expect(await pixelAt(page, 300, 20, canvas(page))).toEqual([...BLUE_BG]);
  });

  await test.step("admin publishes the template so an end user can start a project from it", async () => {
    await page.getByRole("button", { name: "Publish this version" }).click();
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
  });

  let projectUrl = "";
  // A genuinely separate browser context, not just a new tab: sharing `context` would share cookies (the refresh
  // token) with the admin's `page`, silently logging it in as this end user on its next navigation.
  const userContext = await browser.newContext();
  await test.step("a separate end user's project editor canvas shows the same watermark", async () => {
    const userPage = await userContext.newPage();
    await registerUser(userPage, userContext, "watermark-user@example.com", "Watermark User");
    await userPage.locator(".template-card", { hasText: "Watermark Badge" }).click();
    await userPage.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await loaded(userPage);
    await expect(watermarkLayer(userPage)).toBeVisible();
    await expectWatermarked(userPage, 20, 20, 0.5);
    expect(await pixelAt(userPage, 300, 20, canvas(userPage))).toEqual([...BLUE_BG]);
    projectUrl = userPage.url();

    await test.step("...and the exported PNG has no trace of it", async () => {
      await userPage.getByRole("button", { name: /^Export$/ }).click();
      await expect(userPage.locator(".export-status .badge")).toHaveText("COMPLETE", { timeout: 30_000 });
      const href = await userPage.locator("a", { hasText: "Download" }).getAttribute("href");
      const res = await userPage.request.get(href!);
      expect(res.status()).toBe(200);
      const exported = await loadImage(await res.body());
      const c = createCanvas(exported.width, exported.height);
      c.getContext("2d").drawImage(exported, 0, 0);
      // Sampled wherever a tile of the (large, opaque) watermark would sit if it had leaked into the render.
      for (const [x, y] of [[20, 20], [300, 20], [500, 300]] as const) {
        const [r, g, b, a] = [...c.getContext("2d").getImageData(x, y, 1, 1).data];
        expect([r, g, b, a], `export pixel at ${x},${y} must be the clean scene color, never the red watermark`).toEqual([...BLUE_BG]);
      }
    });
    await userPage.close();
  });

  await test.step("admin adjusts opacity and removes the watermark; both take effect without a reload", async () => {
    await page.goto("/admin/settings");
    await setRange(page, "#watermark-opacity", "0.2");
    await page.getByRole("button", { name: "Save opacity" }).click();
    await expect(page.locator(".watermark-preview-tiles")).toHaveCSS("opacity", "0.2", { timeout: 10_000 });

    await page.getByRole("button", { name: "Remove watermark" }).click();
    await expect(page.getByText("No watermark is configured")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Remove watermark" })).toHaveCount(0);

    // Client-side navigation back to the workspace (no browser reload): the removal is already live.
    await page.getByRole("link", { name: "Template Library" }).click();
    await page.locator(".card", { has: page.locator("h3", { hasText: "Watermark Badge" }) }).locator("tbody button.link").click();
    await page.waitForURL(/\/admin\/templates\/.+\/versions\/.+/, { timeout: 15_000 });
    await loaded(page);
    await expect(watermarkLayer(page)).toHaveCount(0);
  });

  await test.step("and it's gone from the end user's editor too, once reopened", async () => {
    const userPage = await userContext.newPage();
    await userPage.goto(projectUrl);
    await loaded(userPage);
    await expect(watermarkLayer(userPage)).toHaveCount(0);
    await userPage.close();
  });

  await userContext.close();
});
