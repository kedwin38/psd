import { expect, type BrowserContext, type JSHandle, type Page } from "@playwright/test";
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

/**
 * A full page load, which starts by spending a session refresh. The API rate-limits those per IP and the whole suite
 * runs from one IP, so when the suite has used up this minute's, the load waits the limit out and tries again.
 */
async function loadPage(page: Page, load: () => Promise<unknown>): Promise<void> {
  const refreshed = page.waitForResponse((res) => res.url().endsWith("/auth/refresh"));
  await load();
  const res = await refreshed;
  if (res.status() !== 429) return;
  await page.waitForTimeout(Number(res.headers()["retry-after"] ?? 60) * 1000);
  await loadPage(page, () => page.reload());
}

/** Signs up with a passkey, as any end user does; the virtual authenticator also answers later step-ups. */
export async function registerUser(page: Page, context: BrowserContext, email: string, name = "End User"): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await loadPage(page, () => page.goto("/register"));
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Create account with a passkey/i }).click();
  await page.waitForURL("/", { timeout: 15_000 });
}

/** Registers a passkey user and makes them a platform admin. */
export async function registerAdmin(page: Page, context: BrowserContext, email: string): Promise<void> {
  await registerUser(page, context, email, "Canvas Admin");
  await grantRole(email, "SUPER_ADMIN");
  await loadPage(page, () => page.reload());
  await expect(page.getByText("Template Library")).toBeVisible({ timeout: 10_000 });
}

/**
 * In-app navigation: every full page load spends one session refresh, which the API rate-limits per IP, and the whole
 * suite runs from one IP.
 */
export const navigate = (page: Page, link: "Templates" | "Categories" | "Template Library") => page.getByRole("navigation").getByRole("link", { name: link, exact: true }).click();

/** Creates a template from the test PSD in one step (file, name, category) in its own new category; stays on the library. */
export async function uploadTemplate(page: Page, template: string, psd = buildTestPsdBuffer()): Promise<void> {
  await navigate(page, "Categories");
  await page.getByLabel("Name").fill(`${template} Category`);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.locator("td", { hasText: `${template} Category` })).toBeVisible();
  await navigate(page, "Template Library");
  await expect(page.getByRole("heading", { name: "Template library" })).toBeVisible();
  const psdPath = join(tmpdir(), `psd-studio-${template.replace(/\W+/g, "-")}-${Date.now()}.psd`);
  writeFileSync(psdPath, psd);
  await page.getByLabel("PSD file").setInputFiles(psdPath);
  await page.getByLabel("Name").fill(template);
  await page.getByLabel("Category").selectOption({ label: `${template} Category` });
  await page.getByRole("button", { name: "Create template" }).click();
  await expect(templateCard(page, template).locator("tbody tr")).toHaveCount(1);
}

export const templateCard = (page: Page, template: string) => page.locator(".card", { has: page.locator("h3", { hasText: template }) });

/** Registers a passkey admin, uploads the test PSD as a new template, opens its workspace, and waits for the canvas to finish loading. */
export async function openWorkspace(page: Page, context: BrowserContext, { email, template }: { email: string; template: string }): Promise<void> {
  await registerAdmin(page, context, email);
  await uploadTemplate(page, template);
  await templateCard(page, template).locator("tbody button.link").click();
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

/** A DataTransfer holding a PNG of the given size: one color, or left/right halves in two colors. */
export function pngFile(page: Page, width: number, height: number, color: string, rightColor = color, name = "art.png"): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(
    async ([w, h, left, right, fileName]) => {
      const c = new OffscreenCanvas(w as number, h as number);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = left as string;
      ctx.fillRect(0, 0, (w as number) / 2, h as number);
      ctx.fillStyle = right as string;
      ctx.fillRect((w as number) / 2, 0, (w as number) / 2, h as number);
      const dt = new DataTransfer();
      dt.items.add(new File([await c.convertToBlob({ type: "image/png" })], fileName as string, { type: "image/png" }));
      return dt;
    },
    [width, height, color, rightColor, name] as const,
  );
}

/** Drags a file over (and optionally drops it onto) the canvas at a scene point. */
export async function dragOver(page: Page, x: number, y: number, dataTransfer: JSHandle<DataTransfer>, drop = false): Promise<void> {
  const p = await scenePoint(page, x, y);
  const target = page.locator(".scene-canvas");
  await target.dispatchEvent("dragenter", { dataTransfer, clientX: p.x, clientY: p.y });
  await target.dispatchEvent("dragover", { dataTransfer, clientX: p.x, clientY: p.y });
  if (drop) await target.dispatchEvent("drop", { dataTransfer, clientX: p.x, clientY: p.y });
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
