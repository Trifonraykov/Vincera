import "server-only"

import NextAuth from "next-auth"

import { createAuthConfig } from "./config"

/**
 * The Auth.js instance. Import these only from lib/auth, the auth route handler and proxy.ts;
 * app code uses `getCurrentUser()` / `requireUser()` from lib/auth/session.ts.
 */
export const { auth, handlers, signIn, signOut } = NextAuth((request) => createAuthConfig(request))
