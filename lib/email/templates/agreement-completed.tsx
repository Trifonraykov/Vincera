import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type AgreementCompletedEmailProps = {
  appName: string
  /** The other member (display name). */
  counterpartName: string
  /** The idea or product the collab is about. */
  collabTitle: string
  /** "5 October 2026": when the last signature was made (UTC). */
  completedOn: string
  /** The attached PDF's file name. */
  pdfFilename: string
  /** Absolute URL of `/app/collabs/<id>`. */
  collabUrl: string
}

export function agreementCompletedSubject(collabTitle: string): string {
  return `Your agreement for “${collabTitle}” is signed`
}

/**
 * §7.4 "agreement fully signed (PDF attached)": to both members once both signed (notification
 * type `agreement.completed`, sent by the `agreements-finalize` job with the stored PDF attached).
 */
export default function AgreementCompletedEmail({
  appName,
  counterpartName,
  collabTitle,
  completedOn,
  pdfFilename,
  collabUrl,
}: AgreementCompletedEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`You and ${counterpartName} signed the agreement. Your copy is attached.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        The agreement is fully signed
      </Heading>
      <Text style={emailStyles.text}>
        You and {counterpartName} signed the collaboration agreement for “{collabTitle}” on{" "}
        {completedOn}. Your signed copy is attached to this email ({pdfFilename}); you can also
        download it from the collab at any time.
      </Text>
      <Text style={emailStyles.text}>
        The collab is now in the building stage: plan the work in Tasks and keep talking in
        Messages.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={collabUrl} style={emailStyles.button}>
          Open the collab
        </Button>
      </Section>
    </EmailLayout>
  )
}

AgreementCompletedEmail.PreviewProps = {
  appName: "Vincera",
  counterpartName: "Ada Creator",
  collabTitle: "Budget tracker for students",
  completedOn: "5 October 2026",
  pdfFilename: "agreement-budget-tracker-for-students.pdf",
  collabUrl: "http://localhost:3000/app/collabs/0190a000-0000-7000-8000-000000000001",
} satisfies AgreementCompletedEmailProps
