import { withSentryConfig } from "@sentry/nextjs/config"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The desktop app (desktop/) bundles a self-contained server; every other build is unchanged.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // `next dev`'s route indicator sits in a corner, and on a phone every corner holds a control
  // (the tab bar's Home and More, the sidebar toggle, the theme switch), so it covered Home.
  // Compile and runtime errors are still shown (CLAUDE.md §19.19).
  devIndicators: false,
  // The signed agreement PDF's fonts are read from disk at run time (lib/agreements/pdf.tsx), a
  // path the file tracer cannot follow: list them for every function that renders the PDF (the
  // Inngest endpoint; the agreement page, whose sign action finalizes inline when jobs are fake;
  // the test-only job route). CLAUDE.md §19.30.
  outputFileTracingIncludes: {
    "/api/inngest": ["./lib/agreements/fonts/*.ttf"],
    "/app/collabs/[id]/agreement": ["./lib/agreements/fonts/*.ttf"],
    "/api/test/jobs/[name]": ["./lib/agreements/fonts/*.ttf"],
    // The iPhone app signs agreements through the mobile API (CLAUDE.md §19.44).
    "/api/mobile/v1/[...path]": ["./lib/agreements/fonts/*.ttf"],
  },
  experimental: {
    // `next dev` keeps every compiled route in memory until Turbopack's "auto" eviction sees memory
    // pressure, which it reads from the whole machine: inside a container or CI runner with a
    // lower memory limit, a session that opens ~30 routes (the e2e suite) reached 12 GB and was
    // killed. "full" drops the in-memory copies after each snapshot to the dev cache on disk and
    // reloads them on demand (peak 4.5 GB for the same routes; CLAUDE.md §19.22). Dev only.
    turbopackMemoryEviction: "full",
  },
  env: {
    // DSNs are not secret: expose the server DSN to the browser SDK (instrumentation-client.ts).
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN ?? "",
  },
  async headers() {
    return [
      {
        // The service worker (public/sw.js) is never cached, so a new version reaches every phone
        // on its next visit; its own fetches are limited to this origin (CLAUDE.md §19).
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ]
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
