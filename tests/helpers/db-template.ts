import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadDotenv } from "dotenv"
import { Client } from "pg"

// Relative import: this module is also loaded by the Vitest global setup.
import { assertNotProduction, assertTestServer, runMigrations } from "../../scripts/lib/db-admin"

/**
 * Integration-test databases (CLAUDE.md §19.4), shared by the Vitest global setup and the per-file
 * helper (tests/helpers/db.ts):
 *
 * - One **template** database per migration set, named after a hash of drizzle/, created once
 *   (under an advisory lock, so parallel runs don't race) and then frozen (IS_TEMPLATE,
 *   ALLOW_CONNECTIONS false).
 * - Each test **file** clones it (`CREATE DATABASE ... TEMPLATE ...`, a fast file copy) and drops
 *   the clone afterwards. Clone names carry the run id, so the run's teardown drops leftovers and
 *   later runs drop those of crashed runs.
 *
 * All of these databases are prefixed `ct_` ("creator test"). Sweeps only ever drop names that
 * match the exact grammar this module generates (`isOwnTestDatabase`), and only on a local server
 * unless ALLOW_REMOTE_TEST_DB=1 (`assertTestServer`).
 */

export const DEFAULT_TEST_ADMIN_URL = "postgres://postgres:postgres@localhost:5432/postgres"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const MIGRATIONS_FOLDER = path.join(ROOT, "drizzle")

const TEMPLATE_PREFIX = "ct_tpl_"
/** Arbitrary constant key for pg_advisory_lock around template creation. */
const TEMPLATE_LOCK_KEY = 4_211_947_613
/** Per-file databases older than this belong to a crashed run (runs take minutes). */
const CLONE_STALE_AFTER_MS = 6 * 60 * 60 * 1000
/** Templates (of other migration sets: other branches, worktrees) unused for this long. */
const TEMPLATE_STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** The names this module generates; nothing else is ever dropped. Times are base-36 ms. */
const TEMPLATE_NAME = /^ct_tpl_[0-9a-f]{12}_([0-9a-z]{8,9})$/
const CLONE_NAME = /^ct_([0-9a-z]{8,9})_[0-9a-f]{6}_[0-9a-f]{8}$/
const BUILD_NAME = /^ct_build_[0-9a-f]{8}$/

/** Templates record their last use in the database comment, so a sweep spares templates in use. */
const LAST_USED_COMMENT = /^ct:last_used=(\d+)$/

export type TestDatabaseConfig = {
  /** Connection to the server's maintenance database; used to create and drop databases. */
  adminUrl: string
  /** Name of the migrated template database to clone. */
  template: string
  /** Prefix of every per-file database created by this run. */
  runPrefix: string
}

/**
 * TEST_DATABASE_URL from the environment, else from .env.local / .env (read into a private object,
 * so the rest of the test environment is untouched), else the local default.
 */
export function resolveAdminUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim()
  if (fromEnv) return fromEnv
  const fileEnv: Record<string, string> = {}
  loadDotenv({
    path: [path.join(ROOT, ".env.local"), path.join(ROOT, ".env")],
    processEnv: fileEnv,
    quiet: true,
  })
  return fileEnv.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_ADMIN_URL
}

/** Same server as `adminUrl`, database `name`. */
export function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

/** Escape LIKE wildcards (`_`, `%`) so `value` matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\_%]/g, (char) => `\\${char}`)
}

export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`Unexpected database name "${name}"`)
  return `"${name}"`
}

/** sha256 of every migration file (SQL + journal), so any migration change yields a new template. */
export function migrationsHash(folder: string = MIGRATIONS_FOLDER): string {
  const hash = createHash("sha256")
  const files = [
    ...readdirSync(folder)
      .filter((f) => f.endsWith(".sql"))
      .sort(),
    path.join("meta", "_journal.json"),
  ]
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(folder, file)))
      .update("\0")
  }
  return hash.digest("hex").slice(0, 12)
}

function timestamp36(ms: number): string {
  return ms.toString(36)
}

/** A new run prefix: `ct_<time36>_<random>`; per-file databases add `_<random>`. */
export function newRunPrefix(nowMs: number): string {
  return `ct_${timestamp36(nowMs)}_${randomBytes(3).toString("hex")}`
}

export type TestDatabaseInfo = { name: string; comment: string | null }

/** Whether `name` is exactly a template, per-file or build database name this module creates. */
export function isOwnTestDatabase(name: string): boolean {
  return TEMPLATE_NAME.test(name) || CLONE_NAME.test(name) || BUILD_NAME.test(name)
}

function parseTime36(value: string | undefined): number | null {
  if (!value) return null
  const ms = Number.parseInt(value, 36)
  return Number.isSafeInteger(ms) ? ms : null
}

/**
 * The databases a sweep may drop (pure). Only our own names, never `keep`:
 * - build databases: abandoned by a crashed build (builds run under the advisory lock the sweep
 *   holds, so none can be in progress);
 * - per-file databases created more than 6 hours ago (crashed runs);
 * - templates last used more than 24 hours ago (their last use is in the database comment,
 *   refreshed under the lock by every run, so a template a run is cloning from is never stale).
 */
