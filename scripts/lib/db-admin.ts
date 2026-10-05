import { existsSync } from "node:fs"
import path from "node:path"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

/**
 * Database administration helpers shared by the db:* scripts and the test global setups.
 * They take explicit URLs and never read lib/env, so they work in any Node context.
 */

export const DEFAULT_MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle")

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const PROTECTED_DATABASES = new Set(["postgres", "template0", "template1"])

export type DatabaseTarget = {
  /** Database name from the URL path. */
  name: string
  host: string
  /** Same server, connected to the `postgres` maintenance database. */
  maintenanceUrl: string
}

export function parseDatabaseUrl(databaseUrl: string): DatabaseTarget {
  const url = new URL(databaseUrl)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(name)) {
    throw new Error(`Unsupported database name in URL: "${name}"`)
  }
  const maintenance = new URL(databaseUrl)
  maintenance.pathname = "/postgres"
  return { name, host: url.hostname, maintenanceUrl: maintenance.toString() }
}

export function isLocalDatabase(databaseUrl: string): boolean {
  return LOCAL_HOSTS.has(parseDatabaseUrl(databaseUrl).host)
}

/**
 * Whether a database name marks it as disposable test data: `test` or `e2e` as a whole word
 * ("creator_e2e", "creator_test"), not inside another word ("attestations", "latest_prod").
 */
export function isTestDatabaseName(name: string): boolean {
  return /(^|[_-])(e2e|test)([_-]|$)/i.test(name)
}

/** Opt-in for test tooling on a non-local Postgres that exists only for tests. */
export const ALLOW_REMOTE_TEST_DB = "ALLOW_REMOTE_TEST_DB"

/**
 * Test tooling creates and force-drops databases, so by default it only touches a Postgres on
 * this machine (CI's service container is on localhost too). Another server must be opted in
 * with ALLOW_REMOTE_TEST_DB=1.
 */
export function assertTestServer(
  databaseUrl: string,
  action: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (isLocalDatabase(databaseUrl) || env[ALLOW_REMOTE_TEST_DB] === "1") return
  const { host } = parseDatabaseUrl(databaseUrl)
  throw new Error(
    `Refusing to ${action} on non-local host ${host}. ` +
      `Set ${ALLOW_REMOTE_TEST_DB}=1 if that server only holds test databases.`,
  )
}

/** Refuse destructive operations in production (§19.4 test tooling never runs there). */
export function assertNotProduction(action: string): void {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error(`Refusing to ${action}: NODE_ENV or APP_ENV is production.`)
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Drop (terminating open connections) and re-create the database named in `databaseUrl`. */
export async function recreateDatabase(databaseUrl: string): Promise<void> {
  assertNotProduction("drop a database")
  const { name, maintenanceUrl } = parseDatabaseUrl(databaseUrl)
  if (PROTECTED_DATABASES.has(name)) {
    throw new Error(`Refusing to drop the "${name}" database.`)
  }
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 })
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
    await pool.query(`CREATE DATABASE ${quoteIdent(name)}`)
  } finally {
    await pool.end()
  }
}

/** Apply pending Drizzle migrations from `migrationsFolder` (default ./drizzle). */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    throw new Error(`No migrations found in ${migrationsFolder}. Run \`pnpm db:generate\` first.`)
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
  } finally {
    await pool.end()
  }
}

/**
 * An error's message followed by its causes. Drizzle wraps driver errors ("Failed query: …"), so
 * the useful part, such as `database "creator_dev" does not exist`, is usually the cause.
 */
export function describeError(error: unknown): string {
  const messages: string[] = []
  let current = error
  while (current instanceof Error && messages.length < 5) {
    messages.push(current.message)
    current = current.cause
  }
  return messages.length > 0 ? messages.join("\n  caused by: ") : String(error)
}

/** Run a script's main function, printing errors without a stack for expected failures. */
export function runScript(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(describeError(error))
      process.exit(1)
    },
  )
}
