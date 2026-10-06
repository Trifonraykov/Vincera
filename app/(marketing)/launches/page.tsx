import type { Metadata } from "next"

import { LaunchDirectory } from "@/components/analytics/launch-directory"
import { listDirectoryLaunches } from "@/lib/analytics/directory"
import { BUILD_PHASE } from "@/lib/app-env"
import { getDb } from "@/lib/db/client"

import { Container, Hero } from "../_components/section"

export const metadata: Metadata = {
  title: "Launches",
  description: "Small paid tools, templates and apps made by creators and builders together.",
  alternates: { canonical: "/launches" },
}

/**
 * The public directory of live launches (§12 `/launches`, v1; CLAUDE.md §19.38). Static and
 * revalidated: every 5 minutes, and on demand whenever a launch goes live, pauses, resumes or ends
 * (`revalidateLaunchPage` also revalidates `/launches`). Search, format and topic filters run in
 * the browser over the rendered list, so the page itself stays static.
 *
 * `next build` has no database to read (CI builds before any database exists), so the build
 * renders an empty shell and the first request after deploy regenerates it.
 */
export const revalidate = 300

export default async function LaunchesDirectoryPage() {
  const items = process.env.NEXT_PHASE === BUILD_PHASE ? [] : await listDirectoryLaunches(getDb())
  return (
    <>
      <Hero
        eyebrow="Launches"
        title="Made by creators and builders, together"
        description="Small paid products built for real audiences: tools, templates, mini-apps and AI utilities. Every sale is split between the people who made it."
      />
      <Container className="py-10 sm:py-14">
        <LaunchDirectory items={items} />
      </Container>
    </>
  )
}
