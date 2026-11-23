-- Release 170 (module K worksheet builder: jobs.worksheet_custom and its sign-off guard; phase 170 in supabase/release-plan.json). Read only: every row should be TRUE (8).
-- Before 170 is applied, rows 1 to 5 are false (the last three read only what must stay true).
-- Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this file only reads. The function body is compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF). The behavioural proof is tests/db/worksheet-custom-170.test.ts.
WITH f AS (SELECT p.oid, p.prosecdef, p.proconfig, p.prorettype, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body_md5, p.proacl, p.proowner
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_worksheet_custom_lock()'))
SELECT 'jobs.worksheet_custom is jsonb NOT NULL default {}' AS check_name,
       EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom'
               AND c.data_type = 'jsonb' AND c.is_nullable = 'NO' AND c.column_default = '''{}''::jsonb') AS ok
UNION ALL SELECT 'the shape constraint exists and is validated',
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('public.jobs') AND k.conname = 'jobs_worksheet_custom_shape' AND k.contype = 'c' AND k.convalidated)
UNION ALL SELECT 'exactly one function of that name, with 170''s body (md5 a7d2d5df...)',
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'jobs_worksheet_custom_lock') = 1
       AND coalesce((SELECT body_md5 = 'a7d2d5df942ae0fc369d15d7bd7ee21c' FROM f), FALSE)
UNION ALL SELECT 'definer with pinned search_path, returns trigger',
       coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] AND prorettype = 'trigger'::regtype FROM f), FALSE)
UNION ALL SELECT 'the trigger is enabled, BEFORE UPDATE OF worksheet_custom, on jobs',
       (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_worksheet_custom_lock' AND t.tgenabled = 'O'
          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF worksheet_custom ON public.jobs FOR EACH ROW%') = 1
UNION ALL SELECT 'no browser role and not PUBLIC can execute the trigger function',
       NOT coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('public', oid, 'EXECUTE') FROM f), FALSE)
UNION ALL SELECT 'no ACL entry names PUBLIC or anon',
       NOT coalesce((SELECT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                                    WHERE a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'anon'))) FROM f), FALSE)
UNION ALL SELECT 'the lock reads only 045''s job_signoffs and jobs.worksheet_version (all exist)',
       to_regclass('public.job_signoffs') IS NOT NULL
       AND (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_signoffs' AND column_name IN ('job_id', 'worksheet_version', 'kind')) = 3
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'worksheet_version');
