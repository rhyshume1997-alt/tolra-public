-- 000: base schema for a FRESH Supabase project. Run this first, then 001 ... 007 in order.
--
-- What this file provides (so a new project does NOT need the three legacy root files
-- production-hardening.sql, iso-security-patch.sql or critical-prelaunch-security.sql):
--   1  extensions (pgcrypto in schema "extensions")
--   2  organizations and user_profiles (id = auth.users.id)
--   3  the business tables with uuid primary keys and the column names the app reads and writes:
--        customers, suppliers, stock, rfqs, quotes, jobs, invoices, sales_orders, purchase_orders,
--        delivery_notes, email_history, machines
--      (child tables, document counters, settings, bookings and the extra columns come from 001 - 006)
--   4  access helper functions (same hardened definitions as 006, so 001 - 005 can already use them)
--   5  row level security: ON for every table. The per-table role policies are created by 006 (which
--      replaces any policy on the business tables), so until 006 has run the business tables are deny-all.
--      user_profiles policies are defined here (006 does not touch that table).
--   6  security_audit schema: append-only, hash-chained audit_log, public.audit_log_view, row-change triggers
--
-- Idempotent: safe to run more than once. Everything is plain SQL for the Supabase SQL editor.
-- Document ids are uuid. Customer-facing numbers stay text: quote_ref, invoice_ref, job_no, dn_number,
-- so_number, po_ref.

BEGIN;

-- =====================================================================================================
-- 1. EXTENSIONS
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =====================================================================================================
-- 2. ORGANIZATIONS AND USER PROFILES
-- =====================================================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No organisation is created here: tenants are created with public.create_organization() (migration 007).

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'workshop' CHECK (role IN ('admin', 'office', 'workshop', 'viewer')),
  secondary_role  TEXT CHECK (secondary_role IS NULL OR secondary_role IN ('admin', 'office', 'workshop', 'viewer')),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  organization    TEXT,
  workshop_email  TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_required    BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_org ON public.user_profiles (organization_id);

-- =====================================================================================================
-- 3. BUSINESS TABLES (uuid ids)
-- created_by / updated_by are filled by create_with_lines() and by the app where it knows the user.
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  name            TEXT NOT NULL,
  contact_name    TEXT,
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.suppliers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id),
  name               TEXT NOT NULL,
  contact_name       TEXT,
  email              TEXT,
  phone              TEXT,
  notes              TEXT,
  on_time_rate       NUMERIC DEFAULT 100.00,
  reliability_status TEXT DEFAULT 'good',
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stock (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id),
  sku                TEXT NOT NULL,
  material           TEXT NOT NULL,
  current_stock      INTEGER DEFAULT 0,
  min_level          INTEGER DEFAULT 0,
  reorder_quantity   INTEGER DEFAULT 0,
  preferred_supplier TEXT,
  unit_price         NUMERIC,
  lead_time_days     TEXT,
  auto_purchase      BOOLEAN DEFAULT TRUE,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

CREATE TABLE IF NOT EXISTS public.rfqs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  customer        TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  description     TEXT,
  quantity        INTEGER,
  material        TEXT,
  estimated_value NUMERIC(14,2),
  status          TEXT DEFAULT 'new',
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Header only: the priced lines live in quote_line_items (001). Notes, terms and sent_at are added by 001 / 006.
CREATE TABLE IF NOT EXISTS public.quotes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  quote_ref       TEXT NOT NULL,
  rfq_id          UUID REFERENCES public.rfqs(id) ON DELETE SET NULL,
  customer        TEXT NOT NULL,
  description     TEXT,
  total_value     NUMERIC(14,2),
  status          TEXT DEFAULT 'draft',
  valid_until     DATE,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sales_orders and jobs reference each other, so the two cross foreign keys are added after both exist
-- (DEFERRABLE so a bulk import can load both tables in one transaction).
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id),
  so_number          TEXT NOT NULL,
  customer           TEXT,
  customer_id        UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_po        TEXT,
  quote_id           UUID REFERENCES public.quotes(id) ON DELETE SET NULL,
  quote_ref          TEXT,
  status             TEXT NOT NULL DEFAULT 'open',
  order_date         DATE DEFAULT CURRENT_DATE,
  delivery_date      DATE,
  total_value        NUMERIC(14,2),
  notes              TEXT,
  converted_to_job_id UUID,
  converted_at       TIMESTAMPTZ,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               UUID NOT NULL REFERENCES public.organizations(id),
  job_no                        TEXT NOT NULL,
  quote_id                      UUID REFERENCES public.quotes(id) ON DELETE SET NULL,
  customer                      TEXT NOT NULL,
  description                   TEXT,
  stage                         TEXT DEFAULT 'material',
  due_date                      DATE,
  value                         NUMERIC(14,2),
  status                        TEXT DEFAULT 'on_track',
  specification                 TEXT,
  drawings                      JSONB DEFAULT '[]'::jsonb,
  started_at                    TIMESTAMPTZ,
  finished_at                   TIMESTAMPTZ,
  converted_from_sales_order_id UUID,
  converted_at                  TIMESTAMPTZ,
  created_by                    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by                    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_converted_to_job_id_fkey' AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE public.sales_orders
      ADD CONSTRAINT sales_orders_converted_to_job_id_fkey FOREIGN KEY (converted_to_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_converted_from_sales_order_id_fkey' AND conrelid = 'public.jobs'::regclass) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_converted_from_sales_order_id_fkey FOREIGN KEY (converted_from_sales_order_id) REFERENCES public.sales_orders(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_status_check' AND conrelid = 'public.sales_orders'::regclass) THEN
    ALTER TABLE public.sales_orders
      ADD CONSTRAINT sales_orders_status_check CHECK (status IN ('open', 'confirmed', 'in_production', 'despatched', 'converted', 'closed'));
  END IF;
