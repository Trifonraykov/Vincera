/**
 * pnpm db:migrate — apply Drizzle migrations from ./drizzle to DATABASE_URL, then run the Supabase
 * hardening (row-level security on, no grants for the Data API roles; a no-op on plain Postgres).
 *
 * Uses drizzle-orm's migrator: pending migrations run in one transaction and are recorded in
 * drizzle.__drizzle_migrations. Generate new ones with `pnpm db:generate` (or
 * `pnpm db:generate --custom --name <name>` for hand-written SQL such as triggers).
 * TLS and pooling follow DATABASE_SSL / DATABASE_CA_CERT like the app, and production's TLS rule
 * applies when APP_ENV / NODE_ENV say production (CLAUDE.md §19.21, §19.23).
 *
 * Refuses, untouched, a database that holds another app's objects (tables, views, functions in
 * `public`, or another Drizzle app's journal) unless DATABASE_ALLOW_FOREIGN_OBJECTS=1: the platform
 * needs a database of its own (CLAUDE.md §19.23).
 *
 * Exits 75 (EX_TEMPFAIL) when the database is not reachable yet, so the Docker entrypoint retries
 * only then; any other failure (wrong password, TLS, a failing migration) exits 1 at once.
 */
import {
  databaseOptionsFromEnv,
  describeDatabaseConnection,
  resolveDatabaseConnection,
} from "../lib/db/connection"
import { describeHardening } from "../lib/db/supabase-hardening"
import {
  ALLOW_FOREIGN_OBJECTS,
  EXIT_TRY_AGAIN,
  isTransientConnectionError,
  runMigrations,
  runScript,
} from "./lib/db-admin"
import { loadEnvFiles, requireEnv } from "./lib/load-env"

loadEnvFiles()

runScript(
  async () => {
    const databaseUrl = requireEnv("DATABASE_URL")
    // `production` (APP_ENV / NODE_ENV) applies production's TLS rule, as the app does.
    const { sslMode, caCert, production } = databaseOptionsFromEnv(process.env)
    const connection = resolveDatabaseConnection(databaseUrl, { sslMode, caCert, production })
    console.log(`Migrating ${describeDatabaseConnection(connection)}.`)
    const report = await runMigrations(databaseUrl, undefined, {
      sslMode,
      caCert,
      production,
      // A database holding another app's objects is refused untouched unless this is set.
      allowForeignObjects: process.env[ALLOW_FOREIGN_OBJECTS]?.trim() === "1",
      log: (line) => console.log(line),
    })
    console.log("Migrations applied.")
    // Anything the hardening could not fix (objects of other roles) is printed as a WARNING line.
    for (const line of describeHardening(report.hardening)) console.log(line)
  },
  (error) => (isTransientConnectionError(error) ? EXIT_TRY_AGAIN : 1),
)
