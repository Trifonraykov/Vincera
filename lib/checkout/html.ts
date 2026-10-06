/**
 * A small standalone HTML page for the checkout route's refusals (sold out, not available, too many
 * attempts, Stripe unavailable): a route handler cannot render the app's React pages, and buyers
 * have no account to send them to. Light and dark, phone width, no scripts. Like `/r/[code]`'s 404.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export type MessagePage = {
  status: number
  title: string
  body: string
  /** Same-origin path for the one button. */
  link: { href: string; label: string }
  headers?: Record<string, string>
}

export function messagePageResponse(page: MessagePage): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>${escapeHtml(page.title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100svh;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:#fff;color:#0a0a0a}main{max-width:28rem;text-align:center}h1{font-size:1.25rem}a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1.25rem;border-radius:.5rem;background:#171717;color:#fafafa;text-decoration:none;font-weight:600}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}a{background:#fafafa;color:#171717}}</style></head><body><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.body)}</p><p><a href="${escapeHtml(page.link.href)}">${escapeHtml(page.link.label)}</a></p></main></body></html>`
  return new Response(html, {
    status: page.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
      ...page.headers,
    },
  })
}
