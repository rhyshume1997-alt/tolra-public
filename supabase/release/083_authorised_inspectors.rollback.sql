-- 083 rollback: ONLY with Rhys's approval, and only while no job has a drawing revision entered or required (those are records: once one
-- exists, forward-fix instead). Puts back 081's public.inspect_job byte for byte (its interim check: an admin, or someone ticked), and
-- removes the drawing revision columns and their check, the pass check on job_inspections and job_signoffs, the history trigger on
-- organization_members, set_authorised_inspector and public.inspector_authorisations. Inspections then follow 081's rule again. The
-- list's history stays in the audit log (each row was audited as it was written, and each change through the app as SET_INSPECTOR);
-- can_inspect is left as it is (an admin ticked by 083's backfill keeps the tick, which under 081 changes nothing: admins may inspect).
-- Run the whole text as one transaction, then `notify pgrst, 'reload schema';` and the release preflight (083 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_held BOOLEAN;
BEGIN
  IF coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)')), 'missing')
       NOT IN ('b411b17ef7cb8a5f3700957d9a7a264f', 'c8dd01f7f385e60e1a4597e5f1da8fe8')
     OR (to_regprocedure('public.inspection_pass_authorised()') IS NOT NULL
         AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.inspection_pass_authorised()'))
             IS DISTINCT FROM 'a3280e8e083ff65f62334c60d78fd997') THEN
    RAISE EXCEPTION '083 rollback: inspect_job or inspection_pass_authorised is neither 083''s nor the one it replaced; stop and compare';
  END IF;
  -- Dynamic, so a second run (the columns already gone) still parses.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'drawing_revision') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.jobs j WHERE j.drawing_revision IS NOT NULL OR j.drawing_revision_required)' INTO v_held;
    IF v_held THEN
      RAISE EXCEPTION '083 holds drawing revisions on jobs: do not roll back; forward-fix instead';
    END IF;
  END IF;
END
$$;

