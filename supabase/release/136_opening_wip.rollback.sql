-- 136 rollback: ONLY with Rhys's approval. Removes the opening WIP record: the table (with its policy, triggers and index). Every opening WIP row
-- is lost (nothing else reads them; keep the importer's wip-verification.csv and SliQ's own figures). The table's row audit entries stay in
-- security_audit.audit_log, which nothing can edit. 136 replaced no existing object, so nothing else is touched. A later SliQ import with WIP
-- rows is then refused (the table is missing).
-- Run the whole text as one transaction, then the release preflight (marker 136 shows "not applied").
BEGIN;

DROP TABLE IF EXISTS public.opening_wip;

DO $$
BEGIN
  IF to_regclass('public.opening_wip') IS NOT NULL THEN
    RAISE EXCEPTION '136 rollback: public.opening_wip is still there';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '136 rollback: the jobs table is missing';
  END IF;
END
$$;

COMMIT;
