import { devices, expect, test, type Page } from "@playwright/test";

const DEV_EMAIL = "admin@solar.local";
const DEV_PASSWORD = "password";

async function signIn(page: Page) {
	await page.goto("/");
	await page.getByPlaceholder("Email").fill(DEV_EMAIL);
	await page.getByPlaceholder("Password (min 8)").fill(DEV_PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
}

async function openSettings(page: Page) {
	await page.locator(".avatar-placeholder").click();
	await page.getByRole("button", { name: "Admin settings" }).click();
}

async function openPresets(page: Page) {
	await page.getByRole("button", { name: "Presets" }).click();
	await page.getByRole("button", { name: "Manage presets" }).click();
}

test("keeps the iOS viewport at its default scale after sign in", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		...devices["iPhone 13"],
		baseURL,
	});
	const page = await context.newPage();

	await page.goto("/");
	await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
		"content",
		"width=device-width, initial-scale=1, maximum-scale=1",
	);
	await signIn(page);
	await expect(page.getByPlaceholder("Send a Message")).toBeVisible();

	const viewport = await page.evaluate(() => ({
		activeElement: document.activeElement?.tagName,
		appWidth: document.querySelector(".solar-app")?.getBoundingClientRect()
			.width,
		documentWidth: document.documentElement.clientWidth,
	}));
	expect(viewport.activeElement).toBe("BODY");
	expect(viewport.appWidth).toBe(viewport.documentWidth);

	await context.close();
});

test("shows compact provider model rows with per-model settings", async ({
	browser,
	baseURL,
}) => {
	for (const options of [
		{ ...devices["iPhone 13"], baseURL },
		{ baseURL, viewport: { width: 1024, height: 768 } },
	]) {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		let interceptedProviders = false;
		await page.route("**/trpc/*admin.listProviders*", async (route) => {
			interceptedProviders = true;
			const providers = [
				{
					provider: "openai",
					hasApiKey: true,
					endpoints: [
						{
							id: "openai-responses",
							label: "openai-responses",
							baseUrl: "https://plexus.example/v1",
							api: "openai-responses",
						},
					],
					enabledModels: [
						{
							id: "gpt-5.6-luna",
							endpointId: "openai-responses",
							api: "openai-responses",
							visibility: "public",
							documents: true,
							capabilities: {
								reasoningLevels: ["low", "medium", "high"],
								serviceTiers: ["auto", "flex"],
								contextWindow: 600_000,
							},
						},
						{
							id: "gpt-5.6-terra",
							endpointId: "openai-responses",
							api: "openai-responses",
							visibility: "public",
							documents: false,
						},
					],
					apis: [
						"openai-responses",
						"openai-completions",
						"anthropic-messages",
						"google-generative-ai",
					],
				},
			];
			const response = await route.fetch();
			const body = await response.json();
			const procedures =
				new URL(route.request().url()).pathname.split("/").at(-1)?.split(",") ??
				[];
			const providerIndex = procedures.indexOf("admin.listProviders");
			body[providerIndex].result.data = providers;
			await route.fulfill({ response, json: body });
		});
		await signIn(page);

		await openSettings(page);
		await page.getByRole("tab", { name: "Providers" }).click();
		expect(interceptedProviders).toBe(true);

		const rows = page
			.getByRole("group", { name: "Imported models" })
			.locator("li");
		await expect(rows).toHaveCount(2);
		for (const row of await rows.all()) {
			expect((await row.boundingBox())!.height).toBeLessThanOrEqual(72);
		}
		await rows.first().getByTitle("Configure gpt-5.6-luna").click();
		const modelSettings = page.locator(".modal.modal-open .modal-box").last();
		await expect(
			modelSettings.getByRole("heading", { name: "gpt-5.6-luna" }),
		).toBeVisible();
		await expect(modelSettings.locator("select").first()).toHaveValue(
			"openai-responses",
		);
		await expect(
			modelSettings.getByRole("checkbox", { name: /Visible to all users/ }),
		).toBeChecked();
		await expect(
			modelSettings.getByRole("checkbox", { name: /Documents/ }),
		).toBeChecked();
		await expect(modelSettings.getByRole("spinbutton")).toHaveValue("600000");
		await modelSettings
			.getByRole("button", { name: "Customize context management" })
			.click();
		const contextSlider = (label: string) =>
			modelSettings
				.locator("label")
				.filter({ hasText: label })
				.locator("input");
		await expect(contextSlider("Soft trigger")).toHaveValue("272000");
		await expect(contextSlider("Target")).toHaveValue("180000");
		await expect(contextSlider("Hard input")).toHaveValue("568000");
		await modelSettings.getByRole("button", { name: "Done" }).click();
		await expect(page.getByText("Model settings")).toBeHidden();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBeLessThanOrEqual(
			await page.evaluate(() => document.documentElement.clientWidth),
		);
		await context.close();
	}
});

