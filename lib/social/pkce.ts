import { createHash, randomBytes } from "node:crypto"

import type { PkceChallenge } from "./types"

/**
 * PKCE (RFC 7636) with S256, for the providers that support it (YouTube via Google, GitHub;
 * §14, §19.10). The verifier is 32 random bytes as base64url: 43 characters from the unreserved
 * set, the minimum length the RFC allows.
 */

export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}

export function pkceChallenge(verifier: string): PkceChallenge {
  return { codeChallenge: codeChallengeFor(verifier), codeChallengeMethod: "S256" }
}

/** RFC 7636 §4.1: 43–128 characters of [A-Za-z0-9-._~]. */
export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value)
}
