-- 010: research_sources and research_insights tables
-- Research data collected by the research agent.

CREATE TABLE IF NOT EXISTS research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  authors TEXT,
  source_type TEXT,  -- academic_paper, industry_report, case_study, best_practice_guide
  url TEXT,
  publication TEXT,
  year INTEGER,
  relevance_score FLOAT DEFAULT 0.5,
  quality_score FLOAT DEFAULT 0.5,
  summary TEXT,
  key_insights JSONB DEFAULT '[]',
  applicable_processes JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id UUID REFERENCES research_sources(id) ON DELETE SET NULL,
  insight TEXT NOT NULL,
  category TEXT,  -- operations, finance, hr, sales, supply_chain, customer_service, marketing, compliance, it
  actionability TEXT DEFAULT 'informational',  -- immediately_actionable, strategic, informational
  applied BOOLEAN DEFAULT FALSE,
  how_to_apply TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
