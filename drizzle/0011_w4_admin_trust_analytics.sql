CREATE TYPE "public"."dispute_outcome" AS ENUM('no_action', 'adjusted', 'collab_ended', 'other');--> statement-breakpoint
CREATE TYPE "public"."matching_model_kind" AS ENUM('weighted', 'logistic');--> statement-breakpoint
CREATE TYPE "public"."refund_request_reason" AS ENUM('not_as_described', 'not_working', 'not_received', 'accidental', 'other');--> statement-breakpoint
CREATE TYPE "public"."refund_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "refund_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"access_grant_id" uuid NOT NULL,
	"reason" "refund_request_reason" NOT NULL,
	"message" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"status" "refund_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_requests_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "refund_requests_refund_id_unique" UNIQUE("refund_id"),
	CONSTRAINT "refund_requests_amount_positive" CHECK ("refund_requests"."amount_cents" > 0),
	CONSTRAINT "refund_requests_currency_format" CHECK ("refund_requests"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "refund_requests_message" CHECK ("refund_requests"."message" IS NULL OR ("refund_requests"."message" ~ '[^[:space:]]' AND char_length("refund_requests"."message") <= 1000)),
	CONSTRAINT "refund_requests_decision_note" CHECK ("refund_requests"."decision_note" IS NULL OR ("refund_requests"."decision_note" ~ '[^[:space:]]' AND char_length("refund_requests"."decision_note") <= 500)),
	CONSTRAINT "refund_requests_decided_columns" CHECK (("refund_requests"."status" = 'pending') = ("refund_requests"."decided_at" IS NULL) AND ("refund_requests"."decided_at" IS NULL) = ("refund_requests"."decided_by_user_id" IS NULL)),
	CONSTRAINT "refund_requests_refund_iff_approved" CHECK (("refund_requests"."status" = 'approved') = ("refund_requests"."refund_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "refund_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ledger_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"dispute_id" uuid,
	"order_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_adjustments_reason" CHECK ("ledger_adjustments"."reason" ~ '[^[:space:]]' AND char_length("ledger_adjustments"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "ledger_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "impersonation_sessions_not_self" CHECK ("impersonation_sessions"."admin_user_id" <> "impersonation_sessions"."target_user_id"),
	CONSTRAINT "impersonation_sessions_reason" CHECK ("impersonation_sessions"."reason" ~ '[^[:space:]]' AND char_length("impersonation_sessions"."reason") <= 500),
	CONSTRAINT "impersonation_sessions_expiry" CHECK ("impersonation_sessions"."expires_at" > "impersonation_sessions"."started_at"),
	CONSTRAINT "impersonation_sessions_end" CHECK (("impersonation_sessions"."ended_at" IS NULL) = ("impersonation_sessions"."end_reason" IS NULL) AND ("impersonation_sessions"."ended_at" IS NULL OR "impersonation_sessions"."ended_at" >= "impersonation_sessions"."started_at") AND ("impersonation_sessions"."end_reason" IS NULL OR "impersonation_sessions"."end_reason" IN ('stopped', 'replaced', 'expired')))
);
--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "match_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "kind" "matching_model_kind" DEFAULT 'weighted' NOT NULL;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "model" jsonb;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "trained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matching_config" ADD COLUMN "activated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "adjustment_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "in_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "in_review_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "outcome" "dispute_outcome";--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_access_grant_id_access_grants_id_fk" FOREIGN KEY ("access_grant_id") REFERENCES "public"."access_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_adjustments" ADD CONSTRAINT "ledger_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_requests_status_created_at_idx" ON "refund_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refund_requests_access_grant_id_idx" ON "refund_requests" USING btree ("access_grant_id");--> statement-breakpoint
CREATE INDEX "refund_requests_decided_by_user_id_idx" ON "refund_requests" USING btree ("decided_by_user_id");--> statement-breakpoint
CREATE INDEX "ledger_adjustments_admin_user_id_idx" ON "ledger_adjustments" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "ledger_adjustments_dispute_id_idx" ON "ledger_adjustments" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "ledger_adjustments_order_id_idx" ON "ledger_adjustments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "impersonation_sessions_admin_user_id_idx" ON "impersonation_sessions" USING btree ("admin_user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "impersonation_sessions_target_user_id_idx" ON "impersonation_sessions" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_sessions_one_open_per_admin_idx" ON "impersonation_sessions" USING btree ("admin_user_id") WHERE "impersonation_sessions"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "matching_config" ADD CONSTRAINT "matching_config_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_adjustment_id_ledger_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."ledger_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_in_review_by_user_id_users_id_fk" FOREIGN KEY ("in_review_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launches_live_directory_idx" ON "launches" USING btree ("went_live_at" DESC NULLS LAST) WHERE "launches"."status" = 'live';--> statement-breakpoint
CREATE INDEX "events_occurred_at_id_idx" ON "events" USING btree ("occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_subject_type_occurred_at_idx" ON "events" USING btree ("subject_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "matching_config_activated_by_user_id_idx" ON "matching_config" USING btree ("activated_by_user_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_adjustment_id_idx" ON "ledger_entries" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_created_at_idx" ON "admin_audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_in_review_by_user_id_idx" ON "disputes" USING btree ("in_review_by_user_id");--> statement-breakpoint
CREATE INDEX "disputes_status_created_at_idx" ON "disputes" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_one_unresolved_per_member_idx" ON "disputes" USING btree ("collab_id","raised_by_user_id") WHERE "disputes"."status" <> 'resolved';--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_match_snapshot_object" CHECK ("proposals"."match_snapshot" IS NULL OR jsonb_typeof("proposals"."match_snapshot") = 'object');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deleted_anonymised" CHECK ("users"."deleted_at" IS NULL OR ("users"."email" IS NULL AND "users"."name" IS NULL AND "users"."avatar_url" IS NULL AND "users"."status" = 'suspended' AND NOT ('admin' = ANY("users"."roles"))));--> statement-breakpoint
ALTER TABLE "matching_config" ADD CONSTRAINT "matching_config_logistic_has_model" CHECK (("matching_config"."kind" = 'logistic') = ("matching_config"."model" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "matching_config" ADD CONSTRAINT "matching_config_json_objects" CHECK (jsonb_typeof("matching_config"."weights") = 'object' AND ("matching_config"."model" IS NULL OR jsonb_typeof("matching_config"."model") = 'object') AND ("matching_config"."metrics" IS NULL OR jsonb_typeof("matching_config"."metrics") = 'object'));--> statement-breakpoint
ALTER TABLE "matching_config" ADD CONSTRAINT "matching_config_trained_when_logistic" CHECK ("matching_config"."kind" <> 'logistic' OR "matching_config"."trained_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_adjustment_account" CHECK ("ledger_entries"."adjustment_id" IS NULL OR ("ledger_entries"."account" = 'adjustment' AND "ledger_entries"."refund_id" IS NULL AND "ledger_entries"."chargeback_id" IS NULL));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_description" CHECK ("disputes"."description" ~ '[^[:space:]]' AND char_length("disputes"."description") <= 2000);--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_review_columns" CHECK (("disputes"."status" = 'open') = ("disputes"."in_review_at" IS NULL) AND ("disputes"."in_review_at" IS NULL) = ("disputes"."in_review_by_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolution_columns" CHECK (CASE WHEN "disputes"."status" = 'resolved' THEN "disputes"."resolved_at" IS NOT NULL AND "disputes"."resolved_by" IS NOT NULL AND "disputes"."outcome" IS NOT NULL AND "disputes"."resolution_note" IS NOT NULL AND "disputes"."resolution_note" ~ '[^[:space:]]' AND char_length("disputes"."resolution_note") <= 2000 ELSE "disputes"."resolved_at" IS NULL AND "disputes"."resolved_by" IS NULL AND "disputes"."outcome" IS NULL AND "disputes"."resolution_note" IS NULL END);--> statement-breakpoint
-- Hand-written (CLAUDE.md §19.38), appended to the generated part above.
-- ledger_adjustments is append-only like the ledger it explains.
CREATE TRIGGER "ledger_adjustments_append_only" BEFORE UPDATE OR DELETE ON "ledger_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "ledger_adjustments_no_truncate" BEFORE TRUNCATE ON "ledger_adjustments"
  FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
--> statement-breakpoint
-- GDPR redaction (§14): account deletion may blank the deleting user's personal data in two
-- append-only tables, inside a transaction that ran allowGdprErasure() (app.gdpr_erasure = on):
-- proposal_revisions.message and agreement_signatures.ip / user_agent may be set to NULL, nothing
-- else may change, and nothing may be deleted. Every other change still raises AO001.
CREATE FUNCTION "gdpr_redaction_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  redactable text[] := TG_ARGV;
  new_row jsonb;
  old_row jsonb;
  col text;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('app.gdpr_erasure', true) = 'on' THEN
    new_row := to_jsonb(NEW);
    old_row := to_jsonb(OLD);
    IF (new_row - redactable) = (old_row - redactable) THEN
      FOREACH col IN ARRAY redactable LOOP
        IF NOT (new_row -> col = 'null'::jsonb OR new_row -> col IS NOT DISTINCT FROM old_row -> col) THEN
          RAISE EXCEPTION 'GDPR redaction on "%" may only set % to NULL', TG_TABLE_NAME, col
            USING ERRCODE = 'AO001';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% on "%" is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'AO001',
          HINT = 'Insert a new row (e.g. a correcting entry) instead of changing history.';
END;
$$;
--> statement-breakpoint
DROP TRIGGER "proposal_revisions_append_only" ON "proposal_revisions";
--> statement-breakpoint
CREATE TRIGGER "proposal_revisions_append_only" BEFORE UPDATE OR DELETE ON "proposal_revisions"
  FOR EACH ROW EXECUTE FUNCTION "gdpr_redaction_guard"('message');
--> statement-breakpoint
DROP TRIGGER "agreement_signatures_append_only" ON "agreement_signatures";
--> statement-breakpoint
CREATE TRIGGER "agreement_signatures_append_only" BEFORE UPDATE OR DELETE ON "agreement_signatures"
  FOR EACH ROW EXECUTE FUNCTION "gdpr_redaction_guard"('ip', 'user_agent');
