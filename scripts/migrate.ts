/**
 * pnpm db:migrate — apply Drizzle migrations from ./drizzle to DATABASE_URL.
 *
 * Uses drizzle-orm's migrator: pending migrations run in one transaction and are recorded in
 * drizzle.__drizzle_migrations. Generate new ones with `pnpm db:generate` (or
 * `pnpm db:generate --custom --name <name>` for hand-written SQL such as triggers).
 */
import { parseDatabaseUrl, runMigrations, runScript } from "./lib/db-admin"
import { loadEnvFiles, requireEnv } from "./lib/load-env"

loadEnvFiles()

runScript(async () => {
  const databaseUrl = requireEnv("DATABASE_URL")
  const { name, host } = parseDatabaseUrl(databaseUrl)
  await runMigrations(databaseUrl)
  console.log(`Migrations applied to "${name}" on ${host}.`)
})
