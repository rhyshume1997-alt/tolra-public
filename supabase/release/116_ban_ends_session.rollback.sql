-- 116 rollback: ONLY with Rhys's approval. Puts back 017's public.session_is_active and 036's public._session_membership byte for
-- byte (same signatures, security, search_path and grants). From then on a disabled sign-in (auth.users.banned_until) is again
-- Auth's alone: an access token already issued keeps working at REST/RPC and Storage until it expires (finding S6-1 is open again).
-- No row, table, policy, trigger, grant or setting is touched; the request hook stays 017's. Run the whole text as one
-- transaction, then the release preflight (marker 116 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_active TEXT;
  v_member TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.session_is_active()') INTO v_active;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') INTO v_member;
  -- af6457ca...: 116's session_is_active; 19fe2195...: 017's (a second run of this rollback).
  IF v_active IS NULL OR v_active NOT IN ('af6457cae4d8b89cd34b5963574fbe58', '19fe21959a87cd880feb0fb0190980eb') THEN
    RAISE EXCEPTION '116 rollback: session_is_active (md5 %) is neither 116''s nor 017''s; stop and compare', coalesce(v_active, 'missing');
  END IF;
  -- b9c4e5c7...: 116's _session_membership; a15c6833...: 036's.
  IF v_member IS NULL OR v_member NOT IN ('b9c4e5c7147e1c7893b4e586dae0be2e', 'a15c6833cefc4b752ceafce0a10730b2') THEN
    RAISE EXCEPTION '116 rollback: _session_membership (md5 %) is neither 116''s nor 036''s; stop and compare', coalesce(v_member, 'missing');
  END IF;
END
$$;

-- 017's session_is_active, verbatim (supabase/migrations/017_session_and_deferred_link_checks.sql).
CREATE OR REPLACE FUNCTION public.session_is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = nullif(auth.jwt() ->> 'session_id', '')::UUID
      AND s.user_id = auth.uid()
      AND (s.not_after IS NULL OR s.not_after > now())
  )
$$;
REVOKE ALL ON FUNCTION public.session_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_is_active() TO authenticated, service_role;

-- 036's _session_membership, verbatim (supabase/migrations/036_two_level_access.sql).
CREATE OR REPLACE FUNCTION public._session_membership()
RETURNS TABLE (organization_id UUID, role TEXT, secondary_role TEXT, is_support BOOLEAN, expires_at TIMESTAMPTZ, elevated_until TIMESTAMPTZ, hidden_sections TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH me AS (
    -- A platform owner works in no company at all on a token that has not passed the second step (aal2): cross-company access
    -- always needs it, whatever REQUIRE_ADMIN_MFA says.
    SELECT p.id,
           EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p.id) AS platform_owner
    FROM public.user_profiles p
    WHERE p.id = auth.uid() AND p.active = TRUE AND p.must_change_password = FALSE
      AND (coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
           OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p.id))
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
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.session_is_active()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '19fe21959a87cd880feb0fb0190980eb')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a15c6833cefc4b752ceafce0a10730b2') THEN
    RAISE EXCEPTION '116 rollback: session_is_active / _session_membership are not 017''s / 036''s afterwards';
  END IF;
END
$$;

COMMIT;
