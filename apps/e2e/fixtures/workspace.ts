import { expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestPsdBuffer } from "./make-test-psd";
import { grantRole } from "./grant-role";

/** Scene size of make-test-psd.ts. */
export const SCENE = { width: 600, height: 380 };

export const canvas = (page: Page) => page.getByRole("img", { name: "Template canvas" });
export const overlay = (page: Page) => page.locator(".scene-canvas-overlay");
export const stage = (page: Page) => page.locator(".scene-canvas-stage");
export const row = (page: Page, name: string) => page.locator(".layer-row", { has: page.locator(".layer-name", { hasText: new RegExp(`^${name}$`) }) });

/** Registers a passkey admin, uploads the test PSD as a new template, and waits for the workspace canvas to finish loading. */
export async function openWorkspace(page: Page, context: BrowserContext, { email, template }: { email: string; template: string }): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await page.goto("/register");
  await page.getByLabel("Full name").fill("Canvas Admin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Create account with a passkey/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });
  await grantRole(email, "SUPER_ADMIN");
  await page.reload();
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10_000 });

  await page.goto("/admin/categories");
  await page.getByLabel("Name").fill(`${template} Category`);
  await page.getByRole("button", { name: "Create category" }).click();
  await page.goto("/admin/templates");
  await page.getByLabel("Name").fill(template);
  await page.getByLabel("Category").selectOption({ label: `${template} Category` });
  await page.getByRole("button", { name: "Create template" }).click();
  const psdPath = join(tmpdir(), `psd-studio-${template.replace(/\W+/g, "-")}-${Date.now()}.psd`);
  writeFileSync(psdPath, buildTestPsdBuffer());
  await page.locator('input[type="file"]').setInputFiles(psdPath);
  await page.waitForURL(/\/admin\/templates\/.+\/versions\/.+/, { timeout: 15_000 });
  await expect(async () => {
    if ((await page.locator(".mapping-layout").count()) === 0) await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".mapping-layout")).toBeVisible();
  }).toPass({ timeout: 15_000, intervals: [500] });
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
}

/** Viewport (client) position of a scene point, wherever the canvas is currently zoomed/panned to. */
export async function scenePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await stage(page).boundingBox())!;
  return { x: box.x + (x / SCENE.width) * box.width, y: box.y + (y / SCENE.height) * box.height };
}

export async function clickScene(page: Page, x: number, y: number): Promise<void> {
  const p = await scenePoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

/** RGBA of the given canvas (composited scene by default) under a scene point. */
export async function pixelAt(page: Page, x: number, y: number, layer = canvas(page)): Promise<number[]> {
  const p = await scenePoint(page, x, y);
  return layer.evaluate(
    (el, [cx, cy]) => {
      const c = el as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const px = Math.floor(((cx! - r.left) / r.width) * c.width);
      const py = Math.floor(((cy! - r.top) / r.height) * c.height);
      return [...c.getContext("2d")!.getImageData(px, py, 1, 1).data];
    },
    [p.x, p.y],
  );
}
