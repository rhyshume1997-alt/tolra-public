-- =====================================================================================================
-- 012: USER MANAGEMENT IN THE APP
--
-- 1. user_profiles.must_change_password: set by an admin when they create a login or set a password for someone;
--    the app then sends that person to "Choose your password" before anything else. Only the server (service role)
--    changes it; the person's own client can't clear it (profile guard below).
-- 2. organization_members.hidden_sections: per-person page access, on top of the role. Each key hides one sidebar
--    section for that person in that organisation. Pages are blocked by the app's middleware; for the sections whose
--    data is self-contained, the database refuses the rows too (restrictive RLS policies, section 4).
--    Customers, suppliers, jobs, schedule and delivery notes are shared by other pages (a quote needs its customer,
--    a delivery note its job), so for those only the page is hidden, not the underlying rows.
-- 3. set_member_access(): also sets the secondary role and the hidden sections. Safeguards, all in the database:
--    nobody can deactivate themselves or remove their own admin rights, and an organisation always keeps at least one
--    active admin (primary OR secondary role counts).
-- 4. Restrictive RLS: quotes (+ lines, attachments), invoices (+ lines), sales orders, purchase orders, RFQs and the
--    e-mail history (needs Email Automation or Approval Queue).
-- 5. Last login: copied from Supabase's own auth.users.last_sign_in_at on every sign-in (any sign-in method), and
--    backfilled now. Fixes Admin > Users showing "Never".
-- 6. org_members() also returns the new fields.
-- Run after 011. Safe to re-run.
-- =====================================================================================================

-- ----- 1. must_change_password --------------------------------------------------------------------------
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- ----- 2. hidden_sections ---------------------------------------------------------------------------------
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS hidden_sections TEXT[] NOT NULL DEFAULT '{}';

