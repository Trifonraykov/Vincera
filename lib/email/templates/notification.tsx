import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type NotificationEmailProps = {
  appName: string
  heading: string
  /** One paragraph per entry. */
  paragraphs: readonly string[]
  /** Call to action: an absolute URL into the app. */
  action?: { label: string; url: string }
  /** Inbox preview text; defaults to the heading. */
  preview?: string
}

/**
 * Generic notification email (§7.4): a heading, a few paragraphs and one button. Notifications
 * without a dedicated template use it through `notify({ email })` (lib/notifications/notify.ts).
 */
export default function NotificationEmail({
  appName,
  heading,
  paragraphs,
  action,
  preview,
}: NotificationEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={preview ?? heading}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        {heading}
      </Heading>
      {paragraphs.map((paragraph, index) => (
        <Text key={index} style={emailStyles.text}>
          {paragraph}
        </Text>
      ))}
      {action ? (
        <Section style={{ margin: "24px 0" }}>
          <Button href={action.url} style={emailStyles.button}>
            {action.label}
          </Button>
        </Section>
      ) : null}
    </EmailLayout>
  )
}

NotificationEmail.PreviewProps = {
  appName: "Vincera",
  heading: "Reconnect your YouTube channel",
  paragraphs: [
    "We couldn't refresh your YouTube data because access to your channel expired.",
    "Reconnect it so your audience stats stay up to date.",
  ],
  action: { label: "Reconnect YouTube", url: "http://localhost:3000/app/settings/connections" },
} satisfies NotificationEmailProps
