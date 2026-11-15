-- =====================================================================================================
-- p158 (post-144 release 158, after 157 in supabase/release-plan.json; 157 is merged but is not a code dependency, 158 keeps the tolra.finish_job flag that 157's jobs guard reads): machine run
-- integrity. A workshop user could pause ANOTHER operator's machine run with a back-dated end time (a 6 hour run became 0.00 hours and that
-- operator's job time closed with it) and then back-date their own start. The same hole was in finish_job, and a second route in
-- pause_machine_run: the caller's own back-dated run, ending last, makes the labour trigger close EVERYONE's open session on the job (labour_close_all)
-- at the caller's device time. PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/158_machine_run_integrity.release.sql, which adds the guard (the exact bodies 044 and 061 wrote, or 158's own), a before and after
-- check of the function settings and the self-check. Verify: supabase/verify/machine_run_integrity_158.sql (every row true).
-- Rollback: supabase/release/158_machine_run_integrity.rollback.sql (puts 044's pause_machine_run and 061's finish_job back, byte for byte).
--
-- PM-APPROVED RULE: server time whenever another operator has an open machine run or labour session on the job; the supplied device
-- time stays in the audit record. Applied in BOTH functions (pause alone would leave finish exploitable). Accepted consequence: a queued
-- (offline) action that affects another operator's open session gets the server's sync time as its effective completion time.
--
-- INPUTS: none (one-time replacement of two functions). OUTPUTS: public.pause_machine_run(uuid, uuid[], uuid, timestamptz) and
-- public.finish_job(uuid, uuid, timestamptz), same signatures, SECURITY DEFINER, search_path and grants as before.
-- WHAT IT CHANGES (the same decision in each, taken once, after the function's own locks and before any write):
--   * Another person = a machine run of the job with ended_at NULL whose operator is not the caller (a run with no operator counts as
--     another person), or an open (not ended, not voided) operator_sessions row of the job whose user is not the caller. ALL of the job's open
--     runs and sessions count, not only the machines being paused, because ending the last run closes everyone's session.
--   * If there is one: the effective time is clock_timestamp() (the server's clock, read after the locks). Else the caller's device time
--     (machine_run_client_time: now when missing or in the future, refused when older than 30 days) as before.
--   * The device time stays in the audit log: pause's PAUSE_MACHINE_RUN event (client_ended_at, as before) and finish's FINISH_ENDS_MACHINE_RUNS
--     event (client_finished_at, as before) and, new, one MACHINE_RUN_TIME_CONFLICT event per coerced action (why other_operator_open, the
--     client_ended_at or client_finished_at, used_at, the counts). No schema change: an existing event name, an existing audit table.
--   * Answers, stored replay results, replay behaviour, lock order, refusals and roles are unchanged.
-- LOCKING: the decision is made while holding the company lock 'job-no:<org>' and the job's row FOR UPDATE, the same two, in the same
--   order, that start_machine_run (046, 049), record_labour_event and add_labour_session take before they open a run or a session. Those are
--   the only writers that open one, so none can slip in between the decision and the writes. clock_timestamp() is read after the locks, so it
--   cannot be earlier than the start of anything that committed while this call waited. Remaining window: SQL run by the database owner or
--   the service role that inserts a run or session without those locks (imports, fixtures) is not covered.
-- MUST NOT CHANGE: machine_run_end, machine_run_client_time, machine_runs_labour, jobs_finish_labour, labour_close_all, start_machine_run
--   or any other function, any table, trigger, grant or policy; a person pausing or finishing their own work when alone on the job.
-- =====================================================================================================
BEGIN;

-- ---- 1. pause_machine_run: the server's time whenever another person has an open run or job time on the job ------------------------
-- 044's body. The device time (v_device_at, still bounded by machine_run_client_time) is used only when nobody but the caller has an open
-- run or session on the job; otherwise the effective time is the server's clock, read after the locks. Same signature, definer, search
-- path and grants as 044.
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
  v_device_at TIMESTAMPTZ;
  v_at    TIMESTAMPTZ;
  v_other_runs     BIGINT;
  v_other_sessions BIGINT;
  v_server         BOOLEAN;
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
  v_device_at := public.machine_run_client_time(p_ended_at);

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

  -- 158: ONE decision, here, after this function's own locks and before any write. The company lock 'job-no:<org>' and this job's row are
  -- held (the same two, in the same order, as start_machine_run, record_labour_event and add_labour_session, which are the only writers
  -- of an open run or session on a job), so nobody else can open a run or a session on this job between this read and the writes below.
  -- Anyone OTHER than the caller (a run with no operator counts as someone else) with an open run or an open job time session on THIS job,
  -- on any machine (ending the last run closes everyone's session), means the effective time is the server's clock, never the device's:
  -- the device time stays in the audit record only. clock_timestamp() is read AFTER the locks, so it is not before the start of any run or
  -- session another transaction committed while this one waited (now() is this transaction's start and could be). With nobody else open the
  -- caller's own time is the device time as before (v_device_at, bounded by machine_run_client_time).
  SELECT (SELECT count(*) FROM public.machine_runs r
           WHERE r.organization_id = v_org AND r.job_id = p_job AND r.ended_at IS NULL AND r.operator_id IS DISTINCT FROM auth.uid()),
         (SELECT count(*) FROM public.operator_sessions s
           WHERE s.organization_id = v_org AND s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL AND s.user_id IS DISTINCT FROM auth.uid())
    INTO v_other_runs, v_other_sessions;
  v_server := v_other_runs + v_other_sessions > 0;
  IF v_server THEN
    v_at := clock_timestamp();
  ELSE
    v_at := v_device_at;
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
  -- 158: the device's time, kept beside the server's when it was not used (the answer and the stored replay result are unchanged).
  IF v_server AND p_ended_at IS NOT NULL AND jsonb_array_length(v_ended) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'MACHINE_RUN_TIME_CONFLICT', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'operation', 'pause', 'why', 'other_operator_open', 'client_ended_at', p_ended_at, 'used_at', v_at,
                         'other_open_runs', v_other_runs, 'other_open_sessions', v_other_sessions, 'client_op_id', p_client_op_id,
                         'actor_user_id', auth.uid(), 'at', now()));
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

-- ---- 2. finish_job: the same rule ------------------------------------------------------------------------------------------------------
-- 061's body with the same decision, taken after the job is known not to be finished yet (a replay answers as before, changes nothing).
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
  v_device_at TIMESTAMPTZ;
  v_at    TIMESTAMPTZ;
  v_other_runs     BIGINT;
  v_other_sessions BIGINT;
  v_server         BOOLEAN;
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
  v_device_at := public.machine_run_client_time(p_finished_at);

  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'finished_at', v_job.finished_at, 'changed', FALSE, 'ended', '[]'::JSONB);
  END IF;

  -- 158: ONE decision, here, after this function's own locks and before any write. The company lock 'job-no:<org>' and this job's row are
  -- held (the same two, in the same order, as start_machine_run, record_labour_event and add_labour_session, which are the only writers
  -- of an open run or session on a job), so nobody else can open a run or a session on this job between this read and the writes below.
  -- Anyone OTHER than the caller (a run with no operator counts as someone else) with an open run or an open job time session on THIS job,
  -- on any machine (ending the last run closes everyone's session), means the effective time is the server's clock, never the device's:
  -- the device time stays in the audit record only. clock_timestamp() is read AFTER the locks, so it is not before the start of any run or
  -- session another transaction committed while this one waited (now() is this transaction's start and could be). With nobody else open the
  -- caller's own time is the device time as before (v_device_at, bounded by machine_run_client_time).
  SELECT (SELECT count(*) FROM public.machine_runs r
           WHERE r.organization_id = v_org AND r.job_id = p_job AND r.ended_at IS NULL AND r.operator_id IS DISTINCT FROM auth.uid()),
         (SELECT count(*) FROM public.operator_sessions s
           WHERE s.organization_id = v_org AND s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL AND s.user_id IS DISTINCT FROM auth.uid())
    INTO v_other_runs, v_other_sessions;
  v_server := v_other_runs + v_other_sessions > 0;
  IF v_server THEN
    v_at := clock_timestamp();
  ELSE
    v_at := v_device_at;
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
  -- 158: the device's time, kept beside the server's when it was not used (also when only job time sessions, no run, were open).
  IF v_server AND p_finished_at IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v_org, 'MACHINE_RUN_TIME_CONFLICT', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'operation', 'finish', 'why', 'other_operator_open', 'client_finished_at', p_finished_at, 'used_at', v_at,
                         'other_open_runs', v_other_runs, 'other_open_sessions', v_other_sessions, 'client_op_id', p_client_op_id,
                         'actor_user_id', auth.uid(), 'at', now()));
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
COMMIT;
