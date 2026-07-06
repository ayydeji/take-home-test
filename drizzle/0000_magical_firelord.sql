CREATE TYPE "public"."form_status" AS ENUM('RECEIVED', 'VALIDATED', 'GEOCODED', 'READY', 'DISPATCHED', 'CONFLICT', 'FAILED_VALIDATION', 'FAILED_GEOCODING', 'FAILED_TRANSFORM');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_form_id" text,
	"content_hash" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"status" "form_status" DEFAULT 'RECEIVED' NOT NULL,
	"schema_version" text,
	"latitude" numeric,
	"longitude" numeric,
	"last_error" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_status_check" CHECK ("outbox"."status" in ('pending', 'sent'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transformed_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transformed_forms_form_id_unique" UNIQUE("form_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_events" ADD CONSTRAINT "form_events_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbox" ADD CONSTRAINT "outbox_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transformed_forms" ADD CONSTRAINT "transformed_forms_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forms_content_hash_unique" ON "forms" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_provider_form_id_idx" ON "forms" USING btree ("provider_form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_status_updated_at_idx" ON "forms" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_status_next_attempt_at_idx" ON "outbox" USING btree ("status","next_attempt_at");