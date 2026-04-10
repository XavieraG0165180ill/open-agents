ALTER TABLE "sessions" ADD COLUMN "sandbox_ensure_lease_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sandbox_ensure_lease_expires_at" timestamp;