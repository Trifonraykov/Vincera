import { readFile } from "node:fs/promises"

import { expect, test } from "./fixtures"
import { acceptAndOpenCollab, sendPitch } from "./helpers/collabs"
import { withE2eDb } from "./helpers/db"
import { eventsAbout, expectEmail, insertOpenIdea, newPerson } from "./helpers/proposals"

/**
 * Phase 6 trust (CLAUDE.md §19.40): "Export my data" downloads the person's JSON; "Delete account"
 * is refused while a collab is active, needs DELETE typed, then anonymises the account and signs
 * the browser out; members raise a dispute from the collab and the other member sees it.
 */

test("export my data downloads a JSON file without tokens", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("baseURL is not set")
  const person = await newPerson(browser, { role: "creator", name: "Ada Export", baseURL })
  const page = person.page
  await page.goto("/app/settings/account")
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("link", { name: "Export my data" }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/-data-\d{4}-\d{2}-\d{2}\.json$/)
  const path = await download.path()
  const data = JSON.parse(await readFile(path, "utf8")) as {
    userId: string
    format: string
    account: { email: string }
  }
  expect(data).toMatchObject({ userId: person.userId, format: "json" })
  expect(data.account.email).toBe(person.email.toLowerCase())
  const raw = await readFile(path, "utf8")
  expect(raw).not.toMatch(/token_enc|access_token|refresh_token/)
  expect((await eventsAbout(person.userId)).map((event) => event.type)).toContain(
    "user.data_exported",
  )
})

test("delete account: blocked by an active collab, then deleted and signed out", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Ada Delete", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Stay", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Habit tracker for runners")
  const proposalId = await sendPitch(builder, creator, ideaId)
  const collabId = await acceptAndOpenCollab(creator, proposalId)

  // The builder cannot delete while the collab is active.
  const b = builder.page
  await b.goto("/app/settings/account")
  await expect(b.getByText("You're in a collab that hasn't ended.", { exact: false })).toBeVisible()
  await expect(b.getByRole("button", { name: "Delete account" })).toBeDisabled()

  // End the collab (the admin or collab flow's job), then delete.
  await withE2eDb((pool) =>
    pool.query(
      "UPDATE collabs SET stage = 'ended', ended_at = now(), ended_reason = 'completed' WHERE id = $1",
      [collabId],
    ),
  )
  await b.reload()
  await b.getByRole("button", { name: "Delete account" }).click()
  const dialog = b.getByRole("dialog", { name: "Delete your account?" })
  const confirm = dialog.getByRole("button", { name: "Delete my account" })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE")
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(b).toHaveURL(/\/\?account=deleted$/)

  await b.goto("/app")
  await expect(b).toHaveURL(/\/sign-in/)
  await expectEmail(builder.email, /account was deleted/)
  const row = await withE2eDb(async (pool) => {
    const { rows } = await pool.query<{ email: string | null; deleted_at: Date | null }>(
      "SELECT email, deleted_at FROM users WHERE id = $1",
      [builder.userId],
    )
    return rows[0]
  })
  expect(row?.email).toBeNull()
  expect(row?.deleted_at).not.toBeNull()

  // The collaborator still sees the collab, with the builder anonymised.
  await creator.page.goto(`/app/collabs/${collabId}`)
  await expect(creator.page.getByText("Deleted user").first()).toBeVisible()
})

test("a member raises a dispute and the other member sees it", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Ada Dispute", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Dispute", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Plant watering reminders")
  const proposalId = await sendPitch(builder, creator, ideaId)
  const collabId = await acceptAndOpenCollab(creator, proposalId)

  const c = creator.page
  await c.getByRole("button", { name: "Raise a dispute" }).click()
  const sheet = c.getByRole("dialog", { name: "Raise a dispute" })
  await sheet.getByRole("button", { name: "Raise the dispute" }).click()
  await expect(sheet.getByText("Pick what the dispute is about.")).toBeVisible()
  await sheet.getByLabel("Work not delivered").check()
  await sheet
    .getByLabel("What happened?")
    .fill("The builder stopped answering after the agreement and nothing was delivered.")
  await sheet.getByRole("button", { name: "Raise the dispute" }).click()
  await expect(sheet).toBeHidden()

  const disputes = c.locator("#disputes")
  await expect(disputes.getByText("Work not delivered")).toBeVisible()
  await expect(disputes.getByText("Open", { exact: true })).toBeVisible()
  await expect(c.getByRole("button", { name: "Raise a dispute" })).toBeHidden()

  await expectEmail(builder.email, /raised a dispute/)
  await builder.page.goto(`/app/collabs/${collabId}#disputes`)
  await expect(builder.page.locator("#disputes").getByText("Raised by Ada Dispute")).toBeVisible()
})
