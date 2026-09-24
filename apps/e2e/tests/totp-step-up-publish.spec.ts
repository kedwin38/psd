import { test, expect, type Page } from "@playwright/test";
import { resetDatabase } from "../fixtures/grant-role";
import { seedTotpAdmin, signInWithPasswordAndTotp, totpCode } from "../fixtures/totp-admin";
import { templateCard, uploadTemplate } from "../fixtures/workspace";

/**
 * The production admin signs in with password + authenticator code and has no passkey. Publishing asks for a fresh
 * step-up, which used to be passkey-only: it answered "No passkeys registered", spent a session refresh on that
 * refusal, and never let the admin publish. The step-up now asks such an admin for an authenticator code instead.
 * One sign-in covers both publish buttons: every full page load spends a rate-limited session refresh.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const codeDialog = (page: Page) => page.getByRole("dialog", { name: "Confirm it's you" });

/** Records the auth requests made from now on. */
function watchAuthRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/v1/auth/")) seen.push(`${req.method()} ${path.slice("/api/v1".length)}`);
  });
  return seen;
}

async function enterCode(page: Page, code: string) {
  await codeDialog(page).getByLabel("Authenticator code").fill(code);
  await codeDialog(page).getByRole("button", { name: "Confirm" }).click();
}

test("an admin without a passkey publishes with an authenticator code, from the library and the workspace", async ({ page }) => {
  test.setTimeout(180_000);
  const admin = seedTotpAdmin("totp-admin@example.com");
  await signInWithPasswordAndTotp(page, admin);

  await test.step("library: a wrong code is refused in the dialog, the right one publishes, and the session is never touched", async () => {
    const template = "TOTP Badge";
    await uploadTemplate(page, template);
    const card = templateCard(page, template);
    const publish = card.getByRole("button", { name: `Publish ${template} version 1` });
    await expect(publish).toBeVisible({ timeout: 20_000 });
    const auth = watchAuthRequests(page);

    await publish.click();
    await enterCode(page, "000000");
    await expect(codeDialog(page).getByRole("alert")).toHaveText("Invalid TOTP code.");
    expect(page.url()).toMatch(/\/admin\/templates$/);

    await enterCode(page, totpCode(admin.totpSecretBase32));
    await expect(codeDialog(page)).toHaveCount(0);
    await expect(card.locator(".badge", { hasText: "current" })).toBeVisible({ timeout: 15_000 });
    await expect(card.locator("h3 .badge")).toHaveText("PUBLISHED");
    await expect(page.locator(".error-box")).toHaveCount(0);
    expect(page.url()).toMatch(/\/admin\/templates$/);
    expect(auth).toEqual(["GET /auth/step-up/methods", "POST /auth/step-up/totp", "POST /auth/step-up/totp"]);
  });

  await test.step("workspace: cancelling the dialog leaves the draft alone, confirming publishes it", async () => {
    const template = "TOTP Workspace Badge";
    await uploadTemplate(page, template);
    await expect(templateCard(page, template).getByRole("button", { name: `Publish ${template} version 1` })).toBeVisible({ timeout: 20_000 });
    await templateCard(page, template).locator("tbody button.link").click();
    await page.waitForURL(/\/admin\/templates\/.+\/versions\/.+/, { timeout: 15_000 });
    const publish = page.getByRole("button", { name: "Publish this version" });
    await expect(publish).toBeEnabled({ timeout: 15_000 });

    await publish.click();
    await codeDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(codeDialog(page)).toHaveCount(0);
    await expect(page.locator(".error-box")).toHaveCount(0);
    await expect(publish).toBeEnabled();

    await publish.click();
    await enterCode(page, totpCode(admin.totpSecretBase32));
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
    await expect(templateCard(page, template).locator("h3 .badge")).toHaveText("PUBLISHED");
  });
});
