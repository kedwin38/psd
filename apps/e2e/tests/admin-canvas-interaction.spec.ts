import { test, expect, type Page } from "@playwright/test";
import { resetDatabase } from "../fixtures/grant-role";
import { clickScene, dragOver, openWorkspace, overlay, pixelAt, pngFile, row, scenePoint, stage } from "../fixtures/workspace";

/**
 * Photoshop-style interaction on the admin workspace canvas: zoom/pan, text-run focus,
 * drag-and-drop replacement of a layer's placeholder image, and undo/redo of workspace actions.
 * Scene coordinates refer to make-test-psd.ts (600x380; Photo is a 160x160 smart object at 40,40).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const zoomLevel = async (page: Page) => Number((await page.getByLabel("Zoom level").textContent())!.replace("%", ""));
const notice = (page: Page) => page.locator(".scene-canvas-chip.notice");
const undoKey = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const redoKey = (page: Page) => page.keyboard.press("ControlOrMeta+Shift+z");


test("admin workspace: zoom/pan, text focus, drag-drop image replacement, undo/redo", async ({ page, context }) => {
  test.setTimeout(180_000);
  await openWorkspace(page, context, { email: "interaction-admin@example.com", template: "Interaction Badge" });
  const gray = [136, 136, 136, 255];
  await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);

  await test.step("scroll-zoom keeps the point under the cursor fixed; keys, pan and fit", async () => {
    const fitZoom = await zoomLevel(page);
    const fitBox = (await stage(page).boundingBox())!;
    const anchor = await scenePoint(page, 120, 120);
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fitZoom * 1.5);
    const zoomedBox = (await stage(page).boundingBox())!;
    expect(zoomedBox.width).toBeGreaterThan(fitBox.width * 1.5);
    const after = await scenePoint(page, 120, 120);
    expect(Math.abs(after.x - anchor.x)).toBeLessThan(2);
    expect(Math.abs(after.y - anchor.y)).toBeLessThan(2);
    // Re-rendered at the new scale, not just stretched: still the photo's color under the cursor.
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);

    const beforeKeys = await zoomLevel(page);
    await page.keyboard.press("+");
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(beforeKeys);
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    await expect.poll(() => zoomLevel(page)).toBeLessThan(beforeKeys);

    // Space+drag pans without selecting anything.
    const panStart = (await stage(page).boundingBox())!;
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(anchor.x + 80, anchor.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    const panned = (await stage(page).boundingBox())!;
    expect(panned.x - panStart.x).toBeCloseTo(80, 0);
    expect(panned.y - panStart.y).toBeCloseTo(40, 0);
    await expect(page.locator(".mapping-pane h3").last()).toHaveText(/Mapped fields/);

    await page.keyboard.press("ControlOrMeta+1");
    await expect(page.getByLabel("Zoom level")).toHaveText("100%");
    await page.getByRole("button", { name: "Fit" }).click();
    await expect.poll(() => zoomLevel(page)).toBe(fitZoom);
    const refit = (await stage(page).boundingBox())!;
    expect(refit.x).toBeCloseTo(fitBox.x, 0);
    expect(refit.width).toBeCloseTo(fitBox.width, 0);
  });

  await test.step("double-click focuses a text layer on its exact glyph bounds", async () => {
    const fitZoom = await zoomLevel(page);
    const p = await scenePoint(page, 70, 280);
    await page.mouse.dblclick(p.x, p.y);
    const focus = page.getByRole("status", { name: "Text layer focus" });
    await expect(focus).toContainText("Run 1 of 1");
    await expect(focus).toContainText("“Jane Doe”");
    await expect(focus).toContainText("ArialMT 28pt");
    await expect(page.locator(".mapping-pane h3", { hasText: "Full Name" })).toBeVisible();
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fitZoom * 2);

    // Back to the whole scene (focus stays): the scrim covers the layer's stored bounds beyond the glyphs, not the glyphs themselves.
    await page.getByRole("button", { name: "Fit" }).click();
    await expect.poll(async () => (await pixelAt(page, 500, 280, overlay(page)))[3]).toBeGreaterThan(80);
    const inside = await pixelAt(page, 70, 280, overlay(page));
    expect(inside[2]).toBeGreaterThan(inside[0]! + 50);

    await page.keyboard.press("Escape");
    await expect(focus).toHaveCount(0);
    await expect(page.locator(".mapping-pane h3", { hasText: "Full Name" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".mapping-pane h3").last()).toHaveText(/Mapped fields/);
  });

  await test.step("drag-and-drop replaces a smart object's placeholder image live, and undo/redo re-points it", async () => {
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const big = await pngFile(page, 200, 200, "#00ff00");

    await dragOver(page, 70, 280, big);
    await expect(notice(page)).toContainText("is a Text layer");
    await dragOver(page, 70, 280, big, true);
    await expect(notice(page)).toContainText("only Pixel and Smart Object layers");
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);

    // A locked layer refuses the drop instead of letting it fall through to the Background beneath.
    await page.getByRole("button", { name: "Lock Photo" }).click();
    await dragOver(page, 120, 120, big, true);
    await expect(notice(page)).toContainText("“Photo” is locked");
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);
    await page.getByRole("button", { name: "Unlock Photo" }).click();

    await dragOver(page, 120, 120, big);
    await expect(notice(page)).toHaveText("Drop to replace the image in “Photo”");
    await expect(notice(page)).toHaveClass(/ok/);
    await expect.poll(async () => (await pixelAt(page, 120, 120, overlay(page)))[1]).toBeGreaterThan(150);

    await dragOver(page, 120, 120, await pngFile(page, 80, 80, "#00ff00"), true);
    await expect(page.locator(".error-box")).toContainText("at least 160x160px");
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);

    await dragOver(page, 120, 120, big, true);
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual([0, 255, 0, 255]);
    await expect(page.locator(".error-box")).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("title", /replace image in “Photo”/);

    await undoKey(page);
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(gray);
    await redoKey(page);
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual([0, 255, 0, 255]);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await page.reload();
    await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual([0, 255, 0, 255]);
  });

  await test.step("field mapping create/update/delete round-trip through undo/redo", async () => {
    const fieldBadge = row(page, "Full Name").locator(".badge", { hasText: "field" });
    await row(page, "Full Name").click();
    await page.getByRole("button", { name: "Create field" }).click();
    await expect(fieldBadge).toBeVisible();

    await undoKey(page);
    await expect(fieldBadge).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create field" })).toBeVisible();
    await redoKey(page);
    await expect(fieldBadge).toBeVisible();
    await expect(page.getByRole("button", { name: "Update field" })).toBeVisible();

    const labelInput = page.locator("form input").nth(0);
    await labelInput.fill("Attendee name");
    await page.getByRole("button", { name: "Update field" }).click();
    await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("title", /edit field “Attendee name”/);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(labelInput).toHaveValue("Full Name");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(labelInput).toHaveValue("Attendee name");

    // Delete removes the selected layer's field for real; undo re-creates it through the API.
    await row(page, "Full Name").click();
    await page.keyboard.press("Delete");
    await expect(fieldBadge).toHaveCount(0);
    await undoKey(page);
    await expect(fieldBadge).toBeVisible();
    await expect(labelInput).toHaveValue("Attendee name");
    await page.reload();
    await expect(fieldBadge).toBeVisible({ timeout: 15_000 });
  });

  await test.step("lock and visibility toggles are undoable too", async () => {
    await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("button", { name: "Lock Background" }).click();
    await expect(page.getByRole("button", { name: "Unlock Background" })).toBeVisible();
    await undoKey(page);
    await expect(page.getByRole("button", { name: "Lock Background" })).toBeVisible();

    await page.getByRole("button", { name: "Hide Background" }).click();
    await expect.poll(async () => (await pixelAt(page, 300, 20))[3]).toBe(0);
    await undoKey(page);
    await expect.poll(() => pixelAt(page, 300, 20)).toEqual([28, 78, 128, 255]);
    await clickScene(page, 300, 20);
    await expect(page.locator(".mapping-pane h3", { hasText: "Background" })).toBeVisible();
  });
});
