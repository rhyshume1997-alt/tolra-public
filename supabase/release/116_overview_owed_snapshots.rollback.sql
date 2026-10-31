-- 116 rollback: ONLY with Rhys's approval. Removes the Overview's owed snapshots (the capture function and its table, with every
-- nightly figure in it: they can't be rebuilt afterwards). Nothing else is touched: 116 replaced no existing object. The app then hides
-- the money-owed sparkline and the nightly job answers "skipped: not configured", so nothing breaks. Run the whole text as one
-- transaction, then the release preflight (marker 116 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.capture_overview_owed();
DROP TABLE IF EXISTS public.overview_owed_snapshots;

DO $$
BEGIN
  IF to_regprocedure('public.capture_overview_owed()') IS NOT NULL OR to_regclass('public.overview_owed_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION '116 rollback: the owed snapshots are still there';
  END IF;
END
$$;

COMMIT;
