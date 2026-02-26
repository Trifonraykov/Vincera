"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { ResearchSource, ResearchInsight } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceWithInsights extends ResearchSource {
  insights: ResearchInsight[];
}

export interface UseResearchReturn {
  sources: SourceWithInsights[];
  totalSources: number;
  totalInsights: number;
  appliedInsights: number;
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useResearch(companyId: string | null): UseResearchReturn {
  const [rawSources, setRawSources] = useState<ResearchSource[]>([]);
  const [rawInsights, setRawInsights] = useState<ResearchInsight[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const supabaseRef = useRef<SupabaseClient | null>(null);

  function getSupabase(): SupabaseClient {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient();
    }
    return supabaseRef.current;
  }

  useEffect(() => {
    if (!companyId || !isSupabaseConfigured()) {
      setRawSources([]);
      setRawInsights([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchResearch() {
      const [sourcesRes, insightsRes] = await Promise.all([
        supabase
          .from("research_sources")
          .select("*")
          .eq("company_id", companyId)
          .order("relevance_score", { ascending: false }),
        supabase
          .from("research_insights")
          .select("*")
          .eq("company_id", companyId),
      ]);

      if (sourcesRes.data) setRawSources(sourcesRes.data as ResearchSource[]);
      if (insightsRes.data)
        setRawInsights(insightsRes.data as ResearchInsight[]);
      setIsLoading(false);
    }

    fetchResearch();
  }, [companyId]);

  const sources = useMemo<SourceWithInsights[]>(() => {
    const bySource: Record<string, ResearchInsight[]> = {};
    for (const ins of rawInsights) {
      const key = ins.source_id ?? "__orphan";
      if (!bySource[key]) bySource[key] = [];
      bySource[key].push(ins);
    }
    return rawSources.map((s) => ({
      ...s,
      insights: bySource[s.id] ?? [],
    }));
  }, [rawSources, rawInsights]);

  const totalSources = sources.length;
  const totalInsights = rawInsights.length;
  const appliedInsights = rawInsights.filter((i) => i.applied).length;

  return { sources, totalSources, totalInsights, appliedInsights, isLoading };
}
