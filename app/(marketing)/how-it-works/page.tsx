import type { Metadata } from "next"

import { BreakdownTable, CtaBand } from "../_components/blocks"
import { coreLoop } from "../_components/core-loop"
import { Hero, Section } from "../_components/section"
import { exampleSale, platformTerms } from "../_lib/economics"

export const metadata: Metadata = {
  title: "How it works",
  description: "Match, propose, agree, build, launch, and split every sale.",
}

export default function HowItWorksPage() {
  const terms = platformTerms()
  const example = exampleSale()

  return (
    <>
      <Hero
        eyebrow="How it works"
        title="Six steps from a match to a payout"
        description="Every collab follows the same path, so both sides always know what comes next and nobody works without an agreement."
      />

      <Section id="steps" title="The collab, step by step">
        <ol className="space-y-6">
          {coreLoop(terms.holdDays).map((step, index) => {
            const Icon = step.icon
            return (
              <li
                key={step.title}
                className="grid gap-4 rounded-2xl border bg-card p-6 sm:grid-cols-[auto_1fr] sm:gap-6"
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold">
                    <span className="text-muted-foreground tabular-nums">{index + 1}.</span>{" "}
                    {step.title}
                  </h3>
                  <p className="text-pretty">{step.summary}</p>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {step.details.map((detail) => (
                      <li key={detail} className="ml-5 list-disc text-pretty">
                        {detail}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            )
          })}
        </ol>
      </Section>

      <Section
        id="split"
        title="How a sale is split"
        description={`Taxes and Stripe's processing fee come off first. The platform keeps ${terms.takeRate} of what remains, and the rest is divided between creator and builder by the split in your agreement.`}
      >
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="font-semibold">
              Example: a €29 product with a {example.creatorPct}/{100 - example.creatorPct} split
            </h3>
            <BreakdownTable lines={example.lines} />
            <p className="text-xs text-muted-foreground">
              Illustrative numbers. VAT depends on the buyer&apos;s country and the card fee on the
              card used. Amounts are rounded to the cent, and the shares always add up to exactly
              what is left after the platform fee.
            </p>
          </div>
          <div className="space-y-4 text-sm text-pretty">
            <h3 className="text-base font-semibold">When you get paid</h3>
            <p>
              Each sale becomes available for payout {terms.holdDays} days after it is paid. The
              hold covers refunds and chargebacks, so nobody is asked to pay money back after it has
              reached their bank.
            </p>
            <p>
              Once a day, available earnings of {terms.minPayout} or more are sent to your bank
              through Stripe Connect. Smaller balances roll over to the next day.
            </p>
            <p>
              Refunds are taken from both shares in proportion to the split. If a buyer disputes a
              charge, the related earnings are frozen until the dispute is resolved.
            </p>
          </div>
        </div>
      </Section>

      <CtaBand
        title="Ready for your first collab?"
        description="Sign up, complete your profile, and set up payouts. Your first matches appear right away."
      />
    </>
  )
}
