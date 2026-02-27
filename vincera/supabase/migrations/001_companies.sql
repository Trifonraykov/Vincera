-- 001: companies table
-- Central registry of companies using Vincera.

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  industry TEXT,
  business_type TEXT,
  status TEXT NOT NULL DEFAULT 'installing',  -- installing, ghost, active, paused
  authority_level TEXT NOT NULL DEFAULT 'ask_risky',  -- observer, suggest, ask_always, ask_risky, ask_high_only, autonomous
  ghost_mode_until TIMESTAMPTZ,
  agent_name TEXT,
  config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
