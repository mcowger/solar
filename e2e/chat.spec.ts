import { devices, expect, test } from "@playwright/test";

const DEV_EMAIL = "admin@solar.local";
const DEV_PASSWORD = "password";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByPlaceholder("Email").fill(DEV_EMAIL);
  await page.getByPlaceholder("Password (min 8)").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("keeps the iOS viewport at its default scale after sign in", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL });
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    "width=device-width, initial-scale=1, maximum-scale=1",
  );
  await signIn(page);
  await expect(page.getByPlaceholder("Message…")).toBeVisible();

  const viewport = await page.evaluate(() => ({
    activeElement: document.activeElement?.tagName,
    appWidth: document.querySelector(".solar-app")?.getBoundingClientRect().width,
    documentWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.activeElement).toBe("BODY");
  expect(viewport.appWidth).toBe(viewport.documentWidth);

  await context.close();
});

test("keeps provider model controls separated on mobile", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL });
  const page = await context.newPage();
  let interceptedProviders = false;
  await page.route("**/trpc/*admin.listProviders*", async (route) => {
    interceptedProviders = true;
    const providers = [{
      provider: "openai",
      hasApiKey: true,
      endpoints: [{
        id: "openai-responses",
        label: "openai-responses",
        baseUrl: "https://plexus.example/v1",
        api: "openai-responses",
      }],
      enabledModels: [
        { id: "gpt-5.6-luna", endpointId: "openai-responses", api: "openai-responses", visibility: "public", documents: true },
        { id: "gpt-5.6-terra", endpointId: "openai-responses", api: "openai-responses", visibility: "public", documents: false },
      ],
      apis: ["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"],
    }];
    const response = await route.fetch();
    const body = await response.json();
    const procedures = new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ?? [];
    const providerIndex = procedures.indexOf("admin.listProviders");
    body[providerIndex].result.data = providers;
    await route.fulfill({ response, json: body });
  });
  await signIn(page);

  await page.locator('[data-tip="Settings"] button').click();
  await page.getByRole("tab", { name: "Providers" }).click();
  expect(interceptedProviders).toBe(true);

  const rows = page.getByRole("group", { name: "Imported models" }).locator(":scope > div");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    const boxes = await row.locator("label, button").evaluateAll((controls) => controls.map((control) => {
      const { left, right, top, bottom } = control.getBoundingClientRect();
      return { left, right, top, bottom };
    }));
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const firstBox = boxes[first]!;
        const secondBox = boxes[second]!;
        const horizontalOverlap = Math.max(firstBox.left, secondBox.left) < Math.min(firstBox.right, secondBox.right);
        const verticalOverlap = Math.max(firstBox.top, secondBox.top) < Math.min(firstBox.bottom, secondBox.bottom);
        expect(horizontalOverlap && verticalOverlap).toBe(false);
      }
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  await context.close();
});

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
