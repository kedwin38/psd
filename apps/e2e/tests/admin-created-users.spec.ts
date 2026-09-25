import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { resetDatabase } from "../fixtures/grant-role";
import { seedTotpAdmin, signInWithPasswordAndTotp, totpCode, type SeededAdmin } from "../fixtures/totp-admin";

/**
 * A super admin creates accounts from the Users page and hands over the password they set. A member signs straight in
 * with it. An account given an admin role signs in with it too, but the whole app gives way to a mandatory
 * authenticator-app setup, which the API enforces on its own: until the setup is done, every other route refuses that
 * session, before and after its 15-minute deadline alike, and it opens up the moment the setup completes.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const codeDialog = (page: Page) => page.getByRole("dialog", { name: "Confirm it's you" });
const createDialog = (page: Page) => page.getByRole("dialog", { name: /Create a user|Account created/ });
const userRow = (page: Page, email: string) => page.getByRole("row").filter({ hasText: email });

async function withDatabase<T>(run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://psdstudio:psdstudio_dev_pw@localhost:5432/psdstudio" });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** Creates an account through the Users page's dialog and step-up; returns the password the dialog hands over. */
async function createUser(page: Page, admin: SeededAdmin, user: { name: string; email: string; role: string; password?: string }): Promise<string> {
  await page.getByRole("button", { name: "Create user" }).click();
  const dialog = createDialog(page);
  await dialog.getByLabel("Full name").fill(user.name);
  await dialog.getByLabel("Email").fill(user.email);
  await dialog.getByLabel("Role").selectOption(user.role);
  if (user.password) {
    await dialog.getByLabel("Initial password").fill(user.password);
  } else {
    await dialog.getByRole("button", { name: "Generate" }).click();
    await expect(dialog.getByLabel("Initial password")).toHaveAttribute("type", "text");
  }
  const typed = await dialog.getByLabel("Initial password").inputValue();
  expect(typed.length).toBeGreaterThanOrEqual(12);
  await dialog.getByRole("button", { name: "Create account" }).click();

  await codeDialog(page).getByLabel("Authenticator code").fill(totpCode(admin.totpSecretBase32));
  await codeDialog(page).getByRole("button", { name: "Confirm" }).click();
  await expect(codeDialog(page)).toHaveCount(0);

  await expect(dialog.getByRole("heading", { name: "Account created" })).toBeVisible();
  const handover = dialog.getByLabel("New account's sign-in details");
  await expect(handover).toContainText(user.email);
  const shown = (await handover.locator("code").textContent())!;
  expect(shown).toBe(typed);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  return shown;
}

/**
 * Signs in on the password form and returns the access token the API answered with. The API allows five password
 * sign-ins a minute per IP and the whole suite shares one, so a 429 waits the limit out and tries again.
 */
async function signInWithPassword(page: Page, email: string, password: string): Promise<string> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a password instead" }).click();
  await page.locator("#email-password").fill(email);
  await page.getByLabel("Password").fill(password);
  for (;;) {
    const answered = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/v1/auth/login/password");
    await page.getByRole("button", { name: "Continue" }).click();
    const res = await answered;
    if (res.status() === 429) {
      await page.waitForTimeout(Number(res.headers()["retry-after"] ?? 60) * 1000);
      continue;
    }
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { mfaRequired: boolean; accessToken?: string };
    expect(body.mfaRequired).toBe(false);
    return body.accessToken!;
  }
}

/** Calls the API directly with a session's access token, as a client that ignores the setup screen would. */
async function asSession(request: APIRequestContext, apiBase: string, token: string, path: string) {
  const res = await request.get(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status(), body: (await res.json()) as { code?: string; detail?: string } };
}

