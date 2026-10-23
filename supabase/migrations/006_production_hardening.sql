-- 006: production hardening (security audit 2026-10: sections 1.1, 1.2, 1.3, 1.7, 2.5, 2.6, 2.7, 4.2, 4.3).
--
-- RUN THIS AFTER migrations 000-005 and BEFORE 007 (on a fresh project nothing else is needed; on the old single-tenant project
-- the legacy root files production-hardening.sql, iso-security-patch.sql and critical-prelaunch-security.sql
-- ran before it). It is idempotent: safe to run any number of times, and safe (indeed required) to run
-- again after anyone re-runs one of the older files, because it removes every policy on the business tables
-- and recreates the role-checked ones, and redefines the access helpers.
--
-- Whole file is one transaction: either everything applies or nothing does.
--
-- Contents (in the order they run in this file):
--   3  Access helpers: only active users of ACTIVE organisations get an organisation / role
--   2  organizations: RLS on, read own org, admin may rename own org, no anon, no insert/delete
--  12  Columns the app now needs (added early because later sections index / constrain them)
--   1  Role matrix: drop every legacy policy on the business tables, recreate role-checked ones
--   4  Audit: grants, hash chain trigger, write_audit(), actor email fix, no direct client writes
--   5  Document numbers: doc_counters + next_doc_number()
--   6  Atomic header + lines: create_with_lines()
--   7  Unique document numbers per organisation
--   8  Integrity: CHECK constraints (NOT VALID) + same-organisation parent guard triggers
--   9  Storage: mime/size limits, role checks on quote-attachments, job-drawings
--  10  Company profile per organisation (admin-only writes)
--  11  Indexes

BEGIN;

-- =====================================================================================================
-- 3. ACCESS HELPERS
-- Signatures are unchanged. A user only resolves to an organisation / role when
--   user_profiles.active AND organizations.status = 'active'
-- so deactivating a user or pausing/closing a company cuts RLS access at once (audit 1.3).
-- =====================================================================================================

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

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
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
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
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.role
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_secondary_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.secondary_role
  FROM public.user_profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.id = auth.uid()
    AND p.active = TRUE
    AND o.status = 'active'
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
    WHERE p.id = auth.uid()
      AND p.active = TRUE
      AND o.status = 'active'
      AND (p.role = ANY (allowed_roles) OR p.secondary_role = ANY (allowed_roles))
  )
$$;

-- Only signed-in users may call the helpers (anon gets "permission denied" instead of an answer).
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
-- 2. ORGANIZATIONS: row level security (audit 1.2)
-- Members can read their own organisation. Admins may rename it. Nobody can create or delete
-- organisations from the browser; status / slug are changed only by the service role or SQL editor
-- (so an admin cannot re-activate a suspended company or lock their own company out).
-- =====================================================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'organizations' LOOP
    EXECUTE format('DROP POLICY %I ON public.organizations', r.policyname);
  END LOOP;
END
$do$;

CREATE POLICY "organizations select own" ON public.organizations FOR SELECT TO authenticated
  USING (id = public.current_user_organization_id());

