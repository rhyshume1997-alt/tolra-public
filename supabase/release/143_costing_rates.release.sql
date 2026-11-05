-- 143_costing_rates.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 143: costing rates inside Tolra (the Quote Builder's costing calculation without a separate service). JNR cutover release, applied after
-- 141 and before 144 (order 138, 140, 141, 143, 144, 145, 146, 147, 149, 150). Needs 000 (organizations), 031/033 (current_user_organization_id,
-- has_org_role, assert_privileged_aal, require_admin_mfa_guard), 036 (support_readonly_guard, my_session) and the row audit trigger
-- (security_audit.log_row_change). Nothing in 144 to 150 reads or changes these objects. Touches no existing table, row, policy, grant or
-- function. Safe to run again.
--
-- NO RATE IS BUILT IN. This file holds no price, hourly rate, scrap, overhead or margin figure: no column has a default, and no row is
-- inserted. Each company enters its own figures in Settings after the release. A company with NO defaults row, or no machine, or no
-- material is NOT CONFIGURED: costing is OFF for it and the app must show that plainly, never a figure worked out from guessed rates.
-- Costing is on only when the company has saved its defaults row (all four values), at least one machine and at least one material.
--
-- WHAT IT ADDS. Three tables, one trigger function and one save function; nothing is switched on.
--   a. public.costing_materials: the company's materials. name (1-80 characters, one line, unique in the company ignoring case and
--      outer spaces), price_pence (whole pence per price_unit: 'kg' or 'each'), price_unit, scrap_pct (the scrap allowance, 0 to 100, 2 places).
--   b. public.costing_machines: the company's machines. name (as above), hourly_rate_pence (whole pence per hour: the engine's
--      machine_rate_per_hr), labour_rate_pence (whole pence per hour, NULL = the company default labour rate: the engine's
--      labor_rate_per_hr per machine).
--   c. public.costing_defaults: one row per company (organization_id UNIQUE; id for the row audit trigger). labour_rate_pence, programming_rate_pence (also the
--      rate first-article inspection is charged at, as the engine does: it has no separate inspection rate), overhead_pct (the engine's
--      overhead multiplier as a percentage: 150 = 1.5, i.e. 50% of machine and labour cost added; 100 = none; 100 to 500),
--      default_margin_pct (0 to 95, the margin the calculation starts at). All four are entered by the company; there is no default.
--   d. public.save_costing_settings_txn(p_org, p_expected, p_value): saves the company's WHOLE rate set (every material, every machine, the
--      defaults) in one transaction, all or nothing. SECURITY INVOKER (row-level security and the table triggers still apply). p_org must be the
--      caller's own company; admin and office only; a support session is refused; the second step (assert_privileged_aal) as every privileged
--      function; p_expected must equal what the company has now (materials, machines and defaults as they were loaded) or the save is refused
--      with SQLSTATE 40001 'Settings changed; reload' (two people saving at once: the second is told, nothing is overwritten); an advisory lock per
--      company serialises concurrent saves; the whole set is validated first (the tables' own ranges; 500 materials and 500 machines at most;
--      no repeated id or name) and refused with 22023 before anything is written; materials and machines missing from p_value are deleted, new
--      ids are added, changed rows updated, unchanged rows left alone (their updated_at, updated_by and audit trail do not move). EXECUTE:
--      authenticated only (not anon, not service_role). Every changed row is in the row audit log.
-- MONEY is whole pence (INTEGER, 0 to 10,000,000 = GBP 100,000). Percentages are NUMERIC(5,2) / NUMERIC(6,2): they are not money, the
-- engine works with fractions (0.05 scrap, 1.5 overhead, 0.2 margin) and a percentage such as 12.5 needs a fractional value.
-- THESE TABLES ARE INPUTS ONLY. No quote, quote line or job row has a foreign key to them, and editing or deleting a rate changes no record
-- that already exists: a price put on a quote line is stored on the line as its own value (quote_line_items.unit_price).
-- RLS: on; one policy per command (no FOR ALL), helpers in sub-selects (131's form). Read and written by the company's admin and office
-- only: workshop and viewer neither read nor change rates (the same people who see quotes, 131's "quotes rbac select"). updated_at and
-- updated_by are stamped by the database (costing_rates_stamp); a row never moves to another company. support_read_only, admin_mfa
-- and the row audit trigger, as 106's email_templates carry.
-- GUARD (section 1). Verify: supabase/verify/costing_rates_143.sql (every row TRUE). Preflight marker 143 (pins costing_rates_stamp's and
-- save_costing_settings_txn's md5). Rollback: supabase/release/143_costing_rates.rollback.sql (drops the three tables and both functions;
-- Rhys's approval). The app works with 143 not applied: costing reads as off.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists, and a costing table already there is this file's (never another shape).
DO $$
BEGIN
  IF to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL
     OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.my_session()') IS NULL
     OR to_regprocedure('security_audit.log_row_change()') IS NULL OR to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '143: a function or table it needs (000, 031, 033, 036, the audit log) is missing';
  END IF;
  IF to_regprocedure('public.save_costing_settings_txn(uuid,jsonb,jsonb)') IS NOT NULL
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_costing_settings_txn(uuid,jsonb,jsonb)'))
         <> '2c779bca11212d8bf660c4526719c919' THEN
    RAISE EXCEPTION '143: public.save_costing_settings_txn exists with another body; stop and compare it first';
  END IF;
  IF to_regprocedure('public.costing_rates_stamp()') IS NOT NULL
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.costing_rates_stamp()'))
         <> '7e262df9f33ad0ece30d5ac7122995f3' THEN
    RAISE EXCEPTION '143: public.costing_rates_stamp exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The tables. No column has a default rate: the company enters every figure itself (a missing one is a not-null error, never a guess).
CREATE TABLE IF NOT EXISTS public.costing_materials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CONSTRAINT costing_materials_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name !~ '[\r\n]'),
  price_pence     INTEGER NOT NULL CONSTRAINT costing_materials_price CHECK (price_pence BETWEEN 0 AND 10000000),
  price_unit      TEXT NOT NULL CONSTRAINT costing_materials_price_unit CHECK (price_unit IN ('kg', 'each')),
  scrap_pct       NUMERIC(5,2) NOT NULL CONSTRAINT costing_materials_scrap CHECK (scrap_pct BETWEEN 0 AND 100),
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
  programming_rate_pence INTEGER NOT NULL CONSTRAINT costing_defaults_programming_rate CHECK (programming_rate_pence BETWEEN 0 AND 10000000),
  overhead_pct           NUMERIC(6,2) NOT NULL CONSTRAINT costing_defaults_overhead CHECK (overhead_pct BETWEEN 100 AND 500),
  default_margin_pct     NUMERIC(5,2) NOT NULL CONSTRAINT costing_defaults_margin CHECK (default_margin_pct BETWEEN 0 AND 95),
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
-- 5. Save the whole rate set in one transaction (all or nothing). SECURITY INVOKER: the caller's own row-level security, the support,
-- second-step and audit triggers all still apply to every statement below.
CREATE OR REPLACE FUNCTION public.save_costing_settings_txn(p_org UUID, p_expected JSONB, p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_session  JSONB;
  v_current  JSONB;
  v_expected JSONB;
  v_x        JSONB;
  v_uuid     CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  PERFORM public.assert_privileged_aal();
  IF auth.uid() IS NULL OR p_org IS NULL OR v_org IS NULL OR p_org IS DISTINCT FROM v_org OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;
  v_session := public.my_session();
  IF coalesce((v_session ->> 'support')::BOOLEAN, FALSE) OR coalesce((v_session ->> 'read_only')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  -- The shape, before anything is read or written.
  IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expected -> 'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(p_expected -> 'machines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_value -> 'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(p_value -> 'machines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_value -> 'defaults') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_value -> 'materials') > 500 OR jsonb_array_length(p_value -> 'machines') > 500
     OR jsonb_array_length(p_expected -> 'materials') > 500 OR jsonb_array_length(p_expected -> 'machines') > 500 THEN
    RAISE EXCEPTION 'Too many rates' USING ERRCODE = '22023';
  END IF;

  -- The whole set, row by row, to the tables' own ranges (so nothing is rounded or cut): whole pence 0 to 10,000,000; one-line names of 1 to 80;
  -- kg or each; percentages in range to 2 places; every id a UUID. The kinds of value are checked first, so no cast below can fail raw.
  FOR v_x IN SELECT x FROM jsonb_array_elements(p_value -> 'materials') x LOOP
    IF jsonb_typeof(v_x) IS DISTINCT FROM 'object' OR jsonb_typeof(v_x -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_x -> 'name') IS DISTINCT FROM 'string' OR jsonb_typeof(v_x -> 'price_unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_x -> 'price_pence') IS DISTINCT FROM 'number' OR jsonb_typeof(v_x -> 'scrap_pct') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid material: check the name, price, unit and scrap' USING ERRCODE = '22023';
    END IF;
    IF (v_x ->> 'id') !~ v_uuid OR char_length(btrim(v_x ->> 'name')) NOT BETWEEN 1 AND 80 OR (v_x ->> 'name') ~ '[\r\n]'
       OR (v_x ->> 'price_pence')::NUMERIC NOT BETWEEN 0 AND 10000000 OR (v_x ->> 'price_pence')::NUMERIC <> trunc((v_x ->> 'price_pence')::NUMERIC)
       OR (v_x ->> 'price_unit') NOT IN ('kg', 'each')
       OR (v_x ->> 'scrap_pct')::NUMERIC NOT BETWEEN 0 AND 100 OR (v_x ->> 'scrap_pct')::NUMERIC <> round((v_x ->> 'scrap_pct')::NUMERIC, 2) THEN
      RAISE EXCEPTION 'Invalid material: check the name, price, unit and scrap' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR v_x IN SELECT x FROM jsonb_array_elements(p_value -> 'machines') x LOOP
    IF jsonb_typeof(v_x) IS DISTINCT FROM 'object' OR jsonb_typeof(v_x -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_x -> 'name') IS DISTINCT FROM 'string' OR jsonb_typeof(v_x -> 'hourly_rate_pence') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_x -> 'labour_rate_pence') IS NULL OR jsonb_typeof(v_x -> 'labour_rate_pence') NOT IN ('null', 'number') THEN
      RAISE EXCEPTION 'Invalid machine: check the name and rates' USING ERRCODE = '22023';
    END IF;
    IF (v_x ->> 'id') !~ v_uuid OR char_length(btrim(v_x ->> 'name')) NOT BETWEEN 1 AND 80 OR (v_x ->> 'name') ~ '[\r\n]'
       OR (v_x ->> 'hourly_rate_pence')::NUMERIC NOT BETWEEN 0 AND 10000000 OR (v_x ->> 'hourly_rate_pence')::NUMERIC <> trunc((v_x ->> 'hourly_rate_pence')::NUMERIC)
       OR (jsonb_typeof(v_x -> 'labour_rate_pence') = 'number'
           AND ((v_x ->> 'labour_rate_pence')::NUMERIC NOT BETWEEN 0 AND 10000000 OR (v_x ->> 'labour_rate_pence')::NUMERIC <> trunc((v_x ->> 'labour_rate_pence')::NUMERIC))) THEN
      RAISE EXCEPTION 'Invalid machine: check the name and rates' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  v_x := p_value -> 'defaults';
  IF jsonb_typeof(v_x -> 'labour_rate_pence') IS DISTINCT FROM 'number' OR jsonb_typeof(v_x -> 'programming_rate_pence') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_x -> 'overhead_pct') IS DISTINCT FROM 'number' OR jsonb_typeof(v_x -> 'default_margin_pct') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Invalid defaults: all four rates are needed' USING ERRCODE = '22023';
  END IF;
  IF (v_x ->> 'labour_rate_pence')::NUMERIC NOT BETWEEN 0 AND 10000000 OR (v_x ->> 'labour_rate_pence')::NUMERIC <> trunc((v_x ->> 'labour_rate_pence')::NUMERIC)
     OR (v_x ->> 'programming_rate_pence')::NUMERIC NOT BETWEEN 0 AND 10000000 OR (v_x ->> 'programming_rate_pence')::NUMERIC <> trunc((v_x ->> 'programming_rate_pence')::NUMERIC)
     OR (v_x ->> 'overhead_pct')::NUMERIC NOT BETWEEN 100 AND 500 OR (v_x ->> 'overhead_pct')::NUMERIC <> round((v_x ->> 'overhead_pct')::NUMERIC, 2)
     OR (v_x ->> 'default_margin_pct')::NUMERIC NOT BETWEEN 0 AND 95 OR (v_x ->> 'default_margin_pct')::NUMERIC <> round((v_x ->> 'default_margin_pct')::NUMERIC, 2) THEN
    RAISE EXCEPTION 'Invalid defaults: check the rates, overhead and margin' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT lower(x ->> 'id')) FROM jsonb_array_elements(p_value -> 'materials') x) <> jsonb_array_length(p_value -> 'materials')
     OR (SELECT count(DISTINCT lower(x ->> 'id')) FROM jsonb_array_elements(p_value -> 'machines') x) <> jsonb_array_length(p_value -> 'machines') THEN
    RAISE EXCEPTION 'Repeated rate ID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT lower(btrim(x ->> 'name'))) FROM jsonb_array_elements(p_value -> 'materials') x) <> jsonb_array_length(p_value -> 'materials')
     OR (SELECT count(DISTINCT lower(btrim(x ->> 'name'))) FROM jsonb_array_elements(p_value -> 'machines') x) <> jsonb_array_length(p_value -> 'machines') THEN
    RAISE EXCEPTION 'Repeated name' USING ERRCODE = '22023';
  END IF;

  -- One save at a time per company; the rows are then locked and compared with what the caller loaded.
  PERFORM pg_advisory_xact_lock(hashtextextended('costing-settings:' || v_org::TEXT, 0));
  PERFORM 1 FROM public.costing_materials WHERE organization_id = v_org ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.costing_machines WHERE organization_id = v_org ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.costing_defaults WHERE organization_id = v_org FOR UPDATE;
  SELECT jsonb_build_object(
    'materials', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'price_pence', price_pence, 'price_unit', price_unit, 'scrap_pct', scrap_pct) ORDER BY id)
                           FROM public.costing_materials WHERE organization_id = v_org), '[]'::JSONB),
    'machines', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'hourly_rate_pence', hourly_rate_pence, 'labour_rate_pence', labour_rate_pence) ORDER BY id)
                          FROM public.costing_machines WHERE organization_id = v_org), '[]'::JSONB),
    'defaults', (SELECT jsonb_build_object('labour_rate_pence', labour_rate_pence, 'programming_rate_pence', programming_rate_pence,
                                           'overhead_pct', overhead_pct, 'default_margin_pct', default_margin_pct)
                 FROM public.costing_defaults WHERE organization_id = v_org))
  INTO v_current;
  BEGIN
    v_expected := jsonb_build_object(
      'materials', coalesce((SELECT jsonb_agg(jsonb_build_object('id', (x ->> 'id')::UUID, 'name', x ->> 'name', 'price_pence', (x ->> 'price_pence')::INTEGER,
                                                                  'price_unit', x ->> 'price_unit', 'scrap_pct', (x ->> 'scrap_pct')::NUMERIC) ORDER BY (x ->> 'id')::UUID)
                             FROM jsonb_array_elements(p_expected -> 'materials') x), '[]'::JSONB),
      'machines', coalesce((SELECT jsonb_agg(jsonb_build_object('id', (x ->> 'id')::UUID, 'name', x ->> 'name', 'hourly_rate_pence', (x ->> 'hourly_rate_pence')::INTEGER,
                                                                 'labour_rate_pence', (x ->> 'labour_rate_pence')::INTEGER) ORDER BY (x ->> 'id')::UUID)
                            FROM jsonb_array_elements(p_expected -> 'machines') x), '[]'::JSONB),
      'defaults', CASE WHEN jsonb_typeof(p_expected -> 'defaults') = 'object'
                       THEN jsonb_build_object('labour_rate_pence', (p_expected #>> '{defaults,labour_rate_pence}')::INTEGER,
                                               'programming_rate_pence', (p_expected #>> '{defaults,programming_rate_pence}')::INTEGER,
                                               'overhead_pct', (p_expected #>> '{defaults,overhead_pct}')::NUMERIC,
                                               'default_margin_pct', (p_expected #>> '{defaults,default_margin_pct}')::NUMERIC)
                       ELSE 'null'::JSONB END);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023';
  END;
  IF v_expected IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'Settings changed; reload' USING ERRCODE = '40001', HINT = 'costing_settings_changed';
  END IF;

  -- Deletes first (a new row may take a name a deleted row held), then adds and changes; unchanged rows are left alone.
  DELETE FROM public.costing_materials s WHERE s.organization_id = v_org
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value -> 'materials') x WHERE (x ->> 'id')::UUID = s.id);
  DELETE FROM public.costing_machines s WHERE s.organization_id = v_org
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value -> 'machines') x WHERE (x ->> 'id')::UUID = s.id);
  INSERT INTO public.costing_materials AS m (id, organization_id, name, price_pence, price_unit, scrap_pct)
    SELECT (x ->> 'id')::UUID, v_org, btrim(x ->> 'name'), (x ->> 'price_pence')::INTEGER, x ->> 'price_unit', (x ->> 'scrap_pct')::NUMERIC
    FROM jsonb_array_elements(p_value -> 'materials') x
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, price_pence = excluded.price_pence, price_unit = excluded.price_unit, scrap_pct = excluded.scrap_pct
    WHERE m.organization_id = v_org AND (m.name, m.price_pence, m.price_unit, m.scrap_pct) IS DISTINCT FROM (excluded.name, excluded.price_pence, excluded.price_unit, excluded.scrap_pct);
  INSERT INTO public.costing_machines AS m (id, organization_id, name, hourly_rate_pence, labour_rate_pence)
    SELECT (x ->> 'id')::UUID, v_org, btrim(x ->> 'name'), (x ->> 'hourly_rate_pence')::INTEGER, (x ->> 'labour_rate_pence')::INTEGER
    FROM jsonb_array_elements(p_value -> 'machines') x
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, hourly_rate_pence = excluded.hourly_rate_pence, labour_rate_pence = excluded.labour_rate_pence
    WHERE m.organization_id = v_org AND (m.name, m.hourly_rate_pence, m.labour_rate_pence) IS DISTINCT FROM (excluded.name, excluded.hourly_rate_pence, excluded.labour_rate_pence);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value -> 'materials') x WHERE NOT EXISTS (SELECT 1 FROM public.costing_materials s WHERE s.organization_id = v_org AND s.id = (x ->> 'id')::UUID))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value -> 'machines') x WHERE NOT EXISTS (SELECT 1 FROM public.costing_machines s WHERE s.organization_id = v_org AND s.id = (x ->> 'id')::UUID)) THEN
    RAISE EXCEPTION 'Invalid rate ID' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.costing_defaults AS d (organization_id, labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct)
    VALUES (v_org, (p_value #>> '{defaults,labour_rate_pence}')::INTEGER, (p_value #>> '{defaults,programming_rate_pence}')::INTEGER,
            (p_value #>> '{defaults,overhead_pct}')::NUMERIC, (p_value #>> '{defaults,default_margin_pct}')::NUMERIC)
    ON CONFLICT (organization_id) DO UPDATE SET labour_rate_pence = excluded.labour_rate_pence, programming_rate_pence = excluded.programming_rate_pence,
      overhead_pct = excluded.overhead_pct, default_margin_pct = excluded.default_margin_pct
    WHERE (d.labour_rate_pence, d.programming_rate_pence, d.overhead_pct, d.default_margin_pct)
          IS DISTINCT FROM (excluded.labour_rate_pence, excluded.programming_rate_pence, excluded.overhead_pct, excluded.default_margin_pct);
END
$$;
REVOKE ALL ON FUNCTION public.save_costing_settings_txn(UUID, JSONB, JSONB) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_costing_settings_txn(UUID, JSONB, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check: what this file made is what it says.
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
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_costing_settings_txn(uuid,jsonb,jsonb)'))
     IS DISTINCT FROM '2c779bca11212d8bf660c4526719c919'
     OR has_function_privilege('anon', 'public.save_costing_settings_txn(uuid,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_costing_settings_txn(uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '143: public.save_costing_settings_txn is not this file''s body, or its EXECUTE grants are wrong';
  END IF;
END
$$;

COMMIT;
