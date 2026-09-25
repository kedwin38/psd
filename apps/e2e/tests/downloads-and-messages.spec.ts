import { test, expect, type Page } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { resetDatabase } from "../fixtures/grant-role";
import { openWorkspace, registerUser } from "../fixtures/workspace";

const galleryCard = (page: Page, template: string) => page.locator(".template-card", { hasText: template });

/**
 * A new user's two free downloads, the "contact an admin" hand-off once they're spent, the admin<->user
 * communication tab both directions (including a high-quality image reply), and an admin topping up a
 * user's allowance so they can download again.
 */
test.beforeAll(async () => {
  await resetDatabase();
});

const TEMPLATE = "Quota Badge";

async function exportOnce(page: Page, expectOk: boolean) {
  await page.getByRole("button", { name: /^Export$/ }).click();
  if (expectOk) {
    await expect(page.locator(".export-status .badge")).toHaveText("COMPLETE", { timeout: 30_000 });
    await page.getByRole("button", { name: "Close" }).click();
  } else {
    await expect(page.locator(".error-box")).toContainText("You've used all your downloads.", { timeout: 10_000 });
  }
}

test("download quota, the hand-off to support, and an admin's top-up", async ({ page, context, browser }) => {
  test.setTimeout(180_000);

  await test.step("admin publishes a template", async () => {
    await openWorkspace(page, context, { email: "quota-admin@example.com", template: TEMPLATE });
    await page.getByRole("button", { name: "Publish this version" }).click();
    await page.waitForURL("/admin/templates", { timeout: 15_000 });
  });

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  let projectUrl = "";

  await test.step("a new end user spends both free downloads", async () => {
    await registerUser(user, userContext, "quota-user@example.com");
    await user.goto("/");
    await galleryCard(user, TEMPLATE).click();
    await user.waitForURL(/\/projects\/.+/, { timeout: 15_000 });
    projectUrl = user.url();
    await expect(user.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });

    await exportOnce(user, true);
    await exportOnce(user, true);
  });

  await test.step("a 3rd download is refused, with a link to contact support", async () => {
    await exportOnce(user, false);
    const link = user.locator(".error-box a", { hasText: "Contact support" });
    await expect(link).toBeVisible();
    await link.click();
    await user.waitForURL("/messages", { timeout: 10_000 });
  });

  await test.step("the user sends a message from the communication tab", async () => {
    await expect(user.getByRole("heading", { name: "Contact support" })).toBeVisible();
    await user.locator(".message-composer textarea").fill("I've used up my downloads — can I get more?");
    await user.getByRole("button", { name: "Send" }).click();
    await expect(user.locator(".message-bubble", { hasText: "I've used up my downloads" })).toBeVisible();
  });

  await test.step("an admin sees the new thread, unread, and replies with a high-quality image", async () => {
    await page.goto("/admin/messages");
    const row = page.locator(".message-thread-row", { hasText: "quota-user@example.com" });
    await expect(row.locator(".badge")).toHaveText("1");
    await row.click();
    await expect(page.locator(".message-bubble", { hasText: "I've used up my downloads" })).toBeVisible();
    // Opening it marked it read.
    await expect(row.locator(".badge")).toHaveCount(0);

    const photo = createCanvas(300, 300);
    const pctx = photo.getContext("2d");
    pctx.fillStyle = "#3366ff";
    pctx.fillRect(0, 0, 300, 300);
    const buffer = photo.toBuffer("image/png");

    await page.locator(".message-composer textarea").fill("Sure — I've added 3 more to your account.");
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach an image" }).click();
    await (await fileChooser).setFiles({ name: "receipt.png", mimeType: "image/png", buffer });
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".message-bubble", { hasText: "Sure — I've added 3 more" })).toBeVisible();
    await expect(page.locator(".message-bubble .message-image")).toBeVisible({ timeout: 10_000 });
  });

  await test.step("the admin grants the user 3 more downloads from the Users page", async () => {
    await page.goto("/admin/users");
    const row = page.getByRole("row").filter({ hasText: "quota-user@example.com" });
    await expect(row).toContainText("2/2");
    await row.getByLabel(/Downloads to add/).fill("3");
    await row.getByRole("button", { name: /Grant downloads/ }).click();
    await expect(row).toContainText("2/5", { timeout: 10_000 });
  });

  await test.step("the user sees the admin's reply and image, and can download again", async () => {
    await user.goto("/messages");
    await expect(user.locator(".message-bubble", { hasText: "Sure — I've added 3 more" })).toBeVisible();
    const image = user.locator(".message-bubble .message-image");
    await expect(image).toBeVisible({ timeout: 10_000 });
    const imageLink = user.locator(".message-image-link");
    await expect(imageLink).toHaveAttribute("href", /.+/);

    await user.goto(projectUrl);
    await expect(user.locator(".scene-canvas-chip.status")).toHaveCount(0, { timeout: 15_000 });
    await exportOnce(user, true);
  });

  await userContext.close();
});
