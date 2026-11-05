-- TEST ONLY prerequisites. AI implementations/policies are loaded verbatim from the source being reviewed.
-- Auth/session/MFA/audit infrastructure below is a stand-in, not hosted-Supabase verification.
DO $$ BEGIN
 IF current_database() NOT LIKE 'ai_verify_%' OR to_regclass('public.organizations') IS NOT NULL THEN RAISE EXCEPTION 'Fresh ai_verify_* database required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA security_audit;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
CREATE TABLE organizations(id uuid PRIMARY KEY);
CREATE TABLE user_profiles(id uuid PRIMARY KEY, email text, organization_id uuid, role text);
CREATE TABLE quotes(id uuid PRIMARY KEY, organization_id uuid, status text);
CREATE TABLE security_audit.platform_admins(user_id uuid PRIMARY KEY);
CREATE TABLE security_audit.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid,
 actor_email text, action text, entity_table text, entity_id text, metadata jsonb, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
CREATE FUNCTION current_user_organization_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT organization_id FROM user_profiles WHERE id=auth.uid() $$;
CREATE FUNCTION has_org_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT coalesce((SELECT role=ANY(roles) FROM user_profiles WHERE id=auth.uid()),false) $$;
CREATE FUNCTION _session_membership() RETURNS TABLE(is_support boolean) LANGUAGE sql STABLE AS $$ SELECT coalesce((auth.jwt()->>'support')::boolean,false) $$;
CREATE FUNCTION assert_privileged_aal() RETURNS void LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF has_org_role(ARRAY['admin']) AND (auth.jwt()->>'aal') IS DISTINCT FROM 'aal2' THEN RAISE EXCEPTION 'MFA required' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION require_admin_mfa_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM assert_privileged_aal(); RETURN NULL; END $$;
CREATE FUNCTION support_readonly_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF coalesce((auth.jwt()->>'support')::boolean,false) THEN RAISE EXCEPTION 'support refused' USING ERRCODE='42501'; END IF; RETURN NULL;
END $$;
CREATE FUNCTION security_audit.log_row_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW,OLD); END $$;
-- Empty release-145 prerequisites only, so the exact public 146 file can be tested without inventing an AI implementation.
CREATE TABLE company_setup_progress(organization_id uuid);
CREATE FUNCTION accounting_cloud_connections_ready() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated, anon,service_role;
