-- C17 proposal only (delivery note for a job with no sales order). Review and apply in a separate release; never run during app startup.
-- Packaged as post-144 release step 147 (supabase/release/147_job_delivery_note.release.sql), after 146. One-time: a repeat refuses on
-- the existing column and rolls back. No existing function or policy is replaced: create_delivery_note (037), the release gate (081), the
-- note link guard (085), the same-company triggers (015/034) and the row audit (013) stay in force and are exercised by every insert.
-- Added on delivery_notes: a request key and hash (one note per request; a changed retry is refused), a numbering guard (browser-made notes
-- take their number from the DLN counter, never a typed one) and a hold: every company that exists when this is installed makes no delivery
-- note until its cutover counter step (supabase/cutover/set_dln_next_number.sql, or keep_dln_numbering.sql) has run.
BEGIN;
-- 1. Double-submit key. Set only by create_job_delivery_note; never by a browser write. A legacy note keeps NULL.
ALTER TABLE public.delivery_notes ADD COLUMN request_id uuid;
ALTER TABLE public.delivery_notes ADD COLUMN request_hash text;
CREATE UNIQUE INDEX delivery_notes_org_request_uniq ON public.delivery_notes (organization_id, request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION public.delivery_notes_request_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.request_id IS NOT NULL OR NEW.request_hash IS NOT NULL)
     AND (NEW.request_id IS NULL OR current_setting('quoteflow.job_delivery_note_request', TRUE) IS DISTINCT FROM NEW.request_id::TEXT) THEN
    RAISE EXCEPTION 'A delivery note''s request key is set by the function that makes it.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.request_hash IS DISTINCT FROM OLD.request_hash) THEN
    RAISE EXCEPTION 'A delivery note''s request key can''t be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.delivery_notes_request_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER delivery_notes_request_guard BEFORE INSERT OR UPDATE OF request_id, request_hash ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_request_guard();

