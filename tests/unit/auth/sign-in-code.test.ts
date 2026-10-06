import { describe, expect, it } from "vitest"

import {
  formatSignInCode,
  generateSignInCode,
  normalizeSignInCode,
  SIGN_IN_CODE_LENGTH,
} from "@/lib/auth/sign-in-code"

describe("sign-in codes", () => {
  it("are 8 Crockford base32 characters, random", () => {
    const codes = new Set(Array.from({ length: 2000 }, generateSignInCode))
    expect(codes.size).toBe(2000)
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
      expect(normalizeSignInCode(code)).toBe(code)
    }
    // Every symbol turns up (the alphabet is used in full, not a biased subset).
    expect(new Set([...codes].join("")).size).toBe(32)
  })

  it("accept what people type: any case, dashes, spaces and look-alikes", () => {
    expect(normalizeSignInCode("7k4q-x2mz")).toBe("7K4QX2MZ")
    expect(normalizeSignInCode(" 7K4Q X2MZ ")).toBe("7K4QX2MZ")
    expect(normalizeSignInCode("O1IL-o0il")).toBe("01110011")
  })

  it("refuse anything that cannot be a code", () => {
    for (const input of [null, undefined, "", "7K4QX2M", "7K4QX2MZ9", "7K4QX2M!", "7K4QX2MU"]) {
      expect(normalizeSignInCode(input)).toBeNull()
    }
    // An older magic link's long hex token is passed through untouched by the callback.
    expect(normalizeSignInCode("a".repeat(64))).toBeNull()
    expect(SIGN_IN_CODE_LENGTH).toBe(8)
  })

  it("are shown in two groups", () => {
    expect(formatSignInCode("7K4QX2MZ")).toBe("7K4Q-X2MZ")
  })
})
