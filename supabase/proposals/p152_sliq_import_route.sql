-- =====================================================================================================
-- p152: the SliQ go-live import route (Admin > Data import > SliQ go-live import). PROPOSAL: not applied anywhere hosted, not registered
-- in supabase/release-plan.json, never run on production. Builds on 076 (as replaced by 079 and 085): every row check, match rule,
-- payment rule and counter rule is 076's import_company_data_run, called unchanged. This adds only what a repeatable, browser-driven
-- go-live load needs on top of it.
--
-- Why. Gates D1 / C1 (state-machines/IMPORT-REPLAY-ASSESSMENT.md): the rehearsal tool (scripts/sliq-import) can never write
-- production by design; 076's one-call import is cut off at 8 s for JNR's size; the owner-only wrapper was never built; and two replay
-- cases went wrong silently (map kept and data wiped: nothing imported, reported ok; map lost and data kept: customers and suppliers
-- duplicated). This route runs in the browser, signed in, as an admin of the session's company (same MFA, support and role rules as
-- 076: import_admin_org), in batches small enough for the 8 s limit, each batch one transaction.
--
-- 1. import_source_batches: one row per committed SliQ batch, keyed (company, source file SHA-256, run label, entity, batch number).
--    Never changed or removed. A re-run of the same key with the same rows answers the first result with already_imported = TRUE and
--    the same counts; the same key with different rows is refused (batch_reused); the same key whose records have since been removed
--    (a wipe) is refused loudly (records_removed), never a silent "ok": a new run label starts a fresh run.
-- 2. import_source_rows: the import map, one row per imported source row (customer, supplier, invoice, payment), keyed (company,
--    entity, source row id) with the source file SHA-256 and the batch that wrote it. Its record is a FOREIGN KEY with ON DELETE
--    CASCADE (one column per entity, exactly one set), so the map row goes with its record: a wipe of the data wipes its map, and a
--    replay after a wipe imports again instead of doing nothing. A map row can't be changed, and can't be removed while its record
--    exists (import_source_rows_guard). Written in the SAME transaction as the records (the batch function), never on its own.
-- 3. Map lost, data kept (or a record keyed by hand): before writing, every row NOT in the map that 076 would match to a record already
--    in Tolra (same customer or supplier name or reference, same invoice number, same payment) is refused (map_diverged), and nothing
--    in the batch is written. Nothing is ever matched silently, so nothing is duplicated and nothing is skipped without a reason.
-- 4. import_sliq_preflight(source_sha256, payload): the WHOLE file, checked at once, writes nothing (076's 'validate' mode inside a
--    rolled-back sub-block). Returns per-entity counts (rows, already imported, to create, problems), every problem with its source row
--    id, and the money: invoiced, paid (sum of payments), owed; any invoice whose payments exceed its total is a problem.
-- 5. import_sliq_batch(source_sha256, run_label, entity, batch_no, rows, dry_run): one batch, one transaction. entity is customers,
--    suppliers or invoices (an invoices batch carries its invoices' payments: 076 writes a payment only with its invoice, and sets
--    amount_paid to the sum of them). At most 2,000 records and 4,000 lines per call. Rows already in the map are skipped and counted
--    already_imported. Numbering: invoice numbers are kept as written; 076 reseeds doc_counters with GREATEST (never lower, never a
--    number invented); a number already in Tolra is refused (076 with different content; this route with the same content but no map
--    row). After the write, in the same transaction: every map row is checked against its record, and every created invoice's
--    amount_paid against the sum of its payments; any difference raises and the whole batch is rolled back. A dry run, a problem or an
--    unexpected error rolls back everything; a cancelled call (statement_timeout, a killed connection) is not caught and rolls back
--    the whole transaction. Audited: 076's IMPORT_COMMITTED for the records, plus IMPORT_SOURCE_BATCH (this table, key, counts) per
--    committed or already-imported batch.
-- 6. Locking: the same advisory lock as 076 (one import per company at a time).
-- 7. The original files: every call names them ([{entity, name, sha256}]); the source key must be the SHA-256 of the sorted lines
--    "<entity>:<sha256>" (import_sliq_check_files), and every batch's IMPORT_SOURCE_BATCH audit row records them.
--
-- Additive: two tables, two callable SECURITY DEFINER functions (signed-in admins), four internal functions, two trigger functions. Rollback:
-- supabase/release/152_sliq_import_route.rollback.sql. Verify: supabase/verify/sliq_import_route_152.sql (every row TRUE).
-- =====================================================================================================

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
  entity          TEXT NOT NULL CHECK (entity IN ('customer', 'supplier', 'invoice', 'payment')),
  source_row_id   TEXT NOT NULL CHECK (length(source_row_id) BETWEEN 1 AND 200),
  source_sha256   TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  run_label       TEXT NOT NULL,
  batch_entity    TEXT NOT NULL,
  batch_no        INT NOT NULL,
  customer_id     UUID REFERENCES public.customers(id) ON DELETE CASCADE,
  supplier_id     UUID REFERENCES public.suppliers(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_id      UUID REFERENCES public.invoice_payments(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_source_rows_pkey PRIMARY KEY (organization_id, entity, source_row_id),
  CONSTRAINT import_source_rows_batch_fkey FOREIGN KEY (organization_id, source_sha256, run_label, batch_entity, batch_no)
    REFERENCES public.import_source_batches (organization_id, source_sha256, run_label, entity, batch_no),
  CONSTRAINT import_source_rows_one_record CHECK (
    num_nonnulls(customer_id, supplier_id, invoice_id, payment_id) = 1
    AND (entity = 'customer') = (customer_id IS NOT NULL) AND (entity = 'supplier') = (supplier_id IS NOT NULL)
    AND (entity = 'invoice') = (invoice_id IS NOT NULL) AND (entity = 'payment') = (payment_id IS NOT NULL)),
  CONSTRAINT import_source_rows_customer_once UNIQUE (customer_id),
  CONSTRAINT import_source_rows_supplier_once UNIQUE (supplier_id),
  CONSTRAINT import_source_rows_invoice_once UNIQUE (invoice_id),
  CONSTRAINT import_source_rows_payment_once UNIQUE (payment_id)
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
      UNION ALL SELECT p.organization_id FROM public.invoice_payments p WHERE p.id = NEW.payment_id) x;
    IF v_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'An import map row must name a record of its own company.' USING ERRCODE = '42501', HINT = 'import_map_other_company';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id)
     OR EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = OLD.supplier_id)
     OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id)
     OR EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.id = OLD.payment_id) THEN
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
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('customers', 'suppliers', 'invoices', 'payments');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown section(s): %.', left(v_bad, 200) USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_each(p_payload) e(k, v) WHERE jsonb_typeof(v) NOT IN ('array', 'null');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Section(s) % must be lists.', v_bad USING ERRCODE = '22023', HINT = 'bad_payload';
  END IF;

  DROP TABLE IF EXISTS pg_temp._sliq_in, pg_temp._sliq_err;
  CREATE TEMP TABLE _sliq_err (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, source_row_id TEXT, field TEXT, message TEXT, code TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _sliq_in ON COMMIT DROP AS
  SELECT s.kind, CASE s.kind WHEN 'customers' THEN 'customer' WHEN 'suppliers' THEN 'supplier' WHEN 'invoices' THEN 'invoice' ELSE 'payment' END AS entity,
         e.ord::INT AS ord, jsonb_typeof(e.v) = 'object' AS obj,
         nullif(btrim(CASE WHEN jsonb_typeof(e.v -> 'source_row_id') IN ('string', 'number') THEN e.v ->> 'source_row_id' END), '') AS source_row_id,
         CASE WHEN jsonb_typeof(e.v) = 'object' THEN e.v - 'source_row_id' - 'row' END AS rec,
         FALSE AS mapped, NULL::TEXT AS mapped_sha, NULL::INT AS pos
  FROM unnest(ARRAY['customers', 'suppliers', 'invoices', 'payments']) s(kind)
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

  UPDATE _sliq_in i SET mapped = TRUE, mapped_sha = m.source_sha256
  FROM public.import_source_rows m
  WHERE m.organization_id = p_org AND m.entity = i.entity AND m.source_row_id = i.source_row_id;
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
        UNION ALL SELECT 'payments', y.ord, 'invoice_ref' FROM pg_temp._imp_payments y WHERE y.action = 'match') m
  JOIN _sliq_in i ON i.kind = m.kind AND i.pos = m.ord AND NOT i.mapped;
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
               FROM unnest(ARRAY['customers', 'suppliers', 'invoices', 'payments']) k(kind)),
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
                WHERE jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'entity', '') NOT IN ('customers', 'suppliers', 'invoices', 'payments')
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

