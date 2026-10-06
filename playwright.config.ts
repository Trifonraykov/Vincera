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

/**
 * Specs for the phone layout run in the "mobile" project: tests/e2e/mobile.spec.ts and
 * mobile-<topic>.spec.ts. mobile-desktop.spec.ts checks the desktop layout next to them and runs
 * in the desktop project.
 */
const MOBILE_SPECS = /\/mobile(?!-desktop)(-[\w-]+)?\.spec\.ts$/

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
      testIgnore: MOBILE_SPECS,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
    {
      // The platform as a phone app (CLAUDE.md §19, "Mobile app (PWA) patterns"): an iPhone's
      // screen, touch and user agent, on Chromium (the browser this sandbox and CI install).
      name: "mobile",
      testMatch: MOBILE_SPECS,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
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
      // The service worker registers under `next dev` too, as it does in CI's production build.
      NEXT_PUBLIC_ENABLE_SW: "1",
      // `next dev` only: Turbopack snapshots its cache (and, with turbopackMemoryEviction "full",
      // drops the in-memory copies) after the server has been busy this long and then idle this
      // long. The defaults wait for a quiet period that a running suite never gives it, so the
      // dev server grew past the sandbox's memory limit and was OOM-killed (CLAUDE.md §19.29).
      // Undocumented Turbopack variables; ignored by `next start` and by versions without them.
      TURBO_ENGINE_SNAPSHOT_MIN_ACTIVE_TIME_MILLIS: "3000",
      TURBO_ENGINE_SNAPSHOT_IDLE_TIMEOUT_MILLIS: "500",
    },
  },
})
