#!/usr/bin/env node
/**
 * End-to-end check of the desktop app, driven with Playwright's Electron support:
 *
 *   1. a first launch with an empty data folder shows the splash, starts the embedded database,
 *      migrates, seeds and opens /app (signed out: the sign-in page);
 *   2. signing up works through the in-app mailbox (the "Open mailbox" button, then the link);
 *   3. after quitting and launching again, the user is still signed in (the session row lives in
 *      the embedded database on disk) and the seed did not run twice.
 *
 * Usage: node scripts/smoke-test.mjs [--app <executable>] [--out <screenshot folder>]
 *   --app  the packaged executable (e.g. release/linux-unpacked/vincera); default: `electron .`
 * Needs a display (on Linux CI: xvfb-run) and the repo root's dependencies (@playwright/test).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const rootRequire = createRequire(path.join(desktopDir, "..", "package.json"))
const { _electron: electron } = rootRequire("@playwright/test")

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const appExecutable = option("--app")
const outDir = path.resolve(option("--out") ?? path.join(desktopDir, "release", "smoke"))
mkdirSync(outDir, { recursive: true })
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "vincera-smoke-"))
const email = `desktop-${Date.now()}@example.com`

function launch() {
  const args = process.platform === "linux" ? ["--no-sandbox"] : []
  return electron.launch({
    ...(appExecutable
      ? { executablePath: path.resolve(appExecutable), args }
      : {
          // The `electron` package exports the path of its binary.
          executablePath: createRequire(path.join(desktopDir, "package.json"))("electron"),
          args: [desktopDir, ...args],
        }),
    env: { ...process.env, VINCERA_USER_DATA_DIR: userDataDir },
    timeout: 60_000,
  })
}

async function waitForUrl(page, pattern, timeout = 180_000) {
  await page.waitForURL(pattern, { timeout })
}

/** Quit through the app (runs the shutdown: server stopped, database closed) and wait for exit. */
async function quit(app) {
  const exited = new Promise((resolve) => app.process().once("exit", resolve))
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await exited
}

const step = (message) => console.log(`- ${message}`)
let app
try {
  step(`first launch (data: ${userDataDir})`)
  app = await launch()
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.screenshot({ path: path.join(outDir, "01-splash.png") })

  step("waiting for /app (signed out: the sign-in page)")
  await waitForUrl(page, /\/sign-in\?callbackUrl=%2Fapp/)
  await page.getByRole("button", { name: /sign-in link/i }).waitFor()
  await page.screenshot({ path: path.join(outDir, "02-sign-in.png") })

  step(`signing up as ${email}`)
  await page.goto(new URL("/sign-up", page.url()).toString())
  await page.getByLabel("Name").fill("Desktop Tester")
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Create account" }).click()
  await page.getByRole("heading", { name: "Check your email" }).waitFor()
  await page.locator("#vincera-desktop-mailbox").waitFor()
  await page.screenshot({ path: path.join(outDir, "03-check-email.png") })

  step("opening the mailbox and the sign-in link")
  await page.locator("#vincera-desktop-mailbox").click()
  await waitForUrl(page, /\/api\/dev\/mailbox/)
  await page.getByText(email).first().waitFor()
  await page.screenshot({ path: path.join(outDir, "04-mailbox.png") })
  await page.locator('a[href*="/api/auth/callback/email"]').first().click()
  await waitForUrl(page, /\/onboarding\/role/, 60_000)
  await page.screenshot({ path: path.join(outDir, "05-signed-in.png") })

  step("choosing a role")
  await page.locator("label").filter({ hasText: "I'm a creator" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await waitForUrl(page, /\/onboarding\/creator\/profile/, 60_000)
  await page.screenshot({ path: path.join(outDir, "06-onboarding.png") })

  step("quitting")
  await quit(app)
  app = undefined

  step("second launch: still signed in, data kept")
  app = await launch()
  const again = await app.firstWindow()
  await waitForUrl(again, /\/onboarding\/creator\/profile/)
  await again.screenshot({ path: path.join(outDir, "07-relaunched.png") })
  await quit(app)
  app = undefined

  const log = readFileSync(path.join(userDataDir, "logs", "vincera.log"), "utf8")
  // The seed is idempotent: the second run finds every seeded user already there.
  if (!/people: (0 created|skipped)/.test(log)) throw new Error("The second launch seeded again.")
  if (!/\[db\] closed/.test(log)) throw new Error("The database was not closed on quit.")
  console.log(`OK: screenshots in ${outDir}`)
} catch (error) {
  console.error(error)
  if (app) {
    const page = app.windows()[0]
    await page?.screenshot({ path: path.join(outDir, "failure.png") }).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
  try {
    console.error(readFileSync(path.join(userDataDir, "logs", "vincera.log"), "utf8").slice(-6000))
  } catch {
    // No log.
  }
  process.exitCode = 1
} finally {
  if (process.exitCode !== 1) rmSync(userDataDir, { recursive: true, force: true })
}
