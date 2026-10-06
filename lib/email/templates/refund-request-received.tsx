import { Heading, Text } from "react-email"

import { formatMoney } from "../../money"

import { EmailLayout, emailStyles } from "./_components/layout"

export type RefundRequestReceivedEmailProps = {
  appName: string
  /** The launch's title (what the buyer bought). */
  productTitle: string
  amountCents: number
  currency: string
}

export function refundRequestReceivedSubject(productTitle: string): string {
  return `We got your refund request for “${productTitle}”`
}

/**
 * To the buyer right after they ask for a refund on `/access/[token]/refund` (CLAUDE.md §19.38;
 * `sendEmail` with the key `refund-request-received:<requestId>`). Buyers have no account, so it
 * carries no link into the app.
 */
export default function RefundRequestReceivedEmail({
  appName,
  productTitle,
  amountCents,
  currency,
}: RefundRequestReceivedEmailProps) {
  const amount = formatMoney(amountCents, currency)
  return (
    <EmailLayout
      appName={appName}
      preview={`Your request for a ${amount} refund is with our team.`}
      footer={`You get this email because you asked for a refund of “${productTitle}” on ${appName}.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        We got your refund request
      </Heading>
      <Text style={emailStyles.text}>
        You asked for a refund of {amount} for “{productTitle}”. Our team looks at it, usually
        within two business days, and emails you the answer.
      </Text>
      <Text style={emailStyles.text}>
        Your access link keeps working while we decide. If the refund is approved, the money goes
        back to the card or account you paid with.
      </Text>
    </EmailLayout>
  )
}

RefundRequestReceivedEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  amountCents: 1900,
  currency: "eur",
} satisfies RefundRequestReceivedEmailProps