CREATE POLICY "organizations admin update own" ON public.organizations FOR UPDATE TO authenticated
  USING (id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']))
  WITH CHECK (id = public.current_user_organization_id());

REVOKE ALL ON public.organizations FROM anon;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.organizations FROM authenticated;
-- Column level: admins may only change the display name (never status or slug).
REVOKE UPDATE ON public.organizations FROM authenticated;
GRANT SELECT ON public.organizations TO authenticated;
GRANT UPDATE (name, updated_at) ON public.organizations TO authenticated;

-- =====================================================================================================
-- 12. COLUMNS THE APP NOW NEEDS (ADD COLUMN IF NOT EXISTS, only where the table exists)
-- =====================================================================================================

DO $do$
DECLARE
  c RECORD;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('invoices',        'amount_paid',       'NUMERIC(12,2) NOT NULL DEFAULT 0'),
    ('invoices',        'paid_at',           'TIMESTAMPTZ'),
    ('purchase_orders', 'po_ref',            'TEXT'),
    ('purchase_orders', 'supplier',          'TEXT'),
    ('purchase_orders', 'expected_delivery', 'DATE'),
    ('purchase_orders', 'items',             'JSONB DEFAULT ''[]''::jsonb'),
    ('purchase_orders', 'received_at',       'TIMESTAMPTZ'),
    ('quotes',          'terms',             'TEXT'),
    ('quotes',          'sent_at',           'TIMESTAMPTZ'),
    ('sales_orders',    'customer',          'TEXT'),
    ('sales_orders',    'quote_ref',         'TEXT'),
    ('sales_orders',    'customer_po',       'TEXT'),
    ('jobs',            'quote_ref',         'TEXT'),
    ('email_history',   'skipped_until',     'TIMESTAMPTZ')
  ) AS v(tbl, col, def)
  LOOP
    IF to_regclass('public.' || c.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I %s', c.tbl, c.col, c.def);
    END IF;
  END LOOP;
END
$do$;

-- purchase_orders.po_number is NOT NULL in production-hardening.sql, but the page writes po_ref only.
-- Keep both columns; neither is required on its own (the app fills po_ref, older rows have po_number).
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'po_number' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.purchase_orders ALTER COLUMN po_number DROP NOT NULL;
  END IF;
END
$do$;

-- =====================================================================================================
-- 1. ROLE MATRIX (audit 1.1)
-- Postgres ORs permissive policies together, so one leftover org-only "FOR ALL" policy cancels every
-- role restriction. For each business table this removes EVERY existing policy (the legacy
-- "<t> org isolation", "org members can manage ...", "org email history", the 001 org-only policies, the
-- iso "<t> tenant ..." policies, the 003 "machines viewer select" policy, and anything added by hand in
-- the dashboard) and recreates one policy per command, each with the organisation AND role check.
--
--   table                                       select              insert/update       delete
--   customers suppliers stock quotes
--     quote_line_items quote_attachments
--     rfqs purchase_orders                      admin, office       admin, office       admin, office
--   email_history                               admin, office       admin, office (*)   admin, office
--   invoices invoice_line_items sales_orders    admin               admin               admin
--   jobs                                        all four roles      admin, office,      admin
--                                                                   workshop
--   delivery_notes delivery_note_items          admin, office,      admin, office,      admin, office
--                                               workshop            workshop
--   machines                                    all four roles      admin, office       admin, office
--   (*) insert additionally requires drafted_by = auth.uid()
--
-- Not touched (their 003 / 004 rules stay): machine_bookings, organization_settings, user_profiles.
-- A role is matched against role OR secondary_role (has_org_role). viewer can never delete.
-- =====================================================================================================

DO $do$
DECLARE
  a    TEXT[] := ARRAY['admin'];
  ao   TEXT[] := ARRAY['admin', 'office'];
  aow  TEXT[] := ARRAY['admin', 'office', 'workshop'];
  allr TEXT[] := ARRAY['admin', 'office', 'workshop', 'viewer'];
  m RECORD;
  r RECORD;
  org_check TEXT := 'organization_id = public.current_user_organization_id()';
BEGIN
  FOR m IN SELECT * FROM (VALUES
    ('customers',           ao,   ao,  ao,  ao,  NULL::text),
    ('suppliers',           ao,   ao,  ao,  ao,  NULL),
    ('stock',               ao,   ao,  ao,  ao,  NULL),
    ('quotes',              ao,   ao,  ao,  ao,  NULL),
    ('quote_line_items',    ao,   ao,  ao,  ao,  NULL),
    ('quote_attachments',   ao,   ao,  ao,  ao,  NULL),
    ('rfqs',                ao,   ao,  ao,  ao,  NULL),
    ('purchase_orders',     ao,   ao,  ao,  ao,  NULL),
    ('email_history',       ao,   ao,  ao,  ao,  'drafted_by = auth.uid()'),
    ('invoices',            a,    a,   a,   a,   NULL),
    ('invoice_line_items',  a,    a,   a,   a,   NULL),
    ('sales_orders',        a,    a,   a,   a,   NULL),
    ('jobs',                allr, aow, aow, a,   NULL),
    ('delivery_notes',      aow,  aow, aow, ao,  NULL),
    ('delivery_note_items', aow,  aow, aow, ao,  NULL),
    ('machines',            allr, ao,  ao,  ao,  NULL)
  ) AS v(tbl, sel_roles, ins_roles, upd_roles, del_roles, ins_extra)
  LOOP
    IF to_regclass('public.' || m.tbl) IS NULL THEN
      RAISE NOTICE '006: table public.% does not exist, skipped', m.tbl;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = m.tbl AND column_name = 'organization_id'
    ) THEN
      RAISE WARNING '006: public.% has no organization_id column, skipped (fix the schema first)', m.tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', m.tbl);

    -- Remove every existing policy, whatever its name.
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = m.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, m.tbl);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s AND public.has_org_role(%L::text[]))',
      m.tbl || ' rbac select', m.tbl, org_check, m.sel_roles);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s AND public.has_org_role(%L::text[])%s)',
      m.tbl || ' rbac insert', m.tbl, org_check, m.ins_roles,
      CASE WHEN m.ins_extra IS NULL THEN '' ELSE ' AND ' || m.ins_extra END);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s AND public.has_org_role(%L::text[])) WITH CHECK (%s AND public.has_org_role(%L::text[]))',
      m.tbl || ' rbac update', m.tbl, org_check, m.upd_roles, org_check, m.upd_roles);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s AND public.has_org_role(%L::text[]))',
      m.tbl || ' rbac delete', m.tbl, org_check, m.del_roles);

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', m.tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', m.tbl);
  END LOOP;

  -- Tables that keep their 003 / 004 policies still must not be reachable by anon.
  FOR m IN SELECT unnest(ARRAY['machine_bookings', 'organization_settings']) AS tbl LOOP
    IF to_regclass('public.' || m.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', m.tbl);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', m.tbl);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', m.tbl);
    END IF;
  END LOOP;
