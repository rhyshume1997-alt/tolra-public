-- =====================================================================================================
-- 036: two-level access (PR D). One migration for every database change in the batch.
--
-- Two levels of access:
--   * Platform owner (Tolra): a short list in security_audit.platform_admins, written only by the database owner (the SQL editor).
--     Being on it grants NO business data by itself. The owner picks a company first, with a reason, and gets an expiring,
--     read-only support membership (2 hours by default, 8 at most). Writing needs a separate, logged, expiring elevation.
--   * Company users: see only the companies they hold an active membership in. Two or more: they choose one at each sign-in. Exactly
--     one: straight in (nothing changes for a single-company business).
--
-- 1. The company a request works in is chosen per SIGN-IN SESSION, not stored on the person. security_audit.session_company is keyed on
--    the session id in the access token (auth.sessions), so two browsers can sit in different companies, signing out or the session
--    ending removes the choice, and nobody can write it except switch_organization() and the platform functions below.
-- 2. The access helpers every row-level policy is built on (current_user_organization_id, user_organization_id, current_user_role,
--    current_user_secondary_role, has_org_role, section_allowed) now answer from ONE internal resolver, _session_membership(): the
--    session's chosen company, and only while the person still holds an active membership in an active company (or an unexpired
--    support membership, for a platform owner). It checks on every call, so expiry, revocation and deactivation bite at once. A
--    person with several companies and no choice for this session, and a platform owner with no choice, resolve to nothing: every
--    policy refuses until a company is chosen. user_profiles.organization_id is no longer read by any policy or function.
-- 3. platform_list_organizations(), platform_enter_organization(org, reason, hours), platform_elevate_support(org, reason, minutes),
--    platform_exit_organization(). Support never creates admins, changes roles, or extends its own expiry (set_member_access refuses
--    a support session; entering again while the window is open keeps the same expiry), and a support membership does not count as
--    one of the company's admins. Every selection and elevation of a support session is bound to the support grant it was made under
--    (organization_members.support_grant): a window that ended or was revoked and is opened again is a NEW grant, so no earlier
--    session gets its selection or elevation back. Every platform function, and every company resolution for a platform owner,
--    needs an aal2 token (the second step of sign-in), checked in the database whatever REQUIRE_ADMIN_MFA says.
-- 4. A support session that has not been elevated is refused every write: a statement trigger on every company table, plus the
--    storage bucket policies. That covers the API and the definer functions alike.
-- 5. security_audit.org_entry_log: one row per company choice, support entry, elevation and exit, written in the same transaction as the
--    change it records (a failed log write undoes the entry). Append-only. Company admins read the entries into their own company
--    through org_entry_history(); nothing else reads the table.
-- 6. my_session(): what the app reads to route (picker, platform page), to show the support banner and to switch the offline store off.
--    my_organizations() lists only the person's own companies. org_members() flags support members and their expiry.
-- 7. The second step (033). set_member_access, replaced here, starts with assert_privileged_aal() again (a company admin at aal1 is
--    refused when the company requires the second step). The platform functions keep their own stricter check, assert_platform_aal():
--    a platform owner always needs aal2, whatever the company or REQUIRE_ADMIN_MFA says.
-- 8. Every company choice under a different support grant is logged too: choosing the same company again after its support window was
--    reopened (by this or another session) writes an org_entry_log row in the same transaction, like choosing another company.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Tables and columns --------------------------------------------------------------------------------
-- Tolra staff who may enter companies. Written only by the database owner (SQL editor): no API role, not even the service role,
-- has any privilege on it, and no function writes it.
CREATE TABLE IF NOT EXISTS security_audit.platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE security_audit.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.platform_admins FROM PUBLIC, anon, authenticated, service_role;

