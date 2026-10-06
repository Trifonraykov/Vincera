import type { Metadata } from "next"

import { AgreementDocument } from "@/components/collabs/agreement-document"
import { DraftNotice } from "@/components/shared/draft-notice"
import {
  PLACEHOLDER_CONTEXT_V1,
  PLACEHOLDER_TERMS_V1,
  renderAgreementV1,
} from "@/lib/agreements/template-v1"
import { env } from "@/lib/env"

import { Container } from "../../_components/section"

export const metadata: Metadata = {
  title: "Collaboration agreement",
  description:
    "The standard agreement every creator and builder sign before they start a collaboration.",
}

/**
 * The public collaboration agreement (§12 `/legal/agreement`, §18.2): template v1 rendered with
 * placeholder terms, exactly as members see it on their collab (lib/agreements/template-v1.tsx),
 * with the "draft — pending legal review" notice.
 */
export default function AgreementPage() {
  const app = env.APP_NAME
  const body = renderAgreementV1(PLACEHOLDER_TERMS_V1, PLACEHOLDER_CONTEXT_V1)

  return (
    <Container className="max-w-3xl py-12 sm:py-16">
      <article className="space-y-8">
        <header className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Collaboration agreement
          </h1>
          <DraftNotice />
          <div className="space-y-3 text-pretty text-muted-foreground">
            <p>
              Every collaboration on {app} is covered by this standard agreement, which both members
              sign before work starts. When a proposal is accepted, the agreement is filled in with
              its terms: the two members, their revenue split, what they will build and the
              timeline. The parts in [brackets] below are examples.
            </p>
            <p>
              Both members sign by typing their full name, and both need payouts set up first. We
              record the time, IP address and browser of each signature together with the
              agreement&apos;s fingerprint, and email both members the signed PDF.
            </p>
          </div>
        </header>
        <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <AgreementDocument body={body} showTitle={false} />
        </div>
      </article>
    </Container>
  )
}
