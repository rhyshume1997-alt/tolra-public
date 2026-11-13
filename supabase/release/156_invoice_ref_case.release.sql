-- Post-144 release step 156 (invoice numbers unique per company whatever their capital letters; registered in supabase/release-plan.json
-- as phase 156, after 154; 155 is reserved and not in this candidate; CI's post-144 step installs it). One transaction; never part of
-- baseline replay. Not applied anywhere hosted. Canonical source: supabase/proposals/p156_invoice_ref_case.sql (its body between BEGIN;
-- and COMMIT; is copied below verbatim between the fingerprint and the self-check; read its header). Its guard needs 152 (the SliQ
-- route) and 078 (next_doc_number) only, not 153 or 154. Apply BEFORE the JNR SliQ import. Production only with Rhys's separate yes.
-- Verify: supabase/verify/invoice_ref_case_156.sql (every row true).
-- Rollback: supabase/release/156_invoice_ref_case.rollback.sql (run it BEFORE 152's or 078's rollback; 078's refuses while 156's
-- next_doc_number is in place). Running this file again once applied changes nothing (the index exists; the bodies are 156's).
-- REFUSES, changing nothing, while any company has invoice numbers that differ only in capital letters (HINT invoice_ref_case_duplicates).
-- Before applying, Rhys runs this READ-ONLY finder (SQL editor; BEGIN TRANSACTION READ ONLY makes any write fail). It must return no row;
-- if it returns any, stop: Rhys or PM decide each pair (e.g. that batch's import undo); 156 never deletes, renames or merges an invoice.
--   BEGIN TRANSACTION READ ONLY;
--   SELECT i.organization_id, o.name AS company, lower(i.invoice_ref) AS number_key, count(*) AS invoices,
--          string_agg(i.invoice_ref || ' [' || coalesce(i.status, 'draft') || ', ' || coalesce(i.total::text, '-') || ', ' || i.id || ']', '; ' ORDER BY i.invoice_ref, i.created_at) AS refs
--   FROM public.invoices i JOIN public.organizations o ON o.id = i.organization_id
--   WHERE i.invoice_ref IS NOT NULL
--   GROUP BY i.organization_id, o.name, lower(i.invoice_ref)
--   HAVING count(DISTINCT i.invoice_ref) > 1
--   ORDER BY o.name, number_key;
--   ROLLBACK;
-- Release preflight row 59 shows the same count (and which bodies are in place).
BEGIN;
DO $post_release_guard$
DECLARE
  v        TEXT;
  v_groups BIGINT;
  v_list   TEXT;
BEGIN
 IF to_regclass('public.import_source_rows') IS NULL OR to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)') IS NULL
    OR to_regprocedure('public.import_sliq_reconcile_rows(uuid)') IS NULL THEN
  RAISE EXCEPTION '156: required release 152 (SliQ import route) is missing; stop and check release preflight';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)');
 IF v IS DISTINCT FROM 'a35a5a70fac350a7e662dd28dd324d80' AND v IS DISTINCT FROM 'a06f5525bb6770dde21c4f9453b96207' THEN
  RAISE EXCEPTION '156: public.import_sliq_prepare is neither 152''s nor 156''s; stop and compare it first';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_reconcile_rows(uuid)');
 IF v IS DISTINCT FROM '315952a95ce42c75078e94026069121b' AND v IS DISTINCT FROM '3288cdc2d98acba018c8e417bddd77bb' THEN
  RAISE EXCEPTION '156: public.import_sliq_reconcile_rows is neither 152''s nor 156''s; stop and compare it first';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)');
 IF v IS DISTINCT FROM 'c5af802da68d4236a36db71098036acf' AND v IS DISTINCT FROM '75dffec8a6b52c01267aa22a64802da0' THEN
  RAISE EXCEPTION '156: public.next_doc_number is neither 078''s nor 156''s; stop and compare it first';
 END IF;
 IF to_regclass('public.invoices_invoice_ref_ci_uniq') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.invoices_invoice_ref_ci_uniq') AND i.indrelid = 'public.invoices'::regclass
                      AND i.indisunique AND i.indisvalid AND i.indisready
                      AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX invoices_invoice_ref_ci_uniq ON public.invoices USING btree (organization_id, lower(invoice_ref))') THEN
  RAISE EXCEPTION '156: an index named invoices_invoice_ref_ci_uniq exists but is not 156''s valid unique index; stop and compare it first';
 END IF;
 -- The same lock the index build takes, held from here to COMMIT: no invoice number can change between this check and the build.
 LOCK TABLE public.invoices IN SHARE MODE;
 SELECT count(*), string_agg(g.org || ': ' || g.refs, '; ' ORDER BY g.org, g.k) FILTER (WHERE g.rn <= 20) INTO v_groups, v_list
 FROM (SELECT x.organization_id::TEXT AS org, x.k, x.refs, row_number() OVER (ORDER BY x.organization_id, x.k) AS rn
       FROM (SELECT i.organization_id, lower(i.invoice_ref) AS k, string_agg(i.invoice_ref, ', ' ORDER BY i.invoice_ref COLLATE "C") AS refs
             FROM public.invoices i WHERE i.invoice_ref IS NOT NULL
             GROUP BY i.organization_id, lower(i.invoice_ref) HAVING count(DISTINCT i.invoice_ref) > 1) x) g;
 IF v_groups > 0 THEN
  RAISE EXCEPTION '156: % group(s) of invoice numbers differ only in capital letters (first 20, company id: numbers): %. Nothing was changed.', v_groups, v_list
    USING HINT = 'invoice_ref_case_duplicates',
          DETAIL = 'Run the read-only finder in this file''s header; Rhys or PM decide each pair (156 never deletes, renames or merges an invoice), then apply 156 again.';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of the money and numbering rows 156 must not touch (invoices, payments, credit allocations, credit notes, counters)
