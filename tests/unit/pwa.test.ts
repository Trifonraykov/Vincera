import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import manifest from "@/app/manifest"
import { isBuiltRoute } from "@/lib/nav"
import {
  APPLE_TOUCH_ICON,
  APP_ICON_BACKGROUND,
  appIconSvg,
  FAVICON_SIZES,
  generatedIconFiles,
  MANIFEST_ICONS,
  markCornerRadiusShare,
  THEME_COLORS,
} from "@/lib/pwa/icons"
import {
  INSTALL_DISMISSED_KEY,
  installMethod,
  iosBrowser,
  iosInstallSteps,
  isIos,
  isStandalone,
  rememberInstallDismissed,
  wasInstallDismissed,
} from "@/lib/pwa/install"
import { appManifest, MANIFEST_SHORTCUTS } from "@/lib/pwa/manifest"
import { decodeIco, encodeIco, pngSize } from "@/lib/pwa/png"
import { serviceWorkerEnabled } from "@/lib/pwa/sw-config"

import { stubServiceEnv } from "../helpers/service-env"

afterEach(() => stubServiceEnv())

const root = process.cwd()
const publicFile = (urlPath: string) => readFileSync(path.join(root, "public", urlPath))

describe("web app manifest (installs like a mobile app)", () => {
  it("opens the app standalone at /app, branded with APP_NAME", () => {
    stubServiceEnv({ APP_NAME: "Vincera" })
    expect(manifest()).toMatchObject({
      id: "/app",
      name: "Vincera",
      short_name: "Vincera",
      start_url: "/app",
      scope: "/",
      display: "standalone",
      background_color: APP_ICON_BACKGROUND,
      theme_color: APP_ICON_BACKGROUND,
      lang: "en",
    })
    expect(manifest().description).toMatch(/creators and builders/i)
  })

  it("uses the dark theme's background for the splash and icon tile", () => {
    expect(APP_ICON_BACKGROUND).toBe(THEME_COLORS.dark)
    expect(THEME_COLORS).toEqual({ light: "#ffffff", dark: "#0a0a0a" })
  })

  it("lists 192 and 512 px PNG icons, each as `any` and `maskable`, all committed", () => {
    const icons = appManifest({ appName: "X" }).icons ?? []
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["192x192", "maskable"],
      ["512x512", "maskable"],
    ])
    for (const icon of icons) {
      expect(icon.type).toBe("image/png")
      expect(icon.src).toMatch(/^\/icons\/[a-z0-9-]+\.png$/)
      const [width] = (icon.sizes ?? "").split("x").map(Number)
      expect(pngSize(publicFile(icon.src))).toEqual({ width, height: width })
    }
  })

  it("keeps the maskable icons' mark inside the 80% safe zone launchers crop to", () => {
    for (const icon of MANIFEST_ICONS.filter((spec) => spec.purpose === "maskable")) {
      expect(icon.shape).toBe("square")
      expect(markCornerRadiusShare(icon.markShare)).toBeLessThanOrEqual(0.4)
    }
  })

  it("only offers shortcuts to pages this build has, with their icons committed", () => {
    expect(MANIFEST_SHORTCUTS.map((shortcut) => shortcut.name)).toEqual([
      "Discover",
      "Messages",
      "Audience",
    ])
    const shortcuts = appManifest({ appName: "X" }).shortcuts ?? []
    expect(shortcuts.map((shortcut) => shortcut.url)).toEqual(
      MANIFEST_SHORTCUTS.map((shortcut) => shortcut.url).filter(isBuiltRoute),
    )
    expect(shortcuts.map((shortcut) => shortcut.name)).toContain("Audience")
    for (const shortcut of shortcuts) {
      for (const icon of shortcut.icons ?? []) {
        expect(pngSize(publicFile(icon.src))).toEqual({ width: 96, height: 96 })
      }
    }
  })
})

