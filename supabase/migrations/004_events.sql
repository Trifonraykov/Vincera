-- 004: events table
-- Append-only log of everything that happens.

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- action, error, decision, deployment, system
  agent_name TEXT,
  message TEXT NOT NULL,
  severity TEXT DEFAULT 'info',  -- debug, info, warning, error, critical
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
