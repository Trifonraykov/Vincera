import { defineConfig } from "drizzle-kit"

// Relative imports: drizzle-kit loads this file without the `@/` alias.
import { databaseOptionsFromEnv, resolveDatabaseConnection } from "./lib/db/connection"
import { loadEnvFiles } from "./scripts/lib/load-env"

loadEnvFiles()

/**
 * drizzle-kit only connects for `migrate`, `push`, `pull` and `studio` (`pnpm db:generate` does
 * not). It gets the same connection as the app and `pnpm db:migrate`: DATABASE_URL without its
 * TLS parameters plus an explicit `ssl` from DATABASE_SSL / DATABASE_CA_CERT
 * (lib/db/connection.ts), and production's TLS rule when APP_ENV / NODE_ENV say production, so a
 * Supabase URL behaves the same everywhere. Apply migrations with
 * `pnpm db:migrate`, which also runs the Supabase hardening (CLAUDE.md §19.21).
 */
const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/creator_dev"
/** drizzle-kit commands that never connect, so a database setting cannot block them. */
const OFFLINE_COMMANDS = new Set(["generate", "check", "up", "export"])

function credentials() {
  const url = process.env.DATABASE_URL?.trim() || DEFAULT_URL
  if (process.argv.some((arg) => OFFLINE_COMMANDS.has(arg))) return { url }
  const connection = resolveDatabaseConnection(url, databaseOptionsFromEnv(process.env))
  const parsed = new URL(connection.connectionString)
  return {
    host: connection.host,
    port: connection.port,
    user: decodeURIComponent(parsed.username) || undefined,
    password: decodeURIComponent(parsed.password) || undefined,
    database: connection.database,
    ssl: connection.ssl,
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: credentials(),
  strict: true,
  verbose: true,
})
