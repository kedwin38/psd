import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { resetDatabase } from "../fixtures/grant-role";
import { navigate, registerAdmin, templateCard } from "../fixtures/workspace";

/** PSD uploads show how much of the file has been sent while it's on its way, both for a new template and a new version. */
test.beforeAll(async () => {
  await resetDatabase();
});

const UPLOAD_SECONDS = 3;

/** Slows uploads down to take a few seconds and records every value the upload progress bar shows. */
async function slowUploads(page: Page, context: BrowserContext, bytes: number) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: Math.ceil(bytes / UPLOAD_SECONDS) });
  await page.evaluate(() => {
    const seen: number[] = [];
    Object.assign(window, { uploadProgress: seen });
    setInterval(() => {
      const bar = document.querySelector<HTMLProgressElement>(".upload-progress progress");
      if (bar && seen.at(-1) !== bar.value) seen.push(bar.value);
    }, 20);
  });
  return async () => {
    const seen = await page.evaluate(() => (window as unknown as { uploadProgress: number[] }).uploadProgress.splice(0));
    return seen;
  };
}

const expectRealProgress = (seen: number[]) => {
  expect(seen.length).toBeGreaterThan(3);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.some((percent) => percent > 10 && percent < 90)).toBe(true);
};

test("PSD uploads show live progress for a new template and for a new version", async ({ page, context }) => {
  test.setTimeout(120_000);
  const template = "Progress Badge";
  const psd = buildTestPsdBuffer();
  const psdPath = join(tmpdir(), `psd-studio-progress-${Date.now()}.psd`);
  writeFileSync(psdPath, psd);

  await registerAdmin(page, context, "upload-progress@example.com");
  await navigate(page, "Categories");
  await page.getByLabel("Name").fill("Progress Category");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("td", { hasText: "Progress Category" })).toBeVisible();
  await navigate(page, "Template Library");
  const progress = await slowUploads(page, context, psd.length);

  await test.step("creating a template", async () => {
    await page.getByLabel("PSD file").setInputFiles(psdPath);
    await page.getByLabel("Name").fill(template);
    await page.getByLabel("Category").selectOption({ label: "Progress Category" });
    await page.getByRole("button", { name: "Create template" }).click();

    const bar = page.locator("form").getByRole("progressbar", { name: "Uploading PSD" });
    await expect(bar).toBeVisible();
    await expect(page.locator("form .upload-progress")).toHaveText(/^\d+%$/);
    await expect(bar).toBeHidden({ timeout: 20_000 });
    expectRealProgress(await progress());
    await expect(templateCard(page, template).locator("tbody tr")).toHaveCount(1);
  });

  await test.step("uploading a new version", async () => {
    const card = templateCard(page, template);
    await card.locator('input[type="file"]').setInputFiles(psdPath);

    const bar = card.getByRole("progressbar", { name: "Uploading PSD" });
    await expect(bar).toBeVisible();
    await expect(bar).toBeHidden({ timeout: 20_000 });
    expectRealProgress(await progress());
    await expect(card.locator("tbody tr")).toHaveCount(2);
    // Once the file is in, the existing ingestion status takes over.
    await expect(card.getByRole("button", { name: `Publish ${template} version 2` })).toBeVisible({ timeout: 20_000 });
  });
});
