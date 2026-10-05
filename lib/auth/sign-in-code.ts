/**
 * Sign-in codes (CLAUDE.md §19.19). The magic link's token is an 8-character code that the email
 * also shows, so a person can finish signing in where they asked for the link by typing it. This
 * matters for the installed app on iOS: a home-screen web app keeps its own cookies, apart from
 * Safari's, so a link tapped in Mail signs Safari in, never the app.
 *
 * Crockford base32 (no I, L, O, U): 40 bits, case-insensitive, with the usual look-alikes
 * accepted (O → 0, I and L → 1). Attempts are rate-limited per IP and per email
 * (app/api/auth/[...nextauth]/route.ts), and a code only matches the email it was sent to.
 * Client-safe.
 */

export const SIGN_IN_CODE_LENGTH = 8
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A new random code (uniform: 256 is a multiple of the alphabet's 32 symbols). */
export function generateSignInCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SIGN_IN_CODE_LENGTH))
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")
}

/**
 * The code as stored, from what a person typed ("abcd-efgh", "ABCD EFGH", "abcdefgo"), or null
 * when it cannot be a code (wrong length or characters). Anything else, such as an older magic
 * link's long token, is not a code.
 */
export function normalizeSignInCode(input: string | null | undefined): string | null {
  if (!input) return null
  const code = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1")
  if (code.length !== SIGN_IN_CODE_LENGTH) return null
  return [...code].every((char) => ALPHABET.includes(char)) ? code : null
}

/** "ABCDEFGH" → "ABCD-EFGH", easier to read and type. */
export function formatSignInCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}