describe("generated icon files (pnpm pwa:icons)", () => {
  it("exist with the pixel size lib/pwa/icons.ts declares", () => {
    for (const { file, size } of generatedIconFiles()) {
      expect([file, pngSize(publicFile(`/icons/${file}`))]).toEqual([
        file,
        { width: size, height: size },
      ])
    }
    expect(APPLE_TOUCH_ICON.size).toBe(180)
  })

  it("packs 16, 32 and 48 px PNGs into app/favicon.ico", () => {
    const images = decodeIco(new Uint8Array(readFileSync(path.join(root, "app", "favicon.ico"))))
    expect(images.map((image) => image.size)).toEqual([...FAVICON_SIZES])
    for (const image of images) {
      expect(pngSize(image.png)).toEqual({ width: image.size, height: image.size })
    }
  })

  it("draws the logo mark on the tile, rounded or full bleed", () => {
    const rounded = appIconSvg({ size: 192, shape: "rounded", markShare: 0.7 })
    expect(rounded).toContain(`fill="${APP_ICON_BACKGROUND}"`)
    expect(rounded).toMatch(/rx="43\.2"/)
    expect(rounded.match(/<rect /g)).toHaveLength(3)
    expect(appIconSvg({ size: 180, shape: "square", markShare: 0.66 })).toContain('rx="0"')
    expect(appIconSvg({ size: 96, shape: "rounded", markShare: 0.6 }, "<circle/>")).toContain(
      "<circle/>",
    )
  })

  it("encodes and decodes ICO directories", () => {
    const png = publicFile("/icons/icon-192.png")
    const ico = encodeIco([{ size: 192, png: new Uint8Array(png) }])
    expect(decodeIco(ico)).toEqual([{ size: 192, png: new Uint8Array(png) }])
    expect(() => encodeIco([{ size: 300, png: new Uint8Array(png) }])).toThrow(/out of range/)
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe("service worker registration", () => {
  it("registers in production builds, or when NEXT_PUBLIC_ENABLE_SW says so", () => {
    expect(serviceWorkerEnabled({ nodeEnv: "production", flag: undefined })).toBe(true)
    expect(serviceWorkerEnabled({ nodeEnv: "development", flag: undefined })).toBe(false)
    expect(serviceWorkerEnabled({ nodeEnv: "test", flag: "" })).toBe(false)
    expect(serviceWorkerEnabled({ nodeEnv: "development", flag: "1" })).toBe(true)
    expect(serviceWorkerEnabled({ nodeEnv: "production", flag: "0" })).toBe(false)
  })

  it("serves /sw.js uncached, from next.config headers", async () => {
    const { default: config } = await import("@/next.config")
    const headers = await (config.headers?.() ?? Promise.resolve([]))
    const sw = headers.find((entry) => entry.source === "/sw.js")
    expect(sw?.headers).toEqual(
      expect.arrayContaining([
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      ]),
    )
  })
})

describe("install prompt", () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  const ipad =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"
  const pixel =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"

  it("recognises iPhones and iPads (which ask for desktop sites)", () => {
    expect(isIos(iphone, 5)).toBe(true)
    expect(isIos(ipad, 5)).toBe(true)
    expect(isIos(ipad, 0)).toBe(false)
    expect(isIos(pixel, 5)).toBe(false)
  })

  it("knows when it already runs from the home screen", () => {
    const media = (matches: boolean) => () => ({ matches })
    expect(isStandalone(media(true), undefined)).toBe(true)
    expect(isStandalone(media(false), true)).toBe(true)
    expect(isStandalone(media(false), false)).toBe(false)
    expect(isStandalone(undefined, undefined)).toBe(false)
  })

  it("offers the browser's dialog, the iOS steps, or nothing", () => {
    const base = { standalone: false, installed: false, hasPromptEvent: false, ios: null }
    expect(installMethod(base)).toBe("unavailable")
    expect(installMethod({ ...base, ios: "safari" })).toBe("ios")
    expect(installMethod({ ...base, ios: "chrome" })).toBe("ios")
    expect(installMethod({ ...base, ios: "in_app" })).toBe("in_app")
    expect(installMethod({ ...base, hasPromptEvent: true })).toBe("prompt")
    expect(installMethod({ ...base, hasPromptEvent: true, standalone: true })).toBe("installed")
    expect(installMethod({ ...base, ios: "safari", installed: true })).toBe("installed")
  })

  it("tells Safari, Chrome and other iOS browsers apart from apps' built-in browsers", () => {
    const ios = (rest: string) =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${rest}`
    expect(iosBrowser(iphone, 5)).toBe("safari")
    expect(iosBrowser(ipad, 5)).toBe("safari")
    expect(iosBrowser(pixel, 5)).toBeNull()
    expect(iosBrowser(ios("CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1"), 5)).toBe("chrome")
    expect(iosBrowser(ios("FxiOS/143.0 Mobile/15E148 Safari/605.1.15"), 5)).toBe("other")
    expect(iosBrowser(ios("EdgiOS/141.0 Version/18.0 Mobile/15E148 Safari/604.1"), 5)).toBe("other")
    // Apps' web views: no Add to Home Screen there.
    for (const ua of [
      ios("Mobile/15E148 Instagram 400.0.0.29.92 (iPhone14,5; iOS 18_0; en_US; en; scale=3.00)"),
      ios("Mobile/15E148 [FBAN/FBIOS;FBAV/530.0.0.43.109;FBBV/1;FBDV/iPhone14,5;FBMD/iPhone]"),
      ios("Mobile/15E148 musical_ly_41.0.0 JsSdk/2.0 NetType/WIFI Channel/App Store"),
      ios("Mobile/15E148 Safari/604.1 TikTok 41.0.0"),
      ios("Mobile/15E148 LinkedInApp/9.31"),
      ios("Mobile/15E148 Line/14.0.0"),
      ios("Version/18.0 GSA/380.0.0 Mobile/15E148 Safari/604.1"),
      // A WKWebView of any app: no Safari token at all.
      ios("Mobile/15E148"),
    ]) {
      expect([ua, iosBrowser(ua, 5)]).toEqual([ua, "in_app"])
    }
  })

  it("words the Add to Home Screen steps for the browser at hand", () => {
    expect(iosInstallSteps("safari").share).toBe("in Safari's toolbar")
    expect(iosInstallSteps("chrome").share).toBe("in the address bar")
    expect(iosInstallSteps("other").description).not.toContain("Safari")
  })

  it("remembers 'Not now' for 60 days, and survives storage that throws", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const day = 24 * 60 * 60 * 1000
    expect(wasInstallDismissed(storage, 0)).toBe(false)
    rememberInstallDismissed(storage, 1_000)
    expect(store.get(INSTALL_DISMISSED_KEY)).toBe("1000")
    expect(wasInstallDismissed(storage, 1_000 + 59 * day)).toBe(true)
    expect(wasInstallDismissed(storage, 1_000 + 61 * day)).toBe(false)
    store.set(INSTALL_DISMISSED_KEY, "garbage")
    expect(wasInstallDismissed(storage, 0)).toBe(false)

    const broken = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }
    expect(wasInstallDismissed(broken, 0)).toBe(false)
    expect(() => rememberInstallDismissed(broken, 0)).not.toThrow()
    expect(wasInstallDismissed(undefined, 0)).toBe(false)
  })
})
