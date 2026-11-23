-- Post-144 release step 164 (the platform owner's Companies screen: counts per company, and Close or Reopen a company; registered in
-- supabase/release-plan.json as phase 164, after 163; CI's post-144 step installs it). One transaction; never part of baseline replay. Not applied
-- anywhere hosted. Canonical source: supabase/proposals/p164_platform_companies.sql (its body between BEGIN; and COMMIT; is copied below verbatim;
-- scripts/check-release-plan.mjs fails if they drift).
-- WHAT IT DOES: adds TWO functions and nothing else.
--   public.platform_company_overview(): one row per company (name, slug, status, active people, jobs, invoices, issued invoices). Platform owner
--   only (is_platform_admin and the second step, as 036's platform functions); anyone else is refused 42501.
--   public.platform_set_organization_status(p_org, p_status, p_confirm_name, p_reason): closes an active company or reopens a closed one, and
--   nothing else. Closing needs the platform owner, the second step, an authenticator code under 15 minutes old, the company's exact name typed
--   and a reason (5 to 500 characters), and is refused for the company the owner's own session is inside. Reopening needs the owner, the second
--   step and a reason. Each change writes PLATFORM_CLOSE_ORGANIZATION or PLATFORM_REOPEN_ORGANIZATION to that company's audit log in the same transaction.
-- WHAT IT DOES NOT DO: no company, person, job, invoice, setting or other row is created, changed or deleted (only organizations.status of the
-- named company changes, and only when the function is called); no table, column, policy or trigger is created or changed. A closed company is
-- already unusable (036 treats only an active company as usable) and platform_enter_organization already refuses it. Nothing is deleted anywhere.
-- It needs release 036 (two-level access) and the status values active, paused and closed of organizations. It needs nothing from 156 to 163.
-- EXECUTE: signed-in users (authenticated) only; not anon, not PUBLIC, not service_role. SECURITY DEFINER with a pinned search_path.
-- STATE is judged by each function's exact body (md5 of its source with every whitespace character removed, because an SQL-editor paste may
-- store CRLF): ABSENT (no function of that name in public): the release creates it. INSTALLED (that body, definer, pinned search_path): running again
-- changes nothing. DRIFTED (any other body, security or search_path, or another overload of either name): the file REFUSES and changes nothing.
-- Verify: supabase/verify/platform_companies_164.sql (every row true). Rollback: supabase/release/164_platform_companies.rollback.sql (drops only these
-- two functions; companies closed meanwhile stay closed, reopen them first if needed). Production only with Rhys's separate yes on this exact file
-- after a fresh backup.
-- Inputs: the database. Outputs: two functions. Must not change: any other function (the self-check compares a fingerprint of every other function in
-- public and security_audit with grants), the organizations table (columns, constraints, triggers, policies, grants, row security and every row)
-- (read under a SHARE lock on organizations, held to COMMIT, so no company changes while it runs), before and after.
BEGIN;
DO $post_release_guard$
DECLARE
  v_ov OID := to_regprocedure('public.platform_company_overview()');
  v_st OID := to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)');
BEGIN
 IF to_regclass('public.organizations') IS NULL OR to_regclass('public.organization_members') IS NULL OR to_regclass('public.jobs') IS NULL OR to_regclass('public.invoices') IS NULL
    OR to_regclass('security_audit.session_company') IS NULL OR to_regclass('security_audit.platform_admins') IS NULL OR to_regclass('security_audit.audit_log') IS NULL THEN
  RAISE EXCEPTION '164: a table it reads (organizations, organization_members, jobs, invoices, security_audit.session_company, platform_admins or audit_log) is missing; apply release 036 first (see release preflight)';
 END IF;
 IF to_regprocedure('public.is_platform_admin()') IS NULL OR to_regprocedure('public.assert_platform_aal()') IS NULL
    OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
  RAISE EXCEPTION '164: a helper it calls (is_platform_admin, assert_platform_aal or security_audit.log_named_event) is missing; apply release 036 first (see release preflight)';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.organizations'::regclass AND k.contype = 'c' AND pg_catalog.pg_get_constraintdef(k.oid) LIKE '%closed%') THEN
  RAISE EXCEPTION '164: organizations.status does not allow closed; stop and compare it first, nothing was changed';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_company_overview' AND p.oid IS DISTINCT FROM v_ov)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_set_organization_status' AND p.oid IS DISTINCT FROM v_st) THEN
  RAISE EXCEPTION '164: another function named platform_company_overview or platform_set_organization_status exists (a different argument list); stop and compare it first, nothing was changed';
 END IF;
 IF v_ov IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_ov AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'ed9d541cde10b9a815eb8fce4eae238f') THEN
  RAISE EXCEPTION '164: public.platform_company_overview() exists but is not 164''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
 IF v_st IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_st AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4e4c0d80bc2b93a1656da5aeaa8eab8e') THEN
  RAISE EXCEPTION '164: public.platform_set_organization_status(uuid, text, text, text) exists but is not 164''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
END $post_release_guard$;

-- The same lock the fingerprint's company rows need: no company can change between the fingerprint and the self-check. Held to COMMIT.
LOCK TABLE public.organizations IN SHARE MODE;
-- Before: a fingerprint of everything 164 must not touch. The self-check requires the identical fingerprint. Session-only helper, dropped before COMMIT.
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

