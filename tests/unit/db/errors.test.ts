import { DrizzleQueryError } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { getPgError, isPgError, PG_ERROR } from "@/lib/db/errors"

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
