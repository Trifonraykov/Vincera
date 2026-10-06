CREATE TABLE "mobile_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mobile_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mobile_sessions_token_hash_format" CHECK ("mobile_sessions"."token_hash" IS NULL OR "mobile_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mobile_sessions_device_name_length" CHECK ("mobile_sessions"."device_name" IS NULL OR char_length("mobile_sessions"."device_name") <= 100)
);
--> statement-breakpoint
ALTER TABLE "mobile_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_sessions_user_id_idx" ON "mobile_sessions" USING btree ("user_id");