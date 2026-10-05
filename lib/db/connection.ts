import { readFileSync } from "node:fs"
import type { ConnectionOptions } from "node:tls"

import type { PoolConfig } from "pg"

import { isStrictProductionEnv } from "../app-env"

/**
 * How the app, the scripts, the migrations and drizzle-kit connect to Postgres (pure apart from
 * reading a CA certificate file; reads no environment itself). CLAUDE.md §19.21, §19.23.
 *
 * **TLS** is decided here, never by node-postgres's URL parsing: node-postgres lets URL
 * parameters override the `ssl` option and falls back to `PGSSLMODE` / `PGSSLNEGOTIATION`. So
 * the URL's TLS parameters are read, removed, and replaced by explicit `ssl` and
 * `sslnegotiation` options:
 * - `DATABASE_SSL` (`disable | require | verify-full`) wins.
 * - Otherwise the URL decides. On every host but Supabase's, it means what it meant to
 *   node-postgres before this resolver existed, so no URL ever got weaker: `sslmode=require`,
 *   `prefer`, `allow` and `verify-ca` verify the server like `verify-full`; `no-verify` (and, with
 *   `uselibpqcompat=true`, libpq's `prefer` / `require`) encrypt without verifying; `ssl=true`
 *   verifies; `sslnegotiation=direct` turns verified TLS on. On Supabase hosts the URL has
 *   libpq's meaning (`require`, `prefer`, `allow`, `no-verify` encrypt without verifying),
 *   because Node does not trust Supabase's CA, so node-postgres's meaning could only fail.
 * - With nothing in the URL: `require` for Supabase hosts, else `disable`.
 * - A CA certificate (`DATABASE_CA_CERT`, PEM text or a file path, or the URL's `sslrootcert`)
 *   always means `verify-full`: verification is never skipped silently while a CA is configured,
 *   and an explicit `disable` next to one is a configuration error.
 * - Unknown `sslmode`, `ssl` or `sslnegotiation` values are configuration errors, never ignored.
 *
 * **Production** (`production: true`) refuses, for any database off this machine, a connection
 * that is not encrypted, and one that does not verify the server unless `DATABASE_SSL=require`
 * says so on purpose; a Supabase server must always be verified against its own CA
 * (`productionTlsProblem`).
 *
 * **Pooling:** Supabase's transaction pooler (port 6543) does not keep session state between
 * transactions. The app never relies on any: drizzle sends unnamed statements, settings such as
 * `app.gdpr_erasure` are transaction-local (`set_config(…, true)`), and there are no advisory
 * locks, session `SET`s or `LISTEN`s (only the test tooling takes an advisory lock).
 */

export const DATABASE_SSL_MODES = ["disable", "require", "verify-full"] as const
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number]

/** DATABASE_POOL_MAX default: connections per app process. */
export const DEFAULT_DATABASE_POOL_MAX = 10
export const MAX_DATABASE_POOL_MAX = 100

/** Supabase's transaction pooler port (Supavisor, and the dedicated PgBouncer on db.<ref>). */
export const TRANSACTION_POOLER_PORT = 6543

/**
 * URL parameters about TLS that node-postgres would act on (they override `ssl`, and
 * `sslnegotiation=direct` alone turns `ssl` into `true`), plus `pgbouncer=true` (Prisma's
 * transaction-pooler hint, which `pg` would ignore anyway).
 */
const STRIPPED_PARAMS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
  "pgbouncer",
] as const

/** How the TLS handshake starts: Postgres's SSLRequest (default) or TLS at once (PG 17+). */
export type DatabaseSslNegotiation = "postgres" | "direct"

/** Which environment variable a configuration error is about. */
export type DatabaseConfigVariable =
  "DATABASE_URL" | "DATABASE_SSL" | "DATABASE_CA_CERT" | "DATABASE_POOL_MAX"

export class DatabaseConfigError extends Error {
  readonly variable: DatabaseConfigVariable

  constructor(variable: DatabaseConfigVariable, message: string) {
    // Messages never include the URL itself (it holds the password).
    super(message)
    this.name = "DatabaseConfigError"
    this.variable = variable
  }
}

export type DatabaseConnectionOptions = {
  /** DATABASE_SSL. */
  sslMode?: DatabaseSslMode | undefined
  /** DATABASE_CA_CERT: PEM text (real newlines or `\n` escapes) or the path of a PEM file. */
  caCert?: string | undefined
  /** Reads CA files (DATABASE_CA_CERT paths, `sslrootcert`); tests inject it. */
  readFile?: ((path: string) => string) | undefined
  /**
   * Production's rule (`productionTlsProblem`): when true, a connection production must not use
   * is a `DatabaseConfigError`. lib/env.ts passes it for the app, `databaseOptionsFromEnv` for
   * the scripts and drizzle-kit.
   */
  production?: boolean | undefined
}

