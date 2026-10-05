"use client"

import { Menu } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import { Logo } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { AUTH_LINKS, type NavLink } from "@/lib/nav"

/** Marketing menu for small screens: a sheet with the main links and the auth buttons. */
export function MobileNav({ appName, links }: { appName: string; links: NavLink[] }) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-72">
        <SheetHeader>
          <SheetTitle asChild>
            <div>
              <Logo appName={appName} />
            </div>
          </SheetTitle>
          <SheetDescription className="sr-only">Site navigation</SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={close}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              {link.title}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 p-4">
          <Button asChild variant="outline" onClick={close}>
            <Link href={AUTH_LINKS.signIn}>Sign in</Link>
          </Button>
          <Button asChild onClick={close}>
            <Link href={AUTH_LINKS.signUp}>Get started</Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
