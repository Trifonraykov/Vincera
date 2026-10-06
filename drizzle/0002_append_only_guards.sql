-- Custom migration: enforce append-only tables at the database level (CLAUDE.md §4, §5, §11).
--
-- events, audience_snapshots, proposal_revisions, agreement_signatures, link_clicks and
-- admin_audit_log reject UPDATE, DELETE and TRUNCATE.
-- ledger_entries rejects DELETE and TRUNCATE, and UPDATE except setting transfer_id once
-- (NULL -> a transfer) when the payout job pays the entry out (§9).
-- GDPR erasure (§14): audience_snapshots rows may be deleted inside a transaction that ran
-- `SELECT set_config('app.gdpr_erasure', 'on', true)` (see lib/db/append-only.ts).
-- Violations raise SQLSTATE AO001.

CREATE FUNCTION "append_only_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_NARGS > 0 AND TG_ARGV[0] = 'erasable'
     AND current_setting('app.gdpr_erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on "%" is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'AO001',
          HINT = 'Insert a new row (e.g. a correcting entry) instead of changing history.';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "ledger_entries_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The only allowed change: link an unpaid entry to its transfer, touching nothing else.
  IF TG_OP = 'UPDATE'
     AND OLD.transfer_id IS NULL
     AND NEW.transfer_id IS NOT NULL
     AND (to_jsonb(NEW) - 'transfer_id') = (to_jsonb(OLD) - 'transfer_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on "ledger_entries" is not allowed: the ledger is append-only (only transfer_id may be set, once)', TG_OP
    USING ERRCODE = 'AO001',
          HINT = 'Write a new (negative or adjustment) entry instead of changing history.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "events_append_only" BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "events_no_truncate" BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "audience_snapshots_append_only" BEFORE UPDATE OR DELETE ON "audience_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('erasable');
--> statement-breakpoint
CREATE TRIGGER "audience_snapshots_no_truncate" BEFORE TRUNCATE ON "audience_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "proposal_revisions_append_only" BEFORE UPDATE OR DELETE ON "proposal_revisions"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "proposal_revisions_no_truncate" BEFORE TRUNCATE ON "proposal_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "agreement_signatures_append_only" BEFORE UPDATE OR DELETE ON "agreement_signatures"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "agreement_signatures_no_truncate" BEFORE TRUNCATE ON "agreement_signatures"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "link_clicks_append_only" BEFORE UPDATE OR DELETE ON "link_clicks"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "link_clicks_no_truncate" BEFORE TRUNCATE ON "link_clicks"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_append_only" BEFORE UPDATE OR DELETE ON "admin_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_no_truncate" BEFORE TRUNCATE ON "admin_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_guard"();
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_truncate" BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