-- ---- 3. Preflight: the whole file, nothing written --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_sliq_preflight(p_source_sha256 TEXT, p_source_files JSONB, p_payload JSONB)
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
BEGIN
  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Give the source file''s SHA-256 (64 hex characters).' USING ERRCODE = '22023', HINT = 'bad_source_sha';
  END IF;
  PERFORM public.import_sliq_check_files(v_sha, p_source_files);
  PERFORM pg_advisory_xact_lock(hashtext('import_company_data'), hashtext(v_org::TEXT));
  BEGIN
    v_imp := public.import_sliq_prepare(v_org, v_sha, p_payload, 'preflight');
    IF (SELECT count(*) FROM _sliq_in WHERE NOT mapped) > 0 THEN
      PERFORM public.import_check_payload(v_imp);
      v_run := public.import_company_data_run(v_org, v_uid, gen_random_uuid(), jsonb_strip_nulls(v_imp), 'validate', gen_random_uuid(),
                                              repeat('0', 64), NULL, NULL, NULL);
      PERFORM public.import_sliq_collect(v_run);
      -- The money, from 076's own figures for the rows it would create.
      SELECT jsonb_build_object(
               'invoiced', coalesce(sum(v.total) FILTER (WHERE v.action = 'create'), 0),
               'paid', coalesce((SELECT sum(y.amount) FROM pg_temp._imp_payments y WHERE y.action = 'create'), 0),
               'owed', coalesce(sum(v.total - v.paid) FILTER (WHERE v.action = 'create' AND v.status NOT IN ('void', 'cancelled', 'written_off') AND NOT v.payment_unverified), 0),
               'payment_to_confirm', count(*) FILTER (WHERE v.action = 'create' AND v.payment_unverified))
        INTO v_money FROM pg_temp._imp_invoices v;
    END IF;
    v_out := public.import_sliq_summary(v_sha) || jsonb_build_object('money', coalesce(v_money, jsonb_build_object('invoiced', 0, 'paid', 0, 'owed', 0, 'payment_to_confirm', 0)),
                                                                 'doc_counters_note', 'counters only rise (GREATEST); invoice numbers are kept as written',
                                                                 'warnings', coalesce(v_run -> 'warnings', '[]'::JSONB));
    RAISE EXCEPTION 'preflight rolled back' USING ERRCODE = 'QI152';
  EXCEPTION
    WHEN SQLSTATE 'QI152' THEN NULL;
  END;
  RETURN jsonb_build_object('ok', (v_out ->> 'error_count')::INT = 0, 'dry_run', TRUE, 'preflight', TRUE, 'source_sha256', v_sha, 'source_files', p_source_files) || v_out;
