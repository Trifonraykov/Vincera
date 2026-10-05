import {
  ChartNoAxesColumn,
  HandCoins,
  Lightbulb,
  Link as LinkIcon,
  Signature,
  UserSearch,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AUTH_LINKS } from "@/lib/nav"

import { CtaBand, Faq, FeatureGrid, type Feature } from "../_components/blocks"
import { Hero, Section } from "../_components/section"
import { platformTerms } from "../_lib/economics"

export const metadata: Metadata = {
  title: "For creators",
  description: "Turn what your audience asks for into products you co-own and earn from.",
}

const FEATURES: Feature[] = [
  {
    icon: ChartNoAxesColumn,
    title: "Show who you reach",
    description:
      "Connect YouTube, Instagram or TikTok. We turn your stats into a short audience summary that you can edit before anyone sees it.",
  },
  {
    icon: Lightbulb,
    title: "Post ideas, not specs",
    description:
      "Describe the problem your audience has and the evidence you've seen in comments and DMs. Builders take it from there.",
  },
  {
    icon: UserSearch,
    title: "Get matched with builders",
    description:
      "Builders are ranked by how well their skills and shipped work fit your idea and your audience, with the reason spelled out.",
  },
  {
    icon: Signature,
    title: "A clear agreement",
    description:
      "Split, scope, ownership and exit terms are agreed up front and signed by both of you before any work starts.",
  },
  {
    icon: LinkIcon,
    title: "Launch with a tracked link",
    description:
      "Promote the product your way. Your link shows the clicks and sales your posts drive.",
  },
  {
    icon: HandCoins,
    title: "Get paid on every sale",
    description:
      "Your share of each sale lands in your Stripe balance automatically. No invoices and no chasing payments.",
  },
]

export default function CreatorsPage() {
  const terms = platformTerms()

  return (
    <>
      <Hero
        eyebrow="For creators"
        title="Turn what your audience asks for into products you co-own"
        description="You know what your audience wants. Team up with a builder to make it, launch it to your followers, and earn from every sale without writing a line of code."
        actions={
          <>
            <Button asChild size="lg">
              <Link href={AUTH_LINKS.signUp}>Join as a creator</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/how-it-works">How it works</Link>
            </Button>
          </>
        }
      />
      <Section
        id="features"
        title="Everything from idea to payout"
        description="You bring the audience and the insight. The platform handles matching, the agreement, payments and the split."
      >
        <FeatureGrid features={FEATURES} />
      </Section>
      <Section id="faq" title="Questions creators ask">
        <Faq
          items={[
            {
              question: "Do I need to be technical?",
              answer:
                "No. Builders do the building. You describe the problem, review progress in the shared workspace and approve the launch.",
            },
            {
              question: "Which platforms can I connect?",
              answer:
                "YouTube, Instagram (Business or Creator accounts) and TikTok. If a connection isn't available yet, you can enter your follower count and upload a screenshot for manual review.",
            },
            {
              question: "How big does my audience need to be?",
              answer:
                "There is no minimum. Smaller creators are often a great fit for early-stage products; matching takes audience size into account.",
            },
            {
              question: "What does it cost?",
              answer: `Nothing up front. The platform keeps ${terms.takeRate} of net revenue on each sale. Your share is paid out after a ${terms.holdDays}-day hold.`,
            },
            {
              question: "Who owns the product?",
              answer:
                "Ownership is set out in the collaboration agreement you both sign before work starts.",
            },
          ]}
        />
      </Section>
      <CtaBand
        title="Your audience has ideas. Let's ship one."
        description="Create a free creator account and connect your first platform in a few minutes."
      />
    </>
  )
}