END
$do$;

-- =====================================================================================================
-- 4. AUDIT (audit 1.7)
-- Clients no longer write audit rows directly. They call public.write_audit(), a SECURITY DEFINER
-- function that takes organisation and actor from the signed-in user's profile (never from the caller).
-- Row-change triggers (log_row_change) keep writing as the table owner.
-- =====================================================================================================

CREATE SCHEMA IF NOT EXISTS security_audit;

-- Readers (admins, through RLS + the audit_log_view) need to see the schema and table. Nothing writes
-- as `authenticated`: inserts happen inside definer functions, so no INSERT grant is needed or given.
GRANT USAGE ON SCHEMA security_audit TO authenticated;
GRANT SELECT ON security_audit.audit_log TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON security_audit.audit_log FROM anon, authenticated;
REVOKE ALL ON security_audit.audit_log FROM anon;

DO $do$
BEGIN
  IF to_regclass('public.audit_log_ingest') IS NOT NULL THEN
    REVOKE ALL ON public.audit_log_ingest FROM anon, authenticated;
  END IF;
  IF to_regclass('public.audit_log_view') IS NOT NULL THEN
    REVOKE ALL ON public.audit_log_view FROM anon;
    GRANT SELECT ON public.audit_log_view TO authenticated;
  END IF;
END
$do$;

-- Hash chain: SECURITY DEFINER so the previous hash is always read regardless of RLS, and one advisory
-- lock per organisation so concurrent inserts cannot both chain to the same previous row.
-- created_at is taken from clock_timestamp() because now() is the transaction start, which would make
-- several rows written in one transaction indistinguishable when picking "the previous row".
CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, security_audit
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(coalesce(NEW.organization_id::TEXT, '')));

  NEW.created_at := clock_timestamp();

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

