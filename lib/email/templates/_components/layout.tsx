import type { CSSProperties, ReactNode } from "react"
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "react-email"

/**
 * Shared frame for every transactional email: preview line, app name header, content, footer.
 * Inline styles only, so it renders consistently across email clients. Lives in `_components`
 * so the React Email preview server (`pnpm email:dev`) does not list it as a template.
 */
export type EmailLayoutProps = {
  appName: string
  /** Inbox preview text shown next to the subject. Keep it under ~90 characters. */
  preview: string
  children: ReactNode
  /** Small print under the divider, e.g. why the recipient got this email. */
  footer?: ReactNode
}

export function EmailLayout({ appName, preview, children, footer }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.brand}>{appName}</Text>
          <Section>{children}</Section>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>
            {footer ?? `You are receiving this email because of your ${appName} account.`}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export const emailStyles = {
  heading: {
    fontSize: "22px",
    lineHeight: "30px",
    fontWeight: 600,
    color: "#0a0a0a",
    margin: "0 0 16px",
  },
  text: {
    fontSize: "15px",
    lineHeight: "24px",
    color: "#262626",
    margin: "0 0 16px",
  },
  muted: {
    fontSize: "13px",
    lineHeight: "20px",
    color: "#737373",
    margin: "0 0 12px",
  },
  button: {
    display: "inline-block",
    backgroundColor: "#171717",
    color: "#fafafa",
    fontSize: "15px",
    fontWeight: 600,
    textDecoration: "none",
    borderRadius: "8px",
    padding: "12px 20px",
  },
  link: {
    color: "#171717",
    textDecoration: "underline",
    wordBreak: "break-all",
  },
} satisfies Record<string, CSSProperties>

const styles = {
  body: {
    backgroundColor: "#f5f5f5",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    margin: 0,
    padding: "24px 0",
  },
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e5e5e5",
    borderRadius: "12px",
    margin: "0 auto",
    maxWidth: "560px",
    padding: "32px",
  },
  brand: {
    fontSize: "16px",
    fontWeight: 700,
    color: "#0a0a0a",
    margin: "0 0 24px",
  },
  hr: {
    borderColor: "#e5e5e5",
    margin: "24px 0 16px",
  },
  footer: {
    fontSize: "12px",
    lineHeight: "18px",
    color: "#a3a3a3",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>
