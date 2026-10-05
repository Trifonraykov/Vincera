import "server-only"

import { env } from "@/lib/env"

import { sendEmail, type SendEmailResult } from "./send"
import MagicLinkEmail, { magicLinkSubject } from "./templates/magic-link"

/**
 * Send the Auth.js magic-link email (for the provider's `sendVerificationRequest`). In fake mode
 * the email lands in `.data/outbox/`, where e2e tests read the link with `latestEmailTo()`.
 */
export async function sendMagicLinkEmail(input: {
  to: string
  url: string
  expiresInMinutes?: number
}): Promise<SendEmailResult> {
  return sendEmail({
    to: input.to,
    subject: magicLinkSubject(env.APP_NAME),
    react: (
      <MagicLinkEmail
        url={input.url}
        appName={env.APP_NAME}
        expiresInMinutes={input.expiresInMinutes}
      />
    ),
    tags: { template: "magic_link" },
  })
}
