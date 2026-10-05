import { ExternalLink, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"
import type { SocialProviderId } from "@/lib/social/types"

/** `/api/oauth/<provider>/start?returnTo=<path>`: where every Connect / Reconnect button goes. */
export function connectHref(provider: SocialProviderId, returnTo: string): string {
  return `/api/oauth/${provider}/start?${new URLSearchParams({ returnTo }).toString()}`
}

/**
 * Starts the OAuth connection flow (§7.1). A plain link, not `next/link`: the target is a route
 * handler that redirects to the provider, which must never be prefetched.
 */
export function ConnectButton({
  provider,
  returnTo,
  reconnect = false,
  variant = "default",
  label,
}: {
  provider: SocialProviderId
  /** The page to come back to (`?connected=<provider>` or `?error=<code>` is appended). */
  returnTo: string
  reconnect?: boolean
  variant?: "default" | "outline" | "secondary"
  label?: string
}) {
  const name = SOCIAL_PROVIDER_META[provider].label
  return (
    <Button asChild variant={variant} className="w-full sm:w-auto">
      <a href={connectHref(provider, returnTo)}>
        {reconnect ? <RefreshCw aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
        {label ?? (reconnect ? `Reconnect ${name}` : `Connect ${name}`)}
      </a>
    </Button>
  )
}
