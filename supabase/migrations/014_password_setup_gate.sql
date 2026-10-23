-- =====================================================================================================
-- 014: a temporary password gives no business access (audit B0a: SEC3).
--
-- When an admin sets someone's password with "must change password" on, that person may sign in, but until they
-- choose their own password their session must not read or write business data: not through the app's API, not
-- directly through the REST API, RPCs or storage. The page redirect in middleware is not enough on its own.
--
-- The access helpers every business policy is built on (current/user organisation, role, secondary role,
-- has_org_role) now also require user_profiles.must_change_password = false. So for a temporary-password session
-- they return NULL / false and every organisation-scoped policy refuses, exactly as for a deactivated member.
--
-- Still allowed, so set-up can finish: reading one's own profile and memberships (policies on auth.uid(), not on
-- these helpers), and /api/auth/change-password, which changes the password and clears the flag with the service
-- role. must_change_password itself stays writable only by the service role (012).
--
-- Forward only: replaces the five helpers with identical signatures (grants are kept). Safe to run more than once.
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
    AND p.must_change_password = FALSE
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
    AND p.must_change_password = FALSE
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
    AND p.must_change_password = FALSE
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
    AND p.must_change_password = FALSE
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
      AND p.must_change_password = FALSE
      AND o.status = 'active'
      AND m.active = TRUE
      AND (m.role = ANY (allowed_roles) OR m.secondary_role = ANY (allowed_roles))
  )
$$;
