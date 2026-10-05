import { isFake, isProduction } from "@/lib/env"
import { extractUrls, listOutbox } from "@/lib/email/outbox"

/**
 * Dev mailbox for the fake email service (§19.3): lists the emails in `.data/outbox/` with their
 * links, so magic links can be clicked from a browser (e.g. when running in Docker). Does not
 * exist (404) unless email is fake, and never in production.
 */
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  if (isProduction() || !isFake("email")) return new Response("Not found", { status: 404 })

  const emails = (await listOutbox()).reverse()
  const rows = emails
    .map((email) => {
      const links = extractUrls(email)
        .map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(shorten(url))}</a></li>`)
        .join("")
      return `<article>
  <header><strong>${escapeHtml(email.subject)}</strong>
  <span>to ${escapeHtml(email.to.join(", "))} · ${escapeHtml(email.sentAt)}</span>
  <a href="/api/dev/mailbox/${encodeURIComponent(email.id)}">view email</a></header>
  ${links ? `<ul>${links}</ul>` : ""}
</article>`
    })
    .join("\n")

  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dev mailbox</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 760px; margin: 0 auto; padding: 16px; }
  article { border: 1px solid #8884; border-radius: 8px; padding: 12px; margin: 12px 0; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  header span { color: #888; font-size: 0.9em; }
  ul { margin: 8px 0 0; padding-left: 20px; word-break: break-all; }
</style></head>
<body>
<h1>Dev mailbox</h1>
<p>Emails the app "sent" while the email service is fake. Newest first. Click a magic link to sign in. <a href="">Refresh</a></p>
${rows || "<p>No emails yet.</p>"}
</body></html>`)
}

function shorten(url: string): string {
  return url.length > 90 ? `${url.slice(0, 87)}...` : url
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
