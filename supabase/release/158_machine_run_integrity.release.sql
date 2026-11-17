-- Post-144 release step 158 (machine run integrity: the server's time when another operator has an open run or job time on the job;
-- registered in supabase/release-plan.json as phase 158, after 157; CI's post-144 step installs it). One transaction; never part of baseline
-- replay. Not applied anywhere hosted. Canonical source: supabase/proposals/p158_machine_run_integrity.sql (its body between BEGIN; and
-- COMMIT; is copied below verbatim between the setting snapshot and the self-check; read its header). Its guard needs 044 (machine runs) and 051
-- (job labour, operator_sessions) and 061 (finish_job). Production only with Rhys's separate yes.
-- Verify: supabase/verify/machine_run_integrity_158.sql (every row true).
-- Rollback: supabase/release/158_machine_run_integrity.rollback.sql (puts 044's pause_machine_run and 061's finish_job back verbatim).
-- Running this file again once applied changes nothing (the bodies are already 158's, so the same text is written again).
-- REFUSES, changing nothing, if pause_machine_run is neither 044's nor 158's body or finish_job is neither 061's nor 158's body (HINT
-- machine_run_integrity_body), or if either is not a SECURITY DEFINER function with a pinned search path. Release preflight row 61 shows
-- which bodies are in place.
-- After it, a queued Pause or Finish that affects another operator's open run or job time is recorded at the server's sync time (the device
-- time stays in the audit log); a person alone on the job keeps their device time.
BEGIN;
DO $post_release_guard$
DECLARE
  v TEXT;
BEGIN
 IF to_regclass('public.machine_runs') IS NULL OR to_regclass('public.machine_run_ops') IS NULL OR to_regclass('public.operator_sessions') IS NULL
    OR to_regprocedure('public.machine_run_end(uuid,timestamptz,text,uuid)') IS NULL OR to_regprocedure('public.machine_run_client_time(timestamptz)') IS NULL
    OR to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') IS NULL OR to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') IS NULL THEN
  RAISE EXCEPTION '158: machine runs (044), job labour (051) or finish_job (061) is missing; stop and check release preflight';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)');
 IF v IS DISTINCT FROM '2a172ae0576c14095bc1281294789894' AND v IS DISTINCT FROM 'b00c08c8ee4934428f278fa6beadde1b' THEN
  RAISE EXCEPTION '158: public.pause_machine_run is neither 044''s nor 158''s; stop and compare it first' USING HINT = 'machine_run_integrity_body';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)');
 IF v IS DISTINCT FROM '57e2b9a298fa8647a775f8e0a56bbe58' AND v IS DISTINCT FROM '154bb3fff8179ce2f26c1810f054e18f' THEN
  RAISE EXCEPTION '158: public.finish_job is neither 061''s nor 158''s; stop and compare it first' USING HINT = 'machine_run_integrity_body';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'))
              AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public']))) THEN
  RAISE EXCEPTION '158: pause_machine_run and finish_job must be SECURITY DEFINER with search_path = pg_catalog, public; stop and compare them first' USING HINT = 'machine_run_integrity_body';
 END IF;
END $post_release_guard$;

-- Before: the settings of the two functions (definer flag, search path, owner, volatility, result type, language, grants) and a fingerprint of the
-- run, job time and operation rows 158 must not touch. The self-check requires the same. Session-only, dropped before COMMIT.
CREATE TEMP TABLE p158_before_fn ON COMMIT DROP AS
SELECT p.oid::regprocedure::TEXT AS sig, p.prosecdef, p.proconfig::TEXT AS config, p.proacl::TEXT AS acl, p.proowner::regrole::TEXT AS owner, p.provolatile,
       p.prorettype::regtype::TEXT AS ret, p.prolang::TEXT AS lang, p.proisstrict, p.proparallel
FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'));
CREATE FUNCTION pg_temp.p158_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p158fp$
  SELECT 'machine_runs'::TEXT, md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.machine_runs x
  UNION ALL SELECT 'operator_sessions', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.id), '')) FROM public.operator_sessions x
  UNION ALL SELECT 'machine_run_ops', md5(coalesce(string_agg(md5(to_jsonb(x)::TEXT), '' ORDER BY x.organization_id, x.client_op_id), '')) FROM public.machine_run_ops x
$p158fp$;
CREATE TEMP TABLE p158_before ON COMMIT DROP AS SELECT * FROM pg_temp.p158_fingerprint();

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

DO $p158_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b00c08c8ee4934428f278fa6beadde1b')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '154bb3fff8179ce2f26c1810f054e18f') THEN
    RAISE EXCEPTION '158 self-check: pause_machine_run and finish_job must be 158''s';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p158_before_fn EXCEPT SELECT p.oid::regprocedure::TEXT, p.prosecdef, p.proconfig::TEXT, p.proacl::TEXT, p.proowner::regrole::TEXT, p.provolatile,
                                                          p.prorettype::regtype::TEXT, p.prolang::TEXT, p.proisstrict, p.proparallel
                                                   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)')))
     OR (SELECT count(*) FROM pg_temp.p158_before_fn) <> 2
     OR EXISTS (SELECT p.oid::regprocedure::TEXT, p.prosecdef, p.proconfig::TEXT, p.proacl::TEXT, p.proowner::regrole::TEXT, p.provolatile,
                       p.prorettype::regtype::TEXT, p.prolang::TEXT, p.proisstrict, p.proparallel
                FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'))
                EXCEPT SELECT * FROM pg_temp.p158_before_fn) THEN
    RAISE EXCEPTION '158 self-check: the definer flag, search path, owner, volatility, result type, language or grants of pause_machine_run or finish_job changed';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE') OR has_function_privilege('anon', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '158 self-check: pause_machine_run and finish_job must be callable by signed-in users and not by anon';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p158_before EXCEPT SELECT * FROM pg_temp.p158_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p158_fingerprint() EXCEPT SELECT * FROM pg_temp.p158_before) THEN
    RAISE EXCEPTION '158 self-check: a machine run, job time session or machine run operation row changed';
  END IF;
END
$p158_self_check$;
DROP TABLE pg_temp.p158_before;
DROP TABLE pg_temp.p158_before_fn;
DROP FUNCTION pg_temp.p158_fingerprint();
COMMIT;
