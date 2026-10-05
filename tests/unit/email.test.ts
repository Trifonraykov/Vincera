import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { sendMagicLinkEmail } from "@/lib/email/magic-link"
import { clearOutbox, extractUrls, latestEmailTo, listOutbox } from "@/lib/email/outbox"
import { sendEmail } from "@/lib/email/send"
import MagicLinkEmail from "@/lib/email/templates/magic-link"

import { stubServiceEnv } from "../helpers/service-env"

const dataRoot = vi.hoisted(() => ({ dir: "" }))
vi.mock("@/lib/services", async () => {
  const path = await import("node:path")
  return { dataDir: (...segments: string[]) => path.join(dataRoot.dir, ...segments) }
})

beforeEach(async () => {
  dataRoot.dir = await mkdtemp(path.join(tmpdir(), "outbox-test-"))
  stubServiceEnv()
})

afterEach(async () => {
  setClockForTests(null)
  await rm(dataRoot.dir, { recursive: true, force: true })
})

const magicUrl = "http://localhost:3000/api/auth/callback/resend?token=abc&email=ada%40example.com"

describe("sendEmail (fake outbox)", () => {
  it("renders the template and writes it to .data/outbox", async () => {
    setClockForTests(new Date("2026-04-01T09:30:00.000Z"))
    const { id } = await sendEmail({
      to: "Ada@Example.com",
      subject: "Sign in",
      react: createElement(MagicLinkEmail, { url: magicUrl, appName: "Vincera" }),
      tags: { template: "magic link!" },
      attachments: [
        { filename: "a.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" },
      ],
    })

    const files = await readdir(path.join(dataRoot.dir, "outbox"))
    expect(files).toEqual([`20260401T093000000Z-${id}.json`])

    const [email] = await listOutbox()
    expect(email).toMatchObject({
      id,
      from: "Vincera <hello@example.com>",
      to: ["Ada@Example.com"],
      subject: "Sign in",
      tags: { template: "magic_link_" },
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 4 }],
    })
    expect(email?.html).toContain("Sign in to Vincera")
    expect(email?.text).toContain(magicUrl)
  })

  it("finds the latest email per recipient and extracts its links", async () => {
    setClockForTests(new Date("2026-04-01T09:00:00.000Z"))
    await sendMagicLinkEmail({ to: "ada@example.com", url: `${magicUrl}&n=1` })
    setClockForTests(new Date("2026-04-01T09:05:00.000Z"))
    await sendMagicLinkEmail({ to: "ada@example.com", url: `${magicUrl}&n=2` })
    await sendMagicLinkEmail({ to: "bob@example.com", url: `${magicUrl}&n=3` })

    const latest = await latestEmailTo("ADA@example.com")
    expect(latest?.subject).toBe("Your sign-in link for Vincera")
    expect(extractUrls(latest!)).toContain(`${magicUrl}&n=2`)
    expect(await latestEmailTo("nobody@example.com")).toBeNull()

    await clearOutbox()
    expect(await listOutbox()).toEqual([])
  })

  it("rejects invalid recipients and empty subjects", async () => {
    const react = createElement(MagicLinkEmail, { url: magicUrl, appName: "Vincera" })
    await expect(sendEmail({ to: "not-an-email", subject: "x", react })).rejects.toThrow()
    await expect(sendEmail({ to: [], subject: "x", react })).rejects.toThrow()
    await expect(sendEmail({ to: "a@example.com", subject: "  ", react })).rejects.toThrow()
  })
})
