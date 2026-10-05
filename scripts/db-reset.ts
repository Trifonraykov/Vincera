/**
 * pnpm db:reset — drop and re-create the DATABASE_URL database, then apply migrations.
 * Refuses to run in production, and on non-local hosts unless `--force` is passed.
 */
import { databaseOptionsFromEnv } from "../lib/db/connection"
import { describeHardening } from "../lib/db/supabase-hardening"
import {
  assertNotProduction,
  isLocalDatabase,
  parseDatabaseUrl,
  recreateDatabase,
  runMigrations,
  runScript,
} from "./lib/db-admin"
import { loadEnvFiles, requireEnv } from "./lib/load-env"

loadEnvFiles()

runScript(async () => {
  assertNotProduction("reset the database")
  const databaseUrl = requireEnv("DATABASE_URL")
  const { name, host } = parseDatabaseUrl(databaseUrl)
  if (!isLocalDatabase(databaseUrl) && !process.argv.includes("--force")) {
    throw new Error(
      `Refusing to reset "${name}" on non-local host ${host}. Pass --force to confirm.`,
    )
  }
  const { sslMode, caCert, production } = databaseOptionsFromEnv(process.env)
  await recreateDatabase(databaseUrl, { sslMode, caCert, production })
  console.log(`Re-created database "${name}".`)
  const report = await runMigrations(databaseUrl, undefined, {
    sslMode,
    caCert,
    production,
    log: (line) => console.log(line),
  })
  console.log("Migrations applied.")
  for (const line of describeHardening(report.hardening)) console.log(line)
})
