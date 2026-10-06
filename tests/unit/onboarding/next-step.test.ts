import { describe, expect, it } from "vitest"

import type { UserRole } from "@/lib/auth/user"
import {
  isOnboardingPathComplete,
  isOnboardingStepComplete,
  nextOnboardingStep,
  nextOnboardingStepId,
  onboardingGate,
  onboardingPath,
  onboardingProgress,
  onboardingStepAccess,
  onboardingStepState,
  sessionOnboardingGate,
  skippedOnboardingSteps,
  type OnboardingSnapshot,
} from "@/lib/onboarding/next-step"
import { rolesForChoice } from "@/lib/onboarding/role-choices"
import {
  isSkippableOnboardingStep,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEP_PATHS,
  onboardingStepForPath,
  parseOnboardingSteps,
  type OnboardingStepId,
  type OnboardingStepsRecord,
  type OnboardingStepStatus,
} from "@/lib/onboarding/steps"
import type { PayoutsState } from "@/lib/payouts/readiness"

const AT = "2026-10-01T10:00:00.000Z"
const DONE = { status: "done", at: AT } as const
const SKIPPED = { status: "skipped", at: AT } as const

function snapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    roles: [],
    onboardingCompletedAt: null,
    steps: {},
    hasCreatorProfile: false,
    hasBuilderProfile: false,
    creatorConnectionCount: 0,
    githubConnectionCount: 0,
    portfolioItemCount: 0,
    payouts: "none",
    ...overrides,
  }
}

const P = ONBOARDING_STEP_PATHS

describe("onboarding steps", () => {
  it("maps every step to its §12 page, and back", () => {
    expect(Object.values(P)).toEqual([
      "/onboarding/role",
      "/onboarding/creator/profile",
      "/onboarding/creator/connect",
      "/onboarding/creator/review",
      "/onboarding/builder/profile",
      "/onboarding/builder/portfolio",
      "/onboarding/payouts",
    ])
    for (const step of ONBOARDING_STEP_IDS) expect(onboardingStepForPath(P[step])).toBe(step)
    expect(onboardingStepForPath("/onboarding")).toBeNull()
    expect(onboardingStepForPath("/onboarding/creator/profile/")).toBeNull()
  })

  it("lets only connect, portfolio and payouts be skipped", () => {
    expect(ONBOARDING_STEP_IDS.filter(isSkippableOnboardingStep)).toEqual([
      "creator.connect",
      "builder.portfolio",
      "payouts",
    ])
  })

  it("parses users.onboarding_steps tolerantly", () => {
    expect(
      parseOnboardingSteps({
        "creator.connect": SKIPPED,
        payouts: DONE,
        "unknown.step": DONE,
        "creator.review": { status: "maybe", at: AT },
        "builder.portfolio": { status: "done", at: "yesterday" },
        role: "done",
      }),
    ).toEqual({ "creator.connect": SKIPPED, payouts: DONE })
    expect(parseOnboardingSteps(null)).toEqual({})
    expect(parseOnboardingSteps([])).toEqual({})
    expect(parseOnboardingSteps("{}")).toEqual({})
  })
})

describe("onboardingPath", () => {
  it("is just the role step without an app role", () => {
    expect(onboardingPath({ roles: [] })).toEqual(["role"])
    expect(onboardingPath({ roles: ["admin"] })).toEqual(["role"])
  })

  it("follows the creator and builder paths, creator first, then payouts", () => {
    expect(onboardingPath({ roles: ["creator"] })).toEqual([
      "role",
      "creator.profile",
      "creator.connect",
      "creator.review",
      "payouts",
    ])
    expect(onboardingPath({ roles: ["builder", "admin"] })).toEqual([
      "role",
      "builder.profile",
      "builder.portfolio",
      "payouts",
    ])
    expect(onboardingPath({ roles: ["builder", "creator"] })).toEqual([
      "role",
      "creator.profile",
      "creator.connect",
      "creator.review",
      "builder.profile",
      "builder.portfolio",
      "payouts",
    ])
  })
})

