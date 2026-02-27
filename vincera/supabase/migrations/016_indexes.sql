-- 016: Performance indexes for common query patterns.

-- Messages: poll for new messages by company + timestamp
CREATE INDEX IF NOT EXISTS idx_messages_company_created ON messages(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_company_sender ON messages(company_id, sender);

-- Events: query by company + type + time
CREATE INDEX IF NOT EXISTS idx_events_company_type ON events(company_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_company_created ON events(company_id, created_at DESC);

-- Automations: query by company + status
CREATE INDEX IF NOT EXISTS idx_automations_company_status ON automations(company_id, status);

-- Decisions: poll for pending decisions
CREATE INDEX IF NOT EXISTS idx_decisions_company_pending ON decisions(company_id, resolution) WHERE resolution IS NULL;

-- Agent statuses: lookup by company + agent
CREATE INDEX IF NOT EXISTS idx_agent_statuses_company_agent ON agent_statuses(company_id, agent_name);

-- Playbook: query by company + agent + tags
CREATE INDEX IF NOT EXISTS idx_playbook_company_agent ON playbook_entries(company_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_playbook_tags ON playbook_entries USING GIN(similarity_tags);

-- Corrections: query unapplied
CREATE INDEX IF NOT EXISTS idx_corrections_company_unapplied ON corrections(company_id, applied) WHERE applied = FALSE;

-- Knowledge: query by company + category
CREATE INDEX IF NOT EXISTS idx_knowledge_company_category ON knowledge(company_id, category);
CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge USING GIN(tags);

-- Brain states: get latest
CREATE INDEX IF NOT EXISTS idx_brain_states_company_created ON brain_states(company_id, created_at DESC);

-- Ghost reports: by company + date
CREATE INDEX IF NOT EXISTS idx_ghost_reports_company_date ON ghost_reports(company_id, report_date DESC);

-- Metrics: by company + name + date
CREATE INDEX IF NOT EXISTS idx_metrics_company_name_date ON metrics(company_id, metric_name, metric_date);

-- Research: by company
CREATE INDEX IF NOT EXISTS idx_research_sources_company ON research_sources(company_id);
CREATE INDEX IF NOT EXISTS idx_research_insights_company ON research_insights(company_id);

-- Cross-company patterns: by industry + type
CREATE INDEX IF NOT EXISTS idx_patterns_industry ON cross_company_patterns(industry, pattern_type);
