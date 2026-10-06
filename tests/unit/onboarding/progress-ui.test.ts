import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { OnboardingProgress } from "@/components/onboarding/onboarding-progress"
import { onboardingProgress, type OnboardingSnapshot } from "@/lib/onboarding/next-step"

const snapshot: OnboardingSnapshot = {
  roles: ["creator"],
  onboardingCompletedAt: null,
  steps: { "creator.connect": { status: "skipped", at: "2026-10-01T10:00:00.000Z" } },
  hasCreatorProfile: true,
  hasBuilderProfile: false,
  creatorConnectionCount: 0,
  githubConnectionCount: 0,
  portfolioItemCount: 0,
  payouts: "none",
}

describe("OnboardingProgress", () => {
  it("names the current step, marks it, and links back to completed steps", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingProgress, {
        progress: onboardingProgress(snapshot, "creator.review"),
      }),
    )
    expect(html).toContain('aria-label="Onboarding progress"')
    expect(html).toContain("Step 4 of 5")
    expect(html).toMatch(/aria-current="step"[^>]*>.*Review audience/)
    expect(html).toContain('href="/onboarding/creator/profile"')
    expect(html).toContain('href="/onboarding/creator/connect"')
    expect(html).toContain("(skipped for now)")
    // Upcoming steps are not links.
    expect(html).not.toContain('href="/onboarding/payouts"')
  })
})
