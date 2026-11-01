-- Migration 109 (each person's date format, public.user_preferences; RLS own row only). Read only: rows 1 to 9 should be TRUE
-- (FALSE, never an error, while 109 is not applied).
SELECT n AS row, check_name, coalesce(ok, FALSE) AS ok FROM (
WITH t AS (SELECT to_regclass('public.user_preferences') AS rel),
pol AS (SELECT * FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_preferences'),
own AS (SELECT '(user_id = ( SELECT auth.uid() AS uid))'::TEXT AS expr)
SELECT 1 AS n, 'table_present' AS check_name, (SELECT rel IS NOT NULL FROM t) AS ok
-- Exactly the two columns: the login and one checked text column, default DD/MM/YYYY.
UNION ALL SELECT 2, 'columns_are_109s',
  (SELECT array_agg(column_name::TEXT || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') ORDER BY column_name)
   FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_preferences')
  = ARRAY['date_format:text:NO:''dmy-number''::text', 'user_id:uuid:NO:']
UNION ALL SELECT 3, 'date_format_checked_nine_values',
  (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.user_preferences') AND c.contype = 'c'
     AND c.conname = 'user_preferences_date_format_check'
     AND pg_get_constraintdef(c.oid) = 'CHECK ((date_format = ANY (ARRAY[''dmy-number''::text, ''dmy-short''::text, ''dmy-full''::text, ''mdy-number''::text, ''mdy-short''::text, ''mdy-full''::text, ''ymd-number''::text, ''ymd-short''::text, ''ymd-full''::text])))')
-- One row per login, removed with the login.
UNION ALL SELECT 4, 'one_row_per_login_cascade',
  (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.user_preferences') AND c.contype = 'p')
  AND (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.user_preferences') AND c.contype = 'f'
         AND c.confrelid = 'auth.users'::regclass AND c.confdeltype = 'c')
UNION ALL SELECT 5, 'rls_on', (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.user_preferences'))
-- Own row only: SELECT, INSERT and UPDATE for signed-in sessions, each on user_id = auth.uid(); no DELETE, no FOR ALL.
UNION ALL SELECT 6, 'policies_own_row_only',
  (SELECT count(*) = 3
          AND bool_and(permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::NAME[])
          AND array_agg(cmd::TEXT ORDER BY cmd) = ARRAY['INSERT', 'SELECT', 'UPDATE']
          AND bool_and(coalesce(qual, (SELECT expr FROM own)) = (SELECT expr FROM own) AND coalesce(with_check, (SELECT expr FROM own)) = (SELECT expr FROM own))
          AND bool_and(CASE cmd WHEN 'SELECT' THEN qual IS NOT NULL AND with_check IS NULL
                                WHEN 'INSERT' THEN qual IS NULL AND with_check IS NOT NULL
                                ELSE qual IS NOT NULL AND with_check IS NOT NULL END)
   FROM pol)
UNION ALL SELECT 7, 'signed_in_grants_select_insert_update_only',
  has_table_privilege('authenticated', to_regclass('public.user_preferences'), 'SELECT')
  AND has_table_privilege('authenticated', to_regclass('public.user_preferences'), 'INSERT')
  AND has_table_privilege('authenticated', to_regclass('public.user_preferences'), 'UPDATE')
  AND NOT has_table_privilege('authenticated', to_regclass('public.user_preferences'), 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
UNION ALL SELECT 8, 'anon_and_public_nothing',
  NOT has_table_privilege('anon', to_regclass('public.user_preferences'), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'user_preferences' AND grantee = 'PUBLIC')
-- Nothing else hangs on it: no trigger, no rule.
UNION ALL SELECT 9, 'no_triggers', (SELECT rel IS NOT NULL FROM t) AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.user_preferences') AND NOT tgisinternal)
) v
ORDER BY n;
