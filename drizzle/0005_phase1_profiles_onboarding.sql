CREATE TYPE "public"."stripe_capability_status" AS ENUM('active', 'inactive', 'pending', 'unrequested');--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD COLUMN "audience_summary_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD COLUMN "audience_summary_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_steps" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "profile_url" text;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "token_obtained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "social_connections" ADD COLUMN "last_sync_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD COLUMN "transfers_capability" "stripe_capability_status" DEFAULT 'unrequested' NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD COLUMN "requirements_currently_due" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_dedupe_key" UNIQUE("user_id","dedupe_key");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_onboarding_steps_object" CHECK (jsonb_typeof("users"."onboarding_steps") = 'object');--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_manual_has_no_tokens" CHECK ("social_connections"."source" <> 'manual' OR ("social_connections"."access_token_enc" IS NULL AND "social_connections"."refresh_token_enc" IS NULL));--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_sync_error_has_time" CHECK ("social_connections"."last_sync_error" IS NULL OR "social_connections"."last_sync_error_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_country_format" CHECK ("stripe_accounts"."country" ~ '^[A-Z]{2}$');