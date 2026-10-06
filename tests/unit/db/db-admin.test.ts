import { describe, expect, it, vi } from "vitest"

import { databaseOptionsFromEnv, DatabaseConfigError } from "@/lib/db/connection"
import {
  assertNotProduction,
  assertTestServer,
  DEFAULT_MIGRATIONS_FOLDER,
  describeError,
  isLocalDatabase,
  isTransientConnectionError,
  isTestDatabaseName,
  parseDatabaseUrl,
  runMigrations,
} from "@/scripts/lib/db-admin"
import { connectScriptDatabase } from "@/scripts/lib/script-db"

describe("parseDatabaseUrl", () => {
  it("returns the database name, host and the maintenance URL on the same server", () => {
    expect(
      parseDatabaseUrl("postgres://u:p@db.example.com:6543/creator_dev?sslmode=require"),
    ).toEqual({
      name: "creator_dev",
      host: "db.example.com",
      maintenanceUrl: "postgres://u:p@db.example.com:6543/postgres?sslmode=require",
    })
  })

  it("rejects names that could break out of an identifier", () => {
    expect(() => parseDatabaseUrl('postgres://localhost/bad"name')).toThrow(/Unsupported/)
    expect(() => parseDatabaseUrl("postgres://localhost/")).toThrow(/Unsupported/)
  })
})

describe("isLocalDatabase", () => {
  it("accepts loopback hosts only", () => {
    expect(isLocalDatabase("postgres://localhost:5432/x")).toBe(true)
    expect(isLocalDatabase("postgres://127.0.0.1/x")).toBe(true)
    expect(isLocalDatabase("postgres://db.example.com/x")).toBe(false)
  })
})

describe("isTestDatabaseName", () => {
  it.each(["creator_e2e", "creator_test", "e2e", "test_creator", "creator-e2e-2", "CREATOR_TEST"])(
    "accepts %s",
    (name) => expect(isTestDatabaseName(name)).toBe(true),
  )

  it.each(["attestations", "latest_prod", "creator_dev", "contest", "e2es", "postgres"])(
    "rejects %s",
    (name) => expect(isTestDatabaseName(name)).toBe(false),
  )
})

describe("assertTestServer", () => {
  it("allows local servers", () => {
    expect(() => assertTestServer("postgres://localhost/postgres", "drop", {})).not.toThrow()
  })

  it("refuses other hosts unless ALLOW_REMOTE_TEST_DB=1", () => {
    const remote = "postgres://u:p@staging.example.com/postgres"
    expect(() => assertTestServer(remote, "drop test databases", {})).toThrow(
      /Refusing to drop test databases on non-local host staging\.example\.com/,
    )
    expect(() => assertTestServer(remote, "drop", { ALLOW_REMOTE_TEST_DB: "true" })).toThrow()
    expect(() => assertTestServer(remote, "drop", { ALLOW_REMOTE_TEST_DB: "1" })).not.toThrow()
  })
})

// Env stubs are undone after each test (`unstubEnvs` in vitest.config.mts).
describe("assertNotProduction", () => {
  it("refuses when NODE_ENV or APP_ENV is production", () => {
    vi.stubEnv("APP_ENV", "production")
    expect(() => assertNotProduction("drop a database")).toThrow(/Refusing to drop a database/)
    vi.stubEnv("APP_ENV", "test")
    vi.stubEnv("NODE_ENV", "production")
    expect(() => assertNotProduction("drop a database")).toThrow(/production/)
  })

  it("allows development and test", () => {
    vi.stubEnv("APP_ENV", "test")
    vi.stubEnv("NODE_ENV", "test")
    expect(() => assertNotProduction("drop a database")).not.toThrow()
  })
})

describe("describeError", () => {
  it("appends the cause chain, where Drizzle keeps the driver's message", () => {
    const driver = new Error('database "creator_dev" does not exist')
    const wrapped = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', {
      cause: driver,
    })
    expect(describeError(wrapped)).toBe(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\n' +
        '  caused by: database "creator_dev" does not exist',
    )
  })

  it("prints non-errors as strings and stops on cycles", () => {
    expect(describeError("plain")).toBe("plain")
    const loop = new Error("loop")
    loop.cause = loop
    expect(describeError(loop).split("caused by").length).toBe(5)
  })
})

describe("isTransientConnectionError", () => {
  const withCode = (message: string, code: string) => Object.assign(new Error(message), { code })

  it("retries a database that is not reachable yet", () => {
    expect(
      isTransientConnectionError(withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")),
    ).toBe(true)
    expect(
      isTransientConnectionError(withCode("the database system is starting up", "57P03")),
    ).toBe(true)
    expect(isTransientConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true)
    // Drizzle wraps driver errors; Node wraps dual-stack connection failures.
    const refused = withCode("connect ECONNREFUSED ::1:5432", "ECONNREFUSED")
    expect(isTransientConnectionError(new Error("Failed query", { cause: refused }))).toBe(true)
    expect(isTransientConnectionError(new AggregateError([refused], "connect failed"))).toBe(true)
  })

  it("does not retry what waiting cannot fix", () => {
    expect(isTransientConnectionError(withCode("password authentication failed", "28P01"))).toBe(
      false,
    )
    expect(isTransientConnectionError(withCode('database "x" does not exist', "3D000"))).toBe(false)
    expect(
      isTransientConnectionError(withCode("getaddrinfo ENOTFOUND db.example", "ENOTFOUND")),
    ).toBe(false)
    expect(
      isTransientConnectionError(new Error("self-signed certificate in certificate chain")),
    ).toBe(false)
    expect(isTransientConnectionError(withCode('relation "x" already exists', "42P07"))).toBe(false)
    expect(isTransientConnectionError("ECONNREFUSED")).toBe(false)
  })
})

describe("production's TLS rule in the scripts (db:migrate, db:reset, admin:grant)", () => {
  // A hosted Supabase URL without DATABASE_CA_CERT: encrypted, but the server is not verified.
  const SUPABASE =
    "postgresql://postgres.abcdefghijklmnopqrst:s3cret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"

  it("runMigrations refuses it before connecting when the environment is production", async () => {
    const options = databaseOptionsFromEnv({ NODE_ENV: "production" })
    expect(options.production).toBe(true)
    const error = await runMigrations(SUPABASE, DEFAULT_MIGRATIONS_FOLDER, options).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(DatabaseConfigError)
    expect(describeError(error)).toMatch(
      /^DATABASE_URL: in production the Supabase server must be verified, not just encrypted: set DATABASE_CA_CERT/,
    )
    expect(describeError(error)).not.toContain("s3cret")
  })

  it("connectScriptDatabase applies it when APP_ENV / NODE_ENV say production", async () => {
    vi.stubEnv("DATABASE_URL", SUPABASE)
    vi.stubEnv("DATABASE_SSL", "")
    vi.stubEnv("DATABASE_CA_CERT", "")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("APP_ENV", "")
    expect(() => connectScriptDatabase()).toThrow(DatabaseConfigError)
    vi.stubEnv("APP_ENV", "production")
    vi.stubEnv("NODE_ENV", "development")
    expect(() => connectScriptDatabase()).toThrow(/Supabase server must be verified/)
    // Docker and e2e run with NODE_ENV=production and a non-production APP_ENV: allowed there.
    vi.stubEnv("APP_ENV", "development")
    vi.stubEnv("NODE_ENV", "production")
    const handle = connectScriptDatabase() // a pg pool connects on its first query only
    await handle.close()
  })
})
