-- Rollback of release step 158 (machine run integrity). One transaction.
-- Puts 044's pause_machine_run and 061's finish_job back byte for byte (their grants are restated as 044 and 061 wrote them). No row is
-- touched. Running it twice equals running it once. After it, a Pause or Finish by one person can again be back-dated over another
-- operator's open run or job time (the S1 defect is open again).
-- Order: roll 158 back BEFORE 061's or 044's rollback (those restore the same functions from older bodies).
-- Refuses, changing nothing, if either function is neither 158's nor the body it would put back (stop and compare it first).
BEGIN;
DO $rollback_guard$
DECLARE
  v TEXT;
BEGIN
 IF to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') IS NULL OR to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') IS NULL THEN
  RAISE EXCEPTION '158 rollback: pause_machine_run or finish_job (044, 061) is not installed; roll 158 back before 044 or 061';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)');
 IF v IS DISTINCT FROM 'b00c08c8ee4934428f278fa6beadde1b' AND v IS DISTINCT FROM '2a172ae0576c14095bc1281294789894' THEN
  RAISE EXCEPTION '158 rollback: public.pause_machine_run is neither 158''s nor 044''s; stop and compare it first';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)');
 IF v IS DISTINCT FROM '154bb3fff8179ce2f26c1810f054e18f' AND v IS DISTINCT FROM '57e2b9a298fa8647a775f8e0a56bbe58' THEN
  RAISE EXCEPTION '158 rollback: public.finish_job is neither 158''s nor 061''s; stop and compare it first';
 END IF;
END $rollback_guard$;

-- 044's pause_machine_run, verbatim (supabase/release/044_machine_runs.release.sql).
CREATE OR REPLACE FUNCTION public.pause_machine_run(p_job UUID, p_machines UUID[], p_client_op_id UUID, p_ended_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_job   public.jobs%ROWTYPE;
  v_at    TIMESTAMPTZ;
  v_run   RECORD;
  v_ended JSONB := '[]'::JSONB;
  v_op    public.machine_run_ops%ROWTYPE;
  v_conflicts JSONB;
  v_result JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can pause a job' USING ERRCODE = '42501';
  END IF;
  IF cardinality(coalesce(p_machines, ARRAY[]::UUID[])) > 10 THEN
    RAISE EXCEPTION 'Up to 10 machines per pause.' USING ERRCODE = '22023';
  END IF;
  v_at := public.machine_run_client_time(p_ended_at);

  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- A replay (same key, same job) answers the first call's result from machine_run_ops, even when it ended nothing, and ends nothing now
  -- (a later Start's runs stay open); the same key for another job (or a Start's key) is refused, never reported as replayed.
  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_op FROM public.machine_run_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_op.job_id = p_job AND v_op.kind = 'pause' THEN
        RETURN v_op.result || jsonb_build_object('replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This Pause was already recorded against another job. Reload the board and try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_run IN
    SELECT r.id FROM public.machine_runs r
    WHERE r.job_id = p_job AND r.ended_at IS NULL
      AND (p_machines IS NULL OR cardinality(p_machines) = 0 OR r.machine_id = ANY (p_machines))
    ORDER BY r.started_at
  LOOP
    v_ended := v_ended || public.machine_run_end(v_run.id, v_at, 'paused', p_client_op_id);
  END LOOP;
  v_conflicts := public.machine_run_end_conflicts(v_ended);

  IF jsonb_array_length(v_ended) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'PAUSE_MACHINE_RUN', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'ended_at', v_at, 'ended', v_ended, 'client_op_id', p_client_op_id, 'client_ended_at', p_ended_at, 'time_conflicts', v_conflicts));
  END IF;
  IF jsonb_array_length(v_conflicts) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'MACHINE_RUN_TIME_CONFLICT', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'operation', 'pause', 'time_conflicts', v_conflicts, 'client_op_id', p_client_op_id,
                         'client_ended_at', p_ended_at, 'actor_user_id', auth.uid(), 'at', now()));
  END IF;
  v_result := jsonb_build_object('job_id', p_job, 'ended', v_ended, 'time_conflicts', v_conflicts, 'replayed', FALSE);
  IF p_client_op_id IS NOT NULL THEN
    INSERT INTO public.machine_run_ops (organization_id, client_op_id, kind, job_id, result, created_by) VALUES (v_org, p_client_op_id, 'pause', p_job, v_result, auth.uid());
  END IF;
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.pause_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pause_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ) TO authenticated;

