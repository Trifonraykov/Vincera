import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ConnectionOptions } from "node:tls"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  databaseOptionsFromEnv,
  databasePoolConfig,
  DatabaseConfigError,
  describeDatabaseConnection,
  isLoopbackHost,
  isSupabaseHost,
  loadCaCert,
  normalizePem,
  productionTlsProblem,
  resolveDatabaseConnection,
  transactionPoolerWarning,
  type DatabaseConnectionOptions,
} from "@/lib/db/connection"

/** node-postgres's own modules (dependencies of `pg`, not of the app). */
const requireFromPg = createRequire(createRequire(import.meta.url).resolve("pg"))
const parsePgUrl = requireFromPg("pg-connection-string").parse as (url: string) => {
  ssl?: boolean | ConnectionOptions
}
type PgConnectionParameters = {
  ssl: boolean | string | ConnectionOptions
  sslnegotiation?: string
  host: string
  port: number
}
const ConnectionParameters = requireFromPg("./connection-parameters") as new (config: {
  connectionString?: string
  ssl?: boolean | ConnectionOptions
  sslnegotiation?: string
}) => PgConnectionParameters

/** Shape only; not a real CA. */
const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIDxTCCAq2gAwIBAgIBADANBgkqhkiG9w0BAQsFADA=\n-----END CERTIFICATE-----"
const PEM_OUT = `${PEM}\n`

const REF = "abcdefghijklmnopqrst"
const DIRECT = `postgresql://postgres:s3cret@db.${REF}.supabase.co:5432/postgres`
const SESSION = `postgresql://postgres.${REF}:s3cret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`
const TRANSACTION = `postgresql://postgres.${REF}:s3cret@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`
const DEDICATED = `postgresql://postgres:s3cret@db.${REF}.supabase.co:6543/postgres`
const LOCAL = "postgres://postgres:postgres@localhost:5432/creator_dev"
const SUPABASE_CLI = "postgres://postgres:postgres@127.0.0.1:54322/postgres"
/** Neon's default connection string (RDS, DigitalOcean, Aiven hand out the same sslmode). */
const NEON = "postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb"

/** A fake file system for CA paths. */
function files(entries: Record<string, string>): (path: string) => string {
  return (path) => {
    const contents = entries[path]
    if (contents === undefined) throw new Error(`ENOENT: ${path}`)
    return contents
  }
}

function resolve(url: string, options: DatabaseConnectionOptions = {}) {
  return resolveDatabaseConnection(url, options)
}

function configError(fn: () => unknown): DatabaseConfigError {
  try {
    fn()
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error
    throw error
  }
  throw new Error("expected a DatabaseConfigError")
}

