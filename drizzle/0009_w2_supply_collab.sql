CREATE TYPE "public"."collab_end_reason" AS ENUM('completed', 'cancelled', 'dispute', 'admin');--> statement-breakpoint
ALTER TABLE "collabs" ALTER COLUMN "ended_reason" SET DATA TYPE "public"."collab_end_reason" USING "ended_reason"::"public"."collab_end_reason";--> statement-breakpoint
ALTER TABLE "thread_reads" ALTER COLUMN "last_read_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_signatures" ADD COLUMN "body_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "rendered_body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "terminated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collabs" ADD COLUMN "stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "collabs" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "collabs" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD COLUMN "revision_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "match_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreements_status_created_at_idx" ON "agreements" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "collabs_stage_last_activity_at_idx" ON "collabs" USING btree ("stage","last_activity_at");--> statement-breakpoint
CREATE INDEX "proposals_match_id_idx" ON "proposals" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_open_per_pair_target_idx" ON "proposals" USING btree (least("from_user_id", "to_user_id"),greatest("from_user_id", "to_user_id"),coalesce("idea_id", "product_id")) WHERE "proposals"."status" IN ('pending', 'countered');--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_id_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "tasks_completed_by_user_id_idx" ON "tasks" USING btree ("completed_by_user_id");--> statement-breakpoint
CREATE INDEX "ideas_status_published_at_idx" ON "ideas" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_status_published_at_idx" ON "products" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "matches_subject_current_score_idx" ON "matches" USING btree ("subject_user_id","score" DESC NULLS LAST) WHERE "matches"."stale_at" IS NULL;--> statement-breakpoint
CREATE INDEX "matches_target_idx" ON "matches" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "saved_items_target_idx" ON "saved_items" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL AND "notifications"."in_app";--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_proposal_number_key" UNIQUE("proposal_id","revision_number");--> statement-breakpoint
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_typed_name_not_blank" CHECK ("agreement_signatures"."typed_name" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_body_hash_sha256" CHECK ("agreement_signatures"."body_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_body_hash_matches_body" CHECK ("agreements"."body_hash" = encode(sha256(convert_to("agreements"."rendered_body", 'UTF8')), 'hex'));--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_template_version_format" CHECK ("agreements"."template_version" ~ '^v[1-9][0-9]*$');--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_completed_at_matches_status" CHECK (("agreements"."status" <> 'signed' OR "agreements"."completed_at" IS NOT NULL) AND ("agreements"."status" <> 'awaiting_signatures' OR "agreements"."completed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_terminated_iff_terminated_at" CHECK (("agreements"."status" = 'terminated') = ("agreements"."terminated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_pdf_after_completion" CHECK ("agreements"."pdf_storage_key" IS NULL OR "agreements"."completed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_ended_iff_ended_at" CHECK (("collabs"."stage" = 'ended') = ("collabs"."ended_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_ended_has_reason" CHECK (("collabs"."stage" = 'ended') = ("collabs"."ended_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_not_blank" CHECK ("messages"."body" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachments_array" CHECK (jsonb_typeof("messages"."attachments") = 'array');--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_number_positive" CHECK ("proposal_revisions"."revision_number" >= 1);--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_scope_not_blank" CHECK ("proposal_revisions"."scope" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_closed_iff_final" CHECK (("proposals"."status" IN ('accepted', 'declined', 'expired', 'withdrawn')) = ("proposals"."closed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_not_blank" CHECK ("tasks"."title" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_position_nonnegative" CHECK ("tasks"."position" >= 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_only_when_done" CHECK ("tasks"."done_at" IS NOT NULL OR "tasks"."completed_by_user_id" IS NULL);--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_embedding_text_hash_format" CHECK ("builder_profiles"."embedding_text_hash" IS NULL OR "builder_profiles"."embedding_text_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_embedding_text_hash_format" CHECK ("creator_profiles"."embedding_text_hash" IS NULL OR "creator_profiles"."embedding_text_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_title_not_blank" CHECK ("ideas"."title" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_currency_format" CHECK ("ideas"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_published_has_time" CHECK ("ideas"."status" NOT IN ('open', 'in_collab', 'launched') OR "ideas"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_archived_iff_archived_at" CHECK (("ideas"."status" = 'archived') = ("ideas"."archived_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_embedding_text_hash_format" CHECK ("ideas"."embedding_text_hash" IS NULL OR "ideas"."embedding_text_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_title_not_blank" CHECK ("products"."title" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_currency_format" CHECK ("products"."currency" ~ '^[a-z]{3}$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_demo_url_http" CHECK ("products"."demo_url" IS NULL OR "products"."demo_url" ~* '^https?://[^[:space:]]+$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_published_has_time" CHECK ("products"."status" NOT IN ('seeking', 'in_collab', 'launched') OR "products"."published_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_archived_iff_archived_at" CHECK (("products"."status" = 'archived') = ("products"."archived_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_embedding_text_hash_format" CHECK ("products"."embedding_text_hash" IS NULL OR "products"."embedding_text_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_features_vector" CHECK (jsonb_typeof("matches"."features") = 'object' AND "matches"."features" ?& ARRAY['semantic', 'topic_overlap', 'audience_fit', 'format_fit', 'stage_fit', 'price_fit', 'reliability'] AND ("matches"."features" - ARRAY['semantic', 'topic_overlap', 'audience_fit', 'format_fit', 'stage_fit', 'price_fit', 'reliability']) = '{}'::jsonb AND CASE WHEN jsonb_typeof("matches"."features" -> 'semantic') = 'number' THEN ("matches"."features" ->> 'semantic')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'topic_overlap') = 'number' THEN ("matches"."features" ->> 'topic_overlap')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'audience_fit') = 'number' THEN ("matches"."features" ->> 'audience_fit')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'format_fit') = 'number' THEN ("matches"."features" ->> 'format_fit')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'stage_fit') = 'number' THEN ("matches"."features" ->> 'stage_fit')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'price_fit') = 'number' THEN ("matches"."features" ->> 'price_fit')::numeric BETWEEN 0 AND 1 ELSE false END AND CASE WHEN jsonb_typeof("matches"."features" -> 'reliability') = 'number' THEN ("matches"."features" ->> 'reliability')::numeric BETWEEN 0 AND 1 ELSE false END);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_not_self" CHECK ("matches"."target_type" NOT IN ('creator', 'builder') OR "matches"."target_id" <> "matches"."subject_user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_payload_object" CHECK (jsonb_typeof("notifications"."payload") = 'object');