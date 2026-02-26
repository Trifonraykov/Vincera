-- 006: knowledge table
-- Accumulated knowledge about the company's operations.

CREATE TABLE IF NOT EXISTS knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,  -- process, tool, integration, business_rule, discovery
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,  -- which agent or process created this
  tags TEXT[] DEFAULT '{}',
  relevance_score FLOAT DEFAULT 0.5,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
