-- LEGACY, ONLY FOR THE OLD JNREng PROJECT (the legacy project).
-- A NEW Supabase project must NOT run this file: migrations/000_base_schema.sql contains everything it provided
-- (and uses uuid ids). It is kept for history. It also assumes the old tables already exist (bigint ids).
--
-- ============================================
-- QUOTEFLOW AI - ISO/SOC SECURITY FOUNDATION
-- Safe to run more than once in Supabase SQL Editor.
--
-- What this adds:
-- 1. Organization/tenant isolation columns
-- 2. Helper functions for tenant and role checks
-- 3. Row Level Security policies on production tables
-- 4. Separate append-only security audit schema
-- 5. Queryable audit views for admins
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================
-- ORGANIZATIONS / TENANTS
-- ============================================

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO organizations (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'JNR Engineering', 'jnr-engineering', 'active')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  updated_at = NOW();

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE user_profiles
SET organization_id = '00000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

ALTER TABLE user_profiles
  ALTER COLUMN organization_id SET NOT NULL;

-- ============================================
-- AUTHZ HELPER FUNCTIONS
-- ============================================

CREATE OR REPLACE FUNCTION public.current_user_organization_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM public.user_profiles
  WHERE id = auth.uid()
    AND active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_profiles
  WHERE id = auth.uid()
    AND active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_secondary_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT secondary_role
  FROM public.user_profiles
  WHERE id = auth.uid()
    AND active = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = auth.uid()
      AND active = TRUE
      AND (
        role = ANY(allowed_roles)
        OR secondary_role = ANY(allowed_roles)
      )
  )
$$;

-- Replace earlier recursive user_profiles policies with helper-based policies.
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own profile" ON user_profiles;
DROP POLICY IF EXISTS "Admins read all" ON user_profiles;
DROP POLICY IF EXISTS "Admins manage all" ON user_profiles;

CREATE POLICY "Users read own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Admins read all" ON user_profiles
  FOR SELECT USING (
    organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  );

CREATE POLICY "Admins manage all" ON user_profiles
  FOR ALL USING (
    organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  )
  WITH CHECK (
    organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  );

-- ============================================
-- TENANT ISOLATION COLUMNS + RLS
-- ============================================