describe("resolveDatabaseConnection: hosts and defaults", () => {
  it("leaves a local database in plain text and the URL untouched", () => {
    const connection = resolve(LOCAL)
    expect(connection).toMatchObject({
      connectionString: LOCAL,
      ssl: false,
      sslMode: "disable",
      sslSource: "default",
      ca: null,
      host: "localhost",
      port: 5432,
      database: "creator_dev",
      endpoint: "postgres",
      transactionPooler: false,
    })
    // The Supabase CLI's local database has TLS off too.
    expect(resolve(SUPABASE_CLI)).toMatchObject({ sslMode: "disable", endpoint: "postgres" })
  })

  it("encrypts every Supabase connection by default (require)", () => {
    for (const [url, endpoint] of [
      [DIRECT, "supabase_direct"],
      [SESSION, "supabase_session_pooler"],
      [TRANSACTION, "supabase_transaction_pooler"],
      [DEDICATED, "supabase_transaction_pooler"],
    ] as const) {
      expect(resolve(url)).toMatchObject({
        ssl: { rejectUnauthorized: false },
        sslMode: "require",
        sslSource: "supabase_host",
        endpoint,
        database: "postgres",
      })
    }
  })

  it("detects transaction poolers by port 6543 or pgbouncer=true", () => {
    expect(resolve(SESSION).transactionPooler).toBe(false)
    expect(resolve(DIRECT).transactionPooler).toBe(false)
    expect(resolve(TRANSACTION)).toMatchObject({ transactionPooler: true, port: 6543 })
    expect(resolve(DEDICATED).transactionPooler).toBe(true)
    const hinted = resolve("postgres://u:p@pgbouncer.internal:6432/app?pgbouncer=true")
    expect(hinted).toMatchObject({ transactionPooler: true, endpoint: "postgres" })
    expect(hinted.connectionString).toBe("postgres://u:p@pgbouncer.internal:6432/app")
  })

  it("recognises Supabase's hosts and nothing else", () => {
    expect(isSupabaseHost(`db.${REF}.supabase.co`)).toBe(true)
    expect(isSupabaseHost("aws-0-eu-central-1.pooler.supabase.com")).toBe(true)
    // A fully qualified name (trailing dot) is the same host.
    expect(isSupabaseHost(`db.${REF}.supabase.co.`)).toBe(true)
    expect(isSupabaseHost(`DB.${REF}.SUPABASE.CO`)).toBe(true)
    expect(isSupabaseHost("localhost")).toBe(false)
    expect(isSupabaseHost("supabase.com.evil.example")).toBe(false)
    expect(isSupabaseHost("notsupabase.co")).toBe(false)
  })

  it("treats a trailing-dot Supabase host like any Supabase host", () => {
    const fqdn = `postgresql://postgres:s3cret@db.${REF}.supabase.co.:5432/postgres`
    expect(resolve(fqdn)).toMatchObject({
      host: `db.${REF}.supabase.co`,
      endpoint: "supabase_direct",
      sslMode: "require",
      sslSource: "supabase_host",
    })
    expect(productionTlsProblem(resolve(fqdn))).toMatch(/Supabase server must be verified/)
  })

  it("knows which hosts are on this machine", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "db.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
    ]) {
      expect([host, isLoopbackHost(host)]).toEqual([host, true])
    }
    expect(isLoopbackHost("/var/run/postgresql")).toBe(true)
    for (const host of ["", "db", "10.0.0.5", "128.0.0.1", "localhost.example.com", "::2"]) {
      expect([host, isLoopbackHost(host)]).toEqual([host, false])
    }
  })

  it("refuses something that is not a postgres:// URL without echoing it", () => {
    for (const url of ["not a url", "mysql://root:hunter2@localhost/db"]) {
      const error = configError(() => resolve(url))
      expect(error.variable).toBe("DATABASE_URL")
      expect(error.message).not.toContain("hunter2")
    }
  })
})

