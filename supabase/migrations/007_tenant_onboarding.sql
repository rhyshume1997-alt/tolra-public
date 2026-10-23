-- 007: multi-organisation membership + tenant onboarding for the multi-tenant product database.
--
-- Run after 006. Idempotent: safe to run more than once. Nothing tenant-specific lives in the migrations;
-- tenants are created by the platform owner (SQL editor / service role) with public.create_organization()
-- and further people are added with public.add_member().
--
-- Model
--   * One login (auth.users / user_profiles row) can belong to SEVERAL organisations with a role in each:
--     public.organization_members (user_id, organization_id, role, secondary_role, active).
--   * user_profiles.organization_id is the login's CURRENT organisation; user_profiles.role / secondary_role are a
--     copy of the membership of that organisation (kept in sync by the functions below) so code that reads
--     profile.role keeps working. user_profiles.active is the account-level switch (the whole login).
--   * The access helpers (current_user_organization_id, current_user_role, has_org_role, ...) require an ACTIVE
--     membership in the current organisation and read the role from the membership, never from the profile copy.
--     Because of that, RLS on every business table is unchanged: it always sees exactly one organisation.
--   * People switch organisation with public.switch_organization(); list their organisations with
--     public.my_organizations().
--
-- Contents
--   1  public.organization_members (+ RLS) and the backfill from existing user_profiles
--   2  access helpers redefined on top of the membership
--   3  user_profiles: RLS policies and guard trigger (current organisation can only change through membership)
--   4  internal helper + switch_organization(), my_organizations(), org_members(), set_member_access()
--   5  public.organization_invites: pending invites (one per organisation + e-mail)
--   6  create_organization() and add_member() (platform owner / service role)
--   7  AFTER INSERT trigger on auth.users: pending invites -> profile + memberships
--   8  public.platform_org_summary(): owner-only overview of all tenants
--
-- Example (platform owner, SQL editor):
--   select public.create_organization('Acme Fabrication Ltd', 'acme-fabrication', 'owner@acme.example',
--          '{"name":"Acme Fabrication Ltd","documentName":"Acme Fabrication Ltd","addressLines":["1 Example Road","Town","AB1 2CD"],
--            "vatNumber":"GB000000000","email":"info@acme.example"}'::jsonb);
--   select public.add_member((select id from organizations where slug='acme-fabrication'), 'second.admin@acme.example', 'admin');

BEGIN;

-- =====================================================================================================
-- 1. organization_members
-- Written only by the SECURITY DEFINER functions below and by the service role. Authenticated users can read their
-- own memberships; admins can read the memberships of their current organisation.
-- =====================================================================================================
CREATE TABLE IF NOT EXISTS public.organization_members (
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'workshop' CHECK (role IN ('admin', 'office', 'workshop', 'viewer')),
  secondary_role  TEXT CHECK (secondary_role IS NULL OR secondary_role IN ('admin', 'office', 'workshop', 'viewer')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS organization_members_org_idx ON public.organization_members (organization_id);

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;

DROP POLICY IF EXISTS "organization_members read own" ON public.organization_members;
CREATE POLICY "organization_members read own" ON public.organization_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "organization_members admins read org" ON public.organization_members;
CREATE POLICY "organization_members admins read org" ON public.organization_members FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- Backfill: a login that already has a profile but no membership at all becomes a member of the organisation of
-- that profile, with the profile's roles. Re-running never overwrites an existing membership, and never adds a
-- second one for a login that already has any (access is removed by deactivating a membership, not by deleting it).
INSERT INTO public.organization_members (user_id, organization_id, role, secondary_role, active, created_at)
SELECT p.id, p.organization_id, p.role, p.secondary_role, p.active, p.created_at
FROM public.user_profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = p.id)
ON CONFLICT (user_id, organization_id) DO NOTHING;

-- =====================================================================================================
-- 2. Access helpers (same signatures as 000 / 006). A user resolves to an organisation / role only while
--    user_profiles.active AND organizations.status = 'active' AND an ACTIVE membership exists for
--    (auth.uid(), user_profiles.organization_id). The role comes from the membership.
-- =====================================================================================================
CREATE OR REPLACE FUNCTION public.current_user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.organization_id
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
    AND m.active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.organization_id
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
    AND m.active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.role
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
    AND m.active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_secondary_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.secondary_role
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
    AND m.active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    JOIN public.organizations o ON o.id = p.organization_id
    JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p.organization_id
    WHERE p.id = auth.uid()
      AND p.active = TRUE
      AND o.status = 'active'
      AND m.active = TRUE
      AND (m.role = ANY (allowed_roles) OR m.secondary_role = ANY (allowed_roles))
  )
