/**
 * pnpm pwa:icons — render the app icons (lib/pwa/icons.ts) to the PNG files under public/icons/
 * and app/favicon.ico, with Playwright's Chromium (no image library needed). The output is
 * committed; run this again after changing the mark, a colour or a size.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { chromium, type Browser } from "@playwright/test"
import { Compass, MessagesSquare, Users, type LucideIcon } from "lucide-react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  APPLE_TOUCH_ICON,
  appIconSvg,
  FAVICON_MARK_SHARE,
  FAVICON_SIZES,
  MANIFEST_ICONS,
  SHORTCUT_ICON_SIZE,
  SHORTCUT_ICONS,
  type IconSpec,
} from "@/lib/pwa/icons"
import { encodeIco, pngSize } from "@/lib/pwa/png"

import { runScript } from "./lib/db-admin"

const ROOT = process.cwd()
const ICON_DIR = path.join(ROOT, "public", "icons")
const FAVICON_FILE = path.join(ROOT, "app", "favicon.ico")
// The build sandbox ships a Chromium; elsewhere Playwright uses its own download.
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium"

const SHORTCUT_GLYPHS: Record<keyof typeof SHORTCUT_ICONS, LucideIcon> = {
  discover: Compass,
  messages: MessagesSquare,
  audience: Users,
}

async function render(browser: Browser, svg: string, size: number): Promise<Uint8Array> {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  try {
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`,
    )
    const png = await page.screenshot({ type: "png", omitBackground: true })
    const actual = pngSize(png)
    if (actual?.width !== size || actual.height !== size) {
      throw new Error(`Rendered ${size}px icon came out ${actual?.width}x${actual?.height}`)
    }
    return png
  } finally {
    await page.close()
  }
}

/** A lucide glyph as SVG children on the 24-unit grid (the `<svg>` wrapper dropped). */
function glyphMarkup(icon: LucideIcon): string {
  const svg = renderToStaticMarkup(
    createElement(icon, { color: "#fafafa", size: 24, strokeWidth: 2, absoluteStrokeWidth: true }),
  )
  const inner = /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(svg)?.[1]
  if (!inner) throw new Error(`Could not read the ${icon.displayName ?? "lucide"} glyph`)
  // Lucide draws with `stroke="currentColor"` on the root element we dropped.
  return `<g fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
}

async function write(file: string, bytes: Uint8Array) {
  await writeFile(file, bytes)
  console.log(`wrote ${path.relative(ROOT, file)} (${bytes.length} bytes)`)
}

runScript(async () => {
  await mkdir(ICON_DIR, { recursive: true })
  const browser = await chromium.launch(
    existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {},
  )
  try {
    const specs: IconSpec[] = [...MANIFEST_ICONS, APPLE_TOUCH_ICON]
    for (const spec of specs) {
      await write(
        path.join(ICON_DIR, spec.file),
        await render(browser, appIconSvg(spec), spec.size),
      )
    }

    for (const [key, file] of Object.entries(SHORTCUT_ICONS) as [
      keyof typeof SHORTCUT_ICONS,
      string,
    ][]) {
      const spec = { size: SHORTCUT_ICON_SIZE, shape: "rounded", markShare: 0.6 } as const
      const svg = appIconSvg(spec, glyphMarkup(SHORTCUT_GLYPHS[key]))
      await write(path.join(ICON_DIR, file), await render(browser, svg, spec.size))
    }

    const favicons = []
    for (const size of FAVICON_SIZES) {
      const svg = appIconSvg({ size, shape: "rounded", markShare: FAVICON_MARK_SHARE })
      favicons.push({ size, png: await render(browser, svg, size) })
    }
    await write(FAVICON_FILE, encodeIco(favicons))
  } finally {
    await browser.close()
  }
})
