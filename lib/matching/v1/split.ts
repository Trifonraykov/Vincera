import { createHash } from "node:crypto"

/**
 * The deterministic hold-out split (CLAUDE.md §19.38): a match row is held out when the first
 * byte of sha256(match id) is below 52 (52 / 256 ≈ 20 %). The same row always lands on the same
 * side, whatever the training run, so v1 and v0 are compared on the same rows every time.
 */
export const HOLDOUT_BYTE_THRESHOLD = 52

export function isHoldout(matchId: string): boolean {
  const digest = createHash("sha256").update(matchId).digest()
  return (digest[0] ?? 0) < HOLDOUT_BYTE_THRESHOLD
}
