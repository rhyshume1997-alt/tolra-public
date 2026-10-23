-- 081 rollback: ONLY with Rhys's approval. Puts back 037's public.job_release_state and 059's public.delivery_note_try_draft byte for
-- byte, and removes everything else 081 added: inspect_job, reopen_job, release_job_early, the triggers on jobs, job_inspections,
-- delivery_notes and invoices, their functions, public.job_flow_events, the seven job_inspections columns and their rules, and
-- public.flow_status(jobs). Afterwards a part failure releases the rest again, a Finish can be cleared by editing the job (035's reopen), a
-- pass needs no criteria and may be recorded by the person who finished the job, and a delivery note drafts its own invoice.
-- WHAT IS LOST: the rows of job_flow_events and the values of the new job_inspections columns. Each was written to the audit log when
-- it was made (audit_job_flow_events_changes and audit_job_inspections_changes), so the audit log keeps them; nothing else of them
-- stays. Draft invoices 081 made at Finish stay as ordinary drafts. Run the whole text as one transaction, then the release preflight
-- (081 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_rs TEXT;
  v_td TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_rs FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_td FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)');
  IF v_rs IS NULL OR v_rs NOT IN ('a7454c7da7ee23564436acfa6a330cd6', 'c16ea537b0b5706ab6db6e160214e17d')
     OR v_td IS NULL OR v_td NOT IN ('ef7acce200b6f0349c84f076725d77c1', '52a9771fec832f0e20e9d780e7561caa') THEN
    RAISE EXCEPTION '081 rollback: job_release_state (md5 %) or delivery_note_try_draft (md5 %) is neither 081''s nor the one it replaced; stop and compare',
      coalesce(v_rs, 'missing'), coalesce(v_td, 'missing');
  END IF;
END
$$;

-- 037's definition, verbatim (supabase/migrations/037_rework.sql section 3).
CREATE OR REPLACE FUNCTION public.job_release_state(p_job UUID)
RETURNS TABLE (released BOOLEAN, quantity_required NUMERIC, held NUMERIC, missing NUMERIC, available NUMERIC, holding BOOLEAN, blocked TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_job   RECORD;
  v_live  INTEGER;
  v_whole BOOLEAN;
  v_held  NUMERIC;
  v_miss  NUMERIC;
  v_loose INTEGER;
  v_rel   BOOLEAN;
  v_block TEXT;
  v_avail NUMERIC;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT jb.inspected_at, jb.quantity_required::NUMERIC AS q, jb.worksheet_version, jb.job_no, jb.converted_from_sales_order_id AS order_id INTO v_job
  FROM public.jobs jb WHERE jb.id = p_job AND jb.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- A part failure releases the rest only for the job as it was inspected: a later worksheet, quantity or drawing change (034
  -- withdraws the sign-off for those) withdraws that release too, until the job is inspected again.
  SELECT count(*), coalesce(bool_or(r.affects_all OR i.worksheet_version IS DISTINCT FROM v_job.worksheet_version
                                    OR (r.sales_order_line_id IS NULL AND r.quantity_affected IS NULL)), FALSE),
         coalesce(sum(coalesce(r.quantity_affected::NUMERIC, l.quantity, v_job.q, 0)), 0)
    INTO v_live, v_whole, v_held
  FROM public.job_rework r
  LEFT JOIN public.job_inspections i ON i.id = r.inspection_id
  LEFT JOIN public.sales_order_lines l ON l.id = r.sales_order_line_id
  WHERE r.job_id = p_job AND r.status IN ('open', 'in_progress', 'finished');
  SELECT coalesce(sum(r.quantity_scrapped - r.quantity_remade - r.quantity_carried), 0) INTO v_miss
  FROM public.job_rework r WHERE r.job_id = p_job AND r.status = 'closed';
  v_rel := (v_job.inspected_at IS NOT NULL AND v_live = 0) OR (v_live > 0 AND NOT v_whole);

  IF v_job.order_id IS NOT NULL THEN
    -- Every hold on a job made from an order is against one of the order's lines. One that isn't (its line was removed when the
    -- order's lines were rebuilt) can't be weighed, so nothing goes out until it is resolved.
    SELECT count(*) INTO v_loose FROM public.job_rework r
    WHERE r.job_id = p_job AND r.sales_order_line_id IS NULL
      AND (r.status IN ('open', 'in_progress', 'finished') OR r.quantity_scrapped > r.quantity_remade + r.quantity_carried);
    IF v_loose > 0 THEN
      v_block := format('%s can''t be despatched: part of it is held in rework or waiting for replacements, but not against a line of its sales order '
                        '(the order''s lines changed after the inspection failed), so what may go out can''t be worked out. Inspect it again, '
                        'failing the order line that is affected, and make any outstanding replacements (Rework, Make the outstanding replacements).', v_job.job_no);
    END IF;
    SELECT sum(CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC ELSE greatest(sl.quantity - h.held - h.missing, 0) END) INTO v_avail
    FROM public.sales_order_lines sl
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(coalesce(r.quantity_affected::NUMERIC, sl.quantity)) FILTER (WHERE r.status IN ('open', 'in_progress', 'finished')), 0) AS held,
             coalesce(sum(r.quantity_scrapped - r.quantity_remade - r.quantity_carried) FILTER (WHERE r.status = 'closed'), 0)::NUMERIC AS missing
      FROM public.job_rework r WHERE r.job_id = p_job AND r.sales_order_line_id = sl.id) h
    WHERE sl.sales_order_id = v_job.order_id AND sl.organization_id = v_org;
    v_avail := CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC ELSE v_avail END;
  ELSE
    -- The job's own quantity. With none on the worksheet, a hold can't be weighed against it: fail closed.
    IF v_job.q IS NULL AND v_rel AND (v_live > 0 OR v_miss > 0) THEN
      v_block := format('%s can''t be despatched: it has %s replacement(s) still to make or parts in rework, but no quantity on its worksheet, so what may go out '
                        'can''t be worked out. Enter the job''s quantity on its worksheet (it is then inspected again), or make and inspect the outstanding '
                        'replacements (Rework, Make the outstanding replacements).', v_job.job_no, v_miss);
    END IF;
    v_avail := CASE WHEN NOT v_rel OR v_block IS NOT NULL THEN 0::NUMERIC WHEN v_job.q IS NULL THEN NULL ELSE greatest(v_job.q - v_held - v_miss, 0) END;
  END IF;
  RETURN QUERY SELECT v_rel, v_job.q, v_held, v_miss, v_avail, (v_live > 0 OR v_miss > 0), v_block;
END
$$;
REVOKE ALL ON FUNCTION public.job_release_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_release_state(UUID) TO authenticated;

-- 059's definition, verbatim (supabase/migrations/059_delivery_note_auto_invoice.sql section 4).
CREATE OR REPLACE FUNCTION public.delivery_note_try_draft(p_note UUID, p_org UUID, p_cause TEXT)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_note   RECORD;
  v_block  TEXT;
  v_terms  TEXT;
  v_days   INT;
  v_today  DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_made   JSONB;
  v_state  TEXT;
  v_msg    TEXT;
BEGIN
  BEGIN
    -- The note's row lock: already held by the note's own update, which called this.
    SELECT d.id, d.status, d.invoice_id, d.invoice_ref, i.status AS invoice_status INTO v_note
    FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id
    WHERE d.id = p_note AND d.organization_id = p_org
    FOR UPDATE OF d;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF v_note.status NOT IN ('despatched', 'delivered', 'signed') THEN
      RETURN 'not_sent';
    END IF;
    -- Idempotent: a note on a live invoice (a draft included) is left alone.
    IF v_note.invoice_id IS NOT NULL AND lower(coalesce(v_note.invoice_status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') THEN
      RETURN 'invoiced';
    END IF;
    -- A hand-typed invoice reference (a hand-made note, or an import from the old system) means it was invoiced elsewhere.
    IF v_note.invoice_id IS NULL AND nullif(btrim(v_note.invoice_ref), '') IS NOT NULL THEN
      RETURN 'invoice_ref';
    END IF;
    v_block := public.delivery_note_draft_block(p_note);
    IF v_block IS NOT NULL THEN
      RETURN v_block;
    END IF;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    -- As the invoices page reads terms: "on receipt" is due today, else the first number in it is days, else 30.
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    v_made := public.invoice_from_delivery_notes_draft(p_org, ARRAY[p_note], v_today, v_today + v_days, v_terms);
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, invoice_id, cause, outcome, created_by)
    VALUES (p_org, p_note, (v_made ->> 'invoice_id')::UUID, p_cause, 'drafted', auth.uid());
    RETURN 'drafted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  -- Everything of the attempt is undone; what went wrong is kept, and the caller's change goes on.
  BEGIN
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, cause, outcome, error_code, error_message, created_by)
    VALUES (p_org, p_note, p_cause, 'failed', v_state, left(coalesce(nullif(v_msg, ''), 'unknown error'), 500), auth.uid());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '059: the draft invoice for delivery note % failed (%: %) and the failure could not be recorded', p_note, v_state, v_msg;
  END;
  RETURN 'failed';
END
$$;
REVOKE ALL ON FUNCTION public.delivery_note_try_draft(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ad_finish_kept ON public.jobs;
DROP TRIGGER IF EXISTS zz_jobs_flow_log ON public.jobs;
DROP TRIGGER IF EXISTS job_inspections_evidence ON public.job_inspections;
DROP TRIGGER IF EXISTS job_inspections_immutable ON public.job_inspections;
DROP TRIGGER IF EXISTS job_inspections_no_truncate ON public.job_inspections;
DROP TRIGGER IF EXISTS audit_job_inspections_changes ON public.job_inspections;
DROP TRIGGER IF EXISTS delivery_notes_release_gate ON public.delivery_notes;
DROP TRIGGER IF EXISTS invoices_job_release_gate ON public.invoices;
DROP FUNCTION IF EXISTS public.inspect_job(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS public.reopen_job(UUID, TEXT);
DROP FUNCTION IF EXISTS public.release_job_early(UUID, TEXT);
DROP FUNCTION IF EXISTS public.job_finish_draft_invoice(UUID, UUID);
DROP FUNCTION IF EXISTS public.jobs_flow_log();
DROP FUNCTION IF EXISTS public.jobs_finish_kept();
DROP FUNCTION IF EXISTS public.job_inspections_evidence();
DROP FUNCTION IF EXISTS public.job_inspections_immutable();
DROP FUNCTION IF EXISTS public.delivery_notes_release_gate();
DROP FUNCTION IF EXISTS public.invoices_job_release_gate();
DROP FUNCTION IF EXISTS public.job_early_release_active(UUID);
DROP TABLE IF EXISTS public.job_flow_events;
DROP FUNCTION IF EXISTS public.job_flow_events_immutable();
ALTER TABLE public.job_inspections DROP CONSTRAINT IF EXISTS job_inspections_criteria_shape;
ALTER TABLE public.job_inspections DROP CONSTRAINT IF EXISTS job_inspections_override_has_reason;
ALTER TABLE public.job_inspections DROP CONSTRAINT IF EXISTS job_inspections_disposition_shape;
ALTER TABLE public.job_inspections DROP CONSTRAINT IF EXISTS job_inspections_client_op;
ALTER TABLE public.job_inspections DROP COLUMN IF EXISTS acceptance_criteria, DROP COLUMN IF EXISTS independent, DROP COLUMN IF EXISTS override_reason,
  DROP COLUMN IF EXISTS disposition, DROP COLUMN IF EXISTS disposition_by, DROP COLUMN IF EXISTS finisher_ids, DROP COLUMN IF EXISTS client_op_id;
DROP FUNCTION IF EXISTS public.flow_status(public.jobs);

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)')) IS DISTINCT FROM 'a7454c7da7ee23564436acfa6a330cd6'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')) IS DISTINCT FROM 'ef7acce200b6f0349c84f076725d77c1'
     OR to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)') IS NOT NULL
     OR to_regclass('public.job_flow_events') IS NOT NULL
     OR to_regprocedure('public.flow_status(public.jobs)') IS NOT NULL THEN
    RAISE EXCEPTION '081 rollback: not back to 037''s job_release_state and 059''s delivery_note_try_draft, or something of 081 is left';
  END IF;
END
$$;
COMMIT;
