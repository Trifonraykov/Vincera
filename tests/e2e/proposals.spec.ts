import { expect, test } from "./fixtures"
import {
  eventsAbout,
  expectEmail,
  insertOpenIdea,
  newPerson,
  proposalIdFrom,
  proposalState,
} from "./helpers/proposals"

/**
 * §15 e2e step 2, "Builder sends a proposal; creator counters; builder accepts" (CLAUDE.md §19.26),
 * on the desktop layout with two people in two browsers: the proposal form (validation, the linked
 * split), the email and notification to the creator, the notifications center and the bell, the
 * counter-offer sheet and its highlighted changes, a message with an attachment in the proposal's
 * thread and the inbox's unread count, then acceptance creating the collab with the countered
 * terms.
 */

test("a builder sends a proposal, the creator counters, the builder accepts", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Ada Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Bo Builder", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Recipe planner for students")

  // --- The builder sends a proposal -----------------------------------------------------------
  const b = builder.page
  await b.goto(`/app/proposals/new?to=${creator.userId}&idea=${ideaId}`)
  await expect(b.getByRole("heading", { level: 1, name: "Send a proposal" })).toBeVisible()
  await expect(b.getByText("Recipe planner for students").first()).toBeVisible()
  // Nothing in the scope: the server's message sits next to the field, the rest is kept.
  await b.getByLabel(/^Message/).fill("Hi Ada, I've built two meal apps before.")
  await b.getByRole("button", { name: "Send proposal" }).click()
  await expect(b.getByText("Describe what you'll build together.")).toBeVisible()
  await expect(b.getByLabel(/^Message/)).toHaveValue("Hi Ada, I've built two meal apps before.")

  await b.getByLabel("What you'll build together").fill("Web app: weekly plans, shopping list.")
  // The split stays linked: typing the creator's share updates the builder's.
  await b.getByLabel("Creator %").fill("55")
  await expect(b.getByLabel("Builder %")).toHaveValue("45")
  await b.getByLabel("Timeline (weeks)").fill("6")
  await b.getByRole("button", { name: "Send proposal" }).click()
  await expect(b).toHaveURL(/\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
  const proposalId = proposalIdFrom(b.url())
  await expect(b.getByText("Proposal sent")).toBeVisible()
  await expect(b.getByText("Waiting for an answer").first()).toBeVisible()
  await expect(b.getByRole("button", { name: "Withdraw proposal" })).toBeVisible()
  await expect(b.getByRole("button", { name: "Accept" })).toHaveCount(0)

  // --- The creator hears about it --------------------------------------------------------------
  await expectEmail(creator.email, "Bo Builder sent you a proposal")
  const c = creator.page
  await c.goto("/app")
  await expect(c.getByRole("link", { name: "Notifications (1 unread)" }).first()).toBeVisible()
  // The home page lists what waits for an answer.
  await expect(c.getByRole("heading", { name: "Waiting for your answer" })).toBeVisible()
  await c.goto("/app/notifications")
  await c.getByRole("button", { name: /Bo Builder sent you a proposal/ }).click()
  await expect(c).toHaveURL(new RegExp(`/app/proposals/${proposalId}$`))
  // Opening it marked it read: the bell has no count any more.
  await expect(c.getByRole("link", { name: /Notifications \(\d+ unread\)/ })).toHaveCount(0)
  await expect(c.getByText("Your turn").first()).toBeVisible()
  await expect(c.getByText("Creator 55% · Builder 45%").first()).toBeVisible()

  // --- The creator counters ----------------------------------------------------------------------
  await c.getByRole("button", { name: "Counter" }).click()
  const sheet = c.getByRole("dialog", { name: "Your counter-offer" })
  await expect(sheet).toBeVisible()
  await sheet.getByLabel("Creator %").fill("65")
  await expect(sheet.getByLabel("Builder %")).toHaveValue("35")
  await sheet.getByLabel("Timeline (weeks)").fill("8")
  await sheet.getByLabel(/^Note to them/).fill("I'll bring the audience; 65/35 feels fair.")
  await sheet.getByRole("button", { name: "Send counter-offer" }).click()
  await expect(sheet).toBeHidden()
  await expect(c.getByText("Countered").first()).toBeVisible()
  await expect(c.getByRole("button", { name: "Withdraw proposal" })).toBeVisible()

  // A message with an attachment in the proposal's thread.
  await c.locator("[data-attach-input]").setInputFiles({
    name: "pantry-sketch.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 sketch"),
  })
  await expect(c.getByText("pantry-sketch.pdf")).toBeVisible()
  await c.getByRole("textbox", { name: "Message" }).fill("Could we add a **pantry** list too?")
  await c.getByRole("button", { name: "Send", exact: true }).click()
  await expect(c.locator("strong", { hasText: "pantry" })).toBeVisible()
  await expect(c.getByRole("link", { name: /pantry-sketch\.pdf/ })).toBeVisible()

  // --- The builder sees the counter-offer and the message, then accepts ---------------------------
  await expectEmail(builder.email, "Ada Creator countered your proposal")
  await b.goto("/app/messages")
  const thread = b.getByRole("link", { name: /Ada Creator/ })
  await expect(thread).toContainText("Could we add a pantry list too?")
  await expect(thread.getByLabel("1 unread")).toBeVisible()
  await thread.click()
  await expect(b).toHaveURL(new RegExp(`/app/proposals/${proposalId}#messages$`))
  await expect(b.getByText("Your turn").first()).toBeVisible()
  // What the counter changed is marked against the offer before it.
  const history = b.getByRole("list", { name: "Offers, newest first" })
  await expect(history.getByText("was 55% / 45%")).toBeVisible()
  await expect(history.getByText("was 6 weeks")).toBeVisible()
  // The attachment downloads through the access-checked route.
  const download = await b.request.get(
    (await b.getByRole("link", { name: /pantry-sketch\.pdf/ }).getAttribute("href")) ?? "",
    { maxRedirects: 0 },
  )
  expect(download.status()).toBe(302)

  await b.getByRole("button", { name: "Accept" }).click()
  const confirm = b.getByRole("dialog", { name: "Accept these terms?" })
  await expect(confirm).toContainText("Creator 65% · Builder 35%")
  await expect(confirm).toContainText("8 weeks")
  await confirm.getByRole("button", { name: "Accept and start the collab" }).click()
  await expect(b.getByText("Accepted: you're collaborating")).toBeVisible()
  await expect(b.getByRole("link", { name: "Open the collab" })).toBeVisible()

  // --- What was stored ---------------------------------------------------------------------------
  const stored = await proposalState(proposalId)
  expect(stored).toMatchObject({
    status: "accepted",
    revisions: 2,
    creator_split: 65,
    builder_split: 35,
    idea_status: "in_collab",
  })
  expect(stored?.collab_id).toBeTruthy()
  const types = (await eventsAbout(proposalId)).map((event) => event.type)
  expect(types).toEqual(["proposal.sent", "proposal.countered", "proposal.accepted"])
  await expectEmail(creator.email, "Bo Builder accepted your proposal")

  // The creator's list moves it to Closed; the bell has the acceptance.
  await c.goto("/app/proposals?tab=closed")
  await expect(c.getByRole("link", { name: /Recipe planner for students/ })).toContainText(
    "Accepted",
  )
  await c.goto("/app/notifications")
  await expect(c.getByRole("button", { name: /Bo Builder accepted your proposal/ })).toBeVisible()
  await c.getByRole("button", { name: "Mark all as read" }).click()
  await expect(c.getByText("Unread:")).toHaveCount(0)

  await creator.page.context().close()
  await builder.page.context().close()
})

