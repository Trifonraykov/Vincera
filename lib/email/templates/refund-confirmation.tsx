import { Heading, Text } from "react-email"

import { formatMoney } from "../../money"

import { EmailLayout, emailStyles } from "./_components/layout"

export type RefundConfirmationEmailProps = {
  appName: string
  /** The launch's title (what the buyer bought). */
  productTitle: string
  amountCents: number
  currency: string
  /** The whole order is refunded now (access to the product ended). */
  full: boolean
}

export function refundConfirmationSubject(productTitle: string): string {
  return `Your refund for “${productTitle}”`
}

/**
 * §7.4 "refund confirmation": to the buyer once a refund succeeded (`refunds-notify` job, a
 * required email with the idempotency key `refund-confirmation:<refundId>`; CLAUDE.md §19.31).
 * Buyers have no account, so it carries no link into the app.
 */
export default function RefundConfirmationEmail({
  appName,
  productTitle,
  amountCents,
  currency,
  full,
}: RefundConfirmationEmailProps) {
  const amount = formatMoney(amountCents, currency)
  return (
    <EmailLayout
      appName={appName}
      preview={`We refunded ${amount} for “${productTitle}”.`}
      footer={`You get this email because you bought “${productTitle}” on ${appName}.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        We refunded {amount}
      </Heading>
      <Text style={emailStyles.text}>
        Your refund of {amount} for “{productTitle}” went through. It goes back to the card or
        account you paid with; depending on your bank it can take 5 to 10 business days to show.
      </Text>
      <Text style={emailStyles.text}>
        {full
          ? "As the whole order is refunded, your access link no longer works."
          : "This was a partial refund, so your access link keeps working."}
      </Text>
    </EmailLayout>
  )
}

RefundConfirmationEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  amountCents: 1900,
  currency: "eur",
  full: true,
} satisfies RefundConfirmationEmailProps