DO $$
DECLARE
  table_name TEXT;
  allowed_roles TEXT[];
  role_check TEXT;
  protected_tables TEXT[] := ARRAY[
    'rfqs',
    'quotes',
    'jobs',
    'invoices',
    'stock',
    'suppliers',
    'machines',
    'sales_orders',
    'purchase_orders',
    'delivery_notes'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id)', table_name);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id)', table_name);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id)', table_name);
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', table_name);
      EXECUTE format('UPDATE public.%I SET organization_id = %L WHERE organization_id IS NULL', table_name, '00000000-0000-0000-0000-000000000001');
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', table_name);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);

      EXECUTE format('DROP POLICY IF EXISTS "%s tenant select" ON public.%I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s tenant insert" ON public.%I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s tenant update" ON public.%I', table_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS "%s tenant delete admin" ON public.%I', table_name, table_name);

      allowed_roles := CASE
        WHEN table_name = 'invoices' THEN ARRAY['admin']
        WHEN table_name IN ('jobs') THEN ARRAY['admin', 'office', 'workshop', 'viewer']
        WHEN table_name IN ('delivery_notes', 'machines') THEN ARRAY['admin', 'office', 'workshop']
        ELSE ARRAY['admin', 'office']
      END;
      role_check := 'public.has_org_role(ARRAY[' || (
        SELECT string_agg(quote_literal(role_name), ', ')
        FROM unnest(allowed_roles) AS role_name
      ) || '])';

      EXECUTE format(
        'CREATE POLICY "%s tenant select" ON public.%I FOR SELECT USING (organization_id = public.current_user_organization_id() AND %s)',
        table_name,
        table_name,
        role_check
      );
      EXECUTE format(
        'CREATE POLICY "%s tenant insert" ON public.%I FOR INSERT WITH CHECK (organization_id = public.current_user_organization_id() AND %s)',
        table_name,
        table_name,
        role_check
      );
      EXECUTE format(
        'CREATE POLICY "%s tenant update" ON public.%I FOR UPDATE USING (organization_id = public.current_user_organization_id() AND %s) WITH CHECK (organization_id = public.current_user_organization_id() AND %s)',
        table_name,
        table_name,
        role_check,
        role_check
      );
      EXECUTE format(
        'CREATE POLICY "%s tenant delete admin" ON public.%I FOR DELETE USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY[''admin'']))',
        table_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

-- ============================================
-- IMMUTABLE, SEPARATE AUDIT LOG
-- ============================================

CREATE SCHEMA IF NOT EXISTS security_audit;

CREATE TABLE IF NOT EXISTS security_audit.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id),
  actor_user_id UUID REFERENCES auth.users(id),
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id TEXT,
  old_data JSONB,
  new_data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,
  previous_hash TEXT,
  hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE security_audit.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit insert own org" ON security_audit.audit_log;
CREATE POLICY "audit insert own org" ON security_audit.audit_log
  FOR INSERT WITH CHECK (
    organization_id = public.current_user_organization_id()
    AND actor_user_id = auth.uid()
  );

DROP POLICY IF EXISTS "audit admins read org" ON security_audit.audit_log;
CREATE POLICY "audit admins read org" ON security_audit.audit_log
  FOR SELECT USING (
    organization_id = public.current_user_organization_id()
    AND public.has_org_role(ARRAY['admin'])
  );

CREATE OR REPLACE FUNCTION security_audit.prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security audit log is append-only and cannot be changed or deleted';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_prevent_mutation ON security_audit.audit_log;
CREATE TRIGGER audit_log_prevent_mutation
BEFORE UPDATE OR DELETE ON security_audit.audit_log
FOR EACH ROW EXECUTE FUNCTION security_audit.prevent_audit_mutation();

CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  previous TEXT;
BEGIN
  SELECT hash
  INTO previous
  FROM security_audit.audit_log
  WHERE organization_id IS NOT DISTINCT FROM NEW.organization_id
  ORDER BY created_at DESC
  LIMIT 1;

  NEW.previous_hash := previous;
  NEW.hash := encode(
    digest(
      coalesce(previous, '') ||
      coalesce(NEW.organization_id::TEXT, '') ||
      coalesce(NEW.actor_user_id::TEXT, '') ||
      NEW.action ||
      NEW.entity_table ||
      coalesce(NEW.entity_id, '') ||
      coalesce(NEW.old_data::TEXT, '') ||
      coalesce(NEW.new_data::TEXT, '') ||
      coalesce(NEW.metadata::TEXT, '') ||
      NEW.created_at::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_set_hash ON security_audit.audit_log;
CREATE TRIGGER audit_log_set_hash
BEFORE INSERT ON security_audit.audit_log
FOR EACH ROW EXECUTE FUNCTION security_audit.set_audit_hash();

REVOKE UPDATE, DELETE ON security_audit.audit_log FROM anon, authenticated;

-- Public views keep the raw audit table separate from application data,
-- while allowing Supabase/PostgREST to query or insert through controlled RLS.
CREATE OR REPLACE VIEW public.audit_log_view
WITH (security_invoker = true)
AS
SELECT
  id,
  organization_id,
  actor_user_id,
  actor_email,
  action,
  entity_table,
  entity_id,
  metadata,
  ip_address,
  user_agent,
  request_id,
  previous_hash,
  hash,
  created_at
FROM security_audit.audit_log;

CREATE OR REPLACE VIEW public.audit_log_ingest
WITH (security_invoker = true)
AS
SELECT
  organization_id,
  actor_user_id,
  actor_email,
  action,
  entity_table,
  entity_id,
  old_data,
  new_data,
  metadata,
  ip_address,
  user_agent,
  request_id
FROM security_audit.audit_log;

GRANT SELECT ON public.audit_log_view TO authenticated;
GRANT INSERT ON public.audit_log_ingest TO authenticated;

-- ============================================
-- AUTOMATED ROW CHANGE AUDITING
-- ============================================

CREATE OR REPLACE FUNCTION security_audit.log_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, security_audit
AS $$
DECLARE
  row_organization_id UUID;
  row_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_organization_id := COALESCE(NEW.organization_id, public.current_user_organization_id());
    row_id := NEW.id::TEXT;
  ELSIF TG_OP = 'UPDATE' THEN
    row_organization_id := COALESCE(NEW.organization_id, OLD.organization_id, public.current_user_organization_id());
    row_id := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
  ELSE
    row_organization_id := COALESCE(OLD.organization_id, public.current_user_organization_id());
    row_id := OLD.id::TEXT;
  END IF;

  INSERT INTO security_audit.audit_log (
    organization_id,
    actor_user_id,
    actor_email,
    action,
    entity_table,
    entity_id,
    old_data,
    new_data,
    metadata
  )
  VALUES (
    row_organization_id,
    auth.uid(),
    current_setting('request.jwt.claim.email', true),
    TG_OP,
    TG_TABLE_NAME,
    row_id,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    jsonb_build_object('source', 'database_trigger')
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  table_name TEXT;
  audited_tables TEXT[] := ARRAY[
    'rfqs',
    'quotes',
    'jobs',
    'invoices',
    'stock',
    'suppliers',
    'machines',
    'sales_orders',
    'purchase_orders',
    'delivery_notes',
    'user_profiles'
  ];
BEGIN
  FOREACH table_name IN ARRAY audited_tables LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || table_name || '_changes', table_name);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()',
        'audit_' || table_name || '_changes',
        table_name
      );
    END IF;
  END LOOP;
END $$;

COMMENT ON SCHEMA security_audit IS 'Separate append-only security audit schema for QuoteFlow ISO/SOC evidence.';
COMMENT ON TABLE security_audit.audit_log IS 'Hash-chained, append-only audit trail. Never update or delete rows.';
