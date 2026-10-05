import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

/**
 * §6: "Every server action and every page loader calls one [authz rule]" (and §19.9: pages check
 * access themselves, besides the session helpers). A static check over the signed-in pages: each
 * imports a rule from lib/auth/authz.ts or lib/social/authz.ts and calls it. Pages that load no
 * data are listed with the reason.
 */

const SIGNED_IN_ROOTS = ["app/app", "app/onboarding", "app/admin"]

const NO_DATA_PAGES = new Map([
  ["app/app/[...missing]/page.tsx", "renders only the shell's not-found page"],
  ["app/admin/[...missing]/page.tsx", "renders only the shell's not-found page"],
  ["app/app/settings/page.tsx", "redirects to /app/settings/profile"],
])

function pageFiles(dir: string): string[] {
  return readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) return pageFiles(relative)
    return entry.name === "page.tsx" ? [relative] : []
  })
}

describe("page loaders call an authorization rule", () => {
  const pages = SIGNED_IN_ROOTS.flatMap(pageFiles)

  it("finds the signed-in pages", () => {
    expect(pages).toEqual(
      expect.arrayContaining([
        "app/app/page.tsx",
        "app/app/settings/payouts/page.tsx",
        "app/onboarding/role/page.tsx",
        "app/admin/page.tsx",
      ]),
    )
  })

  it.each(pages)("%s", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8")
    const reason = NO_DATA_PAGES.get(file)
    if (reason) {
      // Exempt pages must stay data-free.
      expect(source).not.toMatch(/@\/lib\/db/)
      return
    }
    const imported = [
      ...source.matchAll(/import \{([^}]*)\} from "@\/lib\/(?:auth|social)\/authz"/g),
    ].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((name) => name.replace(/\btype\b/, "").trim())
        .filter((name) => /^(can|is)[A-Z]/.test(name)),
    )
    expect(imported, `${file} imports no rule from lib/auth/authz or lib/social/authz`).not.toEqual(
      [],
    )
    expect(
      imported.some((rule) => new RegExp(`\\b${rule}\\(user\\b`).test(source)),
      `${file} never calls ${imported.join(", ")} with the user`,
    ).toBe(true)
  })
})
