-- Migration 092 (an admin's Release machine also ends the job time it stopped). Read only: every row should be TRUE. Bodies are
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH lc AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)')
),
mrl AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.machine_runs_labour()')
),
rm AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_machine(uuid, text)')
),
trg AS (
  SELECT t.tgfoid, t.tgenabled, t.tgtype, t.tgattr
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.machine_runs'::regclass AND t.tgname = 'zz_machine_runs_labour'
)
-- labour_close (internal, invoker): 051's body plus end_reason from quoteflow.release_reason on an 'admin_released' end.
SELECT 'labour_close_is_092' AS check_name,
       coalesce((SELECT body = '05c6a7a7b87e77ff928a235bec2a4635' AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM lc), FALSE) AS ok
-- machine_runs_labour (trigger, definer): an admin's release ends labour as a Pause does.
UNION ALL SELECT 'machine_runs_labour_is_092',
  coalesce((SELECT body = '48f0b169d1beb1de9976f542ac182b3e' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
              AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM mrl), FALSE)
-- release_machine (definer): 044's body plus the reason setting; still callable by authenticated only (it checks admin itself).
UNION ALL SELECT 'release_machine_is_092',
  coalesce((SELECT body = 'f3d62432af1642a30ff8045c543f8d3d' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM rm), FALSE)
-- 051's trigger: AFTER INSERT OR UPDATE OF ended_at FOR EACH ROW (tgtype 21 = ROW | INSERT | UPDATE), enabled, on ended_at only.
UNION ALL SELECT 'trigger_on_machine_runs',
  coalesce((SELECT tgfoid = to_regprocedure('public.machine_runs_labour()') AND tgenabled = 'O' AND tgtype = 21
              AND (SELECT array_agg(a.attname::TEXT) FROM unnest(tgattr::INT2[]) AS k(attnum)
                   JOIN pg_attribute a ON a.attrelid = 'public.machine_runs'::regclass AND a.attnum = k.attnum) = ARRAY['ended_at'] FROM trg), FALSE)
-- Who and why: end_reason TEXT with its 3 to 500 character check, and 'admin_released' allowed as an end source.
UNION ALL SELECT 'end_reason_column_and_check',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_sessions' AND column_name = 'end_reason' AND data_type = 'text' AND is_nullable = 'YES')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.operator_sessions'::regclass AND c.conname = 'operator_sessions_end_reason' AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) LIKE '%length(btrim(end_reason))%')
UNION ALL SELECT 'end_source_allows_admin_released',
  (SELECT count(*) = 1 FROM pg_constraint c WHERE c.conrelid = 'public.operator_sessions'::regclass AND c.conname = 'operator_sessions_end_source_check'
     AND pg_get_constraintdef(c.oid) LIKE '%''admin_released''%' AND pg_get_constraintdef(c.oid) LIKE '%''machine_override''%' AND pg_get_constraintdef(c.oid) LIKE '%''correction''%')
-- 092 changes no policy or grant: job time is still read-only to the API, read through 051's policy.
UNION ALL SELECT 'sessions_policy_and_grants_unchanged',
  (SELECT count(*) = 1 FROM pg_policy p WHERE p.polrelid = 'public.operator_sessions'::regclass)
  AND has_table_privilege('authenticated', 'public.operator_sessions', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.operator_sessions', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.operator_sessions', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.operator_sessions', 'DELETE') AND NOT has_table_privilege('anon', 'public.operator_sessions', 'SELECT');
