-- Post-144 release step 147. One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/c17_job_delivery_note.sql. Existing objects cause refusal, never overwrite.
BEGIN;
DO $post_release_guard$ BEGIN
 IF to_regclass('public.ai_helper_tolra_control') IS NULL OR to_regclass('public.company_setup_progress') IS NULL THEN
  RAISE EXCEPTION '147: required releases 145 and 146 are missing; stop and check release preflight';
 END IF;
 IF to_regprocedure('public.next_doc_number(text)') IS NULL OR to_regprocedure('public.job_release_state(uuid)') IS NULL
    OR to_regprocedure('public.assert_privileged_aal()') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'delivery_notes' AND column_name = 'job_id')
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.delivery_notes'::regclass AND tgenabled = 'O'
        AND tgname IN ('delivery_notes_release_gate', 'delivery_notes_link_guard', 'zz_same_org_job_id', 'zz_same_org_customer_id', 'audit_delivery_notes_changes')) <> 5 THEN
  RAISE EXCEPTION '147: the delivery note functions and triggers it builds on (037, 078, 081, 085, 015, 034, 013) are not all in place; stop and check release preflight';
 END IF;
END $post_release_guard$;

-- 1. Double-submit key. Set only by create_job_delivery_note; never by a browser write. A legacy note keeps NULL.
ALTER TABLE public.delivery_notes ADD COLUMN request_id uuid;
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
  IF TG_OP = 'INSERT' AND NEW.request_id IS NOT NULL
     AND current_setting('quoteflow.job_delivery_note_request', TRUE) IS DISTINCT FROM NEW.request_id::TEXT THEN
    RAISE EXCEPTION 'A delivery note''s request key is set by the function that makes it.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'A delivery note''s request key can''t be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.delivery_notes_request_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER delivery_notes_request_guard BEFORE INSERT OR UPDATE OF request_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.delivery_notes_request_guard();

-- 2. A delivery note for a job that was not made from a sales order, linked to the job (job_id) and to the job's customer record
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

  -- Double submit: the same request again (after the first committed, under the job lock) gets the first note back, unchanged.
  SELECT * INTO v_prior FROM public.delivery_notes WHERE organization_id = v_org AND request_id = p_request;
  IF FOUND THEN
    IF v_prior.job_id IS DISTINCT FROM p_job THEN
      RAISE EXCEPTION 'That request was already used for another delivery note.' USING ERRCODE = '22023';
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
                                     tax_date, ship_via, status, notes, request_id, created_by, updated_by)
  VALUES (v_org, v_number, v_customer.name, v_customer.id, nullif(btrim(coalesce(v_customer.email, '')), ''), v_job.id, v_job.job_no, p_ship_date,
          p_ship_date, p_tax_date, nullif(btrim(p_ship_via), ''), 'awaiting', nullif(btrim(p_notes), ''), p_request, v_user, v_user)
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