describe("resolveDatabaseConnection: the URL's TLS parameters", () => {
  it("keeps node-postgres's meaning on hosts other than Supabase's (never weaker than before)", () => {
    const cases: [string, string, string][] = [
      ["sslmode=disable", "disable", "url"],
      // node-postgres verifies the server for all of these (sslmode=require included).
      ["sslmode=allow", "verify-full", "url"],
      ["sslmode=prefer", "verify-full", "url"],
      ["sslmode=require", "verify-full", "url"],
      ["sslmode=verify-ca", "verify-full", "url"],
      ["sslmode=verify-full", "verify-full", "url"],
      // Its own name for "encrypted, not verified"; and libpq's meaning when asked for.
      ["sslmode=no-verify", "require", "url"],
      ["sslmode=require&uselibpqcompat=true", "require", "url"],
      ["sslmode=prefer&uselibpqcompat=true", "require", "url"],
      ["sslmode=verify-ca&uselibpqcompat=true", "verify-full", "url"],
      ["sslrootcert=system", "verify-full", "url"],
      ["ssl=true", "verify-full", "url"],
      ["ssl=1", "verify-full", "url"],
      ["ssl=no-verify", "require", "url"],
      ["ssl=false", "disable", "url"],
      ["ssl=0", "disable", "url"],
      // sslmode wins over ssl, as in node-postgres.
      ["ssl=0&sslmode=require", "verify-full", "url"],
      ["sslnegotiation=direct", "verify-full", "url"],
      ["sslnegotiation=postgres", "disable", "default"],
    ]
    for (const [query, mode, source] of cases) {
      const connection = resolve(`${LOCAL}?${query}`)
      expect([query, connection.sslMode, connection.sslSource]).toEqual([query, mode, source])
      // The TLS parameters never reach node-postgres.
      expect(connection.connectionString).toBe(LOCAL)
    }
  })

  it("verifies Neon's default connection string, as node-postgres did", () => {
    const connection = resolve(`${NEON}?sslmode=require&channel_binding=require`)
    expect(connection).toMatchObject({
      ssl: { rejectUnauthorized: true },
      sslMode: "verify-full",
      sslSource: "url",
      ca: null,
      endpoint: "postgres",
    })
    expect(connection.connectionString).toBe(`${NEON}?channel_binding=require`)
    expect(describeDatabaseConnection(connection)).toMatch(
      /TLS, server verified against the system's CAs/,
    )
  })

  it("gives the URL libpq's meaning on Supabase hosts (Node does not trust Supabase's CA)", () => {
    for (const query of [
      "sslmode=allow",
      "sslmode=prefer",
      "sslmode=require",
      "sslmode=no-verify",
      "ssl=no-verify",
      "sslnegotiation=direct",
    ]) {
      expect([query, resolve(`${SESSION}?${query}`).sslMode]).toEqual([query, "require"])
    }
    expect(resolve(`${SESSION}?sslmode=disable`).sslMode).toBe("disable")
    for (const query of ["sslmode=verify-ca", "sslmode=verify-full", "ssl=true"]) {
      expect(configError(() => resolve(`${SESSION}?${query}`)).variable).toBe("DATABASE_CA_CERT")
    }
  })

  it("refuses values it does not know instead of ignoring them", () => {
    for (const query of ["sslmode=strict", "ssl=require", "ssl=yes", "sslnegotiation=fast"]) {
      const error = configError(() => resolve(`${NEON}?${query}`))
      expect([query, error.variable]).toEqual([query, "DATABASE_URL"])
      expect(error.message).not.toContain("u:p@")
    }
  })

  it("passes sslnegotiation to node-postgres itself and refuses it next to TLS off", () => {
    expect(resolve(`${SESSION}?sslnegotiation=direct`)).toMatchObject({
      sslNegotiation: "direct",
      sslMode: "require",
      ssl: { rejectUnauthorized: false },
    })
    expect(resolve(SESSION).sslNegotiation).toBe("postgres")
    expect(resolve(`${SESSION}?sslnegotiation=direct`, { caCert: PEM }).ssl).toEqual({
      ca: PEM_OUT,
      rejectUnauthorized: true,
    })
    expect(
      configError(() => resolve(`${LOCAL}?sslnegotiation=direct&sslmode=disable`)).variable,
    ).toBe("DATABASE_URL")
    expect(
      configError(() => resolve(`${SESSION}?sslnegotiation=direct`, { sslMode: "disable" }))
        .variable,
    ).toBe("DATABASE_SSL")
  })

  it("verify-full without a CA trusts the system's CAs (other hosts)", () => {
    expect(resolve(`${LOCAL}?sslmode=verify-full`).ssl).toEqual({ rejectUnauthorized: true })
  })

  it("keeps the URL's other parameters", () => {
    const connection = resolve(
      `${SESSION}?sslmode=require&application_name=platform&connect_timeout=10`,
    )
    expect(connection.connectionString).toBe(
      `${SESSION}?application_name=platform&connect_timeout=10`,
    )
  })

  it("refuses client certificates", () => {
    expect(configError(() => resolve(`${LOCAL}?sslcert=/c.crt&sslkey=/c.key`)).message).toMatch(
      /client certificate/,
    )
  })
})

