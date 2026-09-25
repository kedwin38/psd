import { test, expect, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { resetDatabase } from "../fixtures/grant-role";
import { canvas, clickScene, dragOver, openWorkspace, pixelAt, pngFile, row, scenePoint, stage } from "../fixtures/workspace";

/**
 * The end-user editor's live canvas: the project's field values composited in the browser, in-place
 * text editing, drag-and-drop photo replacement with reposition/zoom, show/hide toggles, zoom/pan —
 * and the export rendering the same pixels. Scene coordinates refer to make-test-psd.ts (600x380;
 * Full Name text at 40,260; Title text at 40,305; Photo a 160x160 smart object at 40,40; hidden Watermark on top).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const BLUE_BG = [28, 78, 128, 255];
const GRAY = [136, 136, 136, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const FULL_NAME = { left: 40, top: 255, right: 560, bottom: 300 };

const zoomLevel = async (page: Page) => Number((await page.getByLabel("Zoom level").textContent())!.replace("%", ""));
const notice = (page: Page) => page.locator(".scene-canvas-chip.notice");
const saved = (page: Page) => expect(page.getByRole("status", { name: "Save status" })).toHaveText("All changes saved", { timeout: 10_000 });
const block = (page: Page, label: string) => page.getByRole("group", { name: label, exact: true });
const loaded = (page: Page) => expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });

/** A fingerprint of the composited pixels over a scene rect, to tell whether (and how) a region re-rendered. */
function regionHash(page: Page, r: { left: number; top: number; right: number; bottom: number }): Promise<string> {
  return Promise.all([scenePoint(page, r.left, r.top), scenePoint(page, r.right, r.bottom)]).then(([a, b]) =>
    canvas(page).evaluate(
      (el, [ax, ay, bx, by]) => {
        const c = el as HTMLCanvasElement;
        const box = c.getBoundingClientRect();
        const k = c.width / box.width;
        const d = c.getContext("2d")!.getImageData(Math.floor((ax! - box.left) * k), Math.floor((ay! - box.top) * k), Math.ceil((bx! - ax!) * k), Math.ceil((by! - ay!) * k)).data;
        let hash = 0;
        for (let i = 0; i < d.length; i++) hash = (hash * 31 + d[i]!) | 0;
        return String(hash);
      },
      [a.x, a.y, b.x, b.y],
    ),
  );
}

/** Tightens the rules on a layer's auto-created field through the mapping form. */
async function tuneField(page: Page, layer: string, fieldType: string, rules: Record<string, number> = {}, required?: boolean) {
  await row(page, layer).click();
  const form = page.locator(".mapping-pane form");
  await form.locator("select").first().selectOption(fieldType);
  for (const [label, value] of Object.entries(rules)) await form.getByLabel(label).fill(String(value));
  if (required !== undefined) await form.getByRole("checkbox", { name: /Required/ }).setChecked(required);
  await page.getByRole("button", { name: "Update field" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("data-tip", new RegExp(`edit field “${layer}”`));
}

test("end-user editor: live canvas with in-place editing that matches the export", async ({ page, context }) => {
  test.setTimeout(240_000);

  await test.step("admin locks Title as fixed design, tightens a few fields' rules and publishes; the end user starts a project", async () => {
    await openWorkspace(page, context, { email: "editor-canvas@example.com", template: "Live Badge" });
    await page.getByRole("button", { name: "Lock Title" }).click();
    await expect(row(page, "Title").locator(".badge", { hasText: "field" })).toHaveCount(0);
    await tuneField(page, "Full Name", "TEXT", { "Max length": 60 }, true);
    await tuneField(page, "Photo", "SMART_OBJECT", { "Min width": 200, "Min height": 200 });
    await tuneField(page, "Watermark", "VISIBILITY");
    await expect(row(page, "Background").locator(".badge", { hasText: "field" })).toBeVisible();
    await page.getByRole("button", { name: "Publish this version" }).click();
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
    await page.goto("/");
    await page.locator(".template-card", { hasText: "Live Badge" }).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await loaded(page);
  });
  const projectUrl = page.url();

  await test.step("the canvas composites the template in the browser; no server-rendered preview image", async () => {
    await expect(page.locator(".editor-canvas-pane img")).toHaveCount(0);
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(GRAY);
    expect(await pixelAt(page, 300, 20)).toEqual(BLUE_BG);
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Jane Doe");
  });

  await test.step("only mapped layers are interactive; clicking one selects and reveals its sidebar field", async () => {
    await expect(block(page, "Title")).toHaveCount(0);
    // Title is fixed design: hovering it highlights the background photo field beneath, never Title itself.
    const title = await scenePoint(page, 60, 320);
    await page.mouse.move(title.x, title.y);
    await expect(page.locator(".scene-canvas-chip.hover")).toHaveText("Background");
    await clickScene(page, 60, 280);
    await expect(block(page, "Full Name")).toHaveClass(/selected/);
    await expect(block(page, "Full Name")).toBeFocused();
    await clickScene(page, 120, 120);
    await expect(block(page, "Photo")).toHaveClass(/selected/);
  });

  await test.step("double-click text to edit it in place: the canvas and sidebar update live, with limits enforced", async () => {
    const before = await regionHash(page, FULL_NAME);
    const p = await scenePoint(page, 70, 280);
    await page.mouse.dblclick(p.x, p.y);
    const editor = page.getByRole("textbox", { name: "Edit Full Name on canvas" });
    await expect(editor).toBeFocused();
    await page.keyboard.type("Alice Example");
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Alice Example");
    await expect.poll(() => regionHash(page, FULL_NAME)).not.toBe(before);
    await expect(page.getByRole("status", { name: "Text field status" })).toContainText("13/60");

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect(page.getByRole("status", { name: "Text field status" })).toContainText("required");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("“Full Name” isn't saved until it's fixed");
    await page.keyboard.type("x".repeat(61));
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("x".repeat(60));
    await expect(page.getByRole("status", { name: "Text field status" })).toContainText("60-character limit reached");

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Alice Example");

    // Scrolling over the editor zooms the canvas; the editor follows the text and keeps focus.
    const fitZoom = await zoomLevel(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fitZoom * 1.5);
    await expect(editor).toBeFocused();
    const layerLeft = await scenePoint(page, 40, 260);
    expect(Math.abs((await editor.boundingBox())!.x - layerLeft.x)).toBeLessThan(2);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Alice Example!");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "Fit" }).click();
  });

  await test.step("typing in the sidebar updates the canvas too", async () => {
    const before = await regionHash(page, FULL_NAME);
    await block(page, "Full Name").locator("textarea").fill("Alice Q. Example");
    await expect.poll(() => regionHash(page, FULL_NAME)).not.toBe(before);
    await saved(page);
    // The layer is stored with empty bounds, so its hit area follows the new, longer text, not the authored "Jane Doe".
    await clickScene(page, 120, 120);
    await clickScene(page, 215, 280);
    await expect(block(page, "Full Name")).toHaveClass(/selected/);
  });

  await test.step("drag-and-drop replaces a photo live, with the admin workspace's drop highlight and refusals", async () => {
    const photo = await pngFile(page, 400, 200, "#ff0000", "#0000ff");
    await dragOver(page, 70, 280, photo);
    await expect(notice(page)).toContainText("“Full Name” is a text field");
    // Title is fixed design, so a drop targets whatever lies beneath it, exactly as a click there would.
    await dragOver(page, 60, 320, photo);
    await expect(notice(page)).toHaveText("Drop to replace the image in “Background”");
    await dragOver(page, 120, 120, await pngFile(page, 100, 100, "#00ff00"), true);
    await expect(block(page, "Photo").locator(".field-error")).toContainText("at least 200×200px");
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(GRAY);

    await dragOver(page, 120, 120, photo);
    await expect(notice(page)).toHaveText("Drop to replace the image in “Photo”");
    await expect(notice(page)).toHaveClass(/ok/);
    await dragOver(page, 120, 120, photo, true);
    // Cover-fitted without distortion: the middle half of the 2:1 photo fills the square frame.
    await expect.poll(() => pixelAt(page, 60, 120)).toEqual(RED);
    await expect.poll(() => pixelAt(page, 180, 120)).toEqual(BLUE);
    await expect(block(page, "Photo")).toContainText("art.png · 400×200px");
    await saved(page);
  });

  await test.step("double-click the photo to reposition it; the crop saves on release", async () => {
    const p = await scenePoint(page, 120, 120);
    await page.mouse.dblclick(p.x, p.y);
    const crop = page.getByRole("application", { name: /Reposition Photo/ });
    await expect(crop).toBeFocused();
    const to = await scenePoint(page, 180, 120);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    // Slid right by 60px: red now reaches most of the frame, but the photo never uncovers it.
    await expect.poll(() => pixelAt(page, 170, 120)).toEqual(RED);
    expect(await pixelAt(page, 195, 120)).toEqual(BLUE);
    // Scrolling over the photo zooms the photo about the cursor (not the canvas), pushing the red/blue edge out of the frame.
    const zoom = await zoomLevel(page);
    const inRed = await scenePoint(page, 100, 120);
    await page.mouse.move(inRed.x, inRed.y);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => pixelAt(page, 195, 120)).toEqual(RED);
    expect(await zoomLevel(page)).toBe(zoom);
    await page.keyboard.press("Enter");
    await expect(crop).toHaveCount(0);
    await saved(page);
  });

  await test.step("the panel's show/hide switch shows a hidden layer; a visible overlay doesn't block clicks beneath it", async () => {
    await block(page, "Watermark").getByRole("checkbox").check();
    await expect.poll(async () => (await pixelAt(page, 300, 20))[0]).toBeGreaterThan(BLUE_BG[0]! + 20);
    await expect(block(page, "Watermark").getByRole("checkbox")).toBeChecked();
    await clickScene(page, 70, 280);
    await expect(block(page, "Full Name")).toHaveClass(/selected/);
  });

  await test.step("an IMAGE field on a pixel layer takes a dropped photo (through the visible watermark)", async () => {
    await dragOver(page, 300, 20, await pngFile(page, 600, 380, "#00ff00"), true);
    await expect.poll(async () => (await pixelAt(page, 300, 20))[1]).toBeGreaterThan(200);
    await saved(page);
  });

  await test.step("everything persists: after a reload the canvas renders the saved values identically", async () => {
    const hashes = [await regionHash(page, FULL_NAME), await regionHash(page, { left: 0, top: 0, right: 600, bottom: 380 })];
    await page.goto(projectUrl);
    await loaded(page);
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Alice Q. Example");
    await expect.poll(() => pixelAt(page, 170, 120)).toEqual(RED);
    await expect.poll(() => Promise.all([regionHash(page, FULL_NAME), regionHash(page, { left: 0, top: 0, right: 600, bottom: 380 })])).toEqual(hashes);
    await expect(block(page, "Watermark").getByRole("checkbox")).toBeChecked();
  });

  await test.step("scroll/pinch zoom, keys, Space+drag pan and Fit; clicks still land on the right layer when zoomed", async () => {
    const fitZoom = await zoomLevel(page);
    const anchor = await scenePoint(page, 70, 280);
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(fitZoom * 1.5);
    const after = await scenePoint(page, 70, 280);
    expect(Math.abs(after.x - anchor.x)).toBeLessThan(2);
    // Near the photo's bottom edge, so it's still on screen after zooming in around the name below it.
    await clickScene(page, 120, 190);
    await expect(block(page, "Photo")).toHaveClass(/selected/);

    const beforeKeys = await zoomLevel(page);
    await page.locator("body").focus();
    await page.keyboard.press("+");
    await expect.poll(() => zoomLevel(page)).toBeGreaterThan(beforeKeys);

    const panStart = (await stage(page).boundingBox())!;
    await page.mouse.move(anchor.x, anchor.y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(anchor.x + 80, anchor.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    const panned = (await stage(page).boundingBox())!;
    expect(panned.x - panStart.x).toBeCloseTo(80, 0);
    expect(panned.y - panStart.y).toBeCloseTo(40, 0);
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Alice Q. Example");

    await page.getByRole("button", { name: "Fit" }).click();
    await expect.poll(() => zoomLevel(page)).toBe(fitZoom);
  });

  await test.step("the exported PNG has the same pixels the canvas shows for photos, crop and visibility", async () => {
    await page.getByRole("button", { name: /^Export$/ }).click();
    await expect(page.locator(".export-status .badge")).toHaveText("COMPLETE", { timeout: 30_000 });
    const href = await page.locator("a", { hasText: "Download" }).getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    const exported = await loadImage(await res.body());
    expect([exported.width, exported.height]).toEqual([600, 380]);
    const ctx = createCanvas(600, 380).getContext("2d");
    ctx.drawImage(exported, 0, 0);
    for (const [x, y] of [[60, 120], [170, 120], [195, 120], [300, 20], [580, 360]] as const) {
      const live = await pixelAt(page, x, y);
      const out = [...ctx.getImageData(x, y, 1, 1).data];
      live.forEach((v, i) => expect(Math.abs(v - out[i]!), `channel ${i} at ${x},${y}: canvas ${live} vs export ${out}`).toBeLessThanOrEqual(2));
    }
  });
});
