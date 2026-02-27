-- 011: brain_states table
-- Serialised orchestrator state snapshots for crash recovery.

CREATE TABLE IF NOT EXISTS brain_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  state JSONB NOT NULL,  -- full OrchestratorState serialized
  checkpoint_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