-- 2. Hold until the cutover counter step. One row per company that existed when this was installed; no browser access at all. The
-- cutover scripts (run by the database owner) delete a company's row once its DLN numbering is set; a company made later has no row.
CREATE TABLE public.dln_numbering_pending (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  marked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dln_numbering_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dln_numbering_pending FROM PUBLIC, anon, authenticated;
INSERT INTO public.dln_numbering_pending (organization_id) SELECT id FROM public.organizations;

-- 3. Numbering guard for browser roles (the service role, the owner and the import are exempt, as the other note guards):
--    a held company makes no note by any route; a note's number comes from next_doc_number('DLN') (the functions take it themselves; a
--    note made by hand gets it here, in the same transaction, so a failed save burns none); a typed number (the old invoice-number
--    mirror INV-0456 -> DLN-0456) is refused, and a number is never changed afterwards.
CREATE FUNCTION public.delivery_notes_numbering_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.dn_number IS DISTINCT FROM OLD.dn_number THEN
      RAISE EXCEPTION 'A delivery note''s number can''t be changed.' USING ERRCODE = '42501', HINT = 'dn_number_from_counter';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.dln_numbering_pending p WHERE p.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'Delivery note numbering for this company hasn''t been set yet, so no delivery note can be made. It is set once, on the cutover day.'
      USING ERRCODE = '55000', HINT = 'dln_numbering_not_set';
  END IF;
  IF current_setting('quoteflow.delivery_note_new', TRUE) = 'on' THEN
    RETURN NEW;
  END IF;
  IF nullif(btrim(coalesce(NEW.dn_number, '')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'A delivery note''s number comes from the delivery note series: leave it empty and Tolra gives the next one.'
      USING ERRCODE = '42501', HINT = 'dn_number_from_counter';
  END IF;
  NEW.dn_number := public.next_doc_number('DLN');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.delivery_notes_numbering_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER delivery_notes_numbering_guard BEFORE INSERT OR UPDATE OF dn_number ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_numbering_guard();

-- 4. A delivery note for a job that was not made from a sales order, linked to the job (job_id) and to the job's customer record
-- (customer_id) by key, numbered DLN by next_doc_number in the same transaction (a failed save burns no number). Roles as
-- create_delivery_note: admin, office, workshop (admin with the second step). The job row is locked FOR UPDATE first, so a second
-- submit with the same request id waits and then gets the first note back. The release gate (081) still fires on the insert.
CREATE FUNCTION public.create_job_delivery_note(p_job uuid, p_customer uuid, p_request uuid, p_ship_date date, p_tax_date date,
                                                p_ship_via text, p_notes text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      uuid := public.current_user_organization_id();
  v_user     uuid := auth.uid();
  v_job      public.jobs%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_prior    public.delivery_notes%ROWTYPE;
  v_state    RECORD;
  v_item     jsonb;
  v_desc     text;
  v_qty      numeric;
  v_dn       uuid;
  v_number   text;
  v_pos      int := 0;
  v_hash     text;
  v_same     int;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_job IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'The job and a request id are required.' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line with a description and a quantity.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'Too many lines (200 at most).' USING ERRCODE = '22023';
  END IF;
  IF p_ship_date IS NULL OR p_tax_date IS NULL THEN
    RAISE EXCEPTION 'The ship date and tax date are required.' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_ship_via, '')) > 100 OR length(coalesce(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Ship via is at most 100 characters and notes 2000.' USING ERRCODE = '22023';
  END IF;

  -- Another company's job is "not found", never told apart from a missing one.
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.dln_numbering_pending p WHERE p.organization_id = v_org) THEN
    RAISE EXCEPTION 'Delivery note numbering for this company hasn''t been set yet, so no delivery note can be made. It is set once, on the cutover day.'
      USING ERRCODE = '55000', HINT = 'dln_numbering_not_set';
  END IF;

  -- Double submit: the same request again (after the first committed, under the job lock) gets the first note back, unchanged. The same
  -- request id with anything different (job, customer, dates, ship via, notes or lines) is refused: it is not the same request.
  v_hash := md5(jsonb_build_object('job', p_job, 'customer', p_customer, 'ship_date', p_ship_date, 'tax_date', p_tax_date,
                                   'ship_via', nullif(btrim(coalesce(p_ship_via, '')), ''), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
                                   'lines', p_lines)::TEXT);
  SELECT * INTO v_prior FROM public.delivery_notes WHERE organization_id = v_org AND request_id = p_request;
  IF FOUND THEN
    IF v_prior.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'That request was already used for delivery note % with different details, so nothing was saved. Start a new delivery note.', v_prior.dn_number
        USING ERRCODE = '22023', HINT = 'request_mismatch';
    END IF;
    RETURN jsonb_build_object('id', v_prior.id, 'dn_number', v_prior.dn_number, 'replayed', TRUE);
  END IF;

  IF v_job.is_internal THEN
    RAISE EXCEPTION 'Job % is internal: it has no customer order, so it can''t be despatched or invoiced.', v_job.job_no USING ERRCODE = '22023', HINT = 'internal_job';
  END IF;
  IF v_job.converted_from_sales_order_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.sales_orders s WHERE s.converted_to_job_id = v_job.id AND s.organization_id = v_org) THEN
    RAISE EXCEPTION 'Job % came from a sales order: make the delivery note from the order, which counts what is left to send.', v_job.job_no USING ERRCODE = '22023';
  END IF;

  -- The customer record: in this company, and the one the job is for (its name is the job's customer). Chosen by the person.
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'Choose the customer this job is for.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_customer FROM public.customers WHERE id = p_customer AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  IF lower(btrim(coalesce(v_customer.name, ''))) IS DISTINCT FROM lower(btrim(coalesce(v_job.customer, ''))) THEN
    RAISE EXCEPTION 'That customer isn''t the one on job % (%).', v_job.job_no, v_job.customer USING ERRCODE = '22023', HINT = 'customer_mismatch';
  END IF;
  -- A job names its customer as text only (jobs carry no customer key), so two records with that name can't be told apart: refused.
  SELECT count(*) INTO v_same FROM public.customers c WHERE c.organization_id = v_org AND lower(btrim(coalesce(c.name, ''))) = lower(btrim(coalesce(v_job.customer, '')));
  IF v_same > 1 THEN
    RAISE EXCEPTION 'There are % customer records named "%", so job % can''t be linked to one. Merge or rename them on the Customers page first.', v_same, btrim(v_job.customer), v_job.job_no
      USING ERRCODE = '22023', HINT = 'customer_ambiguous';
  END IF;

  -- Inspection must pass unless an admin released the job early with a reason (081). Checked here with the job locked, and again
  -- by the delivery_notes_release_gate trigger on the insert, and by the link guard when the note goes out.
  SELECT * INTO v_state FROM public.job_release_state(v_job.id);
  IF NOT v_state.released THEN
    RAISE EXCEPTION '% hasn''t passed inspection (or had a concession recorded by an admin), so it can''t be despatched.', v_job.job_no USING ERRCODE = '22023', HINT = 'job_not_released';
  END IF;
  IF v_state.blocked IS NOT NULL THEN
    RAISE EXCEPTION '%', v_state.blocked USING ERRCODE = '22023';
  END IF;

  v_number := public.next_doc_number('DLN');
  PERFORM set_config('quoteflow.delivery_note_new', 'on', TRUE);
  PERFORM set_config('quoteflow.job_delivery_note_request', p_request::TEXT, TRUE);
  INSERT INTO public.delivery_notes (organization_id, dn_number, customer, customer_id, customer_email, job_id, job_ref, delivery_date, ship_date,
                                     tax_date, ship_via, status, notes, request_id, request_hash, created_by, updated_by)
  VALUES (v_org, v_number, v_customer.name, v_customer.id, nullif(btrim(coalesce(v_customer.email, '')), ''), v_job.id, v_job.job_no, p_ship_date,
          p_ship_date, p_tax_date, nullif(btrim(p_ship_via), ''), 'awaiting', nullif(btrim(p_notes), ''), p_request, v_hash, v_user, v_user)
  RETURNING id INTO v_dn;
  PERFORM set_config('quoteflow.delivery_note_new', '', TRUE);
  PERFORM set_config('quoteflow.job_delivery_note_request', '', TRUE);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'Every line needs a description and a quantity.' USING ERRCODE = '22023';
    END IF;
    v_desc := btrim(coalesce(v_item ->> 'description', ''));
    IF v_desc = '' OR length(v_desc) > 1000 THEN
      RAISE EXCEPTION 'Every line needs a description (1000 characters at most).' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_qty := (v_item ->> 'quantity')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Every line needs a quantity.' USING ERRCODE = '22023';
    END;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty, 3) THEN
      RAISE EXCEPTION 'Each quantity must be more than zero, with at most three decimal places.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity)
    VALUES (v_org, v_dn, v_pos, v_desc, v_qty);
    v_pos := v_pos + 1;
  END LOOP;
  RETURN jsonb_build_object('id', v_dn, 'dn_number', v_number, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.create_job_delivery_note(uuid, uuid, uuid, date, date, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job_delivery_note(uuid, uuid, uuid, date, date, text, text, jsonb) TO authenticated;
COMMIT;
