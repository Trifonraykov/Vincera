import { Button, Heading, Section, Text } from "react-email"

import { formatMoney } from "../../money"

import { EmailLayout, emailStyles } from "./_components/layout"

export type DisputeOpenedEmailProps = {
  appName: string
  productTitle: string
  amountCents: number
  currency: string
  /** Stripe's dispute reason (e.g. `fraudulent`), when known. */
  reason: string | null
  /** Absolute URL of the admin payouts page. */
  adminUrl: string
}

export function disputeOpenedSubject(productTitle: string): string {
  return `Chargeback opened on “${productTitle}”`
}

/** Stripe's reason codes in plain words. */
function reasonLabel(reason: string | null): string {
  if (!reason) return "no reason given"
  return reason.replace(/_/g, " ")
}

/**
 * §7.4 "dispute opened" for admins (notification type `admin.chargeback_opened`, §9 "notify
 * admin"): a buyer's bank opened a chargeback. The order's money is held until it closes; the
 * evidence is answered in Stripe's dashboard.
 */
export default function DisputeOpenedEmail({
  appName,
  productTitle,
  amountCents,
  currency,
  reason,
  adminUrl,
}: DisputeOpenedEmailProps) {
  const amount = formatMoney(amountCents, currency)
  return (
    <EmailLayout
      appName={appName}
      preview={`${amount} disputed on “${productTitle}”: respond in Stripe.`}
      footer={`You get this email because you are an admin on ${appName}.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        A chargeback was opened
      </Heading>
      <Text style={emailStyles.text}>
        A buyer&apos;s bank disputed {amount} on an order of “{productTitle}” ({reasonLabel(reason)}
        ). The order&apos;s earnings are held back from payouts until the dispute closes.
      </Text>
      <Text style={emailStyles.text}>
        Submit evidence in the Stripe dashboard before the response deadline. If the dispute is
        lost, the members&apos; shares are reversed and the platform pays the dispute fee.
      </Text>
      <Section style={{ margin: "24px 0" }}>
        <Button href={adminUrl} style={emailStyles.button}>
          Open admin payouts
        </Button>
      </Section>
    </EmailLayout>
  )
}

DisputeOpenedEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  amountCents: 1900,
  currency: "eur",
  reason: "fraudulent",
  adminUrl: "http://localhost:3000/admin/payouts",
} satisfies DisputeOpenedEmailProps
