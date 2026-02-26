import { createBrowserClient as createSupaBrowserClient } from "@supabase/ssr";
import { createServerClient as createSupaServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    if (typeof window !== "undefined") {
      console.warn("Missing NEXT_PUBLIC_SUPABASE_URL — Supabase features disabled");
    }
    return "";
  }
  return url;
}

function getSupabaseAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    if (typeof window !== "undefined") {
      console.warn("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY — Supabase features disabled");
    }
    return "";
  }
  return key;
}

/** Returns true if Supabase env vars are configured. */
export function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

// ---------------------------------------------------------------------------
// Browser client — for Client Components
// ---------------------------------------------------------------------------

export function createBrowserClient(): SupabaseClient {
  return createSupaBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
}

// ---------------------------------------------------------------------------
// Server client — for Server Components / Route Handlers
// ---------------------------------------------------------------------------

export async function createServerClient(): Promise<SupabaseClient> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();

  return createSupaServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // setAll can fail in Server Components where cookies are read-only.
          // This is expected — middleware or Route Handlers handle writes.
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Types — derived from Supabase migration schema (15 tables)
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Company = {
  id: string;
  name: string;
  industry: string | null;
  business_type: string | null;
  status: string;
  authority_level: string;
  ghost_mode_until: string | null;
  agent_name: string | null;
  config: Json;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type AgentStatus = {
  id: string;
  company_id: string;
  agent_name: string;
  status: string;
  current_task: string | null;
  last_run: string | null;
  error_message: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type Automation = {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  domain: string | null;
  status: string;
  deployment_id: string | null;
  script: string | null;
  expected_behavior: string | null;
  sandbox_result: Json | null;
  shadow_result: Json | null;
  canary_result: Json | null;
  schedule: string | null;
  last_run: string | null;
  run_count: number;
  success_count: number;
  failure_count: number;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type Event = {
  id: string;
  company_id: string;
  event_type: string;
  agent_name: string | null;
  message: string;
  severity: string;
  metadata: Json;
  created_at: string;
};

export type Message = {
  id: string;
  company_id: string;
  sender: string;
  content: string;
  message_type: string;
  metadata: Json;
  read: boolean;
  created_at: string;
};

export type Knowledge = {
  id: string;
  company_id: string;
  category: string;
  title: string;
  content: string;
  source: string | null;
  tags: string[];
  relevance_score: number;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type Decision = {
  id: string;
  company_id: string;
  agent_name: string;
  question: string;
  option_a: string;
  option_b: string;
  context: string | null;
  risk_level: string;
  resolution: string | null;
  resolved_at: string | null;
  expires_at: string | null;
  metadata: Json;
  created_at: string;
};

export type PlaybookEntry = {
  id: string;
  company_id: string;
  agent_name: string;
  task: string;
  description: string | null;
  action_taken: string | null;
  outcome: string | null;
  success: boolean;
  notes: string | null;
  similarity_tags: string[];
  run_count: number;
  last_used: string;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type Correction = {
  id: string;
  company_id: string;
  agent_name: string;
  original_action: string | null;
  correction_text: string;
  corrected_action: string | null;
  category: string;
  severity: string;
  applied: boolean;
  applied_at: string | null;
  tags: string[];
  metadata: Json;
  created_at: string;
};

export type ResearchSource = {
  id: string;
  company_id: string;
  title: string;
  authors: string | null;
  source_type: string | null;
  url: string | null;
  publication: string | null;
  year: number | null;
  relevance_score: number;
  quality_score: number;
  summary: string | null;
  key_insights: Json;
  applicable_processes: Json;
  metadata: Json;
  created_at: string;
};

export type ResearchInsight = {
  id: string;
  company_id: string;
  source_id: string | null;
  insight: string;
  category: string | null;
  actionability: string;
  applied: boolean;
  how_to_apply: string | null;
  metadata: Json;
  created_at: string;
};

export type BrainState = {
  id: string;
  company_id: string;
  state: Json;
  checkpoint_reason: string | null;
  created_at: string;
};

export type GhostReport = {
  id: string;
  company_id: string;
  report_date: string;
  observed_processes: Json;
  would_have_automated: Json;
  estimated_hours_saved: number;
  estimated_tasks_automated: number;
  key_observations: Json;
  metadata: Json;
  created_at: string;
};

export type Metric = {
  id: string;
  company_id: string;
  metric_name: string;
  metric_value: number;
  metric_date: string;
  tags: Json;
  created_at: string;
};

export type CrossCompanyPattern = {
  id: string;
  company_id: string;
  pattern_type: string;
  industry: string | null;
  business_type: string | null;
  description: string;
  frequency: number;
  success_rate: number | null;
  anonymized: boolean;
  metadata: Json;
  created_at: string;
};
