import { handlePayoutsRefresh } from "@/lib/stripe/refresh-route"

/** Stripe's `refresh_url` for onboarding: a new onboarding link (lib/stripe/refresh-route.ts). */
export async function GET(): Promise<Response> {
  return handlePayoutsRefresh("onboarding")
}
