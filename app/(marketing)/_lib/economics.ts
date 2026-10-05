import "server-only"

import { env } from "@/lib/env"
import { formatMoney } from "@/lib/money"

/**
 * Business numbers shown on marketing pages, read from the environment (§17) so the copy always
 * matches what the ledger does. Pages that use them are rendered at build time, so a change to
 * PLATFORM_TAKE_RATE / HOLD_DAYS / MIN_PAYOUT_CENTS needs a redeploy (as it does anyway).
 */

const CURRENCY = "eur"

export function formatPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`
}

export function platformTerms() {
  return {
    takeRate: formatPercent(env.PLATFORM_TAKE_RATE),
    holdDays: env.HOLD_DAYS,
    minPayout: formatMoney(env.MIN_PAYOUT_CENTS, CURRENCY),
    appName: env.APP_NAME,
  }
}

export type BreakdownLine = { label: string; cents: number; note?: string; emphasis?: boolean }

/**
 * A worked example of §9's split for one €29 sale with a 60/40 creator/builder split.
 * VAT (21%) and the card fee (1.5% + €0.25) are illustrative; real values depend on the buyer's
 * country and card. Integer cents throughout; the builder gets the remainder so shares sum
 * exactly to the distributable amount.
 */
export function exampleSale(creatorPct = 60): { lines: BreakdownLine[]; creatorPct: number } {
  const gross = 2900
  const tax = Math.round(gross - gross / 1.21)
  const stripeFee = Math.round(gross * 0.015) + 25
  const net = gross - tax - stripeFee
  const platformFee = Math.round(net * env.PLATFORM_TAKE_RATE)
  const distributable = net - platformFee
  const creator = Math.round((distributable * creatorPct) / 100)
  const builder = distributable - creator

  return {
    creatorPct,
    lines: [
      { label: "Buyer pays", cents: gross },
      { label: "VAT (handled by Stripe Tax)", cents: -tax, note: "21% example" },
      { label: "Stripe processing fee", cents: -stripeFee, note: "example card fee" },
      { label: "Net revenue", cents: net, emphasis: true },
      {
        label: `Platform fee (${formatPercent(env.PLATFORM_TAKE_RATE)} of net)`,
        cents: -platformFee,
      },
      { label: `Creator share (${creatorPct}%)`, cents: creator, emphasis: true },
      { label: `Builder share (${100 - creatorPct}%)`, cents: builder, emphasis: true },
    ],
  }
}

export function formatEuros(cents: number): string {
  return formatMoney(cents, CURRENCY)
}
