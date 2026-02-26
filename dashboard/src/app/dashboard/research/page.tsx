"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Lightbulb, CheckCircle, Search, X } from "lucide-react";
import { pageTransition, staggerChildren, cardEntrance } from "@/lib/animations";
import { useNumberCountUp } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useResearch } from "@/hooks/useResearch";
import { cn } from "@/lib/utils";
import SourceCard from "@/components/research/SourceCard";

// ---------------------------------------------------------------------------
// Stat Card (inline — matches MetricCard pattern)
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const animated = useNumberCountUp(value, 1.2);
  return (
    <motion.div
      variants={cardEntrance}
      className="rounded-lg border border-border-primary bg-bg-surface p-4"
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-4 w-4 text-text-muted" />
        <span className="font-body text-xs text-text-muted">{label}</span>
      </div>
      <span className="font-mono text-3xl text-text-primary">{animated}</span>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Sort options
// ---------------------------------------------------------------------------

type SortBy = "relevance" | "quality" | "recent" | "title";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ResearchPage() {
  const { companyId } = useDashboard();
  const { sources, totalSources, totalInsights, appliedInsights, isLoading } =
    useResearch(companyId);

  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortBy>("relevance");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filter
  const filtered = sources.filter((s) => {
    if (filter !== "all" && s.source_type !== filter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        (s.authors?.toLowerCase().includes(q) ?? false) ||
        (s.summary?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "quality":
        return b.quality_score - a.quality_score;
      case "recent":
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      case "title":
        return a.title.localeCompare(b.title);
      default:
        return b.relevance_score - a.relevance_score;
    }
  });

  const FILTERS = [
    { key: "all", label: "All" },
    { key: "academic", label: "Academic" },
    { key: "industry", label: "Industry" },
    { key: "case_study", label: "Case Study" },
  ];

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-heading text-3xl font-semibold text-text-primary">
          Research Library
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          Sources studied to understand your business
        </p>
      </div>

      {/* Stat cards */}
      {!isLoading && (
        <motion.div
          variants={staggerChildren(0.08)}
          initial="hidden"
          animate="visible"
          className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
        >
          <StatCard label="Sources" value={totalSources} icon={BookOpen} />
          <StatCard label="Insights" value={totalInsights} icon={Lightbulb} />
          <StatCard
            label="Applied"
            value={appliedInsights}
            icon={CheckCircle}
          />
        </motion.div>
      )}

      {/* Filters + Sort + Search */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {/* Type filter chips */}
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full px-3 py-1.5 font-body text-xs transition-colors",
                filter === f.key
                  ? "bg-bg-surface-raised text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded-lg border border-border-primary bg-bg-surface px-3 py-1.5 font-body text-xs text-text-secondary focus:outline-none"
        >
          <option value="relevance">Sort: Relevance</option>
          <option value="quality">Sort: Quality</option>
          <option value="recent">Sort: Recent</option>
          <option value="title">Sort: Title</option>
        </select>

        {/* Search */}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sources..."
            className="rounded-lg border border-border-primary bg-bg-surface py-1.5 pl-8 pr-8 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading...</span>
        </div>
      )}

      {/* Source cards */}
      {!isLoading && sorted.length > 0 && (
        <motion.div
          variants={staggerChildren(0.06)}
          initial="hidden"
          animate="visible"
          className="space-y-4"
        >
          {sorted.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              isExpanded={expandedId === source.id}
              onToggleExpand={() =>
                setExpandedId(expandedId === source.id ? null : source.id)
              }
            />
          ))}
        </motion.div>
      )}

      {/* Empty */}
      {!isLoading && sorted.length === 0 && (
        <p className="py-12 text-center font-body text-sm text-text-muted italic">
          {sources.length === 0
            ? "No research sources yet. The Research Agent will study relevant sources for your business."
            : "No sources match your filters."}
        </p>
      )}
    </motion.div>
  );
}
