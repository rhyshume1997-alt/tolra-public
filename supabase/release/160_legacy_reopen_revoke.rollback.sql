-- Rollback of release step 160 (the older reopen function can no longer be called from the browser). One transaction.
-- Puts back 081's grant on public.reopen_job(uuid, text): EXECUTE for authenticated (081 also revoked PUBLIC and anon, and 160 never
-- granted either, so nothing else is needed). INPUTS: none. OUTPUTS: that one grant. MUST NOT CHANGE: reopen_job's body, service_role's grant,
-- any other function's grants, any policy or trigger. Running it twice equals running it once.
-- WARNING: after this rollback a signed-in user can reopen a job by calling reopen_job directly, skipping 113's reopen request and sign-off
-- (defect J1 is open again). Use it only if the request and sign-off screen cannot be used.
-- Refuses, changing nothing, if reopen_job is missing, is not 081's body, or has grants that are neither 160's nor 081's.
BEGIN;
DO $rollback_guard$
DECLARE
  v_job OID := to_regprocedure('public.reopen_job(uuid,text)');
BEGIN
 IF v_job IS NULL THEN
  RAISE EXCEPTION '160 rollback: public.reopen_job(uuid, text) is missing; nothing to restore';
 END IF;
 IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = v_job) IS DISTINCT FROM '2fca7e7164a55f9f9e0744f8a0c6b50e' THEN
  RAISE EXCEPTION '160 rollback: public.reopen_job is not 081''s body; stop and compare it first';
 END IF;
 IF has_function_privilege('anon', v_job, 'EXECUTE') OR has_function_privilege('public', v_job, 'EXECUTE') THEN
  RAISE EXCEPTION '160 rollback: reopen_job grants are neither 160''s nor 081''s (anon or PUBLIC can execute it); stop and compare them first';
 END IF;
END $rollback_guard$;

-- Before: the same fingerprint of everything the rollback must not touch as the release takes. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p160_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p160fp$
  SELECT 'other function grants'::TEXT, md5(coalesce(string_agg(p.oid::regprocedure::TEXT || '=' || coalesce(p.proacl::TEXT, 'default') || '/' || p.proowner::TEXT, E'\n' ORDER BY p.oid::regprocedure::TEXT), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.oid IS DISTINCT FROM to_regprocedure('public.reopen_job(uuid,text)')
  UNION ALL SELECT 'other function bodies', md5(coalesce(string_agg(p.oid::regprocedure::TEXT || '=' || md5(p.prosrc) || p.prosecdef::TEXT || coalesce(p.proconfig::TEXT, ''), E'\n' ORDER BY p.oid::regprocedure::TEXT), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.oid IS DISTINCT FROM to_regprocedure('public.reopen_job(uuid,text)')
  UNION ALL SELECT 'public relation grants', md5(coalesce(string_agg(c.oid::regclass::TEXT || '=' || coalesce(c.relacl::TEXT, 'default'), E'\n' ORDER BY c.oid::regclass::TEXT), ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL SELECT 'policies', md5(coalesce(string_agg(pol.polrelid::regclass::TEXT || '.' || pol.polname || ':' || pol.polcmd::TEXT || pol.polroles::TEXT || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''), E'\n' ORDER BY pol.polrelid::regclass::TEXT, pol.polname), ''))
  FROM pg_policy pol
  UNION ALL SELECT 'triggers', md5(coalesce(string_agg(t.tgrelid::regclass::TEXT || '.' || t.tgname || ':' || t.tgenabled::TEXT || pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'reopen_job body, owner, service_role grant and owner grant', md5(md5(p.prosrc) || p.proowner::TEXT || p.prosecdef::TEXT || coalesce(p.proconfig::TEXT, '')
         || has_function_privilege('service_role', p.oid, 'EXECUTE')::TEXT || has_function_privilege(p.proowner, p.oid, 'EXECUTE')::TEXT)
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)')
$p160fp$;
CREATE TEMP TABLE p160_before ON COMMIT DROP AS SELECT * FROM pg_temp.p160_fingerprint();

GRANT EXECUTE ON FUNCTION public.reopen_job(uuid, text) TO authenticated;

DO $rollback_self_check$
BEGIN
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE')
     OR has_function_privilege('public', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '160 rollback self-check: reopen_job must be executable by authenticated only (081''s grants)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2fca7e7164a55f9f9e0744f8a0c6b50e') THEN
    RAISE EXCEPTION '160 rollback self-check: reopen_job''s body changed';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p160_before EXCEPT SELECT * FROM pg_temp.p160_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p160_fingerprint() EXCEPT SELECT * FROM pg_temp.p160_before) THEN
    RAISE EXCEPTION '160 rollback self-check: another function, grant, policy or trigger, or reopen_job''s body, owner or service_role grant changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p160_before;
DROP FUNCTION pg_temp.p160_fingerprint();
COMMIT;
