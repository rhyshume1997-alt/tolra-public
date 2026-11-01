-- 126 rollback: ONLY with Rhys's approval. Puts back 042's public.delete_machine_booking(uuid) and 068's public.accept_quote(uuid,
-- text, date, uuid[]) byte for byte (same signatures, security, search_path and grants). No row is changed. After it, a booking with
-- recorded machine time can be removed again (its runs' booking_id is cleared) and a quote for 0.00 can be accepted in the database
-- (the app still refuses it). Run the whole text as one transaction, then the release preflight (marker 126 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_delete  TEXT;
  v_accept  TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delete_machine_booking(uuid)') INTO v_delete;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') INTO v_accept;
  -- 1fee96ce...: 126's delete_machine_booking; df143caf...: 042's (a second run of this rollback).
  IF v_delete IS NULL OR v_delete NOT IN ('1fee96ce68caa2bcbf89f416587e75ba', 'df143caf45e151bb38e618c1ba7703af') THEN
    RAISE EXCEPTION '126 rollback: delete_machine_booking (md5 %) is neither 126''s nor 042''s; stop and compare', coalesce(v_delete, 'missing');
  END IF;
  -- 4f354d38...: 126's accept_quote; 453d0db1...: 068's (a second run of this rollback).
  IF v_accept IS NULL OR v_accept NOT IN ('4f354d3878197aabe53db19807f99305', '453d0db193ef6577e6c75a61eec01c73') THEN
    RAISE EXCEPTION '126 rollback: accept_quote (md5 %) is neither 126''s nor 068''s; stop and compare', coalesce(v_accept, 'missing');
  END IF;
END
$$;

-- 042's delete_machine_booking, verbatim (supabase/migrations/042_internal_jobs_and_machines.sql).
CREATE OR REPLACE FUNCTION public.delete_machine_booking(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_id  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can remove bookings' USING ERRCODE = '42501';
  END IF;
  -- A job's machine plan keeps its row; only the link to the removed booking goes (the foreign key does the same on its own).
  UPDATE public.job_machines SET booking_id = NULL WHERE booking_id = p_id AND organization_id = v_org;
  DELETE FROM public.machine_bookings b WHERE b.id = p_id AND b.organization_id = v_org RETURNING b.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This booking couldn''t be removed: it was already removed, or you don''t have access to remove it.' USING ERRCODE = 'P0002';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.delete_machine_booking(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_machine_booking(UUID) TO authenticated;

-- 068's accept_quote, verbatim (supabase/migrations/068_quote_versions.sql).
CREATE OR REPLACE FUNCTION public.accept_quote(p_quote UUID, p_customer_po TEXT DEFAULT NULL, p_delivery_date DATE DEFAULT NULL, p_lines UUID[] DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_next       public.quotes%ROWTYPE;
  v_accepted   BOOLEAN := FALSE;
  v_auto       BOOLEAN;
  v_so         JSONB;
  v_so_id      UUID;
  v_order      public.sales_orders%ROWTYPE;
  v_job        JSONB;
  v_job_id     UUID;
  v_job_no     TEXT;
  v_job_new    BOOLEAN := FALSE;
  v_job_reason TEXT;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_declined   UUID[] := '{}';
  v_ordered    INTEGER;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can record a customer''s decision on a quote' USING ERRCODE = '42501';
  END IF;
  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  -- Only the latest version is decided.
  SELECT * INTO v_next FROM public.quotes q WHERE q.previous_version_id = p_quote AND q.organization_id = v_org;
  IF FOUND OR v_quote.status = 'superseded' THEN
    RAISE EXCEPTION '% v% has been revised as a newer version: accept the latest version.', v_quote.quote_ref, v_quote.version
      USING ERRCODE = '22023', HINT = 'quote_superseded';
  END IF;
  IF v_quote.status = 'rejected' THEN
    RAISE EXCEPTION '% was marked as rejected; a decision can''t be changed.', v_quote.quote_ref USING ERRCODE = '22023', HINT = 'quote_decided';
  ELSIF coalesce(v_quote.status, 'draft') IN ('draft', 'sent') THEN
    -- The lines the customer's PO covers (NULL: all of them). Each must be one of this quote's lines; at least one.
    IF p_lines IS NOT NULL THEN
      IF cardinality(p_lines) = 0 THEN
        RAISE EXCEPTION 'Choose at least one line the customer ordered.' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(p_lines) c(id)
                 WHERE c.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.quote_line_items l WHERE l.id = c.id AND l.quote_id = p_quote AND l.organization_id = v_org)) THEN
        RAISE EXCEPTION 'One of the chosen lines isn''t on %. Reload the quote and choose again.', v_quote.quote_ref USING ERRCODE = '22023';
      END IF;
    END IF;
    PERFORM set_config('quoteflow.accept_quote', p_quote::TEXT, TRUE);
    UPDATE public.quote_line_items l SET declined = (p_lines IS NOT NULL AND NOT (l.id = ANY (p_lines)))
    WHERE l.quote_id = p_quote AND l.organization_id = v_org AND l.declined IS DISTINCT FROM (p_lines IS NOT NULL AND NOT (l.id = ANY (p_lines)));
    PERFORM set_config('quoteflow.accept_quote', '', TRUE);
    UPDATE public.quotes SET status = 'accepted', accepted_at = now() WHERE id = p_quote;
    v_accepted := TRUE;
  ELSIF v_quote.status <> 'accepted' THEN
    RAISE EXCEPTION '% is %; only a draft or sent quote can be accepted.', v_quote.quote_ref, v_quote.status USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(l.id ORDER BY l.position, l.id) FILTER (WHERE l.declined), '{}'), count(*) FILTER (WHERE NOT l.declined)
    INTO v_declined, v_ordered
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;

  v_auto := coalesce((SELECT s.auto_convert_sales_orders FROM public.organization_settings s WHERE s.organization_id = v_org), TRUE);

  -- The order: only for someone who may see sales orders (036's section gate, as the table's own rules apply it).
  IF NOT public.section_allowed('sales-orders') THEN
    v_so := jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
      'reason', 'Sales orders are hidden for you, so no order was made: someone with the Sales Orders section makes it from this quote.');
  ELSE
    v_so := public.create_sales_order_from_quote(p_quote, v_po, p_delivery_date);
  END IF;
  v_so_id := (v_so ->> 'so_id')::UUID;

  IF v_so_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.sales_orders s WHERE s.id = v_so_id;
    IF (v_so ->> 'created')::BOOLEAN AND v_auto THEN
      -- The job, not started, exactly as Convert to Job makes it. A failure here leaves the order open for Convert to Job by hand.
      BEGIN
        v_job := public.convert_sales_order(v_so_id);
        v_job_id := (v_job ->> 'job_id')::UUID;
        v_job_no := v_job ->> 'job_no';
        v_job_new := coalesce((v_job ->> 'created')::BOOLEAN, FALSE);
      EXCEPTION WHEN OTHERS THEN
        v_job_reason := 'The sales order was made but its job wasn''t (' || SQLERRM || '). Use Convert to Job on the order.';
      END;
    ELSIF v_order.converted_to_job_id IS NOT NULL THEN
      SELECT j.id, j.job_no INTO v_job_id, v_job_no FROM public.jobs j WHERE j.id = v_order.converted_to_job_id AND j.organization_id = v_org;
    END IF;
  END IF;

  IF v_accepted THEN
    PERFORM security_audit.log_named_event(v_org, 'ACCEPT', 'quotes', p_quote::TEXT, jsonb_build_object(
      'quote_ref', v_quote.quote_ref, 'version', v_quote.version, 'so_id', v_so_id, 'so_number', v_so ->> 'so_number',
      'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE), 'provisional', v_so -> 'provisional', 'job_id', v_job_id, 'job_no', v_job_no,
      'job_created', v_job_new, 'auto_convert', v_auto, 'reason', v_so ->> 'reason', 'job_reason', v_job_reason,
      'lines_ordered', v_ordered, 'declined_lines', to_jsonb(v_declined)));
  END IF;

  RETURN jsonb_build_object(
    'quote_id', p_quote, 'quote_ref', v_quote.quote_ref, 'version', v_quote.version, 'accepted', v_accepted, 'created', v_accepted,
    'so_id', v_so_id, 'so_number', v_so ->> 'so_number', 'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE),
    'provisional', coalesce((v_so ->> 'provisional')::BOOLEAN, FALSE),
    'job_id', v_job_id, 'job_no', v_job_no, 'job_created', v_job_new, 'auto_convert', v_auto,
    'needs', v_so ->> 'needs', 'reason', v_so ->> 'reason', 'job_reason', v_job_reason,
    'lines_ordered', v_ordered, 'lines_declined', cardinality(v_declined));
END
$$;
REVOKE ALL ON FUNCTION public.accept_quote(UUID, TEXT, DATE, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_quote(UUID, TEXT, DATE, UUID[]) TO authenticated;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.delete_machine_booking(uuid)')) IS DISTINCT FROM 'df143caf45e151bb38e618c1ba7703af'
     OR (SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) FROM pg_proc WHERE oid = to_regprocedure('public.accept_quote(uuid, text, date, uuid[])')) IS DISTINCT FROM '453d0db193ef6577e6c75a61eec01c73' THEN
    RAISE EXCEPTION '126 rollback: 042''s delete_machine_booking or 068''s accept_quote is not back';
  END IF;
END
$$;
COMMIT;
