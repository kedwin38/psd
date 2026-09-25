import { test, expect, type Page } from "@playwright/test";
import { buildNestedPsdBuffer, NESTED_RECTS } from "../fixtures/make-nested-psd";
import { resetDatabase } from "../fixtures/grant-role";
import { canvas, clickScene, navigate, registerAdmin, registerUser, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * The end-user editor lists fields under the PSD groups that hold their layers: nested and indented as in the PSD,
 * with collapsible group headers, no header for a group with nothing editable in it (the locked Brand), and a
 * selection made on the canvas opening and lighting up the groups around its field. Scene coordinates refer to
 * make-nested-psd.ts.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const TEMPLATE = "Grouped Fields";
const { deepStar, stripe } = NESTED_RECTS;

const panel = (page: Page) => page.getByRole("complementary", { name: "Fields panel" }).locator(".panel-body");
const block = (page: Page, label: string) => page.getByRole("group", { name: label, exact: true });
const header = (page: Page, group: string) => page.getByRole("button", { name: new RegExp(`^${group}, \\d+ fields?$`) });
const section = (page: Page, group: string) => page.locator(".field-group", { has: header(page, group) }).last();
const litGroups = (page: Page) => page.locator(".field-group.holds-selection > .field-group-head .field-group-name").allTextContents();

/** The panel as [name, depth] rows, a group's header as "group:<name>". */
function outline(page: Page): Promise<[string, number][]> {
  return panel(page).evaluate((root) => {
    const rows: [string, number][] = [];
    const walk = (el: Element, depth: number) => {
      for (const child of el.children) {
        if (child.classList.contains("field-block")) rows.push([child.getAttribute("aria-label")!, depth]);
        else if (child.classList.contains("field-group")) {
          rows.push([`group:${child.querySelector(":scope > .field-group-head .field-group-name")!.textContent}`, depth]);
          walk(child.querySelector(":scope > .field-group-body")!, depth + 1);
        }
      }
    };
    walk(root, 0);
    return rows;
  });
}

test("end-user editor groups fields by their PSD groups, collapsibly, and reveals the selected field's groups", async ({ page, context, browser }) => {
  test.setTimeout(120_000);

  await test.step("admin publishes the nested PSD as-is", async () => {
    await registerAdmin(page, context, "groups-admin@example.com");
    await uploadTemplate(page, TEMPLATE, buildNestedPsdBuffer());
    const publish = templateCard(page, TEMPLATE).getByRole("button", { name: `Publish ${TEMPLATE} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await publish.click();
    await expect(templateCard(page, TEMPLATE).locator("h3 .badge")).toHaveText("PUBLISHED", { timeout: 15_000 });
  });

  // Short enough that the fields panel scrolls.
  const userContext = await browser.newContext({ viewport: { width: 1280, height: 640 } });
  const user = await userContext.newPage();

  await test.step("an end user's field list follows the PSD's groups, three deep, with loose fields at the top level", async () => {
    await registerUser(user, userContext, "groups-user@example.com");
    await navigate(user, "Templates");
    await user.locator(".template-card", { hasText: TEMPLATE }).click();
    await user.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await expect(canvas(user)).toBeVisible({ timeout: 15_000 });
    await expect(user.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });

    expect(await outline(user)).toEqual([
      ["Headline", 0],
      ["group:Frame", 0],
      ["Frame", 1],
      ["group:Inner", 1],
      ["Inner", 2],
      ["group:Deep", 2],
      ["Deep", 3],
      ["Deep Star", 3],
      ["Deep Label", 3],
      ["Inner Badge", 2],
      ["Empty Group", 2],
      ["Stripe", 0],
      ["group:Gallery", 0],
      ["Gallery", 1],
      ["Tile", 1],
      ["Tile", 1],
      ["Logo Slot", 0],
    ]);
    // Brand holds only locked layers, so it gets no header; Empty Group has nothing inside, so it's just its own card.
    await expect(user.locator(".field-group-name", { hasText: "Brand" })).toHaveCount(0);
    await expect(header(user, "Frame")).toHaveAccessibleName("Frame, 7 fields");
    await expect(header(user, "Deep")).toHaveAccessibleName("Deep, 3 fields");

    const left = async (label: string) => (await block(user, label).boundingBox())!.x;
    const [headline, frame, badge, star] = await Promise.all(["Headline", "Frame", "Inner Badge", "Deep Star"].map(left));
    expect(frame).toBeGreaterThan(headline!);
    expect(badge).toBeGreaterThan(frame!);
    expect(star).toBeGreaterThan(badge!);
  });

  await test.step("collapsing a group hides its fields and only its fields; expanding shows them again", async () => {
    await header(user, "Deep").click();
    await expect(header(user, "Deep")).toHaveAttribute("aria-expanded", "false");
    for (const label of ["Deep", "Deep Star", "Deep Label"]) await expect(block(user, label)).toBeHidden();
    for (const label of ["Inner", "Inner Badge", "Empty Group", "Headline"]) await expect(block(user, label)).toBeVisible();

    await header(user, "Deep").click();
    await expect(header(user, "Deep")).toHaveAttribute("aria-expanded", "true");
    for (const label of ["Deep", "Deep Star", "Deep Label"]) await expect(block(user, label)).toBeVisible();

    await header(user, "Frame").click();
    for (const label of ["Frame", "Inner", "Deep Star", "Inner Badge", "Empty Group"]) await expect(block(user, label)).toBeHidden();
    await expect(header(user, "Inner")).toBeHidden();
    await expect(block(user, "Stripe")).toBeVisible();
  });

  await test.step("clicking a layer on the canvas opens its collapsed groups, lights them up, and scrolls to its field", async () => {
    await panel(user).evaluate((el) => el.scrollTo(0, el.scrollHeight));
    // The star's lower right corner, clear of the show/hide chips pinned over its group's top left.
    await clickScene(user, deepStar.right - 5, deepStar.bottom - 5);

    await expect(block(user, "Deep Star")).toHaveClass(/selected/);
    await expect(block(user, "Deep Star")).toBeFocused();
    await expect(block(user, "Deep Star")).toBeInViewport();
    for (const group of ["Frame", "Inner", "Deep"]) await expect(header(user, group)).toHaveAttribute("aria-expanded", "true");
    expect(await litGroups(user)).toEqual(["Frame", "Inner", "Deep"]);
    await expect(section(user, "Gallery")).not.toHaveClass(/holds-selection/);  });

  await test.step("a collapsed group still shows it holds the selection; selecting a loose field lights no group", async () => {
    await header(user, "Frame").click();
    await expect(block(user, "Deep Star")).toBeHidden();
    await expect(section(user, "Frame")).toHaveClass(/holds-selection/);

    await clickScene(user, 300, (stripe.top + stripe.bottom) / 2);
    await expect(block(user, "Stripe")).toHaveClass(/selected/);
    expect(await litGroups(user)).toEqual([]);
    // A selection elsewhere leaves the user's collapsed group alone.
    await expect(header(user, "Frame")).toHaveAttribute("aria-expanded", "false");
  });

  await userContext.close();
});
