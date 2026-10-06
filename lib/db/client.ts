import "server-only"

import { is } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { PgTransaction } from "drizzle-orm/pg-core"
import { Pool, type PoolConfig } from "pg"

import { env } from "@/lib/env"

import {
  describeDatabaseConnection,
  pgConnectionConfig,
  resolveDatabaseConnection,
  transactionPoolerWarning,
  type DatabaseConnectionOptions,
} from "./connection"
import * as schema from "./schema"

/**
 * Database access (server only).
 *
 * - `db` / `getDb()`: the app's singleton, connected to DATABASE_URL on first use. The pool is
 *   kept on `globalThis` in development so hot reloads do not open new pools.
 * - `createDb(url)`: a separate instance with its own pool, for scripts and tests.
 * - Functions that read or write take a `DbOrTx` argument (dependency injection) so callers can
 *   pass a transaction and tests can pass their own database. Default to `getDb()` only at the
 *   edges (server actions, route handlers, jobs).
 */

export type Schema = typeof schema
export type Db = NodePgDatabase<Schema>
/** The `tx` handed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type DbOrTx = Db | Tx

export type DbHandle = {
  db: Db
  pool: Pool
  /** Close the pool. The instance is unusable afterwards. */
  close: () => Promise<void>
}

/**
 * A new drizzle instance with its own pool. Callers own it and must `close()` it. `sslMode`
 * (DATABASE_SSL) and `caCert` (DATABASE_CA_CERT) decide TLS for hosted databases such as
 * Supabase; the URL's own TLS parameters are replaced by an explicit `ssl` (lib/db/connection.ts).
 */
export function createDb(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString" | "ssl" | "sslnegotiation"> &
    DatabaseConnectionOptions = {},
): DbHandle {
  const { sslMode, caCert, readFile, production, ...poolConfig } = options
  const connection = resolveDatabaseConnection(connectionString, {
    sslMode,
    caCert,
    readFile,
    production,
  })
  const pool = new Pool({ ...poolConfig, ...pgConnectionConfig(connection) })
  // An idle client losing its connection (DB restart, terminated backend) must not crash the
  // process; the pool replaces the client on the next query.
  pool.on("error", (error) => {
    console.error(`Postgres pool: idle client error: ${error.message}`)
  })
  const db = drizzle(pool, { schema })
  return { db, pool, close: () => pool.end() }
}

const globalForDb = globalThis as typeof globalThis & {
  __appDb?: DbHandle
  /** Set once the connection line (and any pooler warning) was logged in this process. */
  __appDbLogged?: boolean
}
let appDb: DbHandle | undefined

/**
 * The app's pool: DATABASE_URL with DATABASE_SSL / DATABASE_CA_CERT, at most DATABASE_POOL_MAX
 * connections. Logs where the database is (never the user or password) once per process, plus a
 * warning when it is a transaction pooler.
 */
function createAppDb(): DbHandle {
  const options = { sslMode: env.DATABASE_SSL, caCert: env.DATABASE_CA_CERT }
  if (!globalForDb.__appDbLogged) {
    globalForDb.__appDbLogged = true
    const connection = resolveDatabaseConnection(env.DATABASE_URL, options)
    console.info(`[db] ${describeDatabaseConnection(connection)}`)
    const warning = transactionPoolerWarning(connection, "app")
    if (warning) console.warn(`[db] ${warning}`)
  }
  return createDb(env.DATABASE_URL, { ...options, max: env.DATABASE_POOL_MAX })
}

/** The app's database, created on first use from DATABASE_URL. */
export function getDb(): Db {
  appDb ??= globalForDb.__appDb ?? createAppDb()
  if (process.env.NODE_ENV !== "production") globalForDb.__appDb = appDb
  return appDb.db
}

/** Close the app's pool (scripts and tests). The next `getDb()` opens a new one. */
export async function closeDb(): Promise<void> {
  const handle = appDb ?? globalForDb.__appDb
  appDb = undefined
  globalForDb.__appDb = undefined
  await handle?.close()
}

/**
 * The app's database, connected lazily on first property access (like `env`), so importing this
 * module never needs DATABASE_URL. Equivalent to `getDb()`.
 */
export const db: Db = new Proxy({} as Db, {
  get: (_target, key) => Reflect.get(getDb(), key),
  has: (_target, key) => Reflect.has(getDb(), key),
  // Keeps `instanceof` and drizzle's `is(db, PgDatabase)` working through the proxy.
  getPrototypeOf: () => Reflect.getPrototypeOf(getDb()),
})

export function isTransaction(database: DbOrTx): database is Tx {
  return is(database, PgTransaction)
}

/**
 * Run `fn` in a transaction. Given a transaction, runs in a nested one (a savepoint), so helpers
 * can call this whether or not their caller already opened a transaction.
 */
export function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  database: DbOrTx = getDb(),
): Promise<T> {
  return database.transaction(fn)
}