describe("nextOnboardingStep", () => {
  it("starts with the role step when the user has no app role", () => {
    expect(nextOnboardingStep(snapshot())).toBe(P.role)
    expect(nextOnboardingStep(snapshot({ roles: ["admin"] }))).toBe(P.role)
  })

  it("walks a creator through profile, connect, review and payouts", () => {
    let s = snapshot({ roles: ["creator"] })
    expect(nextOnboardingStep(s)).toBe(P["creator.profile"])
    s = { ...s, hasCreatorProfile: true }
    expect(nextOnboardingStep(s)).toBe(P["creator.connect"])
    s = { ...s, creatorConnectionCount: 1 }
    expect(nextOnboardingStep(s)).toBe(P["creator.review"])
    s = { ...s, steps: { "creator.review": DONE } }
    expect(nextOnboardingStep(s)).toBe(P.payouts)
    s = { ...s, payouts: "ready" }
    expect(nextOnboardingStep(s)).toBeNull()
    expect(isOnboardingPathComplete(s)).toBe(true)
  })

  it("walks a builder through profile, portfolio and payouts", () => {
    let s = snapshot({ roles: ["builder"] })
    expect(nextOnboardingStep(s)).toBe(P["builder.profile"])
    s = { ...s, hasBuilderProfile: true }
    expect(nextOnboardingStep(s)).toBe(P["builder.portfolio"])
    expect(nextOnboardingStep({ ...s, portfolioItemCount: 2 })).toBe(P.payouts)
    expect(nextOnboardingStep({ ...s, githubConnectionCount: 1 })).toBe(P.payouts)
    s = { ...s, steps: { "builder.portfolio": SKIPPED } }
    expect(nextOnboardingStep(s)).toBe(P.payouts)
    expect(nextOnboardingStep({ ...s, steps: { ...s.steps, payouts: SKIPPED } })).toBeNull()
  })

  it("does creator steps, then builder steps, then payouts for users with both roles", () => {
    const creatorDone = {
      roles: ["creator", "builder"] as UserRole[],
      hasCreatorProfile: true,
      steps: { "creator.connect": SKIPPED, "creator.review": DONE },
    }
    expect(nextOnboardingStep(snapshot({ ...creatorDone, hasCreatorProfile: false }))).toBe(
      P["creator.profile"],
    )
    // A builder profile does not let the creator steps be skipped.
    expect(
      nextOnboardingStep(
        snapshot({ ...creatorDone, steps: {}, hasBuilderProfile: true, portfolioItemCount: 1 }),
      ),
    ).toBe(P["creator.connect"])
    expect(nextOnboardingStep(snapshot(creatorDone))).toBe(P["builder.profile"])
    expect(nextOnboardingStep(snapshot({ ...creatorDone, hasBuilderProfile: true }))).toBe(
      P["builder.portfolio"],
    )
    expect(
      nextOnboardingStep(
        snapshot({ ...creatorDone, hasBuilderProfile: true, githubConnectionCount: 1 }),
      ),
    ).toBe(P.payouts)
  })

  it("judges profile steps by the profile, not by a record", () => {
    const s = snapshot({
      roles: ["creator"],
      steps: { "creator.profile": DONE, "creator.connect": DONE, "creator.review": DONE },
    })
    expect(nextOnboardingStep(s)).toBe(P["creator.profile"])
  })

  it("never lets the audience review be skipped", () => {
    const s = snapshot({
      roles: ["creator"],
      hasCreatorProfile: true,
      creatorConnectionCount: 1,
      steps: { "creator.review": SKIPPED },
    })
    expect(onboardingStepState(s, "creator.review")).toBe("pending")
    expect(nextOnboardingStep(s)).toBe(P["creator.review"])
  })

  it("needs payouts done, skipped or ready; an unfinished Stripe account is not enough", () => {
    const s = snapshot({
      roles: ["builder"],
      hasBuilderProfile: true,
      portfolioItemCount: 1,
      payouts: "pending",
    })
    expect(nextOnboardingStep(s)).toBe(P.payouts)
    expect(nextOnboardingStep({ ...s, steps: { payouts: DONE } })).toBeNull()
    expect(nextOnboardingStep({ ...s, steps: { payouts: SKIPPED } })).toBeNull()
    expect(nextOnboardingStep({ ...s, payouts: "ready" })).toBeNull()
  })

  it("ignores onboarding_completed_at: navigation continues with a role added later", () => {
    const s = snapshot({
      roles: ["creator", "builder"],
      onboardingCompletedAt: new Date(AT),
      hasCreatorProfile: true,
      steps: { "creator.connect": DONE, "creator.review": DONE, payouts: SKIPPED },
    })
    expect(nextOnboardingStep(s)).toBe(P["builder.profile"])
    expect(onboardingGate(s)).toBeNull()
  })
})

