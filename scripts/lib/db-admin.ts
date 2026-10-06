import { existsSync } from "node:fs"
import path from "node:path"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Client, Pool } from "pg"

import {
  pgConnectionConfig,
  resolveDatabaseConnection,
  transactionPoolerWarning,
  type DatabaseConnectionOptions,
} from "../../lib/db/connection"
import { redactQueryParams } from "../../lib/db/errors"
import {
  ensureVectorOnSearchPath,
  foreignObjects,
  runSupabaseHardening,
  type HardeningSummary,
  type VectorSearchPath,
} from "../../lib/db/supabase-hardening"

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
export async function recreateDatabase(
  databaseUrl: string,
  options: DatabaseConnectionOptions = {},
): Promise<void> {
  assertNotProduction("drop a database")
  const { name, maintenanceUrl } = parseDatabaseUrl(databaseUrl)
  if (PROTECTED_DATABASES.has(name)) {
    throw new Error(`Refusing to drop the "${name}" database.`)
  }
  const maintenance = resolveDatabaseConnection(maintenanceUrl, options)
  const pool = new Pool({ ...pgConnectionConfig(maintenance), max: 1 })
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
    await pool.query(`CREATE DATABASE ${quoteIdent(name)}`)
  } finally {
    await pool.end()
  }
}

export type MigrationReport = {
  /** Where pgvector lives and whether its schema had to be added to the role's search_path. */
  vector: VectorSearchPath
  /** The Supabase hardening that ran after the migrations (a no-op without the API roles). */
  hardening: HardeningSummary
}

export type MigrationOptions = DatabaseConnectionOptions & {
  /** Progress and warnings (`pnpm db:migrate` prints them; the test tooling stays quiet). */
  log?: (line: string) => void
  /**
   * Migrate (and harden) a database that holds objects the platform did not create
   * (DATABASE_ALLOW_FOREIGN_OBJECTS=1). Off: such a database is refused untouched.
   */
  allowForeignObjects?: boolean
}

/** The opt-in for `pnpm db:migrate` on a database that holds someone else's objects. */
export const ALLOW_FOREIGN_OBJECTS = "DATABASE_ALLOW_FOREIGN_OBJECTS"

/** How many foreign objects a refusal names. */
const FOREIGN_OBJECTS_SHOWN = 10

/**
 * DATABASE_URL names a database that already holds objects the platform did not create
 * (another app's tables, or its Supabase project). Nothing was changed.
 */
export class ForeignDatabaseError extends Error {
  readonly objects: readonly string[]

  constructor(database: string, objects: readonly string[]) {
    const shown = objects.slice(0, FOREIGN_OBJECTS_SHOWN).join(", ")
    const more =
      objects.length > FOREIGN_OBJECTS_SHOWN
        ? ` and ${objects.length - FOREIGN_OBJECTS_SHOWN} more`
        : ""
    super(
      `Refusing to migrate database "${database}": it already holds objects this platform did not ` +
        `create (${shown}${more}). The migrations and the Supabase hardening would change them ` +
        "(row-level security on with no policies, Data API grants revoked), which breaks the app " +
        "that uses them. Give the platform a database (a Supabase project) of its own " +
        `(docs/supabase.md), or set ${ALLOW_FOREIGN_OBJECTS}=1 to migrate this one anyway. ` +
        "Nothing was changed.",
    )
    this.name = "ForeignDatabaseError"
    this.objects = objects
  }
}

/**
 * Apply pending Drizzle migrations from `migrationsFolder` (default ./drizzle), then harden the
 * database for Supabase (CLAUDE.md §19.21, §19.23):
 * 0. First: refuse, untouched, a database that is not the platform's and holds objects of
 *    another app (`foreignObjects`; `ForeignDatabaseError`), unless `allowForeignObjects`.
 * 1. Before: make sure pgvector's `vector` type resolves for this role, whatever schema the
 *    extension is installed in (`ensureVectorOnSearchPath`).
 * 2. The migrations, in one transaction (drizzle's migrator).
 * 3. After: `hardenSupabase`, only where Supabase's `anon` / `authenticated` roles exist.
 * TLS comes from `sslMode` (DATABASE_SSL) and `caCert` (DATABASE_CA_CERT) as for the app, and
 * `production: true` (from `databaseOptionsFromEnv`) applies production's TLS rule
 * (lib/db/connection.ts). Every step is idempotent, so it runs on every start.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    throw new Error(`No migrations found in ${migrationsFolder}. Run \`pnpm db:generate\` first.`)
  }
  const { log = () => undefined, allowForeignObjects = false, ...connectionOptions } = options
  const connection = resolveDatabaseConnection(databaseUrl, connectionOptions)
  const poolerWarning = transactionPoolerWarning(connection, "migrations")
  if (poolerWarning) log(`Warning: ${poolerWarning}`)
  const config = pgConnectionConfig(connection)

  // Its own session: a search_path fix applies to sessions opened afterwards.
  const preflight = new Client(config)
  let vector: VectorSearchPath
  try {
    await preflight.connect()
    const hashes = readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash)
    const ownership = await foreignObjects(preflight, hashes)
    if (!ownership.platform && ownership.objects.length > 0) {
      if (!allowForeignObjects)
        throw new ForeignDatabaseError(connection.database, ownership.objects)
      log(
        `${ALLOW_FOREIGN_OBJECTS}=1: migrating and hardening a database that holds objects of ` +
          `another app (${ownership.objects.length}).`,
      )
    }
    vector = await ensureVectorOnSearchPath(preflight)
  } finally {
    await preflight.end().catch(() => undefined)
  }
  if (vector.status === "fixed") {
    log(
      `pgvector is installed in schema "${vector.schema}", which was not on the search_path of ` +
        `role "${vector.role}": set it to ${vector.searchPath} in database "${vector.database}".`,
    )
  }

  const pool = new Pool({ max: 1, ...config })
  pool.on("error", () => undefined)
  try {
    await migrate(drizzle(pool), { migrationsFolder })
    const hardening = await runSupabaseHardening(pool)
    return { vector, hardening }
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
    // A failed query's parameters may hold personal data; the SQL and the cause are enough.
    messages.push(redactQueryParams(current.message))
    current = current.cause
  }
  return messages.length > 0 ? messages.join("\n  caused by: ") : String(error)
}

/** Exit code of `pnpm db:migrate` when the database is not reachable yet (EX_TEMPFAIL). */
export const EXIT_TRY_AGAIN = 75

/** Node socket errors and Postgres states that go away once the server is up. */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  // cannot_connect_now (starting up / shutting down), too_many_connections, connection_failure,
  // sqlclient_unable_to_establish_sqlconnection
  "57P03",
  "53300",
  "08006",
  "08001",
])

/**
 * Whether `error` (or one of its causes) means "the database is not reachable yet", worth retrying
 * while a container starts. Wrong passwords, unknown hosts or databases, TLS and configuration
 * errors and failing migrations are not: retrying cannot fix them.
 */
export function isTransientConnectionError(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true
    if (/Connection terminated unexpectedly|timeout expired/i.test(current.message)) return true
    if (current instanceof AggregateError && current.errors.some(isTransientConnectionError)) {
      return true
    }
    current = current.cause
  }
  return false
}

/** Run a script's main function, printing errors without a stack for expected failures. */
export function runScript(
  main: () => Promise<void>,
  exitCodeFor: (error: unknown) => number = () => 1,
): void {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(describeError(error))
      process.exit(exitCodeFor(error))
    },
  )
}
