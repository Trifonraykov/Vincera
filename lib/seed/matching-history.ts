import "server-only"

import { registerUser } from "@/lib/auth/register"
import { withTransaction, type Tx } from "@/lib/db/client"
import {
  collabMembers,
  collabs,
  ideas,
  launches,
  ledgerEntries,
  matches,
  orders,
  products,
  proposals,
  type ProductFormat,
} from "@/lib/db/schema"
import { MATCH_FEATURES, type MatchFeatures } from "@/lib/db/schema/types"
import { isProduction } from "@/lib/env"
import { V0_WEIGHTS, scoreFeatures } from "@/lib/matching/score"
import { sigmoid } from "@/lib/matching/v1/logistic"
import { builderProfileFormSchema, creatorProfileFormSchema } from "@/lib/profiles/fields"
import { saveBuilderProfile, saveCreatorProfile } from "@/lib/profiles/save"
import { addUserRoles } from "@/lib/users/roles"

import { findUserIdByEmail } from "./people"
import type { SeedStep } from "./types"

/**
 * `matching-history` (matching-v1, development only; CLAUDE.md §19.38 "Seed", §19.42): a past
 * marketplace for `/admin/matching` to show meaningful numbers. Ten history creators and ten
 * history builders (`seed-history-creator-01@example.com` …, never onboarded, so they are never
 * candidates in anyone's Discover and the nightly recompute skips them), two archived ideas or
 * products each, and their v0 match rows **shown** about four months ago: 600 rows with feature
 * vectors drawn from a fixed pseudo-random sequence.
 *
 * Outcomes follow a known model in which semantic fit, topic overlap and reliability matter more
 * than v0's weights say (so a trained v1 beats v0 on the hold-out): proposals (with
 * `match_snapshot`, a few without it, sent after the row was computed), accepted ones with an
 * ended collab and its members, some launches that went live and ended, and paid orders.
 *
 * The orders' ledger entries credit the platform only (`stripe_fee` + `platform_fee` = gross, no
 * member share), so `pnpm ledger:check` holds and the payout job has nothing to pay out for this
 * synthetic history; they have no Stripe charge, so the Stripe comparison skips them. Fewer than
 * 50 launches, so v1's launch gate stays closed unless forced. Idempotent: skipped once history
 * creator 01 exists. Refuses production like every seed step.
 */

const PEOPLE = 10
const ITEMS_PER_PERSON = 2
const HISTORY_DAYS_AGO = 120
const DAY_MS = 24 * 60 * 60 * 1000

export function historyCreatorEmail(index: number): string {
  return `seed-history-creator-${String(index + 1).padStart(2, "0")}@example.com`
}
export function historyBuilderEmail(index: number): string {
  return `seed-history-builder-${String(index + 1).padStart(2, "0")}@example.com`
}

const FORMATS: readonly ProductFormat[] = ["app", "tool", "template", "ai_utility", "course_tool"]
const TOPICS = ["fitness", "cooking", "finance", "productivity", "design", "language learning"]

/** mulberry32: a small deterministic PRNG, so every seed run writes the same history. */
export function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The "true" log-odds of a proposal being accepted in this synthetic history (pure; tests use it).
 * Semantic fit, topic overlap and reliability carry the signal; price fit slightly hurts.
 */
