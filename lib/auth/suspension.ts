import "server-only"

import { eq, or, type SQL } from "drizzle-orm"
import { z } from "zod"

import type { DbOrTx } from "@/lib/db/client"
import { users } from "@/lib/db/schema"

import { normalizeEmail } from "./email"

const uuid = z.uuid()

/**
 * Whether a sign-in attempt belongs to a suspended account (§6: suspended users cannot sign in).
 *
 * Auth.js hands the `signIn` callback either our user row (returning user: real id) or a
 * placeholder built from the email / OAuth profile (new user: random or provider id), so the
 * account is looked up by id when it is a UUID and by normalised email.
 */
export async function isSuspendedSignIn(
  database: DbOrTx,
  user: { id?: string | null; email?: string | null },
): Promise<boolean> {
  const conditions: SQL[] = []
  if (user.id && uuid.safeParse(user.id).success) conditions.push(eq(users.id, user.id))
  if (user.email) conditions.push(eq(users.email, normalizeEmail(user.email)))
  if (conditions.length === 0) return false

  const rows = await database
    .select({ status: users.status })
    .from(users)
    .where(or(...conditions))
  return rows.some((row) => row.status === "suspended")
}