/** Why the TLS mode is what it is. */
export type DatabaseSslSource = "DATABASE_SSL" | "url" | "ca_cert" | "supabase_host" | "default"

export type DatabaseEndpoint =
  /** `db.<ref>.supabase.co:5432` (IPv6 unless the project has the IPv4 add-on). */
  | "supabase_direct"
  /** `<pool>.pooler.supabase.com:5432` (Supavisor, session mode; IPv4). */
  | "supabase_session_pooler"
  /** `<pool>.pooler.supabase.com:6543` or the dedicated pooler `db.<ref>.supabase.co:6543`. */
  | "supabase_transaction_pooler"
  /** Another `*.supabase.co` / `*.supabase.com` address. */
  | "supabase_other"
  /** Anything else: local Postgres, the Supabase CLI's database, Neon, … */
  | "postgres"

export type DatabaseConnection = {
  /** DATABASE_URL without its TLS parameters (still holds the password: never log it). */
  connectionString: string
  /** What node-postgres gets as `ssl`. */
  ssl: false | ConnectionOptions
  /** What node-postgres gets as `sslnegotiation` (the URL's, else `postgres`). */
  sslNegotiation: DatabaseSslNegotiation
  sslMode: DatabaseSslMode
  sslSource: DatabaseSslSource
  /** Where the CA the server is verified against comes from; null for Node's built-in CAs. */
  ca: "DATABASE_CA_CERT" | "sslrootcert" | null
  host: string
  port: number
  database: string
  endpoint: DatabaseEndpoint
  /** Port 6543 (or `pgbouncer=true`): no session state between transactions. */
  transactionPooler: boolean
}

/** A host name as DNS compares it: lower case, without the root's trailing dot. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "")
}

/**
 * Hosts of Supabase databases: `db.<ref>.supabase.co` and `<region>.pooler.supabase.com` (also
 * written as a fully qualified name with a trailing dot).
 */
export function isSupabaseHost(hostname: string): boolean {
  return /(^|\.)supabase\.(co|com)$/.test(normalizeHost(hostname))
}

/**
 * Whether the database is on this machine, so plain text never leaves it: `localhost` (and
 * `*.localhost`), 127.0.0.0/8, `::1`, or a Unix socket directory. An empty host is not: node-postgres
 * then takes `PGHOST`, which may name anything.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.startsWith("/")
  )
}

/**
 * A PEM as stored in an environment variable: real newlines, or `\n` escapes (one-line values in
 * dashboards and `.env` files). Returns null for anything that holds no certificate.
 */
export function normalizePem(value: string): string | null {
  const pem = value.replaceAll("\\n", "\n").replaceAll("\r\n", "\n").trim()
  return /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(pem)
    ? `${pem}\n`
    : null
}

/** Whether a DATABASE_CA_CERT value is PEM text (else it is read as a file path). */
export function looksLikePem(value: string): boolean {
  return value.includes("-----BEGIN")
}

const readTextFile = (path: string): string => readFileSync(path, "utf8")

/**
 * The PEM of DATABASE_CA_CERT: the value itself when it is PEM text, else the contents of the
 * file it names (relative paths resolve from the working directory).
 */
export function loadCaCert(
  value: string,
  readFile: (path: string) => string = readTextFile,
  variable: "DATABASE_CA_CERT" | "sslrootcert" = "DATABASE_CA_CERT",
): string {
  const where = variable === "sslrootcert" ? "sslrootcert in DATABASE_URL" : "DATABASE_CA_CERT"
  const configVariable = variable === "sslrootcert" ? "DATABASE_URL" : "DATABASE_CA_CERT"
  const trimmed = value.trim()
  if (variable === "DATABASE_CA_CERT" && looksLikePem(trimmed)) {
    const pem = normalizePem(trimmed)
    if (!pem)
      throw new DatabaseConfigError(configVariable, `${where} does not contain a PEM certificate`)
    return pem
  }
  let contents: string
  try {
    contents = readFile(trimmed)
  } catch {
    throw new DatabaseConfigError(
      configVariable,
      `${where} must be a PEM certificate or the path of a file holding one; cannot read the file "${trimmed}"`,
    )
  }
  const pem = normalizePem(contents)
  if (!pem) {
    throw new DatabaseConfigError(
      configVariable,
      `${where}: the file "${trimmed}" holds no PEM certificate`,
    )
  }
  return pem
}

