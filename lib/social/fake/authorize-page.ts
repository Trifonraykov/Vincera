import "server-only"

import { z } from "zod"

import { absoluteUrl } from "@/lib/urls"

import { SOCIAL_PROVIDER_META } from "../catalog"
import { isProviderFakeSafe, oauthCallbackPath } from "../registry"
import { socialProviderIdSchema, type SocialProviderId } from "../types"
import { listFakeAccounts, loadFakeFixture, type FakeAccountSummary } from "./fixtures"
import { mintFakeAuthorizationCode } from "./transport"

/**
 * The fake provider consent screen, `/api/dev/fake-oauth/<provider>/authorize` (§19.3,
 * CLAUDE.md §19.13). A fake provider's `authUrl()` points here instead of Google/Meta/TikTok/
 * GitHub. It lists the fixture accounts; "Authorize as <account>" mints a signed code for that
 * account and redirects to our real callback with `code` + `state`, like the real provider.
 *
 * Validates what a provider would: a client id, `response_type=code`, a `state`, an S256 PKCE
 * challenge when one is sent, and a `redirect_uri` that exactly matches our registered callback
 * (anything else is refused on the page, never redirected to). 404 unless the provider is fake.
 */

const paramsSchema = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  // GitHub's authorize endpoint takes no response_type; the others require `code`.
  response_type: z.literal("code").optional(),
  state: z.string().min(1).max(512),
  scope: z.string().max(1000).optional(),
  code_challenge: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  code_challenge_method: z.literal("S256").optional(),
})
type AuthorizeParams = z.infer<typeof paramsSchema>

/** The OAuth parameter names the page carries through its forms. */
const PARAM_NAMES = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
] as const

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } })
}

function resolveProvider(value: string): SocialProviderId | null {
  const parsed = socialProviderIdSchema.safeParse(value)
  if (!parsed.success || !isProviderFakeSafe(parsed.data)) return null
  return parsed.data
}

/** Read the parameters; TikTok calls the client id `client_key`. */
function readParams(
  provider: SocialProviderId,
  get: (name: string) => string | null,
): { ok: true; params: AuthorizeParams } | { ok: false; message: string } {
  const raw: Record<string, string> = {}
  for (const name of PARAM_NAMES) {
    const value = get(name === "client_id" && provider === "tiktok" ? "client_key" : name)
    if (value !== null && value !== "") raw[name] = value
  }
  const parsed = paramsSchema.safeParse(raw)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))]
    return { ok: false, message: `Invalid or missing parameters: ${fields.join(", ")}.` }
  }
  const params = parsed.data
  if (provider !== "github" && params.response_type !== "code") {
    return { ok: false, message: "response_type must be code." }
  }
  if (params.redirect_uri !== absoluteUrl(oauthCallbackPath(provider))) {
    return { ok: false, message: "redirect_uri does not match the registered callback URL." }
  }
  if (params.code_challenge && !params.code_challenge_method) {
    return { ok: false, message: "code_challenge_method must be S256." }
  }
  return { ok: true, params }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#0a0a0a;--muted:#525252;--card:#fff;--border:#e5e5e5;--primary:#171717;--primary-fg:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--card:#171717;--border:#262626;--primary:#fafafa;--primary-fg:#171717}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:32rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.25rem 0;color:var(--muted)}
.badge{display:inline-block;font-size:.75rem;border:1px solid var(--border);border-radius:999px;padding:.1rem .6rem;margin-bottom:1rem;color:var(--muted)}
ul{list-style:none;padding:0;margin:1.25rem 0;display:grid;gap:.75rem}li{background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:1rem}
li p{font-size:.875rem}button{font:inherit;cursor:pointer;border-radius:.5rem;padding:.5rem .9rem;border:1px solid var(--border);background:var(--card);color:var(--fg)}
button.primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary);margin-top:.75rem;width:100%}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}code{font-size:.8rem;word-break:break-all}
`

/**
 * Chrome applies `form-action` to the redirect that follows a form post, so the callback's
 * origin (NEXT_PUBLIC_APP_URL) is allowed next to 'self'.
 */
function formActionSources(): string {
  return `'self' ${new URL(absoluteUrl("/")).origin}`
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources()}; frame-ancestors 'none'; base-uri 'none'`,
      "Referrer-Policy": "no-referrer",
    },
  })
}