$$;

REVOKE ALL ON FUNCTION public.current_user_organization_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_organization_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_user_secondary_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_org_role(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_secondary_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(TEXT[]) TO authenticated;

-- =====================================================================================================
-- 3. user_profiles: policies and guard
-- Admins see and edit the profiles of everyone who has a membership in the admin's CURRENT organisation (not only
-- people whose current organisation it is). They can no longer delete profiles: a profile is a whole login and may
-- serve other organisations too.
-- =====================================================================================================
DROP POLICY IF EXISTS "Admins read all" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins manage all" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins read org members" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins update org members" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins insert org profiles" ON public.user_profiles;

CREATE POLICY "Admins read org members" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()));

CREATE POLICY "Admins update org members" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()))
  WITH CHECK (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()));

-- Creating a profile row for an existing login (current organisation = the admin's). It grants no access by itself:
-- access needs a membership, which only set_member_access / add_member / the service role create.
CREATE POLICY "Admins insert org profiles" ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- Guard. Switching organisation (and syncing the role copy) goes through the definer functions below, which set the
-- transaction-local flag quoteflow.switching_org around their own UPDATE. A client cannot set it: PostgREST only
-- exposes functions of the public schema, none of which runs caller-supplied SQL or set_config(), and the flag is
-- cleared again by the functions right after their UPDATE. Everyone else (admins included):
--   * cannot change id, cannot toggle the account-level `active` (service role only);
--   * non-admins cannot change email, role, organisation or mfa_required;
--   * admins can change another person's current organisation only to one the person is an active member of
--     (role copy and organisation name then follow the membership), cannot edit role copies directly (use
--     set_member_access) and cannot change another person's e-mail (it is the login of every organisation).
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
REVOKE ALL ON FUNCTION public.user_profiles_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS user_profiles_guard ON public.user_profiles;
CREATE TRIGGER user_profiles_guard BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_guard();

-- =====================================================================================================
-- 4. Switching and managing memberships
-- =====================================================================================================

-- Internal: point a profile at an organisation and copy that membership's roles and the organisation name.
-- Not callable by clients (no EXECUTE for anon / authenticated); the definer functions below call it.
CREATE OR REPLACE FUNCTION public._apply_membership_to_profile(p_user UUID, p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  m RECORD;
BEGIN
  SELECT mm.role, mm.secondary_role, o.name AS org_name INTO m
  FROM public.organization_members mm JOIN public.organizations o ON o.id = mm.organization_id
  WHERE mm.user_id = p_user AND mm.organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION '_apply_membership_to_profile: no membership' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('quoteflow.switching_org', 'on', TRUE);
  UPDATE public.user_profiles
     SET organization_id = p_org, role = m.role, secondary_role = m.secondary_role, organization = m.org_name
   WHERE id = p_user;
  PERFORM set_config('quoteflow.switching_org', 'off', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public._apply_membership_to_profile(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The signed-in user changes their current organisation. Needs an active membership in an active organisation.
CREATE OR REPLACE FUNCTION public.switch_organization(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles p
    JOIN public.organization_members m ON m.user_id = p.id AND m.organization_id = p_org
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE p.id = v_uid AND p.active AND m.active AND o.status = 'active'
  ) THEN
    RAISE EXCEPTION 'You are not an active member of that organisation' USING ERRCODE = '42501';
  END IF;
  PERFORM public._apply_membership_to_profile(v_uid, p_org);
END
$$;
REVOKE ALL ON FUNCTION public.switch_organization(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_organization(UUID) TO authenticated;

-- The signed-in user's organisations (active memberships in active organisations).
CREATE OR REPLACE FUNCTION public.my_organizations()
RETURNS TABLE (organization_id UUID, name TEXT, slug TEXT, role TEXT, is_current BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.id, o.name, o.slug, m.role, (o.id = p.organization_id)
  FROM public.user_profiles p
  JOIN public.organization_members m ON m.user_id = p.id
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND m.active = TRUE AND o.status = 'active'
  ORDER BY o.name, o.id
$$;
REVOKE ALL ON FUNCTION public.my_organizations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_organizations() TO authenticated;

-- Members of the caller's current organisation with their login details (admins only; empty for everyone else).
CREATE OR REPLACE FUNCTION public.org_members()
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, role TEXT, secondary_role TEXT, active BOOLEAN, last_login_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.user_id, p.email, p.full_name, m.role, m.secondary_role, m.active, p.last_login_at
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  ORDER BY coalesce(nullif(p.full_name, ''), p.email), p.email
$$;
REVOKE ALL ON FUNCTION public.org_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members() TO authenticated;

-- An admin changes a member's role and/or access for the admin's CURRENT organisation only.
--   * not for yourself when deactivating; never removes / demotes / deactivates the last active admin;
--   * keeps the profile's role copy in sync when that organisation is the member's current one;
--   * when the member loses access to their current organisation they are moved to another active membership.
-- Banning / unbanning the auth user is the caller's job (admin API route): ban only when no active membership is left.
CREATE OR REPLACE FUNCTION public.set_member_access(p_user UUID, p_role TEXT DEFAULT NULL, p_active BOOLEAN DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID := public.current_user_organization_id();
  m        RECORD;
  v_admins INT;
  v_cur    UUID;
  v_cur_ok BOOLEAN;
  v_alt    UUID;
BEGIN
  IF v_uid IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change member access' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL AND p_active IS NULL THEN
    RAISE EXCEPTION 'Nothing to change' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('admin', 'office', 'workshop', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO m FROM public.organization_members WHERE user_id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found in this organisation' USING ERRCODE = 'P0002';
  END IF;
  IF p_user = v_uid AND p_active IS FALSE THEN
    RAISE EXCEPTION 'You cannot deactivate your own access' USING ERRCODE = '23514';
  END IF;

  IF m.active AND m.role = 'admin' AND ((p_role IS NOT NULL AND p_role <> 'admin') OR p_active IS FALSE) THEN
    SELECT count(*) INTO v_admins FROM (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = v_org AND role = 'admin' AND active AND user_id <> p_user FOR UPDATE
    ) x;
    IF v_admins < 1 THEN
      RAISE EXCEPTION 'At least one active admin is required' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.organization_members
     SET role = coalesce(p_role, role), active = coalesce(p_active, active), updated_at = now()
   WHERE user_id = p_user AND organization_id = v_org
   RETURNING * INTO m;

  -- keep the profile in step
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
REVOKE ALL ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN) TO authenticated;

-- =====================================================================================================
-- 5. organization_invites
-- Pending invites for people who have no auth.users row yet: one per (organisation, e-mail), so one e-mail can be
-- invited to several organisations. Written only by create_organization() / add_member() / the owner; admins of the
-- organisation can read theirs.
-- =====================================================================================================
CREATE TABLE IF NOT EXISTS public.organization_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'office', 'workshop', 'viewer')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS public.organization_invites_email_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS organization_invites_org_email_uniq ON public.organization_invites (organization_id, lower(email));
CREATE INDEX IF NOT EXISTS organization_invites_org_idx ON public.organization_invites (organization_id);

ALTER TABLE public.organization_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_invites TO authenticated;

DROP POLICY IF EXISTS "organization_invites admins read" ON public.organization_invites;
CREATE POLICY "organization_invites admins read" ON public.organization_invites FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- =====================================================================================================
-- 6. create_organization / add_member (platform owner: SQL editor / service role)
-- =====================================================================================================

-- Internal: make an existing login a member of an organisation (role set, access active). A login without a profile
-- gets one with this organisation as its current one; a login whose current organisation is not usable is moved here.
CREATE OR REPLACE FUNCTION public._ensure_member(p_user UUID, p_email TEXT, p_org UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_full   TEXT;
  v_name   TEXT;
  v_cur    UUID;
  v_cur_ok BOOLEAN;
BEGIN
  INSERT INTO public.organization_members (user_id, organization_id, role, active)
  VALUES (p_user, p_org, p_role, TRUE)
  ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, active = TRUE, updated_at = now();

  SELECT organization_id INTO v_cur FROM public.user_profiles WHERE id = p_user;
  IF NOT FOUND THEN
    SELECT nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '') INTO v_full FROM auth.users u WHERE u.id = p_user;
    SELECT o.name INTO v_name FROM public.organizations o WHERE o.id = p_org;
    INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, organization, active)
    VALUES (p_user, p_email, v_full, p_role, p_org, v_name, TRUE)
    ON CONFLICT (id) DO NOTHING;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                   WHERE m.user_id = p_user AND m.organization_id = v_cur AND m.active AND o.status = 'active')
      INTO v_cur_ok;
    IF v_cur = p_org OR NOT v_cur_ok THEN
      PERFORM public._apply_membership_to_profile(p_user, p_org);
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public._ensure_member(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_organization(
  p_name            TEXT,
  p_slug            TEXT,
  p_admin_email     TEXT,
  p_company_profile JSONB DEFAULT '{}'::JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_org     UUID;
  v_email   TEXT := lower(btrim(p_admin_email));
  v_name    TEXT := btrim(p_name);
  v_user    UUID;
  v_profile JSONB := coalesce(p_company_profile, '{}'::JSONB);
BEGIN
  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'create_organization: name is required';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9-]{2,48}$' THEN
    RAISE EXCEPTION 'create_organization: slug must match ^[a-z0-9-]{2,48}$ (got %)', p_slug;
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'create_organization: a valid admin e-mail is required (got %)', p_admin_email;
  END IF;
  IF jsonb_typeof(v_profile) <> 'object' THEN
    RAISE EXCEPTION 'create_organization: company profile must be a JSON object';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'create_organization: slug % is already used', p_slug;
  END IF;

  INSERT INTO public.organizations (name, slug, status) VALUES (v_name, p_slug, 'active') RETURNING id INTO v_org;

  -- The printed company name defaults to the organisation name; everything else comes from the caller.
  INSERT INTO public.organization_settings (organization_id, company_profile)
  VALUES (v_org, jsonb_build_object('name', v_name) || v_profile)
  ON CONFLICT (organization_id) DO UPDATE SET company_profile = EXCLUDED.company_profile;

  -- A person who already has a login simply gains an admin membership here (their current organisation only
  -- changes if they have none yet). Everyone else gets a pending invite that sign-up turns into a membership.
  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email ORDER BY u.created_at LIMIT 1;
  IF v_user IS NOT NULL THEN
    PERFORM public._ensure_member(v_user, v_email, v_org, 'admin');
  ELSE
    INSERT INTO public.organization_invites (organization_id, email, role) VALUES (v_org, v_email, 'admin')
    ON CONFLICT (organization_id, lower(email)) DO UPDATE SET role = EXCLUDED.role;
  END IF;

  RETURN v_org;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_organization(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization(TEXT, TEXT, TEXT, JSONB) TO service_role;
COMMENT ON FUNCTION public.create_organization(TEXT, TEXT, TEXT, JSONB) IS
  'Platform owner only (SQL editor / service role). Creates a tenant: organization, settings with company profile, first admin (membership, or a pending invite).';

-- Adds (or updates) a member of an organisation. Existing login -> membership (profile created if missing);
-- unknown e-mail -> pending invite that turns into a membership at sign-up. Returns 'member' or 'invited'.
CREATE OR REPLACE FUNCTION public.add_member(p_org UUID, p_email TEXT, p_role TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_user  UUID;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org) THEN
    RAISE EXCEPTION 'add_member: organisation % does not exist', p_org;
  END IF;
  IF v_email IS NULL OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'add_member: a valid e-mail is required (got %)', p_email;
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'office', 'workshop', 'viewer') THEN
    RAISE EXCEPTION 'add_member: role must be admin, office, workshop or viewer (got %)', p_role;
  END IF;

  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email ORDER BY u.created_at LIMIT 1;
  IF v_user IS NOT NULL THEN
    PERFORM public._ensure_member(v_user, v_email, p_org, p_role);
    RETURN 'member';
  END IF;
  INSERT INTO public.organization_invites (organization_id, email, role) VALUES (p_org, v_email, p_role)
  ON CONFLICT (organization_id, lower(email)) DO UPDATE SET role = EXCLUDED.role;
  RETURN 'invited';
END
$fn$;

REVOKE ALL ON FUNCTION public.add_member(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_member(UUID, TEXT, TEXT) TO service_role;
COMMENT ON FUNCTION public.add_member(UUID, TEXT, TEXT) IS
  'Platform owner only (SQL editor / service role). Adds an organisation member (or a pending invite) with the given role.';

-- =====================================================================================================
-- 7. auth.users trigger: pending invites -> profile + memberships
-- Never raises: a failure here must not block sign-up / invite. The profile gets the first invite's organisation as
-- its current one; every pending invite of that e-mail becomes a membership. The app's invite route adds its own
-- profile / membership afterwards (only if none exists), so both paths are safe in either order.
-- =====================================================================================================
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  inv      RECORD;
  v_first  RECORD;
  v_has    BOOLEAN := FALSE;
BEGIN
  BEGIN
    IF NEW.email IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT i.organization_id, i.role, o.name AS org_name INTO v_first
    FROM public.organization_invites i JOIN public.organizations o ON o.id = i.organization_id
    WHERE lower(i.email) = lower(NEW.email)
    ORDER BY i.created_at, i.id
    LIMIT 1;
    IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, organization, active)
        VALUES (NEW.id, lower(NEW.email), nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), v_first.role,
                v_first.organization_id, v_first.org_name, TRUE)
        ON CONFLICT DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        FOR inv IN SELECT i.organization_id, i.role FROM public.organization_invites i
                   WHERE lower(i.email) = lower(NEW.email) ORDER BY i.created_at, i.id
        LOOP
          INSERT INTO public.organization_members (user_id, organization_id, role, active)
          VALUES (NEW.id, inv.organization_id, inv.role, TRUE)
          ON CONFLICT (user_id, organization_id) DO NOTHING;
          v_has := TRUE;
        END LOOP;
        IF v_has THEN
          DELETE FROM public.organization_invites WHERE lower(email) = lower(NEW.email);
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_auth_user: profile not created for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_apply_invite ON auth.users;
CREATE TRIGGER on_auth_user_created_apply_invite
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- =====================================================================================================
-- 8. platform_org_summary (platform owner only)
-- =====================================================================================================
-- (the OUT columns are unchanged from the previous definition, so CREATE OR REPLACE is allowed)
CREATE OR REPLACE FUNCTION public.platform_org_summary()
RETURNS TABLE (organization_id UUID, name TEXT, slug TEXT, status TEXT, user_count BIGINT, active_user_count BIGINT,
               pending_invites BIGINT, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT o.id, o.name, o.slug, o.status,
         (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o.id),
         (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o.id AND m.active),
         (SELECT count(*) FROM public.organization_invites i WHERE i.organization_id = o.id),
         o.created_at
  FROM public.organizations o
  ORDER BY o.created_at, o.name;
$fn$;

REVOKE ALL ON FUNCTION public.platform_org_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_org_summary() TO service_role;

COMMIT;
