-- 009: corrections table
-- User corrections to agent behaviour, used by the trainer.

CREATE TABLE IF NOT EXISTS corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  original_action TEXT,
  correction_text TEXT NOT NULL,
  corrected_action TEXT,
  category TEXT DEFAULT 'other',  -- output_format, logic_error, wrong_data, wrong_approach, tone, scope, other
  severity TEXT DEFAULT 'moderate',  -- minor, moderate, major, critical
  applied BOOLEAN DEFAULT FALSE,
  applied_at TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
