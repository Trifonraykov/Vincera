/**
 * Browsers request /favicon.ico for pages that link no icon, such as the raw HTML of the fake
 * provider pages and the dev mailbox. Point them at the app icon (app/icon.svg) instead of a 404.
 */
export const dynamic = "force-static"

export function GET(): Response {
  // A relative Location: the route is rendered at build time, without the real host.
  return new Response(null, { status: 308, headers: { Location: "/icon.svg" } })
}