END
$do$;

-- Header: the printed invoice fields (invoice_date, terms, quote_ref, customer_po, carriage, amount_paid, paid_at)
-- are added by 005 / 006. description / quantity / unit_price hold the first line (the app also writes
-- the same line to invoice_line_items).
CREATE TABLE IF NOT EXISTS public.invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  invoice_ref     TEXT NOT NULL,
  job_id          UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  customer        TEXT NOT NULL,
  description     TEXT,
  quantity        NUMERIC(12,3),
  unit_price      NUMERIC(14,2),
  subtotal        NUMERIC(14,2),
  vat             NUMERIC(14,2),
  total           NUMERIC(14,2),
  status          TEXT DEFAULT 'draft',
  sent_date       TIMESTAMPTZ,
  due_date        DATE,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- po_number is kept (the page writes po_ref and po_number); neither is required on its own.
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id),
  po_ref            TEXT,
  po_number         TEXT,
  supplier          TEXT,
  order_date        DATE DEFAULT CURRENT_DATE,
  expected_delivery DATE,
  items             JSONB DEFAULT '[]'::jsonb,
  total_value       NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'sent',
  notes             TEXT,
  received_at       TIMESTAMPTZ,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_status_check' AND conrelid = 'public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_status_check CHECK (status IN ('draft', 'sent', 'confirmed', 'partial_received', 'received', 'cancelled'));
  END IF;
END
$do$;

-- Items printed on the note live in delivery_note_items (005). Status 'awaiting' is what the app creates.
CREATE TABLE IF NOT EXISTS public.delivery_notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id),
  dn_number        TEXT NOT NULL,
  customer         TEXT,
  customer_id      UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  sales_order_id   UUID REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  customer_email   TEXT,
  job_ref          TEXT,
  invoice_ref      TEXT,
  delivery_date    DATE DEFAULT CURRENT_DATE,
  tax_date         DATE,
  ship_date        DATE,
  ship_via         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  notes            TEXT,
  signed_by_name   TEXT,
  signed_at        TIMESTAMPTZ,
  signature_notes  TEXT,
  emailed_at       TIMESTAMPTZ,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_notes_status_check' AND conrelid = 'public.delivery_notes'::regclass) THEN
    ALTER TABLE public.delivery_notes
      ADD CONSTRAINT delivery_notes_status_check CHECK (status IN ('pending', 'awaiting', 'despatched', 'delivered', 'signed'));
  END IF;
END
$do$;

-- related_to_id is TEXT: the app stores the uuid of the quote / invoice / job / note it relates to.
-- 006 re-creates the status / related_to_type CHECK constraints with the full lists ('sending', 'job').
CREATE TABLE IF NOT EXISTS public.email_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  to_email        TEXT NOT NULL,
  to_name         TEXT,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('drafted', 'copied', 'sent_manually', 'sent_via_system', 'sending', 'failed')),
  related_to_type TEXT CHECK (related_to_type IN ('invoice', 'quote', 'sales_order', 'purchase_order', 'delivery_note', 'rfq', 'job', 'general')),
  related_to_id   TEXT,
  drafted_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  drafted_at      TIMESTAMPTZ DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

-- Core of the machine list; capacity columns come from 003.
CREATE TABLE IF NOT EXISTS public.machines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  name            TEXT NOT NULL,
  type            TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================================================
-- 4. ACCESS HELPERS (identical to the definitions in 006)
-- A user resolves to an organisation / role only while user_profiles.active AND organizations.status = 'active'.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION public.current_user_organization_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p.organization_id FROM public.user_profiles p JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND o.status = 'active' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p.organization_id FROM public.user_profiles p JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND o.status = 'active' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p.role FROM public.user_profiles p JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND o.status = 'active' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_secondary_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p.secondary_role FROM public.user_profiles p JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid() AND p.active = TRUE AND o.status = 'active' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(allowed_roles TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles p JOIN public.organizations o ON o.id = p.organization_id
    WHERE p.id = auth.uid() AND p.active = TRUE AND o.status = 'active'
      AND (p.role = ANY (allowed_roles) OR p.secondary_role = ANY (allowed_roles))
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
-- 5. ROW LEVEL SECURITY AND GRANTS
-- RLS is on for everything. The anon role gets nothing; signed-in users get table privileges that RLS then
-- narrows. 006 creates the role policies for the business tables and the organizations policies.
-- =====================================================================================================

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'user_profiles', 'customers', 'suppliers', 'stock', 'rfqs', 'quotes',
                           'sales_orders', 'jobs', 'invoices', 'purchase_orders', 'delivery_notes', 'email_history', 'machines']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END
