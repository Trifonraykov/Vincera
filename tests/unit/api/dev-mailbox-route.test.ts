import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GET as getEmail } from "@/app/api/dev/mailbox/[id]/route"
import { GET as listEmails } from "@/app/api/dev/mailbox/route"
import { listOutbox } from "@/lib/email/outbox"
import { sendEmail } from "@/lib/email/send"

import { stubServiceEnv } from "../../helpers/service-env"

// The fake email transport writes to a temporary outbox instead of the repo's .data/.
const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const nodePath = await import("node:path")
  return { dataDir: (...segments: string[]) => nodePath.join(dataRoot.dir, ...segments) }
})

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "mailbox-test-"))
})

afterEach(async () => {
  await rm(dataRoot.dir, { recursive: true, force: true })
})

async function sendMagicLink() {
  await sendEmail({
    to: "ada@example.com",
    subject: "Sign in to Vincera",
    react: createElement("a", { href: "http://localhost:3000/api/auth/callback/email?token=t" }),
  })
  const [email] = await listOutbox()
  if (!email) throw new Error("no email in the outbox")
  return email
}

function byId(id: string) {
  return getEmail(new Request(`http://localhost/api/dev/mailbox/${id}`), {
    params: Promise.resolve({ id }),
  })
}

describe("/api/dev/mailbox gating", () => {
  it("does not exist without DEV_MAILBOX, even with fake email", async () => {
    stubServiceEnv()
    const email = await sendMagicLink()
    expect((await listEmails()).status).toBe(404)
    expect((await byId(email.id)).status).toBe(404)
  })

  it("does not exist when email is live", async () => {
    stubServiceEnv({ DEV_MAILBOX: "1", FAKE_SERVICES: "" })
    vi.stubEnv("RESEND_API_KEY", "re_123")
    expect((await listEmails()).status).toBe(404)
  })

  it("lists the outbox with its links when DEV_MAILBOX is set", async () => {
    stubServiceEnv({ DEV_MAILBOX: "1" })
    const email = await sendMagicLink()

    const list = await listEmails()
    expect(list.status).toBe(200)
    const html = await list.text()
    expect(html).toContain("Sign in to Vincera")
    expect(html).toContain("/api/auth/callback/email?token=t")

    const one = await byId(email.id)
    expect(one.status).toBe(200)
    expect(one.headers.get("content-security-policy")).toContain("script-src 'none'")
    expect((await byId("missing")).status).toBe(404)
  })
})
