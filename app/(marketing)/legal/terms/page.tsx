import type { Metadata } from "next"

import { env } from "@/lib/env"

import { LegalPage } from "../../_components/legal-page"

export const metadata: Metadata = { title: "Terms of service" }

export default function TermsPage() {
  const app = env.APP_NAME

  return (
    <LegalPage
      title="Terms of service"
      intro={
        <p>
          These terms will govern your use of {app}. The outline below shows what they will cover;
          the final wording is being prepared with a lawyer.
        </p>
      }
      sections={[
        {
          heading: "Who can use the platform",
          body: (
            <p>
              You must be an adult able to enter contracts, and you must give accurate information
              about yourself and the social accounts you connect. Brand and company accounts are not
              offered at this stage.
            </p>
          ),
        },
        {
          heading: "Creators, builders and collaborations",
          body: (
            <p>
              {app} introduces creators and builders and provides tools to agree, build and sell
              products together. Each collaboration is governed by the collaboration agreement its
              members sign. {app} is not a party to the work itself.
            </p>
          ),
        },
        {
          heading: "Payments and the platform fee",
          body: (
            <ul>
              <li>
                {app} sells products to buyers through Stripe Checkout and handles VAT through
                Stripe Tax.
              </li>
              <li>
                Revenue is split as described on the pricing page, after a payout hold period.
              </li>
              <li>Payouts require a Stripe Connect account in good standing.</li>
            </ul>
          ),
        },
        {
          heading: "Acceptable use",
          body: (
            <p>
              No unlawful, infringing, deceptive or harmful products, no manipulation of matching,
              tracking or reviews, and no attempts to move sales off the platform to avoid fees.
            </p>
          ),
        },
        {
          heading: "Suspension, disputes and termination",
          body: (
            <p>
              We may suspend accounts that break these terms. Disputes between collaboration members
              can be raised with us for review. You can close your account at any time from your
              account settings.
            </p>
          ),
        },
        {
          heading: "Liability and governing law",
          body: <p>To be completed after legal review.</p>,
        },
      ]}
    />
  )
}
