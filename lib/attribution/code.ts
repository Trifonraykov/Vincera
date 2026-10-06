import { randomBytes } from "node:crypto"

/**
 * Tracked link codes (§5 `tracked_links.code`, §10): 8 characters of base62 (`[0-9A-Za-z]`), drawn
 * from the platform's CSPRNG with rejection sampling so every character is equally likely
 * (62^8 ≈ 2.2 × 10^14 codes). The database's unique index settles the rare collision; callers
 * retry with a new code.
 */

export const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
export const TRACKED_LINK_CODE_LENGTH = 8

/** 248 = 62 × 4: bytes at or above it are dropped, so `byte % 62` is uniform. */
const UNBIASED_LIMIT = 248

export function generateLinkCode(
  random: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  let code = ""
  while (code.length < TRACKED_LINK_CODE_LENGTH) {
    for (const byte of random(16)) {
      if (byte >= UNBIASED_LIMIT) continue
      code += BASE62_ALPHABET[byte % 62]
      if (code.length === TRACKED_LINK_CODE_LENGTH) break
    }
  }
  return code
}
