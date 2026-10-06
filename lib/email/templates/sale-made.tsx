import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type SaleMadeEmailProps = {
  appName: string
  productTitle: string
  /** Formatted amount the buyer paid ("€29.00"). */
  total: string
  /** The member's share of the collab (the signed split). */
  splitPct: number
  /** "via your tracked link" or "via Ada's link"; null when the sale was not attributed. */
  attributionText: string | null
  holdDays: number
  /** Absolute URL of `/app/earnings`. */
  earningsUrl: string
}

export function saleMadeSubject(productTitle: string, total: string): string {
  return `You made a sale: ${productTitle} (${total})`
}

/**
 * §7.4 "sale made (to both parties)": notification type `sale.made`, sent to each member by the
 * `orders-fulfilled` job (dedupe `sale.made:<orderId>:<userId>`). Amounts are the buyer's total;
 * each member's share is booked once Stripe's fee is known and shows in Earnings.
 */
export default function SaleMadeEmail({
  appName,
  productTitle,
  total,
  splitPct,
  attributionText,
  holdDays,
  earningsUrl,
}: SaleMadeEmailProps) {
  return (
    <EmailLayout
      appName={appName}
      preview={`Someone bought ${productTitle} for ${total}.`}
      footer={`You get this email because of your notification settings on ${appName}. You can change them in Settings → Notifications.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        You made a sale
      </Heading>
      <Text style={emailStyles.text}>
        Someone bought “{productTitle}” for {total}
        {attributionText ? ` ${attributionText}` : ""}.
      </Text>
      <Text style={emailStyles.text}>
        Your share is {splitPct}% of what is left after VAT, Stripe&apos;s fee and the platform fee.
        It becomes available for payout {holdDays} days after the sale.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={earningsUrl} style={emailStyles.button}>
          See your earnings
        </Button>
      </Section>
    </EmailLayout>
  )
}

SaleMadeEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  total: "€29.00",
  splitPct: 60,
  attributionText: "through your tracked link",
  holdDays: 14,
  earningsUrl: "http://localhost:3000/app/earnings",
} satisfies SaleMadeEmailProps