-- 081's definition, verbatim (supabase/migrations/081_job_flow_release.sql).
CREATE OR REPLACE FUNCTION public.inspect_job(p_job UUID, p_result TEXT, p_criteria TEXT, p_measured TEXT, p_expected_version INTEGER,
                                              p_attachment_path TEXT DEFAULT NULL, p_attachment_name TEXT DEFAULT NULL, p_concession_reason TEXT DEFAULT NULL,
                                              p_override_reason TEXT DEFAULT NULL, p_disposition TEXT DEFAULT NULL, p_failure JSONB DEFAULT NULL,
                                              p_client_op_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_user     UUID := auth.uid();
  v_criteria TEXT := nullif(btrim(p_criteria), '');
  v_measured TEXT := nullif(btrim(p_measured), '');
  v_override TEXT := nullif(btrim(p_override_reason), '');
  v_disp     TEXT := nullif(btrim(p_disposition), '');
  v_fail     JSONB := CASE WHEN p_failure IS NULL OR jsonb_typeof(p_failure) = 'null' THEN '{}'::JSONB ELSE p_failure END;
  v_job      RECORD;
  v_prior    RECORD;
  v_out      JSONB;
  v_conc     JSONB;
  v_rework   RECORD;
  v_qty      INTEGER;
  v_id       UUID;
  v_rec      RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  -- A committed record for this offline key: answer it, before any other check, and insert nothing.
  IF p_client_op_id IS NOT NULL THEN
    SELECT i.id, i.job_id, i.result, i.inspector_id, i.release_decision, i.inspected_at, i.independent INTO v_prior
    FROM public.job_inspections i WHERE i.organization_id = v_org AND i.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_prior.job_id = p_job AND v_prior.inspector_id = v_user AND v_prior.result = p_result THEN
        RETURN jsonb_build_object('inspection_id', v_prior.id, 'result', v_prior.result, 'release_decision', v_prior.release_decision,
                                  'inspected_at', v_prior.inspected_at, 'independent', v_prior.independent, 'replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This inspection was already sent for something else, so it wasn''t recorded again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;
  IF NOT public.has_org_role(ARRAY['admin'])
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_user AND m.organization_id = v_org AND m.active AND m.can_inspect) THEN
    RAISE EXCEPTION 'An admin has to make you an inspector before you can record inspections.' USING ERRCODE = '42501';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('pass', 'fail', 'concession') THEN
    RAISE EXCEPTION 'The result must be pass, fail or concession.' USING ERRCODE = '22023';
  END IF;
  IF v_criteria IS NULL OR length(v_criteria) > 2000 THEN
    RAISE EXCEPTION 'Give the acceptance criteria (what it was checked against, up to 2000 characters).' USING ERRCODE = '22023', HINT = 'criteria_required';
  END IF;
  IF v_measured IS NULL OR length(v_measured) > 2000 THEN
    RAISE EXCEPTION 'Give the measured or checked result (up to 2000 characters).' USING ERRCODE = '22023', HINT = 'criteria_required';
  END IF;
  IF v_override IS NOT NULL AND (length(v_override) < 10 OR length(v_override) > 500) THEN
    RAISE EXCEPTION 'The reason for inspecting your own work must be 10 to 500 characters.' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;
  IF jsonb_typeof(v_fail) <> 'object' THEN
    RAISE EXCEPTION 'What failed must be given as an object.' USING ERRCODE = '22023';
  END IF;
  IF p_result = 'fail' THEN
    IF v_disp IS NULL OR v_disp NOT IN ('rework', 'scrap', 'concession') THEN
      RAISE EXCEPTION 'Say what happens to what failed: rework, scrap or concession.' USING ERRCODE = '22023', HINT = 'disposition_required';
    END IF;
    IF nullif(btrim(v_fail ->> 'reason'), '') IS NULL THEN
      RAISE EXCEPTION 'Say what failed.' USING ERRCODE = '22023', HINT = 'disposition_required';
    END IF;
    IF v_disp = 'concession' AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'A concession has to be authorised by an admin.' USING ERRCODE = '42501', HINT = 'concession_admin_only';
    END IF;
  ELSIF v_disp IS NOT NULL THEN
    RAISE EXCEPTION 'A disposition is only for a failed inspection.' USING ERRCODE = '22023', HINT = 'disposition_required';
  END IF;

  SELECT j.id, j.job_no, j.worksheet_version INTO v_job FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- The offline key again, under the job's row lock (two sends at once: the second waits, then finds the first's record).
  IF p_client_op_id IS NOT NULL THEN
    SELECT i.id, i.job_id, i.result, i.inspector_id, i.release_decision, i.inspected_at, i.independent INTO v_prior
    FROM public.job_inspections i WHERE i.organization_id = v_org AND i.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_prior.job_id = p_job AND v_prior.inspector_id = v_user AND v_prior.result = p_result THEN
        RETURN jsonb_build_object('inspection_id', v_prior.id, 'result', v_prior.result, 'release_decision', v_prior.release_decision,
                                  'inspected_at', v_prior.inspected_at, 'independent', v_prior.independent, 'replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This inspection was already sent for something else, so it wasn''t recorded again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  PERFORM set_config('quoteflow.inspection_evidence',
    jsonb_build_object('job', p_job, 'criteria', v_criteria, 'override_reason', v_override, 'disposition', v_disp, 'client_op_id', p_client_op_id)::TEXT, TRUE);
  IF p_result IN ('pass', 'concession') THEN
    v_out := public.record_job_inspection(p_job, p_result, v_measured, p_attachment_path, p_attachment_name, p_concession_reason, p_expected_version);
  ELSE
    v_out := public.fail_job_inspection(p_job, v_measured, v_fail ->> 'reason', (v_fail ->> 'quantity')::INTEGER,
               coalesce(nullif(btrim(v_fail ->> 'instructions'), ''),
                        CASE v_disp WHEN 'scrap' THEN 'Scrap the failed parts and make replacements, then send it for inspection again.'
                                    WHEN 'concession' THEN 'None: accepted on concession.'
                                    ELSE NULL END),
               p_attachment_path, p_attachment_name, CASE WHEN v_fail ? 'lines' THEN v_fail -> 'lines' END, nullif(btrim(v_fail ->> 'batch'), ''));
    IF v_disp = 'scrap' THEN
      FOR v_rework IN SELECT r.id, r.quantity_affected FROM public.job_rework r
                      WHERE r.id IN (SELECT (x #>> '{}')::UUID FROM jsonb_array_elements(v_out -> 'rework_ids') x) ORDER BY r.raised_at, r.id LOOP
        IF v_rework.quantity_affected IS NULL THEN
          RAISE EXCEPTION '% failed without a quantity, so it can''t be scrapped as a whole: say how many failed.', v_job.job_no USING ERRCODE = '22023', HINT = 'scrap_needs_quantity';
        END IF;
        v_qty := v_rework.quantity_affected;
        PERFORM public.scrap_job_quantity(v_rework.id, v_qty, v_fail ->> 'reason');
      END LOOP;
    ELSIF v_disp = 'concession' THEN
      -- The concession is its own record (034), on the job as it is now; the offline key stays on the fail record.
      PERFORM set_config('quoteflow.inspection_evidence',
        jsonb_build_object('job', p_job, 'criteria', v_criteria, 'override_reason', v_override)::TEXT, TRUE);
      v_conc := public.record_job_inspection(p_job, 'concession', v_measured, NULL, NULL, p_concession_reason,
                                             (SELECT j.worksheet_version FROM public.jobs j WHERE j.id = p_job));
      v_out := v_out || jsonb_build_object('concession', v_conc, 'release_decision', 'released');
    END IF;
  END IF;
  PERFORM set_config('quoteflow.inspection_evidence', '', TRUE);

  v_id := (v_out ->> 'inspection_id')::UUID;
  SELECT i.independent, i.override_reason, i.disposition INTO v_rec FROM public.job_inspections i WHERE i.id = v_id;
  RETURN v_out || jsonb_build_object('independent', v_rec.independent, 'not_independent_reason', v_rec.override_reason,
                                     'disposition', v_rec.disposition, 'replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.inspect_job(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspect_job(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO authenticated;

DROP TRIGGER IF EXISTS jobs_zz_drawing_revision ON public.jobs;
DROP FUNCTION IF EXISTS public.set_job_drawing_revision(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.jobs_drawing_revision_guard();
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_drawing_revision_shape;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS drawing_revision;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS drawing_revision_required;
DROP TRIGGER IF EXISTS zz_inspection_pass_authorised ON public.job_inspections;
DROP TRIGGER IF EXISTS zz_inspection_pass_authorised ON public.job_signoffs;
DROP TRIGGER IF EXISTS zz_inspector_history ON public.organization_members;
DROP FUNCTION IF EXISTS public.set_authorised_inspector(uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.inspection_pass_authorised();
DROP FUNCTION IF EXISTS public.organization_members_inspector_history();
DROP TABLE IF EXISTS public.inspector_authorisations;
DROP FUNCTION IF EXISTS public.iso_083_record_immutable();
COMMIT;
