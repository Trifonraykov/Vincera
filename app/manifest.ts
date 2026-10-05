import type { MetadataRoute } from "next"

import { env } from "@/lib/env"
import { appManifest } from "@/lib/pwa/manifest"

/** `/manifest.webmanifest`: the installable app (lib/pwa/manifest.ts, CLAUDE.md §19). */
export default function manifest(): MetadataRoute.Manifest {
  return appManifest({ appName: env.APP_NAME })
}
