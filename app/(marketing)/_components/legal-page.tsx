import type { ReactNode } from "react"

import { DraftNotice } from "@/components/shared/draft-notice"

import { Container } from "./section"

export type LegalSection = { heading: string; body: ReactNode }

/** Layout for /legal/* pages. All three are drafts until reviewed (§18.2). */
export function LegalPage({
  title,
  intro,
  sections,
}: {
  title: string
  intro: ReactNode
  sections: LegalSection[]
}) {
  return (
    <Container className="max-w-3xl py-12 sm:py-16">
      <article className="space-y-8">
        <header className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <DraftNotice />
          <div className="text-pretty text-muted-foreground">{intro}</div>
        </header>
        {sections.map((section, index) => (
          <section key={section.heading} className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">
              {index + 1}. {section.heading}
            </h2>
            <div className="space-y-3 text-sm leading-relaxed text-pretty text-foreground/90 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
              {section.body}
            </div>
          </section>
        ))}
      </article>
    </Container>
  )
}
