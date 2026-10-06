import { Heading, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type AccountDeletedEmailProps = {
  appName: string
}

export function accountDeletedSubject(appName: string): string {
  return `Your ${appName} account was deleted`
}

/**
 * The confirmation after a user deletes their account (§14; CLAUDE.md §19.38). Sent to the old
 * address, captured before the account was anonymised. Says what was removed and what the law
 * makes us keep; no link back into the app (there is no account to sign in to).
 */
export default function AccountDeletedEmail({ appName }: AccountDeletedEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`Your ${appName} account and personal data were deleted.`}
      footer={`You get this email because you deleted your ${appName} account. This is the last email we send to this address.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        Your account was deleted
      </Heading>
      <Text style={emailStyles.text}>
        We removed your name, email address, profiles, connected accounts and their stats, your
        portfolio, your messages and files, and your notifications. You have been signed out
        everywhere.
      </Text>
      <Text style={emailStyles.text}>
        Sales, payouts and signed agreements stay on record without your contact details, because
        tax and contract law require us to keep them. Your collaborators still see past work as made
        by a deleted user.
      </Text>
      <Text style={emailStyles.text}>
        If you didn&apos;t ask for this, reply to this email right away.
      </Text>
    </EmailLayout>
  )
}

AccountDeletedEmail.PreviewProps = { appName: "Vincera" } satisfies AccountDeletedEmailProps
