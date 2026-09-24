import { test, expect, type Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { publishedFields, resetDatabase } from "../fixtures/grant-role";
import { canvas, dragOver, navigate, openWorkspace, pixelAt, pngFile, registerAdmin, row, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * The fast path: upload a PSD, name it, publish — no field mapping at all. Every unlocked layer becomes an editable
 * field (text → text, pixel/shape/smart object → photo, group/adjustment → show/hide) labelled with its layer name;
 * locked layers, whether locked in Photoshop or in the admin Layers panel, stay fixed design. Scene coordinates refer
 * to make-test-psd.ts (600x380; Full Name text at 40,260; Photo a 160x160 smart object at 40,40).
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const GREEN = [0, 255, 0, 255];
const block = (page: Page, label: string) => page.getByRole("group", { name: label, exact: true });
const saved = (page: Page) => expect(page.getByRole("status", { name: "Save status" })).toHaveText("All changes saved", { timeout: 10_000 });

async function startProject(page: Page, template: string) {
  await navigate(page, "Templates");
  await page.locator(".template-card", { hasText: template }).click();
  await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
  await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
}

test("zero-touch publish: every unlocked layer is editable, Photoshop-locked layers stay fixed", async ({ page, context }) => {
  test.setTimeout(180_000);
  const template = "Zero Touch Badge";

  await test.step("admin uploads a PSD with a Photoshop-locked Title, names it and publishes straight from the library", async () => {
    await registerAdmin(page, context, "zero-touch@example.com");
    await uploadTemplate(page, template, buildTestPsdBuffer({ locked: ["Title"] }));
    const card = templateCard(page, template);
    const publish = card.getByRole("button", { name: `Publish ${template} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await expect(card.locator("tbody td").nth(2)).toHaveText("5");
    await publish.click();
    await expect(card.locator(".badge", { hasText: "current" })).toBeVisible({ timeout: 15_000 });
    await expect(card.locator("h3 .badge")).toHaveText("PUBLISHED");
    expect(page.url()).toMatch(/\/admin\/templates$/);
  });

  await test.step("the published version has one field per unlocked layer, typed by layer kind and labelled with its name", async () => {
    expect(await publishedFields(template)).toEqual([
      ["Card", "VISIBILITY", "Card"],
      ["Card/Watermark", "IMAGE", "Watermark"],
      ["Card/Photo", "IMAGE", "Photo"],
      ["Card/Full Name", "TEXT", "Full Name"],
      ["Background", "IMAGE", "Background"],
    ]);
  });

  await test.step("the end user can edit every one of them; the locked Title isn't a field", async () => {
    await startProject(page, template);
    for (const label of ["Card", "Watermark", "Photo", "Full Name", "Background"]) await expect(block(page, label)).toBeVisible();
    await expect(block(page, "Title")).toHaveCount(0);
    await expect(block(page, "Card").getByRole("checkbox")).toBeChecked();

    await block(page, "Full Name").locator("textarea").fill("Alice Example");
    await expect(block(page, "Full Name").locator("textarea")).toHaveValue("Alice Example");
    await dragOver(page, 120, 120, await pngFile(page, 200, 200, "#00ff00"), true);
    await expect.poll(() => pixelAt(page, 120, 120)).toEqual(GREEN);
    await saved(page);
  });

  await test.step("the export reflects the edits", async () => {
    await page.getByRole("button", { name: /^Export$/ }).click();
    await expect(page.locator(".export-status .badge")).toHaveText("COMPLETE", { timeout: 30_000 });
    const res = await page.request.get((await page.locator("a", { hasText: "Download" }).getAttribute("href"))!);
    expect(res.status()).toBe(200);
    const exported = await loadImage(await res.body());
    const ctx = createCanvas(600, 380).getContext("2d");
    ctx.drawImage(exported, 0, 0);
    expect([...ctx.getImageData(120, 120, 1, 1).data]).toEqual(GREEN);
    // "Jane Doe" ends well before x=175 at 28px; the longer "Alice Example" runs past it.
    const band = ctx.getImageData(175, 262, 50, 34).data;
    let light = 0;
    for (let i = 0; i < band.length; i += 4) if (band[i]! > 200 && band[i + 1]! > 200 && band[i + 2]! > 200) light++;
    expect(light).toBeGreaterThan(20);
  });
});

test("zero-touch publish: a layer locked in the admin Layers panel after ingestion is left out", async ({ page, context }) => {
  test.setTimeout(180_000);
  const template = "Locked Later Badge";

  await test.step("admin locks Photo in the workspace, then publishes without touching any field", async () => {
    await openWorkspace(page, context, { email: "locked-later@example.com", template });
    await expect(row(page, "Photo").locator(".badge", { hasText: "field" })).toBeVisible();
    await page.getByRole("button", { name: "Lock Photo", exact: true }).click();
    await expect(row(page, "Photo").locator(".badge", { hasText: "field" })).toHaveCount(0);
    await expect(canvas(page)).toBeVisible();
    await page.getByRole("button", { name: "Publish this version" }).click();
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
  });

  await test.step("Photo isn't a field; every other layer, including the unlocked Title, is", async () => {
    expect(await publishedFields(template)).toEqual([
      ["Card", "VISIBILITY", "Card"],
      ["Card/Watermark", "IMAGE", "Watermark"],
      ["Card/Title", "TEXT", "Title"],
      ["Card/Full Name", "TEXT", "Full Name"],
      ["Background", "IMAGE", "Background"],
    ]);
    await startProject(page, template);
    await expect(block(page, "Title")).toBeVisible();
    await expect(block(page, "Photo")).toHaveCount(0);
  });
});
