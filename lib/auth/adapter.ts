import "server-only"

import { DrizzleAdapter } from "@auth/drizzle-adapter"
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters"

import type { Db } from "@/lib/db/client"
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema"

import { normalizeEmail } from "./email"
import { registerUser, type SignUpContext } from "./register"

/**
 * The Auth.js Drizzle adapter on our tables (§19.5), with three changes:
 *
 * - `createUser` runs our sign-up (`registerUser`): normalised email, `user.signed_up` event and the
 *   ADMIN_EMAILS admin grant, in one transaction. `pendingName` (the optional name typed on
 *   /sign-up) fills in the name when the provider has none.
 * - `getUserByEmail` normalises the address, so `Ada@Example.com` from an OAuth profile finds the
 *   user who signed up as `ada@example.com`.
 * - `linkAccount` drops the login provider's OAuth tokens: we never call Google/GitHub with them,
 *   and §4/§14 forbid storing tokens in plaintext. Social *data* tokens live, encrypted, in
 *   social_connections.
 */

export type AuthAdapterContext = SignUpContext & { pendingName?: string | null }

function required<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`Drizzle adapter is missing ${name}`)
  return method
}

/** The account row Auth.js wants to store, without provider tokens. */
export function withoutTokens(account: AdapterAccount): AdapterAccount {
  return {
    ...account,
    access_token: undefined,
    refresh_token: undefined,
    id_token: undefined,
    session_state: undefined,
  }
}

export function createAuthAdapter(database: Db, context: AuthAdapterContext): Adapter {
  const base = DrizzleAdapter(database, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  })
  const getUserByEmail = required(base.getUserByEmail, "getUserByEmail")
  const linkAccount = required(base.linkAccount, "linkAccount")

  return {
    ...base,
    async createUser(data): Promise<AdapterUser> {
      const user = await registerUser(
        database,
        {
          email: data.email,
          name: data.name || context.pendingName,
          image: data.image,
          emailVerified: data.emailVerified,
        },
        context,
      )
      return {
        id: user.id,
        email: user.email ?? normalizeEmail(data.email),
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
      }
    },
    getUserByEmail: (email) => getUserByEmail(normalizeEmail(email)),
    linkAccount: (account) => linkAccount(withoutTokens(account)),
  }
}
