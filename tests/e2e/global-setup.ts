import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import type { FullConfig } from "@playwright/test"

import {
  assertNotProduction,
  assertTestServer,
  isTestDatabaseName,
  parseDatabaseUrl,
  recreateDatabase,
  runMigrations,
} from "../../scripts/lib/db-admin"

/**
 * Playwright global setup (CLAUDE.md §19.4): give every e2e run a clean world.
 *
 * 1. Clear the fakes' file state under `.data/` (email outbox, storage, fake Stripe, ...), which
 *    belongs to the previous run.
 * 2. Drop and re-create the e2e database (E2E_DATABASE_URL, exported by playwright.config.ts),
 *    apply migrations and run the seed script (which writes fake Stripe objects and files there).
 *
 * Refuses to touch a database whose name lacks a whole "e2e" or "test" word (e.g. "creator_e2e"),
 * or one on another host unless ALLOW_REMOTE_TEST_DB=1.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  assertNotProduction("reset the e2e database")
  const databaseUrl = process.env.E2E_DATABASE_URL
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is not set (see playwright.config.ts).")

  const { name } = parseDatabaseUrl(databaseUrl)
  if (!isTestDatabaseName(name)) {
    throw new Error(
      `Refusing to reset "${name}": the e2e database name needs a whole "e2e" or "test" word, ` +
        `like "creator_e2e".`,
    )
  }
  assertTestServer(databaseUrl, `reset the e2e database "${name}"`)

  const root = config.configFile ? path.dirname(config.configFile) : process.cwd()

  // Clear the fakes' files first: the seed writes some (fake Stripe accounts and payments, the
  // signed agreement's PDF, emails), and they must survive into the run.
  const dataDir = path.join(root, ".data")
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir)) {
      rmSync(path.join(dataDir, entry), { recursive: true, force: true })
    }
  }

  await recreateDatabase(databaseUrl)
  await runMigrations(databaseUrl, path.join(root, "drizzle"))
  execFileSync("pnpm", ["run", "--silent", "db:seed"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
}
