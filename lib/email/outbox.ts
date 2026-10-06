import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { dataDir } from "@/lib/services"

/**
 * The fake email transport's mailbox (§19.3): one JSON file per email in `.data/outbox/`.
 *
 * Written by `sendEmail` when the email service is fake; read by tests and e2e (for example to
 * pick the magic link out of the latest email to a user). No `server-only` import, so Playwright
 * and Vitest can import the readers directly.
 */

const outboxAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
})

export const outboxEmailSchema = z.object({
  id: z.string(),
  sentAt: z.iso.datetime(),
  from: z.string(),
  to: z.array(z.string()).min(1),
  replyTo: z.string().nullable(),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  attachments: z.array(outboxAttachmentSchema),
  tags: z.record(z.string(), z.string()),
})

export type OutboxEmail = z.infer<typeof outboxEmailSchema>

export function outboxDir(): string {
  return dataDir("outbox")
}

/** File names sort chronologically: `<sentAt as yyyymmddThhmmssmmmZ>-<id>.json`. */
function fileNameFor(email: OutboxEmail): string {
  const stamp = email.sentAt.replace(/[-:.]/g, "")
  return `${stamp}-${email.id}.json`
}

export async function writeOutboxEmail(email: OutboxEmail): Promise<string> {
  const parsed = outboxEmailSchema.parse(email)
  const dir = outboxDir()
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, fileNameFor(parsed))
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  return file
}

/** Every email in the outbox, oldest first. Unreadable or malformed files are skipped. */
export async function listOutbox(): Promise<OutboxEmail[]> {
  let names: string[]
  try {
    names = await readdir(outboxDir())
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  const emails: OutboxEmail[] = []
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(outboxDir(), name), "utf8"))
      const parsed = outboxEmailSchema.safeParse(raw)
      if (parsed.success) emails.push(parsed.data)
    } catch {
      // A file being written concurrently, or not ours: ignore it.
    }
  }
  return emails.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id))
}

/** The most recent email sent to `address` (case-insensitive), or null. */
export async function latestEmailTo(address: string): Promise<OutboxEmail | null> {
  const wanted = address.trim().toLowerCase()
  const emails = await listOutbox()
  for (let i = emails.length - 1; i >= 0; i--) {
    const email = emails[i]
    if (email && email.to.some((to) => extractAddress(to) === wanted)) return email
  }
  return null
}

/** Delete every email in the outbox (tests and e2e setup). */
export async function clearOutbox(): Promise<void> {
  await rm(outboxDir(), { recursive: true, force: true })
}

/** All http(s) URLs in an email's plain-text body, in order (e.g. the magic link). */
export function extractUrls(email: Pick<OutboxEmail, "text">): string[] {
  return email.text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []
}

/** "Ada <ada@example.com>" → "ada@example.com"; a bare address is lowercased. */
function extractAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return (match?.[1] ?? value).trim().toLowerCase()
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