-- Row-change trigger: same behaviour as iso-security-patch.sql except the actor email now comes from
-- the JWT (auth.jwt() ->> 'email'); the old request.jwt.claim.email setting is empty on current Supabase.
CREATE OR REPLACE FUNCTION security_audit.log_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, security_audit
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
    organization_id, actor_user_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata
  )
  VALUES (
    row_organization_id,
    auth.uid(),
    NULLIF(auth.jwt() ->> 'email', ''),
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

-- Client entry point for application-level audit events.
--   supabase.rpc('write_audit', { p_action, p_entity_table, p_entity_id, p_old, p_new, p_metadata, p_ip, p_user_agent })
-- Organisation, actor id and actor email are taken from the signed-in user; the caller cannot choose them.
CREATE OR REPLACE FUNCTION public.write_audit(
  p_action       TEXT,
  p_entity_table TEXT,
  p_entity_id    TEXT,
  p_old          JSONB,
  p_new          JSONB,
  p_metadata     JSONB,
  p_ip           TEXT,
  p_user_agent   TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_org   UUID;
  v_email TEXT;
  v_ip    INET;
  v_meta  JSONB;
BEGIN
  -- Active user of an active organisation only.
  v_org := public.current_user_organization_id();
  IF v_uid IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(p_action), '') = '' OR coalesce(btrim(p_entity_table), '') = '' THEN
    RAISE EXCEPTION 'action and entity table are required' USING ERRCODE = '22023';
  END IF;

  -- Size caps (rows are append-only forever, so keep each one small).
  IF octet_length(coalesce(p_old::TEXT, '')) > 65536
     OR octet_length(coalesce(p_new::TEXT, '')) > 65536
     OR octet_length(coalesce(p_metadata::TEXT, '')) > 16384 THEN
    RAISE EXCEPTION 'audit payload too large' USING ERRCODE = '22023';
  END IF;

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_uid AND p.active = TRUE;
  v_email := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), v_email);

  -- x-forwarded-for may hold a list ("1.2.3.4, 5.6.7.8"): keep the first entry. Unparseable -> NULL.
  BEGIN
    v_ip := NULLIF(btrim(split_part(coalesce(p_ip, ''), ',', 1)), '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  v_meta := CASE WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata ELSE '{}'::JSONB END
            || jsonb_build_object('source', 'write_audit');

  INSERT INTO security_audit.audit_log (
    organization_id, actor_user_id, actor_email, action, entity_table, entity_id,
    old_data, new_data, metadata, ip_address, user_agent
  )
  VALUES (
    v_org,
    v_uid,
    v_email,
    left(btrim(p_action), 64),
    left(btrim(p_entity_table), 64),
    left(p_entity_id, 128),
    p_old,
    p_new,
    v_meta,
    v_ip,
    left(p_user_agent, 256)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.write_audit(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_audit(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT) TO authenticated;

-- =====================================================================================================
-- 5. DOCUMENT NUMBERS (audit 2.5)
-- Numbers are allocated inside Postgres so two people saving at once never get the same number and
-- there is no 1000-row read cap. Client call:
--   const { data: ref, error } = await supabase.rpc('next_doc_number', { p_prefix: 'QUO' });  // 'QUO-0001'
-- Allowed prefixes: QUO, INV, J, PO, RFQ. (Delivery notes reuse their invoice number, DLN-####, and jobs
-- created from a quote reuse the quote number, J-####, so neither needs a counter.)
-- doc_counters has RLS on and NO policies: only the SECURITY DEFINER function below can touch it.
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.doc_counters (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  prefix          TEXT NOT NULL,
  last            INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, prefix)
);
ALTER TABLE public.doc_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_counters FROM PUBLIC, anon, authenticated;

-- Seed the counters from the highest number already in use per organisation. GREATEST() means this
-- can be re-run at any time and never moves a counter backwards. 'J' is seeded from job numbers AND
-- quote numbers (a job from a quote takes the quote's number: QUO-1393 -> J-1393), so they never collide.
-- It is a function so it can be called again after any bulk data load:  SELECT public.reseed_doc_counters();
-- (supabase/import/import_legacy.sql does this at the end of the import). Owner / SQL editor only.
CREATE OR REPLACE FUNCTION public.reseed_doc_counters()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  s RECORD;
  pattern TEXT;
  n INT := 0;
  touched INT;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('quotes',          'quote_ref', 'QUO', 'QUO'),
    ('invoices',        'invoice_ref', 'INV', 'INV'),
    ('jobs',            'job_no',    'J',   'J'),
    ('quotes',          'quote_ref', 'QUO', 'J'),
    ('purchase_orders', 'po_ref',    'PO',  'PO'),
    ('purchase_orders', 'po_number', 'PO',  'PO'),
    ('rfqs',            'rfq_ref',   'RFQ', 'RFQ'),
    ('rfqs',            'rfq_number', 'RFQ', 'RFQ')
  ) AS v(tbl, col, src_prefix, counter_prefix)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = s.tbl AND column_name = s.col)
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = s.tbl AND column_name = 'organization_id') THEN
      pattern := '^' || s.src_prefix || '-(\d{1,9})$';
      EXECUTE format(
        'INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
         SELECT organization_id, %L, max((substring(%I FROM %L))::INT)
         FROM public.%I
         WHERE organization_id IS NOT NULL AND %I ~ %L
         GROUP BY organization_id
         ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last, EXCLUDED.last)',
        s.counter_prefix, s.col, pattern, s.tbl, s.col, pattern);
      GET DIAGNOSTICS touched = ROW_COUNT;
      n := n + touched;
    END IF;
  END LOOP;
  RETURN n;
END
$fn$;

REVOKE ALL ON FUNCTION public.reseed_doc_counters() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.reseed_doc_counters();

