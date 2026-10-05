import type { ComponentType, SVGProps } from "react"

import { Button } from "@/components/ui/button"
import { signInWithProvider } from "@/lib/auth/actions"
import type { OAuthProviderId } from "@/lib/auth/config"

import { GitHubIcon, GoogleIcon } from "./provider-icons"

const PROVIDERS: Record<
  OAuthProviderId,
  { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  google: { label: "Google", icon: GoogleIcon },
  github: { label: "GitHub", icon: GitHubIcon },
}

/**
 * "Continue with Google/GitHub": one small form per configured provider, posting to the
 * `signInWithProvider` server action. Renders nothing when no provider is configured.
 */
export function OAuthButtons({
  providers,
  callbackUrl,
}: {
  providers: readonly OAuthProviderId[]
  callbackUrl?: string
}) {
  if (providers.length === 0) return null

  return (
    <div className="grid gap-2">
      {providers.map((id) => {
        const { label, icon: Icon } = PROVIDERS[id]
        return (
          <form key={id} action={signInWithProvider}>
            <input type="hidden" name="provider" value={id} />
            {callbackUrl ? <input type="hidden" name="callbackUrl" value={callbackUrl} /> : null}
            <Button type="submit" variant="outline" className="w-full">
              <Icon className="size-4" />
              Continue with {label}
            </Button>
          </form>
        )
      })}
      <div className="relative py-2 text-center text-xs text-muted-foreground">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <span className="relative bg-card px-2">or use your email</span>
      </div>
    </div>
  )
}
