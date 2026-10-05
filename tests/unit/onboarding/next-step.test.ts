import { describe, expect, it } from "vitest"

import { nextOnboardingStep, ONBOARDING_STEPS } from "@/lib/onboarding/next-step"
import { rolesForChoice } from "@/lib/onboarding/role-choices"

describe("nextOnboardingStep", () => {
  it("starts with the role step when the user has no app role", () => {
    expect(nextOnboardingStep({ roles: [], onboardingCompletedAt: null })).toBe(
      ONBOARDING_STEPS.role,
    )
    expect(nextOnboardingStep({ roles: ["admin"], onboardingCompletedAt: null })).toBe(
      ONBOARDING_STEPS.role,
    )
  })

  it("lets users with a creator or builder role into /app (Phase 0)", () => {
    expect(nextOnboardingStep({ roles: ["creator"], onboardingCompletedAt: null })).toBeNull()
    expect(nextOnboardingStep({ roles: ["builder", "admin"], onboardingCompletedAt: null })).toBe(
      null,
    )
  })
})

describe("rolesForChoice", () => {
  it("maps the role choices to app roles", () => {
    expect(rolesForChoice("creator")).toEqual(["creator"])
    expect(rolesForChoice("builder")).toEqual(["builder"])
    expect(rolesForChoice("both")).toEqual(["creator", "builder"])
  })
})
