-- Release 164 proposal (canonical source of supabase/release/164_platform_companies.release.sql; its body below is copied into that file verbatim, and
-- scripts/check-release-plan.mjs fails if the two drift). Adds the two functions the platform owner's Companies screen needs and production lacks:
--   public.platform_company_overview()  one row per company: name, slug, status, active people, jobs, invoices and issued invoices.
--   public.platform_set_organization_status(p_org uuid, p_status text, p_confirm_name text, p_reason text)  Close a company (typed name, a fresh
--   authenticator code, a reason) or reopen it (active again). Nothing is deleted: only organizations.status changes, active <-> closed.
-- Platform owner only (is_platform_admin and the second step, as 036's platform functions), SECURITY DEFINER with search_path pinned, EXECUTE for
-- signed-in users only. Both need release 036 (two-level access); a closed company already stops its people signing in (036 treats only an active
-- company as usable) and platform_enter_organization already refuses it. No table, column, policy or trigger is created or changed. Not applied anywhere hosted.
BEGIN;
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
COMMIT;
