import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"
import { ProposalTermsBlock, type ProposalEmailTerms } from "./_components/proposal-terms"

export type ProposalReceivedEmailProps = {
  appName: string
  /** The sender's display name (their profile name, never an email address). */
  senderName: string
  targetKind: "idea" | "product"
  /** Whose idea or product it is: the recipient's ("yours") or the sender's ("theirs"). */
  ownership: "yours" | "theirs"
  targetTitle: string
  terms: ProposalEmailTerms
  /** Absolute URL of `/app/proposals/<id>`. */
  proposalUrl: string
  /** When the proposal expires without an answer, already formatted (e.g. "19 October 2026"). */
  expiresOn: string
}

export function proposalReceivedSubject(senderName: string): string {
  return `${senderName} sent you a proposal`
}

/**
 * §7.4 "proposal received": to the recipient of a new proposal (notification type
 * `proposal.received`). The terms are numbers only; the sender's message stays in the app.
 */
export default function ProposalReceivedEmail({
  appName,
  senderName,
  targetKind,
  ownership,
  targetTitle,
  terms,
  proposalUrl,
  expiresOn,
}: ProposalReceivedEmailProps) {
  const whose = ownership === "yours" ? "your" : "their"
  return (
    <EmailLayout
      appName={appName}
      preview={`${senderName} wants to work with you on “${targetTitle}”.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        {senderName} sent you a proposal
      </Heading>
      <Text style={emailStyles.text}>
        {`${senderName} wants to collaborate on ${whose} ${targetKind} “${targetTitle}”.`} Here is
        what they propose:
      </Text>
      <ProposalTermsBlock terms={terms} />
      <Section style={{ margin: "24px 0" }}>
        <Button href={proposalUrl} style={emailStyles.button}>
          Review the proposal
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        You can accept it, counter with your own terms, or decline. Without an answer it expires on{" "}
        {expiresOn}.
      </Text>
    </EmailLayout>
  )
}

ProposalReceivedEmail.PreviewProps = {
  appName: "Vincera",
  senderName: "Max Builder",
  targetKind: "idea",
  ownership: "yours",
  targetTitle: "Budget tracker for students",
  terms: { creatorSplitPct: 60, builderSplitPct: 40, timelineWeeks: 6 },
  proposalUrl: "http://localhost:3000/app/proposals/0190a000-0000-7000-8000-000000000001",
  expiresOn: "19 October 2026",
} satisfies ProposalReceivedEmailProps
