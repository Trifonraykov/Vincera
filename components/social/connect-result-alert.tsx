import { CircleAlert, CircleCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { SOCIAL_PROVIDER_META } from "@/lib/social/catalog"
import { connectErrorMessage } from "@/lib/social/connect-errors"
import { socialProviderIdSchema, type SocialProviderId } from "@/lib/social/types"

type SearchParams = Record<string, string | string[] | undefined>

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null
}

function providerFrom(value: string | null): SocialProviderId | null {
  const parsed = socialProviderIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The outcome of an OAuth connection flow, from the `?connected=<provider>` /
 * `?error=<code>&provider=<provider>` parameters the callback appends (lib/social/oauth-flow.ts).
 */
export function ConnectResultAlert({ searchParams }: { searchParams: SearchParams }) {
  const connected = providerFrom(single(searchParams.connected))
  const error = single(searchParams.error)
  const errorProvider = providerFrom(single(searchParams.provider))

  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>
          {errorProvider
            ? `${SOCIAL_PROVIDER_META[errorProvider].label} wasn't connected`
            : "That account wasn't connected"}
        </AlertTitle>
        <AlertDescription>{connectErrorMessage(error, errorProvider)}</AlertDescription>
      </Alert>
    )
  }
  if (connected) {
    const label = SOCIAL_PROVIDER_META[connected].label
    return (
      <Alert>
        <CircleCheck aria-hidden="true" />
        <AlertTitle>{label} connected</AlertTitle>
        <AlertDescription>
          We&apos;re fetching your {label} stats now. This usually takes a few seconds.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}
