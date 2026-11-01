-- 134 rollback: ONLY with Rhys's approval. Puts back 080's public.convert_sales_order(uuid) byte for byte (same signature, security,
-- search_path and grants). No row is changed: jobs made while 134 was applied keep their 'Customer PO ...' specification and
-- customer_po; jobs made after this rollback read 'Sales order <so_number> ...' again and take only the order's PO. Run the whole
-- text as one transaction, then the release preflight (marker 134 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.convert_sales_order(uuid)') INTO v_md5;
  -- 5c32fec8...: 134's convert_sales_order; dc816554...: 080's (a second run of this rollback).
  IF v_md5 IS NULL OR v_md5 NOT IN ('5c32fec88493cce71da2cd55f83ff7b4', 'dc8165549871bd15047765ac4fba811e') THEN
    RAISE EXCEPTION '134 rollback: convert_sales_order (md5 %) is neither 134''s nor 080''s; stop and compare', coalesce(v_md5, 'missing');
  END IF;
END
$$;

-- 080's convert_sales_order, verbatim (supabase/migrations/080_activity_labels_job_work.sql).
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

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.convert_sales_order(uuid)')) IS DISTINCT FROM 'dc8165549871bd15047765ac4fba811e' THEN
    RAISE EXCEPTION '134 rollback: 080''s convert_sales_order is not back';
  END IF;
END
$$;
COMMIT;
