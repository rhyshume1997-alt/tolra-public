-- =====================================================================================================
-- 119: a disabled sign-in ends the session at once (finding S6-1). Needs 017 (session_is_active, check_request_session, the
-- PostgREST request hook) and 036 (_session_membership). Touches no other migration's objects.
--
-- THE GAP. Admin > Users "Disable sign-in" (app/api/admin/users/sign-in/route.ts) and the platform owner's ban only set
-- auth.users.banned_until in Supabase Auth and keep the membership active. Auth then refuses sign-in and token refresh, but an
-- access token already issued kept working at REST/RPC (and Storage) until it expired (up to an hour): no database function read
-- banned_until, so session_is_active() stayed true and every row helper still answered. "Deactivate" was never affected (it turns
-- the membership off, which _session_membership refuses at once).
--
-- WHAT CHANGES. Two functions, same names, signatures, owner, SECURITY DEFINER, search_path, volatility and grants. Nothing else:
-- no table, row, policy, trigger, grant or setting; check_request_session and the request hook are NOT replaced (the hook calls
-- session_is_active, so it now refuses a banned login too).
--   a. public.session_is_active() (017): also false while the token's login is banned (auth.users.banned_until > now(), Auth's own
--      test of a ban). So check_request_session, run by PostgREST before every signed-in REST/RPC request, refuses it with 017's
--      28000 "Your session has ended. Sign in again." (the client already treats that as a session that ended: the offline queue
--      and copies are kept, lib/session-end.ts), and 033's Storage rules, which call it too, refuse the same token.
--   b. public._session_membership() (036): a banned login has no membership, so every access helper and row rule answers nothing
--      for it even where the request hook does not run (a plain SQL session, a function called inside a request).
--   An unban (banned_until NULL or in the past) gives the same token everything back while it is still valid, exactly as before.
--   Every other rule is unchanged: a deactivated or deleted membership, a disabled profile, a forced password change, a company not
--   'active', a support window, grant or elevation, a platform owner's aal2, an ended or timed-out session.
-- GUARD (section 1): each function must be 017's / 036's (or already 119's), md5 with every whitespace character removed; and the
-- owner must be able to read auth.users.banned_until. Safe to run again, also after 121 (S11), which runs this file's
-- _session_membership query, unchanged, from PL/pgSQL: the guard accepts 121's body too, and re-running this file puts this
-- file's SQL body back (the same answers, only slower) until 121 is re-run after it, as the run sheet re-runs files in order.
-- SELF-CHECK (section 4). Verify: supabase/verify/ban_ends_session_119.sql (every row TRUE).
-- Rollback: supabase/release/119_ban_ends_session.rollback.sql (puts back 017's and 036's bodies; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: both functions are the ones this file was written against; auth.users carries banned_until.
DO $$
DECLARE
  v_active TEXT;
  v_member TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.session_is_active()') INTO v_active;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') INTO v_member;
  -- 19fe21959a87cd880feb0fb0190980eb: 017's session_is_active; af6457cae4d8b89cd34b5963574fbe58: this file's (section 2).
  IF v_active IS NULL OR v_active NOT IN ('19fe21959a87cd880feb0fb0190980eb', 'af6457cae4d8b89cd34b5963574fbe58') THEN
    RAISE EXCEPTION '119: public.session_is_active is not 017''s (md5 without whitespace %); stop and compare it first', coalesce(v_active, 'missing');
  END IF;
  -- a15c6833cefc4b752ceafce0a10730b2: 036's _session_membership; dd70574344856582b9819431b45e6c5c: this file's (section 3);
  -- 4fa415c7b3222def6c37e93353e804c2: 121's (this file's query run by PL/pgSQL; a re-run of 119 after 121, see the header).
  IF v_member IS NULL OR v_member NOT IN ('a15c6833cefc4b752ceafce0a10730b2', 'dd70574344856582b9819431b45e6c5c', '4fa415c7b3222def6c37e93353e804c2') THEN
    RAISE EXCEPTION '119: public._session_membership is not 036''s (md5 without whitespace %); stop and compare it first', coalesce(v_member, 'missing');
  END IF;
  IF to_regprocedure('public.check_request_session()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until')
     OR NOT has_column_privilege(current_user, 'auth.users', 'banned_until', 'SELECT') THEN
    RAISE EXCEPTION '119: 017''s check_request_session, or auth.users.banned_until (readable by %), is missing', current_user;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. session_is_active: 017's text plus the ban test. A banned login's session counts as ended.
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
      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id AND u.banned_until > now())
  )
$$;
REVOKE ALL ON FUNCTION public.session_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_is_active() TO authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 3. _session_membership: 036's text plus the same ban test on the person (the "me" row). A banned login works in no company.
CREATE OR REPLACE FUNCTION public._session_membership()
RETURNS TABLE (organization_id UUID, role TEXT, secondary_role TEXT, is_support BOOLEAN, expires_at TIMESTAMPTZ, elevated_until TIMESTAMPTZ, hidden_sections TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH me AS (
    -- A platform owner works in no company at all on a token that has not passed the second step (aal2): cross-company access
    -- always needs it, whatever REQUIRE_ADMIN_MFA says. A login whose sign-in is disabled (banned in Auth) works in none either (119).
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

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: both bodies are this file's, both still definer with 017's / 036's search_path, the grants are 017's / 036's,
-- and the request hook is still 017's.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.session_is_active()') AND p.prosecdef AND p.provolatile = 's'
                   AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'af6457cae4d8b89cd34b5963574fbe58')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') AND p.prosecdef AND p.provolatile = 's'
                   AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'dd70574344856582b9819431b45e6c5c')
     OR NOT has_function_privilege('authenticated', 'public.session_is_active()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.session_is_active()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._session_membership()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._session_membership()', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
                    WHERE s.setrole = 'authenticator'::regrole AND cfg = 'pgrst.db_pre_request=public.check_request_session') THEN
    RAISE EXCEPTION '119 self-check failed: session_is_active / _session_membership are not as written here, or the request hook moved';
  END IF;
END
$$;
