import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { resetDatabase } from "../fixtures/grant-role";
import { registerUser } from "../fixtures/workspace";

/**
 * The ID photo editor tab: upload a real photo, pick a standard, watch it process through the real
 * face-detection pipeline, and see the compliance checklist and a downloadable result.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const SAMPLE = join(__dirname, "../fixtures/id-photo-sample.jpg");

test("ID photo editor: upload, process, and download against a real photo", async ({ page, context }) => {
  test.setTimeout(60_000);

  await registerUser(page, context, "id-photo-e2e@example.com");
  await page.getByRole("link", { name: "ID Photo Editor" }).click();
  await page.waitForURL("/id-photo");
  await expect(page.getByRole("heading", { name: "ID Photo Editor" })).toBeVisible();

  // US Passport / Visa is selected by default; ICAO is also offered.
  await expect(page.getByText("US Passport / Visa")).toBeVisible();
  await expect(page.getByText("ICAO / Biometric")).toBeVisible();

  await page.getByLabel("Choose a photo").setInputFiles(SAMPLE);
  await expect(page.locator(".id-photo-dropzone-preview")).toBeVisible({ timeout: 10_000 });

  await expect(page.locator(".id-photo-checklist")).toBeVisible({ timeout: 30_000 });
  const checklist = page.locator(".id-photo-checklist li");
  await expect(checklist).toHaveCount(6);
  await expect(checklist.filter({ hasText: "Head size" })).toHaveClass(/pass/);
  await expect(checklist.filter({ hasText: "Eye position" })).toHaveClass(/pass/);
  await expect(checklist.filter({ hasText: "Resolution" })).toContainText("600×600px");

  const download = page.getByRole("link", { name: /Download 600.*px PNG/ });
  await expect(download).toBeVisible();
  await expect(page.locator(".id-photo-result-preview")).toBeVisible();
  const href = await download.getAttribute("href");
  expect(href).toBeTruthy();
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
});

test("ID photo editor: switching to ICAO changes the target spec", async ({ page, context }) => {
  test.setTimeout(60_000);

  await registerUser(page, context, "id-photo-icao-e2e@example.com");
  await page.goto("/id-photo");

  await page.getByText("ICAO / Biometric").click();
  await page.getByLabel("Choose a photo").setInputFiles(SAMPLE);
  await expect(page.locator(".id-photo-checklist")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".id-photo-checklist li").filter({ hasText: "Resolution" })).toContainText("413×531px");
});
