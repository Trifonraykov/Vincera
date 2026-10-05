import { randomBytes } from "node:crypto"

import { expect, type Page } from "@playwright/test"

/**
 * The profile forms as a person fills them (onboarding steps and Settings → Profile).
 */

/** A fresh handle per call, so retries and repeated runs never collide. */
export function uniqueHandle(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`
}

export type CreatorProfileInput = {
  name?: string
  handle: string
  niche?: string
  bio?: string
  /** Country name as the select shows it, e.g. "Germany". */
  country?: string
  /** Language names as the checkboxes show them, e.g. ["English", "Spanish"]. */
  languages?: string[]
}

export async function fillCreatorProfile(page: Page, input: CreatorProfileInput) {
  if (input.name !== undefined) await page.getByLabel("Name", { exact: true }).fill(input.name)
  await page.getByLabel("Handle").fill(input.handle)
  if (input.niche !== undefined) await page.getByLabel(/Your niche/).fill(input.niche)
  if (input.bio !== undefined) await page.getByLabel(/^Bio/).fill(input.bio)
  if (input.country !== undefined) {
    await page.getByLabel(/Where you're based/).selectOption({ label: input.country })
  }
  for (const language of input.languages ?? []) {
    await page.getByRole("checkbox", { name: language, exact: true }).check()
  }
}

export type BuilderProfileInput = {
  name?: string
  handle: string
  bio?: string
  skills?: string
  stack?: string
  /** Card title, e.g. "Open to new collabs". */
  availability?: string
  /** Card title, e.g. "Revenue split". */
  dealPreference?: string
}

export async function fillBuilderProfile(page: Page, input: BuilderProfileInput) {
  if (input.name !== undefined) await page.getByLabel("Name", { exact: true }).fill(input.name)
  await page.getByLabel("Handle").fill(input.handle)
  if (input.bio !== undefined) await page.getByLabel(/^Bio/).fill(input.bio)
  if (input.skills !== undefined) await page.getByLabel(/^Skills/).fill(input.skills)
  if (input.stack !== undefined) await page.getByLabel(/^Stack/).fill(input.stack)
  // The radios are visually hidden inside cards; click the card like a person would.
  if (input.availability !== undefined) {
    await page.locator("label").filter({ hasText: input.availability }).click()
  }
  if (input.dealPreference !== undefined) {
    await page.locator("label").filter({ hasText: input.dealPreference }).click()
  }
}

/** Add a project in the portfolio dialog. */
export async function addProject(
  page: Page,
  project: {
    title: string
    url?: string
    description?: string
    format?: string
    shipped?: boolean
  },
) {
  await page.getByRole("button", { name: "Add a project" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add a project" })
  await dialog.getByLabel("Title").fill(project.title)
  if (project.url !== undefined) await dialog.getByLabel(/^Link/).fill(project.url)
  if (project.description !== undefined) {
    await dialog.getByLabel(/What it does/).fill(project.description)
  }
  if (project.format !== undefined) {
    await dialog.getByLabel(/^Format/).selectOption({ label: project.format })
  }
  if (project.shipped) await dialog.getByLabel(/It's shipped/).check()
  await dialog.getByRole("button", { name: "Add project" }).click()
  await expect(dialog).toBeHidden()
}