function parseUrl(connectionString: string): URL {
  try {
    const url = new URL(connectionString)
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("protocol")
    return url
  } catch {
    // The value is never echoed: it holds the password.
    throw new DatabaseConfigError(
      "DATABASE_URL",
      "DATABASE_URL must be a postgres:// connection string",
    )
  }
}

const unknownValue = (param: string, value: string, use: string) =>
  new DatabaseConfigError(
    "DATABASE_URL",
    `DATABASE_URL has an unknown ${param} "${value}" (use ${use}, or set DATABASE_SSL)`,
  )

/**
 * The TLS mode a URL asks for; null when it leaves the choice to us. See the module comment:
 * node-postgres's meaning on every host but Supabase's, libpq's on Supabase's. Throws for values
 * neither knows, so a typo can never turn TLS off.
 */
function sslModeFromUrl(params: URLSearchParams, supabase: boolean): DatabaseSslMode | null {
  const ssl = params.get("ssl")
  let fromSsl: DatabaseSslMode | null = null
  switch (ssl) {
    case null:
      break
    case "true":
    case "1":
      // node-postgres: TLS verified against Node's CAs.
      fromSsl = "verify-full"
      break
    case "false":
    case "0":
      fromSsl = "disable"
      break
    case "no-verify":
      fromSsl = "require"
      break
    default:
      throw unknownValue("ssl value", ssl, "ssl=true, sslmode=verify-full or sslmode=require")
  }

  const sslmode = params.get("sslmode")
  switch (sslmode) {
    case null:
      break
    case "disable":
      return "disable"
    case "verify-ca":
    case "verify-full":
      return "verify-full"
    case "allow":
    case "prefer":
    case "require":
    case "no-verify": {
      // Supabase: libpq's meaning (encrypted, server not verified; Node lacks Supabase's CA).
      if (supabase) return "require"
      // node-postgres: `no-verify` skips verification; with `uselibpqcompat=true`, libpq's
      // `prefer` / `require` do too. It treats every other value like verify-full.
      const libpq = params.get("uselibpqcompat") === "true"
      const unverified = libpq
        ? sslmode === "prefer" || sslmode === "require"
        : sslmode === "no-verify"
      return unverified ? "require" : "verify-full"
    }
    default:
      throw unknownValue("sslmode", sslmode, "disable, require or verify-full")
  }
  if (fromSsl) return fromSsl
  // libpq 16: sslrootcert=system means "verify against the system's CAs".
  if (params.get("sslrootcert") === "system") return "verify-full"
  // node-postgres: direct negotiation with nothing else configured means `ssl: true` (verified).
  // Supabase hosts already default to TLS (require).
  if (params.get("sslnegotiation") === "direct" && !supabase) return "verify-full"
  return null
}

function sslNegotiationFromUrl(params: URLSearchParams): DatabaseSslNegotiation {
  const value = params.get("sslnegotiation")
  if (value === null || value === "postgres") return "postgres"
  if (value === "direct") return "direct"
  throw unknownValue("sslnegotiation", value, "postgres or direct")
}

function endpointOf(host: string, port: number, transactionPooler: boolean): DatabaseEndpoint {
  if (!isSupabaseHost(host)) return "postgres"
  if (transactionPooler) return "supabase_transaction_pooler"
  if (/\.pooler\.supabase\.com$/i.test(host)) return "supabase_session_pooler"
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host) && port === 5432) return "supabase_direct"
  return "supabase_other"
}

/**
 * Resolve DATABASE_URL plus DATABASE_SSL / DATABASE_CA_CERT into what node-postgres gets.
 * Throws `DatabaseConfigError` (naming the variable) for contradictory or unreadable settings.
 */
