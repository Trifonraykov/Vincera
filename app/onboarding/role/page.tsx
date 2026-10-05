import type { Metadata } from "next"

import { PageHeader } from "@/components/shared/page-header"
import { requireUser } from "@/lib/auth/session"
import { appRolesOf } from "@/lib/auth/user"
import { ROLE_LABELS } from "@/lib/nav"

import { RoleForm } from "./role-form"

export const metadata: Metadata = { title: "Choose your role" }

/**
 * First onboarding step (§12): creator, builder or both. Also where existing users add their
 * other role ("Become a builder" in the role switcher).
 * TODO(Phase 1): polish, then continue to the profile steps.
 */
export default async function OnboardingRolePage() {
  const user = await requireUser()
  const roles = appRolesOf(user)
  const firstName = user.name?.split(/\s+/)[0]

  return (
    <div className="space-y-8">
      <PageHeader
        title={
          firstName
            ? `Welcome, ${firstName}. How will you use the platform?`
            : "How will you use the platform?"
        }
        description={
          roles.length > 0
            ? `You're already a ${roles.map((role) => ROLE_LABELS[role].toLowerCase()).join(" and ")}. Adding a role keeps the one you have; switch between them from the sidebar.`
            : "Pick the side you're on. You can add the other role later."
        }
      />
      <RoleForm />
    </div>
  )
}
