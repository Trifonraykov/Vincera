import { expect, test } from "./fixtures"
import {
  acceptAndOpenCollab,
  collabState,
  emailsTo,
  sendPitch,
  setUpPayouts,
  taskEventTypes,
} from "./helpers/collabs"
import { eventsAbout, expectEmail, insertOpenIdea, newPerson } from "./helpers/proposals"

/**
 * §16 Phase 3 acceptance on the desktop layout (CLAUDE.md §19.28): two people go from a proposal
 * to a fully signed agreement. Signing is blocked until both have payouts (set up through fake
 * Stripe Connect), needs a typed full name, and once both signed the collab is in `building`, the
 * PDF is stored and emailed to both with the PDF attached. Then tasks and messages, and access for
 * people outside the collab.
 */

test("two people go from a proposal to a fully signed agreement", async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Ada Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Builder", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Meal planner for students")
  const title = "Meal planner for students"

  // --- Proposal → collab ------------------------------------------------------------------------
  const proposalId = await sendPitch(builder, creator, ideaId)
  const collabId = await acceptAndOpenCollab(creator, proposalId)
  const c = creator.page
  await expect(c.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(c.getByText("Agreement", { exact: true }).first()).toBeVisible()
  await expect(c.getByRole("heading", { name: "Sign the agreement" })).toBeVisible()
  expect(await collabState(collabId)).toMatchObject({
    stage: "agreement",
    agreement_status: "awaiting_signatures",
    signatures: 0,
  })
  for (const person of [creator, builder]) {
    await expectEmail(person.email, `Your agreement for “${title}” is ready to sign`)
  }

  // --- Signing needs payouts for both -----------------------------------------------------------
  await c.getByRole("link", { name: "Read and sign" }).click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/agreement$`))
  await expect(c.getByText("Draft — pending legal review.").first()).toBeVisible()
  await expect(c.getByText("the Creator (Ada Creator) receives 60%;")).toBeVisible()
  await expect(c.getByText("Set up payouts before you sign")).toBeVisible()
  await expect(c.getByRole("button", { name: "Sign the agreement" })).toBeDisabled()
  await c.getByRole("link", { name: "Set up payouts" }).click()
  await expect(c).toHaveURL(/\/app\/settings\/payouts$/)
  await setUpPayouts(c)

  await c.goto(`/app/collabs/${collabId}/agreement`)
  await expect(c.getByText("Waiting for payouts to be set up")).toBeVisible()
  await expect(c.getByText("Bo Builder still needs to set up payouts.")).toBeVisible()
  await expect(c.getByRole("button", { name: "Sign the agreement" })).toBeDisabled()

  await setUpPayouts(builder.page)

  // --- The creator signs (a name is required) --------------------------------------------------
  await c.reload()
  await expect(c.getByRole("button", { name: "Sign the agreement" })).toBeEnabled()
  await c.getByRole("button", { name: "Sign the agreement" }).click()
  await expect(c.getByText("Type your full name to sign.")).toBeVisible()
  await expect(c.getByLabel("Type your full name to sign")).toBeFocused()
  await c.getByLabel("Type your full name to sign").fill("Ada Lovelace")
  await c.getByRole("button", { name: "Sign the agreement" }).click()
  await expect(c.getByText("You signed", { exact: true })).toBeVisible()
  await expect(c.getByText("Waiting for Bo Builder to sign.")).toBeVisible()
  await expect(c.getByText("Signed as “Ada Lovelace”")).toBeVisible()
  expect(await collabState(collabId)).toMatchObject({ stage: "agreement", signatures: 1 })

  // --- The builder hears about it and signs -----------------------------------------------------
  await expectEmail(builder.email, "Ada Creator signed your agreement")
  const b = builder.page
  await b.goto("/app/collabs")
  await expect(b.getByRole("link", { name: new RegExp(title) })).toContainText("Your turn")
  await b.getByRole("link", { name: new RegExp(title) }).click()
  await expect(b).toHaveURL(new RegExp(`/app/collabs/${collabId}/agreement$`))
  await b.getByLabel("Type your full name to sign").fill("Bo Builder")
  await b.getByRole("button", { name: "Sign the agreement" }).click()
  await expect(b.getByText("Signed by both of you")).toBeVisible()
  // The PDF is rendered in the background; the page checks back until it is there.
  await expect(b.getByRole("link", { name: "Download the signed PDF" })).toBeVisible({
    timeout: 60_000,
  })

  // --- What was stored and sent ------------------------------------------------------------------
  const state = await collabState(collabId)
  expect(state).toMatchObject({
    stage: "building",
    agreement_status: "signed",
    signatures: 2,
    pdf_storage_key: `agreements/${collabId}/${state?.agreement_id}.pdf`,
  })
  const agreementEvents = (await eventsAbout(state?.agreement_id ?? "")).map((event) => event.type)
  expect(agreementEvents).toEqual([
    "agreement.generated",
    "agreement.signed",
    "agreement.signed",
    "agreement.completed",
  ])
  const collabEvents = await eventsAbout(collabId)
  expect(collabEvents.map((event) => event.type)).toEqual([
    "collab.created",
    "collab.stage_changed",
  ])
  expect(collabEvents[1]?.properties).toEqual({ from: "agreement", to: "building" })

  for (const person of [creator, builder]) {
    await expectEmail(person.email, `Your agreement for “${title}” is signed`)
    const [completed] = await emailsTo(person.email, `Your agreement for “${title}” is signed`)
    expect(completed?.attachments).toEqual([
      expect.objectContaining({
        filename: "collaboration-agreement-meal-planner-for-students.pdf",
        contentType: "application/pdf",
      }),
    ])
    expect(completed?.attachments[0]?.sizeBytes).toBeGreaterThan(2000)
  }

  // The download goes through the access-checked route to a short-lived URL.
  const href = await b.getByRole("link", { name: "Download the signed PDF" }).getAttribute("href")
  expect(href).toBe(`/api/agreements/${state?.agreement_id}/pdf`)
  const redirect = await b.request.get(href ?? "", { maxRedirects: 0 })
  expect(redirect.status()).toBe(302)
  const pdf = await b.request.get(href ?? "")
  expect(pdf.status()).toBe(200)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-")

  // The collab moved on: the overview says so.
  await c.goto(`/app/collabs/${collabId}`)
  await expect(c.getByText("Building").first()).toBeVisible()
  await expect(c.getByRole("heading", { name: "Build it together" })).toBeVisible()

  // Someone outside the collab sees nothing of it.
  const stranger = await newPerson(browser, { role: "builder", name: "Eve Else", baseURL })
  for (const path of ["", "/agreement", "/tasks", "/messages"]) {
    const response = await stranger.page.goto(`/app/collabs/${collabId}${path}`)
    expect(response?.status(), `/app/collabs/<id>${path}`).toBe(404)
  }
  const denied = await stranger.page.request.get(href ?? "", { maxRedirects: 0 })
  expect(denied.status()).toBe(404)

  for (const person of [creator, builder, stranger]) await person.page.context().close()
})

test("members plan the work in tasks and talk in the collab's messages", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Cleo Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Ben Builder", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Habit tracker")
  const proposalId = await sendPitch(builder, creator, ideaId)
  const collabId = await acceptAndOpenCollab(creator, proposalId)

  // The builder adds a task for the creator.
  const b = builder.page
  await b.goto(`/app/collabs/${collabId}/tasks`)
  await expect(b.getByText("No tasks yet")).toBeVisible()
  await b.getByRole("button", { name: "New task" }).first().click()
  const sheet = b.getByRole("dialog", { name: "New task" })
  await sheet.getByRole("button", { name: "Add task" }).click()
  await expect(sheet.getByText("Give the task a title.")).toBeVisible()
  await sheet.getByLabel("Task", { exact: true }).fill("Record a 30-second teaser")
  await sheet.getByLabel("Who does it").selectOption({ label: "Cleo Creator" })
  await sheet.getByLabel(/^Due/).fill("2030-01-15")
  await sheet.getByRole("button", { name: "Add task" }).click()
  await expect(sheet).toBeHidden()
  await expect(b.getByText("Record a 30-second teaser")).toBeVisible()
  await expect(b.getByText("Due 15 Jan 2030")).toBeVisible()

  // The creator is told, and ticks it off.
  await expectEmail(creator.email, "Ben Builder assigned you a task")
  const c = creator.page
  await c.goto(`/app/collabs/${collabId}/tasks`)
  await c.getByRole("checkbox", { name: "Mark “Record a 30-second teaser” as done" }).click()
  await expect(c.getByText("Everything is done")).toBeVisible()
  await expect(c.getByText(/Done by You on/)).toBeVisible()
  expect(await taskEventTypes(collabId)).toEqual(["task.created", "task.completed"])

  // Messages: the collab's own thread.
  await c
    .getByRole("navigation", { name: "Collab sections" })
    .getByRole("link", { name: "Messages" })
    .click()
  await expect(c).toHaveURL(new RegExp(`/app/collabs/${collabId}/messages$`))
  await c.getByRole("textbox", { name: "Message" }).fill("Teaser is up in the drive!")
  await c.getByRole("button", { name: "Send", exact: true }).click()
  await expect(c.getByText("Teaser is up in the drive!")).toBeVisible()
  await b.goto("/app/messages")
  await expect(b.getByRole("link", { name: /Cleo Creator/ }).first()).toBeVisible()

  for (const person of [creator, builder]) await person.page.context().close()
})
