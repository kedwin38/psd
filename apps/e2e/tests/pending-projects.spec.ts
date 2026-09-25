import { test, expect, type Page } from "@playwright/test";
import { resetDatabase } from "../fixtures/grant-role";
import { navigate, registerAdmin, templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * The gallery's "Your projects" pending cap: an end user can have at most 2 IN_PROGRESS projects at once, can rename
 * and clear (delete) them from the gallery, and the cap blocks a 3rd with a clear, actionable message until one is
 * cleared.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const TEMPLATE = "Pending Cap Badge";
const DEFAULT_NAME = `${TEMPLATE} project`;

const galleryCard = (page: Page, name: string) => page.locator(".template-card", { hasText: name });
const pendingIndicator = (page: Page) => page.locator(".badge.plain");
const projectRow = (page: Page, name: string) => page.locator("tbody tr", { has: page.getByRole("button", { name: `Rename ${name}` }) });
const backToGallery = (page: Page) => page.getByRole("link", { name: "Back to Templates" }).click();

test("pending-project cap: 2 at a time, renamed and cleared from the gallery", async ({ page, context }) => {
  test.setTimeout(120_000);
  page.on("dialog", (dialog) => dialog.accept());

  await test.step("publish a template to start projects from", async () => {
    await registerAdmin(page, context, "cap-admin@example.com");
    await uploadTemplate(page, TEMPLATE);
    const card = templateCard(page, TEMPLATE);
    await card.getByRole("button", { name: `Publish ${TEMPLATE} version 1` }).click();
    await expect(card.locator(".badge", { hasText: "current" })).toBeVisible({ timeout: 15_000 });
  });

  await test.step("starting two projects reaches the 2/2 cap", async () => {
    await navigate(page, "Templates");
    await expect(galleryCard(page, TEMPLATE)).toBeVisible();

    await galleryCard(page, TEMPLATE).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await backToGallery(page);
    await expect(pendingIndicator(page)).toHaveText("1/2 pending");

    await galleryCard(page, TEMPLATE).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await backToGallery(page);
    await expect(pendingIndicator(page)).toHaveText("2/2 pending — clear one to start another");
    await expect(page.locator("tbody tr")).toHaveCount(2);
  });

  await test.step("a 3rd is blocked with a clear, actionable message", async () => {
    await galleryCard(page, TEMPLATE).click();
    await expect(page.locator(".error-box")).toHaveText("You already have 2 pending projects. Clear one to start another.");
    await expect(page).toHaveURL("/");
  });

  await test.step("renaming a project makes it distinguishable", async () => {
    // Both pending projects share the same default name; the most recently touched one sorts first.
    await page.locator("tbody tr").first().getByRole("button", { name: `Rename ${DEFAULT_NAME}` }).click();
    const input = page.getByLabel("Project name");
    await input.fill("Badge For Alice");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "Rename Badge For Alice" })).toBeVisible();
    await expect(page.locator(".error-box")).toHaveCount(0);
  });

  await test.step("clearing the other project frees a slot", async () => {
    await projectRow(page, DEFAULT_NAME).getByRole("button", { name: `Clear ${DEFAULT_NAME}` }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(pendingIndicator(page)).toHaveText("1/2 pending");
    await expect(page.getByRole("button", { name: "Rename Badge For Alice" })).toBeVisible();
  });

  await test.step("a 3rd project can now be started", async () => {
    await galleryCard(page, TEMPLATE).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    await backToGallery(page);
    await expect(pendingIndicator(page)).toHaveText("2/2 pending — clear one to start another");
    await expect(page.locator("tbody tr")).toHaveCount(2);
  });
});
