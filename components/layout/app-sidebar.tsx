"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { Logo } from "@/components/shared/logo"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { adminNav, appNav, isActiveItem, isActivePath, type NavItem, type NavLink } from "@/lib/nav"

import { RoleSwitcher } from "./role-switcher"
import type { ShellProps } from "./types"
import { UserMenu } from "./user-menu"

type AppSidebarProps = Pick<
  ShellProps,
  | "variant"
  | "appName"
  | "user"
  | "roles"
  | "activeRole"
  | "isAdmin"
  | "includeV1"
  | "switchRole"
  | "signOut"
>

/** Collapsible sidebar on desktop, a sheet on mobile (shadcn Sidebar). Menus come from lib/nav. */
export function AppSidebar(props: AppSidebarProps) {
  const { variant, appName, user, roles, activeRole, isAdmin, includeV1 } = props
  const pathname = usePathname()
  const sections = variant === "admin" ? adminNav({ includeV1 }) : appNav(activeRole, { includeV1 })

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:px-0">
          <Logo
            appName={appName}
            href={variant === "admin" ? "/admin" : "/app"}
            className="min-w-0 group-data-[collapsible=icon]:[&>span]:hidden"
          />
          {variant === "admin" ? (
            <Badge variant="destructive" className="group-data-[collapsible=icon]:hidden">
              Admin
            </Badge>
          ) : null}
        </div>
        {variant === "app" && user ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <RoleSwitcher roles={roles} activeRole={activeRole} onSwitch={props.switchRole} />
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <NavMenuItem key={item.href} item={item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu user={user} variant={variant} isAdmin={isAdmin} signOut={props.signOut} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavMenuItem({ item, pathname }: { item: NavItem; pathname: string }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const active = isActiveItem(pathname, item)
  const Icon = item.icon
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
        <Link href={item.href} onClick={closeOnMobile} aria-current={active ? "page" : undefined}>
          <Icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
      {active && item.children && item.children.length > 0 ? (
        <SidebarMenuSub>
          {item.children.map((child) => {
            const childActive = isChildActive(pathname, item, child)
            return (
              <SidebarMenuSubItem key={child.href}>
                <SidebarMenuSubButton asChild isActive={childActive}>
                  <Link
                    href={child.href}
                    onClick={closeOnMobile}
                    aria-current={childActive ? "page" : undefined}
                  >
                    <span>{child.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  )
}

/** A child that points at its parent's own page (e.g. Earnings → Overview) matches exactly. */
function isChildActive(pathname: string, parent: NavItem, child: NavLink): boolean {
  return child.href === parent.href ? pathname === child.href : isActivePath(pathname, child.href)
}
