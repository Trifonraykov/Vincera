-- 008: playbook_entries table
-- Agent memory of what worked and what didn't.

CREATE TABLE IF NOT EXISTS playbook_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  task TEXT NOT NULL,
  description TEXT,
  action_taken TEXT,
  outcome TEXT,
  success BOOLEAN DEFAULT TRUE,
  notes TEXT,
  similarity_tags TEXT[] DEFAULT '{}',
  run_count INTEGER DEFAULT 1,
  last_used TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
