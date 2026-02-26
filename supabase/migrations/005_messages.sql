-- 005: messages table
-- Core communication channel between dashboard and agents.
-- Dashboard subscribes via Supabase Realtime for sender != 'user'.
-- Agent polls for sender = 'user' messages.

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,  -- 'user', 'orchestrator', 'builder', 'system', etc.
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'chat',  -- chat, system, command, correction, decision_request, decision_response
  metadata JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
