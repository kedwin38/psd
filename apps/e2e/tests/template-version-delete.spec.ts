import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { resetDatabase } from "../fixtures/grant-role";
import { openWorkspace, templateCard } from "../fixtures/workspace";

/** An admin can delete an old, unused template version, but never the one currently live. */
test.beforeAll(async () => {
  await resetDatabase();
});

const TEMPLATE = "Version Cleanup Badge";

test("admin deletes a previous template version, never the current one", async ({ page, context }) => {
  test.setTimeout(120_000);
  page.on("dialog", (dialog) => dialog.accept());

  await test.step("admin publishes version 1, then uploads and publishes version 2", async () => {
    await openWorkspace(page, context, { email: "version-cleanup-admin@example.com", template: TEMPLATE });
    await page.getByRole("button", { name: "Publish this version" }).click();
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
    await expect(templateCard(page, TEMPLATE).locator("tbody tr")).toHaveCount(1);

    const psdPath = join(tmpdir(), `psd-studio-v2-${Date.now()}.psd`);
    writeFileSync(psdPath, buildTestPsdBuffer());
    await templateCard(page, TEMPLATE).locator('input[type="file"]').setInputFiles(psdPath);
    await expect(templateCard(page, TEMPLATE).locator("tbody tr")).toHaveCount(2, { timeout: 15_000 });

    const v2Row = templateCard(page, TEMPLATE).locator("tbody tr").nth(0);
    await expect(v2Row.locator(".badge.READY")).toBeVisible({ timeout: 15_000 });
    await v2Row.getByRole("button", { name: /^Publish/ }).click();
    await expect(v2Row.locator(".badge.PUBLISHED")).toBeVisible({ timeout: 10_000 });
  });

  await test.step("deleting the now-current version 2 is refused, with a clear reason", async () => {
    const card = templateCard(page, TEMPLATE);
    const v2Row = card.locator("tbody tr").nth(0);
    await expect(v2Row.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  });

  await test.step("deleting the unused version 1 succeeds and removes it from the list", async () => {
    const card = templateCard(page, TEMPLATE);
    const v1Row = card.locator("tbody tr").nth(1);
    await expect(v1Row).toContainText("#1");
    await v1Row.getByRole("button", { name: /^Delete/ }).click();
    await expect(card.locator("tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await expect(card.locator("tbody tr")).toContainText("#2");
  });
});
