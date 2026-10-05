import { ArrowRight, Hammer, Megaphone } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { AUTH_LINKS } from "@/lib/nav"

import { CtaBand } from "./_components/blocks"
import { CoreLoopGrid } from "./_components/core-loop"
import { Container, Hero, Section } from "./_components/section"
import { platformTerms } from "./_lib/economics"

export default function HomePage() {
  const terms = platformTerms()

  return (
    <>
      <Hero
        title="Creators bring the audience. Builders bring the product."
        description={`${terms.appName} matches creators and builders to make small paid digital products together, like tools, templates, mini-apps and AI utilities, and splits every sale automatically.`}
        actions={
          <>
            <Button asChild size="lg">
              <Link href={AUTH_LINKS.signUp}>
                Get started free
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/how-it-works">See how it works</Link>
            </Button>
          </>
        }
      />

      <Section
        id="loop"
        eyebrow="How it works"
        title="From a match to money in your account, in six steps"
        description="One flow from first contact to payout, with the agreement, the workspace and the payments in one place."
      >
        <CoreLoopGrid holdDays={terms.holdDays} />
      </Section>

      <section aria-label="Who it is for" className="border-t py-16 sm:py-20">
        <Container className="grid gap-6 md:grid-cols-2">
          <AudienceCard
            icon={Megaphone}
            title="For creators"
            description="Your audience keeps asking for things you don't have time to build. Post the idea, pick a builder, and earn from every sale without writing code."
            href="/creators"
          />
          <AudienceCard
            icon={Hammer}
            title="For builders"
            description="You can ship, but distribution is the hard part. Partner with creators whose audiences already want what you make."
            href="/builders"
          />
        </Container>
      </section>

      <Section
        id="money"
        eyebrow="Pricing"
        title="Free to join. We earn when you do."
        description={`No subscriptions or listing fees. The platform keeps ${terms.takeRate} of net revenue on each sale, and the rest is split between creator and builder exactly as agreed.`}
      >
        <Button asChild variant="outline">
          <Link href="/pricing">
            See the full breakdown
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </Section>

      <CtaBand
        title="Make the thing your audience is asking for"
        description="Create a free account as a creator, a builder, or both."
      />
    </>
  )
}

function AudienceCard({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: typeof Megaphone
  title: string
  description: string
  href: string
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border bg-card p-6 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:p-8"
    >
      <Icon className="size-6" aria-hidden="true" />
      <h2 className="mt-4 text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-pretty text-muted-foreground">{description}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium">
        Learn more
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
    </Link>
  )
}