export function resolveDatabaseConnection(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): DatabaseConnection {
  const url = parseUrl(connectionString)
  const params = url.searchParams
  const readFile = options.readFile ?? readTextFile

  if (params.has("sslcert") || params.has("sslkey")) {
    throw new DatabaseConfigError(
      "DATABASE_URL",
      "DATABASE_URL asks for a client certificate (sslcert/sslkey), which is not supported; remove those parameters",
    )
  }

  const host = decodeURIComponent(params.get("host") ?? url.hostname)
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/(?<=.)\.$/, "")
  const port = Number.parseInt(params.get("port") ?? url.port, 10) || 5432
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres"
  const transactionPooler = port === TRANSACTION_POOLER_PORT || params.get("pgbouncer") === "true"
  const supabase = isSupabaseHost(host)

  // The CA: DATABASE_CA_CERT wins over the URL's sslrootcert.
  const rootCert = params.get("sslrootcert")
  let ca: DatabaseConnection["ca"] = null
  let caPem: string | null = null
  if (options.caCert?.trim()) {
    caPem = loadCaCert(options.caCert, readFile, "DATABASE_CA_CERT")
    ca = "DATABASE_CA_CERT"
  } else if (rootCert && rootCert !== "system") {
    caPem = loadCaCert(rootCert, readFile, "sslrootcert")
    ca = "sslrootcert"
  }

  let sslMode: DatabaseSslMode
  let sslSource: DatabaseSslSource
  const fromUrl = sslModeFromUrl(params, supabase)
  const sslNegotiation = sslNegotiationFromUrl(params)
  if (options.sslMode) {
    sslMode = options.sslMode
    sslSource = "DATABASE_SSL"
  } else if (fromUrl) {
    sslMode = fromUrl
    sslSource = "url"
  } else if (supabase) {
    sslMode = "require"
    sslSource = "supabase_host"
  } else {
    sslMode = "disable"
    sslSource = "default"
  }

  if (ca) {
    const caName = ca === "DATABASE_CA_CERT" ? "DATABASE_CA_CERT" : "sslrootcert in DATABASE_URL"
    if (sslMode === "disable" && sslSource !== "default") {
      const off = sslSource === "DATABASE_SSL" ? "DATABASE_SSL=disable" : "DATABASE_URL's sslmode"
      throw new DatabaseConfigError(
        sslSource === "DATABASE_SSL" ? "DATABASE_SSL" : "DATABASE_URL",
        `${off} turns TLS off, but ${caName} is set: remove one of them`,
      )
    }
    // A configured CA is always used: the server is verified, never just encrypted.
    if (sslMode !== "verify-full") {
      sslMode = "verify-full"
      sslSource = "ca_cert"
    }
  } else if (sslMode === "verify-full" && supabase) {
    throw new DatabaseConfigError(
      "DATABASE_CA_CERT",
      "verifying a Supabase server needs its CA certificate, which Node does not trust by default: " +
        "set DATABASE_CA_CERT to the certificate from the Supabase dashboard (Database settings → " +
        "SSL configuration → Download certificate), or use DATABASE_SSL=require",
    )
  }

  if (sslNegotiation === "direct" && sslMode === "disable") {
    throw new DatabaseConfigError(
      sslSource === "DATABASE_SSL" ? "DATABASE_SSL" : "DATABASE_URL",
      "DATABASE_URL's sslnegotiation=direct starts with a TLS handshake, but TLS is off: remove one of them",
    )
  }

  for (const param of STRIPPED_PARAMS) params.delete(param)
  const ssl: DatabaseConnection["ssl"] =
    sslMode === "disable"
      ? false
      : sslMode === "require"
        ? { rejectUnauthorized: false }
        : caPem
          ? { ca: caPem, rejectUnauthorized: true }
          : { rejectUnauthorized: true }

  const connection: DatabaseConnection = {
    connectionString: url.toString(),
    ssl,
    sslNegotiation,
    sslMode,
    sslSource,
    ca,
    host,
    port,
    database,
    endpoint: endpointOf(host, port, transactionPooler),
    transactionPooler,
  }
  if (options.production) {
    const problem = productionTlsProblem(connection)
    if (problem) throw new DatabaseConfigError("DATABASE_URL", `DATABASE_URL: ${problem}`)
  }
  return connection
}

export type PgConnectionConfig = Pick<PoolConfig, "connectionString" | "ssl" | "sslnegotiation">

/**
 * What node-postgres gets: the connection string without TLS parameters plus explicit `ssl` and
 * `sslnegotiation` (explicit, so neither the URL nor PGSSLMODE / PGSSLNEGOTIATION can change them).
 */
export function pgConnectionConfig(connection: DatabaseConnection): PgConnectionConfig {
  return {
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    sslnegotiation: connection.sslNegotiation,
  }
}

/** The `pg` pool settings for a URL (`pgConnectionConfig` of its resolved connection). */
export function databasePoolConfig(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): PgConnectionConfig {
  return pgConnectionConfig(resolveDatabaseConnection(connectionString, options))
}

const ENDPOINT_LABELS: Record<DatabaseEndpoint, string> = {
  supabase_direct: "Supabase (direct connection)",
  supabase_session_pooler: "Supabase (session pooler)",
  supabase_transaction_pooler: "Supabase (transaction pooler)",
  supabase_other: "Supabase",
  postgres: "Postgres",
}

