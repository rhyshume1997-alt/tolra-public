-- Read only: after release 160 (the older reopen function can no longer be called from the browser; phase 160, after 156 in
-- supabase/release-plan.json), every row must say true. Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this
-- file only reads. Proves: authenticated, anon and PUBLIC cannot execute public.reopen_job(uuid, text) (by privilege and by ACL entry); its
-- body is still 081's; its owner can still run it; 113's request and sign-off functions are still callable by signed-in users (and not anon)
-- and still reach reopen_job as their owner (reopen_preview and reopen_record directly, decide_reopen_request through the internal helper); 081's other two browser functions are untouched; release preflight's 160 marker condition holds.
-- service_role's grant is not judged here (160 leaves it as it was).
-- EXPECTED CHANGE IN THE HISTORICAL 081 CHECK: after release 160, supabase/verify/job_flow_081.sql (unchanged, frozen with migration 081), row
-- api_functions_signed_in_only, reports FALSE by design, because it still expects authenticated EXECUTE on reopen_job. That is the expected and
-- only change 160 causes in that file's result (its two delivery_note_try_draft rows have been false since migration 099, independently). Release
-- 160's own verification (this file) is the current check; the last row below proves the 081 row is false for that one reason only.
-- A read-only script cannot reopen a job, so the rows prove the structural conditions for authorised reopening (113's three functions exist, are
-- definer with the pinned search_path, share reopen_job's owner and are executable by signed-in users; reopen_job's body and the owner's EXECUTE are unchanged).
-- The behavioural proof (request and sign-off reopen, workshop self-reopen with the no-admin tick box, an invoiced job through the sign-off workflow,
-- direct call refused) is in tests/db/legacy-reopen-revoke-160.test.ts.
-- Never re-run 081's release file after 160 (it self-checks authenticated EXECUTE on reopen_job and refuses): roll 160 back first.
WITH rj AS (SELECT p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body_md5
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)'))
SELECT 'reopen_job: authenticated, anon and PUBLIC cannot execute it' AS check_name,
  coalesce((SELECT NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM rj), FALSE) AS ok
UNION ALL SELECT 'reopen_job: no ACL entry names PUBLIC, anon or authenticated',
  coalesce((SELECT NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(rj.proacl, acldefault('f', rj.proowner))) a
                               WHERE a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))) FROM rj), FALSE)
UNION ALL SELECT 'reopen_job: body is still 081''s (md5 2fca7e71...), definer, pinned search_path',
  coalesce((SELECT body_md5 = '2fca7e7164a55f9f9e0744f8a0c6b50e' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM rj), FALSE)
UNION ALL SELECT 'reopen_job: its owner can still execute it (113''s definer functions call it as the owner)',
  coalesce((SELECT has_function_privilege(proowner, oid, 'EXECUTE') FROM rj), FALSE)
UNION ALL SELECT '113: reopen_preview, reopen_record and decide_reopen_request are definer, callable by signed-in users, not anon, and owned like reopen_job',
  (SELECT count(*) = 3 AND bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND p.proowner = (SELECT proowner FROM rj)
                                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.reopen_preview(text,uuid)'), to_regprocedure('public.reopen_record(text,uuid,text,text)'), to_regprocedure('public.decide_reopen_request(uuid,text,text)')))
UNION ALL SELECT '113: the signed-off helper is still internal (no grant to signed-in users) and the definer functions still reach reopen_job',
  coalesce((SELECT NOT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND position('RETURN public.reopen_job(p_job, p_reason)' IN p.prosrc) > 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public._reopen_job_signed_off(uuid,text)')), FALSE)
  AND coalesce((SELECT position('public.reopen_job(' IN p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_preview(text,uuid)')), FALSE)
  AND coalesce((SELECT position('public.reopen_job(' IN p.prosrc) > 0 AND position('public._reopen_job_signed_off(' IN p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_record(text,uuid,text,text)')), FALSE)
  AND coalesce((SELECT position('public._reopen_job_signed_off(' IN p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.decide_reopen_request(uuid,text,text)')), FALSE)
UNION ALL SELECT '081: inspect_job and release_job_early are still callable by signed-in users only',
  (SELECT count(*) = 2 AND bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'), to_regprocedure('public.release_job_early(uuid,text)')))
UNION ALL SELECT 'historical 081 check: its api_functions_signed_in_only row is false by design after 160, for this one reason only (authenticated lacks EXECUTE on reopen_job; inspect_job and release_job_early keep it, anon and PUBLIC have none)',
  coalesce((SELECT NOT has_function_privilege('authenticated', rj.oid, 'EXECUTE') FROM rj), FALSE)
  AND (SELECT count(*) = 2 AND bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
                                         AND p.prosecdef AND position('assert_privileged_aal' IN pg_get_functiondef(p.oid)) > 0)
       FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'), to_regprocedure('public.release_job_early(uuid,text)')))
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 160 legacy_reopen_revoke" condition holds',
  coalesce((SELECT rj.body_md5 = '2fca7e7164a55f9f9e0744f8a0c6b50e' AND NOT has_function_privilege('authenticated', rj.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', rj.oid, 'EXECUTE') AND NOT has_function_privilege('public', rj.oid, 'EXECUTE')
                   AND to_regprocedure('public.reopen_record(text,uuid,text,text)') IS NOT NULL FROM rj), FALSE);
