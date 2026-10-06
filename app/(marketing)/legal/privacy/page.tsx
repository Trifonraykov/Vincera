import type { Metadata } from "next"

import { env } from "@/lib/env"

import { LegalPage } from "../../_components/legal-page"

export const metadata: Metadata = { title: "Privacy policy" }

export default function PrivacyPage() {
  const app = env.APP_NAME

  return (
    <LegalPage
      title="Privacy policy"
      intro={
        <p>
          This policy will explain what personal data {app} collects, why, and the rights you have
          under the GDPR. The outline below reflects how the platform is built today.
        </p>
      }
      sections={[
        {
          heading: "What we collect",
          body: (
            <ul>
              <li>
                Account data: your email, name, profile picture and the profile details you enter.
              </li>
              <li>
                Connected social accounts: profile and audience statistics (followers, views,
                engagement, top countries, and age and gender breakdowns where available). We
                connect only with your permission and store access tokens encrypted.
              </li>
              <li>
                Collaboration data: proposals, agreements, tasks, messages and files you share.
              </li>
              <li>
                Payment data: handled by Stripe. We store order and payout records, never card
                numbers.
              </li>
              <li>Usage data: product analytics and error reports, without message contents.</li>
            </ul>
          ),
        },
        {
          heading: "How we use it",
          body: (
            <p>
              To run the platform: matching creators and builders, generating audience summaries and
              suggestions with AI, processing sales and payouts, preventing abuse, and improving the
              product.
            </p>
          ),
        },
        {
          heading: "Service providers",
          body: (
            <p>
              We use processors for hosting, payments (Stripe), email (Resend), file storage
              (Cloudflare R2), AI features (Anthropic, Voyage AI), background jobs (Inngest),
              analytics (PostHog) and error monitoring (Sentry). The final policy will list them
              with their locations and safeguards.
            </p>
          ),
        },
        {
          heading: "Your rights",
          body: (
            <ul>
              <li>Download a copy of your data from your account settings.</li>
              <li>
                Delete your account. We then anonymise your data, keeping only the order and ledger
                records the law requires us to retain.
              </li>
              <li>
                Disconnect a social account at any time; its tokens and statistics are deleted.
              </li>
            </ul>
          ),
        },
        {
          heading: "Retention and contact",
          body: <p>To be completed after legal review.</p>,
        },
      ]}
    />
  )
}
