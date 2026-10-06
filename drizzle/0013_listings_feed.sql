CREATE TYPE "public"."app_store_verification_method" AS ENUM('description_code', 'admin');--> statement-breakpoint
CREATE TYPE "public"."product_source" AS ENUM('manual', 'app_store', 'web');--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_developer_id" text;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_developer_name" text;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_country" text;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_verification_method" "app_store_verification_method";--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD COLUMN "app_store_sync_error" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source" "product_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_meta" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "media" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tagline" text;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_profiles_app_store_verified_developer_idx" ON "builder_profiles" USING btree ("app_store_developer_id") WHERE "builder_profiles"."app_store_verified_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_builder_source_idx" ON "products" USING btree ("builder_profile_id","source","source_id") WHERE "products"."source" <> 'manual';--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_app_store_developer_id_format" CHECK ("builder_profiles"."app_store_developer_id" IS NULL OR "builder_profiles"."app_store_developer_id" ~ '^[0-9]{1,20}$');--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_app_store_country_format" CHECK (("builder_profiles"."app_store_developer_id" IS NULL) = ("builder_profiles"."app_store_country" IS NULL) AND ("builder_profiles"."app_store_country" IS NULL OR "builder_profiles"."app_store_country" ~ '^[a-z]{2}$'));--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_app_store_verified_has_account" CHECK ("builder_profiles"."app_store_verified_at" IS NULL OR "builder_profiles"."app_store_developer_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "builder_profiles" ADD CONSTRAINT "builder_profiles_app_store_verified_iff_method" CHECK (("builder_profiles"."app_store_verified_at" IS NULL) = ("builder_profiles"."app_store_verification_method" IS NULL));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_id_iff_imported" CHECK (("products"."source" = 'manual') = ("products"."source_id" IS NULL));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_app_store_source_id_format" CHECK ("products"."source" <> 'app_store' OR "products"."source_id" ~ '^[0-9]{1,20}$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_url_http" CHECK ("products"."source_url" IS NULL OR "products"."source_url" ~* '^https?://[^[:space:]]+$');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tagline_length" CHECK ("products"."tagline" IS NULL OR (char_length("products"."tagline") BETWEEN 1 AND 140));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_media_is_array" CHECK (jsonb_typeof("products"."media") = 'array');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_meta_imported_only" CHECK ("products"."source_meta" IS NULL OR "products"."source" <> 'manual');