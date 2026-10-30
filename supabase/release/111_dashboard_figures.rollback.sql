-- 111 rollback: ONLY with Rhys's approval. Removes the two read-only dashboard functions 111 added; nothing else (111 changed no
-- table, row, policy, trigger or existing function). The app falls back to its earlier browser-side reads by itself (lib/dashboard-
-- figures.ts sees the functions are missing), so the dashboard keeps working. Run the whole text as one transaction, then the release
-- preflight (marker 111 shows "not applied").
BEGIN;
DO $$
BEGIN
  -- Only 111's own bodies are removed: a function of that name with another body is someone else's, so stop.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('dashboard_work_figures', 'dashboard_money_figures')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN ('8d4725ea13d23d27ae0be5cbfbfd012d', 'd57a0bd65b8669a48e171dbe49bd95ab')) THEN
    RAISE EXCEPTION '111 rollback: a dashboard figures function is not 111''s; stop and compare';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.dashboard_work_figures(DATE, DATE, DATE, DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.dashboard_money_figures(DATE, DATE);

DO $$
BEGIN
  IF to_regproc('public.dashboard_work_figures') IS NOT NULL OR to_regproc('public.dashboard_money_figures') IS NOT NULL THEN
    RAISE EXCEPTION '111 rollback: a dashboard figures function is still there';
  END IF;
END
$$;
COMMIT;
