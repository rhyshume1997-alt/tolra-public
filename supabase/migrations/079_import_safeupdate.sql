-- =====================================================================================================
-- 079: the data import runs through the API (PostgREST) again. Forward fix for 076 (applied on production Mon 19 Oct).
-- Needs 076. Does NOT need 078 and changes nothing 077 or 078 change: it applies on 075 + 077 + 076 alone or after 078, either order.
--
-- PROBLEM. Supabase loads pg-safeupdate into every API (PostgREST) session, on hosted projects and on the CLI stack. It refuses any
-- UPDATE or DELETE whose own (top-level) WHERE clause is missing, also inside functions the API calls ("UPDATE requires a WHERE
-- clause"; a WHERE inside a subquery doesn't count). 076's internal import_company_data_run has eight such UPDATEs on its own
-- temporary tables (the "decide create / match / error" step: _imp_parties, _imp_stock, _imp_quotes, _imp_sales_orders, _imp_jobs,
-- _imp_purchase_orders, _imp_payments, _imp_invoices; 076 lines 1165, 1167, 1169, 1171, 1173, 1175, 1192, 1236). Every API call that
-- reaches that step fails: import_company_data (dry run and commit), import_validate and import_commit_part. The SQL editor and
-- direct database sessions (where every local and DB test ran) don't load safeupdate, so nothing caught it before the e2e run.
--
-- WHAT CHANGES. Only import_company_data_run: 076's body byte for byte except " WHERE TRUE" before the ';' of those eight statements.
-- WHERE TRUE selects every row, exactly as before (each of them is meant to set every row of its temporary table). Same signature,
-- same RETURNS, LANGUAGE, search_path, not SECURITY DEFINER, same owner and grants (CREATE OR REPLACE keeps them; the REVOKE is 076's,
-- repeated). No other function, table, row or grant is touched. Every other UPDATE and DELETE in the database already has its own
-- WHERE (static scan of every function body; with safeupdate loaded, every import, 078 and time function the DB tests call passes).
--
-- GUARD (section 1). Replaces the function only if its body is 076's or already 079's (md5 with every whitespace character removed,
-- so a CRLF paste matches): anything else stops the release and nothing of 079 is kept. SELF-CHECK (section 3): the body is 079's,
-- no UPDATE or DELETE in it lacks its own WHERE, and the API still can't call it directly.
-- Rollback: supabase/release/079_import_safeupdate.rollback.sql (076's body back, byte for byte; only with Rhys's approval: the
-- import then fails through the API again).
-- =====================================================================================================

-- 1. The guard: the function being replaced is 076's (or already 079's).
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)');
  -- 648b7e06...: 076's body; f7c672e9...: this file's body (section 2); both with every whitespace character removed.
  IF v_md5 IS NULL OR v_md5 NOT IN ('648b7e0652cf46eacf73685343ef9572', 'f7c672e961be898619c046d76458680e') THEN
    RAISE EXCEPTION '079: public.import_company_data_run is not 076''s (md5 without whitespace %); stop and compare it first', coalesce(v_md5, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. 076's import_company_data_run (supabase/migrations/076_data_import.sql section 5), with WHERE TRUE on its eight UPDATEs that had
-- no WHERE of their own. Nothing else in it changes.
CREATE OR REPLACE FUNCTION public.import_company_data_run(p_org UUID, p_uid UUID, p_batch UUID, p_payload JSONB, p_mode TEXT,
                                                         p_client_op_id UUID, p_request TEXT, p_import_id UUID, p_part INT, p_parts INT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kinds CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'stock', 'quotes', 'sales_orders', 'jobs', 'purchase_orders', 'invoices', 'payments'];
  v_k        TEXT;
  v_n        INT;
  v_expect   INT;
  v_counts   JSONB := '{}'::JSONB;
  v_errors   JSONB;
  v_error_n  INT;
  v_warnings JSONB;
  v_warn_n   INT;
  v_counters JSONB;
  v_present  TEXT[];
  v_result   JSONB;
  v_file     TEXT := left(public.import_clean_text(p_payload ->> 'file_name'), 255);
  v_sha      TEXT := lower(public.import_clean_text(p_payload ->> 'file_sha256'));
  v_dry_run  BOOLEAN := p_mode <> 'commit';
  v_size     JSONB;
  v_ql       INT := 0;
  v_il       INT := 0;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('validate', 'dry_run', 'commit') THEN
    RAISE EXCEPTION 'import: unknown mode %', p_mode;
  END IF;
  DROP TABLE IF EXISTS pg_temp._imp_err, pg_temp._imp_warn, pg_temp._imp_parties, pg_temp._imp_stock, pg_temp._imp_quotes,
    pg_temp._imp_quote_lines, pg_temp._imp_sales_orders, pg_temp._imp_jobs, pg_temp._imp_purchase_orders, pg_temp._imp_invoices,
    pg_temp._imp_invoice_lines, pg_temp._imp_payments, pg_temp._imp_names;
  CREATE TEMP TABLE _imp_err (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, ord INT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _imp_warn (seq INT GENERATED ALWAYS AS IDENTITY, kind TEXT, row_no INT, field TEXT, message TEXT) ON COMMIT DROP;

  -- ===== Customers and suppliers (one table, kind tells them apart) ==========================================================
  CREATE TEMP TABLE _imp_parties ON COMMIT DROP AS
  SELECT s.kind, e.ord::INT AS ord,
         CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
         jsonb_typeof(e.v) = 'object' AS obj,
         (cr.c ->> 'name') AS name, (cr.c ->> 'external_ref') AS external_ref,
         (cr.c ->> 'contact_name') AS contact_name, (cr.c ->> 'email') AS email,
         (cr.c ->> 'phone') AS phone, (cr.c ->> 'mobile') AS mobile,
         (cr.c ->> 'address') AS address, (cr.c ->> 'notes') AS notes,
         NULL::TEXT AS match_key, NULL::UUID AS existing_id, 0 AS existing_n, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM unnest(ARRAY['customers', 'suppliers']) s(kind)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(p_payload -> s.kind, '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr;
  CREATE INDEX ON _imp_parties (kind, match_key);

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT c.kind, c.ord, c.row_no, f.field, f.message
  FROM _imp_parties c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('name', CASE WHEN c.obj AND c.name IS NULL THEN 'Name is required.'
                  WHEN length(c.name) > 200 THEN 'Name is longer than 200 characters.'
                  WHEN c.name IS NOT NULL AND public.import_norm_name(c.name) = '' THEN 'Name has no letters or digits.' END),
    ('external_ref', CASE WHEN length(c.external_ref) > 60 THEN 'Account reference is longer than 60 characters.' END),
    ('contact_name', CASE WHEN length(c.contact_name) > 200 THEN 'Contact is longer than 200 characters.' END),
    ('email', CASE WHEN length(c.email) > 320 THEN 'E-mail is longer than 320 characters.' END),
    ('phone', CASE WHEN length(c.phone) > 60 THEN 'Phone is longer than 60 characters.' END),
    ('mobile', CASE WHEN length(c.mobile) > 40 THEN 'Mobile is longer than 40 characters.' END),
    ('address', CASE WHEN length(c.address) > 1000 THEN 'Address is longer than 1000 characters.' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;

  UPDATE _imp_parties c SET match_key = CASE WHEN c.external_ref IS NOT NULL THEN 'ref:' || c.external_ref ELSE 'name:' || public.import_norm_name(c.name) END
  WHERE c.obj AND c.name IS NOT NULL AND length(c.name) <= 200 AND coalesce(length(c.external_ref), 0) <= 60 AND public.import_norm_name(c.name) <> '';

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT d.kind, d.ord, d.row_no, CASE WHEN d.match_key LIKE 'ref:%' THEN 'external_ref' ELSE 'name' END,
         'The same ' || CASE d.kind WHEN 'customers' THEN 'customer' ELSE 'supplier' END || ' is in this file twice (also row ' || d.first_row || ').'
  FROM (SELECT c.kind, c.ord, c.row_no, c.match_key, first_value(c.row_no) OVER w AS first_row, row_number() OVER w AS rn
        FROM _imp_parties c WHERE c.match_key IS NOT NULL
        WINDOW w AS (PARTITION BY c.kind, c.match_key ORDER BY c.ord)) d
  WHERE d.rn > 1;

  -- An account reference: the record an earlier import created under it (if it is still there).
  UPDATE _imp_parties c SET existing_id = k.record_id, existing_n = 1
  FROM public.import_record_keys k
  WHERE k.organization_id = p_org AND k.kind = c.kind AND k.match_key = c.match_key AND c.match_key LIKE 'ref:%'
    AND ((c.kind = 'customers' AND EXISTS (SELECT 1 FROM public.customers x WHERE x.id = k.record_id AND x.organization_id = p_org))
      OR (c.kind = 'suppliers' AND EXISTS (SELECT 1 FROM public.suppliers x WHERE x.id = k.record_id AND x.organization_id = p_org)));
  -- No reference: the company's records with the same normalised name.
  UPDATE _imp_parties c SET existing_n = x.n, existing_id = CASE WHEN x.n = 1 THEN x.id END
  FROM (SELECT 'customers' AS kind, 'name:' || public.import_norm_name(cu.name) AS match_key, count(*)::INT AS n, (array_agg(cu.id))[1] AS id
        FROM public.customers cu WHERE cu.organization_id = p_org GROUP BY 2
        UNION ALL
        SELECT 'suppliers', 'name:' || public.import_norm_name(su.name), count(*)::INT, (array_agg(su.id))[1]
        FROM public.suppliers su WHERE su.organization_id = p_org GROUP BY 2) x
  WHERE x.kind = c.kind AND x.match_key = c.match_key AND c.match_key LIKE 'name:%';
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT c.kind, c.ord, c.row_no, 'name',
         'Matches ' || c.existing_n || ' ' || replace(c.kind, '_', ' ') || ' already in Tolra with the same name: give its account reference, or merge them first.'
  FROM _imp_parties c WHERE c.existing_n > 1;
  -- Matched, but the file's details differ from Tolra's: kept as they are in Tolra (never overwritten), and the admin is told.
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT c.kind, c.row_no, 'name', c.name || ' is already in Tolra with a different ' || d.fields || ': kept as it is, nothing is overwritten.'
  FROM _imp_parties c
  JOIN LATERAL (SELECT cu.contact_name, cu.email, cu.phone, cu.mobile, cu.address, cu.notes FROM public.customers cu WHERE c.kind = 'customers' AND cu.id = c.existing_id
                UNION ALL
                SELECT su.contact_name, su.email, su.phone, NULL, NULL, NULL FROM public.suppliers su WHERE c.kind = 'suppliers' AND su.id = c.existing_id) x ON TRUE
  CROSS JOIN LATERAL (SELECT string_agg(f.name, ', ' ORDER BY f.n) AS fields FROM (VALUES
      (1, 'contact', c.contact_name IS NOT NULL AND c.contact_name IS DISTINCT FROM x.contact_name),
      (2, 'e-mail', c.email IS NOT NULL AND c.email IS DISTINCT FROM x.email),
      (3, 'phone', c.phone IS NOT NULL AND c.phone IS DISTINCT FROM x.phone),
      (4, 'mobile', c.kind = 'customers' AND c.mobile IS NOT NULL AND c.mobile IS DISTINCT FROM x.mobile),
      (5, 'address', c.kind = 'customers' AND c.address IS NOT NULL AND c.address IS DISTINCT FROM x.address),
      (6, 'notes', c.kind = 'customers' AND c.notes IS NOT NULL AND c.notes IS DISTINCT FROM x.notes)) f(n, name, differs)
    WHERE f.differs) d
  WHERE c.existing_n = 1 AND c.existing_id IS NOT NULL AND d.fields IS NOT NULL;

  -- ===== Stock ===============================================================================================================
  CREATE TEMP TABLE _imp_stock ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.unit_price_raw) AS unit_price, public.import_bool(x.auto_purchase_raw) AS auto_purchase,
         CASE WHEN x.current_stock_raw ~ '^-?\d{1,9}$' THEN x.current_stock_raw::INT END AS current_stock,
         CASE WHEN x.min_level_raw ~ '^\d{1,9}$' THEN x.min_level_raw::INT END AS min_level,
         CASE WHEN x.reorder_quantity_raw ~ '^\d{1,9}$' THEN x.reorder_quantity_raw::INT END AS reorder_quantity,
         x.sku AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'sku') AS sku, (cr.c ->> 'material') AS material,
               (cr.c ->> 'current_stock') AS current_stock_raw, (cr.c ->> 'min_level') AS min_level_raw,
               (cr.c ->> 'reorder_quantity') AS reorder_quantity_raw,
               (cr.c ->> 'unit_price') AS unit_price_raw,
               (cr.c ->> 'preferred_supplier') AS preferred_supplier,
               (cr.c ->> 'lead_time_days') AS lead_time_days,
               (cr.c ->> 'auto_purchase') AS auto_purchase_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'stock', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'stock', c.ord, c.row_no, f.field, f.message
  FROM _imp_stock c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('sku', CASE WHEN c.obj AND c.sku IS NULL THEN 'Code (SKU) is required.' WHEN length(c.sku) > 60 THEN 'Code is longer than 60 characters.' END),
    ('material', CASE WHEN c.obj AND c.material IS NULL THEN 'Description is required.' WHEN length(c.material) > 500 THEN 'Description is longer than 500 characters.' END),
    ('current_stock', CASE WHEN c.current_stock_raw IS NOT NULL AND c.current_stock IS NULL THEN 'Stock must be a whole number.' END),
    ('min_level', CASE WHEN c.min_level_raw IS NOT NULL AND c.min_level IS NULL THEN 'Minimum level must be a whole number, 0 or more.' END),
    ('reorder_quantity', CASE WHEN c.reorder_quantity_raw IS NOT NULL AND c.reorder_quantity IS NULL THEN 'Reorder quantity must be a whole number, 0 or more.' END),
    ('unit_price', CASE WHEN c.unit_price_raw IS NOT NULL AND (c.unit_price IS NULL OR c.unit_price < 0 OR c.unit_price <> round(c.unit_price, 4))
                        THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('preferred_supplier', CASE WHEN length(c.preferred_supplier) > 200 THEN 'Supplier is longer than 200 characters.' END),
    ('lead_time_days', CASE WHEN length(c.lead_time_days) > 60 THEN 'Lead time is longer than 60 characters.' END),
    ('auto_purchase', CASE WHEN c.auto_purchase_raw IS NOT NULL AND c.auto_purchase IS NULL THEN 'Auto purchase must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_stock c SET existing_id = s.id FROM public.stock s WHERE s.organization_id = p_org AND s.sku = c.sku;
  -- Matched by code but the file says something else: kept as it is in Tolra (never overwritten), and the admin is told what differs.
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'stock', c.row_no, 'sku', c.sku || ' is already in Tolra with a different ' || d.fields || ': kept as it is, nothing is overwritten.'
  FROM _imp_stock c JOIN public.stock s ON s.id = c.existing_id
  CROSS JOIN LATERAL (SELECT string_agg(f.name, ', ' ORDER BY f.n) AS fields FROM (VALUES
      (1, 'description', c.material IS NOT NULL AND c.material IS DISTINCT FROM s.material),
      (2, 'unit price', c.unit_price IS NOT NULL AND c.unit_price IS DISTINCT FROM s.unit_price),
      (3, 'supplier', c.preferred_supplier IS NOT NULL AND c.preferred_supplier IS DISTINCT FROM s.preferred_supplier),
      (4, 'lead time', c.lead_time_days IS NOT NULL AND c.lead_time_days IS DISTINCT FROM s.lead_time_days)) f(n, name, differs)
    WHERE f.differs) d
  WHERE d.fields IS NOT NULL;

  -- ===== Quotes and their lines ===============================================================================================
  CREATE TEMP TABLE _imp_quotes ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.quote_date_raw) AS quote_date, public.import_date(x.valid_until_raw) AS valid_until,
         public.import_num(x.total_raw) AS total_given, public.import_bool(x.vat_enabled_raw) AS vat_enabled_given,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status,
         NULL::NUMERIC AS total_value, x.quote_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'quote_ref') AS quote_ref, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'quote_date') AS quote_date_raw, (cr.c ->> 'valid_until') AS valid_until_raw,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'description') AS description,
               (cr.c ->> 'terms') AS terms, (cr.c ->> 'customer_notes') AS customer_notes,
               (cr.c ->> 'internal_notes') AS internal_notes, (cr.c ->> 'total_value') AS total_raw,
               (cr.c ->> 'vat_enabled') AS vat_enabled_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'quotes', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_quote_lines ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity, public.import_num(x.unit_price_raw) AS unit_price,
         public.import_num(x.vat_pct_raw) AS vat_pct, public.import_bool(x.vat_exempt_raw) AS vat_exempt
  FROM (SELECT q.ord AS q_ord, q.row_no AS q_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description,
               coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw,
               coalesce((cl.c ->> 'unit_price'), '0') AS unit_price_raw,
               coalesce((cl.c ->> 'vat_pct'), '20') AS vat_pct_raw,
               coalesce((cl.c ->> 'vat_exempt'), 'false') AS vat_exempt_raw,
               (cl.c ->> 'part_number') AS part_number, (cl.c ->> 'drawing_number') AS drawing_number,
               (cl.c ->> 'drawing_revision') AS drawing_revision
        FROM _imp_quotes q
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.v -> 'lines') = 'array' THEN q.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_quote_lines (q_ord);
  ANALYZE _imp_quotes;
  ANALYZE _imp_quote_lines;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', c.ord, c.row_no, f.field, f.message
  FROM _imp_quotes c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('quote_ref', CASE WHEN c.obj AND c.quote_ref IS NULL THEN 'Quote number is required.' WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('quote_date', CASE WHEN c.quote_date_raw IS NOT NULL AND c.quote_date IS NULL THEN 'Date must be a real date written YYYY-MM-DD.' END),
    ('valid_until', CASE WHEN c.valid_until_raw IS NOT NULL AND c.valid_until IS NULL THEN 'Valid until must be a real date written YYYY-MM-DD.' END),
    ('status', CASE WHEN c.status NOT IN ('draft', 'sent', 'accepted', 'rejected') THEN 'Status must be draft, sent, accepted or rejected.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('terms', CASE WHEN length(c.terms) > 4000 THEN 'Terms are longer than 4000 characters.' END),
    ('customer_notes', CASE WHEN length(c.customer_notes) > 4000 THEN 'Notes are longer than 4000 characters.' END),
    ('internal_notes', CASE WHEN length(c.internal_notes) > 4000 THEN 'Internal notes are longer than 4000 characters.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_given IS NULL OR c.total_given < 0 OR c.total_given <> round(c.total_given, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND c.vat_enabled_given IS NULL THEN 'VAT must be yes or no.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', l.q_ord, l.q_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_quote_lines l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 2000 THEN 'Line description is longer than 2000 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity <= 0 OR l.quantity <> round(l.quantity, 4) THEN 'Quantity must be more than 0 (at most 4 decimals).' END),
    ('unit_price', CASE WHEN l.unit_price IS NULL OR l.unit_price < 0 OR l.unit_price <> round(l.unit_price, 4) THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('vat_pct', CASE WHEN l.vat_pct IS NULL OR l.vat_pct < 0 OR l.vat_pct > 100 OR l.vat_pct <> round(l.vat_pct, 2) THEN 'VAT % must be between 0 and 100.' END),
    ('vat_exempt', CASE WHEN l.vat_exempt IS NULL THEN 'VAT exempt must be yes or no.' END),
    ('part_number', CASE WHEN length(l.part_number) > 100 THEN 'Part number is longer than 100 characters.' END),
    ('drawing_number', CASE WHEN length(l.drawing_number) > 100 THEN 'Drawing number is longer than 100 characters.' END),
    ('drawing_revision', CASE WHEN length(l.drawing_revision) > 20 THEN 'Drawing revision is longer than 20 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- The total: as given, else from the lines (net, plus VAT when the quote charges it).
  UPDATE _imp_quotes q SET total_value = coalesce(q.total_given, s.total)
  FROM (SELECT q2.ord, sum(round(l.quantity * l.unit_price, 2)) + CASE WHEN coalesce(q2.vat_enabled_given, TRUE)
                 THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) ELSE 0 END AS total
        FROM _imp_quotes q2 LEFT JOIN _imp_quote_lines l ON l.q_ord = q2.ord AND l.quantity IS NOT NULL AND l.unit_price IS NOT NULL AND l.vat_pct IS NOT NULL AND l.vat_exempt IS NOT NULL
        GROUP BY q2.ord, q2.vat_enabled_given) s
  WHERE s.ord = q.ord;
  UPDATE _imp_quotes c SET existing_id = q.id FROM public.quotes q WHERE q.organization_id = p_org AND q.quote_ref = c.quote_ref;
  -- Numbering collision: the number is already in Tolra with other content (customer, or total when both have one). A match is only
  -- the same record again; anything else is a problem, never an overwrite.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'quotes', c.ord, c.row_no, 'quote_ref', c.quote_ref || ' is already in Tolra with a different customer or total: nothing is overwritten.'
  FROM _imp_quotes c JOIN public.quotes q ON q.id = c.existing_id
  WHERE public.import_norm_name(q.customer) <> public.import_norm_name(c.customer)
     OR (q.total_value IS NOT NULL AND c.total_value IS NOT NULL AND q.total_value <> c.total_value);

  -- ===== Sales orders ===========================================================================================================
  CREATE TEMP TABLE _imp_sales_orders ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.order_date_raw) AS order_date, public.import_date(x.delivery_date_raw) AS delivery_date,
         public.import_num(x.total_raw) AS total_value, lower(regexp_replace(coalesce(x.status_raw, 'open'), '[ -]+', '_', 'g')) AS status,
         public.import_norm_name(x.customer) AS customer_norm,
         CASE WHEN x.so_number IS NOT NULL THEN x.so_number || '|' || public.import_norm_name(x.customer) END AS match_key,
         NULL::UUID AS existing_id, 0 AS existing_n, NULL::TEXT AS action, gen_random_uuid() AS new_id, NULL::UUID AS quote_id, NULL::UUID AS customer_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'so_number') AS so_number, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'customer_po') AS customer_po, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'order_date') AS order_date_raw,
               (cr.c ->> 'delivery_date') AS delivery_date_raw, (cr.c ->> 'total_value') AS total_raw,
               (cr.c ->> 'notes') AS notes
        FROM jsonb_array_elements(coalesce(p_payload -> 'sales_orders', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, f.field, f.message
  FROM _imp_sales_orders c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('so_number', CASE WHEN c.obj AND c.so_number IS NULL THEN 'Order number is required.' WHEN length(c.so_number) > 60 THEN 'Order number is longer than 60 characters.' END),
    ('customer', CASE WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('status', CASE WHEN c.status NOT IN ('open', 'confirmed', 'in_production', 'despatched', 'converted', 'closed')
                    THEN 'Status must be open, confirmed, in production, despatched, converted or closed.' END),
    ('order_date', CASE WHEN c.order_date_raw IS NOT NULL AND c.order_date IS NULL THEN 'Order date must be a real date written YYYY-MM-DD.' END),
    ('delivery_date', CASE WHEN c.delivery_date_raw IS NOT NULL AND c.delivery_date IS NULL THEN 'Delivery date must be a real date written YYYY-MM-DD.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_value IS NULL OR c.total_value < 0 OR c.total_value <> round(c.total_value, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_sales_orders c SET existing_n = x.n, existing_id = x.id
  FROM (SELECT so.so_number || '|' || public.import_norm_name(so.customer) AS match_key, count(*)::INT AS n, (array_agg(so.id))[1] AS id
        FROM public.sales_orders so WHERE so.organization_id = p_org GROUP BY 1) x
  WHERE x.match_key = c.match_key;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, 'so_number', 'Matches ' || c.existing_n || ' sales orders already in Tolra for this customer.'
  FROM _imp_sales_orders c WHERE c.existing_n > 1;
  -- Numbering collision: the number is already in Tolra, for another customer only. Never overwritten, never doubled.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'sales_orders', c.ord, c.row_no, 'so_number', c.so_number || ' is already in Tolra for another customer: nothing is overwritten.'
  FROM _imp_sales_orders c
  WHERE c.existing_n = 0 AND c.so_number IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.organization_id = p_org AND so.so_number = c.so_number);

  -- ===== Jobs ===================================================================================================================
  CREATE TEMP TABLE _imp_jobs ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.due_date_raw) AS due_date, public.import_date(x.date_received_raw) AS date_received,
         CASE WHEN x.quantity_raw ~ '^\d{1,9}$' THEN x.quantity_raw::INT END AS quantity_required, public.import_num(x.value_raw) AS value,
         lower(regexp_replace(coalesce(x.stage_raw, 'material'), '[ -]+', '_', 'g')) AS stage,
         lower(regexp_replace(coalesce(x.status_raw, 'on_track'), '[ -]+', '_', 'g')) AS status,
         x.job_no AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id, NULL::UUID AS quote_id, NULL::UUID AS so_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'description') AS description, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'so_number') AS so_number, (cr.c ->> 'customer_po') AS customer_po,
               (cr.c ->> 'stage') AS stage_raw, (cr.c ->> 'status') AS status_raw,
               (cr.c ->> 'due_date') AS due_date_raw, (cr.c ->> 'date_received') AS date_received_raw,
               (cr.c ->> 'drawing_no') AS drawing_no, (cr.c ->> 'quantity_required') AS quantity_raw,
               (cr.c ->> 'material_required') AS material_required,
               (cr.c ->> 'specification') AS specification, (cr.c ->> 'value') AS value_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'jobs', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'jobs', c.ord, c.row_no, f.field, f.message
  FROM _imp_jobs c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('job_no', CASE WHEN c.obj AND c.job_no IS NULL THEN 'Job number is required.' WHEN length(c.job_no) > 60 THEN 'Job number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('so_number', CASE WHEN length(c.so_number) > 60 THEN 'Order number is longer than 60 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('stage', CASE WHEN c.stage NOT IN ('material', 'setup', 'machining', 'inspection')
                   THEN 'Stage must be material, setup, machining or inspection (a finished job is released by its inspection, not imported).' END),
    ('status', CASE WHEN c.status NOT IN ('on_track', 'at_risk', 'overdue') THEN 'Status must be on track, at risk or overdue.' END),
    ('due_date', CASE WHEN c.due_date_raw IS NOT NULL AND c.due_date IS NULL THEN 'Due date must be a real date written YYYY-MM-DD.' END),
    ('date_received', CASE WHEN c.date_received_raw IS NOT NULL AND c.date_received IS NULL THEN 'Date received must be a real date written YYYY-MM-DD.' END),
    ('drawing_no', CASE WHEN length(c.drawing_no) > 200 THEN 'Drawing number is longer than 200 characters.' END),
    ('quantity_required', CASE WHEN c.quantity_raw IS NOT NULL AND c.quantity_required IS NULL THEN 'Quantity must be a whole number, 0 or more.' END),
    ('material_required', CASE WHEN length(c.material_required) > 500 THEN 'Material is longer than 500 characters.' END),
    ('specification', CASE WHEN length(c.specification) > 4000 THEN 'Specification is longer than 4000 characters.' END),
    ('value', CASE WHEN c.value_raw IS NOT NULL AND (c.value IS NULL OR c.value < 0 OR c.value <> round(c.value, 2)) THEN 'Value must be an amount of 0 or more (pounds and pence).' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_jobs c SET existing_id = j.id FROM public.jobs j WHERE j.organization_id = p_org AND j.job_no = c.job_no;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'jobs', c.ord, c.row_no, 'job_no', c.job_no || ' is already in Tolra for a different customer: nothing is overwritten.'
  FROM _imp_jobs c JOIN public.jobs j ON j.id = c.existing_id
  WHERE public.import_norm_name(j.customer) <> public.import_norm_name(c.customer);

  -- ===== Purchase orders ========================================================================================================
  CREATE TEMP TABLE _imp_purchase_orders ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.order_date_raw) AS order_date, public.import_date(x.expected_raw) AS expected_delivery,
         public.import_num(x.total_raw) AS total_value, public.import_bool(x.vat_enabled_raw) AS vat_enabled,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status,
         x.po_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'po_ref') AS po_ref, (cr.c ->> 'supplier') AS supplier,
               (cr.c ->> 'order_date') AS order_date_raw, (cr.c ->> 'expected_delivery') AS expected_raw,
               (cr.c ->> 'total_value') AS total_raw, (cr.c ->> 'status') AS status_raw,
               (cr.c ->> 'notes') AS notes, (cr.c ->> 'vat_enabled') AS vat_enabled_raw
        FROM jsonb_array_elements(coalesce(p_payload -> 'purchase_orders', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'purchase_orders', c.ord, c.row_no, f.field, f.message
  FROM _imp_purchase_orders c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('po_ref', CASE WHEN c.obj AND c.po_ref IS NULL THEN 'PO number is required.' WHEN length(c.po_ref) > 60 THEN 'PO number is longer than 60 characters.' END),
    ('supplier', CASE WHEN length(c.supplier) > 200 THEN 'Supplier is longer than 200 characters.' END),
    ('order_date', CASE WHEN c.order_date_raw IS NOT NULL AND c.order_date IS NULL THEN 'Order date must be a real date written YYYY-MM-DD.' END),
    ('expected_delivery', CASE WHEN c.expected_raw IS NOT NULL AND c.expected_delivery IS NULL THEN 'Delivery date must be a real date written YYYY-MM-DD.' END),
    ('total_value', CASE WHEN c.total_raw IS NOT NULL AND (c.total_value IS NULL OR c.total_value < 0 OR c.total_value <> round(c.total_value, 2))
                         THEN 'Total must be an amount of 0 or more (pounds and pence).' END),
    ('status', CASE WHEN c.status NOT IN ('draft', 'issued', 'sent', 'confirmed', 'partial_received', 'received', 'cancelled')
                    THEN 'Status must be draft, issued, sent, confirmed, partial received, received or cancelled.' END),
    ('notes', CASE WHEN length(c.notes) > 4000 THEN 'Notes are longer than 4000 characters.' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND c.vat_enabled IS NULL THEN 'VAT must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_purchase_orders c SET existing_id = po.id
  FROM public.purchase_orders po WHERE po.organization_id = p_org AND (po.po_ref = c.po_ref OR po.po_number = c.po_ref);
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'purchase_orders', c.ord, c.row_no, 'po_ref', c.po_ref || ' is already in Tolra with a different supplier or total: nothing is overwritten.'
  FROM _imp_purchase_orders c JOIN public.purchase_orders po ON po.id = c.existing_id
  WHERE public.import_norm_name(po.supplier) <> public.import_norm_name(c.supplier)
     OR (po.total_value IS NOT NULL AND c.total_value IS NOT NULL AND po.total_value <> c.total_value);

  -- ===== Invoices and their lines ===============================================================================================
  CREATE TEMP TABLE _imp_invoices ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.invoice_date_raw) AS invoice_date, public.import_date(x.due_date_raw) AS due_date,
         public.import_num(x.subtotal_raw) AS subtotal_given, public.import_num(x.vat_raw) AS vat_given, public.import_num(x.total_raw) AS total_given,
         coalesce(public.import_bool(x.vat_enabled_raw), TRUE) AS vat_enabled,
         lower(regexp_replace(coalesce(x.status_raw, 'sent'), '[ -]+', '_', 'g')) AS status_given,
         NULL::NUMERIC AS subtotal, NULL::NUMERIC AS vat, NULL::NUMERIC AS total, NULL::NUMERIC AS paid, NULL::DATE AS last_paid_on,
         NULL::TEXT AS status, FALSE AS payment_unverified, NULL::UUID AS job_id,
         x.invoice_ref AS match_key, NULL::UUID AS existing_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord, e.v,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'invoice_ref') AS invoice_ref, (cr.c ->> 'customer') AS customer,
               (cr.c ->> 'invoice_date') AS invoice_date_raw, (cr.c ->> 'due_date') AS due_date_raw,
               (cr.c ->> 'status') AS status_raw, (cr.c ->> 'subtotal') AS subtotal_raw,
               (cr.c ->> 'vat') AS vat_raw, (cr.c ->> 'total') AS total_raw,
               (cr.c ->> 'vat_enabled') AS vat_enabled_raw, (cr.c ->> 'terms') AS terms,
               (cr.c ->> 'customer_po') AS customer_po, (cr.c ->> 'quote_ref') AS quote_ref,
               (cr.c ->> 'job_no') AS job_no, (cr.c ->> 'description') AS description
        FROM jsonb_array_elements(coalesce(p_payload -> 'invoices', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;

  CREATE TEMP TABLE _imp_invoice_lines ON COMMIT DROP AS
  SELECT x.*, public.import_num(x.quantity_raw) AS quantity, public.import_num(x.unit_price_raw) AS unit_price,
         public.import_num(x.vat_pct_raw) AS vat_pct, public.import_bool(x.vat_exempt_raw) AS vat_exempt
  FROM (SELECT i.ord AS i_ord, i.row_no AS i_row, l.pos::INT AS pos, jsonb_typeof(l.v) = 'object' AS obj,
               (cl.c ->> 'description') AS description,
               coalesce((cl.c ->> 'quantity'), '1') AS quantity_raw,
               coalesce((cl.c ->> 'unit_price'), '0') AS unit_price_raw,
               coalesce((cl.c ->> 'vat_pct'), '20') AS vat_pct_raw,
               coalesce((cl.c ->> 'vat_exempt'), 'false') AS vat_exempt_raw
        FROM _imp_invoices i
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.v -> 'lines') = 'array' THEN i.v -> 'lines' ELSE '[]'::JSONB END) WITH ORDINALITY l(v, pos)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(l.v) AS c OFFSET 0) cl) x;
  CREATE INDEX ON _imp_invoices (invoice_ref, ord);
  CREATE INDEX ON _imp_invoice_lines (i_ord);
  ANALYZE _imp_invoices;
  ANALYZE _imp_invoice_lines;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', l.i_ord, l.i_row, 'lines[' || l.pos || '].' || f.field, f.message
  FROM _imp_invoice_lines l
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT l.obj THEN 'Not a line.' END),
    ('description', CASE WHEN l.obj AND l.description IS NULL THEN 'Line description is required.' WHEN length(l.description) > 2000 THEN 'Line description is longer than 2000 characters.' END),
    ('quantity', CASE WHEN l.quantity IS NULL OR l.quantity < 0 OR l.quantity <> round(l.quantity, 4) THEN 'Quantity must be 0 or more (at most 4 decimals).'
                      WHEN l.quantity = 0 AND l.unit_price IS DISTINCT FROM 0 THEN 'A line with quantity 0 is a text line: its unit price must be 0.' END),
    ('unit_price', CASE WHEN l.unit_price IS NULL OR l.unit_price < 0 OR l.unit_price <> round(l.unit_price, 4) THEN 'Unit price must be an amount of 0 or more (at most 4 decimals).' END),
    ('vat_pct', CASE WHEN l.vat_pct IS NULL OR l.vat_pct < 0 OR l.vat_pct > 100 OR l.vat_pct <> round(l.vat_pct, 2) THEN 'VAT % must be between 0 and 100.' END),
    ('vat_exempt', CASE WHEN l.vat_exempt IS NULL THEN 'VAT exempt must be yes or no.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;

  -- Totals: as given (VAT 0 and net = total when only the total is given; the missing one of net and VAT from the other two), else
  -- from the lines. Net + VAT must equal the total.
  UPDATE _imp_invoices i SET
    total = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.net + s.tax ELSE i.total_given END,
    vat = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.tax
               ELSE coalesce(i.vat_given, i.total_given - i.subtotal_given, 0) END,
    subtotal = CASE WHEN i.subtotal_given IS NULL AND i.vat_given IS NULL AND i.total_given IS NULL THEN s.net
                    ELSE coalesce(i.subtotal_given, i.total_given - coalesce(i.vat_given, 0)) END
  FROM (SELECT i2.ord, count(l.pos) AS n,
               sum(round(l.quantity * l.unit_price, 2)) AS net,
               CASE WHEN i2.vat_enabled THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) ELSE 0 END AS tax
        FROM _imp_invoices i2 LEFT JOIN _imp_invoice_lines l ON l.i_ord = i2.ord AND l.quantity IS NOT NULL AND l.unit_price IS NOT NULL AND l.vat_pct IS NOT NULL AND l.vat_exempt IS NOT NULL
        GROUP BY i2.ord, i2.vat_enabled) s
  WHERE s.ord = i.ord;
  UPDATE _imp_invoices c SET existing_id = i.id FROM public.invoices i WHERE i.organization_id = p_org AND i.invoice_ref = c.invoice_ref;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', c.ord, c.row_no, 'invoice_ref', c.invoice_ref || ' is already in Tolra with a different customer or total: nothing is overwritten.'
  FROM _imp_invoices c JOIN public.invoices i ON i.id = c.existing_id
  WHERE public.import_norm_name(i.customer) <> public.import_norm_name(c.customer)
     OR (i.total IS NOT NULL AND c.total IS NOT NULL AND i.total <> c.total);

  -- ===== Payments ===============================================================================================================
  CREATE TEMP TABLE _imp_payments ON COMMIT DROP AS
  SELECT x.*, public.import_date(x.paid_on_raw) AS paid_on, public.import_num(x.amount_raw) AS amount,
         CASE lower(x.method_raw) WHEN 'bacs' THEN 'BACS' WHEN 'bank transfer' THEN 'BACS' WHEN 'cheque' THEN 'cheque' WHEN 'check' THEN 'cheque'
                                  WHEN 'card' THEN 'card' WHEN 'cash' THEN 'cash' WHEN 'other' THEN 'other' END AS method,
         0 AS ordinal, NULL::TEXT AS match_key, NULL::UUID AS existing_id, NULL::UUID AS invoice_id, NULL::TEXT AS action, gen_random_uuid() AS new_id
  FROM (SELECT e.ord::INT AS ord,
               CASE WHEN jsonb_typeof(e.v -> 'row') = 'number' AND (e.v ->> 'row') ~ '^\d{1,7}$' THEN (e.v ->> 'row')::INT ELSE e.ord::INT + 1 END AS row_no,
               jsonb_typeof(e.v) = 'object' AS obj,
               (cr.c ->> 'invoice_ref') AS invoice_ref, (cr.c ->> 'paid_on') AS paid_on_raw,
               (cr.c ->> 'amount') AS amount_raw, (cr.c ->> 'method') AS method_raw,
               (cr.c ->> 'reference') AS reference
        FROM jsonb_array_elements(coalesce(p_payload -> 'payments', '[]'::JSONB)) WITH ORDINALITY e(v, ord)
        CROSS JOIN LATERAL (SELECT public.import_clean_record(e.v) AS c OFFSET 0) cr) x;
  CREATE INDEX ON _imp_payments (ord);
  ANALYZE _imp_payments;

  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', c.ord, c.row_no, f.field, f.message
  FROM _imp_payments c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('invoice_ref', CASE WHEN c.obj AND c.invoice_ref IS NULL THEN 'Invoice number is required.' WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('paid_on', CASE WHEN c.obj AND c.paid_on_raw IS NULL THEN 'Date paid is required.' WHEN c.paid_on_raw IS NOT NULL AND c.paid_on IS NULL THEN 'Date paid must be a real date written YYYY-MM-DD.' END),
    ('amount', CASE WHEN c.obj AND c.amount_raw IS NULL THEN 'Amount is required.'
                    WHEN c.amount_raw IS NOT NULL AND (c.amount IS NULL OR c.amount <= 0 OR c.amount <> round(c.amount, 2)) THEN 'Amount must be more than 0 (pounds and pence).' END),
    ('method', CASE WHEN c.method_raw IS NOT NULL AND c.method IS NULL THEN 'Method must be BACS, cheque, card, cash or other.' END),
    ('reference', CASE WHEN length(c.reference) > 100 THEN 'Reference is longer than 100 characters.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  -- The key: invoice number, date, amount and the payment's place among the file's payments with those three.
  UPDATE _imp_payments p SET ordinal = o.n, match_key = p.invoice_ref || '|' || p.paid_on::TEXT || '|' || to_char(p.amount, 'FM999999999990.00') || '|' || o.n
  FROM (SELECT p2.ord, row_number() OVER (PARTITION BY p2.invoice_ref, p2.paid_on, p2.amount ORDER BY p2.ord)::INT AS n
        FROM _imp_payments p2 WHERE p2.invoice_ref IS NOT NULL AND p2.paid_on IS NOT NULL AND p2.amount IS NOT NULL AND p2.amount > 0) o
  WHERE o.ord = p.ord AND length(p.invoice_ref) <= 60;
  UPDATE _imp_payments p SET existing_id = k.record_id
  FROM public.import_record_keys k
  WHERE k.organization_id = p_org AND k.kind = 'payments' AND k.match_key = p.match_key
    AND EXISTS (SELECT 1 FROM public.invoice_payments x WHERE x.id = k.record_id AND x.organization_id = p_org);

  -- ===== In-file duplicates (documents and stock) =================================================================================
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT d.kind, d.ord, d.row_no, d.field, 'This number is in the file twice (also row ' || d.first_row || ').'
  FROM (SELECT y.*, first_value(y.row_no) OVER w AS first_row, row_number() OVER w AS rn
        FROM (SELECT 'stock' AS kind, 'sku' AS field, ord, row_no, match_key FROM _imp_stock
              UNION ALL SELECT 'quotes', 'quote_ref', ord, row_no, match_key FROM _imp_quotes
              UNION ALL SELECT 'sales_orders', 'so_number', ord, row_no, match_key FROM _imp_sales_orders
              UNION ALL SELECT 'jobs', 'job_no', ord, row_no, match_key FROM _imp_jobs
              UNION ALL SELECT 'purchase_orders', 'po_ref', ord, row_no, match_key FROM _imp_purchase_orders
              UNION ALL SELECT 'invoices', 'invoice_ref', ord, row_no, match_key FROM _imp_invoices) y
        WHERE y.match_key IS NOT NULL
        WINDOW w AS (PARTITION BY y.kind, y.match_key ORDER BY y.ord)) d
  WHERE d.rn > 1;

  -- ===== Decide: create, match (skipped), or error =================================================================================
  CREATE INDEX ON _imp_err (kind, ord);
  ANALYZE _imp_err;
  UPDATE _imp_parties c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = c.kind AND e.ord = c.ord) THEN 'error'
                                          WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_stock c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'stock' AND e.ord = c.ord) THEN 'error'
                                        WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_quotes c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'quotes' AND e.ord = c.ord) THEN 'error'
                                         WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_sales_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'sales_orders' AND e.ord = c.ord) THEN 'error'
                                               WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_jobs c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'jobs' AND e.ord = c.ord) THEN 'error'
                                       WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  UPDATE _imp_purchase_orders c SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'purchase_orders' AND e.ord = c.ord) THEN 'error'
                                                  WHEN c.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;

  -- Payments: matched by key; created only with an invoice this import creates.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', p.ord, p.row_no, 'invoice_ref',
         CASE WHEN i.ord IS NOT NULL AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord)
                THEN 'Its invoice (row ' || i.row_no || ') has problems.'
              WHEN i.ord IS NOT NULL AND i.existing_id IS NULL THEN NULL
              WHEN i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.invoices x WHERE x.organization_id = p_org AND x.invoice_ref = p.invoice_ref)
                THEN 'Invoice ' || p.invoice_ref || ' is already in Tolra: record this payment on it with Record payment.'
              ELSE 'There is no invoice ' || p.invoice_ref || ' in this file or in Tolra.' END
  FROM _imp_payments p
  LEFT JOIN LATERAL (SELECT i2.ord, i2.row_no, i2.existing_id FROM _imp_invoices i2 WHERE i2.invoice_ref = p.invoice_ref ORDER BY i2.ord LIMIT 1) i ON TRUE
  WHERE p.match_key IS NOT NULL AND p.existing_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord)
    AND (i.ord IS NULL OR i.existing_id IS NOT NULL OR EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord));
  UPDATE _imp_payments p SET action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord) THEN 'error'
                                           WHEN p.existing_id IS NOT NULL THEN 'match' ELSE 'create' END,
                             invoice_id = (SELECT i.new_id FROM _imp_invoices i WHERE i.invoice_ref = p.invoice_ref ORDER BY i.ord LIMIT 1) WHERE TRUE;

  -- Invoices: what was paid, and the state that follows from it. No payment is invented: an invoice marked paid or part paid without
  -- payments stays sent and is flagged "Payment to confirm".
  UPDATE _imp_invoices i SET paid = coalesce(s.paid, 0), last_paid_on = s.last
  FROM (SELECT i2.ord, sum(p.amount) AS paid, max(p.paid_on) AS last
        FROM _imp_invoices i2 LEFT JOIN _imp_payments p ON p.invoice_id = i2.new_id AND p.action = 'create'
        GROUP BY i2.ord) s
  WHERE s.ord = i.ord;
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'invoices', c.ord, c.row_no, f.field, f.message
  FROM _imp_invoices c
  CROSS JOIN LATERAL (VALUES
    ('row', CASE WHEN NOT c.obj THEN 'Not a record.' END),
    ('invoice_ref', CASE WHEN c.obj AND c.invoice_ref IS NULL THEN 'Invoice number is required.' WHEN length(c.invoice_ref) > 60 THEN 'Invoice number is longer than 60 characters.' END),
    ('customer', CASE WHEN c.obj AND c.customer IS NULL THEN 'Customer is required.' WHEN length(c.customer) > 200 THEN 'Customer is longer than 200 characters.' END),
    ('invoice_date', CASE WHEN c.obj AND c.invoice_date_raw IS NULL THEN 'Invoice date is required.'
                          WHEN c.invoice_date_raw IS NOT NULL AND c.invoice_date IS NULL THEN 'Invoice date must be a real date written YYYY-MM-DD.' END),
    ('due_date', CASE WHEN c.due_date_raw IS NOT NULL AND c.due_date IS NULL THEN 'Due date must be a real date written YYYY-MM-DD.' END),
    ('status', CASE WHEN c.status_given NOT IN ('issued', 'sent', 'partial', 'paid', 'void', 'cancelled', 'written_off')
                    THEN 'Status must be issued, sent, partial, paid, void, cancelled or written off (drafts and credited invoices are not imported).' END),
    ('subtotal', CASE WHEN c.subtotal_raw IS NOT NULL AND (c.subtotal_given IS NULL OR c.subtotal_given < 0 OR c.subtotal_given <> round(c.subtotal_given, 2))
                      THEN 'Net must be an amount of 0 or more (pounds and pence).' END),
    ('vat', CASE WHEN c.vat_raw IS NOT NULL AND (c.vat_given IS NULL OR c.vat_given < 0 OR c.vat_given <> round(c.vat_given, 2))
                 THEN 'VAT must be an amount of 0 or more (pounds and pence).' END),
    ('total', CASE WHEN c.total_raw IS NOT NULL AND (c.total_given IS NULL OR c.total_given < 0 OR c.total_given <> round(c.total_given, 2))
                     THEN 'Total must be an amount of 0 or more (pounds and pence).'
                   WHEN c.obj AND c.total_raw IS NULL AND (c.subtotal_raw IS NOT NULL OR c.vat_raw IS NOT NULL) THEN 'Total is required with net or VAT.'
                   WHEN c.obj AND c.total_raw IS NULL AND c.subtotal_raw IS NULL AND c.vat_raw IS NULL
                        AND NOT EXISTS (SELECT 1 FROM _imp_invoice_lines l WHERE l.i_ord = c.ord) THEN 'Total is required (or give the lines).'
                   WHEN c.total IS NOT NULL AND (c.subtotal < 0 OR c.vat < 0 OR c.subtotal + c.vat <> c.total) THEN 'Net + VAT must equal the total.'
                   WHEN c.paid > c.total THEN 'Its payments come to ' || to_char(c.paid, 'FM999999999990.00') || ', more than its total.' END),
    ('vat_enabled', CASE WHEN c.vat_enabled_raw IS NOT NULL AND public.import_bool(c.vat_enabled_raw) IS NULL THEN 'VAT must be yes or no.' END),
    ('terms', CASE WHEN length(c.terms) > 4000 THEN 'Terms are longer than 4000 characters.' END),
    ('customer_po', CASE WHEN length(c.customer_po) > 100 THEN 'Customer PO is longer than 100 characters.' END),
    ('quote_ref', CASE WHEN length(c.quote_ref) > 60 THEN 'Quote number is longer than 60 characters.' END),
    ('job_no', CASE WHEN length(c.job_no) > 60 THEN 'Job number is longer than 60 characters.' END),
    ('description', CASE WHEN length(c.description) > 4000 THEN 'Description is longer than 4000 characters.' END),
    ('lines', CASE WHEN c.obj AND c.v ? 'lines' AND jsonb_typeof(c.v -> 'lines') NOT IN ('array', 'null') THEN 'Lines must be a list.' END),
    ('payments', CASE WHEN c.paid > 0 AND c.status_given IN ('void', 'cancelled') THEN 'A void or cancelled invoice can''t have payments.' END)
  ) f(field, message)
  WHERE f.message IS NOT NULL;
  UPDATE _imp_invoices i SET
    status = CASE WHEN i.status_given IN ('void', 'cancelled', 'written_off') THEN i.status_given
                  WHEN i.paid > 0 AND i.paid >= i.total THEN 'paid'
                  WHEN i.paid > 0 THEN 'partial'
                  WHEN i.status_given = 'paid' AND i.total = 0 THEN 'paid'
                  WHEN i.status_given IN ('paid', 'partial') THEN 'sent'
                  ELSE i.status_given END,
    payment_unverified = (i.status_given IN ('paid', 'partial') AND i.paid = 0 AND i.total > 0),
    action = CASE WHEN EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'invoices' AND e.ord = i.ord) THEN 'error'
                  WHEN i.existing_id IS NOT NULL THEN 'match' ELSE 'create' END WHERE TRUE;
  -- Fresh statistics now that every row has its action (the temporary tables are not analysed on their own).
  ANALYZE _imp_parties;
  ANALYZE _imp_stock;
  ANALYZE _imp_quotes;
  ANALYZE _imp_sales_orders;
  ANALYZE _imp_jobs;
  ANALYZE _imp_purchase_orders;
  ANALYZE _imp_invoices;
  ANALYZE _imp_payments;
  -- A payment whose invoice turned out to have a problem above.
  INSERT INTO _imp_err (kind, ord, row_no, field, message)
  SELECT 'payments', p.ord, p.row_no, 'invoice_ref', 'Its invoice (row ' || i.row_no || ') has problems.'
  FROM _imp_payments p JOIN _imp_invoices i ON i.new_id = p.invoice_id
  WHERE p.action = 'create' AND i.action = 'error';
  UPDATE _imp_payments p SET action = 'error' WHERE p.action = 'create' AND EXISTS (SELECT 1 FROM _imp_err e WHERE e.kind = 'payments' AND e.ord = p.ord);

  -- ===== Warnings (never stop the import) ==========================================================================================
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'status', 'Marked ' || i.status_given || ' but no payments were given: imported as sent and flagged "Payment to confirm".'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.payment_unverified;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'total', 'The lines come to net ' || to_char(s.net, 'FM999999999990.00') || ', VAT ' || to_char(s.tax, 'FM999999999990.00')
         || '; the invoice says net ' || to_char(i.subtotal, 'FM999999999990.00') || ', VAT ' || to_char(i.vat, 'FM999999999990.00') || ' (the invoice''s figures are kept).'
  FROM _imp_invoices i
  JOIN (SELECT l.i_ord, sum(round(l.quantity * l.unit_price, 2)) AS net,
               sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(l.quantity * l.unit_price, 2) * l.vat_pct / 100, 2) END) AS tax
        FROM _imp_invoice_lines l GROUP BY l.i_ord) s ON s.i_ord = i.ord
  WHERE i.action = 'create' AND (s.net IS DISTINCT FROM i.subtotal OR (CASE WHEN i.vat_enabled THEN s.tax ELSE 0 END) IS DISTINCT FROM i.vat);
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT y.kind, y.row_no, y.field, y.ref || ' is not ' || y.prefix || '-<digits>: it is imported as written, and Tolra''s ' || y.prefix || ' numbers carry on from their own counter.'
  FROM (SELECT 'quotes' AS kind, row_no, 'quote_ref' AS field, quote_ref AS ref, 'QUO' AS prefix FROM _imp_quotes WHERE action = 'create'
        UNION ALL SELECT 'invoices', row_no, 'invoice_ref', invoice_ref, 'INV' FROM _imp_invoices WHERE action = 'create'
        UNION ALL SELECT 'purchase_orders', row_no, 'po_ref', po_ref, 'PO' FROM _imp_purchase_orders WHERE action = 'create'
        UNION ALL SELECT 'jobs', row_no, 'job_no', job_no, 'J' FROM _imp_jobs WHERE action = 'create'
        UNION ALL SELECT 'sales_orders', row_no, 'so_number', so_number, 'SO' FROM _imp_sales_orders WHERE action = 'create') y
  WHERE y.ref !~ ('^' || y.prefix || '-\d{1,9}$');

  -- ===== Counts and problems =======================================================================================================
  FOREACH v_k IN ARRAY v_kinds LOOP
    EXECUTE format($q$SELECT jsonb_build_object('created', count(*) FILTER (WHERE action = 'create'), 'matched_existing', count(*) FILTER (WHERE action = 'match'),
                                               'errors', count(*) FILTER (WHERE action = 'error'))
                      FROM %s%s$q$, CASE WHEN v_k IN ('customers', 'suppliers') THEN 'pg_temp._imp_parties WHERE kind = ' || quote_literal(v_k) ELSE 'pg_temp._imp_' || v_k END, '')
      INTO v_result;
    v_counts := v_counts || jsonb_build_object(v_k, v_result);
  END LOOP;
  SELECT count(*) INTO v_ql FROM _imp_quote_lines l JOIN _imp_quotes q ON q.ord = l.q_ord WHERE q.action = 'create';
  SELECT count(*) INTO v_il FROM _imp_invoice_lines l JOIN _imp_invoices i ON i.ord = l.i_ord WHERE i.action = 'create';
  v_counts := v_counts || jsonb_build_object('quote_lines', jsonb_build_object('created', v_ql), 'invoice_lines', jsonb_build_object('created', v_il));
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'row', e.row_no, 'field', e.field, 'message', e.message) ORDER BY e.seq)
                              FILTER (WHERE e.seq_rank <= 1000), '[]'::JSONB)
    INTO v_error_n, v_errors
    FROM (SELECT e2.*, row_number() OVER (ORDER BY e2.seq) AS seq_rank FROM _imp_err e2) e;
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'row', w.row_no, 'field', w.field, 'message', w.message) ORDER BY w.seq)
                              FILTER (WHERE w.seq_rank <= 500), '[]'::JSONB)
    INTO v_warn_n, v_warnings
    FROM (SELECT w2.*, row_number() OVER (ORDER BY w2.seq) AS seq_rank FROM _imp_warn w2) w;
  SELECT coalesce(array_agg(k ORDER BY o), ARRAY[]::TEXT[]) INTO v_present
    FROM unnest(v_kinds) WITH ORDINALITY u(k, o) WHERE jsonb_array_length(coalesce(p_payload -> k, '[]'::JSONB)) > 0;

  -- Size: records and lines in the file, and the audit rows writing them would add (each created record, line and issued invoice
  -- writes one; payments none). The time of a call follows the audit rows (docs/RELEASE.md "076", timing).
  v_size := jsonb_build_object(
    'records', (SELECT count(*) FROM _imp_parties) + (SELECT count(*) FROM _imp_stock) + (SELECT count(*) FROM _imp_quotes)
               + (SELECT count(*) FROM _imp_sales_orders) + (SELECT count(*) FROM _imp_jobs) + (SELECT count(*) FROM _imp_purchase_orders)
               + (SELECT count(*) FROM _imp_invoices) + (SELECT count(*) FROM _imp_payments),
    'lines', (SELECT count(*) FROM _imp_quote_lines) + (SELECT count(*) FROM _imp_invoice_lines),
    'audit_rows', (SELECT count(*) FROM _imp_parties WHERE action = 'create') + (SELECT count(*) FROM _imp_stock WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_quotes WHERE action = 'create') + (SELECT count(*) FROM _imp_sales_orders WHERE action = 'create')
                  + (SELECT count(*) FROM _imp_jobs WHERE action = 'create') + (SELECT count(*) FROM _imp_purchase_orders WHERE action = 'create')
                  + 2 * (SELECT count(*) FROM _imp_invoices WHERE action = 'create') + v_ql + v_il);
  v_result := jsonb_build_object('ok', v_error_n = 0, 'dry_run', v_dry_run, 'mode', p_mode, 'committed', FALSE, 'batch_id', NULL,
    'import_id', p_import_id, 'part', p_part, 'parts', p_parts, 'size', v_size, 'kinds', to_jsonb(v_present),
    'file_name', v_file, 'file_sha256', v_sha, 'counts', v_counts, 'error_count', v_error_n, 'errors', v_errors,
    'warning_count', v_warn_n, 'warnings', v_warnings, 'doc_counters', NULL);
  IF v_error_n > 0 OR p_mode = 'validate' THEN
    RETURN v_result;
  END IF;

  -- ===== Write (only with no problems at all) ======================================================================================
  -- The guards let this company's finished records in while this is set (documents_start_as_drafts, the issued-line locks).
  PERFORM set_config('quoteflow.data_import', p_org::TEXT, TRUE);

  INSERT INTO public.customers (id, organization_id, name, contact_name, email, phone, mobile, address, notes, status)
  SELECT c.new_id, p_org, c.name, c.contact_name, c.email, c.phone, c.mobile, c.address, c.notes, 'active'
  FROM _imp_parties c WHERE c.kind = 'customers' AND c.action = 'create' ORDER BY c.ord;
  -- Suppliers have no address column: an address goes into the notes.
  INSERT INTO public.suppliers (id, organization_id, name, contact_name, email, phone, notes)
  SELECT c.new_id, p_org, c.name, c.contact_name, c.email, coalesce(c.phone, c.mobile),
         nullif(concat_ws(E'\n', c.notes, CASE WHEN c.address IS NOT NULL THEN 'Address: ' || c.address END), '')
  FROM _imp_parties c WHERE c.kind = 'suppliers' AND c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.stock (id, organization_id, sku, material, current_stock, min_level, reorder_quantity, unit_price, preferred_supplier, lead_time_days, auto_purchase)
  SELECT c.new_id, p_org, c.sku, c.material, coalesce(c.current_stock, 0), coalesce(c.min_level, 0), coalesce(c.reorder_quantity, 0), c.unit_price,
         c.preferred_supplier, c.lead_time_days, coalesce(c.auto_purchase, FALSE)
  FROM _imp_stock c WHERE c.action = 'create' ORDER BY c.ord;

  INSERT INTO public.quotes (id, organization_id, quote_ref, customer, description, total_value, status, valid_until, terms, customer_notes,
                             internal_notes, vat_enabled, sent_at, accepted_at, rejected_at, created_at, updated_at)
  SELECT c.new_id, p_org, c.quote_ref, c.customer, c.description, c.total_value, c.status, c.valid_until, c.terms, c.customer_notes,
         c.internal_notes, coalesce(c.vat_enabled_given, TRUE),
         CASE WHEN c.status <> 'draft' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         CASE WHEN c.status = 'accepted' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         CASE WHEN c.status = 'rejected' THEN coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()) END,
         coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.quote_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_quotes c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt,
                                       part_number, drawing_number, drawing_revision)
  SELECT p_org, q.new_id, l.pos - 1, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt, l.part_number, l.drawing_number, l.drawing_revision
  FROM _imp_quote_lines l JOIN _imp_quotes q ON q.ord = l.q_ord WHERE q.action = 'create' ORDER BY q.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_ql THEN RAISE EXCEPTION 'import: % quote lines written, % expected', v_n, v_ql; END IF;

  -- The company's customers by normalised name (now including the ones just created): a sales order is linked to its customer when
  -- exactly one has that name.
  CREATE TEMP TABLE _imp_names ON COMMIT DROP AS
  SELECT public.import_norm_name(cu.name) AS nn, count(*)::INT AS n, (array_agg(cu.id))[1] AS id
  FROM public.customers cu WHERE cu.organization_id = p_org GROUP BY 1;
  UPDATE _imp_sales_orders s SET customer_id = n.id FROM _imp_names n WHERE n.nn = s.customer_norm AND n.n = 1 AND s.action = 'create';
  -- Its quote, when that quote has no other sales order (one per quote) and no other order in this file names it.
  UPDATE _imp_sales_orders s SET quote_id = q.id
  FROM public.quotes q
  WHERE s.action = 'create' AND q.organization_id = p_org AND q.quote_ref = s.quote_ref
    AND NOT EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.organization_id = p_org AND o.quote_id = q.id)
    AND (SELECT count(*) FROM _imp_sales_orders s2 WHERE s2.action = 'create' AND s2.quote_ref = s.quote_ref) = 1;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'sales_orders', s.row_no, 'quote_ref', 'Not linked to quote ' || s.quote_ref || ' (not found, or it already has a sales order): kept as text.'
  FROM _imp_sales_orders s WHERE s.action = 'create' AND s.quote_ref IS NOT NULL AND s.quote_id IS NULL;
  INSERT INTO public.sales_orders (id, organization_id, so_number, customer, customer_id, customer_po, quote_id, quote_ref, status, order_date,
                                   delivery_date, total_value, notes, created_at, updated_at)
  SELECT c.new_id, p_org, c.so_number, c.customer, c.customer_id, c.customer_po, c.quote_id, c.quote_ref, c.status, coalesce(c.order_date, CURRENT_DATE),
         c.delivery_date, c.total_value, c.notes,
         coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_sales_orders c WHERE c.action = 'create' ORDER BY c.ord;

  -- Jobs: linked to their quote (by number) and their sales order (number and customer, one job per order).
  UPDATE _imp_jobs j SET quote_id = q.id FROM public.quotes q WHERE j.action = 'create' AND q.organization_id = p_org AND q.quote_ref = j.quote_ref;
  UPDATE _imp_jobs j SET so_id = o.id
  FROM (SELECT so.so_number, public.import_norm_name(so.customer) AS nn, (array_agg(so.id))[1] AS id, count(*) AS n
        FROM public.sales_orders so WHERE so.organization_id = p_org GROUP BY 1, 2) o
  WHERE j.action = 'create' AND o.so_number = j.so_number AND o.nn = public.import_norm_name(j.customer) AND o.n = 1
    AND NOT EXISTS (SELECT 1 FROM public.jobs x WHERE x.converted_from_sales_order_id = o.id)
    AND (SELECT count(*) FROM _imp_jobs j2 WHERE j2.action = 'create' AND j2.so_number = j.so_number
           AND public.import_norm_name(j2.customer) = public.import_norm_name(j.customer)) = 1;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'jobs', j.row_no, 'so_number', 'Not linked to sales order ' || j.so_number || ' (not found for this customer, or it already has a job).'
  FROM _imp_jobs j WHERE j.action = 'create' AND j.so_number IS NOT NULL AND j.so_id IS NULL;
  INSERT INTO public.jobs (id, organization_id, job_no, customer, description, quote_id, quote_ref, converted_from_sales_order_id, customer_po,
                           stage, status, due_date, date_received, drawing_no, quantity_required, material_required, specification, created_at, updated_at)
  SELECT c.new_id, p_org, c.job_no, c.customer, c.description, c.quote_id, c.quote_ref, c.so_id, c.customer_po, c.stage, c.status, c.due_date,
         c.date_received, c.drawing_no, c.quantity_required, c.material_required, c.specification,
         coalesce((c.date_received + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.date_received + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_jobs c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.job_values (job_id, organization_id, value)
  SELECT c.new_id, p_org, c.value FROM _imp_jobs c WHERE c.action = 'create' AND c.value IS NOT NULL;
  -- An order created by this import points back at its job.
  UPDATE public.sales_orders so SET converted_to_job_id = j.new_id
  FROM _imp_jobs j JOIN _imp_sales_orders s ON s.new_id = j.so_id AND s.action = 'create'
  WHERE j.action = 'create' AND so.id = j.so_id AND so.organization_id = p_org AND so.converted_to_job_id IS NULL;

  INSERT INTO public.purchase_orders (id, organization_id, po_ref, po_number, supplier, order_date, expected_delivery, items, total_value, status,
                                      notes, vat_enabled, created_at, updated_at)
  SELECT c.new_id, p_org, c.po_ref, c.po_ref, c.supplier, coalesce(c.order_date, CURRENT_DATE), c.expected_delivery, '[]'::JSONB, c.total_value, c.status,
         c.notes, coalesce(c.vat_enabled, FALSE),
         coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now()), coalesce((c.order_date + TIME '12:00') AT TIME ZONE 'Europe/London', now())
  FROM _imp_purchase_orders c WHERE c.action = 'create' ORDER BY c.ord;

  -- Invoices: linked to their job by number (never an internal job).
  UPDATE _imp_invoices i SET job_id = j.id FROM public.jobs j
  WHERE i.action = 'create' AND j.organization_id = p_org AND j.job_no = i.job_no AND NOT j.is_internal;
  INSERT INTO _imp_warn (kind, row_no, field, message)
  SELECT 'invoices', i.row_no, 'job_no', 'Not linked to job ' || i.job_no || ' (not found, or an internal job).'
  FROM _imp_invoices i WHERE i.action = 'create' AND i.job_no IS NOT NULL AND i.job_id IS NULL;
  INSERT INTO public.invoices (id, organization_id, invoice_ref, customer, description, subtotal, vat, total, status, due_date, invoice_date, terms,
                               quote_ref, customer_po, job_id, vat_enabled, amount_paid, paid_at, payment_unverified, created_at, updated_at)
  SELECT c.new_id, p_org, c.invoice_ref, c.customer, c.description, c.subtotal, c.vat, c.total, c.status, c.due_date, c.invoice_date, c.terms,
         c.quote_ref, c.customer_po, c.job_id, c.vat_enabled, c.paid,
         CASE WHEN c.status = 'paid' THEN coalesce((c.last_paid_on + TIME '12:00') AT TIME ZONE 'Europe/London', (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London') END,
         c.payment_unverified,
         (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London', (c.invoice_date + TIME '12:00') AT TIME ZONE 'Europe/London'
  FROM _imp_invoices c WHERE c.action = 'create' ORDER BY c.ord;
  INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
  SELECT p_org, i.new_id, l.pos - 1, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt
  FROM _imp_invoice_lines l JOIN _imp_invoices i ON i.ord = l.i_ord WHERE i.action = 'create' ORDER BY i.ord, l.pos;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_il THEN RAISE EXCEPTION 'import: % invoice lines written, % expected', v_n, v_il; END IF;
  INSERT INTO public.invoice_payments (id, organization_id, invoice_id, amount, paid_on, method, reference, source, created_by)
  SELECT p.new_id, p_org, p.invoice_id, p.amount, p.paid_on, p.method, p.reference, 'recorded', p_uid
  FROM _imp_payments p WHERE p.action = 'create' ORDER BY p.ord;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_expect := (v_counts -> 'payments' ->> 'created')::INT;
  IF v_n <> v_expect THEN RAISE EXCEPTION 'import: % payments written, % expected', v_n, v_expect; END IF;

  PERFORM set_config('quoteflow.data_import', '', TRUE);

  -- ===== Numbering carries on after the highest PREFIX-digits number (the session's company only; a counter never moves back) =====
  -- QUO, INV, J (jobs, and quotes' QUO-n, as reseed_doc_counters), PO (po_ref and po_number), SO, DLN (delivery notes). rfqs have no
  -- number column, so RFQ has nothing to reseed from.
  INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
  SELECT p_org, v.prefix, v.n
  FROM (SELECT 'QUO' AS prefix, (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org) AS n
        UNION ALL SELECT 'INV', (SELECT max(substring(i.invoice_ref FROM '^INV-(\d{1,9})$')::INT) FROM public.invoices i WHERE i.organization_id = p_org)
        UNION ALL SELECT 'J', GREATEST((SELECT max(substring(j.job_no FROM '^J-(\d{1,9})$')::INT) FROM public.jobs j WHERE j.organization_id = p_org),
                                       (SELECT max(substring(q.quote_ref FROM '^QUO-(\d{1,9})$')::INT) FROM public.quotes q WHERE q.organization_id = p_org))
        UNION ALL SELECT 'PO', GREATEST((SELECT max(substring(po.po_ref FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org),
                                        (SELECT max(substring(po.po_number FROM '^PO-(\d{1,9})$')::INT) FROM public.purchase_orders po WHERE po.organization_id = p_org))
        UNION ALL SELECT 'SO', (SELECT max(substring(so.so_number FROM '^SO-(\d{1,9})$')::INT) FROM public.sales_orders so WHERE so.organization_id = p_org)
        UNION ALL SELECT 'DLN', (SELECT max(substring(dn.dn_number FROM '^DLN-(\d{1,9})$')::INT) FROM public.delivery_notes dn WHERE dn.organization_id = p_org)) v
  WHERE v.n IS NOT NULL
  ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last, EXCLUDED.last);
  SELECT coalesce(jsonb_object_agg(dc.prefix, dc.last ORDER BY dc.prefix), '{}'::JSONB) INTO v_counters
    FROM public.doc_counters dc WHERE dc.organization_id = p_org;

  -- Warnings found while writing (links not made) are part of the answer.
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('kind', w.kind, 'row', w.row_no, 'field', w.field, 'message', w.message) ORDER BY w.seq)
                              FILTER (WHERE w.seq_rank <= 500), '[]'::JSONB)
    INTO v_warn_n, v_warnings
    FROM (SELECT w2.*, row_number() OVER (ORDER BY w2.seq) AS seq_rank FROM _imp_warn w2) w;
  v_result := v_result || jsonb_build_object('doc_counters', v_counters, 'warning_count', v_warn_n, 'warnings', v_warnings);
  IF p_mode = 'dry_run' THEN
    RETURN v_result;
  END IF;

  -- ===== Commit: the batch, the keys of every created record, the audit event ======================================================
  v_result := v_result || jsonb_build_object('committed', TRUE, 'batch_id', p_batch);
  INSERT INTO public.import_batches (id, organization_id, client_op_id, import_id, large, part, parts, created_by, file_name, file_sha256,
                                     request_sha256, kinds, counts, errors, warnings, result, status)
  VALUES (p_batch, p_org, p_client_op_id, p_import_id, p_import_id IS NOT NULL, p_part, p_parts, p_uid, v_file, v_sha,
          p_request, v_present, v_counts, '[]'::JSONB, v_warnings, v_result, 'committed');
  INSERT INTO public.import_record_keys AS k (organization_id, kind, match_key, record_id, batch_id, audit_rows)
  SELECT p_org, y.kind, y.match_key, y.new_id, p_batch,
         (SELECT count(*) FROM security_audit.audit_log a
          WHERE a.organization_id = p_org AND a.entity_table = CASE y.kind WHEN 'payments' THEN 'invoice_payments' ELSE y.kind END
            AND a.entity_id = y.new_id::TEXT)
  FROM (SELECT kind, match_key, new_id FROM _imp_parties WHERE action = 'create'
        UNION ALL SELECT 'stock', match_key, new_id FROM _imp_stock WHERE action = 'create'
        UNION ALL SELECT 'quotes', match_key, new_id FROM _imp_quotes WHERE action = 'create'
        UNION ALL SELECT 'sales_orders', match_key, new_id FROM _imp_sales_orders WHERE action = 'create'
        UNION ALL SELECT 'jobs', match_key, new_id FROM _imp_jobs WHERE action = 'create'
        UNION ALL SELECT 'purchase_orders', match_key, new_id FROM _imp_purchase_orders WHERE action = 'create'
        UNION ALL SELECT 'invoices', match_key, new_id FROM _imp_invoices WHERE action = 'create'
        UNION ALL SELECT 'payments', match_key, new_id FROM _imp_payments WHERE action = 'create') y
  -- A key whose record has since been removed (e.g. a customer deleted by hand) now names the new record.
  ON CONFLICT (organization_id, kind, match_key) DO UPDATE SET record_id = EXCLUDED.record_id, batch_id = EXCLUDED.batch_id,
                                                                audit_rows = EXCLUDED.audit_rows, created_at = clock_timestamp();
  PERFORM security_audit.log_named_event(p_org, 'IMPORT_COMMITTED', 'import_batches', p_batch::TEXT,
    jsonb_build_object('file_name', v_file, 'file_sha256', v_sha, 'counts', v_counts, 'client_op_id', p_client_op_id, 'warning_count', v_warn_n,
                       'large', p_import_id IS NOT NULL, 'import_id', p_import_id, 'part', p_part, 'parts', p_parts));
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.import_company_data_run(UUID, UUID, UUID, JSONB, TEXT, UUID, TEXT, UUID, INT, INT) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: the body is 079's, none of its UPDATE / DELETE statements lacks its own WHERE (the same check as
-- supabase/verify/import_safeupdate_079.sql), and the API can't call it directly.
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)');
  IF v_md5 IS DISTINCT FROM 'f7c672e961be898619c046d76458680e' THEN
    RAISE EXCEPTION '079: import_company_data_run is not 079''s after the replace (md5 %)', v_md5;
  END IF;
  IF EXISTS (
    WITH RECURSIVE stmt AS (
      SELECT s.n, s.t FROM pg_proc p,
        LATERAL regexp_split_to_table(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), ';') WITH ORDINALITY AS s(t, n)
      WHERE p.oid = to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)')
    ),
    occ AS (
      SELECT stmt.n, k, substring(stmt.t FROM regexp_instr(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, k, 0, 'i')) AS t
      FROM stmt, LATERAL generate_series(1, regexp_count(stmt.t, '\m(?:UPDATE\s+(?:ONLY\s+)?[[:alnum:]_.%"]+(?:\s+(?:AS\s+)?[[:alnum:]_]+)?\s+SET|DELETE\s+FROM)\M', 1, 'i')) AS k
    ),
    flat(n, k, t, i) AS (
      SELECT n, k, t, 0 FROM occ
      UNION ALL SELECT n, k, regexp_replace(t, '\([^()]*\)', ' ', 'g'), i + 1 FROM flat WHERE t ~ '\([^()]*\)' AND i < 50
    )
    SELECT 1 FROM flat x
    WHERE NOT EXISTS (SELECT 1 FROM flat y WHERE y.n = x.n AND y.k = x.k AND y.i > x.i)
      AND split_part(x.t, ')', 1) !~* '\mWHERE\M'
  ) THEN
    RAISE EXCEPTION '079: import_company_data_run still has an UPDATE or DELETE without its own WHERE';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)'), 'EXECUTE') THEN
    RAISE EXCEPTION '079: import_company_data_run is callable from the API';
  END IF;
END
$$;
