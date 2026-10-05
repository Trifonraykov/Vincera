"use client"

import {
  ArrowLeftRight,
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react"
import Link from "next/link"
import { useRef } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { AUTH_LINKS } from "@/lib/nav"

import type { ShellUser } from "./types"

function initials(user: ShellUser): string {
  const source = user.name?.trim() || user.email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?"
}

/**
 * Account menu in the sidebar footer. `signOut` is a server action, submitted through a form so
 * it runs as a regular Server Function call with a redirect afterwards.
 */
export function UserMenu({
  user,
  variant,
  isAdmin,
  signOut,
}: {
  user: ShellUser | null
  variant: "app" | "admin"
  isAdmin: boolean
  signOut?: () => Promise<void>
}) {
  // Hooks first: the early return below must not change the hook order.
  const signOutForm = useRef<HTMLFormElement>(null)

  if (!user) {
    return (
      <Button asChild variant="outline" className="w-full">
        <Link href={AUTH_LINKS.signIn}>Sign in</Link>
      </Button>
    )
  }

  const displayName = user.name?.trim() || user.email

  return (
    <>
      {signOut ? <form ref={signOutForm} action={signOut} className="hidden" /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar className="size-8 rounded-lg">
              {user.image ? <AvatarImage src={user.image} alt="" /> : null}
              <AvatarFallback className="rounded-lg">{initials(user)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56" side="top" align="start" sideOffset={4}>
          <DropdownMenuLabel className="font-normal">
            <div className="grid text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link href="/app/settings/profile">
                <UserRound aria-hidden="true" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/app/settings/account">
                <Settings aria-hidden="true" />
                Account settings
              </Link>
            </DropdownMenuItem>
            {variant === "app" && isAdmin ? (
              <DropdownMenuItem asChild>
                <Link href="/admin">
                  <ShieldCheck aria-hidden="true" />
                  Admin
                </Link>
              </DropdownMenuItem>
            ) : null}
            {variant === "admin" ? (
              <DropdownMenuItem asChild>
                <Link href="/app">
                  <ArrowLeftRight aria-hidden="true" />
                  Back to the app
                </Link>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!signOut}
            onSelect={() => signOutForm.current?.requestSubmit()}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
