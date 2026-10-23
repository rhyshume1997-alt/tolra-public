-- import_legacy_tenant.sql: loads the data exported from the OLD single-tenant project into ONE organisation (tenant)
-- of the NEW multi-tenant project. The target organisation must already exist (see 007: public.create_organization).
--
-- Run on the NEW project, in the SQL editor (as the project owner / postgres), AFTER migrations 000 - 009 (009 adds job_values, which the import writes), AFTER the target organisation was created and AFTER
-- the users have been invited (Authentication > Users) so their e-mail addresses exist in auth.users.
--
--   1. Run this whole file once. It creates two archive/mapping tables and the function
--      public.import_legacy_tenant(jsonb) (and nothing else; it does not import data by itself).
--   2. On the OLD project run supabase/import/export_legacy.sql and copy the single JSON cell.
--   3. On the NEW project run:
--          select public.import_legacy_tenant($legacy$ <paste the JSON here> $legacy$::jsonb,
--                                             (select id from public.organizations where slug = '<tenant slug>'));
--      The result is a JSON report (counts per table, skipped rows, doc counters). Read it.
--
-- What it does
--   * The legacy organisation id is NOT assumed to exist in the new database: every imported row gets
--     organization_id = p_target_org (legacy organisation id -> target organisation). Profiles are matched by e-mail
--     and attached to p_target_org.
--   * Every bigint id becomes a fresh uuid. The old id -> new id mapping is kept in public.legacy_import_map, so
--     foreign keys are re-pointed (quotes.rfq_id, jobs.quote_id, jobs.converted_from_sales_order_id,
--     sales_orders.quote_id / converted_to_job_id, invoices.job_id, email_history.related_to_id, ...).
--   * Column renames: jobs.job_ref -> job_no, delivery_notes.dn_ref -> dn_number, sales_orders.order_ref -> so_number,
--     sales_orders.expected_delivery -> delivery_date, quotes.sent_date -> sent_at, invoices.paid_date -> paid_at,
--     delivery_notes.job_id -> job_ref, delivery_notes.signed_by -> signed_by_name, purchase_orders.po_ref -> po_ref + po_number.
--   * A quote or invoice that carries one description / quantity / unit price gets ONE line item
--     (quote_line_items / invoice_line_items). delivery_notes.items (jsonb) becomes delivery_note_items rows.
--     purchase_orders.items stays jsonb.
--   * user_profiles: matched BY E-MAIL to auth.users of the new project. The profile gets the NEW auth id. A profile
--     whose e-mail is not (yet) in auth.users is skipped and listed in the report; invite the user and run the
--     import again, it only adds what is missing.
--     Each matched profile also gets a membership (organization_members) in p_target_org with its legacy role; a profile
--     that already exists with another current organisation keeps that organisation and just gains the membership.
--   * created_at / updated_at are kept. created_by / updated_by / drafted_by are re-pointed to the matching new user,
--     or left empty when that user was not imported.
--   * security_audit.audit_log rows go to public.legacy_audit_log (read-only archive, admins of the organisation can
--     read it). The hash chain of the old project cannot be validated after a move, so they are NOT put in the new chain.
--   * Idempotent: running it again imports nothing twice (public.legacy_import_map records every imported row).
--     A row whose document number already exists in the new project (quote_ref, invoice_ref, job_no, po_ref, stock sku)
--     is not duplicated: the old id is mapped to the existing row and the report counts it as "matched_existing".
--   * Everything runs in one transaction: any error rolls the whole import back.
--   * Finally the document counters of the TARGET ORGANISATION ONLY are reseeded (the same rule as
--     public.reseed_doc_counters(), restricted to p_target_org: no other company's counter is read, created or raised),
--     so QUO-/INV-/J-/PO- numbering continues after the highest existing number that matches the pattern PREFIX-digits
--     (old XYZ-Q-357 style numbers do not match, so the next quote is QUO-0001).
--
-- Importing fires the normal row-change audit triggers: the new audit trail gets one INSERT row per imported row
-- (actor empty = SQL editor). That is deliberate: it records what the import did.

-- ---------------------------------------------------------------------------------------------------------------
-- Support tables (idempotent)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.legacy_import_map (
  source      TEXT NOT NULL,           -- legacy table name, e.g. 'quotes'
  old_id      TEXT NOT NULL,           -- legacy primary key (bigint as text, or uuid as text)
  new_id      UUID NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, old_id)
);
ALTER TABLE public.legacy_import_map ENABLE ROW LEVEL SECURITY;           -- no policies: owner only
REVOKE ALL ON public.legacy_import_map FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.legacy_audit_log (
  old_id          UUID PRIMARY KEY,
  organization_id UUID REFERENCES public.organizations(id),
  actor_user_id   UUID,                -- the OLD project's auth user id (not valid in this project)
  actor_email     TEXT,
  action          TEXT NOT NULL,
  entity_table    TEXT NOT NULL,
  entity_id       TEXT,                -- OLD ids (bigint as text); see legacy_import_map to translate
  old_data        JSONB,
  new_data        JSONB,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address      INET,
  user_agent      TEXT,
  request_id      TEXT,
  previous_hash   TEXT,
  hash            TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legacy_audit_log_org_created_idx ON public.legacy_audit_log (organization_id, created_at DESC);
ALTER TABLE public.legacy_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.legacy_audit_log TO authenticated;
DROP POLICY IF EXISTS "legacy_audit_log admins read" ON public.legacy_audit_log;
CREATE POLICY "legacy_audit_log admins read" ON public.legacy_audit_log FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));

