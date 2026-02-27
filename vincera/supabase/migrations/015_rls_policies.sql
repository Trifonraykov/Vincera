-- 015: Row Level Security policies for all tables.
-- Service role bypasses RLS automatically in Supabase.
-- These policies govern authenticated dashboard users.
-- Convention: company_id = auth.uid()::uuid maps user to company.

-- ============================================================
-- Enable RLS on all tables
-- ============================================================

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbook_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghost_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_company_patterns ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Helper: wraps policy creation to be idempotent on PG < 15
-- ============================================================

-- companies — users read own company
DO $$ BEGIN
  CREATE POLICY "companies_select" ON companies
    FOR SELECT USING (id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "companies_update" ON companies
    FOR UPDATE USING (id = auth.uid()::uuid)
    WITH CHECK (id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- agent_statuses
DO $$ BEGIN
  CREATE POLICY "agent_statuses_select" ON agent_statuses
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "agent_statuses_insert" ON agent_statuses
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "agent_statuses_update" ON agent_statuses
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- automations
DO $$ BEGIN
  CREATE POLICY "automations_select" ON automations
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "automations_insert" ON automations
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "automations_update" ON automations
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- events
DO $$ BEGIN
  CREATE POLICY "events_select" ON events
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "events_insert" ON events
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "events_update" ON events
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- messages — users can read, send (as 'user'), and delete own messages
DO $$ BEGIN
  CREATE POLICY "messages_select" ON messages
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "messages_insert" ON messages
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid AND sender = 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "messages_update" ON messages
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "messages_delete" ON messages
    FOR DELETE USING (company_id = auth.uid()::uuid AND sender = 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- knowledge
DO $$ BEGIN
  CREATE POLICY "knowledge_select" ON knowledge
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "knowledge_insert" ON knowledge
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "knowledge_update" ON knowledge
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- decisions — users can read, and resolve (update) own decisions
DO $$ BEGIN
  CREATE POLICY "decisions_select" ON decisions
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "decisions_insert" ON decisions
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "decisions_update" ON decisions
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- playbook_entries
DO $$ BEGIN
  CREATE POLICY "playbook_entries_select" ON playbook_entries
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "playbook_entries_insert" ON playbook_entries
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "playbook_entries_update" ON playbook_entries
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- corrections
DO $$ BEGIN
  CREATE POLICY "corrections_select" ON corrections
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "corrections_insert" ON corrections
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "corrections_update" ON corrections
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- research_sources
DO $$ BEGIN
  CREATE POLICY "research_sources_select" ON research_sources
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "research_sources_insert" ON research_sources
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "research_sources_update" ON research_sources
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- research_insights
DO $$ BEGIN
  CREATE POLICY "research_insights_select" ON research_insights
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "research_insights_insert" ON research_insights
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "research_insights_update" ON research_insights
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- brain_states
DO $$ BEGIN
  CREATE POLICY "brain_states_select" ON brain_states
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "brain_states_insert" ON brain_states
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "brain_states_update" ON brain_states
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ghost_reports
DO $$ BEGIN
  CREATE POLICY "ghost_reports_select" ON ghost_reports
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "ghost_reports_insert" ON ghost_reports
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "ghost_reports_update" ON ghost_reports
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- metrics
DO $$ BEGIN
  CREATE POLICY "metrics_select" ON metrics
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "metrics_insert" ON metrics
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "metrics_update" ON metrics
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- cross_company_patterns
DO $$ BEGIN
  CREATE POLICY "cross_company_patterns_select" ON cross_company_patterns
    FOR SELECT USING (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "cross_company_patterns_insert" ON cross_company_patterns
    FOR INSERT WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "cross_company_patterns_update" ON cross_company_patterns
    FOR UPDATE USING (company_id = auth.uid()::uuid)
    WITH CHECK (company_id = auth.uid()::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
