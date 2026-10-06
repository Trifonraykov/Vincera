import { Check } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AUTH_LINKS } from "@/lib/nav"

import { BreakdownTable, CtaBand, Faq } from "../_components/blocks"
import { Hero, Section } from "../_components/section"
import { exampleSale, platformTerms } from "../_lib/economics"

export const metadata: Metadata = {
  title: "Pricing",
  description: "Free to join. The platform takes a share of net revenue only when you sell.",
}

export default function PricingPage() {
  const terms = platformTerms()
  const example = exampleSale()

  const included = [
    "Matching with explanations",
    "Proposals, counters and click-to-sign agreements",
    "Shared workspace: tasks, messages and files",
    "Product page, Stripe Checkout and EU VAT via Stripe Tax",
    "Delivery by file, license key or link",
    "Tracked links and sales analytics",
    "Automatic splits and payouts through Stripe Connect",
  ]

  return (
    <>
      <Hero
        eyebrow="Pricing"
        title="Free to join. We only earn when you sell."
        description="No subscriptions, listing fees or setup costs. One simple platform fee on revenue."
      />

      <Section id="plan" title="One plan for everyone">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rounded-2xl border bg-card p-6 sm:p-8">
            <p className="text-sm font-medium text-muted-foreground">Platform fee</p>
            <p className="mt-2 text-5xl font-semibold tracking-tight tabular-nums">
              {terms.takeRate}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              of net revenue per sale, after VAT and Stripe&apos;s processing fee
            </p>
            <ul className="mt-6 space-y-2 text-sm">
              {included.map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <Button asChild className="mt-8 w-full sm:w-auto">
              <Link href={AUTH_LINKS.signUp}>Get started free</Link>
            </Button>
          </div>
          <div className="space-y-4">
            <h3 className="font-semibold">
              Example: a €29 sale with a {example.creatorPct}/{100 - example.creatorPct} split
            </h3>
            <BreakdownTable lines={example.lines} />
            <p className="text-xs text-muted-foreground">
              Illustrative. VAT depends on the buyer&apos;s country and Stripe&apos;s fee on the
              card used.
            </p>
          </div>
        </div>
      </Section>

      <Section id="details" title="The details">
        <Faq
          items={[
            {
              question: "What exactly is the platform fee taken from?",
              answer: `From net revenue: the price the buyer paid, minus VAT or sales tax and minus Stripe's processing fee. The platform keeps ${terms.takeRate} of that, and the rest is split between creator and builder.`,
            },
            {
              question: "Who pays Stripe's fees?",
              answer:
                "Stripe's card processing fee is deducted from each sale before the split, so both sides share it in proportion to their shares.",
            },
            {
              question: "When are earnings paid out?",
              answer: `Earnings become available ${terms.holdDays} days after each sale, to cover refunds and chargebacks. Available balances of ${terms.minPayout} or more are paid out daily through Stripe Connect.`,
            },
            {
              question: "What happens with refunds?",
              answer:
                "A refund reverses the sale's split in proportion, including the platform fee, so nobody keeps money from a refunded sale.",
            },
            {
              question: "Is there a minimum price?",
              answer:
                "No minimum is enforced, but very low prices lose a larger share to fixed card fees.",
            },
          ]}
        />
      </Section>

      <CtaBand
        title="Start free, pay only from sales"
        description="Set up your profile and payouts in minutes."
      />
    </>
  )
}