export function staleTestDatabases(
  databases: readonly TestDatabaseInfo[],
  keep: string,
  nowMs: number,
): string[] {
  return databases
    .filter(({ name, comment }) => {
      if (name === keep) return false
      if (BUILD_NAME.test(name)) return true
      const clone = CLONE_NAME.exec(name)
      if (clone) {
        const createdAt = parseTime36(clone[1])
        return createdAt !== null && nowMs - createdAt > CLONE_STALE_AFTER_MS
      }
      const template = TEMPLATE_NAME.exec(name)
      if (template) {
        const lastUsed = Number(LAST_USED_COMMENT.exec(comment ?? "")?.[1] ?? Number.NaN)
        const since = Number.isSafeInteger(lastUsed) ? lastUsed : parseTime36(template[1])
        return since !== null && nowMs - since > TEMPLATE_STALE_AFTER_MS
      }
      return false
    })
    .map(({ name }) => name)
}

async function withAdmin<T>(adminUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function listDatabases(client: Client, likePattern: string): Promise<string[]> {
  return (await listDatabaseInfo(client, likePattern)).map((database) => database.name)
}

async function listDatabaseInfo(client: Client, likePattern: string): Promise<TestDatabaseInfo[]> {
  const result = await client.query<{ datname: string; comment: string | null }>(
    `SELECT datname, shobj_description(oid, 'pg_database') AS comment
       FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
    [likePattern],
  )
  return result.rows.map((row) => ({ name: row.datname, comment: row.comment }))
}

async function dropDatabase(client: Client, name: string): Promise<void> {
  if (!isOwnTestDatabase(name)) throw new Error(`Refusing to drop "${name}": not a test database`)
  if (name.startsWith(TEMPLATE_PREFIX)) {
    await client.query(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false`)
  }
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
}

/**
 * Return the template for the current migrations, creating it if missing, and mark it used.
 * Also drops stale test databases (`staleTestDatabases`).
 */
export async function ensureTemplateDatabase(adminUrl: string, nowMs: number): Promise<string> {
  assertNotProduction("create test databases")
  assertTestServer(adminUrl, "create and drop test databases")
  const hashPrefix = `${TEMPLATE_PREFIX}${migrationsHash()}_`

  return withAdmin(adminUrl, async (client) => {
    await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY])
    try {
      const [existing] = (await listDatabases(client, `${escapeLike(hashPrefix)}%`)).filter(
        (name) => TEMPLATE_NAME.test(name),
      )
      const template = existing ?? `${hashPrefix}${timestamp36(nowMs)}`

      if (!existing) {
        // Build under a temporary name so a failed migration never leaves a broken template.
        const building = `ct_build_${randomBytes(4).toString("hex")}`
        await client.query(`CREATE DATABASE ${quoteIdent(building)}`)
        try {
          await runMigrations(databaseUrl(adminUrl, building), MIGRATIONS_FOLDER)
        } catch (error) {
          await dropDatabase(client, building)
          throw error
        }
        await client.query(
          `ALTER DATABASE ${quoteIdent(building)} RENAME TO ${quoteIdent(template)}`,
        )
        await client.query(
          `ALTER DATABASE ${quoteIdent(template)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
        )
      }

      // `nowMs` is an integer, so the comment is a plain literal.
      await client.query(
        `COMMENT ON DATABASE ${quoteIdent(template)} IS 'ct:last_used=${Math.trunc(nowMs)}'`,
      )

      const databases = await listDatabaseInfo(client, `${escapeLike("ct_")}%`)
      for (const name of staleTestDatabases(databases, template, nowMs)) {
        await dropDatabase(client, name).catch(() => {
          // In use by another run right now: leave it for a later cleanup.
        })
      }
      return template
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY])
    }
  })
}

/** Postgres refuses to clone a template while something else uses it (SQLSTATE 55006). */
const OBJECT_IN_USE = "55006"

function isObjectInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === OBJECT_IN_USE
}

/** Create database `name` as a copy of `template`, retrying briefly if the template is busy. */
export async function cloneDatabase(
  adminUrl: string,
  template: string,
  name: string,
): Promise<void> {
  await withAdmin(adminUrl, async (client) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`)
        return
      } catch (error) {
        if (!isObjectInUse(error) || attempt >= 20) throw error
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
      }
    }
  })
}

export async function dropDatabases(adminUrl: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  await withAdmin(adminUrl, async (client) => {
    for (const name of names) await dropDatabase(client, name)
  })
}

/** Drop every per-file database this run created (teardown safety net for crashed files). */
export async function dropRunDatabases(adminUrl: string, runPrefix: string): Promise<void> {
  await withAdmin(adminUrl, async (client) => {
    for (const name of await listDatabases(client, `${escapeLike(`${runPrefix}_`)}%`)) {
      if (isOwnTestDatabase(name)) await dropDatabase(client, name)
    }
  })
}