END
$$;
REVOKE ALL ON FUNCTION public.import_sliq_preflight(TEXT, JSONB, JSONB) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_sliq_preflight(TEXT, JSONB, JSONB) TO authenticated;

-- ---- 4. One batch: one transaction ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_sliq_batch(p_source_sha256 TEXT, p_source_files JSONB, p_run_label TEXT, p_entity TEXT, p_batch_no INT, p_rows JSONB, p_dry_run BOOLEAN)
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
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_rows) k WHERE k <> p_entity AND NOT (p_entity = 'invoices' AND k = 'payments')) THEN
    RAISE EXCEPTION 'A % batch carries only %.', p_entity, CASE p_entity WHEN 'invoices' THEN 'invoices and their payments' ELSE p_entity END
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

  BEGIN
    v_imp := public.import_sliq_prepare(v_org, v_sha, p_rows, p_run_label || ' ' || p_entity || ' batch ' || p_batch_no);
    SELECT count(*) FILTER (WHERE mapped), count(*) FILTER (WHERE NOT mapped) INTO v_already, v_created FROM _sliq_in;
    IF v_created > 0 THEN
      PERFORM public.import_check_payload(v_imp);
      v_op := md5(v_org::TEXT || '|' || v_sha || '|' || p_run_label || '|' || p_entity || '|' || p_batch_no)::UUID;
      v_run := public.import_company_data_run(v_org, v_uid, v_batch, jsonb_strip_nulls(v_imp), CASE WHEN p_dry_run THEN 'dry_run' ELSE 'commit' END,
                                              v_op, v_request, NULL, NULL, NULL);
      PERFORM public.import_sliq_collect(v_run);
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

    -- The batch and its map rows, in this transaction.
    v_result := v_result || jsonb_build_object('committed', TRUE);
    INSERT INTO public.import_source_batches (organization_id, source_sha256, run_label, entity, batch_no, request_sha256, import_batch_id,
                                              rows_in, rows_created, rows_already, result, created_by)
    VALUES (v_org, v_sha, p_run_label, p_entity, p_batch_no, v_request, CASE WHEN v_created > 0 THEN v_batch END,
            v_in, v_created, v_already, v_result, v_uid);
    IF v_created > 0 THEN
      INSERT INTO public.import_source_rows (organization_id, entity, source_row_id, source_sha256, run_label, batch_entity, batch_no,
                                             customer_id, supplier_id, invoice_id, payment_id)
      SELECT v_org, i.entity, i.source_row_id, v_sha, p_run_label, p_entity, p_batch_no,
             CASE WHEN i.entity = 'customer' THEN r.new_id END, CASE WHEN i.entity = 'supplier' THEN r.new_id END,
             CASE WHEN i.entity = 'invoice' THEN r.new_id END, CASE WHEN i.entity = 'payment' THEN r.new_id END
      FROM _sliq_in i
      JOIN (SELECT p.kind, p.ord, p.new_id FROM pg_temp._imp_parties p WHERE p.action = 'create'
            UNION ALL SELECT 'invoices', v.ord, v.new_id FROM pg_temp._imp_invoices v WHERE v.action = 'create'
            UNION ALL SELECT 'payments', y.ord, y.new_id FROM pg_temp._imp_payments y WHERE y.action = 'create') r ON r.kind = i.kind AND r.ord = i.pos
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
                    OR coalesce(v.amount_paid, 0) > v.total) THEN
        RAISE EXCEPTION 'import_sliq_batch: an invoice''s paid amount differs from its payments';
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
REVOKE ALL ON FUNCTION public.import_sliq_batch(TEXT, JSONB, TEXT, TEXT, INT, JSONB, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.import_sliq_batch(TEXT, JSONB, TEXT, TEXT, INT, JSONB, BOOLEAN) TO authenticated;
