-- 109 rollback: ONLY with Rhys's approval. Removes public.user_preferences (each person's date format); everyone sees dates as
-- DD/MM/YYYY again: the app reads the setting on each page load and, finding no table, uses the default and forgets the browser's
-- copy (a page already open keeps its format until it is reloaded). Account Settings then says the date format needs a database update.
-- The choices are display settings only: nothing else refers to them, and they are not records. Safe to run again.
-- Run the whole text as one transaction, then `notify pgrst, 'reload schema';`.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.user_preferences') IS NOT NULL
     AND (SELECT array_agg(column_name::TEXT ORDER BY column_name) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'user_preferences') IS DISTINCT FROM ARRAY['date_format', 'user_id'] THEN
    RAISE EXCEPTION '109 rollback: public.user_preferences is not 109''s; stop and compare it first';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.user_preferences;

COMMIT;
