import type { MetadataRoute } from "next"

import { env } from "@/lib/env"
import { APP_ICON_BACKGROUND, PWA_ICONS } from "@/lib/pwa/app-icon"

/**
 * Web app manifest: the platform installs to a phone's home screen and opens like an app
 * (standalone, no browser bar), straight into `/app`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: env.APP_NAME,
    short_name: env.APP_NAME,
    description: "Creators and builders team up to make and sell small digital products together.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: APP_ICON_BACKGROUND,
    theme_color: APP_ICON_BACKGROUND,
    categories: ["business", "productivity"],
    icons: Object.entries(PWA_ICONS).map(([file, icon]) => ({
      src: `/pwa-icons/${file}`,
      sizes: `${icon.size}x${icon.size}`,
      type: "image/png",
      purpose: icon.purpose,
    })),
  }
}
