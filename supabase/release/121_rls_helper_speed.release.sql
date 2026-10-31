-- 121_rls_helper_speed.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 121: the row-level-security helpers are about 10 to 15 times cheaper per row (unit S11, E6 dashboard speed part 2). Needs 119
-- (its _session_membership, which already carries 036's resolver plus the ban test). Touches no other migration's objects.
--
-- THE COST. Every business-table policy calls 036's helpers once per row: has_org_role(...) in every rbac policy and, where the
-- planner can't use it as an index key, current_user_organization_id(). Each of them reads public._session_membership(), an
-- SQL-language SECURITY DEFINER function. PostgreSQL (16 and 17) can't inline such a function and keeps no plan for it between
-- calls made from inside another function, so the resolver's query (six tables, three CTEs) was parsed and planned again for
-- EVERY row: about 25 catalogue buffers and 0.45 to 1 ms per row. Measured on the local stand-in (5,000 invoices, 6,000 quotes,
-- 4,500 jobs in one company, a second company of the same size), signed in as the company's admin:
--   select count(*) from invoices 2,100-2,900 ms; invoices list first 1,000 rows 2,900-3,200 ms; dashboard_money_figures (111, since dropped)
--   3,300-3,650 ms; dashboard_work_figures (111, since dropped) 6,000-6,550 ms. After this file: 175-210 ms, 180-230 ms, 255-300 ms, 435-490 ms,
--   with buffers per row down from 25 to 3. Results identical (tests/scripts/rls-helper-speed-121.measure.sql).
--
-- WHAT CHANGES. One function, public._session_membership(): the same query, word for word (119's function body), now run by
-- PL/pgSQL (RETURN QUERY), which plans it once per database connection and reuses the plan on every later call. Same name,
-- signature, result columns, owner, STABLE, SECURITY DEFINER, search_path and grants (no API role may call it). So every helper,
-- policy and function that reads it answers exactly as before: the same chosen company, role, secondary role, support window,
-- grant and elevation, hidden sections, platform owner aal2 rule, banned login (119), inactive profile / membership / company and
-- forced password change. '#variable_conflict use_column' makes a name that is both a result column and a table column mean the
-- table column, as it did in SQL (119's text qualifies every column, so nothing changes). No table, row, index, policy, trigger,
-- grant or setting. The plan is still re-made automatically when a table, index or function it uses changes (PostgreSQL's plan
-- cache). After 121, 119's own verify row _session_membership_is_119 reads FALSE by design (the body is 121's); the preflight's
-- 119 marker accepts either.
--
-- NOT HERE (a post-go-live decision): wrapping the helper calls in every policy as (SELECT has_org_role(...)) so they run once per
-- statement (165 policies; a further 10x).
-- GUARD (section 1): _session_membership must be 119's (or already 121's), md5 with every whitespace character removed. Safe to
-- run again. SELF-CHECK (sections 3 and 4). Verify: supabase/verify/rls_helper_speed_121.sql (every row TRUE).
-- Rollback: supabase/release/121_rls_helper_speed.rollback.sql (puts back 119's SQL function; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: _session_membership is 119's (or already this file's).
DO $$
DECLARE
  v_member TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()') INTO v_member;
  -- dd70574344856582b9819431b45e6c5c: 119's _session_membership; 4fa415c7b3222def6c37e93353e804c2: this file's (section 2).
  IF v_member IS NULL OR v_member NOT IN ('dd70574344856582b9819431b45e6c5c', '4fa415c7b3222def6c37e93353e804c2') THEN
    RAISE EXCEPTION '121: public._session_membership is not 119''s (md5 without whitespace %); stop and compare it first', coalesce(v_member, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. _session_membership: 119's query, unchanged, run by PL/pgSQL so its plan is kept between calls.
CREATE OR REPLACE FUNCTION public._session_membership()
RETURNS TABLE (organization_id UUID, role TEXT, secondary_role TEXT, is_support BOOLEAN, expires_at TIMESTAMPTZ, elevated_until TIMESTAMPTZ, hidden_sections TEXT[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
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
  ;
END
$$;
REVOKE ALL ON FUNCTION public._session_membership() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT, the function (the same checks as supabase/verify/rls_helper_speed_121.sql): 121's body, PL/pgSQL,
--    a stable set-returning definer with 036's search_path.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '4fa415c7b3222def6c37e93353e804c2' OR NOT p.prosecdef OR p.provolatile <> 's' OR p.proretset IS NOT TRUE
             OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()')) IS NOT FALSE THEN
    RAISE EXCEPTION '121: _session_membership is not 121''s after the replace';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check before COMMIT, the grants: still callable by no API role (anon, authenticated, PUBLIC), as 036 left it.
DO $$
BEGIN
  IF (SELECT has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      FROM pg_proc p WHERE p.oid = to_regprocedure('public._session_membership()')) IS NOT FALSE THEN
    RAISE EXCEPTION '121: _session_membership is callable by an API role after the replace';
  END IF;
END
$$;

COMMIT;
