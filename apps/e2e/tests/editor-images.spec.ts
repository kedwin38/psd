import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { buildNestedPsdBuffer, NESTED_RECTS } from "../fixtures/make-nested-psd";
import { resetDatabase } from "../fixtures/grant-role";
import { navigate, pixelAt, registerAdmin, registerUser, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * A plain end user (not the admin who published) sees every template image on the editor canvas, on first open and
 * after a full reload, including a template whose photo placeholder is an empty smart object; a photo they upload into
 * that placeholder shows too. Scene coordinates refer to make-nested-psd.ts.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const rgba = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
const GREEN = [34, 170, 85, 255];
const { background, stripe, deepStar, logoSlot } = NESTED_RECTS;
const logoCenter = [(logoSlot.left + logoSlot.right) / 2, (logoSlot.top + logoSlot.bottom) / 2] as const;

async function expectTemplateImages(page: Page) {
  await expect(page.getByRole("img", { name: "Template canvas" })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => pixelAt(page, 390, 290)).toEqual(rgba(background.color));
  await expect.poll(() => pixelAt(page, 200, (stripe.top + stripe.bottom) / 2)).toEqual(rgba(stripe.color));
  await expect.poll(() => pixelAt(page, (deepStar.left + deepStar.right) / 2, (deepStar.top + deepStar.bottom) / 2)).toEqual(rgba(deepStar.color));
  // Every image has settled by now, so a "failed to load" chip would be showing.
  await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0);
}

test("end users see every template image and their own uploads on the editor canvas", async ({ page, context, browser }) => {
  test.setTimeout(120_000);
  const template = "Image Check";

  await test.step("an admin publishes the template straight from the library", async () => {
    await registerAdmin(page, context, "images-admin@example.com");
    await uploadTemplate(page, template, buildNestedPsdBuffer());
    const publish = templateCard(page, template).getByRole("button", { name: `Publish ${template} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await publish.click();
    await expect(templateCard(page, template).locator("h3 .badge")).toHaveText("PUBLISHED", { timeout: 15_000 });
  });

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const failures: string[] = [];
  user.on("response", (res) => /\/api\/v1\/.*(layer-assets|\/assets)\//.test(res.url()) && res.status() !== 200 && failures.push(`${res.status()} ${res.url()}`));

  await test.step("an end user starts a project: every template layer's image is on the canvas", async () => {
    await registerUser(user, userContext, "images-user@example.com");
    await navigate(user, "Templates");
    await user.locator(".template-card", { hasText: template }).click();
    await user.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await expectTemplateImages(user);
    // The empty placeholder shows the background through it until a photo is dropped in.
    expect(await pixelAt(user, ...logoCenter)).toEqual(rgba(background.color));
  });

  await test.step("a photo uploaded into the placeholder fills it", async () => {
    const photo = createCanvas(200, 200);
    const ctx = photo.getContext("2d");
    ctx.fillStyle = "#22aa55";
    ctx.fillRect(0, 0, 200, 200);
    const path = join(tmpdir(), `psd-studio-logo-${Date.now()}.png`);
    writeFileSync(path, photo.toBuffer("image/png"));
    await user.getByRole("group", { name: "Logo Slot", exact: true }).locator('input[type="file"]').setInputFiles(path);
    await expect.poll(() => pixelAt(user, ...logoCenter)).toEqual(GREEN);
    await expect(user.getByRole("status", { name: "Save status" })).toHaveText("All changes saved", { timeout: 10_000 });
  });

  await test.step("after a full reload the template images and the upload load again", async () => {
    await user.reload();
    await expectTemplateImages(user);
    await expect.poll(() => pixelAt(user, ...logoCenter)).toEqual(GREEN);
    expect(failures).toEqual([]);
  });
  await userContext.close();
});