test("deletes a provider from settings", async ({ page }) => {
	await signIn(page);

	await openSettings(page);
	await page.getByRole("tab", { name: "Providers" }).click();
	await page.getByPlaceholder("Provider name").fill("temporary-provider");
	await page.getByRole("button", { name: "Add provider" }).click();

	const provider = page
		.getByRole("heading", { name: "temporary-provider" })
		.locator("..");
	await expect(provider).toBeVisible();
	await provider.getByPlaceholder("sk-…").fill("temporary-key");
	await provider.getByRole("button", { name: "Save provider" }).click();
	await expect(provider.getByText("Provider saved")).toBeVisible();
	await expect(provider.getByRole("button", { name: "Saved" })).toBeDisabled();
	await provider
		.getByPlaceholder("Saved — enter to replace")
		.fill("replacement-key");
	await expect(
		provider.getByRole("button", { name: "Save provider" }),
	).toBeEnabled();
	page.once("dialog", (dialog) => dialog.accept());
	await provider.getByRole("button", { name: "Delete provider" }).click();
	await expect(provider).toBeHidden();
});

test("signs in and streams a mock chat response", async ({ page }) => {
	await signIn(page);

	const composer = page.getByPlaceholder("Send a Message");
	await expect(composer).toBeVisible();

	const prompt = "Hello from the browser test";
	await composer.fill(prompt);
	await page.getByTitle("Send or queue message").click();

	const response = page.locator(".solar-assistant-output").last();
	await expect(response).toContainText("Mock reply", { timeout: 20_000 });
	await expect(response).toContainText(prompt);
	await response.getByText("4 Sources", { exact: true }).click();
	await expect(
		response.getByRole("link", { name: "React documentation" }),
	).toBeVisible();
});

test("uses the user's default preset for new chats", async ({ page }) => {
	await signIn(page);

	await openPresets(page);
	await page.getByRole("button", { name: "New preset" }).click();
	const presetForm = page.locator(".modal.modal-open .card");
	await presetForm.getByRole("textbox").first().fill("Vision default");
	await presetForm
		.getByRole("combobox")
		.first()
		.selectOption("mock/mock/mock-vision/mock");
	await presetForm.getByRole("button", { name: "Save preset" }).click();

	const preset = page
		.getByText("Vision default", { exact: true })
		.locator("..")
		.locator("..");
	await preset.getByRole("button").first().click();
	await expect(preset.locator("button.text-warning")).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();
	await page
		.getByRole("button", { name: "New chat", exact: true })
		.first()
		.click();
	// The model switcher is a dropdown in the page title bar (see
	// ModelPicker.tsx); assert the presets' default model selection landed.
	await expect(
		page.getByRole("button", { name: "Mock (vision)" }).first(),
	).toBeVisible();
});

test("queues a follow-up message until the active response completes", async ({
	page,
}) => {
	await signIn(page);

	let releaseFirstRequest!: () => void;
	let chatRequests = 0;
	const firstRequestHeld = new Promise<void>((resolve) => {
		releaseFirstRequest = resolve;
	});
	await page.route("**/api/chat", async (route) => {
		chatRequests++;
		if (chatRequests === 1) await firstRequestHeld;
		await route.continue();
	});

	const composer = page.getByPlaceholder("Send a Message");
	await composer.fill("First queued test message");
	await page.getByTitle("Send or queue message").click();
	await expect(page.getByTitle("Interrupt response")).toBeVisible();

	await composer.fill("Second queued test message");
	await page.getByTitle("Send or queue message").click();
	expect(chatRequests).toBe(1);

	releaseFirstRequest();
	await expect.poll(() => chatRequests).toBe(2);
	await expect(page.locator(".solar-assistant-output").last()).toContainText(
		"Second queued test message",
		{ timeout: 20_000 },
	);
});
