import { z } from "zod"

/**
 * Onboarding steps (§12, §16 Phase 1): ids, pages, labels and what may be skipped.
 *
 * Client-safe (Zod only): the database schema (`users.onboarding_steps`, type-only import), the
 * pure step logic in `./next-step.ts` and the onboarding pages all read the step list from here.
 */

/** Every onboarding step, in path order. A user's path holds the steps of their roles only. */
export const ONBOARDING_STEP_IDS = [
  "role",
  "creator.profile",
  "creator.connect",
  "creator.review",
  "builder.profile",
  "builder.portfolio",
  "payouts",
] as const
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]

/** How a recorded step ended: completed, or put off with "Do this later". */
export const ONBOARDING_STEP_STATUSES = ["done", "skipped"] as const
export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUSES)[number]

/** One entry of `users.onboarding_steps`. `at` is an ISO 8601 timestamp (UTC). */
export type OnboardingStepRecord = { status: OnboardingStepStatus; at: string }

/** `users.onboarding_steps`: step id → how and when it was recorded. Missing = not recorded. */
export type OnboardingStepsRecord = Partial<Record<OnboardingStepId, OnboardingStepRecord>>

/** The page of each step (§12). */
export const ONBOARDING_STEP_PATHS = {
  role: "/onboarding/role",
  "creator.profile": "/onboarding/creator/profile",
  "creator.connect": "/onboarding/creator/connect",
  "creator.review": "/onboarding/creator/review",
  "builder.profile": "/onboarding/builder/profile",
  "builder.portfolio": "/onboarding/builder/portfolio",
  payouts: "/onboarding/payouts",
} as const satisfies Record<OnboardingStepId, string>

/** Short labels for the progress indicator. */
export const ONBOARDING_STEP_LABELS = {
  role: "Your role",
  "creator.profile": "Creator profile",
  "creator.connect": "Connect accounts",
  "creator.review": "Review audience",
  "builder.profile": "Builder profile",
  "builder.portfolio": "Portfolio",
  payouts: "Payouts",
} as const satisfies Record<OnboardingStepId, string>

/**
 * Steps with a "Do this later" button. Payouts can be put off, but payouts readiness is still
 * required later to sign an agreement (§12, §19.10).
 */
export const SKIPPABLE_ONBOARDING_STEPS = [
  "creator.connect",
  "builder.portfolio",
  "payouts",
] as const satisfies readonly OnboardingStepId[]
export type SkippableOnboardingStepId = (typeof SKIPPABLE_ONBOARDING_STEPS)[number]

export function isOnboardingStepId(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(value)
}

export function isSkippableOnboardingStep(
  step: OnboardingStepId,
): step is SkippableOnboardingStepId {
  return (SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step)
}

/** The step a pathname belongs to (exact match), or null. */
export function onboardingStepForPath(pathname: string): OnboardingStepId | null {
  return ONBOARDING_STEP_IDS.find((step) => ONBOARDING_STEP_PATHS[step] === pathname) ?? null
}

const stepRecordSchema = z.object({
  status: z.enum(ONBOARDING_STEP_STATUSES),
  at: z.iso.datetime({ offset: true }),
})

/**
 * Parse `users.onboarding_steps` (jsonb; the database only checks it is an object). Tolerant:
 * unknown step ids and malformed entries are dropped rather than failing the whole read.
 */
export function parseOnboardingSteps(value: unknown): OnboardingStepsRecord {
  const record = z.record(z.string(), z.unknown()).safeParse(value)
  if (!record.success) return {}
  const steps: OnboardingStepsRecord = {}
  for (const [key, entry] of Object.entries(record.data)) {
    if (!isOnboardingStepId(key)) continue
    const parsed = stepRecordSchema.safeParse(entry)
    if (parsed.success) steps[key] = parsed.data
  }
  return steps
}
