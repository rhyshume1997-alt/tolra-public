-- Post-144 release step 160 (the older reopen function can no longer be called from the browser; registered in supabase/release-plan.json
-- as phase 160, after 156; CI's post-144 step installs it). One transaction; never part of baseline replay. Not applied anywhere hosted.
-- Canonical source: supabase/proposals/p160_legacy_reopen_revoke.sql (its body between BEGIN; and COMMIT; is copied below verbatim between
-- the fingerprint and the self-check; read its header). Production only with Rhys's separate yes.
-- Verify: supabase/verify/legacy_reopen_revoke_160.sql (every row true).
-- Rollback: supabase/release/160_legacy_reopen_revoke.rollback.sql (puts back 081's grant: EXECUTE for authenticated).
-- Defect J1 (P0): a signed-in user could call public.reopen_job directly and reopen a Complete job, skipping 113's reopen request and
-- sign-off. 160 revokes EXECUTE on reopen_job (uuid, text) from PUBLIC, anon and authenticated and changes nothing else.
-- INPUTS: none. OUTPUTS: reopen_job's EXECUTE grants. MUST NOT CHANGE: reopen_job's body (md5 2fca7e71...), service_role's grant, any other
-- function's grants, any policy or trigger, 113's functions (which call reopen_job as their owner, so the request and sign-off keep working).
-- REFUSES, changing nothing, unless: release 113 is in place (without it the old function is the only way to reopen), reopen_job exists with
-- the pinned body and is definer with its pinned search_path, and its grants are 081's (authenticated only) or already 160's (nobody in the
-- browser roles). Running this file again once applied changes nothing.
-- RE-RUN CAVEAT: 081's own release file (supabase/release/081_job_flow_release.release.sql) self-checks that authenticated can execute
-- reopen_job, so it would refuse after 160. Never re-run the 081 release after 160; roll 160 back first.
-- EXPECTED CHANGE: supabase/verify/job_flow_081.sql (historical, unchanged) row api_functions_signed_in_only reports false by design after 160 (it still expects
-- authenticated EXECUTE on reopen_job); that is the only change 160 causes in its result. 160's own verify file is the current check.
-- The app's legacy fallback (lib/reopen-sign-off.ts) calls reopen_job directly, but only when 113's functions are missing; it would then fail visibly.
BEGIN;
DO $post_release_guard$
DECLARE
  v_job   OID := to_regprocedure('public.reopen_job(uuid,text)');
  v_owner OID;
  v_auth  BOOLEAN;
  v_anon  BOOLEAN;
  v_pub   BOOLEAN;
  f       TEXT;
BEGIN
 IF v_job IS NULL THEN
  RAISE EXCEPTION '160: public.reopen_job(uuid, text) is missing (081 not applied); stop and check release preflight';
 END IF;
 IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = v_job) IS DISTINCT FROM '2fca7e7164a55f9f9e0744f8a0c6b50e' THEN
  RAISE EXCEPTION '160: public.reopen_job is not 081''s body; stop and compare it first';
 END IF;
 SELECT p.proowner INTO v_owner FROM pg_proc p WHERE p.oid = v_job;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_job AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) THEN
  RAISE EXCEPTION '160: public.reopen_job is not SECURITY DEFINER with search_path pg_catalog, public; stop and compare it first';
 END IF;
 -- Release 113 must be in place: its three definer functions call reopen_job as their owner and are the only way left to reopen.
 IF to_regclass('public.reopen_requests') IS NULL OR to_regprocedure('public._reopen_job_signed_off(uuid,text)') IS NULL THEN
  RAISE EXCEPTION '160: release 113 (reopen sign-off) is missing; without it reopen_job would be the only way to reopen. Apply 113 first';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.reopen_preview(text,uuid)', 'public.reopen_record(text,uuid,text,text)', 'public.decide_reopen_request(uuid,text,text)'] LOOP
  IF to_regprocedure(f) IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(f) AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                      AND p.proowner = v_owner AND position('reopen_job' IN p.prosrc) > 0)
     OR NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') THEN
   RAISE EXCEPTION '160: % is missing, is not 113''s definer function owned like reopen_job, or has the wrong grants; stop and check release 113', f;
  END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public._reopen_job_signed_off(uuid,text)') AND p.proowner = v_owner AND NOT p.prosecdef)
    OR has_function_privilege('authenticated', to_regprocedure('public._reopen_job_signed_off(uuid,text)'), 'EXECUTE') THEN
  RAISE EXCEPTION '160: public._reopen_job_signed_off is not 113''s internal helper; stop and check release 113';
 END IF;
 v_auth := has_function_privilege('authenticated', v_job, 'EXECUTE');
 v_anon := has_function_privilege('anon', v_job, 'EXECUTE');
 v_pub  := has_function_privilege('public', v_job, 'EXECUTE');
 -- 081's grants: authenticated only. 160's: none of the three. Anything else is somebody's edit: refuse.
 IF v_anon OR v_pub THEN
  RAISE EXCEPTION '160: reopen_job grants are neither 081''s (authenticated only) nor 160''s (no browser role): authenticated %, anon %, PUBLIC %; stop and compare them first', v_auth, v_anon, v_pub;
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 160 must not touch: every other function's grants, bodies and settings, relation grants in public,
-- policies and triggers; and reopen_job's own body, owner, service_role grant and owner grant. The self-check requires the identical
-- fingerprint. Session-only helper, dropped before COMMIT.
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

-- ---- 1. The older reopen function is not for the browser ----------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reopen_job(uuid, text) FROM PUBLIC, anon, authenticated;

DO $p160_self_check$
BEGIN
  IF has_function_privilege('authenticated', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE')
     OR has_function_privilege('public', to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '160 self-check: authenticated, anon or PUBLIC can still execute reopen_job';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)') AND a.privilege_type = 'EXECUTE'
               AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')))) THEN
    RAISE EXCEPTION '160 self-check: reopen_job''s ACL still names PUBLIC, anon or authenticated';
  END IF;
  IF NOT has_function_privilege((SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)')), to_regprocedure('public.reopen_job(uuid,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '160 self-check: the owner can no longer execute reopen_job (113''s functions need it)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_job(uuid,text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2fca7e7164a55f9f9e0744f8a0c6b50e') THEN
    RAISE EXCEPTION '160 self-check: reopen_job''s body changed';
  END IF;
  -- 113's workflow stays open to signed-in users.
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.reopen_preview(text,uuid)'), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.reopen_record(text,uuid,text,text)'), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.decide_reopen_request(uuid,text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '160 self-check: 113''s reopen functions are no longer callable by signed-in users';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p160_before EXCEPT SELECT * FROM pg_temp.p160_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p160_fingerprint() EXCEPT SELECT * FROM pg_temp.p160_before) THEN
    RAISE EXCEPTION '160 self-check: another function, grant, policy or trigger, or reopen_job''s body, owner or service_role grant changed';
  END IF;
END
$p160_self_check$;
DROP TABLE pg_temp.p160_before;
DROP FUNCTION pg_temp.p160_fingerprint();
COMMIT;
