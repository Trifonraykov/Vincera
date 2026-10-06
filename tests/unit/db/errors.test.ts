import { DrizzleQueryError } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { getPgError, isPgError, PG_ERROR, redactDbError, redactQueryParams } from "@/lib/db/errors"

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code,
    constraint,
  })
}

describe("getPgError / isPgError", () => {
  it("reads the Postgres error behind drizzle's DrizzleQueryError", () => {
    const wrapped = new DrizzleQueryError(
      "insert into users ...",
      [],
      pgError("23505", "users_email_unique"),
    )
    expect(getPgError(wrapped)).toMatchObject({ code: "23505", constraint: "users_email_unique" })
    expect(isPgError(wrapped, PG_ERROR.uniqueViolation)).toBe(true)
    expect(isPgError(wrapped, PG_ERROR.uniqueViolation, "users_email_unique")).toBe(true)
    expect(isPgError(wrapped, PG_ERROR.uniqueViolation, "other")).toBe(false)
    expect(isPgError(wrapped, PG_ERROR.checkViolation)).toBe(false)
  })

  it("recognises the append-only trigger code", () => {
    expect(isPgError(pgError("AO001"), PG_ERROR.appendOnlyViolation)).toBe(true)
  })

  it("returns null for anything else", () => {
    expect(getPgError(new Error("plain"))).toBeNull()
    expect(getPgError("not an error")).toBeNull()
    expect(getPgError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBeNull()
  })
})

describe("redactDbError (§11, §14: no query values in Sentry or logs)", () => {
  function driverError(): Error {
    return Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      {
        code: "23505",
        constraint: "users_email_unique",
        table: "users",
        detail: "Key (email)=(ada@example.com) already exists.",
        where: "SQL statement",
      },
    )
  }

  it("drops the parameters of a failed query and the driver's row details", () => {
    const failure = new DrizzleQueryError(
      'insert into "users" ("email", "name") values ($1, $2)',
      ["ada@example.com", "Ada Lovelace"],
      driverError(),
    )
    const safe = redactDbError(failure)

    expect(safe).toBeInstanceOf(Error)
    const message = (safe as Error).message
    expect(message).toBe(
      'Failed query: insert into "users" ("email", "name") values ($1, $2)\nparams: [redacted]',
    )
    expect(JSON.stringify(safe)).not.toContain("ada@example.com")
    expect((safe as Error).stack).not.toContain("ada@example.com")

    const cause = (safe as Error).cause as Error & Record<string, unknown>
    expect(cause.message).toContain("users_email_unique")
    expect(cause).toMatchObject({ code: "23505", constraint: "users_email_unique", table: "users" })
    expect(cause.detail).toBeUndefined()
    expect(cause.where).toBeUndefined()
    // Still recognisable by the helpers that branch on SQLSTATE.
    expect(isPgError(safe, PG_ERROR.uniqueViolation, "users_email_unique")).toBe(true)
  })

  it("redacts the input Postgres quotes in invalid-input messages", () => {
    const bad = Object.assign(new Error('invalid input syntax for type uuid: "ada@example.com"'), {
      code: "22P02",
    })
    expect((redactDbError(bad) as Error).message).toBe(
      "invalid input syntax for type uuid: [redacted]",
    )
  })

  it("walks wrappers and leaves unrelated errors untouched", () => {
    const plain = new Error("boom")
    expect(redactDbError(plain)).toBe(plain)
    expect(redactDbError("text")).toBe("text")

    const wrapped = new Error("sync failed", {
      cause: new DrizzleQueryError("select 1 where $1", ["secret-ciphertext"], undefined),
    })
    const safe = redactDbError(wrapped) as Error
    expect(safe.message).toBe("sync failed")
    expect((safe.cause as Error).message).toBe(
      "Failed query: select 1 where $1\nparams: [redacted]",
    )
  })

  it("redactQueryParams only touches failed-query messages", () => {
    expect(redactQueryParams("Failed query: select $1\nparams: a@b.c,1")).toBe(
      "Failed query: select $1\nparams: [redacted]",
    )
    expect(redactQueryParams("params: a@b.c")).toBe("params: a@b.c")
  })
})