$do$;

-- user_profiles policies. Users read and edit their own row; admins manage every row of their organisation.
DO $do$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' LOOP
    EXECUTE format('DROP POLICY %I ON public.user_profiles', r.policyname);
  END LOOP;
END
$do$;

CREATE POLICY "Users read own profile" ON public.user_profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users update own profile" ON public.user_profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Admins read all" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

CREATE POLICY "Admins manage all" ON public.user_profiles
  FOR ALL TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- A user may edit their own row (e.g. workshop_email) but must not promote themselves, switch organisation or
-- reactivate themselves. Only admins (and the service role / SQL editor, where auth.uid() is null) may change these.
CREATE OR REPLACE FUNCTION public.user_profiles_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_org_role(ARRAY['admin']) THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.active IS DISTINCT FROM OLD.active
       OR NEW.mfa_required IS DISTINCT FROM OLD.mfa_required THEN
      RAISE EXCEPTION 'Only admins can change role, organisation, status or email' USING ERRCODE = '42501';
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

-- Cross-table links written by the importer / app must stay in one organisation: see 006 (same-org triggers).

-- =====================================================================================================
-- 6. SECURITY AUDIT (append-only, hash-chained)
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS security_audit;

-- No foreign key on actor_user_id: audit rows must survive the deletion of a user.
CREATE TABLE IF NOT EXISTS security_audit.audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id),
  actor_user_id   UUID,
  actor_email     TEXT,
  action          TEXT NOT NULL,
  entity_table    TEXT NOT NULL,
  entity_id       TEXT,
  old_data        JSONB,
  new_data        JSONB,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address      INET,
  user_agent      TEXT,
  request_id      TEXT,
  previous_hash   TEXT,
  hash            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_created_idx ON security_audit.audit_log (organization_id, created_at DESC);

ALTER TABLE security_audit.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit insert own org" ON security_audit.audit_log;
DROP POLICY IF EXISTS "audit admins read org" ON security_audit.audit_log;
CREATE POLICY "audit admins read org" ON security_audit.audit_log
  FOR SELECT USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

CREATE OR REPLACE FUNCTION security_audit.prevent_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security audit log is append-only and cannot be changed or deleted';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_prevent_mutation ON security_audit.audit_log;
CREATE TRIGGER audit_log_prevent_mutation BEFORE UPDATE OR DELETE ON security_audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION security_audit.prevent_audit_mutation();

-- Same definitions as 006 (006 re-creates them).
CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, security_audit
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT, '')));
  NEW.created_at := clock_timestamp();
  SELECT hash INTO previous FROM security_audit.audit_log
  WHERE organization_id IS NOT DISTINCT FROM NEW.organization_id
  ORDER BY created_at DESC LIMIT 1;
  NEW.previous_hash := previous;
  NEW.hash := encode(digest(
      coalesce(previous, '') || coalesce(NEW.organization_id::TEXT, '') || coalesce(NEW.actor_user_id::TEXT, '') ||
      NEW.action || NEW.entity_table || coalesce(NEW.entity_id, '') || coalesce(NEW.old_data::TEXT, '') ||
      coalesce(NEW.new_data::TEXT, '') || coalesce(NEW.metadata::TEXT, '') || NEW.created_at::TEXT, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_set_hash ON security_audit.audit_log;
CREATE TRIGGER audit_log_set_hash BEFORE INSERT ON security_audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION security_audit.set_audit_hash();

CREATE OR REPLACE FUNCTION security_audit.log_row_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, security_audit
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

  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (
    row_organization_id, auth.uid(), NULLIF(auth.jwt() ->> 'email', ''), TG_OP, TG_TABLE_NAME, row_id,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    jsonb_build_object('source', 'database_trigger'));

  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $do$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'rfqs', 'quotes', 'jobs', 'invoices', 'stock', 'suppliers', 'machines',
                           'sales_orders', 'purchase_orders', 'delivery_notes', 'user_profiles']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()',
                   'audit_' || t || '_changes', t);
  END LOOP;
END
$do$;

-- Admins read the audit trail through this view (RLS of the base table applies).
CREATE OR REPLACE VIEW public.audit_log_view WITH (security_invoker = true) AS
SELECT id, organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata,
       ip_address, user_agent, request_id, previous_hash, hash, created_at
FROM security_audit.audit_log;

GRANT USAGE ON SCHEMA security_audit TO authenticated;
GRANT SELECT ON security_audit.audit_log TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON security_audit.audit_log FROM anon, authenticated;
REVOKE ALL ON security_audit.audit_log FROM anon;
REVOKE ALL ON public.audit_log_view FROM anon;
GRANT SELECT ON public.audit_log_view TO authenticated;

COMMENT ON SCHEMA security_audit IS 'Separate append-only security audit schema for QuoteFlow ISO/SOC evidence.';
COMMENT ON TABLE security_audit.audit_log IS 'Hash-chained, append-only audit trail. Never update or delete rows.';

COMMIT;
