import "server-only"

import type { ReactElement } from "react"
import { render, toPlainText } from "react-email"
import { Resend } from "resend"
import { z } from "zod"

import { now } from "@/lib/clock"
import { env, isFake } from "@/lib/env"
import { newId } from "@/lib/ids"

import { writeOutboxEmail } from "./outbox"

/**
 * Transactional email (§7.4). Live: Resend. Fake: a JSON file per email in `.data/outbox/`
 * (see `./outbox.ts`), so tests can read magic links and notifications without a mail server.
 *
 * Both paths render the React Email template to HTML and plain text the same way, so the fake
 * outbox shows exactly what Resend would have sent.
 */

export type EmailAttachment = {
  filename: string
  content: Buffer | Uint8Array
  contentType?: string
}

export type SendEmailInput = {
  to: string | readonly string[]
  subject: string
  react: ReactElement
  /** Plain-text body. Defaults to a conversion of the rendered HTML. */
  text?: string
  attachments?: readonly EmailAttachment[]
  /** Searchable labels in Resend (e.g. `{ template: "magic_link" }`). Never put PII here. */
  tags?: Readonly<Record<string, string>>
  replyTo?: string
  /** Makes retries safe: Resend sends at most one email per key (24h). */
  idempotencyKey?: string
}

export type SendEmailResult = { id: string }

export class EmailSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "EmailSendError"
  }
}

const MAX_RECIPIENTS = 50
const recipientsSchema = z.array(z.email()).min(1).max(MAX_RECIPIENTS)
const resendResponseSchema = z.object({ id: z.string().min(1) })

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const to = recipientsSchema.parse(
    (typeof input.to === "string" ? [input.to] : [...input.to]).map((a) => a.trim()),
  )
  const subject = input.subject.trim()
  if (!subject) throw new EmailSendError("Email subject must not be empty")

  const html = await render(input.react)
  const text = input.text ?? toPlainText(html)
  const tags = sanitizeTags(input.tags ?? {})
  const attachments = (input.attachments ?? []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content),
    contentType: a.contentType,
  }))

  if (isFake("email")) {
    const id = newId()
    await writeOutboxEmail({
      id,
      sentAt: now().toISOString(),
      from: env.EMAIL_FROM,
      to,
      replyTo: input.replyTo ?? null,
      subject,
      html,
      text,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType ?? null,
        sizeBytes: a.content.byteLength,
      })),
      tags,
    })
    return { id }
  }

  const { data, error } = await getResend().emails.send(
    {
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
      replyTo: input.replyTo,
      attachments: attachments.length > 0 ? attachments : undefined,
      tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
  )
  if (error) {
    // Resend's message names the problem (bad sender, rate limit…) and never echoes secrets.
    throw new EmailSendError(`Resend rejected the email: ${error.message}`, { cause: error })
  }
  const parsed = resendResponseSchema.safeParse(data)
  if (!parsed.success) throw new EmailSendError("Unexpected response from Resend")
  return { id: parsed.data.id }
}

let resend: Resend | undefined

function getResend(): Resend {
  resend ??= new Resend(env.RESEND_API_KEY)
  return resend
}

/** Resend allows ASCII letters, digits, `_` and `-` in tag names and values (max 256 chars). */
function sanitizeTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256)
  return Object.fromEntries(
    Object.entries(tags)
      .map(([name, value]) => [clean(name), clean(value)] as const)
      .filter(([name, value]) => name.length > 0 && value.length > 0),
  )
}
