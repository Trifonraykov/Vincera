import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

import { env } from "@/lib/env"

/**
 * Encryption at rest for secrets and OAuth tokens (§4, §14): AES-256-GCM with ENCRYPTION_KEY.
 *
 * Output format: `v1:<iv>:<tag>:<ciphertext>`, each part base64url. The version prefix lets us
 * rotate algorithms or keys later without guessing how old values were written.
 */

const VERSION = "v1"
const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor() {
    // Deliberately vague: callers and logs learn nothing about why decryption failed.
    super("Unable to decrypt value")
    this.name = "DecryptionError"
  }
}

export type CryptoOptions = {
  /** 32-byte key. Defaults to ENCRYPTION_KEY. */
  key?: Buffer
  /**
   * Additional authenticated data, e.g. `social_connections.access_token:<id>`. Binds the
   * ciphertext to its context so it cannot be copied to another row; must match on decrypt.
   */
  aad?: string
}

/** Decode a base64 key and check it is exactly 32 bytes. */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64")
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, base64-encoded`)
  }
  return key
}

function resolveKey(key: Buffer | undefined): Buffer {
  const resolved = key ?? parseEncryptionKey(env.ENCRYPTION_KEY)
  if (resolved.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes`)
  }
  return resolved
}

export function encrypt(plaintext: string, options: CryptoOptions = {}): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, resolveKey(options.key), iv, {
    authTagLength: TAG_BYTES,
  })
  if (options.aad !== undefined) cipher.setAAD(Buffer.from(options.aad, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(":")
}

/** Throws `DecryptionError` on a wrong key, wrong AAD, tampering or a malformed payload. */
export function decrypt(payload: string, options: CryptoOptions = {}): string {
  const key = resolveKey(options.key)
  const parts = payload.split(":")
  if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionError()
  const [, ivPart = "", tagPart = "", dataPart = ""] = parts
  const iv = Buffer.from(ivPart, "base64url")
  const tag = Buffer.from(tagPart, "base64url")
  const ciphertext = Buffer.from(dataPart, "base64url")
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError()

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    if (options.aad !== undefined) decipher.setAAD(Buffer.from(options.aad, "utf8"))
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  } catch {
    throw new DecryptionError()
  }
}

/** Cryptographically random token, base64url (default 32 bytes, e.g. access grant tokens §5). */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 1)
    throw new RangeError("bytes must be a positive integer")
  return randomBytes(bytes).toString("base64url")
}

/** Hex-encoded SHA-256, e.g. agreement body hashes and user-agent hashes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}
