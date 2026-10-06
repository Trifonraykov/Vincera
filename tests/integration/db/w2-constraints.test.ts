import { createHash } from "node:crypto"

import { eq, sql } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"

import { setClockForTests } from "@/lib/clock"
import { PG_ERROR } from "@/lib/db/errors"
import {
  agreementSignatures,
  agreements,
  collabs,
  creatorProfiles,
  ideas,
  matches,
  messages,
  notifications,
  products,
  proposalRevisions,
  proposals,
  tasks,
  threadReads,
  type AgreementTerms,
} from "@/lib/db/schema"

import { expectPgError, setupTestDatabase } from "../../helpers/db"
import {
  insertBuilder,
  insertCollab,
  insertCreator,
  insertIdea,
  insertMatch,
  insertProduct,
  insertProposal,
  matchFeatures,
} from "../../helpers/db-fixtures"

/** The constraints migration 0009 added for Phases 2–3 (CLAUDE.md §19.24). */

const testDb = setupTestDatabase()
const CHECK = PG_ERROR.checkViolation
const UNIQUE = PG_ERROR.uniqueViolation

afterEach(() => setClockForTests(null))

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

describe("ideas and products", () => {
  it("needs published_at for published statuses and archived_at exactly while archived", async () => {
    const { profile } = await insertCreator(testDb.db)
    await expectPgError(
      testDb.db.insert(ideas).values({
        creatorProfileId: profile.id,
        title: "Open idea",
        format: "app",
        status: "open",
      }),
      CHECK,
      "ideas_published_has_time",
    )
    await expectPgError(
      insertIdea(testDb.db, profile.id, { status: "archived", archivedAt: null }),
      CHECK,
      "ideas_archived_iff_archived_at",
    )
    await expectPgError(
      insertIdea(testDb.db, profile.id, { status: "draft", archivedAt: new Date() }),
      CHECK,
      "ideas_archived_iff_archived_at",
    )
    // Archived after being published: both timestamps stay.
    const idea = await insertIdea(testDb.db, profile.id, { status: "open" })
    const [archived] = await testDb.db
      .update(ideas)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(ideas.id, idea.id))
      .returning()
    expect(archived?.publishedAt).toBeInstanceOf(Date)
    // A draft (restored from the archive) may keep its earlier published_at.
    await testDb.db
      .update(ideas)
      .set({ status: "draft", archivedAt: null })
      .where(eq(ideas.id, idea.id))
  })

  it("rejects blank titles, bad currencies and malformed embedding hashes", async () => {
    const { profile } = await insertCreator(testDb.db)
    await expectPgError(
      insertIdea(testDb.db, profile.id, { title: "  " }),
      CHECK,
      "ideas_title_not_blank",
    )
    await expectPgError(
      insertIdea(testDb.db, profile.id, { currency: "EUR" }),
      CHECK,
      "ideas_currency_format",
    )
    await expectPgError(
      insertIdea(testDb.db, profile.id, { embeddingTextHash: "abc" }),
      CHECK,
      "ideas_embedding_text_hash_format",
    )
    await insertIdea(testDb.db, profile.id, { embeddingTextHash: sha256("text") })
    await expectPgError(
      testDb.db
        .update(creatorProfiles)
        .set({ embeddingTextHash: "ABC" })
        .where(eq(creatorProfiles.id, profile.id)),
      CHECK,
      "creator_profiles_embedding_text_hash_format",
    )
  })

  it("applies the same rules to products, plus an http(s) demo link", async () => {
    const { profile } = await insertBuilder(testDb.db)
    await expectPgError(
      testDb.db.insert(products).values({
        builderProfileId: profile.id,
        title: "Seeking product",
        format: "tool",
        status: "seeking",
      }),
      CHECK,
      "products_published_has_time",
    )
    await expectPgError(
      insertProduct(testDb.db, profile.id, { status: "archived", archivedAt: null }),
      CHECK,
      "products_archived_iff_archived_at",
    )
    await expectPgError(
      insertProduct(testDb.db, profile.id, { demoUrl: "javascript:alert(1)" }),
      CHECK,
      "products_demo_url_http",
    )
    const product = await insertProduct(testDb.db, profile.id, {
      status: "seeking",
      demoUrl: "https://demo.example.test/app",
    })
    expect(product.publishedAt).toBeInstanceOf(Date)
  })
})

