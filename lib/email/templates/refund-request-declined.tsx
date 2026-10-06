import { Heading, Text } from "react-email"

import { formatMoney } from "../../money"

import { EmailLayout, emailStyles } from "./_components/layout"

export type RefundRequestDeclinedEmailProps = {
  appName: string
  productTitle: string
  amountCents: number
  currency: string
  /** The admin's note, quoted to the buyer. */
  note: string
}

export function refundRequestDeclinedSubject(productTitle: string): string {
  return `About your refund request for “${productTitle}”`
}

/**
 * To the buyer when an admin declines their refund request (CLAUDE.md §19.38; `sendEmail` with
 * the key `refund-request-declined:<requestId>`), quoting the admin's note.
 */
export default function RefundRequestDeclinedEmail({
  appName,
  productTitle,
  amountCents,
  currency,
  note,
}: RefundRequestDeclinedEmailProps) {
  const amount = formatMoney(amountCents, currency)
  return (
    <EmailLayout
      appName={appName}
      preview={`We couldn't refund ${amount} for “${productTitle}”.`}
      footer={`You get this email because you asked for a refund of “${productTitle}” on ${appName}.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        We can&apos;t refund this purchase
      </Heading>
      <Text style={emailStyles.text}>
        We looked at your request for a refund of {amount} for “{productTitle}” and can&apos;t
        approve it. Our team wrote:
      </Text>
      <Text style={{ ...emailStyles.text, borderLeft: "3px solid #d4d4d4", paddingLeft: "12px" }}>
        {note}
      </Text>
      <Text style={emailStyles.text}>
        Your access link keeps working. If something about the product is wrong, reply to your
        receipt email and the makers will help.
      </Text>
    </EmailLayout>
  )
}

RefundRequestDeclinedEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  amountCents: 1900,
  currency: "eur",
  note: "The product works as described, and the files were downloaded.",
} satisfies RefundRequestDeclinedEmailProps
