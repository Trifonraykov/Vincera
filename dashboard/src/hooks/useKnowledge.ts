"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Knowledge } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseKnowledgeReturn {
  entries: Knowledge[];
  categories: string[];
  isLoading: boolean;
  editContent: (
    id: string,
    title: string,
    oldContent: string,
    newContent: string
  ) => Promise<void>;
}

export function useKnowledge(companyId: string | null): UseKnowledgeReturn {
  const [entries, setEntries] = useState<Knowledge[]>([]);
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
      setEntries([]);
      setIsLoading(false);
      return;
    }

    const supabase = getSupabase();

    async function fetchKnowledge() {
      const { data } = await supabase
        .from("company_knowledge")
        .select("*")
        .eq("company_id", companyId)
        .order("relevance_score", { ascending: false });

      if (data) {
        setEntries(data as Knowledge[]);
      }
      setIsLoading(false);
    }

    fetchKnowledge();
  }, [companyId]);

  const categories = useMemo(() => {
    const unique = new Set(entries.map((e) => e.category));
    return Array.from(unique).sort();
  }, [entries]);

  const editContent = useCallback(
    async (
      id: string,
      title: string,
      oldContent: string,
      newContent: string
    ) => {
      if (!companyId || !isSupabaseConfigured()) return;
      const supabase = getSupabase();

      // Optimistic
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, content: newContent, source: "user" } : e
        )
      );

      await supabase
        .from("company_knowledge")
        .update({ content: newContent, source: "user" })
        .eq("id", id);

      await supabase.from("corrections").insert({
        company_id: companyId,
        agent_name: "user",
        original_action: JSON.stringify({
          title,
          old_content: oldContent,
        }),
        correction_text: `User corrected knowledge: ${title}`,
        corrected_action: JSON.stringify({
          title,
          new_content: newContent,
        }),
        category: "knowledge_corrected",
        severity: "low",
        applied: true,
        applied_at: new Date().toISOString(),
        tags: ["knowledge"],
      });

      await supabase.from("events").insert({
        company_id: companyId,
        event_type: "knowledge_edited",
        agent_name: "user",
        message: `Knowledge entry edited: ${title}`,
        severity: "info",
      });
    },
    [companyId]
  );

  return { entries, categories, isLoading, editContent };
}
