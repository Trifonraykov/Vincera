import { describe, expect, it, vi } from "vitest"

import {
  scrubBreadcrumb,
  scrubEvent,
  sharedSentryOptions,
  withoutQuery,
  withoutQueryParams,
} from "@/sentry.shared"

const captureRequestError = vi.hoisted(() => vi.fn())
vi.mock("@sentry/nextjs", () => ({ captureRequestError }))

const { onRequestError } = await import("@/instrumentation")

/**
 * URLs can carry magic-link tokens, signed storage URLs and OAuth codes; none of that may reach
 * Sentry (§11, §14, §19.7).
 */

describe("withoutQuery", () => {
  it.each([
    ["/api/auth/callback/email?token=abc&email=a%40b.c", "/api/auth/callback/email"],
    ["/api/dev/storage/k?op=get&exp=1&sig=x#frag", "/api/dev/storage/k"],
    ["/app/ideas#top", "/app/ideas"],
    ["/app", "/app"],
    ["?only=query", ""],
  ])("%s → %s", (input, expected) => {
    expect(withoutQuery(input)).toBe(expected)
  })
})

describe("onRequestError", () => {
  it("reports the request path without its query string", () => {
    const error = new Error("boom")
    const context = {
      routerKind: "App Router",
      routePath: "/api/auth/[...nextauth]",
      routeType: "route",
      renderSource: undefined,
      revalidateReason: undefined,
      renderType: undefined,
    } as const
    const request = {
      path: "/api/auth/callback/email?token=secret-token&email=ada%40example.com",
      method: "GET",
      headers: {},
    }

    void onRequestError(error, request, context)

    expect(captureRequestError).toHaveBeenCalledWith(
      error,
      { ...request, path: "/api/auth/callback/email" },
      context,
    )
  })
})

describe("scrubEvent (beforeSend)", () => {
  it("is installed for every SDK", () => {
    expect(sharedSentryOptions.beforeSend).toBe(scrubEvent)
    expect(sharedSentryOptions.dataCollection.urlQueryParams).toBe(false)
  })

  it("drops the query string from the Next.js request context", () => {
    const event = {
      contexts: {
        nextjs: { request_path: "/access/tok?sig=abc", route_type: "render" },
        app: { app_name: "x" },
      },
    }
    expect(scrubEvent(event).contexts).toEqual({
      nextjs: { request_path: "/access/tok", route_type: "render" },
      app: { app_name: "x" },
    })
  })

  it("leaves events without that context alone", () => {
    expect(scrubEvent({})).toEqual({})
    expect(scrubEvent({ contexts: { nextjs: { router_kind: "App Router" } } })).toEqual({
      contexts: { nextjs: { router_kind: "App Router" } },
    })
  })
})

describe("scrubEvent: database errors", () => {
  const failed = 'Failed query: select * from "users" where "email" = $1\nparams: ada@example.com'
  const redacted = 'Failed query: select * from "users" where "email" = $1\nparams: [redacted]'

  it("removes query parameters from exceptions, breadcrumbs and messages", () => {
    const event = {
      exception: { values: [{ value: failed }, { value: "plain" }, {}] },
      breadcrumbs: [{ message: `[error] ${failed}` }, { message: "fine" }],
      message: failed,
    }
    expect(scrubEvent(event)).toEqual({
      exception: { values: [{ value: redacted }, { value: "plain" }, {}] },
      breadcrumbs: [{ message: `[error] ${redacted}` }, { message: "fine" }],
      message: redacted,
    })
  })

  it("drops console breadcrumbs' raw arguments, where a DrizzleQueryError keeps its params", () => {
    // What Sentry's console integration records for `console.error(error)` (Next logs errors
    // thrown from pages this way): the arguments as they are, serialised with own properties.
    class DrizzleQueryErrorLike extends Error {
      constructor(
        readonly query: string,
        readonly params: unknown[],
      ) {
        super(`Failed query: ${query}\nparams: ${params.join(",")}`)
      }
    }
    const error = new DrizzleQueryErrorLike('select * from "users" where "email" = $1', [
      "ada@example.com",
    ])
    const consoleBreadcrumb = () => ({
      category: "console",
      level: "error",
      message: `⨯ ${error.message}`,
      data: { arguments: ["⨯", error, { params: ["ada@example.com"] }], logger: "console" },
    })

    const event = scrubEvent({
      breadcrumbs: [consoleBreadcrumb(), { category: "http", data: { status_code: 500 } }],
    })
    expect(event.breadcrumbs).toEqual([
      {
        category: "console",
        level: "error",
        message: `⨯ ${redacted}`,
        data: { logger: "console" },
      },
      { category: "http", data: { status_code: 500 } },
    ])
    expect(JSON.stringify(event)).not.toContain("ada@example.com")

    // The same at the source, so the arguments never sit in the scope.
    expect(sharedSentryOptions.beforeBreadcrumb).toBe(scrubBreadcrumb)
    expect(JSON.stringify(scrubBreadcrumb(consoleBreadcrumb()))).not.toContain("ada@example.com")
  })

  it("withoutQueryParams keeps other text", () => {
    expect(withoutQueryParams("no query here")).toBe("no query here")
  })
})