test("a super admin creates a member and an admin; the member signs straight in, the admin must set up an authenticator app first", async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  const admin = seedTotpAdmin("creating-admin@example.com", "Ada Admin");
  const member = { name: "Mo Member", email: "mo@example.com", role: "END_USER" };
  const editor = { name: "Cleo Content", email: "cleo@example.com", role: "CONTENT_ADMIN", password: "cleo-first-password-2026" };
  let apiBase = "";
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith("/api/v1/")) apiBase ||= `${url.origin}/api/v1`;
  });

  await signInWithPasswordAndTotp(page, admin);
  await page.getByRole("link", { name: "Users" }).click();
  await page.waitForURL("/admin/users");

  let memberPassword = "";
  await test.step("the admin creates a member with a generated password, shown once to hand over", async () => {
    memberPassword = await createUser(page, admin, member);
    const row = userRow(page, member.email);
    await expect(row).toContainText(member.name);
    await expect(row.locator(".badge.ACTIVE")).toHaveText("Active");
    await expect(row.getByRole("button", { name: `Remove Member role from ${member.email}` })).toBeVisible();
    await expect(row).toContainText("Not enrolled");
    await expect(page.getByText(memberPassword)).toHaveCount(0);
  });

  await test.step("and a content admin with a password the admin typed", async () => {
    await createUser(page, admin, editor);
    const row = userRow(page, editor.email);
    await expect(row.getByRole("button", { name: `Remove Content admin role from ${editor.email}` })).toBeVisible();
    await expect(row).toContainText("Setup required");
  });

  await test.step("a duplicate email is refused inside the dialog", async () => {
    await page.getByRole("button", { name: "Create user" }).click();
    const dialog = createDialog(page);
    await dialog.getByLabel("Full name").fill("Mo Again");
    await dialog.getByLabel("Email").fill(member.email);
    await dialog.getByLabel("Initial password").fill("another-long-password");
    await dialog.getByRole("button", { name: "Create account" }).click();
    await codeDialog(page).getByLabel("Authenticator code").fill(totpCode(admin.totpSecretBase32));
    await codeDialog(page).getByRole("button", { name: "Confirm" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("An account with this email already exists.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the member signs in with the password alone and never sees an authenticator prompt", async () => {
    const context = await browser.newContext();
    const memberPage = await context.newPage();
    await signInWithPassword(memberPage, member.email, memberPassword);
    await memberPage.waitForURL("/", { timeout: 15_000 });
    await expect(memberPage.getByRole("heading", { name: "Templates" })).toBeVisible();
    await expect(memberPage.getByLabel("6-digit authenticator code")).toHaveCount(0);
    await expect(memberPage.getByRole("heading", { name: "Set up your authenticator app" })).toHaveCount(0);
    await context.close();
  });

  const context = await browser.newContext();
  const editorPage = await context.newPage();
  let token = "";

  await test.step("the content admin signs in with the admin-set password and gets only the setup screen, with its deadline", async () => {
    token = await signInWithPassword(editorPage, editor.email, editor.password);
    await expect(editorPage.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible({ timeout: 15_000 });
    await expect(editorPage.getByRole("status")).toContainText(/Set this up within 1[45]:\d\d\./);
    await expect(editorPage.getByRole("navigation")).toHaveCount(0);
    await expect(editorPage.getByText("Template Library")).toHaveCount(0);
  });

  await test.step("the API itself holds the session, whatever the client does", async () => {
    const held = await asSession(request, apiBase, token, "/templates/admin/all");
    expect(held).toEqual({ status: 403, body: expect.objectContaining({ code: "MFA_SETUP_REQUIRED", detail: "Set up an authenticator app to finish activating this account." }) });
    expect((await asSession(request, apiBase, token, "/projects")).status).toBe(403);
    expect((await asSession(request, apiBase, token, "/auth/me")).status).toBe(200);
  });

  await test.step("past the 15-minute deadline the screen says so and the API still holds the session", async () => {
    await withDatabase((db) => db.query(`UPDATE users SET "mfaSetupDeadline" = now() - interval '1 second' WHERE email = $1`, [editor.email]));
    await editorPage.reload();
    await expect(editorPage.getByRole("alert")).toHaveText("Your 15 minutes to set this up have passed. Your account stays blocked until you finish.");
    await expect(editorPage.getByRole("navigation")).toHaveCount(0);
    const held = await asSession(request, apiBase, token, "/templates/admin/all");
    expect(held.status).toBe(403);
    expect(held.body.detail).toBe("This account's 15 minutes to set up an authenticator app have passed. Set one up to use it again.");
  });

  let secret = "";
  await test.step("enrolling an authenticator app lifts the hold at once", async () => {
    await editorPage.getByRole("button", { name: "Start TOTP enrollment" }).click();
    const manual = await editorPage.getByText("Or enter this secret manually:").textContent();
    secret = manual!.split(":")[1]!.trim();
    await editorPage.getByLabel("6-digit code from your app").fill("000000");
    await editorPage.getByRole("button", { name: "Confirm" }).click();
    await expect(editorPage.locator(".error-box", { hasText: "Invalid TOTP code." })).toBeVisible();
    await editorPage.getByLabel("6-digit code from your app").fill(totpCode(secret));
    await editorPage.getByRole("button", { name: "Confirm" }).click();
    await expect(editorPage.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();

    expect((await asSession(request, apiBase, token, "/templates/admin/all")).status).toBe(200);
    await editorPage.getByRole("button", { name: "Continue to PSD Template Studio" }).click();
    await expect(editorPage.getByRole("navigation").getByText("Template Library")).toBeVisible();
    await expect(editorPage.getByRole("heading", { name: "Set up your authenticator app" })).toHaveCount(0);
  });

  await test.step("from then on, signing in with the password asks for the authenticator code", async () => {
    await editorPage.getByRole("button", { name: "Sign out" }).click();
    await editorPage.waitForURL("/login");
    await signInWithPasswordAndTotp(editorPage, { email: editor.email, password: editor.password, totpSecretBase32: secret });
  });

  await test.step("the Users page now shows the content admin as enrolled", async () => {
    await page.reload();
    await expect(userRow(page, editor.email)).toContainText("Enrolled");
    await expect(userRow(page, editor.email)).not.toContainText("Setup required");
  });

  await context.close();
});