CREATE OR REPLACE FUNCTION public.next_doc_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org      UUID := public.current_user_organization_id();
  n        INT;
  result   TEXT;
  taken    BOOLEAN;
  attempts INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ') THEN
    RAISE EXCEPTION 'invalid document prefix' USING ERRCODE = '22023';
  END IF;

  -- You can only take numbers for documents you are allowed to create (a viewer cannot burn numbers).
  IF NOT public.has_org_role(CASE p_prefix
        WHEN 'INV' THEN ARRAY['admin']
        WHEN 'J'   THEN ARRAY['admin', 'office', 'workshop']
        ELSE            ARRAY['admin', 'office']
      END) THEN
    RAISE EXCEPTION 'not authorised for % numbers', p_prefix USING ERRCODE = '42501';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = c.last + 1
    RETURNING c.last INTO n;

    -- lpad() would truncate numbers above 9999, so only pad short numbers.
    result := p_prefix || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;

    -- Skip numbers that already exist (rows imported or seeded after the counters were seeded, or jobs that
    -- took a quote's number). Counters only move forward, so a skipped number is simply never reused.
    taken := CASE p_prefix
      WHEN 'QUO' THEN EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = result)
      WHEN 'INV' THEN EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND invoice_ref = result)
      WHEN 'J'   THEN EXISTS (SELECT 1 FROM public.jobs     WHERE organization_id = org AND job_no = result)
                   OR EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = 'QUO' || substr(result, 2))
      ELSE FALSE
    END;
    EXIT WHEN NOT taken;

    attempts := attempts + 1;
    IF attempts > 10000 THEN
      RAISE EXCEPTION 'could not allocate a free % number', p_prefix;
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.next_doc_number(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT) TO authenticated;