-- The company each sign-in session is working in. The row goes with the session (sign-out, expiry, revocation).
CREATE TABLE IF NOT EXISTS security_audit.session_company (
  session_id      UUID PRIMARY KEY REFERENCES auth.sessions(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  selected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  elevated_until  TIMESTAMPTZ,
  -- For a support selection: the generation of the support grant it was made under (organization_members.support_grant). A selection
  -- or elevation only counts while that is still the current grant, so reopening a grant never revives an earlier session's access.
  grant_id        UUID
);
ALTER TABLE security_audit.session_company ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.session_company FROM PUBLIC, anon, authenticated, service_role;

-- Every company entry. Insert-only for everyone who comes through the API.
CREATE TABLE IF NOT EXISTS security_audit.org_entry_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL,
  via                TEXT NOT NULL CHECK (via IN ('login_choice', 'switch', 'platform_member', 'platform_support', 'platform_elevate', 'platform_exit')),
  session_id         UUID,
  reason             TEXT,
  write_access       BOOLEAN NOT NULL DEFAULT FALSE,
  support_expires_at TIMESTAMPTZ,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT org_entry_log_reason_required CHECK (via NOT IN ('platform_support', 'platform_elevate') OR length(btrim(coalesce(reason, ''))) >= 5)
);
CREATE INDEX IF NOT EXISTS org_entry_log_org_time ON security_audit.org_entry_log (organization_id, at DESC);
ALTER TABLE security_audit.org_entry_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_audit.org_entry_log FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION security_audit.org_entry_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() THEN
    RAISE EXCEPTION 'the company entry log is append-only' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS org_entry_log_immutable ON security_audit.org_entry_log;
CREATE TRIGGER org_entry_log_immutable BEFORE UPDATE OR DELETE ON security_audit.org_entry_log
  FOR EACH ROW EXECUTE FUNCTION security_audit.org_entry_log_immutable();

-- A support membership is an ordinary membership row with a flag and a compulsory expiry; an ordinary one never expires.
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS support BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS support_reason TEXT;
-- A new value for every new support window (each enter call that opens one), so nothing from an earlier window can be revived.
ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS support_grant UUID;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_support_expiry' AND conrelid = 'public.organization_members'::regclass) THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_support_expiry CHECK (support = (expires_at IS NOT NULL));
  END IF;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Who the caller is working as, right now -----------------------------------------------------------
-- TRUE for an active person on the platform list. No policy refers to this: only the platform functions below do.
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM security_audit.platform_admins a
    JOIN public.user_profiles p ON p.id = a.user_id
    WHERE a.user_id = auth.uid() AND p.active = TRUE AND p.must_change_password = FALSE
  )
$$;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated;

-- Every platform function starts here: the platform owner's token must have passed the second step (aal2), checked in the database
-- so calling the API directly with a password-only token is refused too. Not callable by the API roles; the definer functions
-- below call it.
CREATE OR REPLACE FUNCTION public.assert_platform_aal()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'Confirm your authenticator code first (second step of sign-in).' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.assert_platform_aal() FROM PUBLIC, anon, authenticated;

