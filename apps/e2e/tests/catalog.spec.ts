import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { resetDatabase } from "../fixtures/grant-role";
import { navigate, registerAdmin, registerUser, templateCard } from "../fixtures/workspace";

/**
 * Catalog management and browsing: an admin nests a subcategory, publishes a template into it and renames it; an end
 * user finds it by drilling into the category tree like a shop's departments; deleting it (behind step-up) takes it
 * out of the gallery.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const PARENT = "Stationery";
const CHILD = "Greeting Cards";
const ORIGINAL = "Birthday Draft";
const RENAMED = "Birthday Card";

const categoryRow = (page: Page, name: string) => page.locator("tbody tr", { has: page.locator(".category-name", { hasText: name }) });
const loaded = (page: Page, card: ReturnType<typeof templateCard>) =>
  expect.poll(() => card.locator(".template-thumb img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 20_000 }).toBeGreaterThan(0);

test("catalog: subcategories, rename, browse by category, delete with step-up", async ({ page, context, browser }) => {
  test.setTimeout(180_000);
  page.on("dialog", (dialog) => dialog.accept());

  await test.step("admin creates a category with a subcategory", async () => {
    await registerAdmin(page, context, "catalog-admin@example.com");
    await navigate(page, "Categories");
    await page.getByLabel("Name").fill(PARENT);
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(categoryRow(page, PARENT)).toBeVisible();
    await page.getByLabel("Name").fill(CHILD);
    await page.getByLabel("Parent (optional)").selectOption({ label: PARENT });
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(categoryRow(page, CHILD).locator(".category-branch")).toBeVisible();

    // The parent can't be moved under its own subcategory, so the editor doesn't offer it.
    await categoryRow(page, PARENT).getByRole("button", { name: "Edit" }).click();
    await expect(page.locator("#edit-category-parent option")).toHaveText(["None (top-level)"]);
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("admin publishes a template into the subcategory", async () => {
    await navigate(page, "Template Library");
    const psdPath = join(tmpdir(), `psd-studio-catalog-${Date.now()}.psd`);
    writeFileSync(psdPath, buildTestPsdBuffer());
    await page.getByLabel("PSD file").setInputFiles(psdPath);
    await page.getByLabel("Name").fill(ORIGINAL);
    await page.getByLabel("Category").selectOption({ label: `${PARENT} › ${CHILD}` });
    await page.getByRole("button", { name: "Create template" }).click();
    const card = templateCard(page, ORIGINAL);
    const publish = card.getByRole("button", { name: `Publish ${ORIGINAL} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    await publish.click();
    await expect(card.locator(".badge", { hasText: "current" })).toBeVisible({ timeout: 15_000 });
    await loaded(page, card);
  });

  await test.step("admin renames the template", async () => {
    await templateCard(page, ORIGINAL).getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Template name").fill(RENAMED);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(templateCard(page, RENAMED).locator(".hint").first()).toHaveText(`${PARENT} › ${CHILD}`);
    await expect(templateCard(page, ORIGINAL)).toHaveCount(0);
  });

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const sidebar = user.getByRole("navigation", { name: "Categories" });
  const breadcrumb = user.getByRole("navigation", { name: "Breadcrumb" });

  await test.step("an end user drills into the subcategory and finds the template", async () => {
    await registerUser(user, userContext, "shopper@example.com");
    await expect(user.getByRole("heading", { name: "All templates", level: 1 })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: CHILD })).toHaveCount(0);

    await sidebar.getByRole("link", { name: PARENT }).click();
    await expect(user).toHaveURL(/\?category=/);
    await expect(user.getByRole("heading", { name: PARENT, level: 1 })).toBeVisible();
    await expect(breadcrumb.getByRole("listitem")).toHaveText(["All templates", PARENT]);
    // A parent category shows everything in its subcategories too.
    await expect(user.locator(".template-card", { hasText: RENAMED })).toBeVisible();
    await expect(user.getByRole("group", { name: `Inside ${PARENT}` }).getByRole("link", { name: CHILD })).toBeVisible();

    await sidebar.getByRole("link", { name: CHILD }).click();
    await expect(user.getByRole("heading", { name: CHILD, level: 1 })).toBeVisible();
    await expect(breadcrumb.getByRole("listitem")).toHaveText(["All templates", PARENT, CHILD]);
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(CHILD);
    await expect(sidebar.getByRole("link", { name: CHILD })).toHaveAttribute("aria-current", "page");
    const card = user.locator(".template-card", { hasText: RENAMED });
    await expect(card.locator(".hint")).toHaveText(CHILD);
    await loaded(user, card);

    await breadcrumb.getByRole("link", { name: PARENT }).click();
    await expect(user.getByRole("heading", { name: PARENT, level: 1 })).toBeVisible();
  });

  await test.step("admin deletes the template, confirming with step-up", async () => {
    const deleted = page.waitForResponse((res) => res.request().method() === "DELETE" && /\/api\/v1\/templates\/[^/]+$/.test(res.url()));
    await templateCard(page, RENAMED).getByRole("button", { name: "Delete" }).click();
    const res = await deleted;
    expect(res.status()).toBe(200);
    expect(res.request().headers()["x-step-up-token"]).toBeTruthy();
    await expect(templateCard(page, RENAMED)).toHaveCount(0);
    await expect(page.locator(".error-box")).toHaveCount(0);
  });

  await test.step("it's gone from the gallery", async () => {
    await user.getByRole("link", { name: "Security settings" }).click();
    await navigate(user, "Templates");
    await expect(user.getByText("No published templates yet")).toBeVisible();
    await expect(user.locator(".template-card")).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: PARENT })).toHaveCount(0);
  });

  await test.step("admin can delete the now-empty categories, subcategory first", async () => {
    await navigate(page, "Categories");
    await categoryRow(page, PARENT).getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".error-box")).toHaveText("This category still has subcategories. Move or delete them first.");
    await categoryRow(page, CHILD).getByRole("button", { name: "Delete" }).click();
    await expect(categoryRow(page, CHILD)).toHaveCount(0);
    await categoryRow(page, PARENT).getByRole("button", { name: "Delete" }).click();
    await expect(categoryRow(page, PARENT)).toHaveCount(0);
    await expect(page.getByText("No categories yet.")).toBeVisible();
  });

  await userContext.close();
});