-- and of every other index on invoices. The self-check requires the identical fingerprint. Session-only helper, dropped before COMMIT.
CREATE FUNCTION pg_temp.p156_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p156fp$
  SELECT 'invoices'::TEXT, md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.invoices x
  UNION ALL SELECT 'invoice_payments', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.invoice_payments x
  UNION ALL SELECT 'invoice_credit_allocations', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.invoice_credit_allocations x
  UNION ALL SELECT 'credit_notes', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.credit_notes x
  UNION ALL SELECT 'doc_counters', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.organization_id, x.prefix), '')) FROM public.doc_counters x
  UNION ALL SELECT 'invoice indexes', md5(coalesce(string_agg(pg_get_indexdef(i.indexrelid), E'\n' ORDER BY pg_get_indexdef(i.indexrelid)), ''))
  FROM pg_index i WHERE i.indrelid = 'public.invoices'::regclass AND i.indexrelid IS DISTINCT FROM to_regclass('public.invoices_invoice_ref_ci_uniq')
$p156fp$;
CREATE TEMP TABLE p156_before ON COMMIT DROP AS SELECT * FROM pg_temp.p156_fingerprint();

-- ---- 1. One invoice number per company, whatever its capital letters --------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS invoices_invoice_ref_ci_uniq ON public.invoices (organization_id, lower(invoice_ref));

