import { test, expect } from "@playwright/test";
import { buildNestedPsdBuffer, NESTED_LAYERS } from "../fixtures/make-nested-psd";
import { publishedFields, resetDatabase } from "../fixtures/grant-role";
import { registerAdmin, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * The Layers panel mirrors the PSD's own: every layer (empty ones and ones sharing a name included), in Photoshop's
 * order and nesting. With no manual mapping, publishing makes every unlocked layer editable and only the layers locked
 * in Photoshop (or inside a locked group) stay fixed.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const LOCKED = ["Frame Border", "Brand", "Background"];

test("layers keep the PSD's order and nesting, and only locked layers stay fixed", async ({ page, context }) => {
  test.setTimeout(120_000);
  const template = "Nested Layers";

  await test.step("admin uploads the nested PSD and publishes it without touching a layer", async () => {
    await registerAdmin(page, context, "nested@example.com");
    await uploadTemplate(page, template, buildNestedPsdBuffer());
    const publish = templateCard(page, template).getByRole("button", { name: `Publish ${template} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await publish.click();
    await expect(templateCard(page, template).locator("h3 .badge")).toHaveText("PUBLISHED", { timeout: 15_000 });
  });

  await test.step("every unlocked layer with something to show is a field; locked layers and the locked group's contents aren't", async () => {
    expect(await publishedFields(template)).toEqual([
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
    await templateCard(page, template).locator("tbody button.link").click();
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
    expect(listed.filter((r) => r.locked).map((r) => r.name)).toEqual(LOCKED);
    expect(listed.filter((r) => !r.editable).map((r) => r.name)).toEqual(["Frame Border", "Brand", "Brand Mark", "Transparent", "Background"]);
    await expect(page.getByRole("treeitem", { name: /Gallery/ })).toHaveClass(/is-hidden/);
  });
});
