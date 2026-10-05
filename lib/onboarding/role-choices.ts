import type { AppRole } from "@/lib/nav"

/** The options on /onboarding/role. Client-safe. */
export const ROLE_CHOICES = ["creator", "builder", "both"] as const
export type RoleChoice = (typeof ROLE_CHOICES)[number]

export function rolesForChoice(choice: RoleChoice): AppRole[] {
  return choice === "both" ? ["creator", "builder"] : [choice]
}
