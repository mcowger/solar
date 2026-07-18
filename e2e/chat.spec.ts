import { expect, test } from "@playwright/test";

const DEV_EMAIL = "admin@solar.local";
const DEV_PASSWORD = "password";

test("signs in and streams a mock chat response", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("Email").fill(DEV_EMAIL);
  await page.getByPlaceholder("Password (min 8)").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeVisible();

  const prompt = "Hello from the browser test";
  await composer.fill(prompt);
  await page.getByTitle("Send").click();

  const response = page.locator(".solar-assistant-output");
  await expect(response).toContainText("Mock reply", { timeout: 20_000 });
  await expect(response).toContainText(prompt);
  await response.getByText("4 Sources", { exact: true }).click();
  await expect(response.getByRole("link", { name: "React documentation" })).toBeVisible();
});