describe("matches", () => {
  async function subjectAndTarget() {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    return { subjectUserId: creator.user.id, targetId: builder.user.id }
  }

  it("stores exactly the §8 feature names, each a number in 0–1", async () => {
    const { subjectUserId, targetId } = await subjectAndTarget()
    const base = { subjectUserId, targetType: "builder" as const, targetId }
    const { reliability: _dropped, ...missing } = matchFeatures()
    const bad: unknown[] = [
      missing,
      { ...matchFeatures(), extra: 0.5 },
      { ...matchFeatures(), semantic: 1.2 },
      { ...matchFeatures(), price_fit: -0.1 },
      { ...matchFeatures(), topic_overlap: "0.5" },
      [0.5],
    ]
    for (const features of bad) {
      await expectPgError(
        testDb.db.execute(sql`
          INSERT INTO matches (id, subject_user_id, target_type, target_id, score, features, model_version, computed_at)
          VALUES (gen_random_uuid(), ${base.subjectUserId}, 'builder', ${base.targetId}, 0.5,
                  ${JSON.stringify(features)}::jsonb, 'v0', now())`),
        CHECK,
        "matches_features_vector",
      )
    }
    const match = await insertMatch(testDb.db, { ...base, features: matchFeatures(1) })
    expect(match.features.semantic).toBe(1)
    expect(match.staleAt).toBeNull()
    expect(match.shownAt).toBeNull()
  })

  it("never matches a person with themselves", async () => {
    const { subjectUserId } = await subjectAndTarget()
    await expectPgError(
      insertMatch(testDb.db, { subjectUserId, targetType: "creator", targetId: subjectUserId }),
      CHECK,
      "matches_not_self",
    )
  })

  it("keeps a proposal when its match row goes away (match_id set null)", async () => {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    const idea = await insertIdea(testDb.db, creator.profile.id, { status: "open" })
    const match = await insertMatch(testDb.db, {
      subjectUserId: builder.user.id,
      targetType: "idea",
      targetId: idea.id,
    })
    const { proposal } = await insertProposal(testDb.db, {
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    await testDb.db
      .update(proposals)
      .set({ matchId: match.id })
      .where(eq(proposals.id, proposal.id))
    await testDb.db.delete(matches).where(eq(matches.id, match.id))
    const [after] = await testDb.db.select().from(proposals).where(eq(proposals.id, proposal.id))
    expect(after?.matchId).toBeNull()
  })
})

describe("proposals", () => {
  async function parties() {
    const creator = await insertCreator(testDb.db)
    const builder = await insertBuilder(testDb.db)
    const idea = await insertIdea(testDb.db, creator.profile.id, { status: "open" })
    const product = await insertProduct(testDb.db, builder.profile.id, { status: "seeking" })
    return { creator, builder, idea, product }
  }

  it("sets closed_at exactly for final statuses", async () => {
    const { creator, builder, idea } = await parties()
    const base = { fromUserId: builder.user.id, toUserId: creator.user.id, ideaId: idea.id }
    await expectPgError(
      testDb.db.insert(proposals).values({ ...base, status: "declined" }),
      CHECK,
      "proposals_closed_iff_final",
    )
    await expectPgError(
      testDb.db.insert(proposals).values({ ...base, closedAt: new Date() }),
      CHECK,
      "proposals_closed_iff_final",
    )
    const { proposal } = await insertProposal(testDb.db, base)
    await testDb.db
      .update(proposals)
      .set({ status: "withdrawn", closedAt: new Date() })
      .where(eq(proposals.id, proposal.id))
  })

  it("allows one open proposal per pair and target, whoever sent it", async () => {
    const { creator, builder, idea, product } = await parties()
    const first = await insertProposal(testDb.db, {
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    // The other direction, same idea: refused.
    await expectPgError(
      testDb.db.insert(proposals).values({
        fromUserId: creator.user.id,
        toUserId: builder.user.id,
        ideaId: idea.id,
      }),
      UNIQUE,
      "proposals_one_open_per_pair_target_idx",
    )
    // Countered still counts as open.
    await testDb.db
      .update(proposals)
      .set({ status: "countered" })
      .where(eq(proposals.id, first.proposal.id))
    await expectPgError(
      testDb.db.insert(proposals).values({
        fromUserId: builder.user.id,
        toUserId: creator.user.id,
        ideaId: idea.id,
      }),
      UNIQUE,
      "proposals_one_open_per_pair_target_idx",
    )
    // Another target, or another person, is fine.
    await insertProposal(testDb.db, {
      fromUserId: creator.user.id,
      toUserId: builder.user.id,
      productId: product.id,
    })
    const other = await insertBuilder(testDb.db)
    await insertProposal(testDb.db, {
      fromUserId: other.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    // Once the first one is closed, a new one may follow.
    await testDb.db
      .update(proposals)
      .set({ status: "declined", closedAt: new Date() })
      .where(eq(proposals.id, first.proposal.id))
    await insertProposal(testDb.db, {
      fromUserId: creator.user.id,
      toUserId: builder.user.id,
      ideaId: idea.id,
    })
  })

  it("numbers revisions from 1, once each, and needs a scope", async () => {
    const { creator, builder, idea } = await parties()
    const { proposal } = await insertProposal(testDb.db, {
      fromUserId: builder.user.id,
      toUserId: creator.user.id,
      ideaId: idea.id,
    })
    const revision = (revisionNumber: number, scope = "Counter: smaller MVP") =>
      testDb.db.insert(proposalRevisions).values({
        proposalId: proposal.id,
        authorUserId: creator.user.id,
        revisionNumber,
        scope,
        creatorSplitPct: 50,
        builderSplitPct: 50,
        timelineWeeks: 6,
      })
    await expectPgError(revision(1), UNIQUE, "proposal_revisions_proposal_number_key")
    await expectPgError(revision(0), CHECK, "proposal_revisions_number_positive")
    await expectPgError(revision(2, " "), CHECK, "proposal_revisions_scope_not_blank")
    await revision(2)
  })
})

describe("collabs", () => {
  it("defaults stage_changed_at and last_activity_at to the app clock", async () => {
    const at = new Date("2026-04-01T09:30:00.000Z")
    setClockForTests(at)
    const { collab } = await insertCollab(testDb.db)
    expect(collab.stageChangedAt).toEqual(at)
    expect(collab.lastActivityAt).toEqual(at)
    expect(collab.endedAt).toBeNull()
  })

  it("ends only with ended_at and a known ended_reason", async () => {
    const { collab } = await insertCollab(testDb.db, { stage: "building" })
    await expectPgError(
      testDb.db.update(collabs).set({ stage: "ended" }).where(eq(collabs.id, collab.id)),
      CHECK,
    )
    await expectPgError(
      testDb.db
        .update(collabs)
        .set({ stage: "ended", endedAt: new Date() })
        .where(eq(collabs.id, collab.id)),
      CHECK,
      "collabs_ended_has_reason",
    )
    await expectPgError(
      testDb.db.execute(
        sql`UPDATE collabs SET stage = 'ended', ended_at = now(), ended_reason = 'bored' WHERE id = ${collab.id}`,
      ),
      PG_ERROR.invalidTextRepresentation,
    )
    await testDb.db
      .update(collabs)
      .set({ stage: "ended", endedAt: new Date(), endedReason: "cancelled" })
      .where(eq(collabs.id, collab.id))
    const ended = await insertCollab(testDb.db, { stage: "ended" })
    expect(ended.collab.endedReason).toBe("completed")
  })
})

describe("agreements", () => {
  const terms: AgreementTerms = {
    parties: [],
    scope: "MVP",
    timelineWeeks: 4,
    ip: "Joint ownership",
    term: "12 months",
    exit: "30 days notice",
  }
  // Non-ASCII on purpose: the hash is over the UTF-8 bytes, like Node's.
  const body = "Collaboration agreement — Ana Müller × Bo Ødegård, 60/40."

  async function agreementFor(overrides: Partial<typeof agreements.$inferInsert> = {}) {
    const { collab, creator, builder } = await insertCollab(testDb.db)
    const [agreement] = await testDb.db
      .insert(agreements)
      .values({
        collabId: collab.id,
        templateVersion: "v1",
        terms,
        renderedBody: body,
        bodyHash: sha256(body),
        ...overrides,
      })
      .returning()
    if (!agreement) throw new Error("no agreement")
    return { agreement, collab, creator, builder }
  }

  it("stores the rendered text and checks its sha256 against body_hash", async () => {
    const { agreement } = await agreementFor()
    expect(agreement.renderedBody).toBe(body)
    await expectPgError(
      agreementFor({ bodyHash: sha256(`${body} (edited)`) }),
      CHECK,
      "agreements_body_hash_matches_body",
    )
    await expectPgError(
      testDb.db
        .update(agreements)
        .set({ renderedBody: `${body} (edited)` })
        .where(eq(agreements.id, agreement.id)),
      CHECK,
      "agreements_body_hash_matches_body",
    )
    await expectPgError(
      agreementFor({ templateVersion: "1" }),
      CHECK,
      "agreements_template_version_format",
    )
  })

  it("ties completed_at, terminated_at and the PDF to the status", async () => {
    const { agreement } = await agreementFor()
    const update = (values: Partial<typeof agreements.$inferInsert>) =>
      testDb.db.update(agreements).set(values).where(eq(agreements.id, agreement.id))
    await expectPgError(
      update({ status: "signed" }),
      CHECK,
      "agreements_completed_at_matches_status",
    )
    await expectPgError(
      update({ completedAt: new Date() }),
      CHECK,
      "agreements_completed_at_matches_status",
    )
    await expectPgError(
      update({ pdfStorageKey: "agreements/x.pdf" }),
      CHECK,
      "agreements_pdf_after_completion",
    )
    await expectPgError(
      update({ status: "terminated" }),
      CHECK,
      "agreements_terminated_iff_terminated_at",
    )
    await update({ status: "signed", completedAt: new Date() })
    await update({ pdfStorageKey: "agreements/x.pdf" })
    // A signed agreement may later be terminated (it keeps completed_at).
    await update({ status: "terminated", terminatedAt: new Date() })
  })

  it("records the hash each party signed, with a typed name", async () => {
    const { agreement, creator } = await agreementFor()
    const sign = (values: Partial<typeof agreementSignatures.$inferInsert>) =>
      testDb.db.insert(agreementSignatures).values({
        agreementId: agreement.id,
        userId: creator.user.id,
        signedAt: new Date(),
        typedName: "Ana Müller",
        bodyHash: agreement.bodyHash,
        ...values,
      })
    await expectPgError(sign({ bodyHash: "nope" }), CHECK, "agreement_signatures_body_hash_sha256")
    await expectPgError(
      sign({ typedName: " " }),
      CHECK,
      "agreement_signatures_typed_name_not_blank",
    )
    await sign({})
  })
})

describe("tasks, messages, reads and notifications", () => {
  it("checks task titles, positions and who completed a task", async () => {
    const { collab, creator } = await insertCollab(testDb.db, { stage: "building" })
    const task = (values: Partial<typeof tasks.$inferInsert>) =>
      testDb.db
        .insert(tasks)
        .values({
          collabId: collab.id,
          title: "Wireframes",
          createdByUserId: creator.user.id,
          ...values,
        })
        .returning()
    await expectPgError(task({ title: "" }), CHECK, "tasks_title_not_blank")
    await expectPgError(task({ position: -1 }), CHECK, "tasks_position_nonnegative")
    await expectPgError(
      task({ completedByUserId: creator.user.id }),
      CHECK,
      "tasks_completed_by_only_when_done",
    )
    const [done] = await task({ doneAt: new Date(), completedByUserId: creator.user.id })
    expect(done?.completedByUserId).toBe(creator.user.id)
  })

  it("needs a message body and an attachments array; reads start unread", async () => {
    const { threadId, creator } = await insertCollab(testDb.db)
    await expectPgError(
      testDb.db.insert(messages).values({ threadId, authorUserId: creator.user.id, body: " \n" }),
      CHECK,
      "messages_body_not_blank",
    )
    await expectPgError(
      testDb.db.execute(
        sql`INSERT INTO messages (id, thread_id, author_user_id, body, attachments) VALUES (gen_random_uuid(), ${threadId}, ${creator.user.id}, 'hi', '{}'::jsonb)`,
      ),
      CHECK,
      "messages_attachments_array",
    )
    const reads = await testDb.db
      .select()
      .from(threadReads)
      .where(eq(threadReads.threadId, threadId))
    expect(reads).toHaveLength(2)
    expect(reads.every((read) => read.lastReadAt === null)).toBe(true)
  })

  it("keeps notification payloads objects", async () => {
    const { user } = await insertCreator(testDb.db)
    await expectPgError(
      testDb.db.execute(
        sql`INSERT INTO notifications (id, user_id, type, payload) VALUES (gen_random_uuid(), ${user.id}, 'payouts.ready', '[]'::jsonb)`,
      ),
      CHECK,
      "notifications_payload_object",
    )
    await testDb.db
      .insert(notifications)
      .values({ userId: user.id, type: "payouts.ready", payload: {} })
  })
})