-- =====================================================================================================
-- 6. ATOMIC HEADER + LINES (audit 2.6)
-- One call inserts the header and all its lines in a single transaction (a function is atomic: any error
-- rolls both back). SECURITY INVOKER, so the caller's RLS policies and role checks apply exactly as for
-- a normal insert. organization_id is always the caller's organisation; id / organization_id in the
-- payload are ignored. Returns the new header id.
--
-- Client call shape:
--   const { data: id, error } = await supabase.rpc('create_with_lines', {
--     p_parent: 'quotes',
--     p_header: { quote_ref: 'QUO-0042', customer: 'Acme Ltd', total_value: 120.5, status: 'draft' },
--     p_child:  'quote_line_items',
--     p_fk:     'quote_id',
--     p_lines:  [ { description: 'Bracket', quantity: 5, unit_price: 24.1 } ],   // position defaults to the index
--   });
-- Allowed (p_parent, p_child, p_fk):
--   ('quotes','quote_line_items','quote_id'), ('invoices','invoice_line_items','invoice_id'),
--   ('delivery_notes','delivery_note_items','delivery_note_id')
-- Header / line keys must be real column names of those tables (lower snake case); unknown keys raise.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION public.create_with_lines(
  p_parent TEXT,
  p_header JSONB,
  p_child  TEXT,
  p_fk     TEXT,
  p_lines  JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_hdr     JSONB;
  v_line    JSONB;
  v_id      UUID;
  v_idx     INT := 0;
  v_pcols   TEXT[];
  v_ccols   TEXT[];
  v_key     TEXT;
  v_cols    TEXT;
  v_sel     TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  IF NOT ((p_parent, p_child, p_fk) IN (
        VALUES ('quotes', 'quote_line_items', 'quote_id'),
               ('invoices', 'invoice_line_items', 'invoice_id'),
               ('delivery_notes', 'delivery_note_items', 'delivery_note_id')
      )) THEN
    RAISE EXCEPTION 'create_with_lines: table combination not allowed' USING ERRCODE = '42501';
  END IF;

  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'p_header must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(coalesce(p_lines, '[]'::JSONB)) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(attname::TEXT) INTO v_pcols
  FROM pg_attribute
  WHERE attrelid = format('public.%I', p_parent)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
  SELECT array_agg(attname::TEXT) INTO v_ccols
  FROM pg_attribute
  WHERE attrelid = format('public.%I', p_child)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  -- ---- header --------------------------------------------------------------------------------------
  v_hdr := p_header - 'id' - 'organization_id' - 'created_by' - 'updated_by';
  FOR v_key IN SELECT jsonb_object_keys(v_hdr) LOOP
    IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid column name in header: %', v_key USING ERRCODE = '22023';
    END IF;
    IF NOT (v_key = ANY (v_pcols)) THEN
      RAISE EXCEPTION 'unknown column "%" for %', v_key, p_parent USING ERRCODE = '42703';
    END IF;
  END LOOP;
  v_hdr := v_hdr || jsonb_build_object('organization_id', v_org);
  IF 'created_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('created_by', v_uid); END IF;
  IF 'updated_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('updated_by', v_uid); END IF;

  SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
  INTO v_cols, v_sel
  FROM jsonb_object_keys(v_hdr) AS k;

  EXECUTE format(
    'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r RETURNING id',
    p_parent, v_cols, v_sel, p_parent)
  INTO v_id USING v_hdr;

  -- ---- lines ---------------------------------------------------------------------------------------
  FOR v_line IN SELECT value FROM jsonb_array_elements(coalesce(p_lines, '[]'::JSONB)) LOOP
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION 'every line must be a JSON object' USING ERRCODE = '22023';
    END IF;
    v_line := v_line - 'id' - 'organization_id' - 'created_by' - 'updated_by' - p_fk;
    FOR v_key IN SELECT jsonb_object_keys(v_line) LOOP
      IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'invalid column name in line: %', v_key USING ERRCODE = '22023';
      END IF;
      IF NOT (v_key = ANY (v_ccols)) THEN
        RAISE EXCEPTION 'unknown column "%" for %', v_key, p_child USING ERRCODE = '42703';
      END IF;
    END LOOP;
    v_line := v_line || jsonb_build_object(p_fk, v_id, 'organization_id', v_org);
    IF 'position' = ANY (v_ccols) AND NOT (v_line ? 'position') THEN
      v_line := v_line || jsonb_build_object('position', v_idx);
    END IF;

    SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
    INTO v_cols, v_sel
    FROM jsonb_object_keys(v_line) AS k;

    EXECUTE format(
      'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r',
      p_child, v_cols, v_sel, p_child)
    USING v_line;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_with_lines(TEXT, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_with_lines(TEXT, JSONB, TEXT, TEXT, JSONB) TO authenticated;

-- =====================================================================================================
-- 7. UNIQUE DOCUMENT NUMBERS PER ORGANISATION (audit 2.5)
-- Unconditional unique indexes (005 only covered rows WHERE col IS NOT NULL; NULLs are always allowed
-- to repeat in a unique index anyway). If an install already holds duplicate numbers the index cannot
-- be built: the migration does NOT abort, it prints a WARNING naming the index. Fix the duplicates and
-- re-run this file (see README "Verification").
-- =====================================================================================================

DO $do$
DECLARE
  u RECORD;
BEGIN
  FOR u IN SELECT * FROM (VALUES
    ('quotes',          'quote_ref'),
    ('invoices',        'invoice_ref'),
    ('delivery_notes',  'dn_number'),
    ('jobs',            'job_no'),
    ('purchase_orders', 'po_ref'),
    ('purchase_orders', 'po_number')
  ) AS v(tbl, col)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = u.tbl AND column_name = u.col)
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = u.tbl AND column_name = 'organization_id') THEN
      BEGIN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (organization_id, %I)',
                       u.tbl || '_' || u.col || '_org_uniq', u.tbl, u.col);
      EXCEPTION WHEN unique_violation THEN
        RAISE WARNING '006: duplicate % values exist in public.%; unique index %_%_org_uniq was NOT created. Remove the duplicates and re-run 006.',
                      u.col, u.tbl, u.tbl, u.col;
      END;
    END IF;
  END LOOP;
END
$do$;

-- =====================================================================================================
-- 8. INTEGRITY (audit 2.7, 4.2)
-- 8a. CHECK constraints, added NOT VALID: existing rows are not re-checked (so old data cannot block the
--     migration) but EVERY new insert and update is enforced. Run VALIDATE CONSTRAINT after cleaning old data.
-- =====================================================================================================

DO $do$
DECLARE
  k RECORD;
  missing BOOLEAN;
  col TEXT;
BEGIN
  FOR k IN SELECT * FROM (VALUES
    ('quote_line_items',    'quote_line_items_quantity_positive',   'quantity > 0',    ARRAY['quantity']),
    ('quote_line_items',    'quote_line_items_unit_price_nonneg',   'unit_price >= 0', ARRAY['unit_price']),
    ('invoice_line_items',  'invoice_line_items_quantity_positive', 'quantity > 0',    ARRAY['quantity']),
    ('invoice_line_items',  'invoice_line_items_unit_price_nonneg', 'unit_price >= 0', ARRAY['unit_price']),
    ('delivery_note_items', 'delivery_note_items_quantity_positive','quantity > 0',    ARRAY['quantity']),
    ('invoices',            'invoices_total_nonneg',                'total >= 0',      ARRAY['total']),
    ('invoices',            'invoices_subtotal_nonneg',             'subtotal >= 0',   ARRAY['subtotal']),
    ('rfqs',                'rfqs_quantity_nonneg',                 'quantity >= 0',   ARRAY['quantity'])
  ) AS v(tbl, cname, expr, cols)
  LOOP
    IF to_regclass('public.' || k.tbl) IS NULL THEN CONTINUE; END IF;
    missing := FALSE;
    FOREACH col IN ARRAY k.cols LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = k.tbl AND column_name = col) THEN
        missing := TRUE;
      END IF;
    END LOOP;
    IF missing THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.' || k.tbl) AND conname = k.cname) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', k.tbl, k.cname, k.expr);
    END IF;
  END LOOP;
