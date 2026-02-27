-- 003: automations table
-- Each automation Vincera discovers, builds, and operates.

CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  domain TEXT,  -- finance, sales, operations, etc.
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, sandbox, shadow, canary, full, rolled_back, failed
  deployment_id TEXT,
  script TEXT,
  expected_behavior TEXT,
  sandbox_result JSONB,
  shadow_result JSONB,
  canary_result JSONB,
  schedule TEXT,  -- cron expression or interval description
  last_run TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