describe("resolveDatabaseConnection: DATABASE_SSL and DATABASE_CA_CERT", () => {
  it("DATABASE_SSL wins over the URL and the host", () => {
    expect(resolve(`${SESSION}?sslmode=verify-full`, { sslMode: "require" })).toMatchObject({
      sslMode: "require",
      sslSource: "DATABASE_SSL",
    })
    expect(resolve(SESSION, { sslMode: "disable" })).toMatchObject({ ssl: false })
    expect(resolve(`${LOCAL}?sslmode=disable`, { sslMode: "require" }).ssl).toEqual({
      rejectUnauthorized: false,
    })
  })

  it("verifies against DATABASE_CA_CERT given as PEM text, with real or escaped newlines", () => {
    for (const caCert of [PEM, PEM.replaceAll("\n", "\\n")]) {
      expect(resolve(SESSION, { caCert, sslMode: "verify-full" })).toMatchObject({
        ssl: { ca: PEM_OUT, rejectUnauthorized: true },
        sslMode: "verify-full",
        sslSource: "DATABASE_SSL",
        ca: "DATABASE_CA_CERT",
      })
    }
  })

  it("reads DATABASE_CA_CERT from a file path", () => {
    const readFile = files({ "certs/prod-ca-2021.crt": `${PEM}\r\n` })
    expect(resolve(SESSION, { caCert: "certs/prod-ca-2021.crt", readFile })).toMatchObject({
      ssl: { ca: PEM_OUT, rejectUnauthorized: true },
      ca: "DATABASE_CA_CERT",
    })
  })

  it("never skips verification while a CA is configured", () => {
    // Supabase's default (require), the URL's sslmode=require and an explicit DATABASE_SSL=require
    // all become verify-full; so does a local URL that said nothing.
    for (const [url, sslMode] of [
      [SESSION, undefined],
      [`${SESSION}?sslmode=require`, undefined],
      [SESSION, "require"],
      [LOCAL, undefined],
    ] as const) {
      expect(resolve(url, { sslMode, caCert: PEM })).toMatchObject({
        sslMode: "verify-full",
        sslSource: "ca_cert",
        ssl: { ca: PEM_OUT, rejectUnauthorized: true },
      })
    }
  })

  it("refuses to turn TLS off next to a CA", () => {
    const fromEnv = configError(() => resolve(SESSION, { sslMode: "disable", caCert: PEM }))
    expect(fromEnv.variable).toBe("DATABASE_SSL")
    expect(fromEnv.message).toMatch(/turns TLS off, but DATABASE_CA_CERT is set/)
    const fromUrl = configError(() => resolve(`${SESSION}?sslmode=disable`, { caCert: PEM }))
    expect(fromUrl.variable).toBe("DATABASE_URL")
  })

  it("uses the URL's sslrootcert file; DATABASE_CA_CERT wins over it", () => {
    const readFile = files({ "/etc/ssl/supabase.crt": PEM })
    expect(resolve(`${SESSION}?sslrootcert=/etc/ssl/supabase.crt`, { readFile })).toMatchObject({
      ca: "sslrootcert",
      sslMode: "verify-full",
      ssl: { ca: PEM_OUT, rejectUnauthorized: true },
    })
    const other = PEM.replace("MIID", "MIIE")
    expect(
      resolve(`${SESSION}?sslrootcert=/etc/ssl/supabase.crt`, { readFile, caCert: other }).ssl,
    ).toEqual({ ca: `${other}\n`, rejectUnauthorized: true })
  })

  it("explains an unreadable or empty CA", () => {
    const missing = configError(() =>
      resolve(SESSION, { caCert: "./nope.crt", readFile: files({}) }),
    )
    expect(missing.variable).toBe("DATABASE_CA_CERT")
    expect(missing.message).toMatch(/PEM certificate or the path of a file holding one/)
    const empty = configError(() =>
      resolve(SESSION, { caCert: "ca.crt", readFile: files({ "ca.crt": "nothing here" }) }),
    )
    expect(empty.message).toMatch(/holds no PEM certificate/)
    const broken = configError(() => resolve(SESSION, { caCert: "-----BEGIN CERTIFICATE----- x" }))
    expect(broken.message).toMatch(/does not contain a PEM certificate/)
    expect(
      configError(() => resolve(`${SESSION}?sslrootcert=/missing`, { readFile: files({}) }))
        .variable,
    ).toBe("DATABASE_URL")
  })

  it("asks for Supabase's CA when verify-full has none (Node does not trust it)", () => {
    const error = configError(() => resolve(SESSION, { sslMode: "verify-full" }))
    expect(error.variable).toBe("DATABASE_CA_CERT")
    expect(error.message).toMatch(/Download certificate/)
    expect(configError(() => resolve(`${DIRECT}?sslmode=verify-full`)).variable).toBe(
      "DATABASE_CA_CERT",
    )
  })

  it("loadCaCert normalises PEM text and file contents", () => {
    expect(loadCaCert(PEM.replaceAll("\n", "\\n"))).toBe(PEM_OUT)
    expect(loadCaCert("/ca.pem", files({ "/ca.pem": PEM }))).toBe(PEM_OUT)
    expect(normalizePem("")).toBeNull()
  })
})

