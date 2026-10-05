import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  DecryptionError,
  decrypt,
  encrypt,
  parseEncryptionKey,
  randomToken,
  sha256Hex,
} from "@/lib/crypto"

const key = randomBytes(32)
const otherKey = randomBytes(32)

describe("encrypt/decrypt", () => {
  it.each(["", "ya29.oauth-access-token", "émoji ✓ 日本語", "x".repeat(10_000)])(
    "round-trips %#",
    (plaintext) => {
      const payload = encrypt(plaintext, { key })
      expect(decrypt(payload, { key })).toBe(plaintext)
    },
  )

  it("uses the versioned v1:iv:tag:ciphertext format with base64url parts", () => {
    const payload = encrypt("secret", { key })
    const parts = payload.split(":")
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe("v1")
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]*$/)
    expect(Buffer.from(parts[1] ?? "", "base64url")).toHaveLength(12)
    expect(Buffer.from(parts[2] ?? "", "base64url")).toHaveLength(16)
  })

  it("uses a fresh IV every time", () => {
    expect(encrypt("same", { key })).not.toBe(encrypt("same", { key }))
  })

  it("detects tampering with the ciphertext, tag or IV", () => {
    const [version, iv, tag, data] = encrypt("secret value", { key }).split(":") as [
      string,
      string,
      string,
      string,
    ]
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url")
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      return bytes.toString("base64url")
    }
    for (const tampered of [
      [version, iv, tag, flip(data)],
      [version, iv, flip(tag), data],
      [version, flip(iv), tag, data],
    ]) {
      expect(() => decrypt(tampered.join(":"), { key })).toThrow(DecryptionError)
    }
  })

  it("fails with the wrong key", () => {
    const payload = encrypt("secret", { key })
    expect(() => decrypt(payload, { key: otherKey })).toThrow(DecryptionError)
  })

  it("binds ciphertext to its additional authenticated data", () => {
    const payload = encrypt("token", { key, aad: "social_connections:1" })
    expect(decrypt(payload, { key, aad: "social_connections:1" })).toBe("token")
    expect(() => decrypt(payload, { key, aad: "social_connections:2" })).toThrow(DecryptionError)
    expect(() => decrypt(payload, { key })).toThrow(DecryptionError)
  })

  it.each(["", "v1:abc", "v2:a:b:c", "not-a-payload", "v1::::"])(
    "rejects malformed payload %j",
    (payload) => {
      expect(() => decrypt(payload, { key })).toThrow(DecryptionError)
    },
  )

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encrypt("x", { key: randomBytes(16) })).toThrow(/32 bytes/)
    expect(() => parseEncryptionKey(randomBytes(31).toString("base64"))).toThrow(/32 bytes/)
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true)
  })
})

describe("randomToken", () => {
  it("returns base64url of the requested length", () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, "base64url")).toHaveLength(32)
    expect(Buffer.from(randomToken(16), "base64url")).toHaveLength(16)
    expect(randomToken()).not.toBe(token)
  })

  it("rejects invalid sizes", () => {
    expect(() => randomToken(0)).toThrow(RangeError)
    expect(() => randomToken(1.5)).toThrow(RangeError)
  })
})

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"))
  })
})
