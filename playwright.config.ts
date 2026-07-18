import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const E2E_PORT = 3100;
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
const E2E_DATABASE_PATH = fileURLToPath(new URL("./.e2e.db", import.meta.url));
const E2E_ATTACHMENTS_PATH = fileURLToPath(new URL("./.e2e-attachments", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "bun run ../../scripts/prepare-e2e.ts && bun --env-file=../../.env run start",
    cwd: "apps/server",
    url: `${E2E_BASE_URL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(E2E_PORT),
      BETTER_AUTH_URL: E2E_BASE_URL,
      BETTER_AUTH_SECRET: "solar-e2e-secret-at-least-32-characters",
      DATABASE_PATH: E2E_DATABASE_PATH,
      SOLAR_ATTACHMENTS_DIR: E2E_ATTACHMENTS_PATH,
      SOLAR_MOCK_LLM: "1",
      SOLAR_SEED_DEV_USER: "1",
    },
  },
});
