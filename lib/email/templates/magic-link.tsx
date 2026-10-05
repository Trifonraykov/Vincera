import { Button, Heading, Link, Section, Text } from "react-email"

// Relative, like the other template imports: the `pnpm email:dev` preview has no "@/" alias.
import { formatSignInCode } from "../../auth/sign-in-code"

import { EmailLayout, emailStyles } from "./_components/layout"

export type MagicLinkEmailProps = {
  /** The one-time sign-in URL from Auth.js. */
  url: string
  /** The same token as a code to type in the app (e.g. the installed app on a phone). */
  code?: string
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
  code,
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
      footer="If you did not request this email, you can safely ignore it. Nobody can sign in without this link or code."
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
      {code ? (
        <>
          <Text style={emailStyles.text}>
            Signing in from the {appName} app on your home screen? Enter this code there instead:
          </Text>
          <Text
            style={{
              ...emailStyles.heading,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              letterSpacing: "0.12em",
            }}
          >
            {formatSignInCode(code)}
          </Text>
        </>
      ) : null}
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
  url: "http://localhost:3000/api/auth/callback/email?token=7K4QX2MZ&email=ada%40example.com",
  code: "7K4QX2MZ",
  appName: "Vincera",
} satisfies MagicLinkEmailProps
