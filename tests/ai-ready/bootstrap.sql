-- TEST ONLY: minimal auth/session/audit stand-ins for an EMPTY throwaway PostgreSQL database.
-- The AI tables, policies, functions and grants are the real migrations, loaded separately.
-- This does not prove Supabase JWT validation, the full session framework, or hosted extensions.
DO $$ BEGIN
 IF current_database() NOT LIKE 'ai_ready_test_%' OR to_regclass('public.organizations') IS NOT NULL THEN
  RAISE EXCEPTION 'Requires an empty ai_ready_test_* database';
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA security_audit;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
CREATE TABLE public.organizations(id uuid PRIMARY KEY);
CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, email text, organization_id uuid REFERENCES public.organizations, role text);
CREATE TABLE public.quotes(id uuid PRIMARY KEY, organization_id uuid, status text);
CREATE TABLE security_audit.audit_log(id uuid DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, actor_email text,
 action text, entity_table text, entity_id text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
CREATE FUNCTION public.current_user_organization_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT organization_id FROM public.user_profiles WHERE id=auth.uid() $$;
CREATE FUNCTION public.has_org_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT role=ANY(roles) FROM public.user_profiles WHERE id=auth.uid()),false) $$;
CREATE FUNCTION public._session_membership() RETURNS TABLE(is_support boolean) LANGUAGE sql STABLE AS $$
 SELECT coalesce((auth.jwt()->>'support')::boolean,false) $$;
CREATE FUNCTION public.assert_privileged_aal() RETURNS void LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF public.has_org_role(ARRAY['admin']) AND (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2' THEN RAISE EXCEPTION 'MFA required' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION public.require_admin_mfa_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM public.assert_privileged_aal(); RETURN NULL; END $$;
CREATE FUNCTION public.support_readonly_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF coalesce((auth.jwt()->>'support')::boolean,false) THEN RAISE EXCEPTION 'Support read only' USING ERRCODE='42501'; END IF; RETURN NULL;
END $$;
CREATE FUNCTION security_audit.log_row_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW,OLD); END $$;
