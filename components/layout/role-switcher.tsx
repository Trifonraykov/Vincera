"use client"

import { Check, ChevronsUpDown, Hammer, Megaphone, Plus, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { useTransition } from "react"
import { toast } from "sonner"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import type { ActionResult } from "@/lib/actions/result"
import { APP_ROLES, ROLE_LABELS, type AppRole } from "@/lib/nav"

const ROLE_ICONS: Record<AppRole, LucideIcon> = {
  creator: Megaphone,
  builder: Hammer,
}

const ROLE_HINTS: Record<AppRole, string> = {
  creator: "Audience, ideas, launches",
  builder: "Products, briefs, builds",
}

/**
 * Switches `active_role` (§12: "A role switcher in the sidebar changes it"). Presentational:
 * the server action comes in through `onSwitch`. Roles the user lacks link to onboarding.
 */
export function RoleSwitcher({
  roles,
  activeRole,
  onSwitch,
}: {
  roles: readonly AppRole[]
  activeRole: AppRole
  onSwitch?: (input: { role: AppRole }) => Promise<ActionResult<unknown>>
}) {
  const [pending, startTransition] = useTransition()
  const ActiveIcon = ROLE_ICONS[activeRole]
  const missing = APP_ROLES.filter((role) => !roles.includes(role))

  const select = (role: AppRole) => {
    if (role === activeRole || !onSwitch) return
    startTransition(async () => {
      try {
        const result = await onSwitch({ role })
        if (!result.ok) toast.error(result.error)
      } catch {
        toast.error("Could not switch role. Please try again.")
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          disabled={pending}
          aria-label={`Acting as ${ROLE_LABELS[activeRole]}. Switch role`}
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <ActiveIcon className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{ROLE_LABELS[activeRole]}</span>
            <span className="truncate text-xs text-muted-foreground">{ROLE_HINTS[activeRole]}</span>
          </div>
          <ChevronsUpDown className="ml-auto" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56" align="start" sideOffset={4}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Act as</DropdownMenuLabel>
        {roles.map((role) => {
          const Icon = ROLE_ICONS[role]
          return (
            <DropdownMenuItem
              key={role}
              disabled={!onSwitch && role !== activeRole}
              onSelect={() => select(role)}
            >
              <Icon aria-hidden="true" />
              {ROLE_LABELS[role]}
              {role === activeRole ? <Check className="ml-auto" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          )
        })}
        {missing.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {missing.map((role) => (
              <DropdownMenuItem key={role} asChild>
                <Link href="/onboarding/role">
                  <Plus aria-hidden="true" />
                  Become a {ROLE_LABELS[role].toLowerCase()}
                </Link>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