-- The section keys a person can be kept out of (the sidebar's sections; Dashboard, Admin and Settings excluded).
CREATE OR REPLACE FUNCTION public.member_section_keys()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT ARRAY['email', 'rfq', 'quotes', 'sales-orders', 'jobs', 'schedule', 'invoices', 'approval',
               'purchase-orders', 'delivery-notes', 'customers', 'suppliers']::TEXT[]
$$;
GRANT EXECUTE ON FUNCTION public.member_section_keys() TO authenticated, service_role;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_hidden_sections_valid') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_hidden_sections_valid
      CHECK (hidden_sections <@ public.member_section_keys());
  END IF;
END
$do$;

-- True unless the signed-in person's membership in their current organisation hides this section.
CREATE OR REPLACE FUNCTION public.section_allowed(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
    WHERE p.id = auth.uid() AND p_section = ANY (m.hidden_sections)
  )
$$;
REVOKE ALL ON FUNCTION public.section_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.section_allowed(TEXT) TO authenticated;

-- ----- profile guard: + must_change_password (service role only) -----------------------------------------
CREATE OR REPLACE FUNCTION public.user_profiles_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  m RECORD;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(current_setting('quoteflow.switching_org', TRUE), '') <> 'on' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'The profile id cannot be changed' USING ERRCODE = '42501';
    END IF;

    IF NEW.username IS DISTINCT FROM OLD.username THEN
      RAISE EXCEPTION 'Usernames are set by an administrator in Admin > Users' USING ERRCODE = '42501';
    END IF;

    IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
      RAISE EXCEPTION 'Password requirements are managed in Admin > Users' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_org_role(ARRAY['admin']) THEN
      IF NEW.email IS DISTINCT FROM OLD.email
         OR NEW.role IS DISTINCT FROM OLD.role
         OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.active IS DISTINCT FROM OLD.active
         OR NEW.mfa_required IS DISTINCT FROM OLD.mfa_required THEN
        RAISE EXCEPTION 'Only admins can change role, organisation, status or email' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.active IS DISTINCT FROM OLD.active THEN
        RAISE EXCEPTION 'Use set_member_access to change access; the account-level switch is not editable here' USING ERRCODE = '42501';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email AND OLD.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'An admin cannot change another person''s e-mail' USING ERRCODE = '42501';
      END IF;
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        IF OLD.id IS DISTINCT FROM auth.uid() THEN
          RAISE EXCEPTION 'Only the person can switch their own current organisation' USING ERRCODE = '42501';
        END IF;
        SELECT mm.role, mm.secondary_role, o.name AS org_name INTO m
        FROM public.organization_members mm JOIN public.organizations o ON o.id = mm.organization_id
        WHERE mm.user_id = OLD.id AND mm.organization_id = NEW.organization_id AND mm.active AND o.status = 'active';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'The person is not an active member of that organisation' USING ERRCODE = '42501';
        END IF;
        NEW.role := m.role;
        NEW.secondary_role := m.secondary_role;
        NEW.organization := m.org_name;
      ELSIF NEW.role IS DISTINCT FROM OLD.role OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role THEN
        RAISE EXCEPTION 'Use set_member_access to change a role' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_profiles_guard() FROM PUBLIC, anon, authenticated;

-- ----- 3. set_member_access(): + secondary role, hidden sections, self-demotion guard ---------------------
DROP FUNCTION IF EXISTS public.set_member_access(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]);
CREATE FUNCTION public.set_member_access(
  p_user            UUID,
  p_role            TEXT    DEFAULT NULL,
  p_active          BOOLEAN DEFAULT NULL,
  p_secondary_role  TEXT    DEFAULT NULL,   -- a role to add as secondary
  p_clear_secondary BOOLEAN DEFAULT FALSE,  -- TRUE removes the secondary role
  p_hidden_sections TEXT[]  DEFAULT NULL    -- replaces the person's hidden sections ('{}' shows everything)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_org      UUID := public.current_user_organization_id();
  m          RECORD;
  v_role     TEXT;
  v_second   TEXT;
  v_active   BOOLEAN;
  v_admins   INT;
  v_cur      UUID;
  v_cur_ok   BOOLEAN;
  v_alt      UUID;
BEGIN
  IF v_uid IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change member access' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL AND p_active IS NULL AND p_secondary_role IS NULL AND NOT coalesce(p_clear_secondary, FALSE) AND p_hidden_sections IS NULL THEN
    RAISE EXCEPTION 'Nothing to change' USING ERRCODE = '22023';
  END IF;
  IF (p_role IS NOT NULL AND p_role NOT IN ('admin', 'office', 'workshop', 'viewer'))
     OR (p_secondary_role IS NOT NULL AND p_secondary_role NOT IN ('admin', 'office', 'workshop', 'viewer')) THEN
    RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023';
  END IF;
  IF p_hidden_sections IS NOT NULL AND NOT (p_hidden_sections <@ public.member_section_keys()) THEN
    RAISE EXCEPTION 'Invalid page section' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO m FROM public.organization_members WHERE user_id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found in this organisation' USING ERRCODE = 'P0002';
  END IF;

  v_role   := coalesce(p_role, m.role);
  v_second := CASE WHEN coalesce(p_clear_secondary, FALSE) THEN NULL ELSE coalesce(p_secondary_role, m.secondary_role) END;
  IF v_second = v_role THEN v_second := NULL; END IF;
  v_active := coalesce(p_active, m.active);

  IF p_user = v_uid AND NOT v_active THEN
    RAISE EXCEPTION 'You cannot deactivate your own access' USING ERRCODE = '23514';
  END IF;
  IF p_user = v_uid AND 'admin' NOT IN (v_role, coalesce(v_second, '')) THEN
    RAISE EXCEPTION 'You cannot remove your own admin rights' USING ERRCODE = '23514';
  END IF;

  -- Was an active admin and won't be: someone else must still be one.
  IF m.active AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
     AND (NOT v_active OR 'admin' NOT IN (v_role, coalesce(v_second, ''))) THEN
    SELECT count(*) INTO v_admins FROM (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = v_org AND active AND user_id <> p_user AND 'admin' IN (role, coalesce(secondary_role, ''))
      FOR UPDATE
    ) x;
    IF v_admins < 1 THEN
      RAISE EXCEPTION 'At least one active admin is required' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.organization_members
     SET role = v_role,
         secondary_role = v_second,
         active = v_active,
         hidden_sections = CASE WHEN p_hidden_sections IS NULL THEN hidden_sections
                                ELSE coalesce((SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(p_hidden_sections) s), '{}'::TEXT[]) END,
         updated_at = now()
   WHERE user_id = p_user AND organization_id = v_org
   RETURNING * INTO m;

  -- keep the profile in step (as in 007)
  SELECT organization_id INTO v_cur FROM public.user_profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_cur = v_org THEN
    IF NOT m.active THEN
      SELECT m2.organization_id INTO v_alt
      FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
      WHERE m2.user_id = p_user AND m2.active AND o.status = 'active' AND m2.organization_id <> v_org
      ORDER BY m2.created_at, o.name LIMIT 1;
      IF v_alt IS NOT NULL THEN
        PERFORM public._apply_membership_to_profile(p_user, v_alt);
        RETURN;
      END IF;
    END IF;
    PERFORM public._apply_membership_to_profile(p_user, v_org);
  ELSIF m.active THEN
    SELECT EXISTS (SELECT 1 FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
                   WHERE m2.user_id = p_user AND m2.organization_id = v_cur AND m2.active AND o.status = 'active')
      INTO v_cur_ok;
    IF NOT v_cur_ok THEN
      PERFORM public._apply_membership_to_profile(p_user, v_org);
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) TO authenticated;