/** One line for logs: where the database is and how it is secured. Never the user or password. */
export function describeDatabaseConnection(connection: DatabaseConnection): string {
  const tls =
    connection.sslMode === "disable"
      ? "no TLS"
      : connection.sslMode === "require"
        ? "TLS, server not verified"
        : `TLS, server verified against ${connection.ca ?? "the system's CAs"}`
  const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host
  return `${ENDPOINT_LABELS[connection.endpoint]} at ${host}:${connection.port}, database "${connection.database}" (${tls})`
}

/**
 * The warning to log once when DATABASE_URL points at a transaction pooler, else null. `use` is
 * what connects: the app (fine) or migrations (better through the session pooler).
 */
export function transactionPoolerWarning(
  connection: DatabaseConnection,
  use: "app" | "migrations" = "app",
): string | null {
  if (!connection.transactionPooler) return null
  const base =
    `DATABASE_URL points at a transaction pooler (port ${connection.port}): session features ` +
    "(advisory locks, session-level SET, LISTEN/NOTIFY, named prepared statements) are unavailable."
  return use === "app"
    ? `${base} The app does not use them.`
    : `${base} Migrations work, but run them through the session pooler (port 5432) or the direct host when you can.`
}

/**
 * DATABASE_SSL / DATABASE_CA_CERT / DATABASE_POOL_MAX from an environment record, for the scripts
 * and drizzle.config.ts (the app reads them through lib/env.ts), plus `production` from
 * APP_ENV / NODE_ENV as lib/env.ts decides it, so `pnpm db:migrate`, `db:reset`, `admin:grant`
 * and drizzle-kit apply production's TLS rule like the app. Empty values count as unset.
 */
export function databaseOptionsFromEnv(
  source: Readonly<Record<string, string | undefined>>,
): DatabaseConnectionOptions & { poolMax: number } {
  const sslValue = source.DATABASE_SSL?.trim().toLowerCase() || undefined
  if (sslValue !== undefined && !isDatabaseSslMode(sslValue)) {
    throw new DatabaseConfigError(
      "DATABASE_SSL",
      `DATABASE_SSL must be one of ${DATABASE_SSL_MODES.join(", ")}`,
    )
  }
  const poolValue = source.DATABASE_POOL_MAX?.trim()
  const poolMax = poolValue ? Number(poolValue) : DEFAULT_DATABASE_POOL_MAX
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > MAX_DATABASE_POOL_MAX) {
    throw new DatabaseConfigError(
      "DATABASE_POOL_MAX",
      `DATABASE_POOL_MAX must be a whole number from 1 to ${MAX_DATABASE_POOL_MAX}`,
    )
  }
  return {
    sslMode: sslValue,
    caCert: source.DATABASE_CA_CERT?.trim() || undefined,
    production: isStrictProductionEnv(source),
    poolMax,
  }
}

export function isDatabaseSslMode(value: string): value is DatabaseSslMode {
  return (DATABASE_SSL_MODES as readonly string[]).includes(value)
}

/**
 * Production's rule for DATABASE_URL (applied by `resolveDatabaseConnection` with
 * `production: true`). Null when fine; otherwise the problem in plain words.
 * - A database on this machine (`isLoopbackHost`): anything goes, nothing leaves the machine.
 * - Supabase: encrypted and verified against Supabase's own CA (Node does not trust it).
 * - Any other host: encrypted and verified, unless `DATABASE_SSL=require` accepts an unverified
 *   server on purpose (a private CA the app is not given, an internal network).
 */
export function productionTlsProblem(connection: DatabaseConnection): string | null {
  if (isLoopbackHost(connection.host)) return null
  if (isSupabaseHost(connection.host)) {
    const fix =
      "set DATABASE_CA_CERT to the CA certificate from the Supabase dashboard (Database settings → SSL configuration → Download certificate)"
    if (connection.sslMode === "disable") return `Supabase connections must use TLS: ${fix}`
    if (connection.sslMode === "require" || !connection.ca) {
      return `in production the Supabase server must be verified, not just encrypted: ${fix}`
    }
    return null
  }
  const verify =
    "add sslmode=verify-full to DATABASE_URL, or set DATABASE_SSL=verify-full (with DATABASE_CA_CERT when the server's certificate comes from a private CA)"
  if (connection.sslMode === "disable") {
    return `in production a database that is not on this machine must use TLS: ${verify}`
  }
  if (connection.sslMode === "require" && connection.sslSource !== "DATABASE_SSL") {
    return (
      `in production the database server must be verified, not just encrypted: ${verify}; ` +
      "or set DATABASE_SSL=require to accept an unverified server on purpose"
    )
  }
  return null
}
