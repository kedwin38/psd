import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { buildTestPsdBuffer } from "../fixtures/make-test-psd";
import { grantRole, resetDatabase } from "../fixtures/grant-role";

/**
 * Drives the actual product end-to-end through a real browser with a CDP
 * virtual WebAuthn authenticator standing in for a hardware passkey:
 * register -> enroll passkey -> (bootstrap admin out-of-band) -> create a
 * category/template -> upload a real PSD -> wait for background ingestion
 * -> map fields by clicking layers -> publish (a fresh step-up passkey
 * ceremony) -> as an end user, start a project -> edit text/photo/visibility
 * fields with live preview -> export -> download the rendered file.
 *
 * This is the spec's single most load-bearing test: every layer of the
 * system (auth, ingestion, compositor, RBAC, async jobs, storage) has to be
 * simultaneously correct for it to pass.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

test("golden path: register, publish a template, and export a customized badge", async ({ page, context }) => {
  test.setTimeout(120_000);

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const email = "admin@example.com";

  await page.goto("/register");
  await page.getByLabel("Full name").fill("Admin User");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Create account with a passkey/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });

  await grantRole(email, "SUPER_ADMIN");
  await page.reload();
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10_000 });

  await page.goto("/admin/categories");
  await page.getByLabel("Name").fill("Employee Badges");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("td", { hasText: "Employee Badges" })).toBeVisible();

  await page.goto("/admin/templates");
  await page.getByLabel("Name").fill("Standard Badge");
  await page.getByLabel("Category").selectOption({ label: "Employee Badges" });
  await page.getByRole("button", { name: "Create template" }).click();
  await expect(page.locator("h3", { hasText: "Standard Badge" })).toBeVisible();

  const psdPath = join(tmpdir(), `psd-studio-e2e-${Date.now()}.psd`);
  writeFileSync(psdPath, buildTestPsdBuffer());
  await page.locator('input[type="file"]').setInputFiles(psdPath);
  await page.waitForURL(/\/admin\/templates\/.+\/versions\/.+/, { timeout: 15_000 });

  await expect(async () => {
    if ((await page.locator(".mapping-layout").count()) === 0) {
      const refreshBtn = page.getByRole("button", { name: "Refresh" });
      if (await refreshBtn.count()) await refreshBtn.click();
    }
    await expect(page.locator(".mapping-layout")).toBeVisible();
  }).toPass({ timeout: 15_000, intervals: [500] });

  async function mapLayer(layerText: string, fieldTypeOption: string) {
    await page.locator(".layer-row", { hasText: layerText }).first().click();
    await page.locator("select").first().selectOption(fieldTypeOption);
    await page.getByRole("button", { name: /Create field|Update field/ }).click();
    await page.waitForTimeout(300);
  }
  await mapLayer("Full Name", "TEXT");
  await mapLayer("Title", "TEXT");
  await mapLayer("Photo", "SMART_OBJECT");
  await mapLayer("Watermark", "VISIBILITY");

  await page.getByRole("button", { name: "Publish this version" }).click();
  await page.waitForURL("/admin/templates", { timeout: 15_000 });

  await page.goto("/");
  await page.locator(".template-card", { hasText: "Standard Badge" }).click();
  await page.waitForURL(/\/projects\/.+/, { timeout: 15_000 });

  const textareas = page.locator("textarea");
  await textareas.nth(0).fill("Alice Example");
  await textareas.nth(1).fill("Principal Engineer");

  const photoCanvas = createCanvas(200, 200);
  const pctx = photoCanvas.getContext("2d");
  pctx.fillStyle = "#22aa55";
  pctx.fillRect(0, 0, 200, 200);
  const photoPath = join(tmpdir(), `psd-studio-e2e-photo-${Date.now()}.png`);
  writeFileSync(photoPath, photoCanvas.toBuffer("image/png"));
  await page.locator('input[type="file"]').first().setInputFiles(photoPath);
  await page.waitForTimeout(600);

  await page.locator('input[type="checkbox"]').first().check();

  // Live preview reflects every edit — spec's central preview/export parity bet.
  await expect(page.locator(".editor-canvas-pane img")).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: /^Export$/ }).click();
  await expect(page.locator(".field-block", { hasText: "Export" }).locator(".badge")).toHaveText("COMPLETE", { timeout: 20_000 });

  const downloadHref = await page.locator("a", { hasText: "Download" }).getAttribute("href");
  expect(downloadHref).toBeTruthy();

  const downloadRes = await page.request.get(downloadHref!);
  expect(downloadRes.status()).toBe(200);
  const bytes = await downloadRes.body();
  expect(bytes.length).toBeGreaterThan(1000);
  // PNG signature.
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
});
