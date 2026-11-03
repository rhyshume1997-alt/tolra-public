-- =====================================================================================================
-- 143: costing rates inside Tolra (the Quote Builder's costing calculation without a separate service). WORKING NUMBER: provisional
-- (136/137 #106, 138/139 chasing, 140/141 SliQ, 142 E13); the final number is given at merge. Needs 000 (organizations), 031/033
-- (current_user_organization_id, has_org_role, require_admin_mfa_guard), 036 (support_readonly_guard) and the row audit trigger
-- (security_audit.log_row_change). Touches no existing table, row, policy, grant or function. Safe to run again.
--
-- WHAT IT ADDS. Three tables and one trigger function; nothing is switched on. A company with no machine or no material has costing off.
--   a. public.costing_materials: the company's materials. name (1-80 characters, one line, unique in the company ignoring case and
--      outer spaces), price_pence (whole pence per price_unit: 'kg' or 'each'), scrap_pct (the scrap default, 0 to 100, 2 places).
--   b. public.costing_machines: the company's machines. name (as above), hourly_rate_pence (whole pence per hour: the engine's
--      machine_rate_per_hr), labour_rate_pence (whole pence per hour, NULL = the company default labour rate: the engine's
--      labor_rate_per_hr per machine).
--   c. public.costing_defaults: one row per company (organization_id UNIQUE; id for the row audit trigger). labour_rate_pence, programming_rate_pence (also the
--      rate first-article inspection is charged at, as the engine does: it has no separate inspection rate), overhead_pct (the engine's
--      overhead multiplier as a percentage: 150 = 1.5, i.e. 50% of machine and labour cost added; 100 = none; 100 to 500),
--      default_margin_pct (0 to 95, the margin the calculation starts at). No row = the app's built-in defaults.
-- MONEY is whole pence (INTEGER, 0 to 10,000,000 = GBP 100,000). Percentages are NUMERIC(5,2) / NUMERIC(6,2): they are not money, the
-- engine works with fractions (0.05 scrap, 1.5 overhead, 0.2 margin) and a percentage such as 12.5 needs a fractional value.
-- RLS: on; one policy per command (no FOR ALL), helpers in sub-selects (131's form). Read and written by the company's admin and office
-- only: workshop and viewer neither read nor change rates (the same people who see quotes, 131's "quotes rbac select"). updated_at and
-- updated_by are stamped by the database (costing_rates_stamp); a row never moves to another company. support_read_only, admin_mfa
-- and the row audit trigger, as 106's email_templates carry.
-- GUARD (section 1). Verify: supabase/verify/costing_rates_143.sql (every row TRUE). Preflight marker 143 (pins costing_rates_stamp's
-- md5). Rollback: supabase/release/143_costing_rates.rollback.sql (drops the three tables and the function; Rhys's approval).
-- The app works with 143 not applied: costing reads as off.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists, and a costing table already there is this file's (never another shape).
DO $$
BEGIN
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '143: a function or table it needs (000, 031, 033, 036, the audit log) is missing';
  END IF;
  IF to_regprocedure('public.costing_rates_stamp()') IS NOT NULL
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.costing_rates_stamp()'))
         <> '7e262df9f33ad0ece30d5ac7122995f3' THEN
    RAISE EXCEPTION '143: public.costing_rates_stamp exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The tables.
CREATE TABLE IF NOT EXISTS public.costing_materials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CONSTRAINT costing_materials_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[\r\n]'),
  price_pence     INTEGER NOT NULL CONSTRAINT costing_materials_price CHECK (price_pence BETWEEN 0 AND 10000000),
  price_unit      TEXT NOT NULL DEFAULT 'kg' CONSTRAINT costing_materials_price_unit CHECK (price_unit IN ('kg', 'each')),
  scrap_pct       NUMERIC(5,2) NOT NULL DEFAULT 5 CONSTRAINT costing_materials_scrap CHECK (scrap_pct BETWEEN 0 AND 100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS costing_materials_org_name ON public.costing_materials (organization_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.costing_machines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CONSTRAINT costing_machines_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[\r\n]'),
  hourly_rate_pence INTEGER NOT NULL CONSTRAINT costing_machines_hourly_rate CHECK (hourly_rate_pence BETWEEN 0 AND 10000000),
  labour_rate_pence INTEGER CONSTRAINT costing_machines_labour_rate CHECK (labour_rate_pence BETWEEN 0 AND 10000000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS costing_machines_org_name ON public.costing_machines (organization_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.costing_defaults (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL CONSTRAINT costing_defaults_org UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  labour_rate_pence      INTEGER NOT NULL CONSTRAINT costing_defaults_labour_rate CHECK (labour_rate_pence BETWEEN 0 AND 10000000),
  programming_rate_pence INTEGER NOT NULL DEFAULT 7500 CONSTRAINT costing_defaults_programming_rate CHECK (programming_rate_pence BETWEEN 0 AND 10000000),
  overhead_pct           NUMERIC(6,2) NOT NULL DEFAULT 150 CONSTRAINT costing_defaults_overhead CHECK (overhead_pct BETWEEN 100 AND 500),
  default_margin_pct     NUMERIC(5,2) NOT NULL DEFAULT 20 CONSTRAINT costing_defaults_margin CHECK (default_margin_pct BETWEEN 0 AND 95),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by             UUID
);

-- -----------------------------------------------------------------------------------------------------
-- 3. Who changed it and when come from the database, never the client; a row stays in its company.
CREATE OR REPLACE FUNCTION public.costing_rates_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'A costing rate can''t move to another company.' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.costing_rates_stamp() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. RLS, grants and triggers, the same for each table.
DO $$
DECLARE
  t TEXT;
  v_org TEXT := '(organization_id = (SELECT public.current_user_organization_id()) AND (SELECT public.has_org_role(ARRAY[''admin'', ''office''])))';
BEGIN
  FOREACH t IN ARRAY ARRAY['costing_materials', 'costing_machines', 'costing_defaults'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ' office select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING %s', t || ' office select', t, v_org);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ' office insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK %s', t || ' office insert', t, v_org);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ' office update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING %s WITH CHECK %s', t || ' office update', t, v_org, v_org);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ' office delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING %s', t || ' office delete', t, v_org);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);

    EXECUTE format('DROP TRIGGER IF EXISTS costing_rates_stamp ON public.%I', t);
    EXECUTE format('CREATE TRIGGER costing_rates_stamp BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.costing_rates_stamp()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_' || t || '_changes', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change()', 'audit_' || t || '_changes', t);
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR DELETE OR UPDATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR DELETE OR UPDATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: what this file made is what it says.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.costing_rates_stamp()'))
     <> '7e262df9f33ad0ece30d5ac7122995f3' THEN
    RAISE EXCEPTION '143: public.costing_rates_stamp is not this file''s body';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('costing_materials', 'costing_machines', 'costing_defaults')) <> 12
     OR (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('public.costing_materials'), to_regclass('public.costing_machines'),
                                                     to_regclass('public.costing_defaults')) AND relrowsecurity) <> 3 THEN
    RAISE EXCEPTION '143: the costing tables do not have their 12 policies and row-level security';
  END IF;
END
$$;
