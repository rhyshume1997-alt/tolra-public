-- =====================================================================================================
-- 011: USERNAMES + SIGN-IN RATE LIMITS
--
-- 1. user_profiles.username: an optional sign-in name, unique across the whole platform (stored lower-case,
--    3-32 characters: letters, digits, dot, dash, underscore; starts with a letter or digit). The e-mail stays the
--    login's identity and is still used for invites and password resets.
--    Only an admin sets it, through Admin > Users (the server route uses the service role). Signed-in users, admins
--    included, can't change it directly: the profile guard below refuses it.
-- 2. Username -> e-mail lookup happens only in the server sign-in / reset routes (service role). No function or
--    policy exposes usernames or e-mails to anonymous callers.
-- 3. auth_rate_limits + auth_rate_hit(): a small, service-role-only counter the sign-in and reset routes use to
--    throttle attempts per identifier and per IP. Keys are SHA-256 hashes made by the app; no e-mail, username or IP
--    is stored in clear.
-- 4. org_members() also returns the username, for Admin > Users.
-- Run after 010. Safe to re-run.
-- =====================================================================================================

-- ----- 1. username ------------------------------------------------------------------------------------
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS username TEXT;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_username_format') THEN
    ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_username_format
      CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
  END IF;
END
$do$;

-- The format check forces lower case, so a plain unique index is case-insensitive in practice.
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_username_key ON public.user_profiles (username) WHERE username IS NOT NULL;

-- ----- 2. profile guard: usernames only through the admin route ----------------------------------------
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

-- ----- 3. sign-in / reset rate limits (service role only) -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  id         BIGSERIAL PRIMARY KEY,
  bucket     TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_lookup_idx ON public.auth_rate_limits (bucket, key_hash, created_at DESC);
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_rate_limits FROM PUBLIC, anon, authenticated;

-- Records one attempt and says whether it is still within the limit (max attempts per window).
CREATE OR REPLACE FUNCTION public.auth_rate_hit(p_bucket TEXT, p_key_hash TEXT, p_window_seconds INTEGER, p_max INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  n INTEGER;
BEGIN
  IF p_bucket !~ '^[a-z_:]{1,40}$' OR p_key_hash !~ '^[0-9a-f]{64}$' OR p_window_seconds NOT BETWEEN 1 AND 86400 OR p_max NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'auth_rate_hit: bad arguments' USING ERRCODE = '22023';
  END IF;
  -- Keep the table small: drop anything older than a day (cheap, indexed by created_at within the key).
  DELETE FROM public.auth_rate_limits WHERE created_at < now() - INTERVAL '1 day' AND id IN (
    SELECT id FROM public.auth_rate_limits WHERE created_at < now() - INTERVAL '1 day' LIMIT 500);
  INSERT INTO public.auth_rate_limits (bucket, key_hash) VALUES (p_bucket, p_key_hash);
  SELECT count(*) INTO n FROM public.auth_rate_limits
  WHERE bucket = p_bucket AND key_hash = p_key_hash AND created_at > now() - make_interval(secs => p_window_seconds);
  RETURN n <= p_max;
END;
$$;
REVOKE ALL ON FUNCTION public.auth_rate_hit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_rate_hit(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- ----- 4. org_members(): + username ----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.org_members();
CREATE FUNCTION public.org_members()
RETURNS TABLE (user_id UUID, email TEXT, full_name TEXT, username TEXT, role TEXT, secondary_role TEXT, active BOOLEAN, last_login_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.user_id, p.email, p.full_name, p.username, m.role, m.secondary_role, m.active, p.last_login_at
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  ORDER BY coalesce(nullif(p.full_name, ''), p.email), p.email
$$;
REVOKE ALL ON FUNCTION public.org_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_members() TO authenticated;

-- Check. Expect: username_column = 1, username_index = 1, rate_table_rls = true, anon_can_rate_hit = false,
-- authenticated_can_rate_hit = false.
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'username') AS username_column,
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'user_profiles_username_key') AS username_index,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.auth_rate_limits'::regclass) AS rate_table_rls,
  has_function_privilege('anon', 'public.auth_rate_hit(text, text, integer, integer)', 'EXECUTE') AS anon_can_rate_hit,
  has_function_privilege('authenticated', 'public.auth_rate_hit(text, text, integer, integer)', 'EXECUTE') AS authenticated_can_rate_hit;
