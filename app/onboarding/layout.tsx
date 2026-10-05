import type { Metadata } from "next"
import type { ReactNode } from "react"

import { Logo } from "@/components/shared/logo"
import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Button } from "@/components/ui/button"
import { signOutAction } from "@/lib/auth/actions"
import { requireUser } from "@/lib/auth/session"
import { env } from "@/lib/env"

export const metadata: Metadata = {
  title: { default: "Get started", template: `%s · ${env.APP_NAME}` },
  robots: { index: false, follow: false },
}

/** Onboarding (§12): a focused layout without the app sidebar. proxy.ts requires a session too. */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2 px-4 sm:px-6">
        <Logo appName={env.APP_NAME} />
        <div className="ml-auto flex items-center gap-1">
          <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:inline">
            {user.email}
          </span>
          <ThemeToggle />
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        {children}
      </main>
    </div>
  )
}
