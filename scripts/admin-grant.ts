/**
 * pnpm admin:grant <email> — give an existing user the admin role (§6 admin bootstrap).
 *
 * The user must have signed up first. The grant emits `user.role_added` (source `admin_cli`) and
 * writes `admin_audit_log` in one transaction. New sign-ups whose email is in ADMIN_EMAILS get the
 * role automatically; this script is for everyone else.
 */
import { eq } from "drizzle-orm"

import { normalizeEmail } from "@/lib/auth/email"
import { createDb } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { grantAdminRole } from "@/lib/users/roles"

import { parseDatabaseUrl, runScript } from "./lib/db-admin"
import { loadEnvFiles, requireEnv } from "./lib/load-env"

loadEnvFiles()

runScript(async () => {
  const email = process.argv[2]
  if (!email || process.argv.length > 3) {
    throw new Error("Usage: pnpm admin:grant <email>")
  }

  const databaseUrl = requireEnv("DATABASE_URL")
  const database = createDb(databaseUrl, { max: 1 })
  try {
    const [user] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
    if (!user) {
      throw new Error(`No user with email ${email}. They need to sign up first.`)
    }

    const granted = await grantAdminRole(database.db, { userId: user.id, source: "admin_cli" })
    const { name } = parseDatabaseUrl(databaseUrl)
    console.log(
      granted
        ? `Granted the admin role to ${email} (database "${name}").`
        : `${email} is already an admin; nothing changed.`,
    )
  } finally {
    await database.close()
  }
})
