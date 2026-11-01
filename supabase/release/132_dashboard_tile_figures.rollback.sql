-- 132 rollback: ONLY with Rhys's approval. Drops the six dashboard tile functions 132 added; nothing else (132 changed no table, row,
-- policy, trigger or other function). The dashboard then goes back to its old reads by itself (lib/dashboard-tile-figures.ts falls back
-- when a function is missing), with the same figures. Run the whole text as one transaction, then the release preflight (marker 132
-- shows "not applied") and supabase/verify/dashboard_tiles_132.sql (six_functions FALSE). Safe to run again.
BEGIN;
DO $$
BEGIN
  -- Refuse if a function of these names holds another body than 132's (someone changed it since): compare it first.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('dashboard_open_quotes', 'dashboard_quotes_sent', 'dashboard_quotes_won', 'dashboard_quote_outcomes',
                                 'dashboard_rfqs_to_quote', 'dashboard_money_owed')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN (
                 'd2c5bd23f4c46c421b989012e74c2e80', '308be040514eab13aca8cf86dd7f2c63', 'd2ca2c957383ede97833c95b84b0f8fa',
                 '774a67cfe0e7fd2f013f7fd3abcc7dad', 'feb2db260235700a2166bb4c1a550467', '717e79e4e15894b2392c3c9d0eda4e96')) THEN
    RAISE EXCEPTION '132 rollback: a dashboard tile function is not 132''s; stop and compare it first';
  END IF;
END
$$;
DROP FUNCTION IF EXISTS public.dashboard_open_quotes(DATE);
DROP FUNCTION IF EXISTS public.dashboard_quotes_sent(DATE);
DROP FUNCTION IF EXISTS public.dashboard_quotes_won(DATE);
DROP FUNCTION IF EXISTS public.dashboard_quote_outcomes(DATE, DATE);
DROP FUNCTION IF EXISTS public.dashboard_rfqs_to_quote();
DROP FUNCTION IF EXISTS public.dashboard_money_owed(DATE);
COMMIT;
