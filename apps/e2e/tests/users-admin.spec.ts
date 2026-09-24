import { test, expect, type Page } from "@playwright/test";
import { createMember, resetDatabase } from "../fixtures/grant-role";
import { seedTotpAdmin, signInWithPasswordAndTotp, totpCode, type SeededAdmin } from "../fixtures/totp-admin";

/**
 * A super admin manages signed-up accounts from the Users page. Role changes and suspensions are step-up gated, and a
 * suspension is checked for real: the suspended account's open session stops working and it can't sign in again.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const codeDialog = (page: Page) => page.getByRole("dialog", { name: "Confirm it's you" });
const userRow = (page: Page, email: string) => page.getByRole("row").filter({ hasText: email });

async function confirmItsMe(page: Page, admin: SeededAdmin) {
  await codeDialog(page).getByLabel("Authenticator code").fill(totpCode(admin.totpSecretBase32));
  await codeDialog(page).getByRole("button", { name: "Confirm" }).click();
  await expect(codeDialog(page)).toHaveCount(0);
}

test("a super admin grants a role and suspends an account, which locks that account out", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const admin = seedTotpAdmin("users-admin@example.com", "Ada Admin");
  const target = seedTotpAdmin("former-admin@example.com", "Frank Former");
  const member = "designer@example.com";
  await createMember(member, "Dana Designer");

  // The account that is about to be suspended is signed in elsewhere.
  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  await signInWithPasswordAndTotp(targetPage, target);

  await signInWithPasswordAndTotp(page, admin);

  await test.step("the Users page lists everyone who signed up, and search narrows it", async () => {
    await page.getByRole("link", { name: "Users" }).click();
    await page.waitForURL("/admin/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    for (const email of [admin.email, target.email, member]) await expect(userRow(page, email)).toBeVisible();

    const dana = userRow(page, member);
    await expect(dana).toContainText("Dana Designer");
    await expect(dana.locator(".badge.ACTIVE")).toHaveText("Active");
    await expect(dana).toContainText("Member");
    await expect(dana).toContainText("Not enrolled");
    await expect(userRow(page, admin.email)).toContainText("Enrolled");
    await expect(userRow(page, admin.email).getByRole("button", { name: `Suspend ${admin.email}` })).toBeDisabled();

    await page.getByLabel("Search users").fill("DANA");
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(userRow(page, member)).toBeVisible();
    await page.getByLabel("Search users").fill("nobody-matches");
    await expect(page.getByText("No users match “nobody-matches”.")).toBeVisible();
    await page.getByLabel("Search users").fill("");
    await expect(page.getByRole("row")).toHaveCount(4);
  });

  await test.step("granting a role goes through step-up", async () => {
    const dana = userRow(page, member);
    await dana.getByLabel(`Role to add for ${member}`).selectOption("CONTENT_ADMIN");
    await dana.getByRole("button", { name: `Add role for ${member}` }).click();
    await confirmItsMe(page, admin);
    await expect(dana.getByRole("button", { name: `Remove Content admin role from ${member}` })).toBeVisible();
    await expect(dana.getByRole("button", { name: `Remove Member role from ${member}` })).toBeVisible();
    await expect(page.locator(".error-box")).toHaveCount(0);
  });

  await test.step("removing a role goes through step-up too", async () => {
    const frank = userRow(page, target.email);
    await frank.getByRole("button", { name: `Remove Super admin role from ${target.email}` }).click();
    await confirmItsMe(page, admin);
    await expect(frank).toContainText("No roles");
  });

  await test.step("suspending asks for confirmation, then step-up", async () => {
    const frank = userRow(page, target.email);
    const suspend = frank.getByRole("button", { name: `Suspend ${target.email}` });
    const confirm = page.getByRole("dialog", { name: "Suspend Frank Former?" });

    await suspend.click();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(codeDialog(page)).toHaveCount(0);
    await expect(frank.locator(".badge.ACTIVE")).toHaveText("Active");

    await suspend.click();
    await expect(confirm).toContainText(target.email);
    await confirm.getByRole("button", { name: "Suspend account" }).click();
    await confirmItsMe(page, admin);
    await expect(frank.locator(".badge.SUSPENDED")).toHaveText("Suspended");
    await expect(frank.getByRole("button", { name: `Reactivate ${target.email}` })).toBeVisible();
    await expect(page.locator(".error-box")).toHaveCount(0);
  });

  await test.step("the suspended account's open session stops working at once", async () => {
    const refused = targetPage.waitForResponse((res) => new URL(res.url()).pathname === "/api/v1/templates" && res.status() === 401);
    await targetPage.getByRole("link", { name: "Security settings" }).click();
    await targetPage.getByRole("link", { name: "Templates" }).click();
    expect(await (await refused).json()).toMatchObject({ detail: "This account is suspended." });
    await targetPage.waitForURL("/login", { timeout: 15_000 });
  });

  await test.step("and the suspended account can't sign in again", async () => {
    await targetPage.getByRole("button", { name: "Use password + authenticator code instead" }).click();
    await targetPage.locator("#email-password").fill(target.email);
    await targetPage.getByLabel("Password").fill(target.password);
    await targetPage.getByRole("button", { name: "Continue" }).click();
    await expect(targetPage.locator(".error-box")).toHaveText("This account is suspended.");
    await expect(targetPage.getByLabel("6-digit authenticator code")).toHaveCount(0);
    expect(targetPage.url()).toMatch(/\/login$/);
  });

  await targetContext.close();
});
