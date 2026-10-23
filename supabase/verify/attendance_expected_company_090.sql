-- Migration 090 (a clock action is recorded only in the company it was made in: record_attendance_event_in_company()).
-- Read only: every row should be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)')
),
old AS (
  SELECT p.oid FROM pg_proc p WHERE p.oid = to_regprocedure('public.record_attendance_event(uuid,text,timestamp with time zone,text)')
)
SELECT 'function_is_090' AS check_name,
       coalesce((SELECT body = 'b27723bfaaf334678d8d23bb1c1f0756' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM f), FALSE) AS ok
-- Signed-in people call it (the app); anon does not.
UNION ALL SELECT 'function_grants',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM f), FALSE)
-- 050's four-argument function is still there for app builds from before 090, with its grants.
UNION ALL SELECT '050_function_kept',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM old), FALSE)
-- One function of each name: neither is overloaded (PostgREST never chooses between two).
UNION ALL SELECT 'no_overloads',
  (SELECT count(*) FILTER (WHERE p.proname = 'record_attendance_event') = 1 AND count(*) FILTER (WHERE p.proname = 'record_attendance_event_in_company') = 1
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public');
