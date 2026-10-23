-- =====================================================================================================
-- 080: the Activity log names each record by its own number, an Accept line names its quote, and a job made from a sales order is
-- described by the quote's work (Rhys, production Activity log after QUO-0009 was accepted: sales order SO-0002, job J-0010).
-- Needs 068 (quote_line_items.declined, convert_sales_order) and 035 (org_activity). Independent of 075 to 079 (any order).
--
-- PROBLEM 1. The job and the sales order made from QUO-0009 read "Job QUO-0009" and "Sales order QUO-0009". org_activity (035, the
-- admin Activity page) labels a row with security_audit.activity_label(row) (013), the first of quote_ref, invoice_ref, so_number,
-- po_ref, po_number, dn_number, job_no, ... that the row carries. A job and a sales order carry their quote's quote_ref, so they took
-- the quote's number; an invoice with a quote_ref took the quote's too, and a delivery note with an invoice_ref the invoice's.
-- PROBLEM 2. The quote's Accept line had no number. accept_quote's ACCEPT (068) is a named event (security_audit.log_named_event,
-- 035): its details are in metadata and its old/new data are empty, so the label (taken from the row data) is empty. The app fixes
-- that itself (lib/activity.ts recordLabel: the record's own number from the event's metadata); this file doesn't change it.
-- PROBLEM 3. convert_sales_order (068) describes the job it makes 'Converted from SO-0002': the job board shows that, not the work.
--
-- WHAT CHANGES.
-- 1. security_audit.activity_label(p_table, p_row), new: a row of quotes, invoices, credit_notes, sales_orders, purchase_orders,
--    delivery_notes or jobs is named by its own table's number (quote_ref, invoice_ref, credit_ref, so_number, po_ref / po_number,
--    dn_number, job_no), else by its name / full_name / email / file_name / description (never another document's number); any
--    other table exactly as activity_label(p_row), which stays as it is. Internal: no API role may call it.
-- 2. public.org_activity: 035's body byte for byte except that call (activity_label(a.entity_table, ...)). Same signature, RETURNS,
--    SECURITY DEFINER, search_path, admin-only check, redaction, filters and grants: who sees what is unchanged. Child rows (lines,
--    attachments, bookings) keep their record's number as before.
-- 3. public.convert_sales_order: 068's body byte for byte except the job's description: the quote's distinct ordered (not declined)
--    line descriptions in line order, joined with '; ', cut at 300 characters; 'Converted from SO-...' as before when the order has
--    no quote or the quote no such lines. Same SECURITY INVOKER, search_path, result and grants.
-- 4. Backfill: each job still described exactly 'Converted from ' || its sales order's so_number whose quote has such lines gets the
--    same text. Every other description is left alone. Each such job's worksheet revision goes up by one (description is a worksheet
--    field, jobs_worksheet_version) and the change is in the activity trail as a System edit; an earlier sign-off stays on the
--    revision it signed. Safe to run again (a second run finds nothing to change).
--
-- GUARD (section 1): org_activity must be 035's (or already 080's) and convert_sales_order 068's (or already 080's), compared by md5
-- with every whitespace character removed (a CRLF paste matches); anything else stops the release and nothing of 080 is kept.
-- SELF-CHECK (section 6): the bodies are 080's, the new function is internal, org_activity's security and grants are as before, and
-- no job is left on the placeholder while its quote has lines.
-- Rollback: supabase/release/080_activity_labels_job_work.rollback.sql (035's org_activity and 068's convert_sales_order back, the
-- new function dropped; descriptions already written stay; only with Rhys's approval).
-- =====================================================================================================

-- 1. The guard: the functions being replaced are 035's and 068's (or already 080's).
DO $$
DECLARE
  v_org  TEXT;
  v_conv TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_org FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_conv FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)');
  -- 292d6e26...: 035's org_activity; ae7e2416...: this file's (section 3). 5555212a...: 068's convert_sales_order; dc816554...: this file's
  -- (section 4). All with every whitespace character removed.
  IF v_org IS NULL OR v_org NOT IN ('292d6e2612099e36dd107422bd50e1b5', 'ae7e2416ce0a54b0d8ccb721aeb2d245') THEN
    RAISE EXCEPTION '080: public.org_activity is not 035''s (md5 without whitespace %); stop and compare it first', coalesce(v_org, 'missing');
  END IF;
  IF v_conv IS NULL OR v_conv NOT IN ('5555212a1d32070ce74209e718c3896d', 'dc8165549871bd15047765ac4fba811e') THEN
    RAISE EXCEPTION '080: public.convert_sales_order is not 068''s (md5 without whitespace %); stop and compare it first', coalesce(v_conv, 'missing');
  END IF;
  IF to_regprocedure('security_audit.activity_label(jsonb)') IS NULL THEN
    RAISE EXCEPTION '080: security_audit.activity_label(jsonb) (013) is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. A row's label by its own table's number. The one-argument activity_label (013) is unchanged.
CREATE OR REPLACE FUNCTION security_audit.activity_label(p_table TEXT, p_row JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_table IN ('quotes', 'invoices', 'credit_notes', 'sales_orders', 'purchase_orders', 'delivery_notes', 'jobs') THEN
      left(coalesce(CASE p_table
                      WHEN 'quotes'          THEN p_row ->> 'quote_ref'
                      WHEN 'invoices'        THEN p_row ->> 'invoice_ref'
                      WHEN 'credit_notes'    THEN p_row ->> 'credit_ref'
                      WHEN 'sales_orders'    THEN p_row ->> 'so_number'
                      WHEN 'purchase_orders' THEN coalesce(p_row ->> 'po_ref', p_row ->> 'po_number')
                      WHEN 'delivery_notes'  THEN p_row ->> 'dn_number'
                      WHEN 'jobs'            THEN p_row ->> 'job_no'
                    END,
                    p_row ->> 'name', p_row ->> 'full_name', p_row ->> 'email', p_row ->> 'file_name', p_row ->> 'description'), 80)
    ELSE security_audit.activity_label(p_row)
  END
$$;
REVOKE ALL ON FUNCTION security_audit.activity_label(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. org_activity (035): exactly 035's, but each row is labelled by its own table's number (section 2).
CREATE OR REPLACE FUNCTION public.org_activity(
  p_from   TIMESTAMPTZ DEFAULT NULL,
  p_to     TIMESTAMPTZ DEFAULT NULL,
  p_actor  UUID        DEFAULT NULL,
  p_table  TEXT        DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,   -- "load more": the last row shown (time + id)
  p_before_id UUID     DEFAULT NULL,
  p_limit  INTEGER     DEFAULT 100
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, actor_user_id UUID, actor_name TEXT, actor_email TEXT, action TEXT,
               entity_table TEXT, entity_id TEXT, record_table TEXT, record_id TEXT, record_label TEXT,
               changes JSONB, snapshot JSONB, metadata JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can view the activity log' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at, a.actor_user_id,
         CASE WHEN a.actor_user_id IS NULL THEN 'System' ELSE cp.display_name END,
         NULL::TEXT, a.action, a.entity_table, a.entity_id,
         CASE a.entity_table
           WHEN 'quote_line_items' THEN 'quotes' WHEN 'quote_attachments' THEN 'quotes'
           WHEN 'invoice_line_items' THEN 'invoices' WHEN 'delivery_note_items' THEN 'delivery_notes'
           WHEN 'machine_bookings' THEN 'jobs' WHEN 'job_values' THEN 'jobs'
           ELSE a.entity_table END,
         CASE WHEN a.entity_table IN ('quote_line_items', 'invoice_line_items', 'delivery_note_items', 'machine_bookings', 'job_values')
              THEN security_audit.activity_parent(a.entity_table, a.old_data, a.new_data)
              ELSE a.entity_id END,
         security_audit.redact_emails(to_jsonb(coalesce(pl.parent_label, security_audit.activity_label(a.entity_table, coalesce(a.new_data, a.old_data)))), v_org) #>> '{}',
         security_audit.redact_emails(CASE WHEN a.action = 'UPDATE' THEN security_audit.activity_changes(a.old_data, a.new_data) END, v_org),
         security_audit.redact_emails(CASE WHEN a.action IN ('INSERT', 'DELETE') THEN security_audit.activity_snapshot(coalesce(a.new_data, a.old_data))
              WHEN coalesce(a.metadata ->> 'source', '') = 'write_audit' THEN security_audit.activity_snapshot(coalesce(a.new_data, '{}'))
         END, v_org),
         security_audit.redact_emails(a.metadata - 'source', v_org)
  FROM security_audit.audit_log a
  LEFT JOIN public.company_people() cp ON cp.user_id = a.actor_user_id
  -- Child rows (lines, attachments, bookings) are labelled with their record's number.
  LEFT JOIN LATERAL (
    SELECT CASE a.entity_table
      WHEN 'quote_line_items'    THEN (SELECT q.quote_ref FROM public.quotes q WHERE q.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND q.organization_id = v_org)
      WHEN 'invoice_line_items'  THEN (SELECT i.invoice_ref FROM public.invoices i WHERE i.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND i.organization_id = v_org)
      WHEN 'delivery_note_items' THEN (SELECT d.dn_number FROM public.delivery_notes d WHERE d.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND d.organization_id = v_org)
      WHEN 'machine_bookings'    THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'job_values'          THEN (SELECT j.job_no FROM public.jobs j WHERE j.id::TEXT = security_audit.activity_parent(a.entity_table, a.old_data, a.new_data) AND j.organization_id = v_org)
      WHEN 'quote_attachments'   THEN coalesce(a.new_data ->> 'quote_ref', a.old_data ->> 'quote_ref')
    END AS parent_label
  ) pl ON TRUE
  WHERE a.organization_id = v_org
    AND (p_from IS NULL OR a.created_at >= p_from)
    AND (p_to IS NULL OR a.created_at < p_to)
    AND (p_before IS NULL OR (a.created_at, a.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::UUID)))
    AND (p_actor IS NULL OR a.actor_user_id = p_actor)
    AND (p_table IS NULL OR a.entity_table = p_table
         OR (p_table = 'quotes' AND a.entity_table IN ('quote_line_items', 'quote_attachments'))
         OR (p_table = 'invoices' AND a.entity_table = 'invoice_line_items')
         OR (p_table = 'delivery_notes' AND a.entity_table = 'delivery_note_items')
         OR (p_table = 'jobs' AND a.entity_table IN ('machine_bookings', 'job_values')))
    AND NOT (a.action = 'UPDATE' AND security_audit.activity_changes(a.old_data, a.new_data) = '{}'::JSONB)
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;
REVOKE ALL ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_activity(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. convert_sales_order (068): exactly 068's, but the job is described by the quote's work.
CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job     public.jobs%ROWTYPE;
  v_quote   TEXT;
  v_base    TEXT;
  v_job_no  TEXT;
  v_num     TEXT;
  v_lines   TEXT;
  v_count   INT;
  v_qty     NUMERIC;
  v_drawing TEXT;
  v_spec    TEXT;
  v_work    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can convert sales orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already converted (either side of the link): hand back that job, change nothing.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND THEN
    IF v_order.converted_to_job_id IS DISTINCT FROM v_job.id THEN
      UPDATE public.sales_orders SET converted_to_job_id = v_job.id, converted_at = coalesce(converted_at, v_now) WHERE id = p_order;
    END IF;
    RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', FALSE);
  END IF;

  -- Job number: the quote's number when free, otherwise the next J number. The row lock above only serialises calls for
  -- ONE order; two orders for the same quote would both find J-1393 free. One lock per company, held to the end of this
  -- transaction, makes the "is it free" check and the insert a single step.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  v_quote := v_order.quote_ref;
  IF coalesce(v_quote, '') = '' AND v_order.quote_id IS NOT NULL THEN
    SELECT q.quote_ref INTO v_quote FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
  END IF;
  -- A later version of a quote ('QUO-0123 v2'): its number and its attachments are the quote's own (QUO-0123).
  v_base := v_quote;
  IF v_order.quote_id IS NOT NULL THEN
    SELECT public.quote_base_ref(v_quote, q.version) INTO v_base FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
    v_base := coalesce(v_base, v_quote);
  END IF;
  v_num := substring(coalesce(v_base, '') FROM '^\s*[Qq][Uu][Oo][-\s]?(\d+)\s*$');
  IF v_num IS NOT NULL THEN
    v_job_no := 'J-' || CASE WHEN length(ltrim(v_num, '0')) < 4 THEN lpad(coalesce(nullif(ltrim(v_num, '0'), ''), '0'), 4, '0') ELSE ltrim(v_num, '0') END;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = v_org AND job_no = v_job_no) THEN
      v_job_no := NULL;
    END IF;
  END IF;
  IF v_job_no IS NULL THEN
    v_job_no := public.next_doc_number('J');
  END IF;

  -- What the workshop needs from the quote: the ordered lines' descriptions, parts, drawings and quantities, never prices.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT string_agg('- ' || btrim(l.description)
                        || coalesce(' [' || public.quote_line_reference(l.part_number, l.drawing_number, l.drawing_revision) || ']', '')
                        || ' x ' || trim_scale(l.quantity)::TEXT, E'\n' ORDER BY l.position, l.id),
           count(*), max(l.quantity),
           max(nullif(btrim(l.drawing_number), '') || coalesce(' rev ' || nullif(btrim(l.drawing_revision), ''), ''))
      INTO v_lines, v_count, v_qty, v_drawing
    FROM public.quote_line_items l
    WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org AND NOT l.declined;
  END IF;
  v_spec := 'Sales order ' || v_order.so_number
    || CASE WHEN v_order.delivery_date IS NOT NULL THEN '; customer delivery required ' || to_char(v_order.delivery_date, 'DD/MM/YYYY') ELSE '' END
    || '.'
    || CASE WHEN v_lines IS NOT NULL THEN E'\n' || coalesce(v_quote, 'Quote') || E':\n' || v_lines ELSE '' END;

  -- The job's description (080): the quote's work, its distinct ordered (not declined) line descriptions in line order, joined with
  -- '; ' and cut at 300 characters. An order without a quote, or a quote without such lines, keeps 'Converted from SO-...'.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT left(string_agg(w.text, '; ' ORDER BY w.first_position, w.text), 300) INTO v_work
    FROM (SELECT btrim(l.description) AS text, min(l.position) AS first_position
          FROM public.quote_line_items l
          WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org AND NOT l.declined AND btrim(l.description) <> ''
          GROUP BY btrim(l.description)) w;
  END IF;

  INSERT INTO public.jobs (
    organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
    customer_po, quote_ref, date_received, date_required, quantity_required, drawing_no, converted_from_sales_order_id, converted_at)
  VALUES (
    v_org, v_job_no, v_order.quote_id, v_order.customer, coalesce(v_work, 'Converted from ' || v_order.so_number), 'material',
    v_order.delivery_date, 'on_track', v_spec, '[]'::JSONB,
    nullif(btrim(coalesce(v_order.customer_po, '')), ''), nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    CASE WHEN v_count = 1 THEN v_drawing END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  -- The quote's drawings travel with the job: a reference to each file attached to the quote (same company folder; nothing is
  -- copied), so the worksheet lists them and the shop floor can open them (job_files, section 3 below).
  IF coalesce(v_base, '') <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT v_org, v_job.id, 'drawing', left(coalesce(nullif(btrim(regexp_replace(a.file_name, '\.[^.]*$', '')), ''), 'Drawing'), 200),
           left(coalesce(nullif(btrim(a.file_name), ''), 'Drawing'), 255), 'quote-attachments', a.file_path, a.id, auth.uid()
    FROM public.quote_attachments a
    WHERE a.organization_id = v_org AND a.quote_ref = v_base AND split_part(a.file_path, '/', 1) = v_org::TEXT
    ORDER BY a.created_at, a.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  -- The machines and hours planned on the order's lines, summed per machine on the job (043). No booking: "Book on schedule" on the job.
  PERFORM public.carry_so_machines(p_order, v_job.id);

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Backfill: jobs still described 'Converted from SO-...' whose quote has ordered lines get the text section 4 now writes.
UPDATE public.jobs j
SET description = b.work
FROM (SELECT DISTINCT ON (j.id) j.id, (SELECT left(string_agg(w.text, '; ' ORDER BY w.first_position, w.text), 300)
                    FROM (SELECT btrim(l.description) AS text, min(l.position) AS first_position
                          FROM public.quote_line_items l
                          WHERE l.quote_id = s.quote_id AND l.organization_id = s.organization_id AND NOT l.declined AND btrim(l.description) <> ''
                          GROUP BY btrim(l.description)) w) AS work
  FROM public.jobs j
  JOIN public.sales_orders s ON s.organization_id = j.organization_id AND (s.id = j.converted_from_sales_order_id OR s.converted_to_job_id = j.id)
  WHERE s.quote_id IS NOT NULL AND j.description = 'Converted from ' || s.so_number
  ORDER BY j.id, (s.id = j.converted_from_sales_order_id) DESC NULLS LAST, s.created_at, s.id) b
WHERE j.id = b.id AND b.work IS NOT NULL;

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check before COMMIT (the same checks as supabase/verify/activity_labels_080.sql).
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')) IS DISTINCT FROM 'ae7e2416ce0a54b0d8ccb721aeb2d245' THEN
    RAISE EXCEPTION '080: org_activity is not 080''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)')) IS DISTINCT FROM 'dc8165549871bd15047765ac4fba811e' THEN
    RAISE EXCEPTION '080: convert_sales_order is not 080''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('security_audit.activity_label(text,jsonb)')) IS DISTINCT FROM '50674bed5bd63ddf3cf1c7b9c6e0fd05' THEN
    RAISE EXCEPTION '080: activity_label(text, jsonb) is not 080''s';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('security_audit.activity_label(text,jsonb)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('security_audit.activity_label(text,jsonb)'), 'EXECUTE') THEN
    RAISE EXCEPTION '080: activity_label(text, jsonb) is callable from the API';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')) THEN
    RAISE EXCEPTION '080: org_activity''s security or grants changed';
  END IF;
  IF NOT (SELECT NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)')) THEN
    RAISE EXCEPTION '080: convert_sales_order''s security or grants changed';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (j.id) j.id, (SELECT left(string_agg(w.text, '; ' ORDER BY w.first_position, w.text), 300)
                    FROM (SELECT btrim(l.description) AS text, min(l.position) AS first_position
                          FROM public.quote_line_items l
                          WHERE l.quote_id = s.quote_id AND l.organization_id = s.organization_id AND NOT l.declined AND btrim(l.description) <> ''
                          GROUP BY btrim(l.description)) w) AS work
  FROM public.jobs j
  JOIN public.sales_orders s ON s.organization_id = j.organization_id AND (s.id = j.converted_from_sales_order_id OR s.converted_to_job_id = j.id)
  WHERE s.quote_id IS NOT NULL AND j.description = 'Converted from ' || s.so_number
  ORDER BY j.id, (s.id = j.converted_from_sales_order_id) DESC NULLS LAST, s.created_at, s.id) b WHERE b.work IS NOT NULL) THEN
    RAISE EXCEPTION '080: a job is still described ''Converted from SO-...'' while its quote has lines';
  END IF;
END
$$;
