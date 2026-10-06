import "server-only"

import { canManageOwnAccount, canSwitchToRole } from "@/lib/auth/authz"
import { getEnv } from "@/lib/env"
import { setActiveRole } from "@/lib/users/roles"

import { requestSignInCode, verifySignInCode, type AuthHandlers } from "../auth"
import { buildMe, revalidateApp } from "../context"
import { forbidden, MobileApiError } from "../errors"
import { endpoint, type Endpoint } from "../router"
import {
  meSchema,
  requestCodeInput,
  requestCodeOutput,
  signOutOutput,
  switchRoleInput,
  verifyCodeInput,
  verifyCodeOutput,
} from "../schemas"
import { deleteMobileSession } from "../sessions"

/** Auth.js's handlers, loaded on first use (tests inject their own through `authHandlers`). */
async function defaultHandlers(): Promise<AuthHandlers> {
  const { handlers } = await import("@/lib/auth/auth")
  return handlers
}

export function authEndpoints(options: { authHandlers?: () => Promise<AuthHandlers> } = {}) {
  const handlers = options.authHandlers ?? defaultHandlers
  return [
    endpoint({
      method: "POST",
      path: "/auth/code",
      auth: "public",
      input: requestCodeInput,
      output: requestCodeOutput,
      run: async ({ request, input, db }) => {
        await requestSignInCode(request, input, { db, env: getEnv(), handlers: await handlers() })
        return { sent: true as const }
      },
    }),
    endpoint({
      method: "POST",
      path: "/auth/verify",
      auth: "public",
      input: verifyCodeInput,
      output: verifyCodeOutput,
      run: async ({ request, input, db }) => {
        const session = await verifySignInCode(request, input, {
          db,
          env: getEnv(),
          handlers: await handlers(),
        })
        return {
          token: session.token,
          expiresAt: session.expiresAt,
          me: await buildMe(db, session.user),
        }
      },
    }),
    endpoint({
      method: "POST",
      path: "/auth/sign-out",
      auth: "user",
      output: signOutOutput,
      run: async ({ db, token }) => {
        await deleteMobileSession(db, token)
        return { signedOut: true as const }
      },
    }),
    endpoint({
      method: "GET",
      path: "/me",
      auth: "user",
      output: meSchema,
      run: async ({ db, user }) => {
        if (!canManageOwnAccount(user)) throw forbidden()
        return buildMe(db, user)
      },
    }),
    endpoint({
      method: "POST",
      path: "/me/active-role",
      auth: "onboarded",
      input: switchRoleInput,
      output: meSchema,
      run: async ({ db, user, input }) => {
        // Same rule and write as the sidebar's role switcher (lib/users/actions.ts).
        if (!canSwitchToRole(user, input.role)) throw forbidden()
        const updated = await setActiveRole(db, { userId: user.id, role: input.role })
        if (!updated) {
          throw new MobileApiError(
            422,
            "refused",
            "You don't have that role yet. Add it from onboarding first.",
          )
        }
        revalidateApp()
        return buildMe(db, { ...user, activeRole: input.role })
      },
    }),
  ] satisfies Endpoint[]
}
