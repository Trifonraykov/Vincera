import type { ReactNode } from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MATCH_FEATURES, type MatchingTarget } from "@/lib/db/schema/types"
import { FEATURE_LABELS } from "@/lib/matching/explanation-text"
import type { FunnelBucket, ScoreFunnel } from "@/lib/matching/v1/funnel"
import type { EvaluationMetrics } from "@/lib/matching/v1/metrics"
import type { ModelVersionView } from "@/lib/matching/v1/queries"
import type { V1Metrics } from "@/lib/matching/v1/train-core"
import { cn } from "@/lib/utils"

/**
 * `/admin/matching` read-only blocks (CLAUDE.md §19.42): the v1 vs v0 comparison, calibration by
 * decile, the coefficients and the funnel by match-score bucket. Server components; every table
 * scrolls sideways inside its own box on phones (§19.20).
 */

const TARGET_LABELS: Record<MatchingTarget, string> = {
  accepted: "Proposal accepted",
  sale: "Launch made ≥ 1 sale",
}

function decimal(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits)
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`
}

function countWithRate(count: number, previous: number) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {count.toLocaleString("en")}
      <span className="ml-1 text-xs text-muted-foreground">
        ({previous > 0 ? percent(count / previous) : "—"})
      </span>
    </span>
  )
}

function Better({
  v1,
  v0,
  lowerIsBetter,
}: {
  v1: number | null
  v0: number | null
  lowerIsBetter?: boolean
}) {
  if (v1 === null || v0 === null || v1 === v0) return null
  const better = lowerIsBetter ? v1 < v0 : v1 > v0
  return (
    <span
      className={cn(
        "ml-1 text-xs",
        better ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      {better ? "better" : "worse"}
    </span>
  )
}

export function ComparisonTable({ metrics }: { metrics: V1Metrics }) {
  return (
    <Table>
      <TableCaption>
        Held-out rows ({metrics.holdoutRule}). v0&apos;s score is read as a probability, so its log
        loss and calibration are uncalibrated.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Outcome</TableHead>
          <TableHead className="text-right">Held-out rows</TableHead>
          <TableHead className="text-right">Positives</TableHead>
          <TableHead className="text-right">AUC v1</TableHead>
          <TableHead className="text-right">AUC v0</TableHead>
          <TableHead className="text-right">Log loss v1</TableHead>
          <TableHead className="text-right">Log loss v0</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(["accepted", "sale"] as const).map((target) => {
          const entry = metrics.targets[target]
          return (
            <TableRow key={target} data-target={target}>
              <TableHead scope="row" className="font-medium">
                {TARGET_LABELS[target]}
                {entry.reason ? (
                  <p className="text-xs font-normal whitespace-normal text-muted-foreground">
                    {entry.reason}
                  </p>
                ) : null}
              </TableHead>
              <TableCell className="text-right tabular-nums">{entry.holdout.rows}</TableCell>
              <TableCell className="text-right tabular-nums">{entry.holdout.positives}</TableCell>
              <TableCell className="text-right tabular-nums" data-metric="auc-v1">
                {decimal(entry.v1?.auc)}
                <Better v1={entry.v1?.auc ?? null} v0={entry.v0.auc} />
              </TableCell>
              <TableCell className="text-right tabular-nums" data-metric="auc-v0">
                {decimal(entry.v0.auc)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {decimal(entry.v1?.logLoss)}
                <Better v1={entry.v1?.logLoss ?? null} v0={entry.v0.logLoss} lowerIsBetter />
              </TableCell>
              <TableCell className="text-right tabular-nums">{decimal(entry.v0.logLoss)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function CalibrationTable({
  v1,
  v0,
}: {
  v1: EvaluationMetrics | null
  v0: EvaluationMetrics
}) {
  const deciles = Array.from({ length: 10 }, (_, index) => index + 1)
  const v1By = new Map((v1?.calibration ?? []).map((bin) => [bin.decile, bin]))
  const v0By = new Map(v0.calibration.map((bin) => [bin.decile, bin]))
  return (
    <Table>
      <TableCaption>
        Held-out rows sorted by each model&apos;s prediction and cut into ten equal groups: a well
        ranked model has the observed rate rising from decile 1 to 10.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Decile</TableHead>
          <TableHead className="text-right">v1 predicted</TableHead>
          <TableHead className="text-right">v1 observed</TableHead>
          <TableHead className="text-right">v0 score</TableHead>
          <TableHead className="text-right">v0 observed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deciles.map((decile) => {
          const a = v1By.get(decile)
          const b = v0By.get(decile)
          if (!a && !b) return null
          return (
            <TableRow key={decile}>
              <TableCell className="tabular-nums">{decile}</TableCell>
              <TableCell className="text-right tabular-nums">
                {percent(a?.meanPredicted ?? null)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {a ? `${percent(a.observedRate)} of ${a.count}` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {percent(b?.meanPredicted ?? null)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {b ? `${percent(b.observedRate)} of ${b.count}` : "—"}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function CoefficientsTable({ version }: { version: ModelVersionView }) {
  return (
    <Table>
      <TableCaption>
        Coefficients are per standard deviation of the feature (log-odds). Explanation weights are
        the positive effects normalised to 1; explanations name the top two contributions.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Feature</TableHead>
          <TableHead className="text-right">Coefficient</TableHead>
          <TableHead className="text-right">Explanation weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {MATCH_FEATURES.map((feature) => (
          <TableRow key={feature}>
            <TableCell>{FEATURE_LABELS[feature]}</TableCell>
            <TableCell className="text-right tabular-nums">
              {decimal(version.coefficients?.[feature] ?? null)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {decimal(version.weights?.[feature] ?? null, 2)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function FunnelRow({ bucket, header }: { bucket: FunnelBucket; header?: boolean }) {
  return (
    <TableRow data-bucket={bucket.index}>
      <TableHead scope="row" className={cn("font-medium", header && "font-semibold")}>
        {bucket.label}
      </TableHead>
      <TableCell className="text-right tabular-nums">{bucket.shown.toLocaleString("en")}</TableCell>
      <TableCell className="text-right">{countWithRate(bucket.sent, bucket.shown)}</TableCell>
      <TableCell className="text-right">{countWithRate(bucket.accepted, bucket.sent)}</TableCell>
      <TableCell className="text-right">{countWithRate(bucket.live, bucket.accepted)}</TableCell>
      <TableCell className="text-right">{countWithRate(bucket.sale, bucket.live)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {bucket.shown > 0 ? percent(bucket.sale / bucket.shown) : "—"}
      </TableCell>
    </TableRow>
  )
}

export function ScoreFunnelTable({ funnel }: { funnel: ScoreFunnel }) {
  return (
    <Table aria-label={`Funnel by match score, ${funnel.modelVersion}`}>
      <TableCaption>
        Shown matches of {funnel.modelVersion} by their score. Each step&apos;s rate is against the
        step before it; the last column is shown to sale.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Score</TableHead>
          <TableHead className="text-right">Shown</TableHead>
          <TableHead className="text-right">Proposal sent</TableHead>
          <TableHead className="text-right">Accepted</TableHead>
          <TableHead className="text-right">Launch live</TableHead>
          <TableHead className="text-right">≥ 1 sale</TableHead>
          <TableHead className="text-right">Shown → sale</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {funnel.buckets.map((bucket) => (
          <FunnelRow key={bucket.index} bucket={bucket} />
        ))}
      </TableBody>
      <TableFooter>
        <FunnelRow bucket={funnel.total} header />
      </TableFooter>
    </Table>
  )
}

export function SectionCard({
  id,
  title,
  description,
  children,
}: {
  id?: string
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card id={id} className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  )
}
