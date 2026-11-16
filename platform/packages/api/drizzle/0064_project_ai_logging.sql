CREATE TABLE "project_ai_logging" (
	"project_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "project_ai_logging_mode" CHECK ("project_ai_logging"."mode" IN ('off', 'metadata', 'full'))
);
--> statement-breakpoint
ALTER TABLE "project_ai_logging" ADD CONSTRAINT "project_ai_logging_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;