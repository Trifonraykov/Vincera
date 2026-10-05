import type { MetadataRoute } from "next"

import { isBuiltRoute } from "@/lib/nav"

import {
  APP_ICON_BACKGROUND,
  iconPath,
  MANIFEST_ICONS,
  SHORTCUT_ICON_SIZE,
  SHORTCUT_ICONS,
} from "./icons"

/** One line about the platform: the manifest, the root metadata and the offline page use it. */
export const APP_DESCRIPTION =
  "Creators and builders team up to make and sell small digital products together."

/** Where the installed app opens, and its identity (one install per origin and id). */
export const APP_START_URL = "/app"

/**
 * Long-press shortcuts on the installed icon. Only pages this build has (`isBuiltRoute`) are
 * listed, so a shortcut never opens a "coming soon" page; Discover and Messages appear with their
 * phases (lib/nav.ts BUILT_ROUTES).
 */
const SHORTCUTS = [
  {
    name: "Discover",
    description: "Ranked matches for your ideas and products",
    url: "/app/discover",
    icon: SHORTCUT_ICONS.discover,
  },
  {
    name: "Messages",
    description: "Proposal and collab conversations",
    url: "/app/messages",
    icon: SHORTCUT_ICONS.messages,
  },
  {
    name: "Audience",
    description: "Your followers, reach and who watches",
    url: "/app/audience",
    icon: SHORTCUT_ICONS.audience,
  },
] as const

export const MANIFEST_SHORTCUTS = SHORTCUTS

/**
 * The web app manifest (app/manifest.ts): installs to the home screen and opens standalone (no
 * browser bar) straight into the app, like a native one.
 */
export function appManifest({ appName }: { appName: string }): MetadataRoute.Manifest {
  return {
    id: APP_START_URL,
    name: appName,
    short_name: appName,
    description: APP_DESCRIPTION,
    lang: "en",
    dir: "ltr",
    start_url: APP_START_URL,
    scope: "/",
    display: "standalone",
    background_color: APP_ICON_BACKGROUND,
    theme_color: APP_ICON_BACKGROUND,
    categories: ["business", "productivity"],
    prefer_related_applications: false,
    icons: MANIFEST_ICONS.map((icon) => ({
      src: iconPath(icon.file),
      sizes: `${icon.size}x${icon.size}`,
      type: "image/png",
      purpose: icon.purpose,
    })),
    shortcuts: SHORTCUTS.filter((shortcut) => isBuiltRoute(shortcut.url)).map((shortcut) => ({
      name: shortcut.name,
      short_name: shortcut.name,
      description: shortcut.description,
      url: shortcut.url,
      icons: [
        {
          src: iconPath(shortcut.icon),
          sizes: `${SHORTCUT_ICON_SIZE}x${SHORTCUT_ICON_SIZE}`,
          type: "image/png",
        },
      ],
    })),
  }
}
