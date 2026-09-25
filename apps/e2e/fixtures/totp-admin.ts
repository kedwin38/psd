import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export interface SeededAdmin {
  email: string;
  password: string;
  totpSecretBase32: string;
}

/**
 * Provisions a SUPER_ADMIN exactly as a real deployment's first admin is: the API's seed-admin bootstrap script,
 * which sets a password and TOTP secret and enrolls no passkey. Needs the built API and the API's DATABASE_URL and
 * PASSWORD_PEPPER in the environment.
 */
export function seedTotpAdmin(email: string, displayName = "Studio Admin"): SeededAdmin {
  const password = "e2e-admin-password-not-secret";
  const out = execFileSync("node", [join(__dirname, "../../api/dist/scripts/seed-admin.js")], {
    env: { ...process.env, ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_DISPLAY_NAME: displayName },
  }).toString();
  const { totpSecretBase32 } = JSON.parse(out.split("SEED_ADMIN_RESULT ")[1]!) as { totpSecretBase32: string };
  return { email, password, totpSecretBase32 };
}

/** The RFC 6238 code an authenticator app shows for this secret right now. */
export function totpCode(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secretBase32].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Signs in through the login page's password + authenticator code path. */
export async function signInWithPasswordAndTotp(page: Page, admin: SeededAdmin): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a password instead" }).click();
  await page.locator("#email-password").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit authenticator code").fill(totpCode(admin.totpSecretBase32));
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("/", { timeout: 15_000 });
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10_000 });
}
