-- Post-144 release step 152 (SliQ go-live import route; registered in supabase/release-plan.json as phase 152, after 151; CI's post-144 step installs it). One-time, one transaction; never part of baseline replay.
-- Not applied anywhere hosted. Canonical source: supabase/proposals/p152_sliq_import_route.sql (its body between BEGIN; and COMMIT; is copied below verbatim
-- between the guard and the self-check; read its header). Apply only after 151 (the guard tests 151's objects) and 076/079/085 (the data import).
-- Verify: supabase/verify/sliq_import_route_152.sql (every row true). Rollback: supabase/release/152_sliq_import_route.rollback.sql.
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regclass('public.import_source_rows') IS NOT NULL OR to_regclass('public.import_source_batches') IS NOT NULL THEN
  RAISE EXCEPTION '152: the SliQ import route already exists; this one-time release was applied before';
 END IF;
 IF to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NULL THEN
  RAISE EXCEPTION '152: required release 151 (Xero invite hardening) is missing; stop and check release preflight';
 END IF;
 IF to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)') IS NULL
    OR to_regprocedure('public.import_admin_org()') IS NULL OR to_regprocedure('public.import_check_payload(jsonb)') IS NULL
    OR to_regclass('public.import_batches') IS NULL OR to_regclass('public.import_record_keys') IS NULL THEN
  RAISE EXCEPTION '152: the data import (076) is not in place; stop and check release preflight';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)')
                AND prosrc LIKE '%_imp_credit_notes%') THEN
  RAISE EXCEPTION '152: the data import is not 085''s (credit and delivery notes); stop and check release preflight';
 END IF;
 IF to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL OR to_regprocedure('public.support_readonly_guard()') IS NULL
    OR to_regprocedure('public.require_admin_mfa_guard()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
    OR to_regprocedure('public.current_user_organization_id()') IS NULL THEN
  RAISE EXCEPTION '152: the helper functions it builds on are not all in place; stop and check release preflight';
 END IF;
END $post_release_guard$;

-- ---- 1. Tables --------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_source_batches (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  source_sha256   TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  run_label       TEXT NOT NULL CHECK (run_label ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  entity          TEXT NOT NULL CHECK (entity IN ('customers', 'suppliers', 'invoices')),
  batch_no        INT NOT NULL CHECK (batch_no BETWEEN 1 AND 10000),
  request_sha256  TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  import_batch_id UUID REFERENCES public.import_batches(id),
  rows_in         INT NOT NULL CHECK (rows_in >= 0),
  rows_created    INT NOT NULL CHECK (rows_created >= 0),
  rows_already    INT NOT NULL CHECK (rows_already >= 0),
  result          JSONB NOT NULL,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_source_batches_pkey PRIMARY KEY (organization_id, source_sha256, run_label, entity, batch_no),
  CONSTRAINT import_source_batches_counts CHECK (rows_created + rows_already = rows_in),
  CONSTRAINT import_source_batches_written CHECK ((rows_created = 0) = (import_batch_id IS NULL))
);
ALTER TABLE public.import_source_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_source_batches admin select" ON public.import_source_batches;
CREATE POLICY "import_source_batches admin select" ON public.import_source_batches FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_source_batches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.import_source_batches TO authenticated;

CREATE TABLE IF NOT EXISTS public.import_source_rows (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  entity          TEXT NOT NULL CHECK (entity IN ('customer', 'supplier', 'invoice', 'payment', 'credit_note')),
  source_row_id   TEXT NOT NULL CHECK (length(source_row_id) BETWEEN 1 AND 200),
  source_sha256   TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  run_label       TEXT NOT NULL,
  batch_entity    TEXT NOT NULL,
  batch_no        INT NOT NULL,
  customer_id     UUID REFERENCES public.customers(id) ON DELETE CASCADE,
  supplier_id     UUID REFERENCES public.suppliers(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_id      UUID REFERENCES public.invoice_payments(id) ON DELETE CASCADE,
  credit_note_id  UUID REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_source_rows_pkey PRIMARY KEY (organization_id, entity, source_row_id),
  CONSTRAINT import_source_rows_batch_fkey FOREIGN KEY (organization_id, source_sha256, run_label, batch_entity, batch_no)
    REFERENCES public.import_source_batches (organization_id, source_sha256, run_label, entity, batch_no),
  CONSTRAINT import_source_rows_one_record CHECK (
    num_nonnulls(customer_id, supplier_id, invoice_id, payment_id, credit_note_id) = 1
    AND (entity = 'customer') = (customer_id IS NOT NULL) AND (entity = 'supplier') = (supplier_id IS NOT NULL)
    AND (entity = 'invoice') = (invoice_id IS NOT NULL) AND (entity = 'payment') = (payment_id IS NOT NULL)
    AND (entity = 'credit_note') = (credit_note_id IS NOT NULL)),
  CONSTRAINT import_source_rows_customer_once UNIQUE (customer_id),
  CONSTRAINT import_source_rows_supplier_once UNIQUE (supplier_id),
  CONSTRAINT import_source_rows_invoice_once UNIQUE (invoice_id),
  CONSTRAINT import_source_rows_payment_once UNIQUE (payment_id),
  CONSTRAINT import_source_rows_credit_note_once UNIQUE (credit_note_id)
);
CREATE INDEX IF NOT EXISTS idx_import_source_rows_batch ON public.import_source_rows (organization_id, source_sha256, run_label, batch_entity, batch_no);
ALTER TABLE public.import_source_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "import_source_rows admin select" ON public.import_source_rows;
CREATE POLICY "import_source_rows admin select" ON public.import_source_rows FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
REVOKE ALL ON public.import_source_rows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.import_source_rows TO authenticated;

-- A batch is a record of what was imported: never changed or removed (as 076's import_batches).
CREATE OR REPLACE FUNCTION public.import_source_batches_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'An import batch is a record of what was imported: it can''t be changed or removed.' USING ERRCODE = '42501', HINT = 'import_batch_immutable';
END
$$;
REVOKE ALL ON FUNCTION public.import_source_batches_immutable() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS import_source_batches_immutable ON public.import_source_batches;
CREATE TRIGGER import_source_batches_immutable BEFORE UPDATE OR DELETE ON public.import_source_batches
  FOR EACH ROW EXECUTE FUNCTION public.import_source_batches_immutable();

-- The map and the data can't come apart: a map row names a record of its own company; it is never changed; it is removed only with
-- its record (the ON DELETE CASCADE above runs after the record is gone, so the record no longer exists when this fires).
CREATE OR REPLACE FUNCTION public.import_source_rows_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An import map row can''t be changed.' USING ERRCODE = '42501', HINT = 'import_map_locked';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT x.organization_id INTO v_org FROM (
      SELECT c.organization_id FROM public.customers c WHERE c.id = NEW.customer_id
      UNION ALL SELECT s.organization_id FROM public.suppliers s WHERE s.id = NEW.supplier_id
      UNION ALL SELECT i.organization_id FROM public.invoices i WHERE i.id = NEW.invoice_id
      UNION ALL SELECT p.organization_id FROM public.invoice_payments p WHERE p.id = NEW.payment_id
      UNION ALL SELECT n.organization_id FROM public.credit_notes n WHERE n.id = NEW.credit_note_id) x;
    IF v_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'An import map row must name a record of its own company.' USING ERRCODE = '42501', HINT = 'import_map_other_company';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id)
     OR EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = OLD.supplier_id)
     OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id)
     OR EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.id = OLD.payment_id)
     OR EXISTS (SELECT 1 FROM public.credit_notes n WHERE n.id = OLD.credit_note_id) THEN
    RAISE EXCEPTION 'An import map row goes only with its record: remove the record, not its map row.' USING ERRCODE = '42501', HINT = 'import_map_locked';
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION public.import_source_rows_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS import_source_rows_guard ON public.import_source_rows;
CREATE TRIGGER import_source_rows_guard BEFORE INSERT OR UPDATE OR DELETE ON public.import_source_rows
  FOR EACH ROW EXECUTE FUNCTION public.import_source_rows_guard();

