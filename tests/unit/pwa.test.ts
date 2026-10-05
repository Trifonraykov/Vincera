import { afterEach, describe, expect, it } from "vitest"

import manifest from "@/app/manifest"
import { isPwaIconFile, PWA_ICONS } from "@/lib/pwa/app-icon"

import { stubServiceEnv } from "../helpers/service-env"

afterEach(() => stubServiceEnv())

describe("web app manifest (installs like a mobile app)", () => {
  it("opens the app standalone at /app, branded with APP_NAME", () => {
    stubServiceEnv({ APP_NAME: "Vincera" })
    const result = manifest()
    expect(result).toMatchObject({
      id: "/app",
      name: "Vincera",
      short_name: "Vincera",
      start_url: "/app",
      scope: "/",
      display: "standalone",
    })
  })

  it("lists 192 and 512 px PNG icons plus a maskable one, all served by the icon route", () => {
    stubServiceEnv()
    const icons = manifest().icons ?? []
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ])
    for (const icon of icons) {
      const file = icon.src.replace("/pwa-icons/", "")
      expect(isPwaIconFile(file)).toBe(true)
      expect(icon.type).toBe("image/png")
    }
    // Maskable icons keep the mark inside the 80% safe zone.
    expect(PWA_ICONS["maskable-512.png"].markShare).toBeLessThanOrEqual(0.8 * 0.8)
    expect(isPwaIconFile("toString")).toBe(false)
  })
})
