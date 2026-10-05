import { devMailboxEnabled } from "@/lib/env"
import { listOutbox } from "@/lib/email/outbox"

/** One email from the dev mailbox, rendered as sent. Same gating as the list (404 otherwise). */
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: Context): Promise<Response> {
  if (!devMailboxEnabled()) return new Response("Not found", { status: 404 })

  const { id } = await context.params
  const email = (await listOutbox()).find((candidate) => candidate.id === id)
  if (!email) return new Response("Not found", { status: 404 })

  return new Response(email.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Email HTML is shown as-is but may not run scripts; links still open on click.
      "Content-Security-Policy":
        "sandbox allow-popups allow-top-navigation-by-user-activation; script-src 'none'",
    },
  })
}