-- Support read-only and admin two-step on both (as 076's tables). Not row-audited (log_row_change needs an id column): every batch is
-- audited by name instead (IMPORT_SOURCE_BATCH, below), and its records by 076's IMPORT_COMMITTED.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_source_batches', 'import_source_rows'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS support_read_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS admin_mfa ON public.%I', t);
    EXECUTE format('CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard()', t);
  END LOOP;
END
$$;

-- ---- 2. Preparing a payload (internal) ------------------------------------------------------------------------------------------
-- Reads { customers, suppliers, invoices, payments } (each record with a source_row_id) into _sliq_in, marks the rows already in the
-- map, records shape problems in _sliq_err, and returns 076's payload of the rows NOT in the map (each with "row" = its place in its
-- section, which is how 076's problems are tied back to the source row id).
CREATE OR REPLACE FUNCTION public.import_sliq_prepare(p_org UUID, p_sha TEXT, p_payload JSONB, p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bad TEXT;
  v_out JSONB;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'The import must be one record of sections.' USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('customers', 'suppliers', 'invoices', 'payments', 'credit_notes');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown section(s): %.', left(v_bad, 200) USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(p_payload) e(k, v) WHERE jsonb_typeof(v) NOT IN ('array', 'null');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Section(s) % must be lists.', v_bad USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;

  DROP TABLE IF EXISTS pg_temp._sliq_in, pg_temp._sliq_err, pg_temp._sliq_warn;
  CREATE TEMP TABLE _sliq_err (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, source_row_id TEXT, field TEXT, message TEXT, code TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _sliq_warn (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, source_row_id TEXT, field TEXT, message TEXT, code TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _sliq_in ON COMMIT DROP AS
  SELECT s.kind, CASE s.kind WHEN 'customers' THEN 'customer' WHEN 'suppliers' THEN 'supplier' WHEN 'invoices' THEN 'invoice'
                             WHEN 'credit_notes' THEN 'credit_note' ELSE 'payment' END AS entity,
         e.ord::INT AS ord, jsonb_typeof(e.v) = 'object' AS obj,
         nullif(btrim(CASE WHEN jsonb_typeof(e.v -> 'source_row_id') IN ('string', 'number') THEN e.v ->> 'source_row_id' END), '') AS source_row_id,
         CASE WHEN jsonb_typeof(e.v) = 'object' THEN e.v - 'source_row_id' - 'row' END AS rec,
         FALSE AS mapped, NULL::TEXT AS mapped_sha, NULL::INT AS pos, NULL::UUID AS mapped_id
  FROM unnest(ARRAY['customers', 'suppliers', 'invoices', 'payments', 'credit_notes']) s(kind)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(p_payload -> s.kind, '[]'::JSONB)) WITH ORDINALITY e(v, ord);

  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT i.kind, i.source_row_id, 'source_row_id',
         CASE WHEN NOT i.obj THEN 'Not a record.'
              WHEN i.source_row_id IS NULL THEN 'Row ' || i.ord || ' has no source row id.'
              ELSE 'The source row id is longer than 200 characters.' END, 'bad_row'
  FROM _sliq_in i WHERE NOT i.obj OR i.source_row_id IS NULL OR length(i.source_row_id) > 200;
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT d.kind, d.source_row_id, 'source_row_id', 'The same source row id is in this file twice.', 'duplicate_row'
  FROM (SELECT i.kind, i.source_row_id, row_number() OVER (PARTITION BY i.entity, i.source_row_id ORDER BY i.ord) AS rn
        FROM _sliq_in i WHERE i.source_row_id IS NOT NULL) d
  WHERE d.rn > 1;

  UPDATE _sliq_in i SET mapped = TRUE, mapped_sha = m.source_sha256,
                        mapped_id = coalesce(m.customer_id, m.supplier_id, m.invoice_id, m.payment_id, m.credit_note_id)
  FROM public.import_source_rows m
  WHERE m.organization_id = p_org AND m.entity = i.entity AND m.source_row_id = i.source_row_id;
  -- Already imported from a DIFFERENT export (another source key): refused. One export, one key; the source row ids of two exports
  -- are not assumed to mean the same rows.
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT i.kind, i.source_row_id, 'source_row_id',
         'Already imported from a different export (source key ' || left(i.mapped_sha, 12) || '...): this file set is not the one that was imported. Nothing was written.',
         'other_source_file'
  FROM _sliq_in i WHERE i.mapped AND i.mapped_sha <> p_sha;
  -- Already imported, but the export says something else now: listed, kept as it is in Tolra (never overwritten).
  INSERT INTO _sliq_warn (kind, source_row_id, field, message, code)
  SELECT i.kind, i.source_row_id, x.field, 'Already imported, but the export now says ' || x.now || ' (Tolra has ' || x.was || '): kept as it is in Tolra.', 'changed_since_import'
  FROM _sliq_in i
  CROSS JOIN LATERAL (
    SELECT 'name' AS field, coalesce(i.rec ->> 'name', '') AS now, c.name AS was FROM public.customers c
      WHERE i.entity = 'customer' AND c.id = i.mapped_id AND public.import_norm_name(c.name) <> public.import_norm_name(coalesce(i.rec ->> 'name', ''))
    UNION ALL SELECT 'name', coalesce(i.rec ->> 'name', ''), s2.name FROM public.suppliers s2
      WHERE i.entity = 'supplier' AND s2.id = i.mapped_id AND public.import_norm_name(s2.name) <> public.import_norm_name(coalesce(i.rec ->> 'name', ''))
    UNION ALL SELECT 'total', coalesce(i.rec ->> 'total', ''), v.total::TEXT FROM public.invoices v
      WHERE i.entity = 'invoice' AND v.id = i.mapped_id AND public.import_num(i.rec ->> 'total') IS DISTINCT FROM v.total
    UNION ALL SELECT 'customer', coalesce(i.rec ->> 'customer', ''), v.customer FROM public.invoices v
      WHERE i.entity = 'invoice' AND v.id = i.mapped_id AND public.import_norm_name(v.customer) <> public.import_norm_name(coalesce(i.rec ->> 'customer', ''))
    UNION ALL SELECT 'amount', coalesce(i.rec ->> 'amount', ''), y.amount::TEXT FROM public.invoice_payments y
      WHERE i.entity = 'payment' AND y.id = i.mapped_id AND public.import_num(i.rec ->> 'amount') IS DISTINCT FROM y.amount
    UNION ALL SELECT 'total', coalesce(i.rec ->> 'total', ''), n.total::TEXT FROM public.credit_notes n
      WHERE i.entity = 'credit_note' AND n.id = i.mapped_id AND public.import_num(i.rec ->> 'total') IS DISTINCT FROM n.total) x
  WHERE i.mapped;
  UPDATE _sliq_in i SET pos = r.n
  FROM (SELECT i2.kind, i2.ord, row_number() OVER (PARTITION BY i2.kind ORDER BY i2.ord)::INT AS n FROM _sliq_in i2 WHERE NOT i2.mapped) r
  WHERE r.kind = i.kind AND r.ord = i.ord;

  SELECT jsonb_build_object('file_name', 'SliQ ' || p_label, 'file_sha256', p_sha)
         || coalesce(jsonb_object_agg(x.kind, x.recs), '{}'::JSONB) INTO v_out
  FROM (SELECT i.kind, jsonb_agg(coalesce(i.rec, '{}'::JSONB) || jsonb_build_object('row', i.pos) ORDER BY i.pos) AS recs
        FROM _sliq_in i WHERE NOT i.mapped GROUP BY i.kind) x;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_prepare(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- After 076 has decided every row (any mode): its problems tied to their source row ids, and every unmapped row 076 would MATCH to a
-- record already in Tolra refused as map_diverged. Reads 076's own temporary tables, which live until the end of the transaction.
CREATE OR REPLACE FUNCTION public.import_sliq_collect(p_run JSONB)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT e ->> 'kind', i.source_row_id, e ->> 'field', e ->> 'message', 'row_problem'
  FROM jsonb_array_elements(coalesce(p_run -> 'errors', '[]'::JSONB)) e
  LEFT JOIN _sliq_in i ON i.kind = e ->> 'kind' AND i.pos = (e ->> 'row')::INT AND NOT i.mapped;
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT m.kind, i.source_row_id, m.field,
         'Already in Tolra but not in this import''s map (the map and the data disagree, or it was keyed by hand): nothing in this batch was written.',
         'map_diverged'
  FROM (SELECT p.kind, p.ord, 'name' AS field FROM pg_temp._imp_parties p WHERE p.action = 'match'
        UNION ALL SELECT 'invoices', v.ord, 'invoice_ref' FROM pg_temp._imp_invoices v WHERE v.action = 'match'
        UNION ALL SELECT 'payments', y.ord, 'invoice_ref' FROM pg_temp._imp_payments y WHERE y.action = 'match'
        UNION ALL SELECT 'credit_notes', n.ord, 'credit_ref' FROM pg_temp._imp_credit_notes n WHERE n.action = 'match') m
  JOIN _sliq_in i ON i.kind = m.kind AND i.pos = m.ord AND NOT i.mapped;
  -- A customer or supplier 076 would CREATE (its account reference is new) whose name Tolra already has: typed by hand, or imported
  -- without this map. Refused and listed, never created a second time.
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT p.kind, i.source_row_id, 'name',
         'Tolra already has ' || CASE p.kind WHEN 'customers' THEN 'customer' ELSE 'supplier' END || ' "' || x.name || '" (not from this import): merge or remove it, or leave this row out. Nothing in this batch was written.',
         'already_in_tolra'
  FROM pg_temp._imp_parties p
  JOIN _sliq_in i ON i.kind = p.kind AND i.pos = p.ord AND NOT i.mapped
  -- (records this same run has just written are not "already in Tolra": in a commit they exist by now, under the run's new ids)
  CROSS JOIN LATERAL (SELECT c.name FROM public.customers c WHERE p.kind = 'customers' AND c.organization_id = current_setting('quoteflow.sliq_org')::UUID
                        AND public.import_norm_name(c.name) = public.import_norm_name(p.name)
                        AND NOT EXISTS (SELECT 1 FROM pg_temp._imp_parties n WHERE n.action = 'create' AND n.new_id = c.id)
                      UNION ALL SELECT s2.name FROM public.suppliers s2 WHERE p.kind = 'suppliers' AND s2.organization_id = current_setting('quoteflow.sliq_org')::UUID
                        AND public.import_norm_name(s2.name) = public.import_norm_name(p.name)
                        AND NOT EXISTS (SELECT 1 FROM pg_temp._imp_parties n WHERE n.action = 'create' AND n.new_id = s2.id) LIMIT 1) x
  WHERE p.action = 'create';
  -- Every invoice names exactly one customer (Tolra's own or one this file creates), by Tolra's name rule: an invoice keeps its
  -- customer as text, so a missing or ambiguous name would put the money on the wrong account.
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT 'invoices', i.source_row_id, 'customer',
         CASE WHEN r.n = 0 THEN 'Customer "' || v.customer || '" is not in Tolra or in this file.'
              ELSE 'Customer "' || v.customer || '" matches ' || r.n || ' customers: the invoice can''t be put on one account.' END,
         'customer_unresolved'
  FROM pg_temp._imp_invoices v
  JOIN _sliq_in i ON i.kind = 'invoices' AND i.pos = v.ord AND NOT i.mapped
  CROSS JOIN LATERAL (SELECT count(*) AS n FROM (
      SELECT c.id::TEXT FROM public.customers c WHERE c.organization_id = current_setting('quoteflow.sliq_org')::UUID
        AND public.import_norm_name(c.name) = public.import_norm_name(v.customer)
        AND NOT EXISTS (SELECT 1 FROM pg_temp._imp_parties n WHERE n.action = 'create' AND n.new_id = c.id)
      UNION SELECT 'new:' || p.ord FROM pg_temp._imp_parties p WHERE p.kind = 'customers' AND p.action = 'create'
        AND public.import_norm_name(p.name) = public.import_norm_name(v.customer)) z) r
  WHERE v.action = 'create' AND v.customer IS NOT NULL AND r.n <> 1;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_collect(JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- Counts per entity and the problems, from _sliq_in / _sliq_err (from_other_file: already imported from a different source file).
CREATE OR REPLACE FUNCTION public.import_sliq_summary(p_sha TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'counts', (SELECT coalesce(jsonb_object_agg(k.kind, jsonb_build_object(
                 'rows', (SELECT count(*) FROM _sliq_in i WHERE i.kind = k.kind),
                 'already_imported', (SELECT count(*) FROM _sliq_in i WHERE i.kind = k.kind AND i.mapped),
                 'from_other_file', (SELECT count(*) FROM _sliq_in i WHERE i.kind = k.kind AND i.mapped AND i.mapped_sha <> p_sha),
                 'to_create', (SELECT count(*) FROM _sliq_in i WHERE i.kind = k.kind AND NOT i.mapped AND NOT EXISTS (SELECT 1 FROM _sliq_err e WHERE e.kind = k.kind AND e.source_row_id = i.source_row_id)),
                 'problems', (SELECT count(DISTINCT e.source_row_id) FROM _sliq_err e WHERE e.kind = k.kind))), '{}'::JSONB)
               FROM unnest(ARRAY['customers', 'suppliers', 'invoices', 'payments', 'credit_notes']) k(kind)),
    'changed_since_import', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'source_row_id', w.source_row_id, 'field', w.field, 'message', w.message, 'code', w.code) ORDER BY w.seq)
                 FILTER (WHERE w.seq <= 1000), '[]'::JSONB) FROM _sliq_warn w),
    'error_count', (SELECT count(*) FROM _sliq_err),
    'errors', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'source_row_id', e.source_row_id, 'field', e.field, 'message', e.message, 'code', e.code) ORDER BY e.seq)
                 FILTER (WHERE e.seq <= 1000), '[]'::JSONB) FROM _sliq_err e));
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_summary(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- The original export's files: [{entity, name, sha256}], one per entity at most. The source key is bound to them: it must equal the
-- SHA-256 of the lines "<entity>:<sha256>" sorted by entity and joined with a newline (lib/sliq-import-route.ts sourceKey), so the
-- per-file hashes recorded in every batch's audit row are the files the key was made from.
CREATE OR REPLACE FUNCTION public.import_sliq_check_files(p_sha TEXT, p_files JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'array' OR jsonb_array_length(p_files) NOT BETWEEN 1 AND 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_files) f
                WHERE jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'entity', '') NOT IN ('customers', 'suppliers', 'invoices', 'payments', 'creditNotes')
                   OR coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$' OR length(coalesce(f ->> 'name', '')) NOT BETWEEN 1 AND 255)
     OR (SELECT count(DISTINCT f ->> 'entity') FROM jsonb_array_elements(p_files) f) <> jsonb_array_length(p_files) THEN
    RAISE EXCEPTION 'Give the source files: entity, name and SHA-256 of each, one per entity.' USING ERRCODE = '22023', HINT = 'bad_source_files';
  END IF;
  IF p_sha IS DISTINCT FROM (SELECT encode(sha256(convert_to(string_agg((f ->> 'entity') || ':' || (f ->> 'sha256'), E'\n' ORDER BY f ->> 'entity'), 'UTF8')), 'hex')
                             FROM jsonb_array_elements(p_files) f) THEN
    RAISE EXCEPTION 'The source key is not the one these files make.' USING ERRCODE = '22023', HINT = 'source_sha_mismatch';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_check_files(TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- What 076's reseed would set the company's counters to (QUO, J, PO, SO, DLN), from what is in Tolra now: the same formulas as 076/085.
-- The preflight uses it so a dry run applies the batch's counter_changed rule.
CREATE OR REPLACE FUNCTION public.import_sliq_counter_moves(p_org UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT string_agg(v.prefix || ' ' || coalesce(dc.last::TEXT, 'none') || ' -> ' || v.n, ', ' ORDER BY v.prefix)
  FROM (SELECT 'QUO' AS prefix, (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org) AS n
        UNION ALL SELECT 'J', GREATEST((SELECT max(substring(j.job_no FROM '^J-(\d{1,9})$')::INT) FROM public.jobs j WHERE j.organization_id = p_org),
                                       (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org))
        UNION ALL SELECT 'PO', GREATEST((SELECT max(substring(po.po_ref FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org),
                                        (SELECT max(substring(po.po_number FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org))
        UNION ALL SELECT 'SO', (SELECT max(substring(so.so_number FROM '^SO-(\d{1,9})$')::INT) FROM public.sales_orders so WHERE so.organization_id = p_org)
        UNION ALL SELECT 'DLN', (SELECT max(substring(dn.dn_number FROM '^DLN-(\d{1,9})$')::INT) FROM public.delivery_notes dn WHERE dn.organization_id = p_org)) v
  LEFT JOIN public.doc_counters dc ON dc.organization_id = p_org AND dc.prefix = v.prefix
  WHERE v.n IS NOT NULL AND v.n > coalesce(dc.last, 0)
$$;
REVOKE ALL ON FUNCTION public.import_sliq_counter_moves(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- An INV-<digits> number to create that is more than p_gap above the nearest lower INV number (in Tolra, or in this call): refused,
-- one problem per row, unless p_allow. The lowest one is measured from the INV counter; in a company with no INV counter and no
-- INV invoice (an empty company) the first number may be at most 100,000. Reads 076's _imp_invoices (rows decided 'create').
-- The same rule in the preflight (whole file) and in each batch: the planner sends invoices in ascending number order
-- (lib/sliq-import-route.ts), so every row's nearest lower number is either in Tolra already or in the same batch.
CREATE OR REPLACE FUNCTION public.import_sliq_check_inv_gap(p_org UUID, p_gap INT, p_allow BOOLEAN, p_inv_counter BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_allow THEN
    RETURN;
  END IF;
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  SELECT 'invoices', i.source_row_id, 'invoice_ref',
         x.invoice_ref || ' is ' || (x.n - x.prev) || ' above ' || CASE WHEN x.prev_src = -1 THEN 'the INV counter (' ELSE 'the nearest lower invoice number (' END || x.prev
         || '): a typo would move the INV counter there for good. Check the number; if it is right, import with the large-gap allowance.', 'inv_gap'
  FROM (SELECT y.*, lag(y.n) OVER (ORDER BY y.n, y.src) AS prev, lag(y.src) OVER (ORDER BY y.n, y.src) AS prev_src
        -- p_inv_counter: the INV counter as it was BEFORE this call (in a commit, 076 has reseeded it by now).
        FROM (SELECT coalesce(p_inv_counter, 0) AS n,
                     -1 AS src, NULL::INT AS ord, NULL::TEXT AS invoice_ref
              UNION ALL
              SELECT substring(v.invoice_ref FROM '^INV-(\d{1,9})$')::BIGINT AS n, 0 AS src, NULL::INT AS ord, NULL::TEXT AS invoice_ref
              FROM public.invoices v WHERE v.organization_id = p_org AND v.invoice_ref ~ '^INV-\d{1,9}$'
                AND NOT EXISTS (SELECT 1 FROM pg_temp._imp_invoices w WHERE w.action = 'create' AND w.new_id = v.id)  -- in a commit, this run's own rows are written by now
              UNION ALL
              SELECT substring(t.invoice_ref FROM '^INV-(\d{1,9})$')::BIGINT, 1, t.ord, t.invoice_ref
              FROM pg_temp._imp_invoices t WHERE t.action = 'create' AND t.invoice_ref ~ '^INV-\d{1,9}$') y) x
  JOIN _sliq_in i ON i.kind = 'invoices' AND i.pos = x.ord AND NOT i.mapped
  WHERE x.src = 1 AND x.prev IS NOT NULL
    AND x.n - x.prev > CASE WHEN x.prev_src = -1 AND x.prev = 0
                                 AND NOT EXISTS (SELECT 1 FROM public.invoices v WHERE v.organization_id = p_org AND v.invoice_ref ~ '^INV-\d{1,9}$'
                                                   AND NOT EXISTS (SELECT 1 FROM pg_temp._imp_invoices w WHERE w.action = 'create' AND w.new_id = v.id))
                            THEN 100000 ELSE p_gap END;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_check_inv_gap(UUID, INT, BOOLEAN, BIGINT) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 3. Preflight: the whole file, nothing written --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_sliq_preflight(p_source_sha256 TEXT, p_source_files JSONB, p_payload JSONB, p_allow_inv_gap BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID := public.import_admin_org();
  v_sha    TEXT := lower(p_source_sha256);
  v_imp    JSONB;
  v_run    JSONB;
  v_out    JSONB;
  v_money  JSONB;
  v_moved  TEXT;
BEGIN
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Give the source file''s SHA-256 (64 hex characters).' USING ERRCODE = '22023', HINT = 'bad_source_sha';
  END IF;
  PERFORM public.import_sliq_check_files(v_sha, p_source_files);
  IF octet_length(p_payload::TEXT) > 4194304
     OR (SELECT coalesce(sum(CASE WHEN jsonb_typeof(v) = 'array' THEN jsonb_array_length(v) ELSE 0 END), 0) FROM jsonb_each(p_payload) e(k, v)) > 6000 THEN
    RAISE EXCEPTION 'The file set is too large for one preflight (at most 6,000 records and 4 MB; JNR is about 4,300): nothing was checked. Split it by date into separate exports.'
      USING ERRCODE = '22023', HINT = 'preflight_too_large';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  PERFORM set_config('quoteflow.sliq_org', v_org::TEXT, TRUE);
  BEGIN
    v_imp := public.import_sliq_prepare(v_org, v_sha, p_payload, 'preflight');
    IF (SELECT count(*) FROM _sliq_in WHERE NOT mapped) > 0 THEN
      PERFORM public.import_check_payload(v_imp);
      v_run := public.import_company_data_run(v_org, v_uid, gen_random_uuid(), jsonb_strip_nulls(v_imp), 'validate', gen_random_uuid(),
                                              repeat('0', 64), NULL, NULL, NULL);
      PERFORM public.import_sliq_collect(v_run);
      PERFORM public.import_sliq_check_inv_gap(v_org, 1000, coalesce(p_allow_inv_gap, FALSE),
        (SELECT dc.last FROM public.doc_counters dc WHERE dc.organization_id = v_org AND dc.prefix = 'INV'));
      -- The batch's counter rule, applied here too: any counter but INV that a commit would move refuses the import.
      v_moved := public.import_sliq_counter_moves(v_org);
      IF v_moved IS NOT NULL THEN
        INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
        VALUES (NULL, NULL, NULL, 'counter_changed: ' || v_moved || ' (records in Tolra are numbered above their counter; this route may only raise INV). Nothing would be imported.', 'counter_changed');
      END IF;
      -- The money, from 076's own figures for the rows it would create, by the app's rule (034): per invoice
      -- greatest(0, total - paid - credited + refunded) (an import has no refunds), void / cancelled / written off / draft excluded,
      -- the excess as customer credit.
      SELECT jsonb_build_object(
               'invoiced', coalesce(sum(v.total) FILTER (WHERE v.action = 'create'), 0),
               'paid', coalesce((SELECT sum(y.amount) FROM pg_temp._imp_payments y WHERE y.action = 'create'), 0),
               'credited', coalesce((SELECT sum(n.total) FROM pg_temp._imp_credit_notes n WHERE n.action = 'create'), 0),
               'owed', coalesce(sum(greatest(0, v.total - v.paid - v.credited)) FILTER (WHERE v.action = 'create' AND v.status NOT IN ('void', 'cancelled', 'written_off', 'draft')), 0),
               'customer_credit', coalesce(sum(greatest(0, v.paid + v.credited - v.total)) FILTER (WHERE v.action = 'create' AND v.status NOT IN ('void', 'cancelled', 'written_off', 'draft')), 0),
               'excluded_invoices', count(*) FILTER (WHERE v.action = 'create' AND v.status IN ('void', 'cancelled', 'written_off', 'draft')),
               'payment_to_confirm', count(*) FILTER (WHERE v.action = 'create' AND v.payment_unverified))
        INTO v_money FROM pg_temp._imp_invoices v;
    END IF;
    v_out := public.import_sliq_summary(v_sha) || jsonb_build_object('money', coalesce(v_money, jsonb_build_object('invoiced', 0, 'paid', 0, 'credited', 0, 'owed', 0, 'customer_credit', 0, 'excluded_invoices', 0, 'payment_to_confirm', 0)),
                                                                 'doc_counters_note', 'counters only rise (GREATEST); invoice numbers are kept as written',
                                                                 'warnings', coalesce(v_run -> 'warnings', '[]'::JSONB));
    RAISE EXCEPTION 'preflight rolled back' USING ERRCODE = 'QI152';
  EXCEPTION
    WHEN SQLSTATE 'QI152' THEN NULL;
  END;
  RETURN jsonb_build_object('ok', (v_out ->> 'error_count')::INT = 0, 'dry_run', TRUE, 'preflight', TRUE, 'source_sha256', v_sha, 'source_files', p_source_files) || v_out;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_preflight(TEXT, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_sliq_preflight(TEXT, JSONB, JSONB, BOOLEAN) TO authenticated;

-- ---- 4. One batch: one transaction ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_sliq_batch(p_source_sha256 TEXT, p_source_files JSONB, p_run_label TEXT, p_entity TEXT, p_batch_no INT, p_rows JSONB, p_dry_run BOOLEAN,
                                                    p_allow_inv_gap BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_org     UUID := public.import_admin_org();
  v_sha     TEXT := lower(p_source_sha256);
  v_request TEXT;
  v_prior   public.import_source_batches%ROWTYPE;
  v_left    INT;
  v_batch   UUID := gen_random_uuid();
  v_op      UUID;
  v_imp     JSONB;
  v_run     JSONB;
  v_sum     JSONB;
  v_result  JSONB;
  v_in      INT;
  v_already INT;
  v_created INT;
  v_n       INT;
  v_lines   INT;
  v_before  JSONB;
  v_moved   TEXT;
BEGIN
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Give the source file''s SHA-256 (64 hex characters).' USING ERRCODE = '22023', HINT = 'bad_source_sha';
  END IF;
  IF p_run_label IS NULL OR p_run_label !~ '^[a-z0-9][a-z0-9-]{0,39}$' THEN
    RAISE EXCEPTION 'The run label is lower-case letters, digits and hyphens (at most 40).' USING ERRCODE = '22023', HINT = 'bad_run_label';
  END IF;
  PERFORM public.import_sliq_check_files(v_sha, p_source_files);
  IF p_entity IS NULL OR p_entity NOT IN ('customers', 'suppliers', 'invoices') OR p_batch_no IS NULL OR p_batch_no NOT BETWEEN 1 AND 10000 OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'A batch is customers, suppliers or invoices, numbered 1 to 10000, and says whether it is a dry run.' USING ERRCODE = '22023', HINT = 'bad_request';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_rows) k WHERE k <> p_entity AND NOT (p_entity = 'invoices' AND k IN ('payments', 'credit_notes'))) THEN
    RAISE EXCEPTION 'A % batch carries only %.', p_entity, CASE p_entity WHEN 'invoices' THEN 'invoices and their payments and credit notes' ELSE p_entity END
      USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT coalesce(sum(CASE WHEN jsonb_typeof(v) = 'array' THEN jsonb_array_length(v) ELSE 0 END), 0) INTO v_in FROM jsonb_each(p_rows) e(k, v);
  SELECT coalesce(sum(CASE WHEN jsonb_typeof(r -> 'lines') = 'array' THEN jsonb_array_length(r -> 'lines') ELSE 0 END), 0) INTO v_lines
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows -> 'invoices') = 'array' THEN p_rows -> 'invoices' ELSE '[]'::JSONB END) r;
  IF v_in = 0 OR v_in > 2000 OR v_lines > 4000 THEN
    RAISE EXCEPTION 'A batch has 1 to 2,000 records and at most 4,000 lines (this one: % records, % lines).', v_in, v_lines USING ERRCODE = '22023', HINT = 'batch_size';
  END IF;
  v_request := encode(sha256(convert_to(p_rows::TEXT, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));

  -- A batch already committed: the first answer, unless its records were removed since (loud) or the rows differ (refused).
  SELECT * INTO v_prior FROM public.import_source_batches b
  WHERE b.organization_id = v_org AND b.source_sha256 = v_sha AND b.run_label = p_run_label AND b.entity = p_entity AND b.batch_no = p_batch_no;
  IF FOUND THEN
    IF v_prior.request_sha256 <> v_request THEN
      RAISE EXCEPTION 'Batch % of % in run "%" was already imported with different rows: nothing was written.', p_batch_no, p_entity, p_run_label
        USING ERRCODE = '22023', HINT = 'batch_reused';
    END IF;
    SELECT count(*) INTO v_left FROM public.import_source_rows m
    WHERE m.organization_id = v_org AND m.source_sha256 = v_sha AND m.run_label = p_run_label AND m.batch_entity = p_entity AND m.batch_no = p_batch_no;
    IF v_left <> v_prior.rows_created THEN
      RAISE EXCEPTION 'Batch % of % in run "%" was imported, but % of its % records have since been removed: nothing was written. Start a new run label to import them again.',
        p_batch_no, p_entity, p_run_label, v_prior.rows_created - v_left, v_prior.rows_created USING ERRCODE = '22023', HINT = 'records_removed';
    END IF;
    RETURN v_prior.result || jsonb_build_object('already_imported', TRUE, 'replayed', TRUE);
  END IF;

  PERFORM set_config('quoteflow.sliq_org', v_org::TEXT, TRUE);
  SELECT coalesce(jsonb_object_agg(dc.prefix, dc.last), '{}'::JSONB) INTO v_before FROM public.doc_counters dc WHERE dc.organization_id = v_org;
  BEGIN
    v_imp := public.import_sliq_prepare(v_org, v_sha, p_rows, p_run_label || ' ' || p_entity || ' batch ' || p_batch_no);
    SELECT count(*) FILTER (WHERE mapped), count(*) FILTER (WHERE NOT mapped) INTO v_already, v_created FROM _sliq_in;
    IF v_created > 0 THEN
      PERFORM public.import_check_payload(v_imp);
      v_op := md5(v_org::TEXT || '|' || v_sha || '|' || p_run_label || '|' || p_entity || '|' || p_batch_no)::UUID;
      v_run := public.import_company_data_run(v_org, v_uid, v_batch, jsonb_strip_nulls(v_imp), CASE WHEN p_dry_run THEN 'dry_run' ELSE 'commit' END,
                                              v_op, v_request, NULL, NULL, NULL);
      PERFORM public.import_sliq_collect(v_run);
      PERFORM public.import_sliq_check_inv_gap(v_org, 1000, coalesce(p_allow_inv_gap, FALSE), (v_before ->> 'INV')::BIGINT);
    END IF;
    v_sum := public.import_sliq_summary(v_sha);
    v_result := jsonb_build_object('ok', (v_sum ->> 'error_count')::INT = 0, 'dry_run', p_dry_run, 'committed', FALSE, 'already_imported', v_created = 0,
                                   'source_sha256', v_sha, 'source_files', p_source_files, 'run_label', p_run_label, 'entity', p_entity, 'batch_no', p_batch_no,
                                   'rows', v_in, 'created', CASE WHEN (v_sum ->> 'error_count')::INT = 0 THEN v_created ELSE 0 END, 'skipped_already_imported', v_already,
                                   'import_batch_id', CASE WHEN v_created > 0 AND NOT p_dry_run THEN v_batch END,
                                   'doc_counters', v_run -> 'doc_counters', 'records', v_run -> 'counts',
                                   'warning_count', coalesce((v_run ->> 'warning_count')::INT, 0), 'warnings', coalesce(v_run -> 'warnings', '[]'::JSONB))
                || v_sum;
    IF p_dry_run OR NOT (v_result ->> 'ok')::BOOLEAN THEN
      RAISE EXCEPTION 'batch rolled back' USING ERRCODE = 'QI152';
    END IF;

    -- Counters: only INV may move (and only up); any other counter moving refuses the whole batch.
    SELECT string_agg(coalesce(a.prefix, b.key) || ' ' || coalesce(b.value, 'none') || ' -> ' || coalesce(a.last::TEXT, 'none'), ', ') INTO v_moved
    FROM (SELECT dc.prefix, dc.last FROM public.doc_counters dc WHERE dc.organization_id = v_org) a
    FULL JOIN jsonb_each_text(v_before) b ON b.key = a.prefix
    WHERE (coalesce(a.prefix, b.key) <> 'INV' AND a.last::TEXT IS DISTINCT FROM b.value)
       OR (coalesce(a.prefix, b.key) = 'INV' AND (a.last IS NULL OR (b.value IS NOT NULL AND a.last < b.value::BIGINT)));
    IF v_moved IS NOT NULL THEN
      RAISE EXCEPTION 'import_sliq_batch: counter_changed: % (this route may only raise INV)', v_moved;
    END IF;

    -- The batch and its map rows, in this transaction.
    v_result := v_result || jsonb_build_object('committed', TRUE);
    INSERT INTO public.import_source_batches (organization_id, source_sha256, run_label, entity, batch_no, request_sha256, import_batch_id,
                                              rows_in, rows_created, rows_already, result, created_by)
    VALUES (v_org, v_sha, p_run_label, p_entity, p_batch_no, v_request, CASE WHEN v_created > 0 THEN v_batch END,
            v_in, v_created, v_already, v_result, v_uid);
    IF v_created > 0 THEN
      INSERT INTO public.import_source_rows (organization_id, entity, source_row_id, source_sha256, run_label, batch_entity, batch_no,
                                             customer_id, supplier_id, invoice_id, payment_id, credit_note_id)
      SELECT v_org, i.entity, i.source_row_id, v_sha, p_run_label, p_entity, p_batch_no,
             CASE WHEN i.entity = 'customer' THEN r.new_id END, CASE WHEN i.entity = 'supplier' THEN r.new_id END,
             CASE WHEN i.entity = 'invoice' THEN r.new_id END, CASE WHEN i.entity = 'payment' THEN r.new_id END,
             CASE WHEN i.entity = 'credit_note' THEN r.new_id END
      FROM _sliq_in i
      JOIN (SELECT p.kind, p.ord, p.new_id FROM pg_temp._imp_parties p WHERE p.action = 'create'
            UNION ALL SELECT 'invoices', v.ord, v.new_id FROM pg_temp._imp_invoices v WHERE v.action = 'create'
            UNION ALL SELECT 'payments', y.ord, y.new_id FROM pg_temp._imp_payments y WHERE y.action = 'create'
            UNION ALL SELECT 'credit_notes', n.ord, n.new_id FROM pg_temp._imp_credit_notes n WHERE n.action = 'create') r ON r.kind = i.kind AND r.ord = i.pos
      WHERE NOT i.mapped;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> v_created THEN
        RAISE EXCEPTION 'import_sliq_batch: % map rows written, % expected', v_n, v_created;
      END IF;
      -- Balances: every invoice this batch created is paid exactly the sum of its payments, and never more than its total.
      IF EXISTS (SELECT 1 FROM public.invoices v
                 JOIN public.import_source_rows m ON m.invoice_id = v.id AND m.organization_id = v_org AND m.source_sha256 = v_sha
                  AND m.run_label = p_run_label AND m.batch_entity = p_entity AND m.batch_no = p_batch_no
                 WHERE coalesce(v.amount_paid, 0) <> coalesce((SELECT sum(p.amount) FROM public.invoice_payments p WHERE p.invoice_id = v.id), 0)
                    OR coalesce(v.credited_amount, 0) <> coalesce((SELECT sum(a.amount) FROM public.invoice_credit_allocations a WHERE a.invoice_id = v.id), 0)
                    OR coalesce(v.amount_paid, 0) + coalesce(v.credited_amount, 0) > v.total) THEN
        RAISE EXCEPTION 'import_sliq_batch: an invoice''s paid or credited amount differs from its payments or credit allocations, or exceeds its total';
      END IF;
    END IF;
    PERFORM security_audit.log_named_event(v_org, 'IMPORT_SOURCE_BATCH', 'import_source_batches',
      v_sha || '/' || p_run_label || '/' || p_entity || '/' || p_batch_no,
      jsonb_build_object('source_sha256', v_sha, 'source_files', p_source_files, 'run_label', p_run_label, 'entity', p_entity, 'batch_no', p_batch_no, 'rows', v_in,
                         'created', v_created, 'already_imported', v_already, 'import_batch_id', CASE WHEN v_created > 0 THEN v_batch END));
  EXCEPTION
    WHEN SQLSTATE 'QI152' THEN NULL;
    WHEN SQLSTATE '22023' THEN RAISE;
    WHEN OTHERS THEN
      v_result := jsonb_build_object('ok', FALSE, 'dry_run', p_dry_run, 'committed', FALSE, 'already_imported', FALSE, 'source_sha256', v_sha,
                                     'run_label', p_run_label, 'entity', p_entity, 'batch_no', p_batch_no, 'rows', v_in, 'created', 0,
                                     'error_count', 1, 'errors', jsonb_build_array(jsonb_build_object('kind', NULL, 'source_row_id', NULL, 'field', NULL, 'code', SQLSTATE,
                                       'message', 'The database refused the batch, so nothing in it was written: ' || left(SQLERRM, 500))));
  END;
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_batch(TEXT, JSONB, TEXT, TEXT, INT, JSONB, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_sliq_batch(TEXT, JSONB, TEXT, TEXT, INT, JSONB, BOOLEAN, BOOLEAN) TO authenticated;

-- ---- 5. Reconciliation rows (read only) ------------------------------------------------------------------------------------------
-- The metric rows lib/sliq-reconcile compares with the validator's source totals. One definition, two callers: the browser card
-- (import_sliq_reconcile, the session's company, admins) and supabase/verify/sliq_reconcile.sql in the SQL editor (as the owner, for a
-- named company). Outstanding as the app (034); customers keyed by the import map's account code, else name; refuses an unknown company.
CREATE OR REPLACE FUNCTION public.import_sliq_reconcile_rows(p_org UUID)
RETURNS TABLE (metric TEXT, key TEXT, value TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_org IS NULL OR p_org = '00000000-0000-0000-0000-000000000000'::UUID THEN
    RAISE EXCEPTION 'Replace the organisation id placeholder first.' USING ERRCODE = '22023', HINT = 'org_placeholder';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'No company has the organisation id %.', p_org USING ERRCODE = '22023', HINT = 'org_unknown';
  END IF;
  RETURN QUERY
  WITH p0 AS (
    SELECT p_org AS org
  ),
  p AS (
    SELECT p0.org FROM p0
  ),
  inv AS (
    SELECT i.id, i.invoice_ref, i.customer, i.total, i.credited_amount, i.amount_paid, i.refunded_amount,
           lower(coalesce(i.status, 'draft')) IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'written_off') AS excluded
    FROM public.invoices i JOIN p ON i.organization_id = p.org
  ),
  pay AS (
    SELECT x.id, x.invoice_id, x.amount, x.paid_on, x.reference
    FROM public.invoice_payments x JOIN p ON x.organization_id = p.org
  ),
  paid AS (
    SELECT invoice_id, sum(amount) AS paid FROM pay GROUP BY invoice_id
  ),
  inv_bal AS (
    SELECT i.id, i.invoice_ref, i.customer, i.excluded,
           round(coalesce(i.total, 0) / 0.01)::bigint AS total_p,
           coalesce(round(pd.paid / 0.01), 0)::bigint AS paid_p,
           round(coalesce(i.credited_amount, 0) / 0.01)::bigint AS credit_p,
           round(coalesce(i.refunded_amount, 0) / 0.01)::bigint AS refund_p
    FROM inv i LEFT JOIN paid pd ON pd.invoice_id = i.id
  ),
  -- The app's balance (034): per live invoice greatest(0, total - paid - credited + refunded); the excess is customer credit.
  inv_due AS (
    SELECT b.*, (b.total_p - b.paid_p - b.credit_p + b.refund_p) AS left_p FROM inv_bal b WHERE NOT b.excluded
  ),
  cust AS (
    SELECT c.id, c.name, c.email FROM public.customers c JOIN p ON c.organization_id = p.org
  ),
  -- The customer each invoice is on, by Tolra's name rule; its key is the account code the import map holds ("acct:"), else the name.
  -- An invoice that names no customer or several gets "unresolved:" and so can never match a source balance.
  cust_key AS (
    SELECT c.id, public.import_norm_name(c.name) AS nn,
           coalesce('acct:' || upper(substr((SELECT m.source_row_id FROM public.import_source_rows m WHERE m.customer_id = c.id AND m.entity = 'customer'), 3)),
                    'name:' || public.import_norm_name(c.name)) AS k
    FROM cust c
  ),
  inv_key AS (
    SELECT d.id, CASE WHEN (SELECT count(1) FROM cust_key ck WHERE ck.nn = public.import_norm_name(d.customer)) = 1
                      THEN (SELECT ck.k FROM cust_key ck WHERE ck.nn = public.import_norm_name(d.customer))
                      ELSE 'unresolved:' || lower(btrim(coalesce(d.customer, ''))) END AS k
    FROM inv_due d
  ),
  refs AS (
    SELECT invoice_ref,
           substring(invoice_ref FROM '^INV-(\d{1,9})$')::int AS n
    FROM inv
  ),
  dup_cust_name AS (
    SELECT lower(btrim(name)) AS k, count(1) AS n FROM cust GROUP BY 1 HAVING count(1) > 1
  ),
  dup_cust_email AS (
    SELECT lower(btrim(email)) AS k, count(1) AS n FROM cust
    WHERE email IS NOT NULL AND btrim(email) <> '' GROUP BY 1 HAVING count(1) > 1
  ),
  dup_inv_ref AS (
    SELECT invoice_ref AS k, count(1) AS n FROM inv GROUP BY 1 HAVING count(1) > 1
  ),
  -- The same payment twice: same invoice, date, amount AND reference (the receipt key). Two receipts of the same amount on the same day
  -- with different references are a legitimate split, not a duplicate.
  dup_pay AS (
    SELECT x.invoice_id::text || '|' || coalesce(x.paid_on::text, 'none') || '|' || round(x.amount / 0.01)::bigint::text || '|' || coalesce(x.reference, '') AS k,
           count(1) AS n
    FROM pay x GROUP BY x.invoice_id, x.paid_on, round(x.amount / 0.01), coalesce(x.reference, '') HAVING count(1) > 1
  ),
  orphan AS (
    SELECT x.id FROM pay x LEFT JOIN inv i ON i.id = x.invoice_id WHERE i.id IS NULL
  ),
  overpaid AS (
    SELECT invoice_ref, total_p, paid_p, credit_p FROM inv_bal WHERE paid_p + credit_p > total_p
  )
  SELECT metric, key, value FROM (
    SELECT 1 AS o, 'count' AS metric, 'customers' AS key, (SELECT count(1) FROM cust)::text AS value
    UNION ALL SELECT 1, 'count', 'invoices', (SELECT count(1) FROM inv)::text
    UNION ALL SELECT 1, 'count', 'payments', (SELECT count(1) FROM pay)::text
    UNION ALL SELECT 1, 'count', 'credit_notes',
      (SELECT count(1) FROM public.credit_notes c JOIN p ON c.organization_id = p.org)::text
    UNION ALL SELECT 2, 'total_pence', 'invoiced', (SELECT coalesce(sum(total_p), 0) FROM inv_bal)::text
    UNION ALL SELECT 2, 'total_pence', 'paid', (SELECT coalesce(sum(paid_p), 0) FROM inv_bal)::text
    UNION ALL SELECT 2, 'total_pence', 'credits', (SELECT coalesce(sum(credit_p), 0) FROM inv_bal)::text
    UNION ALL SELECT 2, 'total_pence', 'refunds', (SELECT coalesce(sum(refund_p), 0) FROM inv_bal)::text
    UNION ALL SELECT 2, 'total_pence', 'outstanding', (SELECT coalesce(sum(greatest(0, left_p)), 0) FROM inv_due)::text
    UNION ALL SELECT 2, 'total_pence', 'customer_credit', (SELECT coalesce(sum(greatest(0, -left_p)), 0) FROM inv_due)::text
    UNION ALL SELECT 2, 'total_pence', 'net_live', (SELECT coalesce(sum(left_p), 0) FROM inv_due)::text
    UNION ALL SELECT 2, 'excluded_invoices', 'count', (SELECT count(1) FROM inv_bal WHERE excluded)::text
    UNION ALL SELECT 3, 'customer_outstanding_pence', k.k, sum(d.left_p)::text
      FROM inv_due d JOIN inv_key k ON k.id = d.id GROUP BY k.k
    UNION ALL SELECT 4, 'invoice_ref', 'min_number', (SELECT min(n) FROM refs)::text
    UNION ALL SELECT 4, 'invoice_ref', 'max_number', (SELECT max(n) FROM refs)::text
    UNION ALL SELECT 4, 'invoice_ref', 'not_INV_format', (SELECT count(1) FROM refs WHERE n IS NULL)::text
    UNION ALL SELECT 5, 'counter_last', d.prefix, d.last::text
      FROM public.doc_counters d JOIN p ON d.organization_id = p.org
    UNION ALL SELECT 6, 'dup_customer_name', 'groups', (SELECT count(1) FROM dup_cust_name)::text
    UNION ALL SELECT 6, 'dup_customer_name_detail', k, n::text FROM dup_cust_name
    UNION ALL SELECT 6, 'dup_customer_email', 'groups', (SELECT count(1) FROM dup_cust_email)::text
    UNION ALL SELECT 6, 'dup_customer_email_detail', k, n::text FROM dup_cust_email
    UNION ALL SELECT 6, 'dup_invoice_ref', 'groups', (SELECT count(1) FROM dup_inv_ref)::text
    UNION ALL SELECT 6, 'dup_invoice_ref_detail', k, n::text FROM dup_inv_ref
    UNION ALL SELECT 6, 'dup_payment', 'groups', (SELECT count(1) FROM dup_pay)::text
    UNION ALL SELECT 6, 'dup_payment_detail', k, n::text FROM dup_pay
    UNION ALL SELECT 7, 'orphan_payments', 'count', (SELECT count(1) FROM orphan)::text
    UNION ALL SELECT 8, 'overpaid_invoices', 'count', (SELECT count(1) FROM overpaid)::text
    UNION ALL SELECT 8, 'overpaid_invoices_detail', invoice_ref,
      (paid_p + credit_p - total_p)::text FROM overpaid
  ) r
  ORDER BY o, metric, key;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_reconcile_rows(UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.import_sliq_reconcile()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.import_admin_org();
BEGIN
  RETURN jsonb_build_object('rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('metric', r.metric, 'key', r.key, 'value', r.value)), '[]'::JSONB)
                                     FROM public.import_sliq_reconcile_rows(v_org) r));
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_reconcile() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_sliq_reconcile() TO authenticated;

DO $self_check$ BEGIN
  IF NOT has_function_privilege('authenticated', 'public.import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.import_sliq_prepare(uuid,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '152 self-check: function grants are not as designed';
  END IF;
  IF has_table_privilege('authenticated', 'public.import_source_rows', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '152 self-check: the import map must not be writable through the API';
  END IF;
END $self_check$;
COMMIT;
