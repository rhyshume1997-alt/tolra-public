-- 136_recent_second_step_admin_changes.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 136: G1, a recent authenticator code for giving or taking admin, in the DATABASE as well as in the app (working number; 135 is on
-- another branch). The app (requireRecentAal2, lib/server/admin-users.ts) already refuses an Admin > Users action that gives or takes
-- admin unless the session's authenticator (TOTP) code is under 15 minutes old. A signed-in browser can also call the two functions
-- behind those actions directly with its own token (public.set_member_access, public.admin_set_company_access), which skips the app.
-- This file closes that door in the database, with the same rule and the same 15 minutes.
--
-- WHAT CHANGES. One trigger function and one trigger; no existing function, table, column, policy, grant or row is changed.
--   a. public.organization_members_recent_second_step() RETURNS TRIGGER, SECURITY DEFINER, search_path pinned, executable by nobody
--      (a trigger function needs no EXECUTE grant to fire). For a SIGNED-IN call (the role in force is authenticated: a browser, or the
--      app calling with the caller's own token; the service role, the SQL editor and the database owner are not asked) that GIVES OR
--      TAKES ADMIN on a membership, it refuses (42501, HINT mfa_recent_required) unless the token's amr list shows an authenticator
--      code (method totp) entered in the last 15 minutes (900 seconds; a time up to 60 seconds ahead is accepted for clock skew, any
--      later one is not: the same test as lib/mfa-policy.ts recentSecondStep). "Gives or takes admin" is, on organization_members:
--        - a membership that holds admin (role or second role) is added, removed, or stops/starts holding it (a role or second role
--          to or from admin);
--        - a membership that holds admin is switched OFF (deactivated) or switched back ON (taking admin away counts, so does giving it
--          back).
--      Anything else on a membership (pages, the inspector flag, the set-up flag, a change between two non-admin roles, an admin
--      kept as admin) is not asked. Support memberships (the platform owner's own, 036) are never asked here: they have their own gate.
--   b. TRIGGER organization_members_recent_second_step, BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW, on public.organization_members.
--      Because it sits on the table, it covers every function that writes there for a signed-in caller, today set_member_access (the
--      session company's Edit / Deactivate) and admin_set_company_access (per-company access, 066), and any later one.
-- THE DATABASE'S SWITCH. The app's switch is the environment setting REQUIRE_ADMIN_MFA, which the database cannot see. The database's
-- own switch for the same rule is organizations.require_admin_mfa (033: the company's setting, off by default, which 033's admin_mfa
-- trigger and 066's per-company rule already use). This file asks for the recent code only in a company whose require_admin_mfa is on,
-- judged on the company of the MEMBERSHIP being changed (as 066 does for per-company access). A company with it off is unchanged by
-- this file. So where the app's switch is on and a company's own is off, a direct call to the function is not refused for recency by the
-- database (the app's routes still refuse it). Switching a company's own on is the step that makes the database refuse too.
-- ORDER OF REFUSALS. 033's admin_mfa statement trigger fires first: an admin of such a company at aal1 still gets mfa_required.
-- The app maps hint mfa_recent_required to its 403 mfa_recent_required answer, which opens the authenticator code dialog.
-- GUARD (section 1): the objects this relies on are there and set_member_access / admin_set_company_access are 093's (neither is replaced
-- here; the guard stops the file if someone changed them, so what it protects is what was reviewed). SELF-CHECK (section 4).
-- Safe to run again (CREATE OR REPLACE, DROP TRIGGER IF EXISTS).
-- Verify: supabase/verify/recent_second_step_136.sql (every row TRUE); every earlier verify file reads as it did before.
-- Rollback: supabase/release/136_recent_second_step_admin_changes.rollback.sql (drops the trigger and the function; only with Rhys's
-- approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
BEGIN
  IF to_regclass('public.organization_members') IS NULL OR to_regclass('public.organizations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'require_admin_mfa')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_members' AND column_name = 'support')
     OR to_regprocedure('public.is_api_role()') IS NULL OR to_regprocedure('public.assert_privileged_aal()') IS NULL
     OR to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])') IS NULL
     OR to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION '136: 033 (require_admin_mfa), 036 (support memberships), 066 / 093 (set_member_access, admin_set_company_access) or is_api_role is missing';
  END IF;
  -- The two functions this protects are 093's (2fc2a6a9..., 37881824...): not replaced here, so a different body is stopped and compared.
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])'))
       IS DISTINCT FROM '2fc2a6a96b80cc9f7a7f8baf9b67df04'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)'))
       IS DISTINCT FROM '378818d240f26ff55595ff4168f7a40e' THEN
    RAISE EXCEPTION '136: public.set_member_access or public.admin_set_company_access is not 093''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The trigger function.
CREATE OR REPLACE FUNCTION public.organization_members_recent_second_step()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old   BOOLEAN := FALSE;
  v_new   BOOLEAN := FALSE;
  v_org   UUID;
  v_now   NUMERIC := extract(epoch FROM now());
BEGIN
  -- Signed-in browser calls only (the role in force survives a SECURITY DEFINER function, current_user does not; 019 is_api_role).
  -- The service role (the app's own server work), the SQL editor and the owner are not asked.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IS DISTINCT FROM 'authenticated' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- The platform owner's support memberships have their own gate (036); a membership that is not one is the company's own.
  IF (TG_OP <> 'INSERT' AND OLD.support) OR (TG_OP <> 'DELETE' AND NEW.support) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old := coalesce(OLD.role = 'admin', FALSE) OR coalesce(OLD.secondary_role = 'admin', FALSE); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := coalesce(NEW.role = 'admin', FALSE) OR coalesce(NEW.secondary_role = 'admin', FALSE); END IF;
  -- Gives or takes admin: admin added, removed or changed to or from; or an admin switched off or back on.
  IF NOT (v_old IS DISTINCT FROM v_new OR (TG_OP = 'UPDATE' AND v_new AND OLD.active IS DISTINCT FROM NEW.active)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Only in a company that requires the second step (033), judged on the company of the membership being changed (as 066 does).
  v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF NOT coalesce((SELECT o.require_admin_mfa FROM public.organizations o WHERE o.id = v_org), FALSE) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- An authenticator code entered in the last 15 minutes (a time up to 60 seconds ahead is clock skew). Anything else does not count:
  -- no amr list, an entry without a numeric time, another method, an older or a later time.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' ELSE '[]'::jsonb END) AS e
    WHERE e ->> 'method' IN ('totp', 'mfa/totp')
      AND CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e ->> 'timestamp')::NUMERIC END BETWEEN v_now - 900 AND v_now + 60
  ) THEN
    RAISE EXCEPTION 'Enter a fresh code from your authenticator app to change who is an admin.' USING ERRCODE = '42501', HINT = 'mfa_recent_required';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION public.organization_members_recent_second_step() FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- 3. The trigger.
DROP TRIGGER IF EXISTS organization_members_recent_second_step ON public.organization_members;
CREATE TRIGGER organization_members_recent_second_step
  BEFORE INSERT OR UPDATE OR DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_recent_second_step();

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: everything above is in place and the function is a definer nobody can call.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'organization_members_recent_second_step'
                 AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('public.organization_members_recent_second_step()') AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2
                 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16)
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.organization_members_recent_second_step()'))
     OR has_function_privilege('authenticated', 'public.organization_members_recent_second_step()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.organization_members_recent_second_step()', 'EXECUTE') THEN
    RAISE EXCEPTION '136 self-check: the recent-code trigger on organization_members is not in place';
  END IF;
END
$$;

COMMIT;
