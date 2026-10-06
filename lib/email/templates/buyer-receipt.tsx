import { Button, Heading, Section, Text } from "react-email"

import { EmailLayout, emailStyles } from "./_components/layout"

export type BuyerReceiptEmailProps = {
  appName: string
  productTitle: string
  /** "by Ada Codes × Max Builds". */
  byLine: string | null
  /** Formatted amounts ("€29.00"). */
  total: string
  vat: string | null
  discount: string | null
  /** "5 October 2026". */
  paidOn: string
  /** The order reference shown to the buyer (first part of the order id). */
  reference: string
  /** What the buyer gets, e.g. "Download your files from your access page." */
  deliveryText: string
  /** Absolute URL of `/access/<token>`; null when access ended before the email went out. */
  accessUrl: string | null
}

export function buyerReceiptSubject(productTitle: string): string {
  return `Your purchase: ${productTitle}`
}

/**
 * §7.4 "buyer receipt and access link" (CLAUDE.md §19.31, §19.34): sent by the `orders-fulfilled`
 * job once the order exists, with idempotency key `buyer-receipt:<orderId>`. The access link is the
 * buyer's only key (they have no account), so the email says to keep it.
 */
export default function BuyerReceiptEmail({
  appName,
  productTitle,
  byLine,
  total,
  vat,
  discount,
  paidOn,
  reference,
  deliveryText,
  accessUrl,
}: BuyerReceiptEmailProps) {
  const row = (label: string, value: string, strong = false) => (
    <Text style={{ ...emailStyles.text, margin: "0 0 6px" }}>
      {label}: {strong ? <strong>{value}</strong> : value}
    </Text>
  )
  return (
    <EmailLayout
      appName={appName}
      preview={`Thanks for buying ${productTitle}. Your access link is inside.`}
      footer={`You get this email because you bought “${productTitle}” on ${appName}. Keep it: the link above is how you get back to your purchase.`}
    >
      <Heading as="h1" style={emailStyles.heading}>
        Thanks for your purchase
      </Heading>
      <Text style={emailStyles.text}>
        “{productTitle}”{byLine ? ` ${byLine}` : ""} is yours. {deliveryText}
      </Text>
      {accessUrl ? (
        <Section style={{ margin: "24px 0" }}>
          <Button href={accessUrl} style={emailStyles.button}>
            Open your purchase
          </Button>
        </Section>
      ) : (
        <Text style={emailStyles.text}>Access to this purchase has ended.</Text>
      )}
      <Section style={{ margin: "8px 0 16px" }}>
        {row("Paid on", paidOn)}
        {discount ? row("Discount", discount) : null}
        {row("Total paid", total, true)}
        {vat ? row("VAT included", vat) : null}
        {row("Order reference", reference)}
      </Section>
      {accessUrl ? (
        <Text style={emailStyles.muted}>
          Anyone with this link can open your purchase, so don&apos;t share it. If the button
          doesn&apos;t work, copy this address into your browser: {accessUrl}
        </Text>
      ) : null}
    </EmailLayout>
  )
}

BuyerReceiptEmail.PreviewProps = {
  appName: "Vincera",
  productTitle: "Budget tracker for students",
  byLine: "by Ada Codes × Max Builds",
  total: "€29.00",
  vat: "€5.03",
  discount: null,
  paidOn: "5 October 2026",
  reference: "0190A000",
  deliveryText: "Download your files from your access page.",
  accessUrl: "http://localhost:3000/access/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
} satisfies BuyerReceiptEmailProps
