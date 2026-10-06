import { sql } from "drizzle-orm"
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core"

// Relative imports: drizzle-kit loads this folder without the `@/` path alias.
import { now } from "../../clock"
import { id, sha256HexCheck, timestamps, timestamptz, withRLS } from "./columns"
import { users } from "./identity"

/**
 * Sessions of the native iPhone app (CLAUDE.md §19.44). The app signs in with the emailed code and
 * gets an opaque bearer token; only its sha256 is stored here, so a database leak gives nobody a
 * usable token. Separate from Auth.js's `sessions` (whose cookie value is stored as is) so a
 * mobile token can never act as a web session cookie or the other way round.
 *
 * Deleted on sign-out and by "Sign out everywhere"; `expires_at` slides forward while the app is
 * used (lib/mobile-api/sessions.ts). Cascades with the user.
 */
export const mobileSessions = withRLS(
  pgTable(
    "mobile_sessions",
    {
      id: id(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      /** sha256 (hex) of the bearer token. */
      tokenHash: text("token_hash").notNull().unique("mobile_sessions_token_hash_unique"),
      /** What the app says it runs on ("iPhone 16"), shown to the person; ≤ 100 characters. */
      deviceName: text("device_name"),
      ...timestamps(),
      lastUsedAt: timestamptz("last_used_at").notNull().defaultNow().$defaultFn(now),
      expiresAt: timestamptz("expires_at").notNull(),
    },
    (t) => [
      index("mobile_sessions_user_id_idx").on(t.userId),
      check("mobile_sessions_token_hash_format", sql`${sha256HexCheck(t.tokenHash)}`),
      check(
        "mobile_sessions_device_name_length",
        sql`${t.deviceName} IS NULL OR char_length(${t.deviceName}) <= 100`,
      ),
    ],
  ),
)
