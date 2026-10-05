import { existsSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"
import { config as loadDotenv } from "dotenv"

import { E2E_ADMIN_EMAIL } from "./tests/e2e/helpers/accounts"

const isCI = Boolean(process.env.CI)
const port = Number(process.env.PORT ?? 3100)
const baseURL = `http://localhost:${port}`

/**
 * E2E_DATABASE_URL from the environment, else from .env.local / .env (read into a private object,
 * like TEST_DATABASE_URL in tests/helpers/db-template.ts), else the local default.
 */
function resolveE2eDatabaseUrl(): string {
  const fromEnv = process.env.E2E_DATABASE_URL?.trim()
  if (fromEnv) return fromEnv
  const fileEnv: Record<string, string> = {}
  loadDotenv({ path: [".env.local", ".env"], processEnv: fileEnv, quiet: true })
  return (
    fileEnv.E2E_DATABASE_URL?.trim() || "postgres://postgres:postgres@localhost:5432/creator_e2e"
  )
}

// Also exported to process.env so tests/e2e/global-setup.ts resets the same database.
const e2eDatabaseUrl = resolveE2eDatabaseUrl()
process.env.E2E_DATABASE_URL = e2eDatabaseUrl

// This sandbox ships a pre-installed Chromium; elsewhere (CI) Playwright uses its own download.
const sandboxChromium = "/opt/pw-browsers/chromium"
const executablePath = existsSync(sandboxChromium) ? sandboxChromium : undefined

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // The flows share one database, so they run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  // `next dev` compiles each route on its first request, which can take several seconds; a
  // navigation or redirect that triggers a compile would trip the default 5 s. Builds (CI) keep it.
  expect: { timeout: isCI ? 5_000 : 15_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    command: isCI ? "pnpm build && pnpm start" : "pnpm dev",
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    stdout: "pipe",
    env: {
      PORT: String(port),
      // `next start` always runs with NODE_ENV=production; APP_ENV=test keeps fakes and test
      // routes allowed (see lib/env.ts).
      APP_ENV: "test",
      FAKE_SERVICES: "all",
      E2E_TEST_ROUTES: "1",
      DATABASE_URL: e2eDatabaseUrl,
      E2E_DATABASE_URL: e2eDatabaseUrl,
      NEXT_PUBLIC_APP_URL: baseURL,
      AUTH_URL: baseURL,
      ADMIN_EMAILS: E2E_ADMIN_EMAIL,
    },
  },
})
