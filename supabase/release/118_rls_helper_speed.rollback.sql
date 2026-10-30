-- 118 rollback: ONLY with Rhys's approval. Puts back 116's public._session_membership() byte for byte (LANGUAGE sql, same
-- signature, security and grants). Every helper and policy answers exactly as with 118; only the per-row cost returns. Run the
-- whole text as one transaction, then the release preflight (marker 118 shows "not applied", 116 still "applied").
BEGIN;
DO $$
DECLARE
  v_member TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') INTO v_member;
  -- 38ad8bd2...: 118's body; b9c4e5c7...: 116's (a second run of this rollback).
  IF v_member IS NULL OR v_member NOT IN ('38ad8bd255ea9a2d2b8713aa04eb7c82', 'b9c4e5c7147e1c7893b4e586dae0be2e') THEN
    RAISE EXCEPTION '118 rollback: _session_membership (md5 %) is neither 118''s nor 116''s; stop and compare', coalesce(v_member, 'missing');
  END IF;
END
$$;

-- 116's _session_membership, verbatim (supabase/migrations/116_ban_ends_session.sql).
CREATE OR REPLACE FUNCTION public._session_membership()
RETURNS TABLE (organization_id UUID, role TEXT, secondary_role TEXT, is_support BOOLEAN, expires_at TIMESTAMPTZ, elevated_until TIMESTAMPTZ, hidden_sections TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH me AS (
    -- A platform owner works in no company at all on a token that has not passed the second step (aal2): cross-company access
    -- always needs it, whatever REQUIRE_ADMIN_MFA says. A login whose sign-in is disabled (banned in Auth) works in none either (116).
    SELECT p.id,
           EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p.id) AS platform_owner
    FROM public.user_profiles p
    WHERE p.id = auth.uid() AND p.active = TRUE AND p.must_change_password = FALSE
      AND (coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
           OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p.id))
      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id AND u.banned_until > now())
  ),
  usable AS (
    SELECT m.organization_id, m.role, m.secondary_role, m.support, m.expires_at, m.hidden_sections, m.support_grant
    FROM me
    JOIN public.organization_members m ON m.user_id = me.id
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE o.status = 'active'
      AND m.active = TRUE
      AND (NOT m.support OR (me.platform_owner AND m.expires_at > now()))
  ),
  chosen AS (
    SELECT sc.organization_id, sc.elevated_until, sc.grant_id
    FROM security_audit.session_company sc
    JOIN me ON me.id = sc.user_id
    WHERE sc.session_id = nullif(auth.jwt() ->> 'session_id', '')::UUID
  )
  SELECT u.organization_id, u.role, u.secondary_role, u.support, u.expires_at,
         CASE WHEN u.support THEN c.elevated_until END, u.hidden_sections
  FROM usable u
  -- A support selection (and its elevation) only counts under the grant it was made under: a window that ended or was revoked and
  -- is opened again is a new grant, and no earlier session gets anything back.
  LEFT JOIN chosen c ON c.organization_id = u.organization_id AND (NOT u.support OR c.grant_id = u.support_grant)
  WHERE c.organization_id IS NOT NULL
     OR (NOT EXISTS (SELECT 1 FROM chosen c2 JOIN usable u2 ON u2.organization_id = c2.organization_id)
         AND NOT u.support
         AND NOT (SELECT me.platform_owner FROM me)
         AND (SELECT count(*) FROM usable u3 WHERE NOT u3.support) = 1)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._session_membership() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b9c4e5c7147e1c7893b4e586dae0be2e' OR NOT p.prosecdef OR p.provolatile <> 's'
             OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql')
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
             OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()')) IS NOT FALSE THEN
    RAISE EXCEPTION '118 rollback: _session_membership is not 116''s after the replace';
  END IF;
END
$$;

COMMIT;
