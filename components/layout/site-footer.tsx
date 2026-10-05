import Link from "next/link"

import { Logo } from "@/components/shared/logo"
import { LEGAL_NAV, marketingNav } from "@/lib/nav"

export function SiteFooter({ appName }: { appName: string }) {
  const year = new Date().getUTCFullYear()

  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-[2fr_1fr_1fr] sm:px-6">
        <div className="space-y-3">
          <Logo appName={appName} />
          <p className="max-w-xs text-sm text-muted-foreground">
            Creators and builders co-create small digital products and split every sale.
          </p>
        </div>
        <FooterColumn title="Product" links={marketingNav()} />
        <FooterColumn title="Legal" links={LEGAL_NAV} />
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted-foreground sm:px-6">
          © {year} {appName}. Payments are processed by Stripe.
        </p>
      </div>
    </footer>
  )
}

function FooterColumn({
  title,
  links,
}: {
  title: string
  links: { title: string; href: string }[]
}) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