END
$do$;

-- 8b. Same-organisation guard for child rows. Instead of composite foreign keys (which need a
--     unique (organization_id, id) on every parent) a BEFORE INSERT/UPDATE trigger looks up the parent
--     row and raises if its organization_id differs from the child's. The lookup is SECURITY DEFINER so
--     it also catches parents the caller cannot see.
CREATE OR REPLACE FUNCTION public.enforce_same_org_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_id  UUID;
  parent_org UUID;
BEGIN
  -- TG_ARGV[0] = parent table, TG_ARGV[1] = foreign key column on the child.
  parent_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[1], '')::UUID;
  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', TG_ARGV[0]) INTO parent_org USING parent_id;
  -- Parent not found: leave that to the foreign key constraint.
  IF parent_org IS NOT NULL AND parent_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'cross-organisation reference rejected: % row belongs to a different organisation', TG_ARGV[0]
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_same_org_parent() FROM PUBLIC, anon;

DO $do$
DECLARE
  g RECORD;
BEGIN
  FOR g IN SELECT * FROM (VALUES
    ('quote_line_items',    'quotes',         'quote_id'),
    ('invoice_line_items',  'invoices',       'invoice_id'),
    ('delivery_note_items', 'delivery_notes', 'delivery_note_id'),
    ('machine_bookings',    'machines',       'machine_id'),
    ('machine_bookings',    'jobs',           'job_id')
  ) AS v(child, parent, fk)
  LOOP
    IF to_regclass('public.' || g.child) IS NOT NULL AND to_regclass('public.' || g.parent) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'zz_same_org_' || g.fk, g.child);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent(%L, %L)',
        'zz_same_org_' || g.fk, g.child, g.parent, g.fk);
    END IF;
  END LOOP;
END
$do$;

-- =====================================================================================================
-- 9. STORAGE (audit 4.3)
-- Private buckets get a mime allow-list and 20 MB cap; quote-attachments writes now need admin/office
-- (reads too); job-drawings keeps the organisation-folder rule plus roles (viewer may read).
-- Object path convention: <organization_id>/...
-- =====================================================================================================

DO $do$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
    SET allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
        file_size_limit = 20971520
    WHERE id IN ('job-drawings', 'quote-attachments');
  END IF;
END
$do$;

DO $do$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  -- quote-attachments: admin + office only.
  DROP POLICY IF EXISTS "quote-attachments org select" ON storage.objects;
  DROP POLICY IF EXISTS "quote-attachments org insert" ON storage.objects;
  DROP POLICY IF EXISTS "quote-attachments org update" ON storage.objects;
  DROP POLICY IF EXISTS "quote-attachments org delete" ON storage.objects;

  CREATE POLICY "quote-attachments org select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'quote-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office']));

  CREATE POLICY "quote-attachments org insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'quote-attachments'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin', 'office']));

  CREATE POLICY "quote-attachments org update" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'quote-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office']))
    WITH CHECK (bucket_id = 'quote-attachments'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin', 'office']));

  CREATE POLICY "quote-attachments org delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'quote-attachments'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office']));

  -- job-drawings: everyone in the organisation may read; admin/office/workshop may change.
  DROP POLICY IF EXISTS "job drawings org select" ON storage.objects;
  DROP POLICY IF EXISTS "job drawings org insert" ON storage.objects;
  DROP POLICY IF EXISTS "job drawings org update" ON storage.objects;
  DROP POLICY IF EXISTS "job drawings org delete" ON storage.objects;

  CREATE POLICY "job drawings org select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'job-drawings'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));

  CREATE POLICY "job drawings org insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'job-drawings'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

  CREATE POLICY "job drawings org update" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'job-drawings'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office', 'workshop']))
    WITH CHECK (bucket_id = 'job-drawings'
                AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
                AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));

  CREATE POLICY "job drawings org delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'job-drawings'
           AND (storage.foldername(name))[1] = public.current_user_organization_id()::TEXT
           AND public.has_org_role(ARRAY['admin', 'office', 'workshop']));
