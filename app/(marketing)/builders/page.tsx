import { BadgeCheck, Code, HandCoins, Lightbulb, Package, Target } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AUTH_LINKS } from "@/lib/nav"

import { CtaBand, Faq, FeatureGrid, type Feature } from "../_components/blocks"
import { Hero, Section } from "../_components/section"
import { platformTerms } from "../_lib/economics"

export const metadata: Metadata = {
  title: "For builders",
  description: "Ship small products with distribution built in, by partnering with creators.",
}

const FEATURES: Feature[] = [
  {
    icon: Package,
    title: "List what you build",
    description:
      "Add a product at any stage, from idea to live, with the split you'd like and whether you want an exclusive partner.",
  },
  {
    icon: Lightbulb,
    title: "Browse real demand",
    description:
      "Creators post ideas backed by what their audience says. Pick the briefs that fit your skills.",
  },
  {
    icon: Target,
    title: "Matched on fit",
    description:
      "Creators are ranked by topic, audience and format fit with your work, so you pitch the people most likely to say yes.",
  },
  {
    icon: Code,
    title: "Your stack, your way",
    description:
      "Tools, templates, mini-apps or AI utilities. You build and host it; buyers get a file, a license key or a link.",
  },
  {
    icon: BadgeCheck,
    title: "Show your track record",
    description:
      "Connect GitHub and add shipped work to your portfolio. Completed collabs build your reputation.",
  },
  {
    icon: HandCoins,
    title: "Paid automatically",
    description:
      "Each sale is split as agreed and paid out to your bank through Stripe. No invoicing your partner.",
  },
]

export default function BuildersPage() {
  const terms = platformTerms()

  return (
    <>
      <Hero
        eyebrow="For builders"
        title="Ship small products with distribution built in"
        description="Building is the part you're good at; finding buyers is the hard part. Partner with creators whose audiences already want what you make, and share the revenue."
        actions={
          <>
            <Button asChild size="lg">
              <Link href={AUTH_LINKS.signUp}>Join as a builder</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/how-it-works">How it works</Link>
            </Button>
          </>
        }
      />
      <Section
        id="features"
        title="Built for makers who'd rather build than market"
        description="Find a creator, agree the terms, build together, and let the platform handle checkout, delivery and payouts."
      >
        <FeatureGrid features={FEATURES} />
      </Section>
      <Section id="faq" title="Questions builders ask">
        <Faq
          items={[
            {
              question: "What kinds of products work best?",
              answer:
                "Small paid digital products with a clear audience: tools, templates, mini-apps, AI utilities and course companions.",
            },
            {
              question: "Do you host my app?",
              answer:
                "No. You host what you build. The platform handles the product page, checkout and delivery of a file, a license key or a link.",
            },
            {
              question: "Can I do fixed-price work instead of a split?",
              answer:
                "Collabs on the platform are revenue splits. You can say in your profile whether you prefer splits, fixed fees or either.",
            },
            {
              question: "What does it cost?",
              answer: `Nothing up front. The platform keeps ${terms.takeRate} of net revenue on each sale. Your share is paid out after a ${terms.holdDays}-day hold.`,
            },
            {
              question: "Who owns the code?",
              answer:
                "Ownership and what happens if a collab ends are set out in the agreement you both sign before work starts.",
            },
          ]}
        />
      </Section>
      <CtaBand
        title="Bring your next product to an audience that wants it"
        description="Create a free builder account and list your first product."
      />
    </>
  )
}
