import { describe, expect, it } from "vitest"

import { isOwnTestDatabase, newRunPrefix, staleTestDatabases } from "../../helpers/db-template"

/** The integration-test database sweep only ever drops databases it created (CLAUDE.md §19.4). */

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 5, 12)
const t36 = (ms: number) => ms.toString(36)

const template = (hash: string, createdMs: number) => `ct_tpl_${hash}_${t36(createdMs)}`
const clone = (createdMs: number) => `ct_${t36(createdMs)}_a1b2c3_0123abcd`

describe("isOwnTestDatabase", () => {
  it("recognises the names this module generates", () => {
    expect(isOwnTestDatabase(`${newRunPrefix(NOW)}_0123abcd`)).toBe(true)
    expect(isOwnTestDatabase(template("0123456789ab", NOW))).toBe(true)
    expect(isOwnTestDatabase("ct_build_0123abcd")).toBe(true)
  })

  it.each([
    "ct_shop",
    "ct_app_data",
    "ct_tpl_mine",
    "ct_tpl_0123456789ab_x",
    "ct_build_production",
    "ct_mfx1abcd_a1b2c3",
    "creator_test",
  ])("leaves %s alone", (name) => {
    expect(isOwnTestDatabase(name)).toBe(false)
  })
})

describe("staleTestDatabases", () => {
  const current = template("aaaaaaaaaaaa", NOW - 72 * HOUR)

  it("never touches names it did not generate, or the current template", () => {
    const databases = ["ct_shop", "ct_app_data", "ct_tpl_x", current].map((name) => ({
      name,
      comment: null,
    }))
    expect(staleTestDatabases(databases, current, NOW)).toEqual([])
  })

  it("drops per-file databases of runs older than 6 hours, and abandoned builds", () => {
    const old = clone(NOW - 7 * HOUR)
    const recent = clone(NOW - 1 * HOUR)
    const databases = [old, recent, "ct_build_0123abcd"].map((name) => ({ name, comment: null }))
    expect(staleTestDatabases(databases, current, NOW)).toEqual([old, "ct_build_0123abcd"])
  })

  it("keeps other templates while they are in use, judged by their last use", () => {
    const created = NOW - 30 * 24 * HOUR
    const inUse = template("bbbbbbbbbbbb", created)
    const unused = template("cccccccccccc", created)
    const neverMarked = template("dddddddddddd", created)
    const databases = [
      { name: inUse, comment: `ct:last_used=${NOW - 2 * HOUR}` },
      { name: unused, comment: `ct:last_used=${NOW - 25 * HOUR}` },
      { name: neverMarked, comment: null },
    ]
    expect(staleTestDatabases(databases, current, NOW)).toEqual([unused, neverMarked])
  })
})
