import { Button, Heading, Section, Text } from "react-email"

import { formatMoney } from "../../money"

import { EmailLayout, emailStyles } from "./_components/layout"

export type PayoutSentEmailProps = {
  appName: string
  amountCents: number
  currency: string
  /** How many ledger entries (sales, refunds) the payout covers. */
  entryCount: number
  /** Absolute URL of `/app/earnings/payouts`. */
  payoutsUrl: string
}

export function payoutSentSubject(amountCents: number, currency: string): string {
  return `We sent you ${formatMoney(amountCents, currency)}`
}

/**
 * §7.4 "payout sent" (notification type `payout.sent`, a required email: it is the record of money
 * paid, CLAUDE.md §19.31). Sent once the transfer to the user's Stripe account was created; Stripe
 * then pays it to their bank on the account's payout schedule.
 */
export default function PayoutSentEmail({
  appName,
  amountCents,
  currency,
  entryCount,
  payoutsUrl,
}: PayoutSentEmailProps) {
  const amount = formatMoney(amountCents, currency)
  return (
    <EmailLayout
      appName={appName}
      preview={`${amount} is on its way to your Stripe account.`}
      footer={`We always email payouts: they are the record of money paid to you on ${appName}.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        {amount} is on its way
      </Heading>
      <Text style={emailStyles.text}>
        We sent {amount} to your Stripe account. It covers your share of{" "}
        {entryCount === 1 ? "one sale or adjustment" : `${entryCount} sales and adjustments`} that
        finished their holding period.
      </Text>
      <Text style={emailStyles.text}>
        Stripe pays it out to your bank on your payout schedule, usually within a few days.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={payoutsUrl} style={emailStyles.button}>
          See your payouts
        </Button>
      </Section>
    </EmailLayout>
  )
}

PayoutSentEmail.PreviewProps = {
  appName: "Vincera",
  amountCents: 81_800,
  currency: "eur",
  entryCount: 12,
  payoutsUrl: "http://localhost:3000/app/earnings/payouts",
} satisfies PayoutSentEmailProps
