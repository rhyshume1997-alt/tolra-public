-- Local proof for migration 134 (the job sheet names the customer's PO, not the sales order). Run on a COPY of a database with the
-- chain applied, once at 080's body and once with 134 (it leaves a proof schema and synthetic rows behind):
--   createdb p_before -T base; psql -d p_before -f this > before.out
--   createdb p_after -T base; psql -d p_after -f supabase/release/134_job_spec_customer_po.release.sql; psql -d p_after -f this > after.out
--   diff before.out after.out    -- only the spec column (and ok_now) of the PO cases may differ; every "rest" md5 is the same
-- The same inputs on both: one synthetic company, its users, quotes and sales orders, converted as the office user (the API's role).
-- Per case: the job's specification, the wording 080 and 134 each give (ok_080 / ok_134), and an md5 of everything else the
-- conversion writes or returns (the job row without its specification, ids and clock times; its value; its files; the order).
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS proof CASCADE; CREATE SCHEMA proof;
CREATE TABLE proof.ids (k TEXT PRIMARY KEY, v UUID);
CREATE TABLE proof.res (k TEXT PRIMARY KEY, so UUID, result JSONB, err TEXT);
GRANT USAGE ON SCHEMA proof TO authenticated, service_role; GRANT ALL ON ALL TABLES IN SCHEMA proof TO authenticated, service_role;
DO $$
DECLARE o UUID := gen_random_uuid(); r TEXT; u UUID; qa UUID; qc UUID; qd UUID; qh UUID;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES (o, 'Proof Co', 'proof-' || left(o::text, 8));
  FOREACH r IN ARRAY ARRAY['office', 'workshop'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, r || '-' || left(u::text, 8) || '@example.test');
    INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES (u, r || '-' || left(u::text, 8) || '@example.test', r, o)
      ON CONFLICT (id) DO UPDATE SET organization_id = o, role = r;
    INSERT INTO public.organization_members (user_id, organization_id, role) VALUES (u, o, r) ON CONFLICT DO NOTHING;
    INSERT INTO proof.ids VALUES ('u_' || r, u);
  END LOOP;
  -- Quotes (drafts): A has two ordered lines, a declined one and a drawing file; C has a PO on the quote only; D has no PO; H is accepted below.
  INSERT INTO public.quotes (organization_id, quote_ref, customer, total_value) VALUES (o, 'QUO-9001', 'Acme', 100) RETURNING id INTO qa;
  INSERT INTO public.quotes (organization_id, quote_ref, customer, total_value, customer_po) VALUES (o, 'QUO-9003', 'Acme', 50, 'PO-C1') RETURNING id INTO qc;
  INSERT INTO public.quotes (organization_id, quote_ref, customer, total_value) VALUES (o, 'QUO-9004', 'Acme', 50) RETURNING id INTO qd;
  INSERT INTO public.quotes (organization_id, quote_ref, customer, total_value, customer_po) VALUES (o, 'QUO-9008', 'Acme', 72, 'PO-H1') RETURNING id INTO qh;
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, part_number, drawing_number, drawing_revision, declined) VALUES
    (o, qa, 1, 'Flange 80mm', 12, 5, 'FL-80', 'DWG-1', 'B', FALSE), (o, qa, 2, 'Spacer', 4, 10, NULL, NULL, NULL, FALSE),
    (o, qa, 3, 'Bush (declined)', 3, 1, NULL, NULL, NULL, TRUE),
    (o, qc, 1, 'Shaft', 5, 10, 'SH-1', NULL, NULL, FALSE),
    (o, qd, 1, 'Pin', 1.5, 10, NULL, 'DP-7', 'D', FALSE),
    (o, qh, 1, 'Collar', 6, 10, NULL, NULL, NULL, FALSE);
  INSERT INTO public.quote_attachments (organization_id, quote_ref, file_path, file_name) VALUES (o, 'QUO-9001', o::text || '/QUO-9001/dwg-1.pdf', 'dwg-1.pdf');
  -- Sales orders, one per case.
  --   A: PO on the order, reference = the PO (the accept path's rule), quote with lines, delivery date.
  --   B: PO on the order, reference an SO number (the PO arrived later or was typed apart), no quote, no delivery date.
  --   C: no PO on the order, the quote has one.   D: no PO anywhere, quote with lines.   E: no PO, no quote.
  --   F: PO with surrounding spaces (trimmed).    G: PO '' (none).
  INSERT INTO public.sales_orders (organization_id, so_number, customer, customer_po, quote_id, quote_ref, status, order_date, delivery_date, total_value) VALUES
    (o, 'PO-A1', 'Acme', 'PO-A1', qa, 'QUO-9001', 'open', '2026-10-09', '2026-11-20', 100),
    (o, 'SO-0902', 'Acme', 'PO-B1', NULL, NULL, 'open', '2026-10-10', NULL, 20),
    (o, 'SO-0903', 'Acme', NULL, qc, 'QUO-9003', 'open', '2026-10-11', '2026-12-01', 50),
    (o, 'SO-0904', 'Acme', NULL, qd, 'QUO-9004', 'open', '2026-10-12', '2026-12-02', 50),
    (o, 'SO-0905', 'Acme', NULL, NULL, NULL, 'confirmed', '2026-10-13', NULL, 0),
    (o, 'SO-0906', 'Acme', '  PO-F1 ', NULL, NULL, 'open', '2026-10-14', '2026-12-03', 10),
    (o, 'SO-0907', 'Acme', '', NULL, NULL, 'open', '2026-10-15', NULL, 10);
  INSERT INTO proof.ids SELECT 'so_' || x.k, s.id FROM public.sales_orders s
    JOIN (VALUES ('A', 'PO-A1'), ('B', 'SO-0902'), ('C', 'SO-0903'), ('D', 'SO-0904'), ('E', 'SO-0905'), ('F', 'SO-0906'), ('G', 'SO-0907')) x(k, n)
      ON s.so_number = x.n WHERE s.organization_id = o;
  INSERT INTO proof.ids VALUES ('o', o), ('qh', qh);
END $$;
CREATE FUNCTION proof.id(k TEXT) RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT v FROM proof.ids WHERE ids.k = $1 $$;
GRANT EXECUTE ON FUNCTION proof.id(TEXT) TO authenticated, service_role;
CREATE FUNCTION proof.as_user(r TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', proof.id('u_' || r), 'role', 'authenticated', 'aal', 'aal1')::text, false) $$;
CREATE FUNCTION proof.convert(p_k TEXT, p_so UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proof.res (k, so, result) VALUES (p_k, p_so, public.convert_sales_order(p_so));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO proof.res (k, so, err) VALUES (p_k, p_so, SQLSTATE || ' ' || SQLERRM);
END $$;
GRANT EXECUTE ON FUNCTION proof.convert(TEXT, UUID) TO authenticated;

-- ---- as the workshop user: refused (unchanged) ----
SELECT proof.as_user('workshop'); SET ROLE authenticated;
SELECT proof.convert('W_refused', proof.id('so_A'));
-- ---- as the office user, in a fixed order (job numbers come from the company's counter) ----
RESET ROLE; SELECT proof.as_user('office'); SET ROLE authenticated;
SELECT proof.convert(k, proof.id('so_' || k)) FROM unnest(ARRAY['A', 'B', 'C', 'D', 'E', 'F', 'G']) k ORDER BY k;
-- A again: already converted, the same job back, nothing changed.
SELECT proof.convert('A_again', proof.id('so_A'));
-- H: the accept path (create_sales_order_from_quote, 123): no PO typed in the dialog, the quote's PO is taken and becomes the reference.
-- When the company converts accepted orders on its own, accept_quote makes the job; otherwise the office converts the order.
CREATE TEMP TABLE acc AS SELECT public.accept_quote(proof.id('qh'), NULL, '2026-12-09', NULL) AS r;
SELECT proof.convert('H', ((SELECT r ->> 'so_id' FROM acc))::UUID) WHERE (SELECT coalesce((r ->> 'job_created')::BOOLEAN, FALSE) FROM acc) IS FALSE;
RESET ROLE;
INSERT INTO proof.res (k, so, result)
  SELECT 'H', (r ->> 'so_id')::UUID, jsonb_build_object('job_id', r -> 'job_id', 'job_no', r -> 'job_no', 'created', r -> 'job_created')
  FROM acc WHERE coalesce((r ->> 'job_created')::BOOLEAN, FALSE) ON CONFLICT (k) DO NOTHING;

-- ---- the report: one row per case ----
WITH o AS (SELECT proof.id('o') AS id),
expected(k, spec_080, spec_134) AS (VALUES
  ('A', E'Sales order PO-A1; customer delivery required 20/11/2026.\nQUO-9001:\n- Flange 80mm [Part FL-80; Dwg DWG-1 rev B] x 12\n- Spacer x 4',
        E'Customer PO PO-A1; customer delivery required 20/11/2026.\nQUO-9001:\n- Flange 80mm [Part FL-80; Dwg DWG-1 rev B] x 12\n- Spacer x 4'),
  ('A_again', E'Sales order PO-A1; customer delivery required 20/11/2026.\nQUO-9001:\n- Flange 80mm [Part FL-80; Dwg DWG-1 rev B] x 12\n- Spacer x 4',
              E'Customer PO PO-A1; customer delivery required 20/11/2026.\nQUO-9001:\n- Flange 80mm [Part FL-80; Dwg DWG-1 rev B] x 12\n- Spacer x 4'),
  ('B', 'Sales order SO-0902.', 'Customer PO PO-B1.'),
  ('C', E'Sales order SO-0903; customer delivery required 01/12/2026.\nQUO-9003:\n- Shaft [Part SH-1] x 5',
        E'Customer PO PO-C1; customer delivery required 01/12/2026.\nQUO-9003:\n- Shaft [Part SH-1] x 5'),
  ('D', E'Sales order SO-0904; customer delivery required 02/12/2026.\nQUO-9004:\n- Pin [Dwg DP-7 rev D] x 1.5',
        E'Sales order SO-0904; customer delivery required 02/12/2026.\nQUO-9004:\n- Pin [Dwg DP-7 rev D] x 1.5'),
  ('E', 'Sales order SO-0905.', 'Sales order SO-0905.'),
  ('F', 'Sales order SO-0906; customer delivery required 03/12/2026.', 'Customer PO PO-F1; customer delivery required 03/12/2026.'),
  ('G', 'Sales order SO-0907.', 'Sales order SO-0907.'),
  ('H', E'Sales order PO-H1; customer delivery required 09/12/2026.\nQUO-9008:\n- Collar x 6',
        E'Customer PO PO-H1; customer delivery required 09/12/2026.\nQUO-9008:\n- Collar x 6'),
  ('W_refused', NULL, NULL)),
rows AS (
  SELECT r.k, j.specification AS spec, e.spec_080, e.spec_134,
    jsonb_build_object(
      'result', r.result - 'job_id', 'job_is_returned', (r.result ->> 'job_id')::UUID IS NOT DISTINCT FROM j.id, 'err', r.err,
      'job', to_jsonb(j) - ARRAY['id', 'organization_id', 'specification', 'created_at', 'updated_at', 'converted_at', 'converted_from_sales_order_id',
                                  'quote_id', 'created_by', 'updated_by', 'worksheet_version'],
      'job_quote_is_order_quote', j.quote_id IS NOT DISTINCT FROM s.quote_id,
      'job_values', (SELECT jsonb_agg(v.value) FROM public.job_values v WHERE v.job_id = j.id),
      'job_files', (SELECT jsonb_agg(jsonb_build_array(f.kind, f.ref, f.file_name, f.storage_bucket, replace(f.storage_path, (SELECT id::text FROM o), 'ORG'))
                                     ORDER BY f.storage_path) FROM public.job_files f WHERE f.job_id = j.id),
      'order', jsonb_build_object('status', s.status, 'so_number', s.so_number, 'customer_po', s.customer_po, 'linked', s.converted_to_job_id IS NOT DISTINCT FROM j.id),
      'jobs_for_order', (SELECT count(*) FROM public.jobs x WHERE x.converted_from_sales_order_id = r.so)) AS rest
  FROM proof.res r
  JOIN expected e ON e.k = r.k
  LEFT JOIN public.sales_orders s ON s.id = r.so
  LEFT JOIN public.jobs j ON j.id = (r.result ->> 'job_id')::UUID
)
SELECT k AS case_key, spec, spec IS NOT DISTINCT FROM spec_080 AS ok_080, spec IS NOT DISTINCT FROM spec_134 AS ok_134,
  md5(rest::text) AS rest_md5, rest::text AS rest
FROM rows ORDER BY k;
