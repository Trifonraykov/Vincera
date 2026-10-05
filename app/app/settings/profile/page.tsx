import { ExternalLink, UserPlus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { BuilderProfileForm } from "@/components/profiles/builder-profile-form"
import { CreatorProfileForm } from "@/components/profiles/creator-profile-form"
import { PortfolioManager } from "@/components/profiles/portfolio-manager"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { canEditBuilderProfile, canEditCreatorProfile } from "@/lib/auth/authz"
import { requireOnboardedUser } from "@/lib/auth/session"
import { appRolesOf } from "@/lib/auth/user"
import { getDb } from "@/lib/db/client"
import { ROLE_LABELS, type AppRole } from "@/lib/nav"
import { ONBOARDING_STEP_PATHS } from "@/lib/onboarding/steps"
import { countryOptions, languageOptions } from "@/lib/profiles/locale"
import {
  builderProfilePageData,
  creatorProfilePageData,
  portfolioPageItems,
} from "@/lib/profiles/page-data"

export const metadata: Metadata = { title: "Profile" }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * Settings → Profile (§12): the user's creator and/or builder profile, and the builder's
 * portfolio. With both roles the profiles sit in tabs, the active role's first (`?tab=creator`
 * or `?tab=builder` opens the other). A role without a profile (added later and left midway,
 * §19.11) links to its onboarding step.
 */
export default async function ProfileSettingsPage({ searchParams }: Props) {
  // Pages check access themselves too: layouts are not re-rendered on client navigations.
  const user = await requireOnboardedUser()
  const db = getDb()
  const roles = appRolesOf(user)
  const ordered: AppRole[] = [...roles].sort((a, b) =>
    a === user.activeRole ? -1 : b === user.activeRole ? 1 : 0,
  )

  const sections = (
    await Promise.all(
      ordered.map(async (role) => {
        if (role === "creator" && canEditCreatorProfile(user)) {
          return {
            role,
            node: <CreatorSection data={await creatorProfilePageData(db, user)} />,
          }
        }
        if (role === "builder" && canEditBuilderProfile(user)) {
          const [data, items] = await Promise.all([
            builderProfilePageData(db, user),
            portfolioPageItems(db, user.id),
          ])
          return { role, node: <BuilderSection data={data} items={items} /> }
        }
        return null
      }),
    )
  ).filter((section) => section !== null)

  const requested = (await searchParams).tab
  const initialTab =
    sections.find((section) => section.role === requested)?.role ?? sections[0]?.role

  return (
    <div className="max-w-3xl space-y-10">
      <PageHeader
        title="Profile"
        description="What other people see on your public profile and in their matches."
      />
      {sections.length > 1 && initialTab ? (
        <Tabs defaultValue={initialTab} className="gap-6">
          <TabsList className="w-full sm:w-fit" aria-label="Your profiles">
            {sections.map((section) => (
              <TabsTrigger key={section.role} value={section.role} className="px-4">
                {ROLE_LABELS[section.role]} profile
              </TabsTrigger>
            ))}
          </TabsList>
          {sections.map((section) => (
            // Kept mounted, so unsaved edits survive switching tabs.
            <TabsContent
              key={section.role}
              value={section.role}
              forceMount
              className="data-[state=inactive]:hidden"
            >
              {section.node}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        sections.map((section) => <div key={section.role}>{section.node}</div>)
      )}
    </div>
  )
}

function ViewPublicLink({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />
        View public profile<span className="sr-only"> (opens in a new tab)</span>
      </Link>
    </Button>
  )
}

function MissingProfile({ role }: { role: AppRole }) {
  const href = ONBOARDING_STEP_PATHS[role === "creator" ? "creator.profile" : "builder.profile"]
  return (
    <EmptyState
      icon={UserPlus}
      title={`You haven't set up your ${role} profile yet`}
      description={
        role === "creator"
          ? "Builders find creators through their profile. It takes a minute."
          : "Creators find builders through their profile. It takes a minute."
      }
      action={
        <Button asChild size="sm">
          <Link href={href}>Set up your {role} profile</Link>
        </Button>
      }
    />
  )
}

function CreatorSection({ data }: { data: Awaited<ReturnType<typeof creatorProfilePageData>> }) {
  return (
    <section aria-labelledby="creator-profile-heading" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 id="creator-profile-heading" className="text-lg font-semibold">
            Creator profile
          </h2>
          <p className="text-sm text-muted-foreground">
            Your audience summary is edited on the{" "}
            <Link href="/app/audience" className="font-medium text-foreground underline">
              Audience
            </Link>{" "}
            page.
          </p>
        </div>
        {data.exists ? <ViewPublicLink href={`/c/${data.defaults.handle}`} /> : null}
      </div>
      {data.exists ? (
        <CreatorProfileForm
          source="settings"
          defaults={data.defaults}
          countries={countryOptions()}
          languages={languageOptions()}
        />
      ) : (
        <MissingProfile role="creator" />
      )}
    </section>
  )
}

function BuilderSection({
  data,
  items,
}: {
  data: Awaited<ReturnType<typeof builderProfilePageData>>
  items: Awaited<ReturnType<typeof portfolioPageItems>>
}) {
  return (
    <section aria-labelledby="builder-profile-heading" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="builder-profile-heading" className="text-lg font-semibold">
          Builder profile
        </h2>
        {data.exists ? <ViewPublicLink href={`/b/${data.defaults.handle}`} /> : null}
      </div>
      {data.exists ? (
        <>
          <BuilderProfileForm source="settings" defaults={data.defaults} />
          <div className="space-y-3 border-t pt-6">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Portfolio</h3>
              <p className="text-sm text-muted-foreground">
                Projects on your public profile. Your GitHub stats come from{" "}
                <Link
                  href="/app/settings/connections"
                  className="font-medium text-foreground underline"
                >
                  Connections
                </Link>
                .
              </p>
            </div>
            <PortfolioManager items={items} source="settings" headingLevel="h4" />
          </div>
        </>
      ) : (
        <MissingProfile role="builder" />
      )}
    </section>
  )
}