test("a proposal page is only for its two parties", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error("baseURL is not set")
  const creator = await newPerson(browser, { role: "creator", name: "Cy Creator", baseURL })
  const builder = await newPerson(browser, { role: "builder", name: "Di Builder", baseURL })
  const ideaId = await insertOpenIdea(creator.userId, "Habit tracker")
  await builder.page.goto(`/app/proposals/new?to=${creator.userId}&idea=${ideaId}`)
  await builder.page.getByLabel("What you'll build together").fill("A habit tracker app.")
  await builder.page.getByRole("button", { name: "Send proposal" }).click()
  await expect(builder.page).toHaveURL(/\/app\/proposals\/[0-9a-f-]{36}\?sent=1$/)
  const proposalId = proposalIdFrom(builder.page.url())

  // A second proposal about the same idea is refused while this one is open.
  await builder.page.goto(`/app/proposals/new?to=${creator.userId}&idea=${ideaId}`)
  await expect(
    builder.page.getByText("You already have an open proposal with them about this"),
  ).toBeVisible()

  // Someone else gets a 404, and the proposal is not in their lists.
  const stranger = await newPerson(browser, { role: "builder", name: "Eve Else", baseURL })
  const response = await stranger.page.goto(`/app/proposals/${proposalId}`)
  expect(response?.status()).toBe(404)
  await stranger.page.goto("/app/proposals?tab=sent")
  await expect(stranger.page.getByText("No open proposals from you")).toBeVisible()
  // Nobody can make a deal about someone else's idea with a third person.
  await stranger.page.goto(`/app/proposals/new?to=${builder.userId}&idea=${ideaId}`)
  await expect(stranger.page.getByText("You can't send this proposal")).toBeVisible()

  // The builder withdraws; the creator is told and can no longer answer.
  await builder.page.goto(`/app/proposals/${proposalId}`)
  await builder.page.getByRole("button", { name: "Withdraw proposal" }).click()
  await builder.page.getByRole("dialog").getByRole("button", { name: "Withdraw" }).click()
  await expect(builder.page.getByText("This proposal was withdrawn.")).toBeVisible()
  await creator.page.goto(`/app/proposals/${proposalId}`)
  await expect(creator.page.getByRole("button", { name: "Accept" })).toHaveCount(0)
  await expect(
    creator.page.getByText("This proposal is closed, so its conversation is read-only."),
  ).toBeVisible()
  for (const person of [creator, builder, stranger]) await person.page.context().close()
})
