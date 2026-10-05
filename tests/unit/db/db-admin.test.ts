import { describe, expect, it, vi } from "vitest"

import {
  assertNotProduction,
  assertTestServer,
  describeError,
  isLocalDatabase,
  isTestDatabaseName,
  parseDatabaseUrl,
} from "@/scripts/lib/db-admin"

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
