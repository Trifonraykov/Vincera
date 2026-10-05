import { readdir } from "node:fs/promises"
import path from "node:path"

import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { audienceSnapshots } from "@/lib/db/schema"
import { defaultFixturesRoot } from "@/lib/social/fake/fixtures"
import { gitHubStatsFromRaw, parseSnapshotRaw } from "@/lib/social/raw"
import { SOCIAL_PROVIDER_IDS, type SocialProviderId } from "@/lib/social/types"

import { setupTestDatabase } from "../../helpers/db"
import { insertSocialConnection, insertUser } from "../../helpers/db-fixtures"
import {
  connect,
  fakeProvider,
  NOW,
  resetSocialTest,
  setupSocialTest,
} from "../../unit/social/helpers"

/**
 * §15 "social providers against recorded fixtures": every fixture account goes through the real
 * provider code (fake transport) and its snapshot is stored in `audience_snapshots` as it is,
 * exercising the column types (numeric(6,4), jsonb, text[]) and CHECK constraints, then read
 * back through the typed raw readers.
 */

const testDb = setupTestDatabase()

beforeEach(() => setupSocialTest())
afterEach(() => resetSocialTest())

/** Fixture accounts that can produce a snapshot (Lapsed Lens can, until its token expires). */
async function fixtureAccounts(provider: SocialProviderId): Promise<string[]> {
  const files = await readdir(path.join(defaultFixturesRoot(), provider))
  return files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5))
}

describe("fixture snapshots in Postgres", () => {
  for (const provider of SOCIAL_PROVIDER_IDS) {
    it(`stores and reads back every ${provider} fixture snapshot`, async () => {
      const db = testDb.db
      for (const account of await fixtureAccounts(provider)) {
        const { provider: social } = fakeProvider(provider)
        const token = await connect(social, account)
        const profile = await social.fetchProfile(token)
        const snapshot = await social.fetchAudience(token)

        const user = await insertUser(db)
        const connection = await insertSocialConnection(db, user.id, {
          provider,
          providerAccountId: profile.providerAccountId,
          username: profile.username,
        })
        const [row] = await db
          .insert(audienceSnapshots)
          .values({ socialConnectionId: connection.id, takenAt: NOW, ...snapshot })
          .returning()
        expect(row, `${provider}/${account}`).toBeDefined()

        const [stored] = await db
          .select()
          .from(audienceSnapshots)
          .where(eq(audienceSnapshots.id, row!.id))
        expect(stored, `${provider}/${account}`).toMatchObject({
          followers: snapshot.followers,
          avgViews: snapshot.avgViews,
          engagementRate: snapshot.engagementRate,
          topCountries: snapshot.topCountries,
          countriesBasis: snapshot.countriesBasis,
          ageGender: snapshot.ageGender,
          topTopics: snapshot.topTopics,
        })
        expect(parseSnapshotRaw(provider, stored!.raw), `${provider}/${account}`).not.toBeNull()
        expect(JSON.stringify(stored!.raw)).not.toContain(token.accessToken)
        if (provider === "github") {
          expect(gitHubStatsFromRaw(stored!.raw)?.login).toBe(profile.username)
        }
      }
    })
  }
})
