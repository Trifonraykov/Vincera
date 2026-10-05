import { createDb, type DbHandle } from "../../lib/db/client"
import { databaseOptionsFromEnv } from "../../lib/db/connection"
import { requireEnv } from "./load-env"

/**
 * The database for a script (`pnpm admin:grant`, `pnpm db:seed`, ...): DATABASE_URL with the same
 * TLS settings as the app (DATABASE_SSL, DATABASE_CA_CERT; lib/db/connection.ts) and, when
 * APP_ENV / NODE_ENV say production, production's TLS rule, so a hosted Supabase URL works (and
 * is refused) the same everywhere. Call `loadEnvFiles()` first; close the handle when done.
 */
export function connectScriptDatabase(options: { max?: number } = {}): DbHandle & { url: string } {
  const url = requireEnv("DATABASE_URL")
  const { sslMode, caCert, production } = databaseOptionsFromEnv(process.env)
  return { ...createDb(url, { max: options.max ?? 1, sslMode, caCert, production }), url }
}