-- ---- 2. The SliQ route refuses a case variant before anything is written (152's body plus the 156 block) -----------------------
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
  v_case TEXT;
  v_n BIGINT;
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
  -- 156: an invoice number that differs only in capital letters from one Tolra already has in this company (inv-1001 next to
  -- INV-1001), or from another new invoice row of this payload, is refused (invoice_ref_case_duplicate). Unmapped invoice rows only,
  -- with the number as 085 will store it (import_clean_record). Exact equality is left to 076's match (map_diverged), unchanged.
  -- The preflight lists these rows with every other problem; a batch (dry run or commit) refuses before 076 is called, so nothing
  -- is written and the batch is not recorded (a corrected retry under the same key goes through). Reads the company's invoices
  -- through invoices_invoice_ref_ci_uniq (organization_id, lower(invoice_ref)), which is also the guarantee for every other path.
  INSERT INTO _sliq_err (kind, source_row_id, field, message, code)
  WITH r AS MATERIALIZED (
      SELECT i.kind, i.ord, i.source_row_id, public.import_clean_record(i.rec) ->> 'invoice_ref' AS ref
      FROM _sliq_in i WHERE i.kind = 'invoices' AND NOT i.mapped AND i.obj),
    in_file AS (
      SELECT lower(r.ref) AS k, string_agg(DISTINCT r.ref COLLATE "C", ', ' ORDER BY r.ref COLLATE "C") AS refs FROM r WHERE r.ref IS NOT NULL
      GROUP BY lower(r.ref) HAVING count(DISTINCT r.ref) > 1)
  SELECT x.kind, x.source_row_id, 'invoice_ref', x.message, 'invoice_ref_case_duplicate'
  FROM (SELECT r.kind, r.ord, 1 AS o, r.source_row_id,
               'Tolra already has invoice ' || t.invoice_ref || '; ' || r.ref || ' differs only in capital letters. Nothing in this batch was written.' AS message
        FROM r
        CROSS JOIN LATERAL (SELECT v.invoice_ref FROM public.invoices v
                            WHERE v.organization_id = p_org AND lower(v.invoice_ref) = lower(r.ref) AND v.invoice_ref <> r.ref
                            ORDER BY v.invoice_ref LIMIT 1) t
        WHERE r.ref IS NOT NULL
        UNION ALL
        SELECT r.kind, r.ord, 2, r.source_row_id,
               'This file has invoice numbers ' || f.refs || ', which differ only in capital letters. Nothing in this batch was written.'
        FROM r JOIN in_file f ON f.k = lower(r.ref)) x
  ORDER BY x.ord, x.o;
  IF p_label <> 'preflight' THEN
    SELECT e.message, count(*) OVER () INTO v_case, v_n FROM _sliq_err e WHERE e.code = 'invoice_ref_case_duplicate' ORDER BY e.seq LIMIT 1;
    IF v_case IS NOT NULL THEN
      RAISE EXCEPTION '%', v_case || CASE WHEN v_n > 1 THEN ' (' || v_n || ' invoice rows in this batch differ only in capital letters from another invoice number.)' ELSE '' END
        USING ERRCODE = '22023', HINT = 'invoice_ref_case_duplicate';
    END IF;
  END IF;
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

-- ---- 3. Numbering: an invoice number is taken whatever its capital letters (078's body, one line changed) ----------------------
-- The 058 body, plus 'CRD' (admin, office; a number already used as a credit_ref is skipped). For 'CRD' the counter is first moved
-- past the highest CRD-n or CN-n credit note number the company has (read at every call; a counter never moves back).
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
  floor_n  INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ', 'DLN', 'CN', 'SO', 'CRD') THEN
    RAISE EXCEPTION 'invalid document prefix' USING ERRCODE = '22023';
  END IF;

  -- You can only take numbers for documents you are allowed to create (a viewer cannot burn numbers).
  IF NOT public.has_org_role(CASE p_prefix
        WHEN 'INV' THEN ARRAY['admin', 'office']
        WHEN 'J'   THEN ARRAY['admin', 'office', 'workshop']
        WHEN 'DLN' THEN ARRAY['admin', 'office', 'workshop']
        ELSE            ARRAY['admin', 'office']
      END) THEN
    RAISE EXCEPTION 'not authorised for % numbers', p_prefix USING ERRCODE = '42501';
  END IF;

  -- 078: credit notes carry on after the highest credit note number the company already has (CRD-n, or CN-n from before 078), so a
  -- credit note loaded or recorded after the counter was made still moves it on. Other prefixes: floor 0, exactly as before.
  IF p_prefix = 'CRD' THEN
    SELECT coalesce(max(substring(cn.credit_ref FROM '^(?:CRD|CN)-(\d{1,9})$')::INT), 0) INTO floor_n
    FROM public.credit_notes cn
    WHERE cn.organization_id = org AND cn.credit_ref ~ '^(CRD|CN)-\d{1,9}$';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, floor_n + 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = GREATEST(c.last + 1, EXCLUDED.last)
    RETURNING c.last INTO n;

    -- lpad() would truncate numbers above 9999, so only pad short numbers.
    result := p_prefix || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;

    -- Skip numbers that already exist (rows imported or seeded after the counters were seeded, or jobs that
    -- took a quote's number). Counters only move forward, so a skipped number is simply never reused.
    taken := CASE p_prefix
      WHEN 'QUO' THEN EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = result)
      WHEN 'INV' THEN EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND lower(invoice_ref) = lower(result))  -- 156: any capitalisation
      WHEN 'J'   THEN EXISTS (SELECT 1 FROM public.jobs     WHERE organization_id = org AND job_no = result)
                   OR EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = 'QUO' || substr(result, 2))
      WHEN 'DLN' THEN EXISTS (SELECT 1 FROM public.delivery_notes WHERE organization_id = org AND dn_number = result)
      WHEN 'CN'  THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
      WHEN 'CRD' THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
      WHEN 'SO'  THEN EXISTS (SELECT 1 FROM public.sales_orders WHERE organization_id = org AND so_number = result)
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