describe("onboardingStepState", () => {
  it("prefers the facts over a skip record", () => {
    const s = snapshot({
      roles: ["creator", "builder"],
      creatorConnectionCount: 1,
      payouts: "ready",
      steps: { "creator.connect": SKIPPED, "builder.portfolio": SKIPPED, payouts: SKIPPED },
    })
    expect(onboardingStepState(s, "creator.connect")).toBe("done")
    expect(onboardingStepState(s, "builder.portfolio")).toBe("skipped")
    expect(onboardingStepState(s, "payouts")).toBe("done")
    expect(onboardingStepState(s, "role")).toBe("done")
    expect(onboardingStepState(s, "builder.profile")).toBe("pending")
    expect(skippedOnboardingSteps(s)).toEqual(["builder.portfolio"])
  })
})

describe("gates", () => {
  const complete = snapshot({
    roles: ["builder"],
    hasBuilderProfile: true,
    steps: { "builder.portfolio": SKIPPED, payouts: SKIPPED },
  })

  it("decides from the session alone when it can", () => {
    expect(sessionOnboardingGate({ roles: [], onboardingCompletedAt: null })).toEqual({
      decided: true,
      step: P.role,
    })
    // Even a finished user without an app role (e.g. an admin-only account) picks a role first.
    expect(
      sessionOnboardingGate({ roles: ["admin"], onboardingCompletedAt: new Date(AT) }),
    ).toEqual({ decided: true, step: P.role })
    expect(
      sessionOnboardingGate({ roles: ["creator"], onboardingCompletedAt: new Date(AT) }),
    ).toEqual({ decided: true, step: null })
    expect(sessionOnboardingGate({ roles: ["creator"], onboardingCompletedAt: null })).toEqual({
      decided: false,
    })
  })

  it("sends unfinished users to their next step and never sends finished users back", () => {
    expect(onboardingGate(snapshot({ roles: ["builder"] }))).toBe(P["builder.profile"])
    expect(onboardingGate(complete)).toBeNull()
    expect(
      onboardingGate(snapshot({ roles: ["builder"], onboardingCompletedAt: new Date(AT) })),
    ).toBeNull()
  })
})

describe("onboardingStepAccess", () => {
  const creator = snapshot({ roles: ["creator"], hasCreatorProfile: true })

  it("always opens the role page", () => {
    expect(onboardingStepAccess(snapshot(), "role")).toEqual({ allowed: true })
    expect(onboardingStepAccess(creator, "role")).toEqual({ allowed: true })
  })

  it("opens the next step and completed ones, and redirects jumps ahead", () => {
    expect(onboardingStepAccess(creator, "creator.profile")).toEqual({ allowed: true })
    expect(onboardingStepAccess(creator, "creator.connect")).toEqual({ allowed: true })
    expect(onboardingStepAccess(creator, "creator.review")).toEqual({
      allowed: false,
      redirectTo: P["creator.connect"],
    })
    expect(onboardingStepAccess(creator, "payouts")).toEqual({
      allowed: false,
      redirectTo: P["creator.connect"],
    })
  })

  it("redirects steps that are not on the user's path", () => {
    expect(onboardingStepAccess(creator, "builder.profile")).toEqual({
      allowed: false,
      redirectTo: P["creator.connect"],
    })
    expect(onboardingStepAccess(snapshot(), "payouts")).toEqual({
      allowed: false,
      redirectTo: P.role,
    })
    const done = snapshot({
      roles: ["creator"],
      hasCreatorProfile: true,
      steps: { "creator.connect": SKIPPED, "creator.review": DONE, payouts: SKIPPED },
    })
    expect(onboardingStepAccess(done, "builder.portfolio")).toEqual({
      allowed: false,
      redirectTo: "/app",
    })
    for (const step of onboardingPath(done)) {
      expect(onboardingStepAccess(done, step)).toEqual({ allowed: true })
    }
  })
})

describe("onboardingProgress", () => {
  it("describes the path, the current step and the back/forward links", () => {
    const s = snapshot({
      roles: ["creator"],
      hasCreatorProfile: true,
      steps: { "creator.connect": SKIPPED },
    })
    const progress = onboardingProgress(s, "creator.review")
    expect(progress.total).toBe(5)
    expect(progress.currentIndex).toBe(3)
    expect(progress.previousHref).toBe(P["creator.connect"])
    expect(progress.nextHref).toBe(P.payouts)
    expect(progress.steps.map((step) => [step.id, step.state, step.current])).toEqual([
      ["role", "done", false],
      ["creator.profile", "done", false],
      ["creator.connect", "skipped", false],
      ["creator.review", "pending", true],
      ["payouts", "pending", false],
    ])
    expect(progress.steps[0]).toMatchObject({ label: "Your role", href: P.role })

    const first = onboardingProgress(s, "role")
    expect([first.previousHref, first.nextHref]).toEqual([null, P["creator.profile"]])
    const last = onboardingProgress(s, "payouts")
    expect([last.previousHref, last.nextHref]).toEqual([P["creator.review"], null])
    const offPath = onboardingProgress(s, "builder.profile")
    expect([offPath.currentIndex, offPath.previousHref, offPath.nextHref]).toEqual([-1, null, null])
  })
})

