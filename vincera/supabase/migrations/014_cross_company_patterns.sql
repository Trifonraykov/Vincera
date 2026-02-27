-- 014: cross_company_patterns table
-- Anonymised patterns shared across Vincera deployments.

CREATE TABLE IF NOT EXISTS cross_company_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,  -- automation_success, common_pain_point, best_practice
  industry TEXT,
  business_type TEXT,
  description TEXT NOT NULL,
  frequency INTEGER DEFAULT 1,
  success_rate FLOAT,
  anonymized BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
