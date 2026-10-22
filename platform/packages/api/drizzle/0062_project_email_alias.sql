ALTER TABLE "projects" ADD COLUMN "email_alias" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_projects_email_alias" ON "projects" USING btree ("email_alias") WHERE "projects"."email_alias" IS NOT NULL;--> statement-breakpoint
-- A slug and an email alias both name a mailbox on the shared mail domain, so
-- one name may belong to only one project. The unique indexes cover slug vs
-- slug and alias vs alias; this trigger covers slug vs alias in both
-- directions, including projects that an older runtime creates. The advisory
-- lock orders concurrent claims so each check sees the other's commit.
CREATE FUNCTION "void_project_mailbox_name_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.slug IS NOT DISTINCT FROM OLD.slug
    AND NEW.email_alias IS NOT DISTINCT FROM OLD.email_alias THEN
    RETURN NEW;
  END IF;
  -- Aliases never start with "preview-", so preview projects cannot collide.
  IF NEW.email_alias IS NULL AND NEW.slug LIKE 'preview-%' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(5110511);
  IF NEW.email_alias = NEW.slug
    OR EXISTS (
      SELECT 1 FROM "projects"
      WHERE "id" <> NEW.id AND "slug" = NEW.email_alias
    )
    OR EXISTS (
      SELECT 1 FROM "projects"
      WHERE "id" <> NEW.id AND "email_alias" = NEW.slug
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'A project slug or email alias already uses this name';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "void_project_mailbox_name_guard"
BEFORE INSERT OR UPDATE OF "slug", "email_alias" ON "projects"
FOR EACH ROW EXECUTE FUNCTION "void_project_mailbox_name_guard"();