describe("nextOnboardingStep over every combination of inputs", () => {
  const ROLE_SETS: UserRole[][] = [[], ["admin"], ["creator"], ["builder"], ["creator", "builder"]]
  const RECORDED: OnboardingStepId[] = [
    "creator.connect",
    "creator.review",
    "builder.portfolio",
    "payouts",
  ]
  const RECORD_OPTIONS: (OnboardingStepStatus | null)[] = [null, "done", "skipped"]
  const PAYOUTS: PayoutsState[] = ["none", "pending", "ready"]

  function* recordCombinations(index = 0): Generator<OnboardingStepsRecord> {
    const step = RECORDED[index]
    if (step === undefined) {
      yield {}
      return
    }
    for (const rest of recordCombinations(index + 1)) {
      for (const status of RECORD_OPTIONS) {
        yield status === null ? rest : { ...rest, [step]: { status, at: AT } }
      }
    }
  }

  function* snapshots(): Generator<OnboardingSnapshot> {
    const bools = [false, true]
    for (const roles of ROLE_SETS)
      for (const hasCreatorProfile of bools)
        for (const hasBuilderProfile of bools)
          for (const creatorConnectionCount of [0, 1])
            for (const githubConnectionCount of [0, 1])
              for (const portfolioItemCount of [0, 3])
                for (const payouts of PAYOUTS)
                  for (const steps of recordCombinations())
                    yield snapshot({
                      roles,
                      hasCreatorProfile,
                      hasBuilderProfile,
                      creatorConnectionCount,
                      githubConnectionCount,
                      portfolioItemCount,
                      payouts,
                      steps,
                    })
  }

  it("returns the first incomplete step of the path, and progress always moves forward", () => {
    let count = 0
    for (const s of snapshots()) {
      count++
      const path = onboardingPath(s)
      const next = nextOnboardingStepId(s)
      const hasAppRole = s.roles.some((role) => role === "creator" || role === "builder")

      // The role step comes first exactly when the user has no app role.
      expect(next === "role").toBe(!hasAppRole)
      // Only steps of the user's roles, and only after every earlier step is complete.
      if (next !== null) {
        expect(path).toContain(next)
        const index = path.indexOf(next)
        for (const earlier of path.slice(0, index)) {
          expect(isOnboardingStepComplete(s, earlier)).toBe(true)
        }
        expect(isOnboardingStepComplete(s, next)).toBe(false)
        expect(nextOnboardingStep(s)).toBe(ONBOARDING_STEP_PATHS[next])
      } else {
        for (const step of path) expect(isOnboardingStepComplete(s, step)).toBe(true)
      }
      expect(isOnboardingPathComplete(s)).toBe(hasAppRole && next === null)

      // Completing the current step (the way its page does) moves strictly forward.
      if (next !== null && next !== "role") {
        const completed: OnboardingSnapshot =
          next === "creator.profile"
            ? { ...s, hasCreatorProfile: true }
            : next === "builder.profile"
              ? { ...s, hasBuilderProfile: true }
              : { ...s, steps: { ...s.steps, [next]: { status: "done", at: AT } } }
        const after = nextOnboardingStepId(completed)
        if (after !== null) expect(path.indexOf(after)).toBeGreaterThan(path.indexOf(next))
      }

      // The gate never sends a finished user back, and otherwise agrees with navigation.
      expect(onboardingGate({ ...s, onboardingCompletedAt: new Date(AT) })).toBe(
        hasAppRole ? null : ONBOARDING_STEP_PATHS.role,
      )
      expect(onboardingGate(s)).toBe(nextOnboardingStep(s))
    }
    expect(count).toBe(5 * 2 * 2 * 2 * 2 * 2 * 3 * 81)
  })
})

describe("rolesForChoice", () => {
  it("maps the role choices to app roles", () => {
    expect(rolesForChoice("creator")).toEqual(["creator"])
    expect(rolesForChoice("builder")).toEqual(["builder"])
    expect(rolesForChoice("both")).toEqual(["creator", "builder"])
  })
})
