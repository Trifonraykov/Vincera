-- 012: ghost_reports table
-- Daily observation reports generated during ghost mode.

CREATE TABLE IF NOT EXISTS ghost_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  observed_processes JSONB DEFAULT '[]',
  would_have_automated JSONB DEFAULT '[]',
  estimated_hours_saved FLOAT DEFAULT 0,
  estimated_tasks_automated INTEGER DEFAULT 0,
  key_observations JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