-- ----- 4. restrictive RLS for hidden sections -------------------------------------------------------------
-- RESTRICTIVE: ANDed with the existing role policies, so it can only take access away. (SELECT ...) makes Postgres
-- evaluate the check once per statement, not once per row.
DO $do$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('quotes',             '(SELECT public.section_allowed(''quotes''))'),
    ('quote_line_items',   '(SELECT public.section_allowed(''quotes''))'),
    ('quote_attachments',  '(SELECT public.section_allowed(''quotes''))'),
    ('invoices',           '(SELECT public.section_allowed(''invoices''))'),
    ('invoice_line_items', '(SELECT public.section_allowed(''invoices''))'),
    ('sales_orders',       '(SELECT public.section_allowed(''sales-orders''))'),
    ('purchase_orders',    '(SELECT public.section_allowed(''purchase-orders''))'),
    ('rfqs',               '(SELECT public.section_allowed(''rfq''))'),
    ('email_history',      '((SELECT public.section_allowed(''email'')) OR (SELECT public.section_allowed(''approval'')))')
  ) AS t(tbl, expr)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.tbl || ' section access', r.tbl);
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
                     r.tbl || ' section access', r.tbl, r.expr, r.expr);
    END IF;
  END LOOP;
END
$do$;

-- ----- 5. last login from auth.users ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_last_login()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at AND NEW.last_sign_in_at IS NOT NULL THEN
    BEGIN
      UPDATE public.user_profiles SET last_login_at = NEW.last_sign_in_at
       WHERE id = NEW.id AND (last_login_at IS NULL OR last_login_at < NEW.last_sign_in_at);
    EXCEPTION WHEN OTHERS THEN
      -- Never block a sign-in over the "last login" column.
      RAISE WARNING 'sync_last_login: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.sync_last_login() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_signed_in_sync_last_login ON auth.users;
CREATE TRIGGER on_auth_user_signed_in_sync_last_login
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_last_login();

UPDATE public.user_profiles p
   SET last_login_at = u.last_sign_in_at
  FROM auth.users u
 WHERE u.id = p.id AND u.last_sign_in_at IS NOT NULL AND (p.last_login_at IS NULL OR p.last_login_at < u.last_sign_in_at);

-- ----- 6. org_members(): + hidden_sections, must_change_password ------------------------------------------
DROP FUNCTION IF EXISTS public.org_members();
CREATE FUNCTION public.org_members()
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, username TEXT, role TEXT, secondary_role TEXT, active BOOLEAN,
               last_login_at TIMESTAMPTZ, hidden_sections TEXT[], must_change_password BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.user_id, p.email, p.full_name, p.username, m.role, m.secondary_role, m.active, p.last_login_at,
         m.hidden_sections, p.must_change_password, m.created_at
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  ORDER BY coalesce(nullif(p.full_name, ''), p.email), p.email
$$;
REVOKE ALL ON FUNCTION public.org_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members() TO authenticated;

-- Check. Expect: new_columns = 2, section_policies = 9, last_login_trigger = 1, set_member_access_args = 6,
-- profiles_with_login = (number of people who have ever signed in; 2 or more).
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
     AND ((table_name = 'user_profiles' AND column_name = 'must_change_password')
       OR (table_name = 'organization_members' AND column_name = 'hidden_sections'))) AS new_columns,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '% section access' AND permissive = 'RESTRICTIVE') AS section_policies,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'on_auth_user_signed_in_sync_last_login') AS last_login_trigger,
  (SELECT pronargs FROM pg_proc WHERE proname = 'set_member_access' AND pronamespace = 'public'::regnamespace) AS set_member_access_args,
  (SELECT count(*) FROM public.user_profiles WHERE last_login_at IS NOT NULL) AS profiles_with_login;
