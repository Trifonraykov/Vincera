import { redirect } from "next/navigation"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { authUser } from "../../helpers/auth-users"

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  reportError: vi.fn(),
  db: { kind: "test-db" },
}))

vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser }))
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }))
vi.mock("@/lib/db/client", () => ({ getDb: () => mocks.db }))

const { ACTION_MESSAGES, ActionError, defineAction, formDataToObject } =
  await import("@/lib/actions/define-action")

const input = z.object({ title: z.string().trim().min(3, "Use at least 3 characters.") })
/** Tests about other steps of the recipe authorize everyone. */
const allow = () => true

beforeEach(() => {
  mocks.requireUser.mockReset().mockResolvedValue(authUser())
  mocks.reportError.mockReset()
})

describe("defineAction", () => {
  it("parses input, loads the user, authorizes and returns the result", async () => {
    const authorize = vi.fn().mockReturnValue(true)
    const run = vi.fn(async ({ input: parsed }: { input: { title: string } }) => parsed.title)
    const action = defineAction({ name: "test.ok", input, authorize, run })

    await expect(action({ title: "  Budget app  " })).resolves.toEqual({
      ok: true,
      data: "Budget app",
    })
    expect(authorize).toHaveBeenCalledWith(authUser(), { title: "Budget app" })
    expect(run).toHaveBeenCalledWith({
      input: { title: "Budget app" },
      user: authUser(),
      db: mocks.db,
    })
  })

  it("returns field errors without touching the session when input is invalid", async () => {
    const run = vi.fn()
    const action = defineAction({ name: "test.invalid", input, authorize: allow, run })

    await expect(action({ title: "ab" })).resolves.toEqual({
      ok: false,
      error: ACTION_MESSAGES.invalidInput,
      fieldErrors: { title: ["Use at least 3 characters."] },
    })
    expect(mocks.requireUser).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("accepts FormData", async () => {
    const formData = new FormData()
    formData.set("title", "From a form")
    const action = defineAction({
      name: "test.form",
      input,
      authorize: allow,
      run: async ({ input: i }) => i,
    })
    await expect(action(formData)).resolves.toEqual({ ok: true, data: { title: "From a form" } })
  })

  it("refuses with a plain-language message when authorize says no", async () => {
    const run = vi.fn()
    const action = defineAction({
      name: "test.forbidden",
      input,
      authorize: async () => false,
      run,
    })
    await expect(action({ title: "Valid" })).resolves.toEqual({
      ok: false,
      error: ACTION_MESSAGES.forbidden,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("requires an authorize rule (§4), at compile time and at runtime", () => {
    const run = async () => "never"
    // @ts-expect-error -- `authorize` is required: an action without a permission check must not compile.
    expect(() => defineAction({ name: "test.unauthorized", input, run })).toThrow(
      /authorize is required/,
    )
  })

  it("shows ActionError messages and does not report them", async () => {
    const action = defineAction({
      name: "test.expected",
      input,
      authorize: allow,
      run: async () => {
        throw new ActionError("That idea is already archived.")
      },
    })
    await expect(action({ title: "Valid" })).resolves.toEqual({
      ok: false,
      error: "That idea is already archived.",
    })
    expect(mocks.reportError).not.toHaveBeenCalled()
  })

  it("reports unexpected errors and returns a generic message", async () => {
    const failure = new Error("connection reset; params: secret@example.com")
    const action = defineAction({
      name: "test.unexpected",
      input,
      authorize: allow,
      run: async () => {
        throw failure
      },
    })
    await expect(action({ title: "Valid" })).resolves.toEqual({
      ok: false,
      error: ACTION_MESSAGES.unexpected,
    })
    expect(mocks.reportError).toHaveBeenCalledWith(failure, {
      tags: { action: "test.unexpected" },
    })
  })

  it("lets Next.js redirects through (requireUser and run)", async () => {
    mocks.requireUser.mockImplementationOnce(async () => redirect("/sign-in"))
    const action = defineAction({
      name: "test.redirect",
      input,
      authorize: allow,
      run: async () => "never",
    })
    await expect(action({ title: "Valid" })).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    })

    const redirecting = defineAction({
      name: "test.redirect_run",
      input,
      authorize: allow,
      run: async () => redirect("/app"),
    })
    await expect(redirecting({ title: "Valid" })).rejects.toMatchObject({
      digest: expect.stringContaining("/app"),
    })
    expect(mocks.reportError).not.toHaveBeenCalled()
  })
})

describe("formDataToObject", () => {
  it("keeps single values and turns repeated keys into arrays", () => {
    const formData = new FormData()
    formData.append("title", "Hello")
    formData.append("topics", "ai")
    formData.append("topics", "tools")
    expect(formDataToObject(formData)).toEqual({ title: "Hello", topics: ["ai", "tools"] })
  })
})