END
$do$;

-- =====================================================================================================
-- 10. COMPANY PROFILE PER ORGANISATION (audit 2.3)
-- organization_settings.company_profile holds the details printed on documents (name, address, VAT number,
-- logo, default terms). Only admins may change it: the 004 trigger is extended. The trigger only enforces
-- for signed-in users (auth.uid() not null); the SQL editor / service role are not blocked.
-- =====================================================================================================

ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS company_profile JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE OR REPLACE FUNCTION public.organization_settings_guard_nav()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.hidden_nav IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.hidden_nav ELSE '{}'::TEXT[] END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change hidden menu items';
    END IF;
    IF NEW.company_profile IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.company_profile ELSE '{}'::JSONB END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change the company profile';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_settings_guard_nav ON public.organization_settings;
CREATE TRIGGER organization_settings_guard_nav
  BEFORE INSERT OR UPDATE ON public.organization_settings
  FOR EACH ROW EXECUTE FUNCTION public.organization_settings_guard_nav();

-- No company profile is seeded: each tenant's profile is set by public.create_organization() (007) or edited in the
-- app under Settings > Company details.

-- =====================================================================================================
-- 8c. email_history CHECK constraints (server-side send flow writes 'sending' and 'failed').
-- production-hardening.sql and critical-prelaunch-security.sql define different lists, so every CHECK that
-- mentions status / related_to_type is dropped (whatever its name) and recreated with the full lists.
-- =====================================================================================================

DO $do$
DECLARE
  c RECORD;
BEGIN
  IF to_regclass('public.email_history') IS NULL THEN
    RETURN;
  END IF;
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.email_history'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) ~ '\mstatus\M' OR pg_get_constraintdef(oid) ~ '\mrelated_to_type\M')
  LOOP
    EXECUTE format('ALTER TABLE public.email_history DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.email_history ADD CONSTRAINT email_history_status_check
    CHECK (status IN ('drafted', 'copied', 'sent_manually', 'sent_via_system', 'sending', 'failed'));
  ALTER TABLE public.email_history ADD CONSTRAINT email_history_related_to_type_check
    CHECK (related_to_type IN ('invoice', 'quote', 'sales_order', 'purchase_order', 'delivery_note', 'rfq', 'job', 'general'));
END
$do$;

-- =====================================================================================================
-- 11. INDEXES (audit 2.7). Each one is created only when its table and columns exist.
-- =====================================================================================================

DO $do$
DECLARE
  ix RECORD;
  missing BOOLEAN;
  col TEXT;
BEGIN
  FOR ix IN SELECT * FROM (VALUES
    ('idx_quotes_org_created',          'quotes',          '(organization_id, created_at DESC)', ARRAY['organization_id', 'created_at']),
    ('idx_invoices_org_created',        'invoices',        '(organization_id, created_at DESC)', ARRAY['organization_id', 'created_at']),
    ('idx_jobs_org_created',            'jobs',            '(organization_id, created_at DESC)', ARRAY['organization_id', 'created_at']),
    ('idx_rfqs_org_created',            'rfqs',            '(organization_id, created_at DESC)', ARRAY['organization_id', 'created_at']),
    ('idx_purchase_orders_org_created', 'purchase_orders', '(organization_id, created_at DESC)', ARRAY['organization_id', 'created_at']),
    ('idx_invoices_org_status',         'invoices',        '(organization_id, status)',          ARRAY['organization_id', 'status']),
    ('idx_sales_orders_org_order_date', 'sales_orders',    '(organization_id, order_date DESC)', ARRAY['organization_id', 'order_date']),
    ('idx_delivery_notes_org_delivery', 'delivery_notes',  '(organization_id, delivery_date DESC)', ARRAY['organization_id', 'delivery_date']),
    ('idx_email_history_org_status',    'email_history',   '(organization_id, status)',          ARRAY['organization_id', 'status'])
  ) AS v(iname, tbl, def, cols)
  LOOP
    IF to_regclass('public.' || ix.tbl) IS NULL THEN CONTINUE; END IF;
    missing := FALSE;
    FOREACH col IN ARRAY ix.cols LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ix.tbl AND column_name = col) THEN
        missing := TRUE;
      END IF;
    END LOOP;
    IF NOT missing THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I %s', ix.iname, ix.tbl, ix.def);
    END IF;
  END LOOP;
END
$do$;

COMMIT;
