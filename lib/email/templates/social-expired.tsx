import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type SocialExpiredEmailProps = {
  appName: string
  /** Provider display name, e.g. "YouTube". */
  provider: string
  /** The connected account's name or @handle, when known. */
  accountName: string | null
  /** Absolute URL of Settings → Connections. */
  reconnectUrl: string
}

export function socialExpiredSubject(provider: string): string {
  return `Reconnect your ${provider} account`
}

/**
 * Sent when a social connection's token expired or was revoked (§7.1 "On token failure, set
 * status = expired and notify the user"; notification type `social.expired`).
 */
export default function SocialExpiredEmail({
  appName,
  provider,
  accountName,
  reconnectUrl,
}: SocialExpiredEmailProps) {
  const account = accountName ? `${provider} account ${accountName}` : `${provider} account`
  return (
    <EmailLayout
      appName={appName}
      preview={`Your ${provider} connection stopped working. Reconnect it to keep your stats current.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        Reconnect your {provider} account
      </Heading>
      <Text style={emailStyles.text}>
        We couldn&apos;t refresh the audience stats of your {account}: access has expired or was
        removed on {provider}&apos;s side.
      </Text>
      <Text style={emailStyles.text}>
        Your profile keeps the numbers from the last successful update, but builders see them as out
        of date until you reconnect. It only takes a minute.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={reconnectUrl} style={emailStyles.button}>
          Reconnect {provider}
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        If you removed access on purpose, you can disconnect the account in Settings → Connections
        instead; that deletes its stored data.
      </Text>
    </EmailLayout>
  )
}

SocialExpiredEmail.PreviewProps = {
  appName: "Vincera",
  provider: "YouTube",
  accountName: "Ada Codes",
  reconnectUrl: "http://localhost:3000/app/settings/connections",
} satisfies SocialExpiredEmailProps
