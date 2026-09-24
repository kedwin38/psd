import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { buildNestedPsdBuffer, NESTED_LAYERS, NESTED_RECTS } from "../fixtures/make-nested-psd";
import { publishedFields, resetDatabase } from "../fixtures/grant-role";
import { navigate, pixelAt, registerAdmin, registerUser, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * A nested PSD published without any mapping. The Layers panel mirrors the PSD's own: every layer (empty ones and ones
 * sharing a name included), in Photoshop's order and nesting; every unlocked layer is editable and only the layers
 * locked in Photoshop (or inside a locked group) stay fixed. A plain end user then sees every template image on the
 * editor canvas, on first open and after a full reload, including a photo they upload into the template's empty smart
 * object placeholder. Scene coordinates refer to make-nested-psd.ts.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const TEMPLATE = "Nested Layers";
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

test("a nested PSD keeps its layers as designed, and end users see all of its images", async ({ page, context, browser }) => {
  test.setTimeout(120_000);

  await test.step("admin uploads the nested PSD and publishes it without touching a layer", async () => {
    await registerAdmin(page, context, "nested@example.com");
    await uploadTemplate(page, TEMPLATE, buildNestedPsdBuffer());
    const publish = templateCard(page, TEMPLATE).getByRole("button", { name: `Publish ${TEMPLATE} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await publish.click();
    await expect(templateCard(page, TEMPLATE).locator("h3 .badge")).toHaveText("PUBLISHED", { timeout: 15_000 });
  });

  await test.step("every unlocked layer with something to show is a field; locked layers and the locked group's contents aren't", async () => {
    expect(await publishedFields(TEMPLATE)).toEqual([
      ["Headline", "TEXT", "Headline"],
      ["Frame", "VISIBILITY", "Frame"],
      ["Frame/Inner", "VISIBILITY", "Inner"],
      ["Frame/Inner/Deep", "VISIBILITY", "Deep"],
      ["Frame/Inner/Deep/Deep Star", "IMAGE", "Deep Star"],
      ["Frame/Inner/Deep/Deep Label", "TEXT", "Deep Label"],
      ["Frame/Inner/Inner Badge", "IMAGE", "Inner Badge"],
      ["Frame/Inner/Empty Group", "VISIBILITY", "Empty Group"],
      ["Stripe", "IMAGE", "Stripe"],
      ["Gallery", "VISIBILITY", "Gallery"],
      ["Gallery/Tile", "IMAGE", "Tile"],
      ["Gallery/Tile", "IMAGE", "Tile"],
      ["Logo Slot", "IMAGE", "Logo Slot"],
    ]);
  });

  await test.step("the Layers panel lists every layer, topmost first, at its depth, with its lock", async () => {
    await templateCard(page, TEMPLATE).locator("tbody button.link").click();
    await expect(page.locator(".mapping-layout")).toBeVisible({ timeout: 15_000 });
    const rows = page.getByRole("tree", { name: "Layers" }).getByRole("treeitem");
    await expect(rows).toHaveCount(NESTED_LAYERS.length);
    const listed = await rows.evaluateAll((els) =>
      els.map((el) => ({
        name: el.querySelector(".layer-name")!.textContent,
        depth: Number(el.getAttribute("aria-level")) - 1,
        locked: el.querySelector(".layer-lock")!.getAttribute("aria-pressed") === "true",
        editable: el.querySelector(".field-pill") !== null,
      })),
    );
    expect(listed.map((r) => [r.name, r.depth])).toEqual(NESTED_LAYERS);
    expect(listed.filter((r) => r.locked).map((r) => r.name)).toEqual(["Frame Border", "Brand", "Background"]);
    expect(listed.filter((r) => !r.editable).map((r) => r.name)).toEqual(["Frame Border", "Brand", "Brand Mark", "Transparent", "Background"]);
    await expect(page.getByRole("treeitem", { name: /Gallery/ })).toHaveClass(/is-hidden/);
  });

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const failures: string[] = [];
  user.on("response", (res) => /\/api\/v1\/.*(layer-assets|\/assets)\//.test(res.url()) && res.status() !== 200 && failures.push(`${res.status()} ${res.url()}`));

  await test.step("an end user starts a project: every template layer's image is on the canvas", async () => {
    await registerUser(user, userContext, "nested-user@example.com");
    await navigate(user, "Templates");
    await user.locator(".template-card", { hasText: TEMPLATE }).click();
    await user.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await expectTemplateImages(user);
    // The empty placeholder shows the background through it until a photo goes in.
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
