import { Button, Heading, Link, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"
import { ProposalTermsBlock, type ProposalEmailTerms } from "./_components/proposal-terms"

export type AgreementReadyEmailProps = {
  appName: string
  /** The other member (display name). */
  counterpartName: string
  /** The idea or product the collab is about. */
  collabTitle: string
  /** The terms in the agreement. */
  terms: ProposalEmailTerms
  /** Whether the recipient can already receive payouts (signing needs both members ready). */
  payoutsReady: boolean
  /** Absolute URL of `/app/collabs/<id>/agreement`. */
  agreementUrl: string
  /** Absolute URL of `/app/settings/payouts`. */
  payoutsUrl: string
}

export function agreementReadySubject(collabTitle: string): string {
  return `Your agreement for “${collabTitle}” is ready to sign`
}

/**
 * §7.4 "agreement ready to sign": to both members when the agreement is generated (notification
 * type `agreement.ready`). Signing needs payouts set up for both, so the email says so when the
 * recipient is not ready yet. Split and timeline only: the scope stays in the app.
 */
export default function AgreementReadyEmail({
  appName,
  counterpartName,
  collabTitle,
  terms,
  payoutsReady,
  agreementUrl,
  payoutsUrl,
}: AgreementReadyEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`Read and sign your collaboration agreement with ${counterpartName}.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        Your agreement is ready to sign
      </Heading>
      <Text style={emailStyles.text}>
        The collaboration agreement for “{collabTitle}” with {counterpartName} is ready. It is
        filled in with the terms you both accepted:
      </Text>
      <ProposalTermsBlock terms={terms} />
      {payoutsReady ? (
        <Text style={emailStyles.text}>
          Read it through and sign by typing your full name. Work starts once you have both signed.
        </Text>
      ) : (
        <Text style={emailStyles.text}>
          Before you can sign, set up payouts so you get paid for every sale. It takes a few minutes
          with Stripe:{" "}
          <Link href={payoutsUrl} style={emailStyles.link}>
            set up payouts
          </Link>
          .
        </Text>
      )}
      <Section style={{ margin: "24px 0" }}>
        <Button href={agreementUrl} style={emailStyles.button}>
          Read the agreement
        </Button>
      </Section>
    </EmailLayout>
  )
}

AgreementReadyEmail.PreviewProps = {
  appName: "Vincera",
  counterpartName: "Bo Builder",
  collabTitle: "Budget tracker for students",
  terms: { creatorSplitPct: 60, builderSplitPct: 40, timelineWeeks: 6 },
  payoutsReady: false,
  agreementUrl: "http://localhost:3000/app/collabs/0190a000-0000-7000-8000-000000000001/agreement",
  payoutsUrl: "http://localhost:3000/app/settings/payouts",
} satisfies AgreementReadyEmailProps