export function historyAcceptLogit(features: MatchFeatures): number {
  return (
    -6.5 +
    4 * features.semantic +
    2.5 * features.topic_overlap +
    2 * features.reliability -
    0.8 * features.price_fit +
    0.6 * features.format_fit
  )
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function randomFeatures(random: () => number): MatchFeatures {
  const features = {} as MatchFeatures
  for (const feature of MATCH_FEATURES) features[feature] = round(random())
  return features
}

type Person = { userId: string; items: { id: string; kind: "idea" | "product" }[] }

async function historyPerson(
  database: Tx,
  role: "creator" | "builder",
  index: number,
  at: Date,
): Promise<Person> {
  const email = role === "creator" ? historyCreatorEmail(index) : historyBuilderEmail(index)
  const name = `History ${role === "creator" ? "Creator" : "Builder"} ${index + 1}`
  const handle = `hist_${role}_${String(index + 1).padStart(2, "0")}`
  const user = await registerUser(database, { email, name }, { method: "email", adminEmails: [] })
  await addUserRoles(database, {
    userId: user.id,
    roles: [role],
    source: "onboarding",
    actorUserId: user.id,
    activeRole: role,
  })
  const topics = [TOPICS[index % TOPICS.length]!, TOPICS[(index + 2) % TOPICS.length]!]
  const { profileId } =
    role === "creator"
      ? await saveCreatorProfile(database, {
          userId: user.id,
          source: "onboarding",
          form: creatorProfileFormSchema.parse({
            displayName: name,
            handle,
            niche: topics[0],
            bio: "Seeded history for the matching model comparison.",
            topics: topics.join(", "),
            country: "ES",
            languages: ["en"],
          }),
        })
      : await saveBuilderProfile(database, {
          userId: user.id,
          source: "onboarding",
          form: builderProfileFormSchema.parse({
            displayName: name,
            handle,
            bio: "Seeded history for the matching model comparison.",
            skills: "typescript, design",
            stack: "next.js, postgres",
            availability: "limited",
            dealPreference: "either",
          }),
        })
  const items: Person["items"] = []
  for (let item = 0; item < ITEMS_PER_PERSON; item++) {
    const values = {
      title: `${name}'s ${item === 0 ? "first" : "second"} ${role === "creator" ? "idea" : "product"}`,
      format: FORMATS[(index + item) % FORMATS.length]!,
      topics,
      targetPriceCents: 900 + 1000 * ((index + item) % 4),
      currency: "eur",
      status: "archived" as const,
      publishedAt: new Date(at.getTime() - 5 * DAY_MS),
      archivedAt: at,
      createdAt: new Date(at.getTime() - 6 * DAY_MS),
    }
    if (role === "creator") {
      const [row] = await database
        .insert(ideas)
        .values({ ...values, creatorProfileId: profileId, problem: "Seeded history." })
        .returning({ id: ideas.id })
      if (row) items.push({ id: row.id, kind: "idea" })
    } else {
      const [row] = await database
        .insert(products)
        .values({
          ...values,
          builderProfileId: profileId,
          description: "Seeded history.",
          stage: "beta",
        })
        .returning({ id: products.id })
      if (row) items.push({ id: row.id, kind: "product" })
    }
  }
  return { userId: user.id, items }
}

export const seedMatchingHistory: SeedStep = {
  name: "matching-history",
  owner: "matching-v1",
  run: async ({ db, now }) => {
    if (isProduction()) return { skipped: "never in production" }
    if (await findUserIdByEmail(db, historyCreatorEmail(0))) {
      return { skipped: "history already seeded" }
    }
    const random = prng(20261006)
    const shownAt = new Date(now.getTime() - HISTORY_DAYS_AGO * DAY_MS)

    return withTransaction(async (tx) => {
      const creators: Person[] = []
      const builders: Person[] = []
      for (let index = 0; index < PEOPLE; index++) {
        creators.push(await historyPerson(tx, "creator", index, shownAt))
        builders.push(await historyPerson(tx, "builder", index, shownAt))
      }

      type Row = {
        subject: Person
        owner: Person
        targetType: "idea" | "product" | "creator" | "builder"
        targetId: string
        /** The idea or product a proposal is about. */
        about: { id: string; kind: "idea" | "product" }
      }
      const rows: Row[] = []
      for (const builder of builders) {
        for (const creator of creators) {
          for (const item of creator.items) {
            rows.push({
              subject: builder,
              owner: creator,
              targetType: "idea",
              targetId: item.id,
              about: item,
            })
          }
          rows.push({
            subject: builder,
            owner: creator,
            targetType: "creator",
            targetId: creator.userId,
            about: creator.items[0]!,
          })
        }
      }
      for (const creator of creators) {
        for (const builder of builders) {
          for (const item of builder.items) {
            rows.push({
              subject: creator,
              owner: builder,
              targetType: "product",
              targetId: item.id,
              about: item,
            })
          }
          rows.push({
            subject: creator,
            owner: builder,
            targetType: "builder",
            targetId: builder.userId,
            about: builder.items[0]!,
          })
        }
      }

      let created = 0
      let launchNumber = 0
      let orderNumber = 0
      for (const [index, row] of rows.entries()) {
        const features = randomFeatures(random)
        const computedAt = new Date(shownAt.getTime() + index * 60_000)
        const [match] = await tx
          .insert(matches)
          .values({
            subjectUserId: row.subject.userId,
            targetType: row.targetType,
            targetId: row.targetId,
            score: scoreFeatures(features, V0_WEIGHTS),
            features,
            modelVersion: "v0",
            status: "shown",
            computedAt,
            shownAt: new Date(computedAt.getTime() + 3_600_000),
            staleAt: new Date(computedAt.getTime() + 30 * DAY_MS),
            createdAt: computedAt,
            updatedAt: computedAt,
          })
          .returning({ id: matches.id })
        if (!match) continue
        created++

        const p = sigmoid(historyAcceptLogit(features))
        const accepted = random() < p
        const sent = accepted || random() < 0.2
        const draw = random()
        if (!sent) continue

        const sentAt = new Date(computedAt.getTime() + 2 * DAY_MS)
        const status = accepted ? "accepted" : draw < 0.5 ? "declined" : "expired"
        const closedAt = new Date(sentAt.getTime() + 3 * DAY_MS)
        const [creatorSide, builderSide] =
          row.subject.items[0]?.kind === "idea"
            ? [row.subject, row.owner]
            : [row.owner, row.subject]
        const [proposal] = await tx
          .insert(proposals)
          .values({
            fromUserId: row.subject.userId,
            toUserId: row.owner.userId,
            ideaId: row.about.kind === "idea" ? row.about.id : null,
            productId: row.about.kind === "product" ? row.about.id : null,
            status,
            matchId: match.id,
            // Most proposals froze their match; some predate snapshots (the stored vector, computed
            // before the send, stands in for them).
            matchSnapshot:
              draw < 0.85
                ? {
                    modelVersion: "v0",
                    score: scoreFeatures(features, V0_WEIGHTS),
                    features,
                    computedAt: computedAt.toISOString(),
                  }
                : null,
            expiresAt: new Date(sentAt.getTime() + 14 * DAY_MS),
            respondedAt: status === "expired" ? null : closedAt,
            closedAt,
            createdAt: sentAt,
            updatedAt: closedAt,
          })
          .returning({ id: proposals.id })
        if (!proposal || !accepted) continue

        const launched = random() < 0.3
        const endedAt = new Date(closedAt.getTime() + 60 * DAY_MS)
        const [collab] = await tx
          .insert(collabs)
          .values({
            proposalId: proposal.id,
            ideaId: row.about.kind === "idea" ? row.about.id : null,
            productId: row.about.kind === "product" ? row.about.id : null,
            stage: "ended",
            endedReason: launched ? "completed" : "cancelled",
            endedAt,
            stageChangedAt: endedAt,
            lastActivityAt: endedAt,
            createdAt: closedAt,
            updatedAt: endedAt,
          })
          .returning({ id: collabs.id })
        if (!collab) continue
        await tx.insert(collabMembers).values([
          { collabId: collab.id, userId: creatorSide.userId, role: "creator", splitPct: 50 },
          { collabId: collab.id, userId: builderSide.userId, role: "builder", splitPct: 50 },
        ])
        if (!launched) continue

        launchNumber++
        const wentLiveAt = new Date(closedAt.getTime() + 21 * DAY_MS)
        const priceCents = 1900
        const [launch] = await tx
          .insert(launches)
          .values({
            collabId: collab.id,
            slug: `history-launch-${String(launchNumber).padStart(3, "0")}`,
            title: `History launch ${launchNumber}`,
            priceCents,
            currency: "eur",
            deliveryType: "url",
            deliveryConfig: { type: "url", url: "https://example.com/history" },
            status: "ended",
            wentLiveAt,
            endedAt,
            createdAt: closedAt,
            updatedAt: endedAt,
          })
          .returning({ id: launches.id })
        if (!launch) continue
        // Better matches sell more often (the "sale" outcome).
        const sales =
          random() < sigmoid(historyAcceptLogit(features) + 1) ? 1 + Math.floor(random() * 3) : 0
        for (let sale = 0; sale < sales; sale++) {
          orderNumber++
          const paidAt = new Date(wentLiveAt.getTime() + (sale + 1) * DAY_MS)
          const stripeFee = Math.round(priceCents * 0.015) + 25
          const ref = String(orderNumber).padStart(4, "0")
          const [order] = await tx
            .insert(orders)
            .values({
              launchId: launch.id,
              buyerEmail: `seed-history-buyer-${ref}@example.com`,
              stripeCheckoutSessionId: `cs_seed_history_${ref}`,
              stripeBalanceTransactionId: `txn_seed_history_${ref}`,
              amountGrossCents: priceCents,
              stripeFeeCents: stripeFee,
              currency: "eur",
              status: "paid",
              paidAt,
              ledgerPostedAt: paidAt,
              createdAt: paidAt,
              updatedAt: paidAt,
            })
            .returning({ id: orders.id })
          if (!order) continue
          await tx.insert(ledgerEntries).values([
            {
              orderId: order.id,
              userId: null,
              account: "stripe_fee",
              amountCents: stripeFee,
              currency: "eur",
              availableAt: paidAt,
              createdAt: paidAt,
            },
            {
              orderId: order.id,
              userId: null,
              account: "platform_fee",
              amountCents: priceCents - stripeFee,
              currency: "eur",
              availableAt: paidAt,
              createdAt: paidAt,
            },
          ])
        }
      }
      return { created }
    }, db)
  },
}
