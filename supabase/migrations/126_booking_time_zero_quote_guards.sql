-- =====================================================================================================
-- 126: two database guards the app already applies. Needs 042 (delete_machine_booking), 044 (machine_runs), 064 (the booking / run
-- identity guards) and 068 (accept_quote with p_lines). Touches no other migration's objects; no row is changed.
--
-- 1. B39: a booking with recorded machine time is never removed. delete_machine_booking (042's body, the newest: no later migration
--    replaces it) refuses, for every role, a booking that any machine_runs row points at (an open or an ended run):
--    'This booking has recorded machine time; finish or release it instead.' (23514, hint booking_has_runs, the hint 064's guard uses,
--    so the app shows the sentence). Before 126 the delete went through and the foreign key (ON DELETE SET NULL) cleared those runs'
--    booking_id. set_job_machines (061) removes a machine's 'booked' booking through delete_machine_booking, so the same refusal stops
--    the whole save there (nothing of it is kept); set_job_machines itself is not replaced. The booking's row is locked (FOR UPDATE)
--    before the check, so a run being started on it at the same moment (064 holds the booking FOR SHARE) is waited for and seen.
--    A booking with no runs is removed exactly as before; the runs are never touched.
-- 2. L9: a quote for 0.00 is not accepted. accept_quote (068's body, the newest) refuses a draft, sent or accepted quote whose
--    total_value is 0.00 or less in whole pence, as the app does (lib/quote-status.ts quoteAcceptBlock, the Quotes page's Mark
--    Accepted and the Sales Orders page's order from a quote): 'A quote for £0.00 can''t be accepted. Add a price or decline it.'
--    (22023, hint quote_zero_value). Nothing is accepted, no order or job is made. A superseded or rejected quote keeps its own
--    refusal; every other quote is accepted exactly as before.
-- Both keep their name, signature, VOLATILE, SECURITY DEFINER, search_path, owner and grants (signed-in only).
-- GUARD (section 1): each body must be its earlier migration's (or already this file's), md5 with every whitespace character removed.
-- Safe to run again. SELF-CHECK (section 4). Verify: supabase/verify/booking_time_zero_quote_126.sql (every row TRUE).
-- Rollback: supabase/release/126_booking_time_zero_quote_guards.rollback.sql (puts back 042's delete_machine_booking and 068's
-- accept_quote; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: both functions are there, and each body is its earlier migration's (or already this file's).
DO $$
DECLARE
  v_delete  TEXT;
  v_accept  TEXT;
BEGIN
  IF to_regclass('public.machine_runs') IS NULL OR to_regprocedure('public.guard_run_booking_identity()') IS NULL THEN
    RAISE EXCEPTION '126: 044''s machine_runs or 064''s booking identity guard is missing; apply them first';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delete_machine_booking(uuid)') INTO v_delete;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') INTO v_accept;
  -- df143caf45e151bb38e618c1ba7703af: 042's delete_machine_booking; 1fee96ce68caa2bcbf89f416587e75ba: this file's (section 2).
  IF v_delete IS NULL OR v_delete NOT IN ('df143caf45e151bb38e618c1ba7703af', '1fee96ce68caa2bcbf89f416587e75ba') THEN
    RAISE EXCEPTION '126: public.delete_machine_booking is not 042''s (md5 without whitespace %); stop and compare it first', coalesce(v_delete, 'missing');
  END IF;
  -- 453d0db193ef6577e6c75a61eec01c73: 068's accept_quote; 4f354d3878197aabe53db19807f99305: this file's (section 3).
  IF v_accept IS NULL OR v_accept NOT IN ('453d0db193ef6577e6c75a61eec01c73', '4f354d3878197aabe53db19807f99305') THEN
    RAISE EXCEPTION '126: public.accept_quote is not 068''s (md5 without whitespace %); stop and compare it first', coalesce(v_accept, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. B39: delete_machine_booking refuses a booking with recorded machine time. 042's body plus the check after the plan unlink.
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
  -- 126 (B39): a booking with recorded machine time (any run, open or ended) is never removed, for any role: removing it would clear
  -- the runs' booking_id. The booking's row is locked before the check: a run being started on it holds FOR SHARE (064), so this
  -- waits for that run and then sees it; a run started after the lock waits for it. The refusal undoes the
  -- plan unlink above; the runs are not touched.
  PERFORM 1 FROM public.machine_bookings b WHERE b.id = p_id AND b.organization_id = v_org FOR UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.booking_id = p_id) THEN
    RAISE EXCEPTION 'This booking has recorded machine time; finish or release it instead.' USING ERRCODE = '23514', HINT = 'booking_has_runs';
  END IF;
  DELETE FROM public.machine_bookings b WHERE b.id = p_id AND b.organization_id = v_org RETURNING b.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This booking couldn''t be removed: it was already removed, or you don''t have access to remove it.' USING ERRCODE = 'P0002';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.delete_machine_booking(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_machine_booking(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. L9: accept_quote refuses a quote for 0.00. 068's body plus the check after the rejected one.
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
  -- 126 (L9): a quote for 0.00 is not accepted and makes no order, as the app refuses it (lib/quote-status.ts quoteAcceptBlock: whole pence).
  ELSIF coalesce(v_quote.status, 'draft') IN ('draft', 'sent', 'accepted') AND round(coalesce(v_quote.total_value, 0) * 100) <= 0 THEN
    RAISE EXCEPTION 'A quote for £0.00 can''t be accepted. Add a price or decline it.' USING ERRCODE = '22023', HINT = 'quote_zero_value';
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

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: both bodies are this file's, and both stay definer, pinned, signed-in only.
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delete_machine_booking(uuid)'))
       IS DISTINCT FROM '1fee96ce68caa2bcbf89f416587e75ba' THEN
    RAISE EXCEPTION '126: delete_machine_booking is not this file''s body';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.accept_quote(uuid, text, date, uuid[])'))
       IS DISTINCT FROM '4f354d3878197aabe53db19807f99305' THEN
    RAISE EXCEPTION '126: accept_quote is not this file''s body';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.delete_machine_booking(uuid)', 'public.accept_quote(uuid, text, date, uuid[])'] LOOP
    IF (SELECT NOT p.prosecdef OR p.provolatile <> 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
               OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS NOT FALSE THEN
      RAISE EXCEPTION '126: % is not definer, volatile, pinned and signed-in only', v_fn;
    END IF;
  END LOOP;
END
$$;