/** How strongly a node-postgres `ssl` value protects the connection. */
function strength(ssl: unknown): 0 | 1 | 2 {
  if (!ssl) return 0
  if (typeof ssl === "object" && (ssl as ConnectionOptions).rejectUnauthorized === false) return 1
  return 2
}

describe("node-postgres gets exactly our ssl", () => {
  it("node-postgres alone would verify on sslmode=require (why the URL's TLS parameters go)", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined)
    onTestFinished(() => warn.mockRestore())
    // `{}` means TLS with Node's default verification: it fails against Supabase's own CA.
    expect(parsePgUrl(`${SESSION}?sslmode=require`).ssl).toEqual({})
  })

  it("no URL parameter, PGSSLMODE or PGSSLNEGOTIATION can override the explicit ssl", () => {
    vi.stubEnv("PGSSLMODE", "verify-full")
    vi.stubEnv("PGSSLNEGOTIATION", "direct")
    const readFile = files({ "/ca.crt": PEM })
    const cases: [string, DatabaseConnectionOptions][] = [
      [`${SESSION}?sslmode=require`, {}],
      [`${SESSION}?sslmode=verify-full&sslrootcert=/ca.crt`, { readFile }],
      [`${SESSION}?ssl=true&uselibpqcompat=true&sslmode=require`, { sslMode: "require" }],
      [`${LOCAL}?sslmode=require`, { sslMode: "disable" }],
      [LOCAL, {}],
      [TRANSACTION, { caCert: PEM }],
      // pg-connection-string turns a lone sslnegotiation=direct into `ssl: true`.
      [`${SESSION}?sslnegotiation=direct`, {}],
      [`${SESSION}?sslnegotiation=direct`, { caCert: PEM }],
      [`${NEON}?sslnegotiation=direct&sslmode=no-verify`, {}],
      [`${LOCAL}?sslnegotiation=postgres`, {}],
    ]
    for (const [url, options] of cases) {
      const params = new ConnectionParameters(databasePoolConfig(url, options))
      const connection = resolve(url, options)
      expect([url, params.ssl, params.sslnegotiation]).toEqual([
        url,
        connection.ssl,
        connection.sslNegotiation,
      ])
    }
  })

  it("is never weaker than node-postgres's own reading of a non-Supabase URL", () => {
    // What node-postgres made of a URL before this resolver existed, for every combination of
    // the TLS parameters, compared by strength (none < encrypted < verified).
    vi.stubEnv("PGSSLMODE", "")
    vi.stubEnv("PGSSLNEGOTIATION", "")
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined)
    onTestFinished(() => warn.mockRestore())
    const dir = mkdtempSync(path.join(tmpdir(), "pg-ca-"))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const caFile = path.join(dir, "ca.crt")
    writeFileSync(caFile, PEM)

    const sslmodes = [
      null,
      "disable",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
      "no-verify",
    ]
    // `ssl=false` is left out: node-postgres keeps the string "false", which is truthy, so it
    // used TLS by accident; we honour what it says (and production refuses plain text remotely).
    const ssls = [null, "true", "1", "0", "no-verify"]
    let compared = 0
    for (const sslmode of sslmodes) {
      for (const ssl of ssls) {
        for (const compat of [null, "true"]) {
          for (const negotiation of [null, "postgres", "direct"]) {
            for (const rootCert of [null, caFile]) {
              const query = new URLSearchParams()
              if (sslmode) query.set("sslmode", sslmode)
              if (ssl) query.set("ssl", ssl)
              if (compat) query.set("uselibpqcompat", compat)
              if (negotiation) query.set("sslnegotiation", negotiation)
              if (rootCert) query.set("sslrootcert", rootCert)
              const url = `${NEON}?${query.toString()}`
              let theirs: 0 | 1 | 2
              try {
                theirs = strength(new ConnectionParameters({ connectionString: url }).ssl)
              } catch {
                continue // node-postgres refuses it too (e.g. verify-ca without a CA, libpq mode)
              }
              let ours: 0 | 1 | 2
              try {
                ours = strength(resolve(url).ssl)
              } catch (error) {
                // Refusing a URL is never weaker than accepting it.
                expect(error).toBeInstanceOf(DatabaseConfigError)
                continue
              }
              compared++
              expect([url, ours >= theirs]).toEqual([url, true])
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(300)
  })
})

describe("logging helpers", () => {
  it("describes the connection without the user or password", () => {
    const line = describeDatabaseConnection(resolve(SESSION))
    expect(line).toBe(
      'Supabase (session pooler) at aws-1-eu-central-1.pooler.supabase.com:5432, database "postgres" (TLS, server not verified)',
    )
    expect(line).not.toContain("s3cret")
    expect(line).not.toContain(`postgres.${REF}`)
    expect(describeDatabaseConnection(resolve(TRANSACTION, { caCert: PEM }))).toMatch(
      /transaction pooler.*TLS, server verified against DATABASE_CA_CERT/,
    )
    expect(describeDatabaseConnection(resolve(LOCAL))).toBe(
      'Postgres at localhost:5432, database "creator_dev" (no TLS)',
    )
    expect(describeDatabaseConnection(resolve("postgres://u:p@[::1]:5432/db"))).toContain(
      "[::1]:5432",
    )
  })

  it("warns once-worthy text only for transaction poolers", () => {
    expect(transactionPoolerWarning(resolve(SESSION))).toBeNull()
    expect(transactionPoolerWarning(resolve(TRANSACTION), "app")).toMatch(
      /advisory locks, session-level SET, LISTEN\/NOTIFY.*The app does not use them/,
    )
    expect(transactionPoolerWarning(resolve(TRANSACTION), "migrations")).toMatch(
      /session pooler \(port 5432\)/,
    )
  })
})

describe("databaseOptionsFromEnv", () => {
  it("reads DATABASE_SSL, DATABASE_CA_CERT and DATABASE_POOL_MAX, empty meaning unset", () => {
    expect(databaseOptionsFromEnv({})).toEqual({
      sslMode: undefined,
      caCert: undefined,
      production: false,
      poolMax: 10,
    })
    expect(
      databaseOptionsFromEnv({
        DATABASE_SSL: " Verify-Full ",
        DATABASE_CA_CERT: ` ${PEM} `,
        DATABASE_POOL_MAX: "25",
      }),
    ).toEqual({ sslMode: "verify-full", caCert: PEM, production: false, poolMax: 25 })
    expect(databaseOptionsFromEnv({ DATABASE_SSL: "", DATABASE_POOL_MAX: " " })).toEqual({
      sslMode: undefined,
      caCert: undefined,
      production: false,
      poolMax: 10,
    })
  })

  it("says production exactly when lib/env.ts does (APP_ENV wins over NODE_ENV)", () => {
    const production = (source: Record<string, string>) => databaseOptionsFromEnv(source).production
    expect(production({ NODE_ENV: "production" })).toBe(true)
    expect(production({ APP_ENV: "production" })).toBe(true)
    expect(production({ NODE_ENV: "development", APP_ENV: "production" })).toBe(true)
    // e2e, CI and Docker run `next start` with NODE_ENV=production and a non-production APP_ENV.
    expect(production({ NODE_ENV: "production", APP_ENV: "test" })).toBe(false)
    expect(production({ NODE_ENV: "production", APP_ENV: "development" })).toBe(false)
    expect(production({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe(false)
    expect(production({ NODE_ENV: "test" })).toBe(false)
  })

  it("refuses invalid values", () => {
    expect(configError(() => databaseOptionsFromEnv({ DATABASE_SSL: "prefer" })).variable).toBe(
      "DATABASE_SSL",
    )
    for (const value of ["0", "-1", "2.5", "abc", "101"]) {
      expect(configError(() => databaseOptionsFromEnv({ DATABASE_POOL_MAX: value })).variable).toBe(
        "DATABASE_POOL_MAX",
      )
    }
  })
})

describe("productionTlsProblem", () => {
  it("accepts a Supabase server only when verified against our own CA", () => {
    expect(productionTlsProblem(resolve(SESSION, { caCert: PEM }))).toBeNull()
    expect(productionTlsProblem(resolve(SESSION))).toMatch(
      /must be verified, not just encrypted: set DATABASE_CA_CERT/,
    )
    // Even when DATABASE_SSL=require says so on purpose: Supabase's CA is one download away.
    expect(productionTlsProblem(resolve(SESSION, { sslMode: "require" }))).toMatch(
      /must be verified/,
    )
    expect(productionTlsProblem(resolve(SESSION, { sslMode: "disable" }))).toMatch(/must use TLS/)
  })

  it("lets anything through on this machine", () => {
    for (const url of [
      LOCAL,
      SUPABASE_CLI,
      "postgres://u:p@[::1]/db",
      `${LOCAL}?sslmode=no-verify`,
      "postgres://u:p@localhost/db?host=/var/run/postgresql",
    ]) {
      expect([url, productionTlsProblem(resolve(url))]).toEqual([url, null])
    }
  })

  it("requires every other host to be encrypted and verified, unless DATABASE_SSL=require", () => {
    expect(productionTlsProblem(resolve(`${NEON}?sslmode=require`))).toBeNull()
    expect(productionTlsProblem(resolve(`${NEON}?sslmode=verify-full`))).toBeNull()
    expect(productionTlsProblem(resolve(NEON, { caCert: PEM }))).toBeNull()
    expect(productionTlsProblem(resolve(NEON))).toMatch(
      /a database that is not on this machine must use TLS: add sslmode=verify-full/,
    )
    expect(productionTlsProblem(resolve(NEON, { sslMode: "disable" }))).toMatch(/must use TLS/)
    expect(productionTlsProblem(resolve("postgres://u:p@db:5432/postgres"))).toMatch(/must use TLS/)
    for (const query of [
      "sslmode=no-verify",
      "ssl=no-verify",
      "sslmode=require&uselibpqcompat=true",
    ]) {
      expect([query, productionTlsProblem(resolve(`${NEON}?${query}`))]).toEqual([
        query,
        expect.stringMatching(/must be verified, not just encrypted.*DATABASE_SSL=require/),
      ])
    }
    // An unverified server accepted on purpose.
    expect(productionTlsProblem(resolve(NEON, { sslMode: "require" }))).toBeNull()
  })

  it("is applied by resolveDatabaseConnection with production: true, naming DATABASE_URL", () => {
    expect(resolve(SESSION, { production: false }).sslMode).toBe("require")
    const error = configError(() => resolve(SESSION, { production: true }))
    expect(error.variable).toBe("DATABASE_URL")
    expect(error.message).toMatch(
      /^DATABASE_URL: in production the Supabase server must be verified/,
    )
    expect(error.message).not.toContain("s3cret")
    expect(
      configError(() => resolve(`${NEON}?sslmode=no-verify`, { production: true })).variable,
    ).toBe("DATABASE_URL")
    expect(resolve(`${NEON}?sslmode=require`, { production: true }).sslMode).toBe("verify-full")
    expect(resolve(LOCAL, { production: true }).sslMode).toBe("disable")
  })
})