-- The one place that decides which company, role and access this request has. Internal: the helpers below call it; the API roles
-- cannot. At most one row.
--   * The session's chosen company, if the person still holds an active membership in an active company. A support membership also
--     needs an unexpired window and a platform owner.
--   * No usable choice: the person's only active ordinary membership, if they have exactly one and are not a platform owner.
--   * Otherwise nothing, and every policy refuses.
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. The access helpers answer from the session's company --------------------------------------------------
-- Same names, signatures and grants as 014; every row-level policy keeps working through them.
-- True unless the person's membership in the session's company hides this section.
CREATE OR REPLACE FUNCTION public.section_allowed(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT coalesce((SELECT p_section = ANY (s.hidden_sections) FROM public._session_membership() s), FALSE)
$$;

CREATE OR REPLACE FUNCTION public.current_user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.organization_id FROM public._session_membership() s
$$;

CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.organization_id FROM public._session_membership() s
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.role FROM public._session_membership() s
$$;

CREATE OR REPLACE FUNCTION public.current_user_secondary_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.secondary_role FROM public._session_membership() s
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((SELECT s.role = ANY (allowed_roles) OR s.secondary_role = ANY (allowed_roles) FROM public._session_membership() s), FALSE)
$$;

-- TRUE while the caller's session is a support session that has not been elevated (or whose elevation has run out).
CREATE OR REPLACE FUNCTION public.session_read_only()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((SELECT s.is_support AND coalesce(s.elevated_until, '-infinity'::TIMESTAMPTZ) <= now() FROM public._session_membership() s), FALSE)
$$;
REVOKE ALL ON FUNCTION public.session_read_only() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_read_only() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Choosing a company, and the platform owner's entry ------------------------------------------------
-- The signed-in person chooses (or changes) the company for THIS session. Needs an active membership in an active company; a
-- platform owner may also choose a company where an unexpired support membership exists (read-only until elevated).
CREATE OR REPLACE FUNCTION public.switch_organization(p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_session UUID := nullif(auth.jwt() ->> 'session_id', '')::UUID;
  v_prior   UUID;
  v_prior_grant UUID;
  m         RECORD;
BEGIN
  IF v_uid IS NULL OR v_session IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  SELECT m2.support, m2.expires_at, m2.support_grant INTO m
  FROM public.user_profiles p
  JOIN public.organization_members m2 ON m2.user_id = p.id AND m2.organization_id = p_org
  JOIN public.organizations o ON o.id = m2.organization_id
  WHERE p.id = v_uid AND p.active AND m2.active AND o.status = 'active'
    AND (NOT m2.support OR (m2.expires_at > now() AND public.is_platform_admin() AND coalesce(auth.jwt() ->> 'aal', '') = 'aal2'));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not an active member of that organisation' USING ERRCODE = '42501';
  END IF;

  SELECT sc.organization_id, sc.grant_id INTO v_prior, v_prior_grant FROM security_audit.session_company sc WHERE sc.session_id = v_session AND sc.user_id = v_uid;
  -- Choosing a support company binds the session to the grant that is current now; an elevation survives only a re-choice under the
  -- same grant.
  INSERT INTO security_audit.session_company (session_id, user_id, organization_id, grant_id)
  VALUES (v_session, v_uid, p_org, CASE WHEN m.support THEN m.support_grant END)
  ON CONFLICT (session_id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        grant_id = EXCLUDED.grant_id,
        selected_at = CASE WHEN security_audit.session_company.organization_id = EXCLUDED.organization_id THEN security_audit.session_company.selected_at ELSE now() END,
        elevated_until = CASE WHEN security_audit.session_company.organization_id = EXCLUDED.organization_id
                               AND security_audit.session_company.grant_id IS NOT DISTINCT FROM EXCLUDED.grant_id
                              THEN security_audit.session_company.elevated_until END
    WHERE security_audit.session_company.user_id = v_uid;
  -- Logged in the same transaction: a choice of another company, and also a choice of the same company under another support grant
  -- (a window reopened, perhaps by another session, since this session last chose it): that is a new entry into the company.
  IF v_prior IS DISTINCT FROM p_org
     OR v_prior_grant IS DISTINCT FROM (CASE WHEN m.support THEN m.support_grant END) THEN
    INSERT INTO security_audit.org_entry_log (organization_id, user_id, via, session_id, support_expires_at)
    VALUES (p_org, v_uid, CASE WHEN v_prior IS NULL THEN 'login_choice' ELSE 'switch' END, v_session, CASE WHEN m.support THEN m.expires_at END);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.switch_organization(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_organization(UUID) TO authenticated;

-- The person's own companies (active ordinary memberships in active companies), never anyone else's and never support access.
CREATE OR REPLACE FUNCTION public.my_organizations()
RETURNS TABLE (organization_id UUID, name TEXT, slug TEXT, role TEXT, is_current BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.id, o.name, o.slug, m.role, (o.id = (SELECT s.organization_id FROM public._session_membership() s))
  FROM public.user_profiles p
  JOIN public.organization_members m ON m.user_id = p.id
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND m.active = TRUE AND NOT m.support AND o.status = 'active'
  ORDER BY o.name, o.id
$$;
REVOKE ALL ON FUNCTION public.my_organizations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_organizations() TO authenticated;

-- What the app needs to route and to label the session. Describes the caller's own session only.
CREATE OR REPLACE FUNCTION public.my_session()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  s       RECORD;
  v_owner BOOLEAN;
  v_count INTEGER;
  v_name  TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public._session_membership();
  v_owner := public.is_platform_admin();
  SELECT count(*) INTO v_count
  FROM public.user_profiles p
  JOIN public.organization_members m ON m.user_id = p.id
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE p.id = v_uid AND p.active AND p.must_change_password = FALSE AND m.active AND NOT m.support AND o.status = 'active';
  IF s.organization_id IS NOT NULL THEN
    SELECT o.name INTO v_name FROM public.organizations o WHERE o.id = s.organization_id;
  END IF;
  RETURN jsonb_build_object(
    'user_id', v_uid,
    'organization_id', s.organization_id,
    'organization_name', v_name,
    'role', s.role,
    'secondary_role', s.secondary_role,
    'hidden_sections', coalesce(to_jsonb(s.hidden_sections), '[]'::JSONB),
    'support', coalesce(s.is_support, FALSE),
    'read_only', coalesce(s.is_support AND coalesce(s.elevated_until, '-infinity'::TIMESTAMPTZ) <= now(), FALSE),
    'support_expires_at', CASE WHEN s.is_support THEN s.expires_at END,
    'elevated_until', CASE WHEN s.is_support AND s.elevated_until > now() THEN s.elevated_until END,
    'platform_admin', v_owner,
    'organization_count', v_count,
    'needs_choice', s.organization_id IS NULL AND (v_owner OR v_count >= 1)
  );
END
$$;
REVOKE ALL ON FUNCTION public.my_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_session() TO authenticated;

-- Every company, for the platform owner's list. Anyone else is refused.
CREATE OR REPLACE FUNCTION public.platform_list_organizations()
RETURNS TABLE (organization_id UUID, name TEXT, slug TEXT, status TEXT, active_members BIGINT, own_membership BOOLEAN, support_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  RETURN QUERY
  SELECT o.id, o.name, o.slug, o.status,
         (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o.id AND m.active AND NOT m.support),
         EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = o.id AND m.user_id = auth.uid() AND m.active AND NOT m.support),
         (SELECT m.expires_at FROM public.organization_members m
          WHERE m.organization_id = o.id AND m.user_id = auth.uid() AND m.active AND m.support AND m.expires_at > now())
  FROM public.organizations o
  ORDER BY o.name, o.id;
END
$$;
REVOKE ALL ON FUNCTION public.platform_list_organizations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_organizations() TO authenticated;

-- The platform owner enters a company for this session. A company where they hold an ordinary membership is simply chosen. Otherwise
-- an expiring SUPPORT membership is created (admin role, read-only until elevated): 2 hours unless asked for less or more, 8 at most.
-- Entering again while the window is open keeps the same expiry; only a new call after it has ended opens a new window. The entry is
-- logged in this same transaction.
CREATE OR REPLACE FUNCTION public.platform_enter_organization(p_org UUID, p_reason TEXT, p_hours NUMERIC DEFAULT 2)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_session UUID := nullif(auth.jwt() ->> 'session_id', '')::UUID;
  v_reason  TEXT := btrim(coalesce(p_reason, ''));
  v_hours   NUMERIC := coalesce(p_hours, 2);
  v_expires TIMESTAMPTZ;
  v_via     TEXT;
  v_grant   UUID;
  m         RECORD;
BEGIN
  IF v_uid IS NULL OR v_session IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  IF length(v_reason) < 5 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for entering this company (5 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  IF v_hours < 0.25 OR v_hours > 8 THEN
    RAISE EXCEPTION 'Support access lasts between 15 minutes and 8 hours' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.status = 'active') THEN
    RAISE EXCEPTION 'That company does not exist or is not active' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO m FROM public.organization_members WHERE user_id = v_uid AND organization_id = p_org FOR UPDATE;
  IF FOUND AND NOT m.support AND m.active THEN
    v_via := 'platform_member';
  ELSE
    v_via := 'platform_support';
    IF FOUND AND m.support AND m.active AND m.expires_at > now() THEN
      v_expires := m.expires_at;
      v_grant := m.support_grant;
    ELSE
      -- A new window is a new grant: every selection and elevation made under an earlier one, in any session, stops counting.
      v_expires := now() + make_interval(secs => (v_hours * 3600)::DOUBLE PRECISION);
      v_grant := gen_random_uuid();
      INSERT INTO public.organization_members (user_id, organization_id, role, secondary_role, active, support, expires_at, support_reason, support_grant, hidden_sections)
      VALUES (v_uid, p_org, 'admin', NULL, TRUE, TRUE, v_expires, v_reason, v_grant, '{}')
      ON CONFLICT (user_id, organization_id) DO UPDATE
        SET role = 'admin', secondary_role = NULL, active = TRUE, support = TRUE, expires_at = EXCLUDED.expires_at,
            support_reason = EXCLUDED.support_reason, support_grant = EXCLUDED.support_grant, hidden_sections = '{}', updated_at = now();
    END IF;
  END IF;

  INSERT INTO security_audit.session_company (session_id, user_id, organization_id, elevated_until, grant_id)
  VALUES (v_session, v_uid, p_org, NULL, v_grant)
  ON CONFLICT (session_id) DO UPDATE SET organization_id = EXCLUDED.organization_id, selected_at = now(), elevated_until = NULL, grant_id = EXCLUDED.grant_id
    WHERE security_audit.session_company.user_id = v_uid;
  INSERT INTO security_audit.org_entry_log (organization_id, user_id, via, session_id, reason, support_expires_at)
  VALUES (p_org, v_uid, v_via, v_session, v_reason, v_expires);

  RETURN jsonb_build_object('organization_id', p_org, 'support', v_via = 'platform_support', 'read_only', v_via = 'platform_support', 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.platform_enter_organization(UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_enter_organization(UUID, TEXT, NUMERIC) TO authenticated;

-- Write access for THIS session of a support entry, for a stated reason, for 30 minutes unless asked otherwise (5 to 120), and never
-- beyond the support window itself. Logged in the same transaction.
CREATE OR REPLACE FUNCTION public.platform_elevate_support(p_org UUID, p_reason TEXT, p_minutes INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_session UUID := nullif(auth.jwt() ->> 'session_id', '')::UUID;
  v_reason  TEXT := btrim(coalesce(p_reason, ''));
  v_minutes INTEGER := coalesce(p_minutes, 30);
  v_until   TIMESTAMPTZ;
  m         RECORD;
BEGIN
  IF v_uid IS NULL OR v_session IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  IF length(v_reason) < 5 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for write access (5 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  IF v_minutes < 5 OR v_minutes > 120 THEN
    RAISE EXCEPTION 'Write access lasts between 5 and 120 minutes' USING ERRCODE = '22023';
  END IF;
  -- Only for the company this session has entered, and only while the support window is open.
  SELECT m2.expires_at INTO m
  FROM security_audit.session_company sc
  JOIN public.organization_members m2 ON m2.user_id = sc.user_id AND m2.organization_id = sc.organization_id
  JOIN public.organizations o ON o.id = m2.organization_id
  WHERE sc.session_id = v_session AND sc.user_id = v_uid AND sc.organization_id = p_org
    AND m2.support AND m2.active AND m2.expires_at > now() AND o.status = 'active'
    AND sc.grant_id = m2.support_grant
  FOR UPDATE OF m2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enter the company with a reason first (support access missing or ended)' USING ERRCODE = '42501';
  END IF;
  v_until := least(now() + make_interval(mins => v_minutes), m.expires_at);
  UPDATE security_audit.session_company SET elevated_until = v_until WHERE session_id = v_session AND user_id = v_uid;
  INSERT INTO security_audit.org_entry_log (organization_id, user_id, via, session_id, reason, write_access, support_expires_at)
  VALUES (p_org, v_uid, 'platform_elevate', v_session, v_reason, TRUE, m.expires_at);
  RETURN jsonb_build_object('organization_id', p_org, 'elevated_until', v_until, 'expires_at', m.expires_at);
END
$$;
REVOKE ALL ON FUNCTION public.platform_elevate_support(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_elevate_support(UUID, TEXT, INTEGER) TO authenticated;

-- Leaves the company for this session (back to the platform list). The support window itself runs out on its own.
CREATE OR REPLACE FUNCTION public.platform_exit_organization()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_session UUID := nullif(auth.jwt() ->> 'session_id', '')::UUID;
  v_org     UUID;
BEGIN
  IF v_uid IS NULL OR v_session IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform access only' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_platform_aal();
  DELETE FROM security_audit.session_company WHERE session_id = v_session AND user_id = v_uid RETURNING organization_id INTO v_org;
  IF v_org IS NOT NULL THEN
    INSERT INTO security_audit.org_entry_log (organization_id, user_id, via, session_id) VALUES (v_org, v_uid, 'platform_exit', v_session);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.platform_exit_organization() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_exit_organization() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. A support session that has not been elevated cannot write -------------------------------------------
-- Runs once per statement on every company table, so it also stops the definer functions (which skip row-level security). Trigger
-- functions don't need the caller to hold EXECUTE; the check itself reads the session, not the role.
CREATE OR REPLACE FUNCTION public.support_readonly_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.session_read_only() THEN
    RAISE EXCEPTION 'Support access is read-only. Ask for write access first.' USING ERRCODE = '42501', HINT = 'support_read_only';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.support_readonly_guard() FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_schema AS s, c.table_name AS t
    FROM information_schema.columns c
    JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
    WHERE c.column_name = 'organization_id' AND c.table_schema IN ('public', 'security_audit')
      -- Access records are written by the platform functions and by the member functions, which have their own rules.
      AND c.table_name NOT IN ('user_profiles', 'organization_members', 'organization_invites', 'org_entry_log', 'session_company')
    ORDER BY 1, 2
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON %I.%I', r.s, r.t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', r.s, r.t);
  END LOOP;
END
$do$;

-- Files: uploads, replacements and deletions follow the same rule. RESTRICTIVE, so it can only take access away.
DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '036: storage schema not found, skipping the Storage read-only rule';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS "support read-only insert" ON storage.objects;
  DROP POLICY IF EXISTS "support read-only update" ON storage.objects;
  DROP POLICY IF EXISTS "support read-only delete" ON storage.objects;
  CREATE POLICY "support read-only insert" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT (SELECT public.session_read_only()));
  CREATE POLICY "support read-only update" ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT (SELECT public.session_read_only())) WITH CHECK (NOT (SELECT public.session_read_only()));
  CREATE POLICY "support read-only delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT (SELECT public.session_read_only()));
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Members: support is flagged, never counted, never changed by support ---------------------------------
-- Members of the session's company (admins only), support members flagged with their expiry. Support members whose window has ended or
-- who were switched off are not listed (the entry log keeps that history).
DROP FUNCTION IF EXISTS public.org_members();
CREATE FUNCTION public.org_members()
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, username TEXT, role TEXT, secondary_role TEXT, active BOOLEAN,
               last_login_at TIMESTAMPTZ, hidden_sections TEXT[], must_change_password BOOLEAN, created_at TIMESTAMPTZ,
               support BOOLEAN, expires_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.user_id, p.email, p.full_name, p.username, m.role, m.secondary_role, m.active, p.last_login_at,
         m.hidden_sections, p.must_change_password, m.created_at, m.support, m.expires_at
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
    AND (NOT m.support OR (m.active AND m.expires_at > now()))
  ORDER BY m.support, coalesce(nullif(p.full_name, ''), p.email), p.email
$$;
REVOKE ALL ON FUNCTION public.org_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members() TO authenticated;

-- An admin changes a member's role, access and page access in the session's company. As 012, plus: a support session can't change
-- anything here (no new admins, no role changes, no extending anyone); a support membership can only be switched off by the company's
-- own admins; and support members are not counted when checking that an admin remains.
CREATE OR REPLACE FUNCTION public.set_member_access(
  p_user            UUID,
  p_role            TEXT    DEFAULT NULL,
  p_active          BOOLEAN DEFAULT NULL,
  p_secondary_role  TEXT    DEFAULT NULL,
  p_clear_secondary BOOLEAN DEFAULT FALSE,
  p_hidden_sections TEXT[]  DEFAULT NULL
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
  PERFORM public.assert_privileged_aal();
  IF v_uid IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change member access' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public._session_membership() s WHERE s.is_support) THEN
    RAISE EXCEPTION 'Support access cannot change who has access to the company' USING ERRCODE = '42501';
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
  IF m.support AND (p_role IS NOT NULL OR p_secondary_role IS NOT NULL OR coalesce(p_clear_secondary, FALSE) OR p_hidden_sections IS NOT NULL
                    OR p_active IS DISTINCT FROM FALSE) THEN
    RAISE EXCEPTION 'A support membership can only be switched off' USING ERRCODE = '42501';
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

  -- Was an active admin and won't be: someone else (not support) must still be one.
  IF m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
     AND (NOT v_active OR 'admin' NOT IN (v_role, coalesce(v_second, ''))) THEN
    SELECT count(*) INTO v_admins FROM (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = v_org AND active AND NOT support AND user_id <> p_user AND 'admin' IN (role, coalesce(secondary_role, ''))
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

  -- A support member has no company of their own to keep in step.
  IF m.support THEN
    RETURN;
  END IF;

  -- keep the profile in step (as in 007)
  SELECT organization_id INTO v_cur FROM public.user_profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_cur = v_org THEN
    IF NOT m.active THEN
      SELECT m2.organization_id INTO v_alt
      FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
      WHERE m2.user_id = p_user AND m2.active AND NOT m2.support AND o.status = 'active' AND m2.organization_id <> v_org
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

-- The owner adding someone as an ordinary member (SQL editor / service role) turns any support membership of theirs into an ordinary one.
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
  ON CONFLICT (user_id, organization_id) DO UPDATE
    SET role = EXCLUDED.role, active = TRUE, support = FALSE, expires_at = NULL, support_reason = NULL, support_grant = NULL, updated_at = now();

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

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. Who has entered the company -------------------------------------------------------------------------
-- The company's own admins read the entries into THEIR company (choices, switches, support entries with the reason, elevations and
-- exits). Names only, no e-mail addresses; anyone who came in through the platform is shown as Tolra support.
CREATE OR REPLACE FUNCTION public.org_entry_history(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (at TIMESTAMPTZ, via TEXT, person TEXT, reason TEXT, write_access BOOLEAN, support_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT l.at, l.via,
         CASE WHEN l.via LIKE 'platform\_%' THEN 'Tolra support'
              ELSE (SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END
                    FROM public.user_profiles p WHERE p.id = l.user_id) END,
         l.reason, l.write_access, l.support_expires_at
  FROM security_audit.org_entry_log l
  WHERE l.organization_id = v_org
  ORDER BY l.at DESC, l.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END
$$;
REVOKE ALL ON FUNCTION public.org_entry_history(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_entry_history(INTEGER) TO authenticated;
