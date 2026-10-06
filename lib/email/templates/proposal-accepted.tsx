import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"
import { ProposalTermsBlock, type ProposalEmailTerms } from "./_components/proposal-terms"

export type ProposalAcceptedEmailProps = {
  appName: string
  /** Who accepted (display name). */
  counterpartName: string
  targetTitle: string
  /** The accepted terms. */
  terms: ProposalEmailTerms
  /** Absolute URL of the new collab, `/app/collabs/<id>`. */
  collabUrl: string
}

export function proposalAcceptedSubject(counterpartName: string): string {
  return `${counterpartName} accepted your proposal`
}

/**
 * §7.4 "proposal accepted": to the party whose offer was accepted (notification type
 * `proposal.accepted`). The collab now exists; the next step is the agreement (§1 "Agree").
 */
export default function ProposalAcceptedEmail({
  appName,
  counterpartName,
  targetTitle,
  terms,
  collabUrl,
}: ProposalAcceptedEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`You're collaborating on “${targetTitle}”. Next: sign the agreement.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        {counterpartName} accepted your proposal
      </Heading>
      <Text style={emailStyles.text}>
        You&apos;re now collaborating on “{targetTitle}” on these terms:
      </Text>
      <ProposalTermsBlock terms={terms} />
      <Text style={emailStyles.text}>
        Next, you both sign the collaboration agreement. You&apos;ll need payouts set up first, so
        you get paid for every sale.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={collabUrl} style={emailStyles.button}>
          Open the collab
        </Button>
      </Section>
    </EmailLayout>
  )
}

ProposalAcceptedEmail.PreviewProps = {
  appName: "Vincera",
  counterpartName: "Ada Codes",
  targetTitle: "Budget tracker for students",
  terms: { creatorSplitPct: 60, builderSplitPct: 40, timelineWeeks: 6 },
  collabUrl: "http://localhost:3000/app/collabs/0190a000-0000-7000-8000-000000000001",
} satisfies ProposalAcceptedEmailProps
