import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"
import { ProposalTermsBlock, type ProposalEmailTerms } from "./_components/proposal-terms"

export type ProposalCounteredEmailProps = {
  appName: string
  /** Who made the counter-offer (display name). */
  counterpartName: string
  targetTitle: string
  terms: ProposalEmailTerms
  /** Absolute URL of `/app/proposals/<id>`. */
  proposalUrl: string
  expiresOn: string
}

export function proposalCounteredSubject(counterpartName: string): string {
  return `${counterpartName} countered your proposal`
}

/**
 * §7.4 "proposal countered": to the party who now has to answer (notification type
 * `proposal.countered`).
 */
export default function ProposalCounteredEmail({
  appName,
  counterpartName,
  targetTitle,
  terms,
  proposalUrl,
  expiresOn,
}: ProposalCounteredEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`New terms for “${targetTitle}”: it's your turn to answer.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        {counterpartName} countered your proposal
      </Heading>
      <Text style={emailStyles.text}>
        {counterpartName} answered with new terms for “{targetTitle}”:
      </Text>
      <ProposalTermsBlock terms={terms} />
      <Section style={{ margin: "24px 0" }}>
        <Button href={proposalUrl} style={emailStyles.button}>
          See what changed
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        It&apos;s your turn: accept, counter again, or decline. Without an answer the proposal
        expires on {expiresOn}.
      </Text>
    </EmailLayout>
  )
}

ProposalCounteredEmail.PreviewProps = {
  appName: "Vincera",
  counterpartName: "Ada Codes",
  targetTitle: "Budget tracker for students",
  terms: { creatorSplitPct: 65, builderSplitPct: 35, timelineWeeks: 8 },
  proposalUrl: "http://localhost:3000/app/proposals/0190a000-0000-7000-8000-000000000001",
  expiresOn: "19 October 2026",
} satisfies ProposalCounteredEmailProps
