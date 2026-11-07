-- Rollback of release step 152 (SliQ go-live import route). One transaction. Removes the two tables and its functions; nothing of 076 is touched.
-- Refuses while any SliQ import map row exists: dropping the map with the data still there is exactly the "map lost, data kept" case.
-- IF IT REFUSES (nothing has been changed; the transaction is rolled back): do NOT delete map rows by hand. Either keep 152 installed
-- (preferred: it is additive; the rest of Tolra does not depend on it), or restore the database backup taken before the SliQ import
-- and then run this rollback again (the restored copy has no map rows). Refuses a second time once 152 is gone.
BEGIN;
DO $rollback_guard$ BEGIN
 IF to_regclass('public.import_source_rows') IS NULL THEN
  RAISE EXCEPTION '152 rollback: release 152 is not installed';
 END IF;
 IF EXISTS (SELECT 1 FROM public.import_source_rows) THEN
  RAISE EXCEPTION '152 rollback: SliQ import map rows exist; dropping them would separate the map from the data. Nothing was changed. Keep 152, or restore the backup taken before the SliQ import and run this rollback again; never delete map rows by hand.';
 END IF;
END $rollback_guard$;
DROP FUNCTION IF EXISTS public.import_sliq_reconcile();
DROP FUNCTION IF EXISTS public.import_sliq_reconcile_rows(UUID);
DROP FUNCTION IF EXISTS public.import_sliq_batch(TEXT, JSONB, TEXT, TEXT, INT, JSONB, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.import_sliq_preflight(TEXT, JSONB, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.import_sliq_check_inv_gap(UUID, INT, BOOLEAN, BIGINT);
DROP FUNCTION IF EXISTS public.import_sliq_counter_moves(UUID);
DROP FUNCTION IF EXISTS public.import_sliq_check_files(TEXT, JSONB);
DROP FUNCTION IF EXISTS public.import_sliq_summary(TEXT);
DROP FUNCTION IF EXISTS public.import_sliq_collect(JSONB);
DROP FUNCTION IF EXISTS public.import_sliq_prepare(UUID, TEXT, JSONB, TEXT);
DROP TABLE IF EXISTS public.import_source_rows;
ALTER TABLE public.import_source_batches DISABLE TRIGGER import_source_batches_immutable;
DROP TABLE IF EXISTS public.import_source_batches;
DROP FUNCTION IF EXISTS public.import_source_rows_guard();
DROP FUNCTION IF EXISTS public.import_source_batches_immutable();
COMMIT;
