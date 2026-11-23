-- Rollback of post-144 release step 164 (supabase/release/164_platform_companies.release.sql). Drops ONLY public.platform_company_overview() and
-- public.platform_set_organization_status(uuid, text, text, text), so the database is exactly as it was before 164 (164 created those two functions and
-- changed nothing else). Companies that were closed with the function stay closed (their status is data); reopen them first if they should work
-- again, because after this the owner's screen cannot reopen them until 164 is applied again.
-- STATE is judged by each function's exact body: ABSENT (nothing to do, refuses nothing), INSTALLED as 164 left it (dropped), DRIFTED (any other body,
-- security or search_path, or another overload of either name: REFUSES, changes nothing). The self-check compares the same fingerprint as the release
-- (every other function with grants, the organizations table and rows) before and after, and requires both functions gone.
-- Inputs: the database. Outputs: two functions removed. Must not change: anything else. Production only with Rhys's separate yes.
BEGIN;
DO $rollback_guard$
DECLARE
  v_ov OID := to_regprocedure('public.platform_company_overview()');
  v_st OID := to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)');
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_company_overview' AND p.oid IS DISTINCT FROM v_ov)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_set_organization_status' AND p.oid IS DISTINCT FROM v_st) THEN
  RAISE EXCEPTION '164 rollback: another function named platform_company_overview or platform_set_organization_status exists (a different argument list); stop and compare it first, nothing was changed';
 END IF;
 IF v_ov IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_ov AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'ed9d541cde10b9a815eb8fce4eae238f') THEN
  RAISE EXCEPTION '164 rollback: public.platform_company_overview() is not 164''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
 IF v_st IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_st AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4e4c0d80bc2b93a1656da5aeaa8eab8e') THEN
  RAISE EXCEPTION '164 rollback: public.platform_set_organization_status(uuid, text, text, text) is not 164''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
END $rollback_guard$;

LOCK TABLE public.organizations IN SHARE MODE;
CREATE FUNCTION pg_temp.p164_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p164fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname IN ('platform_company_overview', 'platform_set_organization_status'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'organizations: columns',
         md5(coalesce(string_agg(concat_ws('|', c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
  UNION ALL SELECT 'organizations: constraints',
         md5(coalesce(string_agg(concat_ws('|', k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.organizations'::regclass
  UNION ALL SELECT 'organizations: triggers',
         md5(coalesce(string_agg(concat_ws('|', t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.organizations'::regclass
  UNION ALL SELECT 'organizations: policies',
         md5(coalesce(string_agg(concat_ws('|', p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'organizations'
  UNION ALL SELECT 'organizations: row security, owner, grants',
         c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, '')
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.organizations'::regclass
  UNION ALL SELECT 'organizations rows', md5(coalesce(string_agg(to_jsonb(o)::TEXT, ';' ORDER BY o.id), ''))
  FROM public.organizations o
$p164fp$;
CREATE TEMP TABLE p164_before ON COMMIT DROP AS SELECT * FROM pg_temp.p164_fingerprint();

DROP FUNCTION IF EXISTS public.platform_company_overview();
DROP FUNCTION IF EXISTS public.platform_set_organization_status(uuid,text,text,text);

DO $rollback_self_check$
BEGIN
  IF to_regprocedure('public.platform_company_overview()') IS NOT NULL OR to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_company_overview', 'platform_set_organization_status')) THEN
    RAISE EXCEPTION '164 rollback self-check: a function is still there';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p164_before EXCEPT SELECT * FROM pg_temp.p164_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p164_fingerprint() EXCEPT SELECT * FROM pg_temp.p164_before) THEN
    RAISE EXCEPTION '164 rollback self-check: another function or the organizations table (structure or a row) changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p164_before;
DROP FUNCTION pg_temp.p164_fingerprint();
COMMIT;
