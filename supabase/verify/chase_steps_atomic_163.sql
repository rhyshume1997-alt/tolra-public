-- Release 163 (the chase steps save is one database call; phase 163 in supabase/release-plan.json). Read only: every row should be TRUE (8).
-- Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this file only reads. The function body is compared with every
-- whitespace character removed (an SQL-editor paste may store CRLF). The behavioural proof is tests/db/chase-steps-atomic-163.test.ts.
WITH f AS (SELECT p.oid, p.prosecdef, p.proconfig, p.prorettype, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body_md5
           FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)'))
SELECT 'function exists, exactly one of that name' AS check_name,
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_chase_steps_atomic') = 1
       AND EXISTS (SELECT 1 FROM f) AS ok
UNION ALL SELECT 'body is 163''s (md5 63145f30...)', coalesce((SELECT body_md5 = '63145f3026fdc7db5dc1ba0a5928177a' FROM f), FALSE)
UNION ALL SELECT 'invoker with pinned search_path, returns jsonb',
       coalesce((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] AND prorettype = 'jsonb'::regtype FROM f), FALSE)
UNION ALL SELECT 'signed-in users can execute it; anon and PUBLIC cannot',
       coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM f), FALSE)
UNION ALL SELECT 'no ACL entry names PUBLIC or anon',
       coalesce((SELECT NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE p.oid = f.oid AND a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'anon'))) FROM f), FALSE)
UNION ALL SELECT '138 is in place: chase_steps with row security on and its guard trigger enabled',
       coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.chase_steps')), FALSE)
       AND (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.chase_steps') AND t.tgname = 'chase_steps_guard' AND t.tgenabled = 'O') = 1
UNION ALL SELECT 'the helpers it calls exist (assert_privileged_aal, my_session, has_org_role, current_user_organization_id)',
       to_regprocedure('public.assert_privileged_aal()') IS NOT NULL AND to_regprocedure('public.my_session()') IS NOT NULL
       AND to_regprocedure('public.has_org_role(text[])') IS NOT NULL AND to_regprocedure('public.current_user_organization_id()') IS NOT NULL
UNION ALL SELECT 'no browser write grant on chase_steps was added (anon has none; authenticated writes stay through row security)',
       NOT has_table_privilege('anon', 'public.chase_steps', 'INSERT') AND NOT has_table_privilege('anon', 'public.chase_steps', 'UPDATE') AND NOT has_table_privilege('anon', 'public.chase_steps', 'DELETE');
