"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import { ActionError, defineAction } from "@/lib/actions/define-action"
import { canManageOwnAccount } from "@/lib/auth/authz"
import { completeOnboardingStep } from "@/lib/onboarding/complete-step"
import { payoutsStatusOf } from "@/lib/payouts/readiness"

import { createDashboardLink, createOnboardingLink, findStripeAccountByUser } from "./connect"
import { PAYOUT_COUNTRY_CODES } from "./countries"
import { PAYOUTS_PAGES } from "./paths"

/**
 * Payouts server actions for `/onboarding/payouts` and `/app/settings/payouts` (§7.2, §12). All
 * act on the signed-in user's own connected account only (`canManageOwnAccount`).
 */

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value)

/**
 * "Set up payouts" / "Continue with Stripe": create the connected account on first use (with the
 * chosen country), then redirect to a fresh Stripe-hosted onboarding link.
 */
export const startPayoutsOnboarding = defineAction({
  name: "payouts.start_onboarding",
  input: z.object({
    from: z.enum(["onboarding", "settings"]),
    country: z.preprocess(
      emptyToUndefined,
      z.enum(PAYOUT_COUNTRY_CODES, { error: "Choose a country from the list." }).optional(),
    ),
  }),
  // Creates or continues the user's own connected account.
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ input, user, db }) => {
    const page = PAYOUTS_PAGES[input.from]
    const url = await createOnboardingLink(db, user, {
      returnPath: page.returnPath,
      refreshPath: page.refreshPath,
      country: input.country ?? null,
    })
    redirect(url)
  },
})

/** "Open Stripe Express dashboard": redirect to a one-time login link. */
export const openStripeDashboard = defineAction({
  name: "payouts.open_dashboard",
  input: z.object({}),
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ user, db }) => {
    redirect(await createDashboardLink(db, user))
  },
})

/**
 * "Continue" on `/onboarding/payouts` once the user has done their part with Stripe (payouts
 * ready, or everything submitted and Stripe still verifying): records the step `done` and moves
 * on (`/app` when that finishes onboarding). Not done yet → use "Do this later" instead.
 */
export const finishPayoutsStep = defineAction({
  name: "onboarding.finish_payouts",
  input: z.object({}),
  authorize: (user) => canManageOwnAccount(user),
  run: async ({ user, db }) => {
    const status = payoutsStatusOf(await findStripeAccountByUser(db, user.id))
    if (status.kind !== "ready" && status.kind !== "verifying") {
      throw new ActionError(
        "Finish setting up payouts with Stripe first, or choose “Do this later”.",
      )
    }
    const { nextStep } = await completeOnboardingStep(db, {
      userId: user.id,
      step: "payouts",
      status: "done",
    })
    redirect(nextStep ?? "/app")
  },
})
