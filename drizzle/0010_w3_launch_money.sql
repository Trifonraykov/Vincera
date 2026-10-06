CREATE TYPE "public"."chargeback_status" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."launch_paused_by" AS ENUM('member', 'admin', 'dispute');--> statement-breakpoint
CREATE TYPE "public"."order_attribution" AS ENUM('cookie', 'ref', 'discount_code');--> statement-breakpoint
CREATE TYPE "public"."payout_batch_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'requires_action', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."transfer_reversal_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "chargebacks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"stripe_dispute_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"reason" text,
	"status" chargeback_status DEFAULT 'open' NOT NULL,
	"stripe_status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"ledger_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chargebacks_stripe_dispute_id_unique" UNIQUE("stripe_dispute_id"),
	CONSTRAINT "chargebacks_amount_positive" CHECK ("chargebacks"."amount_cents" > 0 AND "chargebacks"."fee_cents" >= 0),
	CONSTRAINT "chargebacks_currency_format" CHECK ("chargebacks"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "chargebacks_closed_iff_final" CHECK (("chargebacks"."status" = 'open') = ("chargebacks"."closed_at" IS NULL)),
	CONSTRAINT "chargebacks_ledger_only_when_lost" CHECK ("chargebacks"."ledger_posted_at" IS NULL OR "chargebacks"."status" = 'lost')
);
--> statement-breakpoint
ALTER TABLE "chargebacks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"status" "payout_batch_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"transfer_count" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_batches_run_key_unique" UNIQUE("run_key"),
	CONSTRAINT "payout_batches_run_key_not_blank" CHECK ("payout_batches"."run_key" ~ '[^[:space:]]'),
	CONSTRAINT "payout_batches_completed_iff_final" CHECK (("payout_batches"."status" = 'running') = ("payout_batches"."completed_at" IS NULL)),
	CONSTRAINT "payout_batches_counts_nonnegative" CHECK ("payout_batches"."transfer_count" >= 0 AND "payout_batches"."total_cents" >= 0 AND "payout_batches"."failed_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payout_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfer_reversals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"refund_id" uuid,
	"chargeback_id" uuid,
	"stripe_reversal_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"status" "transfer_reversal_status" DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_reversals_stripe_reversal_id_unique" UNIQUE("stripe_reversal_id"),
	CONSTRAINT "transfer_reversals_amount_positive" CHECK ("transfer_reversals"."amount_cents" > 0),
	CONSTRAINT "transfer_reversals_currency_format" CHECK ("transfer_reversals"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "transfer_reversals_one_cause" CHECK (num_nonnulls("transfer_reversals"."refund_id", "transfer_reversals"."chargeback_id") <= 1),
	CONSTRAINT "transfer_reversals_stripe_id_when_succeeded" CHECK ("transfer_reversals"."status" <> 'succeeded' OR "transfer_reversals"."stripe_reversal_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "transfer_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracked_links" DROP CONSTRAINT "tracked_links_launch_discount_code_key";--> statement-breakpoint
ALTER TABLE "launches" DROP CONSTRAINT "launches_price_nonnegative";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_amounts_nonnegative";--> statement-breakpoint
ALTER TABLE "launch_files" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "tax_code" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "paused_by" "launch_paused_by";--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "license_keys" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stripe_balance_transaction_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "amount_refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_country" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attribution" "order_attribution";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ledger_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "currency" text DEFAULT 'eur' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "status" "refund_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "ledger_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "discount_percent_off" integer;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "stripe_promotion_code_id" text;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "chargeback_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "batch_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "destination_account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "chargebacks" ADD CONSTRAINT "chargebacks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_chargeback_id_chargebacks_id_fk" FOREIGN KEY ("chargeback_id") REFERENCES "public"."chargebacks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chargebacks_order_id_idx" ON "chargebacks" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "chargebacks_status_idx" ON "chargebacks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transfer_reversals_transfer_id_idx" ON "transfer_reversals" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "transfer_reversals_refund_id_idx" ON "transfer_reversals" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "transfer_reversals_chargeback_id_idx" ON "transfer_reversals" USING btree ("chargeback_id");--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_chargeback_id_chargebacks_id_fk" FOREIGN KEY ("chargeback_id") REFERENCES "public"."chargebacks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_batch_id_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_one_active_per_order_idx" ON "access_grants" USING btree ("order_id") WHERE "access_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "launches_reviewed_by_user_id_idx" ON "launches" USING btree ("reviewed_by_user_id");--> statement-breakpoint
CREATE INDEX "orders_ledger_pending_idx" ON "orders" USING btree ("paid_at") WHERE "orders"."ledger_posted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refunds_requested_by_user_id_idx" ON "refunds" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_links_one_default_per_launch_idx" ON "tracked_links" USING btree ("launch_id") WHERE "tracked_links"."is_default";--> statement-breakpoint
CREATE INDEX "ledger_entries_chargeback_id_idx" ON "ledger_entries" USING btree ("chargeback_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_unpaid_idx" ON "ledger_entries" USING btree ("user_id","available_at") WHERE "ledger_entries"."transfer_id" IS NULL AND "ledger_entries"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transfers_batch_id_idx" ON "transfers" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_stripe_charge_id_unique" UNIQUE("stripe_charge_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_stripe_balance_transaction_id_unique" UNIQUE("stripe_balance_transaction_id");--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_discount_code_unique" UNIQUE("discount_code");--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_stripe_promotion_code_id_unique" UNIQUE("stripe_promotion_code_id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_batch_user_currency_key" UNIQUE("batch_id","user_id","currency");--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_token_format" CHECK ("access_grants"."token" ~ '^[A-Za-z0-9_-]{43}$');--> statement-breakpoint
ALTER TABLE "launch_files" ADD CONSTRAINT "launch_files_size_limit" CHECK ("launch_files"."size_bytes" <= 209715200);--> statement-breakpoint
ALTER TABLE "launch_files" ADD CONSTRAINT "launch_files_filename_not_blank" CHECK ("launch_files"."filename" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "launch_files" ADD CONSTRAINT "launch_files_position_nonnegative" CHECK ("launch_files"."position" >= 0);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_slug_length" CHECK (char_length("launches"."slug") BETWEEN 3 AND 80);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_title_not_blank" CHECK ("launches"."title" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_currency_format" CHECK ("launches"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_price_range" CHECK ("launches"."price_cents" IS NULL OR "launches"."price_cents" BETWEEN 50 AND 1000000);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_tax_code_format" CHECK ("launches"."tax_code" IS NULL OR "launches"."tax_code" ~ '^txcd_[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_delivery_config_matches_type" CHECK ("launches"."delivery_config" IS NULL OR "launches"."delivery_config"->>'type' = "launches"."delivery_type"::text);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_approved_by_array" CHECK (jsonb_typeof("launches"."approved_by") = 'array');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_media_array" CHECK (jsonb_typeof("launches"."media") = 'array');--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_paused_iff_paused_at" CHECK (("launches"."status" = 'paused') = ("launches"."paused_at" IS NOT NULL AND "launches"."paused_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_paused_by_only_when_paused" CHECK ("launches"."paused_by" IS NULL OR "launches"."paused_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_ended_iff_ended_at" CHECK (("launches"."status" = 'ended') = ("launches"."ended_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_live_has_went_live_at" CHECK ("launches"."status" NOT IN ('live', 'paused') OR "launches"."went_live_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_submitted_unless_draft" CHECK ("launches"."status" NOT IN ('pending_approval', 'admin_review') OR "launches"."submitted_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_reviewed_pair" CHECK (("launches"."reviewed_by_user_id" IS NULL) = ("launches"."reviewed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_key_not_blank" CHECK ("license_keys"."key" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_key_length" CHECK (char_length("license_keys"."key") <= 200);--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_assigned_pair" CHECK (("license_keys"."order_id" IS NULL) = ("license_keys"."assigned_at" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tax_within_gross" CHECK ("orders"."tax_cents" <= "orders"."amount_gross_cents");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_range" CHECK ("orders"."amount_refunded_cents" BETWEEN 0 AND "orders"."amount_gross_cents");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_format" CHECK ("orders"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_country_format" CHECK ("orders"."buyer_country" IS NULL OR "orders"."buyer_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_attribution_has_link" CHECK (("orders"."attribution" IS NULL) = ("orders"."tracked_link_id" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ledger_needs_balance_transaction" CHECK ("orders"."ledger_posted_at" IS NULL OR "orders"."stripe_balance_transaction_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_status" CHECK ("orders"."status" = 'disputed' OR ("orders"."status" = 'paid' AND "orders"."amount_refunded_cents" = 0) OR ("orders"."status" = 'partially_refunded' AND "orders"."amount_refunded_cents" > 0 AND "orders"."amount_refunded_cents" < "orders"."amount_gross_cents") OR ("orders"."status" = 'refunded' AND "orders"."amount_refunded_cents" = "orders"."amount_gross_cents"));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_nonnegative" CHECK ("orders"."amount_gross_cents" >= 0 AND "orders"."tax_cents" >= 0 AND "orders"."stripe_fee_cents" >= 0 AND "orders"."discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_currency_format" CHECK ("refunds"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_discount_code_format" CHECK ("tracked_links"."discount_code" IS NULL OR "tracked_links"."discount_code" ~ '^[A-Z0-9]{4,20}$');--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_discount_pair" CHECK (("tracked_links"."discount_code" IS NULL) = ("tracked_links"."discount_percent_off" IS NULL));--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_discount_range" CHECK ("tracked_links"."discount_percent_off" IS NULL OR "tracked_links"."discount_percent_off" BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_promotion_needs_code" CHECK ("tracked_links"."stripe_promotion_code_id" IS NULL OR "tracked_links"."discount_code" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_label_length" CHECK ("tracked_links"."label" IS NULL OR char_length("tracked_links"."label") <= 80);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_currency_format" CHECK ("ledger_entries"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_one_cause" CHECK (num_nonnulls("ledger_entries"."refund_id", "ledger_entries"."chargeback_id") <= 1);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_cause_has_order" CHECK (("ledger_entries"."refund_id" IS NULL AND "ledger_entries"."chargeback_id" IS NULL) OR "ledger_entries"."order_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transfer_needs_user" CHECK ("ledger_entries"."transfer_id" IS NULL OR "ledger_entries"."user_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_currency_format" CHECK ("transfers"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_stripe_id_unless_pending" CHECK ("transfers"."status" IN ('pending', 'failed') OR "transfers"."stripe_transfer_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_failure_code_only_when_failed" CHECK ("transfers"."failure_code" IS NULL OR "transfers"."status" = 'failed');