-- ---- 4. Reconciliation rows: duplicate invoice numbers counted whatever their capital letters (152's body, one line changed) -----
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
  -- Linear: one row per normalised name (how many customers have it, and the key when exactly one does), hash-joined to each
  -- invoice's normalised customer name (computed once per invoice).
  cust_by_name AS (
    SELECT ck.nn, count(1) AS n, min(ck.k) AS k FROM cust_key ck GROUP BY ck.nn
  ),
  inv_key AS (
    SELECT d.id, CASE WHEN cb.n = 1 THEN cb.k
                      ELSE 'unresolved:' || lower(btrim(coalesce(d.customer, ''))) END AS k
    FROM (SELECT d0.id, d0.customer, public.import_norm_name(d0.customer) AS nn FROM inv_due d0) d
    LEFT JOIN cust_by_name cb ON cb.nn = d.nn
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
  -- 156: invoice numbers that differ only in capital letters are one number (as invoices_invoice_ref_ci_uniq).
  dup_inv_ref AS (
    SELECT lower(invoice_ref) AS k, count(1) AS n FROM inv GROUP BY 1 HAVING count(1) > 1
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

DO $p156_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.invoices_invoice_ref_ci_uniq') AND i.indrelid = 'public.invoices'::regclass
                   AND i.indisunique AND i.indisvalid AND i.indisready
                   AND pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX invoices_invoice_ref_ci_uniq ON public.invoices USING btree (organization_id, lower(invoice_ref))') THEN
    RAISE EXCEPTION '156 self-check: invoices_invoice_ref_ci_uniq must be the valid unique index on (organization_id, lower(invoice_ref))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)')
                   AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a06f5525bb6770dde21c4f9453b96207' AND p.prosrc LIKE '%invoice_ref_case_duplicate%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '75dffec8a6b52c01267aa22a64802da0')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.import_sliq_reconcile_rows(uuid)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '3288cdc2d98acba018c8e417bddd77bb') THEN
    RAISE EXCEPTION '156 self-check: import_sliq_prepare, next_doc_number and import_sliq_reconcile_rows must be 156''s';
  END IF;
  -- Grants and definer flags as before: the two 152 helpers callable by no API role, invoker, pinned; next_doc_number definer, pinned,
  -- signed-in users only; still exactly 152's three callable import functions.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.import_sliq_prepare(uuid,text,jsonb,text)', 'public.import_sliq_reconcile_rows(uuid)']) AS f(sig),
                    unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
             WHERE has_function_privilege(r.role, to_regprocedure(f.sig), 'EXECUTE'))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.import_sliq_prepare(uuid,text,jsonb,text)'), to_regprocedure('public.import_sliq_reconcile_rows(uuid)'))
                  AND (p.prosecdef OR p.proconfig IS NULL))
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.next_doc_number(text)') AND p.prosecdef AND p.proconfig IS NOT NULL)
     OR NOT has_function_privilege('authenticated', 'public.next_doc_number(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.next_doc_number(text)', 'EXECUTE')
     OR (SELECT count(*) FROM pg_proc p WHERE (p.proname LIKE 'import_sliq%' OR p.proname LIKE 'import_source%') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 3 THEN
    RAISE EXCEPTION '156 self-check: function grants or definer settings are not as before';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.invoice_ref IS NOT NULL GROUP BY i.organization_id, lower(i.invoice_ref) HAVING count(DISTINCT i.invoice_ref) > 1) THEN
    RAISE EXCEPTION '156 self-check: invoice numbers that differ only in capital letters exist';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p156_before EXCEPT SELECT * FROM pg_temp.p156_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p156_fingerprint() EXCEPT SELECT * FROM pg_temp.p156_before) THEN
    RAISE EXCEPTION '156 self-check: an invoice, payment, credit allocation, credit note, counter or other invoice index changed';
  END IF;
END
$p156_self_check$;
DROP TABLE pg_temp.p156_before;
DROP FUNCTION pg_temp.p156_fingerprint();
COMMIT;
