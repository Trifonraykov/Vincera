"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useKnowledge } from "@/hooks/useKnowledge";
import { cn } from "@/lib/utils";
import KnowledgeGraph from "@/components/knowledge/KnowledgeGraph";
import KnowledgeTable from "@/components/knowledge/KnowledgeTable";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KnowledgePage() {
  const { companyId, company } = useDashboard();
  const { entries, categories, isLoading, editContent } =
    useKnowledge(companyId);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  function handleGraphEntryClick(id: string) {
    setHighlightId(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(`knowledge-row-${id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setTimeout(() => setHighlightId(null), 3000);
  }

  // Filter entries
  const filtered = entries.filter((e) => {
    if (selectedCategory && e.category !== selectedCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q)
      );
    }
    return true;
  });

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
          Knowledge Base
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          What Vincera knows about your company
          {!isLoading && entries.length > 0 && (
            <span className="text-text-muted">
              {" "}
              &middot; {entries.length} entries across {categories.length}{" "}
              categories
            </span>
          )}
        </p>
      </div>

      {/* Knowledge Graph */}
      <KnowledgeGraph
        entries={entries}
        categories={categories}
        companyName={company?.name ?? null}
        onEntryClick={handleGraphEntryClick}
      />

      {/* Filters + Search */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {/* Category chips */}
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setSelectedCategory(null)}
            className={cn(
              "rounded-full px-3 py-1.5 font-body text-xs transition-colors",
              selectedCategory === null
                ? "bg-bg-surface-raised text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() =>
                setSelectedCategory(selectedCategory === cat ? null : cat)
              }
              className={cn(
                "rounded-full px-3 py-1.5 font-body text-xs transition-colors",
                selectedCategory === cat
                  ? "bg-bg-surface-raised text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search knowledge..."
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

      {/* Table */}
      {!isLoading && (
        <KnowledgeTable
          entries={filtered}
          highlightId={highlightId}
          onEdit={editContent}
        />
      )}
    </motion.div>
  );
}