-- 061's finish_job, verbatim (supabase/release/061_auto_book_next_free.release.sql).
CREATE OR REPLACE FUNCTION public.finish_job(p_job UUID, p_client_op_id UUID, p_finished_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_job   public.jobs%ROWTYPE;
  v_at    TIMESTAMPTZ;
  v_run   RECORD;
  v_b     RECORD;
  v_ended JSONB := '[]'::JSONB;
  v_completed JSONB := '[]'::JSONB;
  v_conflicts JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can finish a job' USING ERRCODE = '42501';
  END IF;
  v_at := public.machine_run_client_time(p_finished_at);

  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'finished_at', v_job.finished_at, 'changed', FALSE, 'ended', '[]'::JSONB);
  END IF;

  PERFORM set_config('tolra.finish_job', 'on', TRUE);
  UPDATE public.jobs SET finished_at = v_at, started_at = coalesce(started_at, v_at), stage = 'inspection' WHERE id = p_job;
  PERFORM set_config('tolra.finish_job', 'off', TRUE);

  FOR v_run IN SELECT r.id FROM public.machine_runs r WHERE r.job_id = p_job AND r.ended_at IS NULL ORDER BY r.started_at LOOP
    v_ended := v_ended || public.machine_run_end(v_run.id, v_at, 'finished', p_client_op_id);
  END LOOP;
  v_conflicts := public.machine_run_end_conflicts(v_ended);
  IF jsonb_array_length(v_ended) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'FINISH_ENDS_MACHINE_RUNS', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'finished_at', v_at, 'ended', v_ended, 'client_op_id', p_client_op_id, 'client_finished_at', p_finished_at, 'time_conflicts', v_conflicts));
  END IF;
  IF jsonb_array_length(v_conflicts) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'MACHINE_RUN_TIME_CONFLICT', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'operation', 'finish', 'time_conflicts', v_conflicts, 'client_op_id', p_client_op_id,
                         'client_finished_at', p_finished_at, 'actor_user_id', auth.uid(), 'at', now()));
  END IF;

  -- 061: the job is finished, so its machine time is too: every booking of THIS job not yet complete (never played, paused, a bench run,
  -- a booking the runs never named) completes, hours done as recorded. Other jobs' bookings are not touched.
  FOR v_b IN
    SELECT b.id FROM public.machine_bookings b
    WHERE b.organization_id = v_org AND b.job_id = p_job AND b.status <> 'complete'
    ORDER BY b.start_at, b.id
  LOOP
    v_completed := v_completed || coalesce(public.machine_booking_mirror(v_b.id, v_org, 'complete', 0), '[]'::JSONB);
  END LOOP;
  IF jsonb_array_length(v_completed) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'FINISH_COMPLETES_BOOKINGS', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'finished_at', v_at, 'bookings', v_completed, 'client_op_id', p_client_op_id));
  END IF;
  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'finished_at', v_at, 'changed', TRUE, 'ended', v_ended, 'time_conflicts', v_conflicts,
                            'bookings_completed', v_completed);
END
$$;
REVOKE ALL ON FUNCTION public.finish_job(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_job(UUID, UUID, TIMESTAMPTZ) TO authenticated;

DO $rollback_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2a172ae0576c14095bc1281294789894')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '57e2b9a298fa8647a775f8e0a56bbe58') THEN
    RAISE EXCEPTION '158 rollback self-check: pause_machine_run must be 044''s and finish_job 061''s again';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'))
               AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public'])))
     OR NOT has_function_privilege('authenticated', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '158 rollback self-check: definer flags, search path or grants are not as 044 and 061 left them';
  END IF;
END
$rollback_self_check$;
COMMIT;
