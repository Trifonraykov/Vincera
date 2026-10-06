import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"

import { Logo } from "@/components/shared/logo"
import { ThemeToggle } from "@/components/shared/theme-toggle"
import { env } from "@/lib/env"
import { LEGAL_NAV } from "@/lib/nav"

export const metadata: Metadata = {
  robots: { index: false, follow: true },
}

/** Minimal centred layout for /sign-in and /sign-up. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="pt-safe">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-safe-4 sm:px-safe-6">
          <Logo appName={env.APP_NAME} />
          <ThemeToggle />
        </div>
      </header>
      <main
        id="main"
        className="flex flex-1 items-start justify-center py-6 px-safe-4 sm:items-center sm:py-10"
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
      <footer className="pt-6 px-safe-4 pb-safe-6">
        <nav
          aria-label="Legal"
          className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          {LEGAL_NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center hover:text-foreground sm:min-h-0"
            >
              {link.title}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  )
}
