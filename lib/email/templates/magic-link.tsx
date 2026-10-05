import { Button, Heading, Link, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type MagicLinkEmailProps = {
  /** The one-time sign-in URL from Auth.js. */
  url: string
  appName: string
  /** How long the link stays valid; shown to the user. */
  expiresInMinutes?: number
}

export function magicLinkSubject(appName: string): string {
  return `Your sign-in link for ${appName}`
}

/** Sign-in email for the Auth.js email (magic link) provider (§7.4). */
export default function MagicLinkEmail({
  url,
  appName,
  expiresInMinutes = 24 * 60,
}: MagicLinkEmailProps) {
  const validity =
    expiresInMinutes % 60 === 0
      ? `${expiresInMinutes / 60} hour${expiresInMinutes === 60 ? "" : "s"}`
      : `${expiresInMinutes} minutes`

  return (
    <EmailLayout
      appName={appName}
      preview={`Sign in to ${appName}`}
      footer="If you did not request this email, you can safely ignore it. Nobody can sign in without this link."
    >
      <Heading as="h1" style={emailStyles.heading}>
        Sign in to {appName}
      </Heading>
      <Text style={emailStyles.text}>
        Click the button below to sign in. The link works once and expires in {validity}.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={url} style={emailStyles.button}>
          Sign in
        </Button>
      </Section>
      <Text style={emailStyles.muted}>Or copy and paste this URL into your browser:</Text>
      <Text style={emailStyles.muted}>
        <Link href={url} style={emailStyles.link}>
          {url}
        </Link>
      </Text>
    </EmailLayout>
  )
}

MagicLinkEmail.PreviewProps = {
  url: "http://localhost:3000/api/auth/callback/resend?token=preview-token&email=ada%40example.com",
  appName: "Vincera",
} satisfies MagicLinkEmailProps
