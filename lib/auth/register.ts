import "server-only"

import { eq } from "drizzle-orm"

import { withTransaction, type DbOrTx } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { track } from "@/lib/events/track"
import type { AuthMethod } from "@/lib/events/types"
import { grantAdminRole } from "@/lib/users/roles"

import { normalizeEmail } from "./email"

/**
 * Sign-up (§6, §11): creating the `users` row for a first sign-in. Called by the Auth.js adapter's
 * `createUser`, so it runs for magic-link, Google and GitHub sign-ups alike.
 *
 * One transaction: insert the user, emit `user.signed_up`, and, for emails listed in
 * ADMIN_EMAILS, grant the admin role (emits `user.role_added`, writes `admin_audit_log`).
 */

export type NewUserData = {
  email: string
  name?: string | null
  image?: string | null
  emailVerified?: Date | null
}

export type SignUpContext = {
  method: AuthMethod
  /** Lowercased ADMIN_EMAILS. */
  adminEmails: readonly string[]
}

export type RegisteredUser = typeof users.$inferSelect

export async function registerUser(
  database: DbOrTx,
  data: NewUserData,
  context: SignUpContext,
): Promise<RegisteredUser> {
  const email = normalizeEmail(data.email)
  const name = data.name?.trim() || null

  return withTransaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name,
        image: data.image ?? null,
        emailVerified: data.emailVerified ?? null,
      })
      .returning()
    if (!user) throw new Error("registerUser: no row returned")

    await track(
      "user.signed_up",
      {
        actorUserId: user.id,
        subjectType: "user",
        subjectId: user.id,
        properties: { method: context.method },
      },
      tx,
    )

    if (!context.adminEmails.includes(email)) return user
    await grantAdminRole(tx, { userId: user.id, source: "admin_emails" })
    const [granted] = await tx.select().from(users).where(eq(users.id, user.id))
    if (!granted) throw new Error("registerUser: user disappeared")
    return granted
  }, database)
}
