-- 117 rollback: ONLY with Rhys's approval. Drops the drafted_by lock trigger and its function. No data changes: email_history rows are
-- untouched, and a signed-in admin or office user can again update drafted_by (the gap 117 closed). Run the whole text as one
-- transaction, then the release preflight (marker 117 shows "not applied").
BEGIN;

DROP TRIGGER IF EXISTS email_history_drafted_by_lock ON public.email_history;
DROP FUNCTION IF EXISTS public.email_history_drafted_by_lock();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_history_drafted_by_lock')
     OR to_regprocedure('public.email_history_drafted_by_lock()') IS NOT NULL THEN
    RAISE EXCEPTION '117 rollback: the drafted_by lock is still there';
  END IF;
END
$$;

COMMIT;
