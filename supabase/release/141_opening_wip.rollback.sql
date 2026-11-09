-- 141 rollback: ONLY with Rhys's approval. Removes the opening WIP record: the table (with its policy, triggers and index). Every opening WIP row
-- is lost (nothing else reads them; keep the importer's wip-verification.csv and SliQ's own figures). The table's row audit entries stay in
-- security_audit.audit_log, which nothing can edit. 141 replaced no existing object, so nothing else is touched. A later SliQ import with WIP
-- rows is then refused (the table is missing).
-- Run the whole text as one transaction, then the release preflight (marker 141 shows "not applied").
-- It REFUSES while any opening WIP row exists, unless the runner first says, in the same session, that deleting them is accepted (export them first):
--     SET tolra.x141_accept_deleting_wip = 'yes';
BEGIN;
DO $rb$ BEGIN
 IF to_regclass('public.opening_wip') IS NOT NULL THEN
  IF EXISTS (SELECT 1 FROM public.opening_wip) AND coalesce(current_setting('tolra.x141_accept_deleting_wip', TRUE), '') <> 'yes' THEN
   RAISE EXCEPTION '141 rollback refused: opening WIP rows exist; rolling back deletes them. Export them first, then SET tolra.x141_accept_deleting_wip = ''yes'' if that is accepted.';
  END IF;
 END IF;
END $rb$;

DROP TABLE IF EXISTS public.opening_wip;

DO $$
BEGIN
  IF to_regclass('public.opening_wip') IS NOT NULL THEN
    RAISE EXCEPTION '141 rollback: public.opening_wip is still there';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '141 rollback: the jobs table is missing';
  END IF;
END
$$;

COMMIT;
