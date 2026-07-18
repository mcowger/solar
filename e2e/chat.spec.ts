import { expect, test } from "@playwright/test";

const DEV_EMAIL = "admin@solar.local";
const DEV_PASSWORD = "password";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(DEV_EMAIL);
  await page.getByPlaceholder("Password (min 8)").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("signs in and streams a mock chat response", async ({ page }) => {
  await signIn(page);

  const composer = page.getByPlaceholder("Message…");
  await expect(composer).toBeVisible();

  const prompt = "Hello from the browser test";
  await composer.fill(prompt);
  await page.getByTitle("Send").click();

  const response = page.locator(".solar-assistant-output").last();
  await expect(response).toContainText("Mock reply", { timeout: 20_000 });
  await expect(response).toContainText(prompt);
  await response.getByText("4 Sources", { exact: true }).click();
  await expect(response.getByRole("link", { name: "React documentation" })).toBeVisible();
});

test("configures active context management policies", async ({ page }) => {
  await signIn(page);

  await page.locator('[data-tip="Settings"] button').click();
  await page.getByRole("tab", { name: "context management" }).click();

  await expect(page.getByText("Active chat policies resolve as exact model, family, provider, then derived fallback.")).toBeVisible();
  const gptPolicy = page.getByRole("group", { name: "openai / gpt-5.6" });
  await expect(gptPolicy.getByLabel("Soft trigger")).toHaveValue("272000");
  await expect(gptPolicy.getByLabel("Target")).toHaveValue("180000");

  await gptPolicy.getByLabel("Target").fill("175000");
  await gptPolicy.getByRole("button", { name: "Save policy" }).click();
  await expect(gptPolicy.getByLabel("Target")).toHaveValue("175000");
});
