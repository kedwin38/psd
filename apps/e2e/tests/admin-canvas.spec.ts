import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { grantRole, resetDatabase } from "../fixtures/grant-role";

/**
 * The admin field-mapping workspace's live canvas: client-side compositing from
 * per-layer rasters, canvas <-> layers-panel selection sync, and the panel's
 * eye/lock/filter/collapse controls. Scene coordinates refer to make-test-psd.ts (600x380).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const canvas = (page: Page) => page.getByRole("img", { name: "Template canvas" });

async function clickScene(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + (x / 600) * box.width, box.y + (y / 380) * box.height);
}

function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return canvas(page).evaluate(
    (el, [sx, sy]) => {
      const c = el as HTMLCanvasElement;
      const data = c.getContext("2d")!.getImageData(Math.floor((sx! / 600) * c.width), Math.floor((sy! / 380) * c.height), 1, 1).data;
      return [...data];
    },
    [x, y],
  );
}

const row = (page: Page, name: string) => page.locator(".layer-row", { has: page.locator(".layer-name", { hasText: new RegExp(`^${name}$`) }) });

test("admin workspace: live layered canvas synced with the layers panel", async ({ page, context }) => {
  test.setTimeout(120_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  const email = "canvas-admin@example.com";
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Canvas Admin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Create account with a passkey/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });
  await grantRole(email, "SUPER_ADMIN");
  await page.reload();
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10_000 });

  await page.goto("/admin/categories");
  await page.getByLabel("Name").fill("Badges");
  await page.getByRole("button", { name: "Create category" }).click();
  await page.goto("/admin/templates");
  await page.getByLabel("Name").fill("Canvas Badge");
  await page.getByLabel("Category").selectOption({ label: "Badges" });
  await page.getByRole("button", { name: "Create template" }).click();
  const psdPath = join(tmpdir(), `psd-studio-canvas-${Date.now()}.psd`);
  writeFileSync(psdPath, buildTestPsdBuffer());
  await page.locator('input[type="file"]').setInputFiles(psdPath);
  await page.waitForURL(/\/admin\/templates\/.+\/versions\/.+/, { timeout: 15_000 });
  await expect(async () => {
    if ((await page.locator(".mapping-layout").count()) === 0) await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".mapping-layout")).toBeVisible();
  }).toPass({ timeout: 15_000, intervals: [500] });

  // Composited client-side: the background's own color, with the hidden watermark left out.
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => pixelAt(page, 300, 20)).toEqual([28, 78, 128, 255]);
  await expect.poll(() => pixelAt(page, 120, 120)).toEqual([136, 136, 136, 255]);

  // Panel: topmost-first order, detected font badge, filter.
  await expect(page.locator(".layer-name").first()).toHaveText("Card");
  await expect(row(page, "Full Name").locator(".font-badge")).toContainText("ArialMT");
  await expect(row(page, "Full Name").locator(".font-badge")).toHaveAttribute("title", /Detected from PSD/);
  await page.getByLabel("Filter layers").fill("tit");
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await page.getByLabel("Filter layers").fill("");

  // Canvas click selects the topmost layer under the pointer, expanding its collapsed group, and opens the field form.
  await page.getByRole("button", { name: "Collapse Card" }).click();
  await expect(row(page, "Photo")).toHaveCount(0);
  await clickScene(page, 120, 120);
  await expect(row(page, "Photo")).toHaveClass(/selected/);
  await expect(page.locator(".mapping-pane h3", { hasText: "Photo" })).toBeVisible();
  await clickScene(page, 100, 280);
  await expect(page.locator(".mapping-pane h3", { hasText: "Full Name" })).toBeVisible();

  // Locked layers let canvas clicks pass through, and the lock persists.
  await page.getByRole("button", { name: "Lock Background" }).click();
  await clickScene(page, 300, 20);
  await expect(page.locator(".mapping-pane h3", { hasText: "Full Name" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Unlock Background" })).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });

  // Eye toggles re-render the canvas immediately (view-only).
  await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole("button", { name: "Hide Background" }).click();
  await expect.poll(async () => (await pixelAt(page, 300, 20))[3]).toBe(0);
  await page.getByRole("button", { name: "Show Watermark" }).click();
  await expect.poll(async () => pixelAt(page, 300, 20)).toEqual([255, 0, 0, 38]);
  await page.screenshot({ path: join(tmpdir(), "psd-studio-admin-canvas.png") });
});