function errorPage(provider: SocialProviderId, message: string): Response {
  const label = SOCIAL_PROVIDER_META[provider].label
  return page(
    `${label} (fake): request refused`,
    `<span class="badge">Development only · fake ${escapeHtml(label)}</span><h1>This authorization request was refused</h1><p role="alert">${escapeHtml(message)}</p>`,
    400,
  )
}

function hiddenInputs(provider: SocialProviderId, params: AuthorizeParams): string {
  return PARAM_NAMES.flatMap((name) => {
    const value = params[name]
    if (value === undefined) return []
    const field = name === "client_id" && provider === "tiktok" ? "client_key" : name
    return [`<input type="hidden" name="${field}" value="${escapeHtml(value)}">`]
  }).join("")
}

function consentPage(
  provider: SocialProviderId,
  params: AuthorizeParams,
  accounts: readonly FakeAccountSummary[],
): Response {
  const label = SOCIAL_PROVIDER_META[provider].label
  const hidden = hiddenInputs(provider, params)
  const scopes = params.scope
    ? `<p>Requested access: <code>${escapeHtml(params.scope)}</code></p>`
    : "<p>Requested access: public, read-only data.</p>"
  const list =
    accounts.length === 0
      ? `<p role="alert">No fixture accounts found in <code>tests/fixtures/social/${provider}/</code>.</p>`
      : `<ul>${accounts
          .map(
            (account) =>
              `<li><form method="post">${hidden}<input type="hidden" name="account" value="${escapeHtml(account.key)}"><input type="hidden" name="decision" value="allow"><strong>${escapeHtml(account.label)}</strong><p>${escapeHtml(account.description)}</p><button type="submit" class="primary">Authorize as ${escapeHtml(account.label)}</button></form></li>`,
          )
          .join("")}</ul>`
  const deny = `<form method="post">${hidden}<input type="hidden" name="decision" value="deny"><button type="submit">Cancel</button></form>`
  return page(
    `Sign in with ${label} (fake)`,
    `<span class="badge">Development only · fake ${escapeHtml(label)}</span><h1>Connect a ${escapeHtml(label)} account</h1><p>No real ${escapeHtml(label)} credentials are configured, so this page stands in for ${escapeHtml(label)}'s consent screen. Pick a recorded test account.</p>${scopes}${list}${deny}`,
  )
}

function redirectBack(
  provider: SocialProviderId,
  params: AuthorizeParams,
  query: Record<string, string>,
): Response {
  const url = new URL(params.redirect_uri)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  url.searchParams.set("state", params.state)
  // Instagram appends `#_` to its redirect; the browser keeps it client-side only.
  const location = provider === "instagram" ? `${url.toString()}#_` : url.toString()
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  })
}

export async function fakeAuthorizeGet(request: Request, providerParam: string): Promise<Response> {
  const provider = resolveProvider(providerParam)
  if (!provider) return notFound()
  const query = new URL(request.url).searchParams
  const read = readParams(provider, (name) => query.get(name))
  if (!read.ok) return errorPage(provider, read.message)
  return consentPage(provider, read.params, await listFakeAccounts(provider))
}

export async function fakeAuthorizePost(
  request: Request,
  providerParam: string,
): Promise<Response> {
  const provider = resolveProvider(providerParam)
  if (!provider) return notFound()
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorPage(provider, "The form could not be read.")
  }
  const field = (name: string) => {
    const value = form.get(name)
    return typeof value === "string" ? value : null
  }
  const read = readParams(provider, field)
  if (!read.ok) return errorPage(provider, read.message)
  const { params } = read

  if (field("decision") !== "allow") {
    return redirectBack(provider, params, {
      error: "access_denied",
      error_description: "The user denied the request.",
    })
  }
  const account = field("account") ?? ""
  if (!(await loadFakeFixture(provider, account))) {
    return errorPage(provider, "Unknown test account.")
  }
  const code = mintFakeAuthorizationCode({
    provider,
    account,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
  })
  return redirectBack(provider, params, { code })
}