-- Read-only for everyone, owner included (same rule as the live audit log).
DROP TRIGGER IF EXISTS legacy_audit_log_prevent_mutation ON public.legacy_audit_log;
CREATE TRIGGER legacy_audit_log_prevent_mutation BEFORE UPDATE OR DELETE ON public.legacy_audit_log
  FOR EACH ROW EXECUTE FUNCTION security_audit.prevent_audit_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- The importer
-- ---------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_legacy_tenant(p JSONB, p_target_org UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $fn$
DECLARE
  srcs     TEXT[] := ARRAY['user_profiles', 'customers', 'suppliers', 'stock', 'rfqs', 'quotes', 'sales_orders', 'jobs',
                           'invoices', 'purchase_orders', 'delivery_notes', 'email_history'];
  src      TEXT;
  n        INT;
  n_read   INT;
  n_new    INT;
  n_adopt  INT;
  n_skip   INT;
  v_tables JSONB := '{}'::JSONB;
  v_lines  JSONB := '{}'::JSONB;
  v_skipped JSONB := '[]'::JSONB;
  v_unmatched JSONB := '[]'::JSONB;
  v_notes  JSONB := '[]'::JSONB;
  r        RECORD;
  c_ql INT := 0; c_il INT := 0; c_dl INT := 0; c_audit INT := 0; c_audit_read INT := 0;
  v_counters JSONB;
  v_expected JSONB;
  c_prof INT := 0;
  v_org_name TEXT;
  v_pattern TEXT;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR p ->> 'format' IS DISTINCT FROM 'quoteflow-legacy-export/1' THEN
    RAISE EXCEPTION 'import_legacy_tenant: expected the JSON produced by supabase/import/export_legacy.sql (format quoteflow-legacy-export/1)';
  END IF;

  IF p_target_org IS NULL THEN
    RAISE EXCEPTION 'import_legacy_tenant: p_target_org is required (create the organisation first with public.create_organization)';
  END IF;
  SELECT o.name INTO v_org_name FROM public.organizations o WHERE o.id = p_target_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_legacy_tenant: organisation % does not exist', p_target_org;
  END IF;

  -- Map the legacy organisation id(s) onto the target organisation: every row of every data table gets
  -- organization_id = p_target_org (audit_log rows that had no organisation stay without one).
  SELECT jsonb_object_agg(t.k,
           CASE
             WHEN t.k = ANY (srcs) AND jsonb_typeof(t.v) = 'array' THEN
               (SELECT coalesce(jsonb_agg(e.value || jsonb_build_object('organization_id', p_target_org) ORDER BY e.ord), '[]'::JSONB)
                  FROM jsonb_array_elements(t.v) WITH ORDINALITY AS e(value, ord))
             WHEN t.k = 'audit_log' AND jsonb_typeof(t.v) = 'array' THEN
               (SELECT coalesce(jsonb_agg(CASE WHEN e.value ->> 'organization_id' IS NULL THEN e.value
                                               ELSE e.value || jsonb_build_object('organization_id', p_target_org) END ORDER BY e.ord), '[]'::JSONB)
                  FROM jsonb_array_elements(t.v) WITH ORDINALITY AS e(value, ord))
             ELSE t.v
           END)
    INTO p
    FROM jsonb_each(p) AS t(k, v);

  -- One import at a time.
  PERFORM pg_advisory_xact_lock(hashtext('import_legacy_tenant'));

  -- sales_orders <-> jobs point at each other: allow the load in any order inside this transaction.
  SET CONSTRAINTS sales_orders_converted_to_job_id_fkey, jobs_converted_from_sales_order_id_fkey DEFERRED;

  -- Rows that get imported by THIS run (a temp table so the mapping survives across the steps below).
  DROP TABLE IF EXISTS _imp_new;
  CREATE TEMP TABLE _imp_new (source TEXT NOT NULL, old_id TEXT NOT NULL, adopted BOOLEAN NOT NULL DEFAULT FALSE,
                              PRIMARY KEY (source, old_id)) ON COMMIT DROP;

  -- ===== 1. organizations: nothing is created; the legacy organisation is mapped onto p_target_org =====
  v_tables := v_tables || jsonb_build_object('organizations', jsonb_build_object(
    'read', jsonb_array_length(coalesce(p -> 'organizations', '[]'::JSONB)), 'inserted', 0,
    'mapped_to', jsonb_build_object('id', p_target_org, 'name', v_org_name)));

  -- ===== 2. ID MAP =======================================================================================
  -- 2a. user_profiles: legacy id -> the auth.users id with the same e-mail in THIS project.
  WITH cand AS (
    SELECT j.id AS old_id, u.id AS new_id
    FROM jsonb_to_recordset(coalesce(p -> 'user_profiles', '[]'::JSONB)) AS j(id UUID, email TEXT, organization_id UUID)
    JOIN auth.users u ON lower(u.email) = lower(j.email)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'user_profiles', old_id::TEXT, new_id FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id
  )
  INSERT INTO _imp_new (source, old_id) SELECT 'user_profiles', old_id FROM ins;

  -- 2b. tables with bigint ids. Natural-key tables adopt an existing row with the same document number
  --     instead of failing on the unique index.
  FOREACH src IN ARRAY ARRAY['customers', 'suppliers', 'rfqs', 'sales_orders', 'delivery_notes'] LOOP
    WITH cand AS (
      SELECT j.id::TEXT AS old_id
      FROM jsonb_to_recordset(coalesce(p -> src, '[]'::JSONB)) AS j(id BIGINT, organization_id UUID)
      WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
    ), ins AS (
      INSERT INTO public.legacy_import_map (source, old_id, new_id)
      SELECT src, old_id, gen_random_uuid() FROM cand
      ON CONFLICT (source, old_id) DO NOTHING
      RETURNING old_id
    )
    INSERT INTO _imp_new (source, old_id) SELECT src, old_id FROM ins;
  END LOOP;

  -- quotes / invoices / jobs / purchase_orders / stock: adopt on (organization, document number)
  WITH cand AS (
    SELECT j.id::TEXT AS old_id,
           (SELECT t.id FROM public.quotes t WHERE t.organization_id = j.organization_id AND t.quote_ref = j.quote_ref) AS existing
    FROM jsonb_to_recordset(coalesce(p -> 'quotes', '[]'::JSONB)) AS j(id BIGINT, organization_id UUID, quote_ref TEXT)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'quotes', old_id, coalesce(existing, gen_random_uuid()) FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id, new_id
  )
  INSERT INTO _imp_new (source, old_id, adopted) SELECT 'quotes', i.old_id, c.existing IS NOT NULL FROM ins i JOIN cand c USING (old_id);

  WITH cand AS (
    SELECT j.id::TEXT AS old_id,
           (SELECT t.id FROM public.invoices t WHERE t.organization_id = j.organization_id AND t.invoice_ref = j.invoice_ref) AS existing
    FROM jsonb_to_recordset(coalesce(p -> 'invoices', '[]'::JSONB)) AS j(id BIGINT, organization_id UUID, invoice_ref TEXT)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'invoices', old_id, coalesce(existing, gen_random_uuid()) FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id, new_id
  )
  INSERT INTO _imp_new (source, old_id, adopted) SELECT 'invoices', i.old_id, c.existing IS NOT NULL FROM ins i JOIN cand c USING (old_id);

  WITH cand AS (
    SELECT j.id::TEXT AS old_id,
           (SELECT t.id FROM public.jobs t WHERE t.organization_id = j.organization_id AND t.job_no = j.job_ref) AS existing
    FROM jsonb_to_recordset(coalesce(p -> 'jobs', '[]'::JSONB)) AS j(id BIGINT, organization_id UUID, job_ref TEXT)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'jobs', old_id, coalesce(existing, gen_random_uuid()) FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id, new_id
  )
  INSERT INTO _imp_new (source, old_id, adopted) SELECT 'jobs', i.old_id, c.existing IS NOT NULL FROM ins i JOIN cand c USING (old_id);

  WITH cand AS (
    SELECT j.id::TEXT AS old_id,
           (SELECT t.id FROM public.purchase_orders t WHERE t.organization_id = j.organization_id AND t.po_ref = j.po_ref) AS existing
    FROM jsonb_to_recordset(coalesce(p -> 'purchase_orders', '[]'::JSONB)) AS j(id BIGINT, organization_id UUID, po_ref TEXT)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'purchase_orders', old_id, coalesce(existing, gen_random_uuid()) FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id, new_id
  )
  INSERT INTO _imp_new (source, old_id, adopted) SELECT 'purchase_orders', i.old_id, c.existing IS NOT NULL FROM ins i JOIN cand c USING (old_id);

  WITH cand AS (
    SELECT j.id::TEXT AS old_id,
           (SELECT t.id FROM public.stock t WHERE t.organization_id = j.organization_id AND t.sku = j.sku) AS existing
    FROM jsonb_to_recordset(coalesce(p -> 'stock', '[]'::JSONB)) AS j(id BIGINT, organization_id UUID, sku TEXT)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'stock', old_id, coalesce(existing, gen_random_uuid()) FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id, new_id
  )
  INSERT INTO _imp_new (source, old_id, adopted) SELECT 'stock', i.old_id, c.existing IS NOT NULL FROM ins i JOIN cand c USING (old_id);

  -- email_history keeps its (uuid) id
  WITH cand AS (
    SELECT j.id AS old_id
    FROM jsonb_to_recordset(coalesce(p -> 'email_history', '[]'::JSONB)) AS j(id UUID, organization_id UUID)
    WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ), ins AS (
    INSERT INTO public.legacy_import_map (source, old_id, new_id)
    SELECT 'email_history', old_id::TEXT, old_id FROM cand
    ON CONFLICT (source, old_id) DO NOTHING
    RETURNING old_id
  )
  INSERT INTO _imp_new (source, old_id) SELECT 'email_history', old_id FROM ins;

  -- ===== 3. user_profiles ================================================================================
  INSERT INTO public.user_profiles (id, email, full_name, role, secondary_role, organization_id, organization, workshop_email,
                                    active, mfa_required, last_login_at, created_at, updated_at)
  SELECT m.new_id, j.email, j.full_name, coalesce(j.role, 'workshop'), j.secondary_role, j.organization_id,
         v_org_name, j.workshop_email, coalesce(j.active, TRUE), coalesce(j.mfa_required, FALSE),
         j.last_login_at, coalesce(j.created_at, now()), coalesce(j.updated_at, now())
  FROM jsonb_to_recordset(p -> 'user_profiles') AS j(id UUID, email TEXT, full_name TEXT, role TEXT, secondary_role TEXT,
         organization_id UUID, organization TEXT, workshop_email TEXT, active BOOLEAN, mfa_required BOOLEAN,
         last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'user_profiles' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'user_profiles' AND nw.old_id = m.old_id
  ON CONFLICT DO NOTHING;     -- the owner already created this profile by hand (same id or same e-mail): leave it as it is
  GET DIAGNOSTICS c_prof = ROW_COUNT;

  -- Every matched profile (new, or one the owner had already created, possibly with another current organisation)
  -- becomes a member of the target organisation with the role of its legacy row. An existing membership is left
  -- as it is, so a re-import adds nothing.
  INSERT INTO public.organization_members (user_id, organization_id, role, secondary_role, active, created_at)
  SELECT m.new_id, p_target_org, coalesce(j.role, 'workshop'), j.secondary_role, coalesce(j.active, TRUE), coalesce(j.created_at, now())
  FROM jsonb_to_recordset(coalesce(p -> 'user_profiles', '[]'::JSONB)) AS j(id UUID, role TEXT, secondary_role TEXT, active BOOLEAN, created_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'user_profiles' AND m.old_id = j.id::TEXT
  ON CONFLICT (user_id, organization_id) DO NOTHING;

  -- ===== 4. customers / suppliers / stock / rfqs ========================================================
  INSERT INTO public.customers (id, organization_id, name, contact_name, email, phone, address, notes, status, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.name, NULL, j.email, j.phone, j.address, j.notes, coalesce(j.status, 'active'),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'customers') AS j(id BIGINT, organization_id UUID, name TEXT, email TEXT, phone TEXT, address TEXT, notes TEXT,
         status TEXT, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'customers' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'customers' AND nw.old_id = m.old_id AND NOT nw.adopted;

  INSERT INTO public.suppliers (id, organization_id, name, email, phone, on_time_rate, reliability_status, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.name, j.email, j.phone, j.on_time_rate, j.reliability_status,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'suppliers') AS j(id BIGINT, organization_id UUID, name TEXT, email TEXT, phone TEXT, on_time_rate NUMERIC,
         reliability_status TEXT, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'suppliers' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'suppliers' AND nw.old_id = m.old_id AND NOT nw.adopted;

  INSERT INTO public.stock (id, organization_id, sku, material, current_stock, min_level, reorder_quantity, preferred_supplier, unit_price,
                            lead_time_days, auto_purchase, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.sku, j.material, j.current_stock, j.min_level, j.reorder_quantity, j.preferred_supplier, j.unit_price,
         j.lead_time_days, j.auto_purchase,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'stock') AS j(id BIGINT, organization_id UUID, sku TEXT, material TEXT, current_stock INT, min_level INT,
         reorder_quantity INT, preferred_supplier TEXT, unit_price NUMERIC, lead_time_days TEXT, auto_purchase BOOLEAN,
         created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'stock' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'stock' AND nw.old_id = m.old_id AND NOT nw.adopted;

  INSERT INTO public.rfqs (id, organization_id, customer, email, phone, description, quantity, material, estimated_value, status, notes,
                           created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.customer, j.email, j.phone, j.description, j.quantity, j.material, j.estimated_value, j.status, j.notes,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'rfqs') AS j(id BIGINT, organization_id UUID, customer TEXT, email TEXT, phone TEXT, description TEXT, quantity INT,
         material TEXT, estimated_value NUMERIC, status TEXT, notes TEXT, created_by UUID, updated_by UUID,
         created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'rfqs' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'rfqs' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- ===== 5. quotes + one line item ======================================================================
  INSERT INTO public.quotes (id, organization_id, quote_ref, rfq_id, customer, description, total_value, status, valid_until, sent_at,
                             created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.quote_ref,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'rfqs' AND x.old_id = j.rfq_id::TEXT),
         j.customer, j.description, j.total_value, coalesce(j.status, 'draft'), j.valid_until, j.sent_date,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'quotes') AS j(id BIGINT, organization_id UUID, quote_ref TEXT, rfq_id BIGINT, customer TEXT, description TEXT,
         total_value NUMERIC, status TEXT, valid_until DATE, sent_date TIMESTAMPTZ, created_by UUID, updated_by UUID,
         created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'quotes' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'quotes' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- One line from description / quantity / material / unit_price (a quote with none of them gets no line).
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, source, created_at)
  SELECT j.organization_id, m.new_id, 0,
         coalesce(nullif(btrim(j.description), ''), 'Imported quote ' || j.quote_ref)
           || CASE WHEN nullif(btrim(j.material), '') IS NOT NULL THEN ' - ' || btrim(j.material) ELSE '' END,
         CASE WHEN j.quantity IS NOT NULL AND j.quantity > 0 THEN j.quantity ELSE 1 END,
         round(coalesce(j.unit_price,
                        CASE WHEN j.total_value IS NOT NULL THEN j.total_value / (CASE WHEN j.quantity IS NOT NULL AND j.quantity > 0 THEN j.quantity ELSE 1 END) END,
                        0)::NUMERIC, 2),
         'manual', coalesce(j.created_at, now())
  FROM jsonb_to_recordset(p -> 'quotes') AS j(id BIGINT, organization_id UUID, quote_ref TEXT, description TEXT, material TEXT, quantity INT,
         unit_price NUMERIC, total_value NUMERIC, created_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'quotes' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'quotes' AND nw.old_id = m.old_id AND NOT nw.adopted
  WHERE nullif(btrim(j.description), '') IS NOT NULL OR j.unit_price IS NOT NULL OR j.quantity IS NOT NULL;
  GET DIAGNOSTICS c_ql = ROW_COUNT;

  -- ===== 6. sales_orders and jobs (cross-linked; constraints are deferred) ===============================
  INSERT INTO public.sales_orders (id, organization_id, so_number, customer, quote_id, quote_ref, status, order_date, delivery_date, total_value, notes,
                                   converted_to_job_id, converted_at, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.order_ref, j.customer, q.id,
         coalesce(q.quote_ref, CASE WHEN j.quote_id IS NOT NULL AND j.quote_id !~ '^\d+$' THEN j.quote_id END),
         coalesce(j.status, 'open'), j.order_date, j.expected_delivery, j.total_value, j.notes,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'jobs' AND x.old_id = j.converted_to_job_id::TEXT), j.converted_at,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'sales_orders') AS j(id BIGINT, organization_id UUID, order_ref TEXT, customer TEXT, quote_id TEXT, status TEXT,
         order_date DATE, expected_delivery DATE, total_value NUMERIC, notes TEXT, converted_to_job_id BIGINT, converted_at TIMESTAMPTZ,
         created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'sales_orders' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'sales_orders' AND nw.old_id = m.old_id AND NOT nw.adopted
  -- legacy quote_id is text: a number (old quote id) or a quote reference
  LEFT JOIN public.quotes q ON q.id = coalesce(
        (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'quotes' AND x.old_id = j.quote_id),
        (SELECT t.id FROM public.quotes t WHERE t.organization_id = j.organization_id AND t.quote_ref = j.quote_id));

  INSERT INTO public.jobs (id, organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
                           started_at, finished_at, converted_from_sales_order_id, converted_at, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.job_ref,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'quotes' AND x.old_id = j.quote_id::TEXT),
         j.customer, j.description, coalesce(j.stage, 'material'), j.due_date, coalesce(j.status, 'on_track'), j.specification,
         CASE WHEN jsonb_typeof(j.drawings) = 'array' THEN j.drawings ELSE '[]'::JSONB END,
         j.started_at, j.finished_at,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'sales_orders' AND x.old_id = j.converted_from_sales_order_id::TEXT),
         j.converted_at,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'jobs') AS j(id BIGINT, organization_id UUID, job_ref TEXT, quote_id BIGINT, customer TEXT, description TEXT, stage TEXT,
         due_date DATE, value NUMERIC, status TEXT, specification TEXT, drawings JSONB, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
         converted_from_sales_order_id BIGINT, converted_at TIMESTAMPTZ, created_by UUID, updated_by UUID,
         created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'jobs' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'jobs' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- Job prices live in job_values (admin/office only, migration 009), not on the job the workshop can read.
  INSERT INTO public.job_values (job_id, organization_id, value)
  SELECT m.new_id, j.organization_id, j.value
  FROM jsonb_to_recordset(p -> 'jobs') AS j(id BIGINT, organization_id UUID, value NUMERIC)
  JOIN public.legacy_import_map m ON m.source = 'jobs' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'jobs' AND nw.old_id = m.old_id AND NOT nw.adopted
  WHERE j.value IS NOT NULL
  ON CONFLICT (job_id) DO NOTHING;

  -- The worksheet / job list show the quote number from jobs.quote_ref: fill it from the linked quote.
  UPDATE public.jobs jb SET quote_ref = q.quote_ref
  FROM public.quotes q
  WHERE q.id = jb.quote_id AND jb.quote_ref IS NULL
    AND jb.id IN (SELECT m.new_id FROM public.legacy_import_map m JOIN _imp_new nw ON nw.source = m.source AND nw.old_id = m.old_id
                  WHERE m.source = 'jobs' AND NOT nw.adopted);

  -- ===== 7. invoices + one line item ====================================================================
  INSERT INTO public.invoices (id, organization_id, invoice_ref, job_id, customer, description, quantity, unit_price, subtotal, vat, total, status,
                               sent_date, due_date, invoice_date, amount_paid, paid_at, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.invoice_ref,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'jobs' AND x.old_id = j.job_id::TEXT),
         j.customer, j.description, j.quantity, j.unit_price, j.subtotal, j.vat, j.total, coalesce(j.status, 'draft'),
         j.sent_date, j.due_date, coalesce(j.sent_date, j.created_at, now())::DATE,
         CASE WHEN j.status = 'paid' THEN coalesce(j.total, 0) ELSE 0 END, j.paid_date,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'invoices') AS j(id BIGINT, organization_id UUID, invoice_ref TEXT, job_id BIGINT, customer TEXT, description TEXT,
         quantity INT, unit_price NUMERIC, subtotal NUMERIC, vat NUMERIC, total NUMERIC, status TEXT, sent_date TIMESTAMPTZ, due_date DATE,
         paid_date TIMESTAMPTZ, created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'invoices' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'invoices' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- No payment amounts in the export, only a status: an invoice not marked paid is NOT assumed unpaid. Once migration
  -- 027 is in, it is flagged "payment to confirm" (kept out of money owed and chasers until someone checks it).
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'payment_unverified') THEN
    EXECUTE $sql$
      UPDATE public.invoices i SET payment_unverified = TRUE
      FROM public.legacy_import_map m JOIN _imp_new nw ON nw.source = m.source AND nw.old_id = m.old_id AND NOT nw.adopted
      WHERE m.source = 'invoices' AND m.new_id = i.id
        AND lower(coalesce(i.status, 'draft')) NOT IN ('paid', 'draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off')
    $sql$;
  END IF;

  -- Part payments (migration 032): invoices.amount_paid is always the sum of the invoice's payment rows. An imported
  -- invoice that carries a receipt (the paid ones, at their total) gets ONE 'legacy' row for exactly that amount, dated from
  -- its paid date; the ones flagged "payment to confirm" and those with nothing received get none.
  IF to_regclass('public.invoice_payments') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, source)
      SELECT i.organization_id, i.id, i.amount_paid, i.paid_at::DATE, 'legacy'
      FROM public.invoices i
      JOIN public.legacy_import_map m ON m.source = 'invoices' AND m.new_id = i.id
      JOIN _imp_new nw ON nw.source = m.source AND nw.old_id = m.old_id AND NOT nw.adopted
      WHERE i.amount_paid > 0 AND NOT i.payment_unverified
        AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)
    $sql$;
  END IF;

  INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, created_at)
  SELECT j.organization_id, m.new_id, 0,
         coalesce(nullif(btrim(j.description), ''), 'Imported invoice ' || j.invoice_ref),
         CASE WHEN j.quantity IS NOT NULL AND j.quantity > 0 THEN j.quantity ELSE 1 END,
         round(coalesce(j.unit_price,
                        CASE WHEN j.subtotal IS NOT NULL THEN j.subtotal / (CASE WHEN j.quantity IS NOT NULL AND j.quantity > 0 THEN j.quantity ELSE 1 END) END,
                        0)::NUMERIC, 2),
         CASE WHEN j.subtotal IS NOT NULL AND j.subtotal > 0 AND j.vat IS NOT NULL THEN least(round(j.vat / j.subtotal * 100, 2), 999.99) ELSE 20 END,
         coalesce(j.created_at, now())
  FROM jsonb_to_recordset(p -> 'invoices') AS j(id BIGINT, organization_id UUID, invoice_ref TEXT, description TEXT, quantity INT,
         unit_price NUMERIC, subtotal NUMERIC, vat NUMERIC, created_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'invoices' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'invoices' AND nw.old_id = m.old_id AND NOT nw.adopted
  WHERE nullif(btrim(j.description), '') IS NOT NULL OR j.unit_price IS NOT NULL OR j.subtotal IS NOT NULL;
  GET DIAGNOSTICS c_il = ROW_COUNT;

  -- ===== 8. purchase_orders (items stay jsonb) ==========================================================
  INSERT INTO public.purchase_orders (id, organization_id, po_ref, po_number, supplier, order_date, expected_delivery, items, total_value, status,
                                      notes, received_at, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.po_ref, j.po_ref, j.supplier, j.order_date, j.expected_delivery,
         CASE WHEN jsonb_typeof(j.items) = 'array' THEN j.items ELSE '[]'::JSONB END,
         j.total_value, coalesce(j.status, 'sent'), j.notes,
         CASE WHEN j.status = 'received' THEN coalesce(j.updated_at, j.created_at) END,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'purchase_orders') AS j(id BIGINT, organization_id UUID, po_ref TEXT, supplier TEXT, order_date DATE,
         expected_delivery DATE, items JSONB, total_value NUMERIC, status TEXT, notes TEXT, created_by UUID, updated_by UUID,
         created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'purchase_orders' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'purchase_orders' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- ===== 9. delivery_notes + items (from the legacy items jsonb) ========================================
  INSERT INTO public.delivery_notes (id, organization_id, dn_number, customer, job_ref, delivery_date, ship_date, status, notes, signed_by_name,
                                     signed_at, signature_notes, emailed_at, created_by, updated_by, created_at, updated_at)
  SELECT m.new_id, j.organization_id, j.dn_ref, j.customer,
         -- legacy job_id is text: an old job id (re-pointed to the job number) or already a reference
         coalesce((SELECT jb.job_no FROM public.legacy_import_map x JOIN public.jobs jb ON jb.id = x.new_id
                   WHERE x.source = 'jobs' AND x.old_id = j.job_id), j.job_id),
         j.delivery_date, j.delivery_date, coalesce(j.status, 'despatched'), j.notes,
         coalesce(j.signed_by_name, j.signed_by), j.signed_at, j.signature_notes, j.emailed_at,
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.created_by::TEXT),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.updated_by::TEXT),
         coalesce(j.created_at, now()), coalesce(j.updated_at, j.created_at, now())
  FROM jsonb_to_recordset(p -> 'delivery_notes') AS j(id BIGINT, organization_id UUID, dn_ref TEXT, customer TEXT, job_id TEXT, delivery_date DATE,
         status TEXT, notes TEXT, signed_by TEXT, signed_by_name TEXT, signed_at TIMESTAMPTZ, signature_notes TEXT, emailed_at TIMESTAMPTZ,
         created_by UUID, updated_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'delivery_notes' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'delivery_notes' AND nw.old_id = m.old_id AND NOT nw.adopted;

  -- items: [{"description": "...", "quantity": 2}, {"name": "...", "qty": 1}, "plain text"] (best effort)
  INSERT INTO public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, created_at)
  SELECT j.organization_id, m.new_id, (e.ord - 1)::INT,
         coalesce(nullif(btrim(CASE WHEN jsonb_typeof(e.item) = 'string' THEN e.item #>> '{}'
                                    ELSE coalesce(e.item ->> 'description', e.item ->> 'name', e.item ->> 'item') END), ''), 'Item'),
         CASE WHEN jsonb_typeof(e.item) = 'object'
                   AND coalesce(e.item ->> 'quantity', e.item ->> 'qty') ~ '^\d+(\.\d+)?$'
                   AND coalesce(e.item ->> 'quantity', e.item ->> 'qty')::NUMERIC > 0
              THEN coalesce(e.item ->> 'quantity', e.item ->> 'qty')::NUMERIC ELSE 1 END,
         coalesce(j.created_at, now())
  FROM jsonb_to_recordset(p -> 'delivery_notes') AS j(id BIGINT, organization_id UUID, items JSONB, created_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'delivery_notes' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'delivery_notes' AND nw.old_id = m.old_id AND NOT nw.adopted
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.items) = 'array' THEN j.items ELSE '[]'::JSONB END) WITH ORDINALITY AS e(item, ord);
  GET DIAGNOSTICS c_dl = ROW_COUNT;

  -- ===== 10. email_history ==============================================================================
  INSERT INTO public.email_history (id, organization_id, to_email, to_name, subject, body, status, related_to_type, related_to_id, drafted_by,
                                    drafted_at, sent_at)
  SELECT m.new_id, j.organization_id, j.to_email, j.to_name, j.subject, j.body, j.status, j.related_to_type,
         -- related_to_id held the OLD id of the quote / invoice / job ...: point it at the new uuid
         coalesce((SELECT x.new_id::TEXT FROM public.legacy_import_map x
                   WHERE x.old_id = j.related_to_id
                     AND x.source = CASE j.related_to_type WHEN 'invoice' THEN 'invoices' WHEN 'quote' THEN 'quotes' WHEN 'job' THEN 'jobs'
                                                           WHEN 'sales_order' THEN 'sales_orders' WHEN 'purchase_order' THEN 'purchase_orders'
                                                           WHEN 'delivery_note' THEN 'delivery_notes' WHEN 'rfq' THEN 'rfqs' END),
                  j.related_to_id),
         (SELECT x.new_id FROM public.legacy_import_map x WHERE x.source = 'user_profiles' AND x.old_id = j.drafted_by::TEXT),
         j.drafted_at, j.sent_at
  FROM jsonb_to_recordset(p -> 'email_history') AS j(id UUID, organization_id UUID, to_email TEXT, to_name TEXT, subject TEXT, body TEXT, status TEXT,
         related_to_type TEXT, related_to_id TEXT, drafted_by UUID, drafted_at TIMESTAMPTZ, sent_at TIMESTAMPTZ)
  JOIN public.legacy_import_map m ON m.source = 'email_history' AND m.old_id = j.id::TEXT
  JOIN _imp_new nw ON nw.source = 'email_history' AND nw.old_id = m.old_id;

  -- ===== 11. audit log archive ==========================================================================
  c_audit_read := jsonb_array_length(coalesce(p -> 'audit_log', '[]'::JSONB));
  INSERT INTO public.legacy_audit_log (old_id, organization_id, actor_user_id, actor_email, action, entity_table, entity_id, old_data, new_data,
                                       metadata, ip_address, user_agent, request_id, previous_hash, hash, created_at)
  SELECT j.id, j.organization_id, j.actor_user_id, j.actor_email, j.action, j.entity_table, j.entity_id, j.old_data, j.new_data,
         coalesce(j.metadata, '{}'::JSONB), j.ip_address, j.user_agent, j.request_id, j.previous_hash, j.hash, j.created_at
  FROM jsonb_to_recordset(coalesce(p -> 'audit_log', '[]'::JSONB)) AS j(id UUID, organization_id UUID, actor_user_id UUID, actor_email TEXT,
         action TEXT, entity_table TEXT, entity_id TEXT, old_data JSONB, new_data JSONB, metadata JSONB, ip_address INET, user_agent TEXT,
         request_id TEXT, previous_hash TEXT, hash TEXT, created_at TIMESTAMPTZ)
  WHERE j.organization_id IS NULL OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = j.organization_id)
  ON CONFLICT (old_id) DO NOTHING;
  GET DIAGNOSTICS c_audit = ROW_COUNT;

  -- ===== 12. report ======================================================================================
  FOREACH src IN ARRAY srcs LOOP
    n_read  := jsonb_array_length(coalesce(p -> src, '[]'::JSONB));
    SELECT count(*) FILTER (WHERE NOT adopted), count(*) FILTER (WHERE adopted) INTO n_new, n_adopt FROM _imp_new WHERE source = src;
    -- rows of this table without a mapping could not be imported
    SELECT count(*) INTO n_skip
    FROM jsonb_array_elements(coalesce(p -> src, '[]'::JSONB)) e
    WHERE NOT EXISTS (SELECT 1 FROM public.legacy_import_map x WHERE x.source = src AND x.old_id = e.value ->> 'id');

    IF n_skip > 0 THEN
      IF src = 'user_profiles' THEN
        FOR r IN SELECT e.value ->> 'id' AS old_id, e.value ->> 'email' AS email, e.value ->> 'role' AS role
                 FROM jsonb_array_elements(p -> src) e
                 WHERE NOT EXISTS (SELECT 1 FROM public.legacy_import_map x WHERE x.source = src AND x.old_id = e.value ->> 'id')
        LOOP
          v_unmatched := v_unmatched || jsonb_build_object('email', r.email, 'role', r.role, 'old_id', r.old_id);
          v_skipped := v_skipped || jsonb_build_object('table', src, 'old_id', r.old_id, 'email', r.email,
                                                   'reason', 'no auth.users row with this e-mail in the new project (invite the user, then run the import again)');
        END LOOP;
      ELSE
        FOR r IN SELECT e.value ->> 'id' AS old_id
                 FROM jsonb_array_elements(p -> src) e
                 WHERE NOT EXISTS (SELECT 1 FROM public.legacy_import_map x WHERE x.source = src AND x.old_id = e.value ->> 'id')
        LOOP
          v_skipped := v_skipped || jsonb_build_object('table', src, 'old_id', r.old_id, 'reason', 'its organization does not exist in the new project');
        END LOOP;
      END IF;
    END IF;

    v_tables := v_tables || jsonb_build_object(src, jsonb_build_object(
      'read', n_read, 'inserted', n_new, 'matched_existing', n_adopt,
      'already_imported', n_read - n_new - n_adopt - n_skip, 'skipped', n_skip));
  END LOOP;

  -- user_profiles: "inserted" counts profiles that really got a row; a profile the owner had already created by hand
  -- (same id or e-mail) is left untouched and counted as matched_existing.
  SELECT count(*) INTO n_new FROM _imp_new WHERE source = 'user_profiles';
  v_tables := jsonb_set(v_tables, '{user_profiles,inserted}', to_jsonb(c_prof));
  v_tables := jsonb_set(v_tables, '{user_profiles,matched_existing}', to_jsonb(n_new - c_prof));

  v_tables := v_tables || jsonb_build_object('audit_log_to_legacy_audit_log', jsonb_build_object(
    'read', c_audit_read, 'inserted', c_audit, 'already_imported', c_audit_read - c_audit));
  v_lines := jsonb_build_object('quote_line_items_created', c_ql, 'invoice_line_items_created', c_il, 'delivery_note_items_created', c_dl);

  -- compare with the counts recorded by the export
  v_expected := coalesce(p -> 'counts', '{}'::JSONB);
  FOR r IN SELECT k AS tbl, (v_expected ->> k)::INT AS exp
           FROM jsonb_object_keys(v_expected) k
           WHERE k <> 'audit_log' AND k <> 'organizations'
  LOOP
    IF jsonb_array_length(coalesce(p -> r.tbl, '[]'::JSONB)) <> r.exp THEN
      v_notes := v_notes || to_jsonb('export says ' || r.exp || ' ' || r.tbl || ' rows but the JSON holds ' || jsonb_array_length(coalesce(p -> r.tbl, '[]'::JSONB)) || ' (truncated paste?)');
    END IF;
  END LOOP;

  -- document counters continue after the highest existing PREFIX-digits number
  -- (marker: sliq-scoped-reseed) restricted to the target organisation; GREATEST() so a counter never moves backwards.
  FOR r IN SELECT * FROM (VALUES
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
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col) THEN
      v_pattern := '^' || r.src_prefix || '-(\d{1,9})$';
      EXECUTE format(
        'INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
         SELECT organization_id, %L, max((substring(%I FROM %L))::INT)
         FROM public.%I
         WHERE organization_id = %L AND %I ~ %L
         GROUP BY organization_id
         ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last, EXCLUDED.last)',
        r.counter_prefix, r.col, v_pattern, r.tbl, p_target_org, r.col, v_pattern);
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('organization_id', organization_id, 'prefix', prefix, 'last', last) ORDER BY prefix), '[]'::JSONB)
    INTO v_counters FROM public.doc_counters WHERE organization_id = p_target_org;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_format', p ->> 'format',
    'exported_at', p -> 'exported_at',
    'tables', v_tables,
    'line_items', v_lines,
    'unmatched_profiles', v_unmatched,
    'skipped', v_skipped,
    'notes', v_notes,
    'doc_counters', v_counters
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.import_legacy_tenant(JSONB, UUID) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.import_legacy_tenant(JSONB, UUID) IS
  'Owner-only (SQL editor). Imports the JSON from supabase/import/export_legacy.sql into the given organisation; idempotent.';
