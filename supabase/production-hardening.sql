-- LEGACY, ONLY FOR THE OLD JNREng PROJECT (the legacy project).
-- A NEW Supabase project must NOT run this file: migrations/000_base_schema.sql contains everything it provided
-- (and uses uuid ids). It is kept for history. It also assumes the old tables already exist (bigint ids).
--
-- ============================================
-- QUOTEFLOW AI - PRODUCTION HARDENING SQL
-- Safe to run more than once in Supabase SQL Editor.
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) ORGANIZATIONS
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- status is read by the access helpers (migrations/006); iso-security-patch.sql inserts it too.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'JNR Engineering Ltd', 'jnr-engineering')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

-- 2) USER PROFILES
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'office', 'workshop', 'viewer')),
  secondary_role TEXT CHECK (secondary_role IN ('office', 'workshop')),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  organization TEXT DEFAULT 'JNR Engineering',
  workshop_email TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS organization TEXT DEFAULT 'JNR Engineering',
  ADD COLUMN IF NOT EXISTS workshop_email TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE user_profiles
SET organization_id = '00000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_org ON user_profiles(organization_id);

CREATE OR REPLACE FUNCTION user_organization_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM user_profiles WHERE id = auth.uid() AND active = TRUE
$$;

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid() AND active = TRUE
$$;

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read profiles in their org" ON user_profiles;
DROP POLICY IF EXISTS "Admins can update profiles in their org" ON user_profiles;
DROP POLICY IF EXISTS "Users read own profile" ON user_profiles;
DROP POLICY IF EXISTS "Admins read all" ON user_profiles;
DROP POLICY IF EXISTS "Admins manage all" ON user_profiles;

CREATE POLICY "Users can read profiles in their org"
ON user_profiles FOR SELECT
USING (organization_id = user_organization_id());

CREATE POLICY "Admins can update profiles in their org"
ON user_profiles FOR UPDATE
USING (organization_id = user_organization_id() AND current_user_role() = 'admin')
WITH CHECK (organization_id = user_organization_id() AND current_user_role() = 'admin');

-- 3) TENANT COLUMNS ON EXISTING BUSINESS TABLES
DO $$
DECLARE
  table_name TEXT;
  business_tables TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'rfqs', 'quotes', 'jobs', 'invoices', 'machines'];
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id)', table_name);
      EXECUTE format('UPDATE public.%I SET organization_id = %L WHERE organization_id IS NULL', table_name, '00000000-0000-0000-0000-000000000001');
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      -- The legacy org-only FOR ALL "<table> org isolation" policy used to be created here. It OR-ed with
      -- the role-based policies and cancelled them, so it was removed: superseded by migrations/006.
    END IF;
  END LOOP;
END $$;

-- 4) SALES ORDERS / PURCHASE ORDERS / DELIVERY NOTES
CREATE TABLE IF NOT EXISTS sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  so_number TEXT NOT NULL,
  customer_id UUID,
  quote_id UUID,
  status TEXT NOT NULL DEFAULT 'open',
  order_date DATE DEFAULT CURRENT_DATE,
  delivery_date DATE,
  total_value DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  po_number TEXT NOT NULL,
  supplier_id UUID,
  status TEXT NOT NULL DEFAULT 'open',
  order_date DATE DEFAULT CURRENT_DATE,
  expected_date DATE,
  total_value DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  dn_number TEXT NOT NULL,
  sales_order_id UUID,
  customer_id UUID,
  delivery_date DATE DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY;

-- Legacy org-only "org members can manage sales orders / purchase orders / delivery notes" policies were
-- created here. Removed: superseded by migrations/006_production_hardening.sql, which creates the
-- role-checked policies. Do not re-add org-only FOR ALL policies; they cancel the role restrictions.

-- 5) EMAIL HISTORY - DRAFTS ONLY UNTIL DOMAIN EMAIL IS VERIFIED
CREATE TABLE IF NOT EXISTS email_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('drafted', 'copied', 'sent_manually', 'sent_via_system', 'failed')),
  related_to_type TEXT CHECK (related_to_type IN ('invoice', 'quote', 'sales_order', 'purchase_order', 'delivery_note', 'rfq', 'general')),
  related_to_id UUID,
  drafted_by UUID REFERENCES user_profiles(id),
  drafted_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

ALTER TABLE email_history ENABLE ROW LEVEL SECURITY;
-- The legacy org-only "org email history" FOR ALL policy was removed: superseded by migrations/006.

-- 6) AUDIT FOUNDATION
CREATE SCHEMA IF NOT EXISTS security_audit;
CREATE TABLE IF NOT EXISTS security_audit.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
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
DROP POLICY IF EXISTS "audit admins read org" ON security_audit.audit_log;

CREATE POLICY "audit insert own org" ON security_audit.audit_log
FOR INSERT WITH CHECK (organization_id = user_organization_id() AND actor_user_id = auth.uid());

CREATE POLICY "audit admins read org" ON security_audit.audit_log
FOR SELECT USING (organization_id = user_organization_id() AND current_user_role() = 'admin');

CREATE OR REPLACE FUNCTION security_audit.prevent_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security audit log is append-only and cannot be changed or deleted';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_prevent_mutation ON security_audit.audit_log;
CREATE TRIGGER audit_log_prevent_mutation
BEFORE UPDATE OR DELETE ON security_audit.audit_log
FOR EACH ROW EXECUTE FUNCTION security_audit.prevent_audit_mutation();

CREATE OR REPLACE VIEW public.audit_log_view WITH (security_invoker = true) AS
SELECT id, organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata, ip_address, user_agent, request_id, previous_hash, hash, created_at
FROM security_audit.audit_log;

CREATE OR REPLACE VIEW public.audit_log_ingest WITH (security_invoker = true) AS
SELECT organization_id, actor_user_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata, ip_address, user_agent, request_id
FROM security_audit.audit_log;

GRANT SELECT ON public.audit_log_view TO authenticated;
-- Direct client INSERT on audit_log_ingest is revoked by migrations/006; clients call public.write_audit() instead.
-- GRANT INSERT ON public.audit_log_ingest TO authenticated;

-- ============================================
-- Create user_profiles rows for each auth user after creating them in Supabase Authentication
-- (id = the auth user's UUID; role is one of admin / office / workshop / viewer; set
-- organization_id to the user's company). Keep real names and email addresses out of this repo.
-- ============================================
