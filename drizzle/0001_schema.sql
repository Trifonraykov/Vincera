CREATE TYPE "public"."agreement_status" AS ENUM('awaiting_signatures', 'signed', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."builder_availability" AS ENUM('open', 'limited', 'closed');--> statement-breakpoint
CREATE TYPE "public"."collab_role" AS ENUM('creator', 'builder');--> statement-breakpoint
CREATE TYPE "public"."collab_stage" AS ENUM('agreement', 'building', 'launch_review', 'live', 'ended');--> statement-breakpoint
CREATE TYPE "public"."deal_preference" AS ENUM('split', 'fixed', 'either');--> statement-breakpoint
CREATE TYPE "public"."delivery_type" AS ENUM('file', 'license_key', 'url');--> statement-breakpoint
CREATE TYPE "public"."dispute_kind" AS ENUM('split', 'non_delivery', 'exit', 'other');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'in_review', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('draft', 'open', 'in_collab', 'launched', 'archived');--> statement-breakpoint
CREATE TYPE "public"."launch_status" AS ENUM('draft', 'pending_approval', 'admin_review', 'live', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('creator_share', 'builder_share', 'platform_fee', 'stripe_fee', 'tax', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('shown', 'saved', 'dismissed', 'proposed');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('paid', 'refunded', 'partially_refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."product_format" AS ENUM('app', 'tool', 'template', 'ai_utility', 'course_tool', 'other');--> statement-breakpoint
CREATE TYPE "public"."product_stage" AS ENUM('idea', 'prototype', 'beta', 'live');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'seeking', 'in_collab', 'launched', 'archived');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'countered', 'accepted', 'declined', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."size_tier" AS ENUM('nano', 'micro', 'mid', 'macro');--> statement-breakpoint
CREATE TYPE "public"."social_connection_source" AS ENUM('oauth', 'manual');--> statement-breakpoint
CREATE TYPE "public"."social_connection_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."social_provider" AS ENUM('youtube', 'instagram', 'tiktok', 'github');--> statement-breakpoint
CREATE TYPE "public"."target_type" AS ENUM('creator', 'builder', 'idea', 'product');--> statement-breakpoint
CREATE TYPE "public"."thread_kind" AS ENUM('proposal', 'collab');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('pending', 'created', 'failed', 'reversed', 'partially_reversed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('creator', 'builder', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "agreement_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agreement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"typed_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreement_signatures_agreement_user_key" UNIQUE("agreement_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collab_id" uuid NOT NULL,
	"template_version" text NOT NULL,
	"terms" jsonb NOT NULL,
	"body_hash" text NOT NULL,
	"pdf_storage_key" text,
	"status" "agreement_status" DEFAULT 'awaiting_signatures' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreements_body_hash_sha256" CHECK ("agreements"."body_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "collab_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collab_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "collab_role" NOT NULL,
	"split_pct" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collab_members_collab_user_key" UNIQUE("collab_id","user_id"),
	CONSTRAINT "collab_members_split_range" CHECK ("collab_members"."split_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "collabs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"idea_id" uuid,
	"product_id" uuid,
	"stage" "collab_stage" DEFAULT 'agreement' NOT NULL,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collabs_proposal_id_unique" UNIQUE("proposal_id"),
	CONSTRAINT "collabs_exactly_one_target" CHECK (num_nonnulls("collabs"."idea_id", "collabs"."product_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"message" text,
	"scope" text NOT NULL,
	"creator_split_pct" integer NOT NULL,
	"builder_split_pct" integer NOT NULL,
	"timeline_weeks" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_revisions_split_valid" CHECK ("proposal_revisions"."creator_split_pct" BETWEEN 0 AND 100 AND "proposal_revisions"."builder_split_pct" BETWEEN 0 AND 100 AND "proposal_revisions"."creator_split_pct" + "proposal_revisions"."builder_split_pct" = 100),
	CONSTRAINT "proposal_revisions_timeline_positive" CHECK ("proposal_revisions"."timeline_weeks" > 0)
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"idea_id" uuid,
	"product_id" uuid,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"current_revision_id" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_exactly_one_target" CHECK (num_nonnulls("proposals"."idea_id", "proposals"."product_id") = 1),
	CONSTRAINT "proposals_not_to_self" CHECK ("proposals"."from_user_id" <> "proposals"."to_user_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collab_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_user_id" uuid,
	"due_date" date,
	"done_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_reads_thread_user_key" UNIQUE("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "thread_kind" NOT NULL,
	"proposal_id" uuid,
	"collab_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_proposal_id_unique" UNIQUE("proposal_id"),
	CONSTRAINT "threads_collab_id_unique" UNIQUE("collab_id"),
	CONSTRAINT "threads_kind_matches_parent" CHECK (("threads"."kind" = 'proposal' AND "threads"."proposal_id" IS NOT NULL AND "threads"."collab_id" IS NULL) OR ("threads"."kind" = 'collab' AND "threads"."collab_id" IS NOT NULL AND "threads"."proposal_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"token" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "launch_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"launch_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launch_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "launch_files_size_nonnegative" CHECK ("launch_files"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collab_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"tagline" text,
	"description_md" text,
	"price_cents" integer,
	"currency" text DEFAULT 'eur' NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_type" "delivery_type",
	"delivery_config" jsonb,
	"status" "launch_status" DEFAULT 'draft' NOT NULL,
	"approved_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"went_live_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "launches_collab_id_unique" UNIQUE("collab_id"),
	CONSTRAINT "launches_slug_unique" UNIQUE("slug"),
	CONSTRAINT "launches_slug_format" CHECK ("launches"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "launches_price_nonnegative" CHECK ("launches"."price_cents" >= 0),
	CONSTRAINT "launches_complete_unless_draft" CHECK ("launches"."status" = 'draft' OR ("launches"."price_cents" IS NOT NULL AND "launches"."delivery_type" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "license_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"launch_id" uuid NOT NULL,
	"key" text NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_keys_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "license_keys_launch_key_key" UNIQUE("launch_id","key")
);
--> statement-breakpoint
CREATE TABLE "link_clicks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tracked_link_id" uuid NOT NULL,
	"clicked_at" timestamp with time zone NOT NULL,
	"referrer" text,
	"country" text,
	"ua_hash" text,
	"visitor_id" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"launch_id" uuid NOT NULL,
	"buyer_email" text NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount_gross_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"stripe_fee_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"tracked_link_id" uuid,
	"status" "order_status" DEFAULT 'paid' NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "orders_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "orders_amounts_nonnegative" CHECK ("orders"."amount_gross_cents" >= 0 AND "orders"."tax_cents" >= 0 AND "orders"."stripe_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"stripe_refund_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_stripe_refund_id_unique" UNIQUE("stripe_refund_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "tracked_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"launch_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"discount_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_links_code_unique" UNIQUE("code"),
	CONSTRAINT "tracked_links_launch_discount_code_key" UNIQUE("launch_id","discount_code"),
	CONSTRAINT "tracked_links_code_format" CHECK ("tracked_links"."code" ~ '^[0-9A-Za-z]{8}$')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_subject_complete" CHECK (("events"."subject_type" IS NULL) = ("events"."subject_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_pkey" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "builder_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"stack" text[] DEFAULT '{}'::text[] NOT NULL,
	"availability" "builder_availability" DEFAULT 'open' NOT NULL,
	"deal_preference" "deal_preference" DEFAULT 'either' NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "builder_profiles_handle_unique" UNIQUE("handle"),
	CONSTRAINT "builder_profiles_handle_format" CHECK ("builder_profiles"."handle" ~ '^[a-z0-9_]{3,30}$')
);
--> statement-breakpoint
CREATE TABLE "creator_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"niche" text,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"country" text,
	"size_tier" "size_tier",
	"audience_summary" text,
	"audience_summary_prompt_version" text,
	"embedding" vector(1024),
	"embedding_model" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "creator_profiles_handle_unique" UNIQUE("handle"),
	CONSTRAINT "creator_profiles_handle_format" CHECK ("creator_profiles"."handle" ~ '^[a-z0-9_]{3,30}$'),
	CONSTRAINT "creator_profiles_country_format" CHECK ("creator_profiles"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handles_handle_user_id_key" UNIQUE("handle","user_id"),
	CONSTRAINT "handles_handle_format" CHECK ("handles"."handle" ~ '^[a-z0-9_]{3,30}$')
);
--> statement-breakpoint
CREATE TABLE "portfolio_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builder_profile_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"description" text,
	"image_url" text,
	"is_shipped" boolean DEFAULT false NOT NULL,
	"format" "product_format",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"avatar_url" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"active_role" "user_role",
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_roles_valid" CHECK ("users"."roles" <@ ARRAY['creator', 'builder', 'admin']::text[]),
	CONSTRAINT "users_active_role_in_roles" CHECK ("users"."active_role" IS NULL OR "users"."active_role"::text = ANY("users"."roles"))
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "audience_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"social_connection_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"followers" integer,
	"avg_views" integer,
	"engagement_rate" numeric(6, 4),
	"top_countries" jsonb,
	"age_gender" jsonb,
	"top_topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audience_snapshots_followers_nonnegative" CHECK ("audience_snapshots"."followers" >= 0),
	CONSTRAINT "audience_snapshots_avg_views_nonnegative" CHECK ("audience_snapshots"."avg_views" >= 0)
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "social_provider" NOT NULL,
	"provider_account_id" text,
	"username" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "social_connection_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"source" "social_connection_source" DEFAULT 'oauth' NOT NULL,
	"verified_at" timestamp with time zone,
	"evidence_storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_user_id_provider_key" UNIQUE("user_id","provider"),
	CONSTRAINT "social_connections_provider_account_key" UNIQUE("provider","provider_account_id"),
	CONSTRAINT "social_connections_oauth_has_account" CHECK ("social_connections"."source" <> 'oauth' OR "social_connections"."provider_account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"creator_profile_id" uuid NOT NULL,
	"title" text NOT NULL,
	"problem" text,
	"audience_evidence" text,
	"format" "product_format" NOT NULL,
	"target_price_cents" integer,
	"currency" text DEFAULT 'eur' NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "idea_status" DEFAULT 'draft' NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ideas_target_price_nonnegative" CHECK ("ideas"."target_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builder_profile_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_user" text,
	"stage" "product_stage" DEFAULT 'idea' NOT NULL,
	"demo_url" text,
	"format" "product_format" NOT NULL,
	"target_price_cents" integer,
	"currency" text DEFAULT 'eur' NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_split_builder_pct" integer,
	"exclusivity" boolean DEFAULT false NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_target_price_nonnegative" CHECK ("products"."target_price_cents" >= 0),
	CONSTRAINT "products_preferred_split_range" CHECK ("products"."preferred_split_builder_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"score" numeric(7, 6) NOT NULL,
	"features" jsonb NOT NULL,
	"explanation" text,
	"explanation_prompt_version" text,
	"model_version" text NOT NULL,
	"status" "match_status" DEFAULT 'shown' NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_subject_target_model_key" UNIQUE("subject_user_id","target_type","target_id","model_version"),
	CONSTRAINT "matches_score_range" CHECK ("matches"."score" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "matching_config" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"weights" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matching_config_model_version_unique" UNIQUE("model_version")
);
--> statement-breakpoint
CREATE TABLE "saved_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_items_user_target_key" UNIQUE("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid,
	"refund_id" uuid,
	"user_id" uuid,
	"account" "ledger_account" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"transfer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_share_has_user" CHECK ("ledger_entries"."account" NOT IN ('creator_share', 'builder_share') OR "ledger_entries"."user_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_platform_has_no_user" CHECK ("ledger_entries"."account" NOT IN ('platform_fee', 'stripe_fee', 'tax') OR "ledger_entries"."user_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "stripe_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"country" text,
	"updated_from_stripe_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "stripe_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_transfer_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'eur' NOT NULL,
	"status" "transfer_status" DEFAULT 'pending' NOT NULL,
	"amount_reversed_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_stripe_transfer_id_unique" UNIQUE("stripe_transfer_id"),
	CONSTRAINT "transfers_amount_positive" CHECK ("transfers"."amount_cents" > 0),
	CONSTRAINT "transfers_reversed_range" CHECK ("transfers"."amount_reversed_cents" BETWEEN 0 AND "transfers"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"collab_id" uuid NOT NULL,
	"raised_by_user_id" uuid NOT NULL,
	"kind" "dispute_kind" NOT NULL,
	"description" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_type_key" UNIQUE("user_id","type")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_members" ADD CONSTRAINT "collab_members_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_members" ADD CONSTRAINT "collab_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_current_revision_id_proposal_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."proposal_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_files" ADD CONSTRAINT "launch_files_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_clicks" ADD CONSTRAINT "link_clicks_tracked_link_id_tracked_links_id_fk" FOREIGN KEY ("tracked_link_id") REFERENCES "public"."tracked_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tracked_link_id_tracked_links_id_fk" FOREIGN KEY ("tracked_link_id") REFERENCES "public"."tracked_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_handle_owner_fk" FOREIGN KEY ("handle","user_id") REFERENCES "public"."handles"("handle","user_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_handle_owner_fk" FOREIGN KEY ("handle","user_id") REFERENCES "public"."handles"("handle","user_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "handles" ADD CONSTRAINT "handles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_builder_profile_id_builder_profiles_id_fk" FOREIGN KEY ("builder_profile_id") REFERENCES "public"."builder_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_snapshots" ADD CONSTRAINT "audience_snapshots_social_connection_id_fk" FOREIGN KEY ("social_connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_creator_profile_id_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."creator_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_builder_profile_id_builder_profiles_id_fk" FOREIGN KEY ("builder_profile_id") REFERENCES "public"."builder_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_model_version_matching_config_model_version_fk" FOREIGN KEY ("model_version") REFERENCES "public"."matching_config"("model_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_collab_id_collabs_id_fk" FOREIGN KEY ("collab_id") REFERENCES "public"."collabs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_user_id_users_id_fk" FOREIGN KEY ("raised_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_signatures_user_id_idx" ON "agreement_signatures" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agreements_collab_id_idx" ON "agreements" USING btree ("collab_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agreements_one_active_per_collab_idx" ON "agreements" USING btree ("collab_id") WHERE "agreements"."status" <> 'terminated';--> statement-breakpoint
CREATE INDEX "collab_members_user_id_idx" ON "collab_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "collabs_idea_id_idx" ON "collabs" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "collabs_product_id_idx" ON "collabs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "collabs_stage_idx" ON "collabs" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "messages_thread_id_created_at_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_author_user_id_idx" ON "messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "proposal_revisions_proposal_id_idx" ON "proposal_revisions" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "proposal_revisions_author_user_id_idx" ON "proposal_revisions" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "proposals_from_user_id_idx" ON "proposals" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "proposals_to_user_id_idx" ON "proposals" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "proposals_idea_id_idx" ON "proposals" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "proposals_product_id_idx" ON "proposals" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "proposals_current_revision_id_idx" ON "proposals" USING btree ("current_revision_id");--> statement-breakpoint
CREATE INDEX "proposals_status_expires_at_idx" ON "proposals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "tasks_collab_id_position_idx" ON "tasks" USING btree ("collab_id","position");--> statement-breakpoint
CREATE INDEX "tasks_assignee_user_id_idx" ON "tasks" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "thread_reads_user_id_idx" ON "thread_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grants_order_id_idx" ON "access_grants" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "launch_files_launch_id_idx" ON "launch_files" USING btree ("launch_id");--> statement-breakpoint
CREATE INDEX "launches_status_idx" ON "launches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "license_keys_unassigned_idx" ON "license_keys" USING btree ("launch_id") WHERE "license_keys"."order_id" IS NULL;--> statement-breakpoint
CREATE INDEX "link_clicks_tracked_link_clicked_at_idx" ON "link_clicks" USING btree ("tracked_link_id","clicked_at");--> statement-breakpoint
CREATE INDEX "orders_launch_id_paid_at_idx" ON "orders" USING btree ("launch_id","paid_at");--> statement-breakpoint
CREATE INDEX "orders_tracked_link_id_idx" ON "orders" USING btree ("tracked_link_id");--> statement-breakpoint
CREATE INDEX "refunds_order_id_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "tracked_links_launch_id_idx" ON "tracked_links" USING btree ("launch_id");--> statement-breakpoint
CREATE INDEX "tracked_links_owner_user_id_idx" ON "tracked_links" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "events_type_occurred_at_idx" ON "events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_subject_id_idx" ON "events" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "events_actor_user_id_idx" ON "events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "builder_profiles_embedding_hnsw_idx" ON "builder_profiles" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "creator_profiles_embedding_hnsw_idx" ON "creator_profiles" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "handles_user_id_idx" ON "handles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "portfolio_items_builder_profile_id_idx" ON "portfolio_items" USING btree ("builder_profile_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audience_snapshots_connection_taken_at_idx" ON "audience_snapshots" USING btree ("social_connection_id","taken_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ideas_creator_profile_id_idx" ON "ideas" USING btree ("creator_profile_id");--> statement-breakpoint
CREATE INDEX "ideas_status_idx" ON "ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ideas_embedding_hnsw_idx" ON "ideas" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "products_builder_profile_id_idx" ON "products" USING btree ("builder_profile_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_embedding_hnsw_idx" ON "products" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "matches_subject_status_score_idx" ON "matches" USING btree ("subject_user_id","status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "matches_model_version_idx" ON "matches" USING btree ("model_version");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_config_single_active_idx" ON "matching_config" USING btree ("active") WHERE "matching_config"."active";--> statement-breakpoint
CREATE INDEX "ledger_entries_user_id_available_at_idx" ON "ledger_entries" USING btree ("user_id","available_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_refund_id_idx" ON "ledger_entries" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transfer_id_idx" ON "ledger_entries" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "transfers_user_id_idx" ON "transfers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_admin_user_id_idx" ON "admin_audit_log" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "disputes_collab_id_idx" ON "disputes" USING btree ("collab_id");--> statement-breakpoint
CREATE INDEX "disputes_raised_by_user_id_idx" ON "disputes" USING btree ("raised_by_user_id");--> statement-breakpoint
CREATE INDEX "disputes_resolved_by_idx" ON "disputes" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);