/**
 * The installed app's icons (home screen, app switcher, splash, favicon) and the colours the
 * manifest and the browser chrome use. Client-safe, no server imports.
 *
 * The PNG files under public/icons/ (and app/favicon.ico) are generated from `appIconSvg` by
 * `pnpm pwa:icons` (scripts/pwa-icons.ts, rendered with Playwright's Chromium) and committed.
 * tests/unit/pwa.test.ts checks that every file listed here exists with the right pixel size, so
 * run the script again after changing the mark, a colour or a size.
 */

/** The page background of each theme (app/globals.css `--background`), for `theme-color`. */
export const THEME_COLORS = { light: "#ffffff", dark: "#0a0a0a" } as const

/**
 * The icon tile and splash colour: the dark theme's background, so the splash screen (Android
 * paints `background_color` around the icon) and the icon read as one surface.
 */
export const APP_ICON_BACKGROUND = THEME_COLORS.dark

/** Where the generated icons are served from (public/icons/). The service worker caches it. */
export const PWA_ICON_DIR = "/icons"

export type IconShape = "rounded" | "square"

export type IconSpec = {
  /** File name under public/icons/. */
  file: string
  size: number
  /**
   * `rounded`: a rounded tile with transparent corners (desktop installs, favicons, shortcuts).
   * `square`: full bleed and opaque, for platforms that crop the icon themselves (maskable
   * launchers, iOS).
   */
  shape: IconShape
  /** The share of the tile the mark's 24-unit grid spans (the mark itself is 20 of 24 units). */
  markShare: number
  /** Manifest `purpose`; undefined for icons that are not in the manifest. */
  purpose?: "any" | "maskable"
}

/** Icons listed in the web app manifest. */
export const MANIFEST_ICONS: readonly IconSpec[] = [
  { file: "icon-192.png", size: 192, shape: "rounded", markShare: 0.7, purpose: "any" },
  { file: "icon-512.png", size: 512, shape: "rounded", markShare: 0.7, purpose: "any" },
  // Launchers crop maskable icons to a circle of 80% of the tile, so the mark sits well inside it.
  { file: "maskable-192.png", size: 192, shape: "square", markShare: 0.6, purpose: "maskable" },
  { file: "maskable-512.png", size: 512, shape: "square", markShare: 0.6, purpose: "maskable" },
]

/** iOS home-screen icon (`apple-touch-icon`): opaque, iOS rounds the corners itself. */
export const APPLE_TOUCH_ICON: IconSpec = {
  file: "apple-touch-icon.png",
  size: 180,
  shape: "square",
  markShare: 0.66,
}

/** The sizes packed into app/favicon.ico (a bigger mark: they are seen tiny). */
export const FAVICON_SIZES = [16, 32, 48] as const
export const FAVICON_MARK_SHARE = 0.86

/** App shortcuts (long-press on the installed icon): one 96 px icon each, a lucide glyph. */
export const SHORTCUT_ICON_SIZE = 96
export const SHORTCUT_ICONS = {
  discover: "shortcut-discover.png",
  messages: "shortcut-messages.png",
  audience: "shortcut-audience.png",
} as const

export function iconPath(file: string): string {
  return `${PWA_ICON_DIR}/${file}`
}

/** Every generated PNG under public/icons/ with its pixel size (for the tests and the script). */
export function generatedIconFiles(): { file: string; size: number }[] {
  return [
    ...MANIFEST_ICONS.map(({ file, size }) => ({ file, size })),
    { file: APPLE_TOUCH_ICON.file, size: APPLE_TOUCH_ICON.size },
    ...Object.values(SHORTCUT_ICONS).map((file) => ({ file, size: SHORTCUT_ICON_SIZE })),
  ]
}

/**
 * How far the visible mark reaches from the tile's centre, as a share of the tile's width: the
 * mark is a 20-unit square on the 24-unit grid, so its corner is at half its diagonal.
 */
export function markCornerRadiusShare(markShare: number): number {
  const markSide = (markShare * 20) / 24
  return (markSide * Math.SQRT2) / 2
}

// The logo mark (components/shared/logo.tsx, app/icon.svg) in its dark-theme colours.
const MARK_FRONT = "#fafafa"
const MARK_BACK = "#404040"

/**
 * The app icon as an SVG document `size` px square: the two overlapping squares of the logo on a
 * dark tile. `glyph` replaces the mark with other SVG content on the same 24-unit grid (the
 * shortcut icons use lucide glyphs).
 */
export function appIconSvg(
  spec: Pick<IconSpec, "size" | "shape" | "markShare">,
  glyph?: string,
): string {
  const { size, shape, markShare } = spec
  const grid = size * markShare
  const offset = (size - grid) / 2
  const scale = grid / 24
  const radius = shape === "rounded" ? size * 0.225 : 0
  const mark =
    glyph ??
    `<rect x="2" y="2" width="13" height="13" rx="3.5" fill="${MARK_FRONT}"/>` +
      `<rect x="9" y="9" width="13" height="13" rx="3.5" fill="${MARK_BACK}" stroke="${MARK_FRONT}" stroke-width="1.5"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${APP_ICON_BACKGROUND}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${mark}</g>` +
    `</svg>`
  )
}
