/**
 * The desktop app's database bootstrap: the same code paths as `pnpm db:migrate` and
 * `pnpm db:seed` (scripts/migrate.ts, scripts/seed.ts), bundled by desktop/scripts/build-app.mjs
 * into one file that runs under Electron's Node (ELECTRON_RUN_AS_NODE) before the server starts.
 *
 * Usage: bootstrap.cjs <migrations folder> [--seed]
 * Reads DATABASE_URL (and DATABASE_SSL / DATABASE_CA_CERT for a hosted database) plus the app's
 * environment from the parent process. Exits 75 while the database is not reachable, else 1 on a
 * failure, like scripts/migrate.ts.
 */
import { now } from "@/lib/clock"
import { closeDb, createDb } from "@/lib/db/client"
import { databaseOptionsFromEnv } from "@/lib/db/connection"
import { describeHardening } from "@/lib/db/supabase-hardening"
import { runSeed } from "@/lib/seed"

import {
  ALLOW_FOREIGN_OBJECTS,
  EXIT_TRY_AGAIN,
  isTransientConnectionError,
  runMigrations,
  runScript,
} from "../../scripts/lib/db-admin"

async function main(): Promise<void> {
  const [migrationsFolder, ...flags] = process.argv.slice(2)
  if (!migrationsFolder) throw new Error("bootstrap: missing the migrations folder argument")
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error("bootstrap: DATABASE_URL is not set")
  const { sslMode, caCert, production } = databaseOptionsFromEnv(process.env)

  const report = await runMigrations(databaseUrl, migrationsFolder, {
    sslMode,
    caCert,
    production,
    allowForeignObjects: process.env[ALLOW_FOREIGN_OBJECTS]?.trim() === "1",
    log: (line) => console.log(line),
  })
  console.log("Migrations applied.")
  for (const line of describeHardening(report.hardening)) console.log(line)

  if (!flags.includes("--seed")) return
  const database = createDb(databaseUrl, { max: 1, sslMode, caCert, production })
  try {
    console.log("Seeding demo data:")
    await runSeed({ db: database.db, now: now(), log: (line) => console.log(line) })
  } finally {
    await database.close()
    await closeDb()
  }
}

runScript(main, (error) => (isTransientConnectionError(error) ? EXIT_TRY_AGAIN : 1))
