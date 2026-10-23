-- =====================================================================================================
-- 039: the platform owner's "New company" is checked and recorded by the database. One migration for the change.
--
-- Until now the route (app/api/platform/organizations) called public.create_organization (007; service role only) with the
-- service role after its own platform-owner checks, so the only gate was the app and the only record a server log line.
--
-- 1. public.platform_create_organization(name, slug, admin e-mail), SECURITY DEFINER, called with the platform owner's own session:
--    * refused (42501) unless the caller is on the platform owner list (is_platform_admin(), 036);
--    * refused (42501, hint mfa_required) unless the caller's token passed the second step (assert_platform_aal(), 036), exactly as
--      platform_list_organizations does;
--    * creates the company with the unchanged create_organization (007): the same checks, settings, first admin (membership or
--      invite), and the same "slug ... is already used" refusal;
--    * writes a permanent audit row in the same transaction: PLATFORM_CREATE_ORGANIZATION on organizations / the new company's id, in
--      the new company's audit chain (security_audit.set_audit_hash, 006, chains and hashes it), with the actor, the actor's e-mail,
--      metadata source 'platform', the slug and the first admin's e-mail as create_organization stores it (trimmed, lower case).
--      If anything fails, nothing is created and nothing is recorded.
--    Executable by authenticated only (not anon, not PUBLIC). create_organization keeps its grants: still service role only.
--    create_organization and the audit insert run with the request's JWT claims set to '{}' (restored straight after, in the same
--    transaction), as create_organization ran before under the service role. Without that, the triggers of 006 and 036 would judge the platform owner
--    by the company their session happens to be in: organization_settings_guard_nav refuses the new company's profile unless that
--    company's role is admin, and support_read_only (on the new company's tables and on audit_log) refuses while they view a company
--    as read-only support. Neither concerns the new company. The actor is read before the claims are cleared and recorded on the audit row.
-- 2. Nothing else changes: no table, policy or other function.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The function --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_create_organization(p_name TEXT, p_slug TEXT, p_admin_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID;
  v_uid    UUID;
  v_email  TEXT;
  v_claims TEXT;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  v_uid := auth.uid();
  v_email := coalesce(nullif(auth.jwt() ->> 'email', ''), (SELECT u.email FROM auth.users u WHERE u.id = v_uid));

  v_claims := current_setting('request.jwt.claims', TRUE);
  -- auth.uid() is NULL here exactly as it was under the old service-role call (a service-role JWT has no sub), so create_organization behaves the same.
  PERFORM set_config('request.jwt.claims', '{}', TRUE);
  v_org := public.create_organization(p_name, p_slug, p_admin_email, '{}'::JSONB);
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_uid, v_email,
          'PLATFORM_CREATE_ORGANIZATION', 'organizations', v_org::TEXT,
          jsonb_build_object('source', 'platform', 'slug', p_slug, 'admin_email', lower(btrim(p_admin_email))));
  PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), TRUE);
  RETURN v_org;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Who may call it: authenticated only ---------------------------------------------------------
REVOKE ALL ON FUNCTION public.platform_create_organization(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_create_organization(TEXT, TEXT, TEXT) TO authenticated;
COMMENT ON FUNCTION public.platform_create_organization(TEXT, TEXT, TEXT) IS
  'Platform owner only (is_platform_admin, aal2). Creates a company with create_organization and records PLATFORM_CREATE_ORGANIZATION in its audit log, in one transaction.';
