import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetDatabase } from "../fixtures/grant-role";
import { clickScene, openWorkspace, pixelAt, row } from "../fixtures/workspace";

/**
 * The admin field-mapping workspace's live canvas: client-side compositing from
 * per-layer rasters, canvas <-> layers-panel selection sync, and the panel's
 * eye/lock/filter/collapse controls. Scene coordinates refer to make-test-psd.ts (600x380).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

test("admin workspace: live layered canvas synced with the layers panel", async ({ page, context }) => {
  test.setTimeout(120_000);
  await openWorkspace(page, context, { email: "canvas-admin@example.com", template: "Canvas Badge" });

  // Composited client-side: the background's own color, with the hidden watermark left out.
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
