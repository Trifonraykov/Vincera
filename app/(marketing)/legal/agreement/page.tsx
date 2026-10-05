import type { Metadata } from "next"

import { env } from "@/lib/env"

import { LegalPage } from "../../_components/legal-page"

export const metadata: Metadata = { title: "Collaboration agreement" }

/** Public outline of the agreement template (§12, §18.2). The real template is versioned in code. */
export default function AgreementPage() {
  const app = env.APP_NAME

  return (
    <LegalPage
      title="Collaboration agreement"
      intro={
        <p>
          Every collaboration on {app} is covered by a standard agreement that both members sign
          before work starts. It is filled in with the terms you agreed in your proposal. This page
          shows what the template covers.
        </p>
      }
      sections={[
        {
          heading: "Parties",
          body: <p>The creator and the builder, identified by their verified accounts.</p>,
        },
        {
          heading: "Scope and timeline",
          body: (
            <p>What will be built and the expected timeline, taken from the accepted proposal.</p>
          ),
        },
        {
          heading: "Revenue split",
          body: (
            <p>
              Each member&apos;s percentage of the revenue left after taxes, payment processing fees
              and the platform fee. The percentages always add up to 100.
            </p>
          ),
        },
        {
          heading: "Intellectual property",
          body: (
            <p>
              Who owns the product, the code and the brand during and after the collaboration. To be
              completed after legal review.
            </p>
          ),
        },
        {
          heading: "Term and exit",
          body: (
            <p>
              How long the agreement runs, how a member can leave, and what happens to the product
              and future revenue if they do. To be completed after legal review.
            </p>
          ),
        },
        {
          heading: "Signatures",
          body: (
            <p>
              Both members sign by typing their full name. We record the time, IP address and
              browser of each signature and store the signed PDF, which both members receive by
              email.
            </p>
          ),
        },
      ]}
    />
  )
}
