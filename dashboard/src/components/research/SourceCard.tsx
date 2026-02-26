"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { cardEntrance } from "@/lib/animations";
import { cn } from "@/lib/utils";
import type { SourceWithInsights } from "@/hooks/useResearch";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SourceCardProps {
  source: SourceWithInsights;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeEmoji(t: string | null): string {
  switch (t) {
    case "academic":
      return "\uD83D\uDCC4";
    case "industry":
      return "\uD83C\uDFE2";
    case "case_study":
      return "\uD83D\uDCCB";
    default:
      return "\uD83D\uDCDD";
  }
}

function typeLabel(t: string | null): string {
  switch (t) {
    case "academic":
      return "Academic";
    case "industry":
      return "Industry";
    case "case_study":
      return "Case Study";
    default:
      return t ?? "Other";
  }
}

function Stars({ score }: { score: number }) {
  const filled = Math.round(score * 5);
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "text-xs",
            i < filled ? "text-accent" : "text-text-muted/30"
          )}
        >
          ★
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SourceCard({
  source,
  isExpanded,
  onToggleExpand,
}: SourceCardProps) {
  const insightCount = source.insights.length;
  const hasUrl = source.url && source.url.trim().length > 0;

  // Build metadata string
  const metaParts: string[] = [];
  if (source.authors) metaParts.push(source.authors);
  if (source.year) metaParts.push(String(source.year));
  if (source.publication) metaParts.push(source.publication);
  const metaStr = metaParts.join(" \u00B7 ");

  return (
    <motion.div
      variants={cardEntrance}
      className="rounded-lg border border-border-primary bg-bg-surface p-5 transition-colors hover:border-border-hover"
    >
      {/* Row 1: type badge + title */}
      <div className="mb-1 flex items-start gap-2">
        <span className="shrink-0 rounded-full bg-bg-surface-raised px-2 py-0.5 font-mono text-[10px] text-text-muted">
          {typeEmoji(source.source_type)} {typeLabel(source.source_type)}
        </span>
      </div>
      <h3 className="mb-1 font-heading text-lg text-text-primary">
        {source.title}
      </h3>

      {/* Row 2: authors / year / publication */}
      {metaStr && (
        <p className="mb-2 font-body text-sm text-text-secondary">{metaStr}</p>
      )}

      {/* Row 3: quality + relevance */}
      <div className="mb-2 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Stars score={source.quality_score} />
          <span className="font-mono text-[10px] text-text-muted">quality</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 rounded-full bg-bg-primary">
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${Math.min(source.relevance_score * 100, 100)}%`,
              }}
            />
          </div>
          <span className="font-mono text-xs text-text-secondary">
            {source.relevance_score.toFixed(2)}
          </span>
          <span className="font-mono text-[10px] text-text-muted">
            relevance
          </span>
        </div>
      </div>

      {/* Row 4: summary */}
      {source.summary ? (
        <p
          className={cn(
            "mb-3 font-body text-sm text-text-muted",
            !isExpanded && "line-clamp-2"
          )}
        >
          {source.summary}
        </p>
      ) : (
        <p className="mb-3 font-body text-sm text-text-muted italic">
          No summary available.
        </p>
      )}

      {/* Row 5: expand toggle + view source */}
      <div className="flex items-center gap-4">
        {insightCount > 0 ? (
          <button
            onClick={onToggleExpand}
            className="flex items-center gap-1 font-body text-xs text-text-secondary transition-colors hover:text-text-primary"
          >
            {isExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {insightCount} {insightCount === 1 ? "insight" : "insights"}
          </button>
        ) : (
          <span className="font-body text-xs text-text-muted italic">
            No insights extracted
          </span>
        )}
        {hasUrl && (
          <a
            href={source.url!}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-body text-xs text-accent transition-colors hover:underline"
          >
            View source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Expanded: insights */}
      <AnimatePresence>
        {isExpanded && insightCount > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.33, 1, 0.68, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-4 border-t border-border-primary pt-3">
              <p className="mb-2 font-body text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                Insights
              </p>
              <div className="space-y-2">
                {source.insights.map((ins) => (
                  <div
                    key={ins.id}
                    className="flex items-start gap-3 rounded-md px-2 py-1.5"
                  >
                    <span
                      className={cn(
                        "mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full",
                        ins.applied ? "bg-accent" : "bg-text-muted/40"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "font-body text-sm",
                          ins.applied
                            ? "text-text-secondary"
                            : "text-text-muted"
                        )}
                      >
                        {ins.insight}
                      </p>
                      {ins.how_to_apply && (
                        <p className="mt-0.5 font-body text-xs text-text-muted italic">
                          {ins.how_to_apply}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {ins.category && (
                        <span className="font-mono text-[10px] text-text-muted">
                          {ins.category}
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                          ins.applied
                            ? "bg-accent/10 text-accent"
                            : "bg-bg-surface-raised text-text-muted"
                        )}
                      >
                        {ins.applied ? "applied" : "pending"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