-- ---- The functions (the proposal's body, unchanged) ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_company_overview()
RETURNS TABLE (organization_id uuid, name text, slug text, status text, user_count bigint, job_count bigint, invoice_count bigint, issued_invoice_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501', HINT = 'platform_required';
  END IF;
  PERFORM public.assert_platform_aal();
  RETURN QUERY
  SELECT o.id, o.name, o.slug, o.status,
         (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o.id AND m.active AND NOT m.support),
         (SELECT count(*) FROM public.jobs j WHERE j.organization_id = o.id),
         (SELECT count(*) FROM public.invoices i WHERE i.organization_id = o.id),
         (SELECT count(*) FROM public.invoices i WHERE i.organization_id = o.id AND lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled'))
  FROM public.organizations o
  ORDER BY o.name, o.id;
END $$;
REVOKE ALL ON FUNCTION public.platform_company_overview() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_company_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.platform_set_organization_status(p_org uuid, p_status text, p_confirm_name text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, security_audit AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_now     numeric := extract(epoch FROM now());
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_org     public.organizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501', HINT = 'platform_required';
  END IF;
  PERFORM public.assert_platform_aal();
  IF p_status IS NULL OR p_status NOT IN ('active', 'closed') THEN
    RAISE EXCEPTION 'Choose closed or active' USING ERRCODE = '22023', HINT = 'status_invalid';
  END IF;
  IF length(v_reason) < 5 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason (5 to 500 characters)' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  SELECT * INTO v_org FROM public.organizations o WHERE o.id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'P0002', HINT = 'company_not_found';
  END IF;
  IF p_status = 'closed' THEN
    IF NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) AS e
         WHERE e ->> 'method' IN ('totp', 'mfa/totp')
           AND CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e ->> 'timestamp')::numeric END BETWEEN v_now - 900 AND v_now + 60) THEN
      RAISE EXCEPTION 'Enter a fresh code from your authenticator app first.' USING ERRCODE = '42501', HINT = 'mfa_recent_required';
    END IF;
    IF btrim(coalesce(p_confirm_name, '')) IS DISTINCT FROM btrim(v_org.name) THEN
      RAISE EXCEPTION 'The name typed does not match this company.' USING ERRCODE = '22023', HINT = 'name_mismatch';
    END IF;
    IF v_session IS NOT NULL AND EXISTS (SELECT 1 FROM security_audit.session_company sc WHERE sc.session_id = v_session AND sc.organization_id = p_org) THEN
      RAISE EXCEPTION 'You are inside this company. Leave it first.' USING ERRCODE = '22023', HINT = 'inside_company';
    END IF;
  END IF;
  IF v_org.status = p_status THEN
    RETURN jsonb_build_object('organization_id', p_org, 'status', p_status, 'changed', false);
  END IF;
  IF NOT ((v_org.status = 'active' AND p_status = 'closed') OR (v_org.status = 'closed' AND p_status = 'active')) THEN
    RAISE EXCEPTION 'Only an active company can be closed, and a closed one reopened.' USING ERRCODE = '22023', HINT = 'status_transition';
  END IF;
  UPDATE public.organizations o SET status = p_status, updated_at = now() WHERE o.id = p_org;
  PERFORM security_audit.log_named_event(p_org, CASE WHEN p_status = 'closed' THEN 'PLATFORM_CLOSE_ORGANIZATION' ELSE 'PLATFORM_REOPEN_ORGANIZATION' END,
    'organizations', p_org::text, jsonb_build_object('from', v_org.status, 'to', p_status, 'reason', v_reason, 'actor', v_uid));
  RETURN jsonb_build_object('organization_id', p_org, 'status', p_status, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION public.platform_set_organization_status(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_set_organization_status(uuid, text, text, text) TO authenticated;

DO $p164_self_check$
BEGIN
  IF to_regprocedure('public.platform_company_overview()') IS NULL OR to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_company_overview', 'platform_set_organization_status')) <> 2 THEN
    RAISE EXCEPTION '164 self-check: both functions must exist, once each';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.platform_company_overview()') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND p.proretset
                   AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'ed9d541cde10b9a815eb8fce4eae238f') THEN
    RAISE EXCEPTION '164 self-check: platform_company_overview must be definer, with search_path pg_catalog, public, returning a table, with 164''s body (md5 ed9d541c...)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] AND p.prorettype = 'jsonb'::regtype
                   AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4e4c0d80bc2b93a1656da5aeaa8eab8e') THEN
    RAISE EXCEPTION '164 self-check: platform_set_organization_status must be definer, with search_path pg_catalog, public, security_audit, returning jsonb, with 164''s body (md5 4e4c0d80...)';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.platform_company_overview()'), 'EXECUTE') OR NOT has_function_privilege('authenticated', to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.platform_company_overview()'), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)'), 'EXECUTE')
     OR has_function_privilege('public', to_regprocedure('public.platform_company_overview()'), 'EXECUTE') OR has_function_privilege('public', to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)'), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure('public.platform_company_overview()'), 'EXECUTE') OR has_function_privilege('service_role', to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION '164 self-check: only signed-in users may execute the two functions (not anon, PUBLIC or service_role)';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p164_before EXCEPT SELECT * FROM pg_temp.p164_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p164_fingerprint() EXCEPT SELECT * FROM pg_temp.p164_before) THEN
    RAISE EXCEPTION '164 self-check: another function or the organizations table (structure or a row) changed';
  END IF;
END
$p164_self_check$;
DROP TABLE pg_temp.p164_before;
DROP FUNCTION pg_temp.p164_fingerprint();
COMMIT;
