import { AlertTriangle, Brain } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { ModelSwitchButton, TrainModelButton } from "@/components/matching-admin/model-actions"
import {
  CalibrationTable,
  CoefficientsTable,
  ComparisonTable,
  ScoreFunnelTable,
  SectionCard,
} from "@/components/matching-admin/tables"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { canManageMatchingModels } from "@/lib/auth/authz"
import { authorizePage, requireAdmin } from "@/lib/auth/session"
import { getDb } from "@/lib/db/client"
import { env } from "@/lib/env"
import {
  countCompletedLaunches,
  loadActiveMatchingConfig,
  MIN_COMPLETED_LAUNCHES_FOR_V1,
  V0_MODEL_VERSION,
} from "@/lib/matching/config"
import { scoreBucketFunnel } from "@/lib/matching/v1/funnel"
import { listModelVersions, type ModelVersionView } from "@/lib/matching/v1/queries"
import { MIN_ACCEPTED_POSITIVES } from "@/lib/matching/v1/train-core"
import { formatExact } from "@/lib/proposals/display"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Matching" }

type Props = { searchParams: Promise<{ version?: string | string[]; funnel?: string | string[] }> }

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function chipClass(active: boolean): string {
  return cn(
    "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-8 sm:px-3",
    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
    active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
  )
}

function hrefWith(params: { version?: string; funnel?: string }): string {
  const search = new URLSearchParams()
  if (params.version) search.set("version", params.version)
  if (params.funnel) search.set("funnel", params.funnel)
  const query = search.toString()
  return query ? `/admin/matching?${query}` : "/admin/matching"
}

/**
 * `/admin/matching` (§8 v1, §12 v1; CLAUDE.md §19.38, §19.42): which model ranks and why, train a
 * v1 model, compare it with v0 on held-out data (AUC, log loss, calibration by decile, sample
 * sizes), activate or deactivate it (audited), and the Phase 7 acceptance view: funnel conversion
 * by match-score bucket.
 */
