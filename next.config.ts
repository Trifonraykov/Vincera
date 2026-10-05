import { withSentryConfig } from "@sentry/nextjs/config"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev`'s route indicator sits in a corner, and on a phone every corner holds a control
  // (the tab bar's Home and More, the sidebar toggle, the theme switch), so it covered Home.
  // Compile and runtime errors are still shown (CLAUDE.md §19.19).
  devIndicators: false,
  env: {
    // DSNs are not secret: expose the server DSN to the browser SDK (instrumentation-client.ts).
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN ?? "",
  },
}

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Source maps are only uploaded when a token is configured (CI/Vercel), never from dev machines.
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  widenClientFileUpload: true,
  silent: !process.env.CI,
  telemetry: false,
})
