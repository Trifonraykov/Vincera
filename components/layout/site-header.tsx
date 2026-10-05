import Link from "next/link"

import { Logo } from "@/components/shared/logo"
import { ThemeToggle } from "@/components/shared/theme-toggle"
import { Button } from "@/components/ui/button"
import { AUTH_LINKS, marketingNav } from "@/lib/nav"

import { MobileNav } from "./mobile-nav"

/**
 * Public header for marketing and public-profile pages. Sticky; on phones it clears the notch and
 * status bar (`pt-safe`) and the menu moves into a sheet (MobileNav).
 */
export function SiteHeader({ appName }: { appName: string }) {
  const links = marketingNav()

  return (
    <header
      data-site-header=""
      className="sticky top-0 z-40 border-b bg-background/80 pt-safe backdrop-blur supports-[backdrop-filter]:bg-background/60"
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-safe-4 sm:px-safe-6">
        <Logo appName={appName} />
        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Button key={link.href} asChild variant="ghost" size="sm">
              <Link href={link.href}>{link.title}</Link>
            </Button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href={AUTH_LINKS.signIn}>Sign in</Link>
          </Button>
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <Link href={AUTH_LINKS.signUp}>Get started</Link>
          </Button>
          <MobileNav appName={appName} links={links} />
        </div>
      </div>
    </header>
  )
}
