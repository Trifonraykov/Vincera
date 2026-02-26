-- 017: Helper functions and triggers.

-- ============================================================
-- Auto-update updated_at timestamp
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables that have an updated_at column
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'companies', 'agent_statuses', 'automations', 'knowledge',
    'playbook_entries'
  ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trigger_updated_at ON %I', t
    );
    EXECUTE format(
      'CREATE TRIGGER trigger_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================
-- Increment metric (upsert pattern)
-- ============================================================

CREATE OR REPLACE FUNCTION increment_metric(
  p_company_id UUID,
  p_metric_name TEXT,
  p_increment FLOAT DEFAULT 1,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO metrics (company_id, metric_name, metric_value, metric_date)
  VALUES (p_company_id, p_metric_name, p_increment, p_date)
  ON CONFLICT (company_id, metric_name, metric_date)
  DO UPDATE SET metric_value = metrics.metric_value + p_increment;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Clean old events (retention policy — keep 90 days)
-- ============================================================

CREATE OR REPLACE FUNCTION clean_old_events(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM events WHERE created_at < now() - (days_to_keep || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Get latest brain state for a company
-- ============================================================

CREATE OR REPLACE FUNCTION get_latest_brain_state(p_company_id UUID)
RETURNS JSONB AS $$
  SELECT state FROM brain_states
  WHERE company_id = p_company_id
  ORDER BY created_at DESC LIMIT 1;
$$ LANGUAGE sql;