export default async function AdminMatchingPage({ searchParams }: Props) {
  const user = await requireAdmin()
  authorizePage(canManageMatchingModels(user), "/admin")
  const params = await searchParams
  const db = getDb()

  const [versions, ranking, completedLaunches] = await Promise.all([
    listModelVersions(db),
    loadActiveMatchingConfig(db),
    countCompletedLaunches(db),
  ])
  const trained = versions.filter((version) => version.kind === "logistic")
  const requestedVersion = single(params.version)
  const selected: ModelVersionView | undefined =
    trained.find((version) => version.modelVersion === requestedVersion) ?? trained[0]
  const funnelVersions = versions.map((version) => version.modelVersion)
  const requestedFunnel = single(params.funnel)
  const funnelVersion =
    requestedFunnel && funnelVersions.includes(requestedFunnel) ? requestedFunnel : V0_MODEL_VERSION
  const funnel = await scoreBucketFunnel(db, funnelVersion)

  const gateMet = completedLaunches >= MIN_COMPLETED_LAUNCHES_FOR_V1
  const gateNote = gateMet
    ? null
    : env.MATCHING_V1_FORCE
      ? `Only ${completedLaunches} of ${MIN_COMPLETED_LAUNCHES_FOR_V1} completed launches exist; MATCHING_V1_FORCE lets v1 rank anyway (never in production).`
      : `Only ${completedLaunches} of ${MIN_COMPLETED_LAUNCHES_FOR_V1} completed launches exist. A v1 version can be marked active, but v0 keeps ranking until ${MIN_COMPLETED_LAUNCHES_FOR_V1} launches went live.`
  const thinHoldout =
    selected?.metrics &&
    selected.metrics.targets.accepted.holdout.positives < MIN_ACCEPTED_POSITIVES

  return (
    <div className="space-y-6">
      <PageHeader
        title="Matching"
        description="Which model ranks matches, how v1 compares with v0 on held-out data, and how each score bucket converts."
        actions={<TrainModelButton />}
      />

      <SectionCard title="Ranking now">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Ranking with</dt>
            <dd className="text-lg font-semibold" data-testid="ranking-version">
              {ranking.modelVersion}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Active version</dt>
            <dd className="text-lg font-semibold">
              {versions.find((version) => version.active)?.modelVersion ?? "none"}
              {env.MATCHING_MODEL_VERSION ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  Pinned by MATCHING_MODEL_VERSION={env.MATCHING_MODEL_VERSION}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Completed launches</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {completedLaunches} / {MIN_COMPLETED_LAUNCHES_FOR_V1}
            </dd>
          </div>
        </dl>
        {ranking.fallbackReason ? (
          <p className="mt-4 text-sm text-muted-foreground">{ranking.fallbackReason}</p>
        ) : null}
      </SectionCard>

      {!gateMet || thinHoldout ? (
        <Alert>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Not much data yet</AlertTitle>
          <AlertDescription>
            {gateNote ? <p>{gateNote}</p> : null}
            {thinHoldout ? (
              <p>
                The held-out data has fewer than {MIN_ACCEPTED_POSITIVES} accepted matches, so the
                comparison below is noisy.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <SectionCard
        title="Model versions"
        description="Trained versions are stored inactive. Activating one is written to the audit log."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Trained</TableHead>
              <TableHead className="text-right">Training rows</TableHead>
              <TableHead className="text-right">AUC v1 / v0</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version) => (
              <TableRow key={version.id} data-version={version.modelVersion}>
                <TableCell className="font-medium whitespace-nowrap">
                  {version.kind === "logistic" ? (
                    <Link
                      href={hrefWith({ version: version.modelVersion, funnel: requestedFunnel })}
                      className="underline-offset-4 hover:underline"
                    >
                      {version.modelVersion}
                    </Link>
                  ) : (
                    version.modelVersion
                  )}
                  {version.active ? (
                    <Badge className="ml-2" variant="secondary">
                      Active
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{version.kind === "logistic" ? "Logistic (v1)" : "Weighted"}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {version.trainedAt ? formatExact(version.trainedAt) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {version.metrics?.rows.training ?? "—"}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {version.metrics
                    ? `${version.metrics.targets.accepted.v1?.auc?.toFixed(3) ?? "—"} / ${version.metrics.targets.accepted.v0.auc?.toFixed(3) ?? "—"}`
                    : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {version.active && version.modelVersion !== V0_MODEL_VERSION ? (
                    <ModelSwitchButton
                      modelVersion={version.modelVersion}
                      mode="deactivate"
                      gateNote={null}
                    />
                  ) : !version.active ? (
                    <ModelSwitchButton
                      modelVersion={version.modelVersion}
                      mode="activate"
                      gateNote={version.kind === "logistic" ? gateNote : null}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      {selected?.metrics ? (
        <>
          <SectionCard
            id="comparison"
            title={`${selected.modelVersion} against v0`}
            description={`Trained on ${selected.metrics.rows.training} ${selected.metrics.sourceVersion} matches, evaluated on ${selected.metrics.rows.holdout} held out. ${selected.metrics.rows.excludedPositives} positives were left out because no feature vector from before their proposal exists. L2 λ = ${selected.metrics.l2}.`}
          >
            <ComparisonTable metrics={selected.metrics} />
          </SectionCard>
          <SectionCard
            title="Calibration by decile"
            description="Proposal accepted, held-out rows."
          >
            <CalibrationTable
              v1={selected.metrics.targets.accepted.v1}
              v0={selected.metrics.targets.accepted.v0}
            />
          </SectionCard>
          <SectionCard
            title="What v1 learned"
            description="The ranking model: P(proposal accepted)."
          >
            <CoefficientsTable version={selected} />
          </SectionCard>
        </>
      ) : (
        <SectionCard title="v1 against v0">
          <EmptyState
            icon={Brain}
            title="No v1 model yet"
            description="Train one to compare it with v0 on held-out matches. Training needs at least 20 accepted and 20 not accepted matches."
          />
        </SectionCard>
      )}

      <SectionCard
        id="funnel"
        title="Funnel by match score"
        description="How shown matches convert: a linked proposal, accepted, a launch that went live, and at least one sale."
      >
        {funnelVersions.length > 1 ? (
          <nav aria-label="Model version for the funnel" className="-mx-4 mb-4 sm:mx-0">
            <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 sm:px-0">
              {funnelVersions.map((version) => (
                <li key={version} className="shrink-0">
                  <Link
                    href={hrefWith({ version: requestedVersion, funnel: version })}
                    aria-current={version === funnelVersion ? "page" : undefined}
                    className={chipClass(version === funnelVersion)}
                  >
                    {version}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <ScoreFunnelTable funnel={funnel} />
      </SectionCard>
    </div>
  )
}
