-- Rollback of 092 (an admin's Release machine also ends the job time it stopped). ONE transaction: run the whole text; if anything
-- fails, nothing of it is kept. Only with Rhys's approval. Puts back 051's labour_close and machine_runs_labour and 044's
-- release_machine exactly (their grants and 051's trigger unchanged), removes operator_sessions.end_reason and its check, and restores
-- 051's end_source check (without 'admin_released'). Afterwards an admin's release ends no labour again (051).
-- STOPS (nothing changed) while any body is neither 092's nor the earlier one, or while any session was ended by a release
-- (end_source 'admin_released') or carries an end_reason: those rows hold who ended the time and why, and the rollback never drops that
-- silently. Report the count to Rhys; deciding what such rows become is his (no rollback text changes them).
-- Safe to run twice. Then `notify pgrst, 'reload schema';` and the release preflight (marker 092 "not applied").
BEGIN;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)'))
       NOT IN ('05c6a7a7b87e77ff928a235bec2a4635', '77bb57169c5235f1bbd7cc5823ead5b7') THEN
    RAISE EXCEPTION '092 rollback: public.labour_close is neither 092''s nor 051''s; stop and compare';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.machine_runs_labour()'))
       NOT IN ('48f0b169d1beb1de9976f542ac182b3e', 'afb1ff078a608e7748c6f75f369e2249') THEN
    RAISE EXCEPTION '092 rollback: public.machine_runs_labour() is neither 092''s nor 051''s; stop and compare';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_machine(uuid, text)'))
       NOT IN ('f3d62432af1642a30ff8045c543f8d3d', '85a72dc839da55046880163014e87800') THEN
    RAISE EXCEPTION '092 rollback: public.release_machine(uuid, text) is neither 092''s nor 044''s; stop and compare';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_sessions' AND column_name = 'end_reason') THEN
    IF EXISTS (SELECT 1 FROM public.operator_sessions s WHERE s.end_source = 'admin_released' OR s.end_reason IS NOT NULL) THEN
      RAISE EXCEPTION '092 rollback: % job time session(s) were ended by an admin''s release; stop and report the count to Rhys',
        (SELECT count(*) FROM public.operator_sessions s WHERE s.end_source = 'admin_released' OR s.end_reason IS NOT NULL);
    END IF;
  END IF;
END
$$;

ALTER TABLE public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_source_check;
ALTER TABLE public.operator_sessions ADD CONSTRAINT operator_sessions_end_source_check
  CHECK (end_source IN ('sheet', 'machine_pause', 'machine_finish', 'machine_override', 'job_finish', 'pending_stop', 'correction'));
ALTER TABLE public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_reason;

-- 051's labour_close, exactly as supabase/migrations/051_job_labour.sql creates it (end_reason is no longer written).
CREATE OR REPLACE FUNCTION public.labour_close(p_user UUID, p_job UUID, p_at TIMESTAMPTZ, p_end_source TEXT, p_op UUID,
                                               OUT session public.operator_sessions, OUT conflict BOOLEAN)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open public.operator_sessions%ROWTYPE;
BEGIN
  conflict := FALSE;
  SELECT * INTO v_open FROM public.operator_sessions s
  WHERE s.user_id = p_user AND s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  conflict := p_at < v_open.started_at;
  UPDATE public.operator_sessions
  SET ended_at = CASE WHEN conflict THEN v_open.started_at ELSE p_at END,
      end_source = p_end_source, ended_by = coalesce(auth.uid(), p_user), end_op_id = p_op,
      device_ended_at = CASE WHEN conflict THEN p_at END, updated_at = now()
  WHERE id = v_open.id
  RETURNING * INTO session;
END
$$;
REVOKE ALL ON FUNCTION public.labour_close(UUID, UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- 051's machine_runs_labour, exactly as supabase/migrations/051_job_labour.sql creates it ('admin_released' ends no labour).
CREATE OR REPLACE FUNCTION public.machine_runs_labour()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_r   RECORD;
  v_all BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only an open run pressed by a signed-in person opens labour.
    IF NEW.operator_id IS NULL OR NEW.ended_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    -- 1. The presser's labour lock (approve_time_week takes it too). If even that fails, the labour is skipped, never the Start.
    BEGIN
      PERFORM public.labour_lock(NEW.organization_id, NEW.operator_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.labour_write_failed(NEW.organization_id, 'machine_runs', NEW.id, 'open', SQLSTATE, SQLERRM);
      RETURN NULL;
    END;
    -- 2. Approved hours, under the lock: refused before anything is written, run and all (only when this Start would open labour).
    IF NOT EXISTS (SELECT 1 FROM public.operator_sessions s WHERE s.user_id = NEW.operator_id AND s.job_id = NEW.job_id
                   AND s.ended_at IS NULL AND s.voided_at IS NULL) THEN
      PERFORM public.labour_assert_week_open(NEW.organization_id, NEW.operator_id, NEW.started_at);
    END IF;
    -- 3. The write: a failure is logged, never allowed to undo the Start.
    BEGIN
      SELECT * INTO v_r FROM public.labour_open(NEW.organization_id, NEW.operator_id, NEW.job_id, NEW.started_at, 'machine', NEW.id, NEW.client_op_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.labour_write_failed(NEW.organization_id, 'machine_runs', NEW.id, 'open', SQLSTATE, SQLERRM);
    END;
    RETURN NULL;
  END IF;
  -- UPDATE: a run that has just ended.
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.end_reason NOT IN ('paused', 'finished', 'override') THEN
    RETURN NULL;
  END IF;
  -- Nothing runs on the job any more (Pause on the whole job, or Finish): everyone's time on it stops. Else only the operator's, once
  -- their own runs on the job have all stopped (other people's runs and time carry on). The caller holds the job row: runs can't change.
  v_all := NEW.end_reason IN ('paused', 'finished')
           AND NOT EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = NEW.job_id AND r.ended_at IS NULL AND r.id <> NEW.id);
  IF NOT v_all AND (NEW.operator_id IS NULL
                    OR EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = NEW.job_id AND r.ended_at IS NULL AND r.id <> NEW.id
                                 AND r.operator_id = NEW.operator_id)) THEN
    RETURN NULL;
  END IF;
  -- 1. The labour locks of everyone with time open on the job (and the operator), in user id order.
  BEGIN
    PERFORM public.labour_lock_job_people(NEW.organization_id, NEW.job_id, NEW.operator_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.labour_write_failed(NEW.organization_id, 'machine_runs', NEW.id, 'close', SQLSTATE, SQLERRM);
    RETURN NULL;
  END;
  -- 2. Approved hours, under the locks: every session this end would close (refused whole, outside the catch).
  PERFORM public.labour_assert_week_open(NEW.organization_id, s.user_id, NEW.ended_at)
  FROM public.operator_sessions s
  WHERE s.job_id = NEW.job_id AND s.ended_at IS NULL AND s.voided_at IS NULL AND (v_all OR s.user_id = NEW.operator_id);
  -- 3. The write.
  BEGIN
    IF v_all THEN
      PERFORM public.labour_close_all(NEW.organization_id, NEW.job_id, NEW.ended_at,
                                      CASE WHEN NEW.end_reason = 'finished' THEN 'machine_finish' ELSE 'machine_pause' END, NEW.ended_op_id);
    ELSE
      SELECT * INTO v_r FROM public.labour_close(NEW.operator_id, NEW.job_id, NEW.ended_at,
                                                 CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'override' THEN 'machine_override' ELSE 'machine_pause' END,
                                                 NEW.ended_op_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.labour_write_failed(NEW.organization_id, 'machine_runs', NEW.id, 'close', SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.machine_runs_labour() FROM PUBLIC, anon, authenticated;

-- 044's release_machine, exactly as supabase/migrations/044_machine_runs.sql creates it (no quoteflow.release_reason).
CREATE OR REPLACE FUNCTION public.release_machine(p_machine UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_name  TEXT;
  v_open_id UUID;
  v_open_job UUID;
  v_open_no TEXT;
  v_ended JSONB;
  v_reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can release a machine' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for releasing the machine (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;
  SELECT m.name INTO v_name FROM public.machines m WHERE m.id = p_machine AND m.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT r.id, r.job_id, j.job_no INTO v_open_id, v_open_job, v_open_no FROM public.machine_runs r JOIN public.jobs j ON j.id = r.job_id
  WHERE r.machine_id = p_machine AND r.ended_at IS NULL;
  IF v_open_id IS NULL THEN
    RETURN jsonb_build_object('machine_id', p_machine, 'machine', v_name, 'released', NULL);
  END IF;
  v_ended := public.machine_run_end(v_open_id, now(), 'admin_released', NULL);
  PERFORM security_audit.log_named_event(v_org, 'RELEASE_MACHINE', 'jobs', v_open_job::TEXT,
    jsonb_build_object('job_no', v_open_no, 'machine_id', p_machine, 'machine', v_name, 'reason', v_reason, 'conflicts', jsonb_build_array(v_ended),
                       'clashing_job_nos', jsonb_build_array(v_open_no), 'actor_user_id', auth.uid(), 'at', now(), 'released', v_ended));
  RETURN jsonb_build_object('machine_id', p_machine, 'machine', v_name, 'released', v_ended || jsonb_build_object('job_no', v_open_no));
END
$$;
REVOKE ALL ON FUNCTION public.release_machine(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_machine(UUID, TEXT) TO authenticated;

ALTER TABLE public.operator_sessions DROP COLUMN IF EXISTS end_reason;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)'))
       IS DISTINCT FROM '77bb57169c5235f1bbd7cc5823ead5b7'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.machine_runs_labour()'))
       IS DISTINCT FROM 'afb1ff078a608e7748c6f75f369e2249'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_machine(uuid, text)'))
       IS DISTINCT FROM '85a72dc839da55046880163014e87800' THEN
    RAISE EXCEPTION '092 rollback: a body is not 051''s / 044''s after the rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_sessions' AND column_name = 'end_reason')
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.operator_sessions'::regclass AND c.conname = 'operator_sessions_end_reason')
     OR (SELECT pg_get_constraintdef(c.oid) LIKE '%admin_released%' FROM pg_constraint c
         WHERE c.conrelid = 'public.operator_sessions'::regclass AND c.conname = 'operator_sessions_end_source_check') IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION '092 rollback: operator_sessions still has 092''s column or check';
  END IF;
END
$$;

COMMIT;
