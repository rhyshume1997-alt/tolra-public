-- =====================================================================================================
-- 092: an admin's Release machine also ends the job time it stopped (Rhys's walkthrough, Thu 22 Oct, L11; ruling relayed by Rhys:
-- acceptable if it keeps the hours recorded so far, shows who ended it and why, and a new Start is needed to resume). Applies after 085
-- and 084; independent of 086 to 091 (other branches). Needs only 044 (machine_runs, release_machine) and 051 (operator_sessions,
-- labour_close, machine_runs_labour and its trigger).
--
-- WHY. 051's machine_runs_labour ends labour when a run ends 'paused', 'finished' or 'override', but not 'admin_released' (051 header:
-- "an admin's release ... ends no labour"). On production J-0010's run was released by an admin at 14:55:05 BST and the operator's job
-- time (operator_sessions) kept counting until 15:09:17, 14 minutes more, with nothing on the run to say so.
--
-- WHAT CHANGES.
--   a. operator_sessions.end_source may also be 'admin_released' (the CHECK is replaced with the same list plus that value), and a new
--      column operator_sessions.end_reason TEXT (NULL, or 3 to 500 characters) holds the admin's reason. ended_by (051) already says who.
--   b. machine_runs_labour (051, the AFTER UPDATE OF ended_at trigger on machine_runs) treats a run ended 'admin_released' as a Pause:
--      when the release leaves the job with no open run, everyone's open session on the job ends at the run's end; else only the run's
--      operator's, once they have no other open run on the job. Those sessions end with end_source 'admin_released', ended_by the admin
--      (labour_close's coalesce(auth.uid(), ...)), at the same instant as the run (or at a session's own start when that is later, as
--      every other end). started_at .. ended_at is kept: the hours recorded so far stay; the session simply stops counting.
--   c. labour_close (051, internal) writes end_reason from the transaction-local quoteflow.release_reason when it ends a session
--      'admin_released' (NULL for every other end source, as before).
--   d. release_machine (044) sets quoteflow.release_reason to the admin's reason around its one machine_run_end call and clears it
--      straight after (the 032 / 073 / 091 pattern). Its checks, lock, audit row (RELEASE_MACHINE) and answer are unchanged.
-- UNCHANGED PATHS: Start (a new Start opens a new session as today: 051's INSERT branch is untouched), Pause, Finish, override and bench
-- to machine (their end sources and the sessions they end are as before; only the CASE gains a branch they never reach), the sheet's
-- Start / Stop (record_labour_event), add / correct / void (052: a correction of a released session keeps end_source and end_reason),
-- jobs_finish_labour, labour_close_all (unchanged; it passes the end source through). The labour write stays best effort (a failure is
-- LABOUR_WRITE_FAILED, never undoes the release). The approved-week check is unchanged (release_machine is admin only, and admins are
-- exempt from it). No policy, grant or row is changed; no pay arithmetic changes (lib/time-sheet.ts counts started_at .. ended_at).
-- GUARD (section 1): labour_close and machine_runs_labour must be 051's or 092's, release_machine 044's or 092's (md5 with every
-- whitespace character removed). Safe to run again.
-- Rollback: supabase/release/092_release_ends_session.rollback.sql (only with Rhys's approval; puts 051's and 044's bodies back).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 092 builds on is there, and each body it replaces is the one it was written against (or already 092's).
DO $$
BEGIN
  IF to_regclass('public.operator_sessions') IS NULL OR to_regclass('public.machine_runs') IS NULL
     OR to_regprocedure('public.release_machine(uuid, text)') IS NULL OR to_regprocedure('public.machine_runs_labour()') IS NULL
     OR to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)') IS NULL THEN
    RAISE EXCEPTION '092: operator_sessions / labour_close / machine_runs_labour (051) or machine_runs / release_machine (044) is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)'))
       NOT IN ('77bb57169c5235f1bbd7cc5823ead5b7', '05c6a7a7b87e77ff928a235bec2a4635') THEN
    RAISE EXCEPTION '092: public.labour_close is neither 051''s nor 092''s; stop and compare it first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.machine_runs_labour()'))
       NOT IN ('afb1ff078a608e7748c6f75f369e2249', '48f0b169d1beb1de9976f542ac182b3e') THEN
    RAISE EXCEPTION '092: public.machine_runs_labour() is neither 051''s nor 092''s; stop and compare it first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_machine(uuid, text)'))
       NOT IN ('85a72dc839da55046880163014e87800', 'f3d62432af1642a30ff8045c543f8d3d') THEN
    RAISE EXCEPTION '092: public.release_machine(uuid, text) is neither 044''s nor 092''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Who ended a session and why: end_source 'admin_released' (ended_by, 051, is the admin) and the admin's reason.
ALTER TABLE public.operator_sessions ADD COLUMN IF NOT EXISTS end_reason TEXT;
ALTER TABLE public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_reason;
ALTER TABLE public.operator_sessions ADD CONSTRAINT operator_sessions_end_reason
  CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 500);
ALTER TABLE public.operator_sessions DROP CONSTRAINT IF EXISTS operator_sessions_end_source_check;
ALTER TABLE public.operator_sessions ADD CONSTRAINT operator_sessions_end_source_check
  CHECK (end_source IN ('sheet', 'machine_pause', 'machine_finish', 'machine_override', 'job_finish', 'pending_stop', 'correction', 'admin_released'));

-- -----------------------------------------------------------------------------------------------------
-- 3. labour_close: 051's body plus end_reason, written from quoteflow.release_reason only when the end source is 'admin_released'.
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
      end_reason = CASE WHEN p_end_source = 'admin_released' THEN nullif(btrim(coalesce(current_setting('quoteflow.release_reason', TRUE), '')), '') END,
      device_ended_at = CASE WHEN conflict THEN p_at END, updated_at = now()
  WHERE id = v_open.id
  RETURNING * INTO session;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3a. machine_runs_labour: 051's body, with a run ended 'admin_released' ending labour as a Pause does (end source 'admin_released').
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
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.end_reason NOT IN ('paused', 'finished', 'override', 'admin_released') THEN
    RETURN NULL;
  END IF;
  -- Nothing runs on the job any more (Pause on the whole job, Finish, or an admin's release): everyone's time on it stops. Else only the operator's, once
  -- their own runs on the job have all stopped (other people's runs and time carry on). The caller holds the job row: runs can't change.
  v_all := NEW.end_reason IN ('paused', 'finished', 'admin_released')
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
                                      CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'admin_released' THEN 'admin_released' ELSE 'machine_pause' END, NEW.ended_op_id);
    ELSE
      SELECT * INTO v_r FROM public.labour_close(NEW.operator_id, NEW.job_id, NEW.ended_at,
                                                 CASE NEW.end_reason WHEN 'finished' THEN 'machine_finish' WHEN 'override' THEN 'machine_override' WHEN 'admin_released' THEN 'admin_released' ELSE 'machine_pause' END,
                                                 NEW.ended_op_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.labour_write_failed(NEW.organization_id, 'machine_runs', NEW.id, 'close', SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3b. release_machine: 044's body plus quoteflow.release_reason (the admin's reason) around its one machine_run_end call, cleared after.
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
  PERFORM set_config('quoteflow.release_reason', v_reason, TRUE);
  v_ended := public.machine_run_end(v_open_id, now(), 'admin_released', NULL);
  PERFORM set_config('quoteflow.release_reason', '', TRUE);
  PERFORM security_audit.log_named_event(v_org, 'RELEASE_MACHINE', 'jobs', v_open_job::TEXT,
    jsonb_build_object('job_no', v_open_no, 'machine_id', p_machine, 'machine', v_name, 'reason', v_reason, 'conflicts', jsonb_build_array(v_ended),
                       'clashing_job_nos', jsonb_build_array(v_open_no), 'actor_user_id', auth.uid(), 'at', now(), 'released', v_ended));
  RETURN jsonb_build_object('machine_id', p_machine, 'machine', v_name, 'released', v_ended || jsonb_build_object('job_no', v_open_no));
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 4. Grants as 044 and 051 state them (both internal functions not callable from the API; release_machine by authenticated only), and
-- 051's trigger restated unchanged (machine_runs AFTER INSERT OR UPDATE OF ended_at, the 092 body).
REVOKE ALL ON FUNCTION public.labour_close(UUID, UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.machine_runs_labour() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_machine(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_machine(UUID, TEXT) TO authenticated;
DROP TRIGGER IF EXISTS zz_machine_runs_labour ON public.machine_runs;
CREATE TRIGGER zz_machine_runs_labour AFTER INSERT OR UPDATE OF ended_at ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.machine_runs_labour();

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT: the three bodies are 092's with their security and search_path, the grants are as above, the trigger is
-- on machine_runs, and the column and both checks are there.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '05c6a7a7b87e77ff928a235bec2a4635' OR p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.labour_close(uuid, uuid, timestamptz, text, uuid)')) THEN
    RAISE EXCEPTION '092: labour_close is not 092''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '48f0b169d1beb1de9976f542ac182b3e' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.machine_runs_labour()')) THEN
    RAISE EXCEPTION '092: machine_runs_labour is not 092''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'f3d62432af1642a30ff8045c543f8d3d' OR NOT p.prosecdef
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.release_machine(uuid, text)')) THEN
    RAISE EXCEPTION '092: release_machine is not 092''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.labour_close(uuid, uuid, timestamptz, text, uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.labour_close(uuid, uuid, timestamptz, text, uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.machine_runs_labour()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.machine_runs_labour()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.release_machine(uuid, text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.release_machine(uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '092: an internal function is callable from the API, or release_machine''s grants changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_machine_runs_labour' AND t.tgrelid = 'public.machine_runs'::regclass
                   AND t.tgfoid = 'public.machine_runs_labour()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '092: the machine_runs labour trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operator_sessions' AND column_name = 'end_reason' AND data_type = 'text')
     OR (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.operator_sessions'::regclass AND c.contype = 'c'
           AND ((c.conname = 'operator_sessions_end_reason' AND pg_get_constraintdef(c.oid) LIKE '%end_reason%')
                OR (c.conname = 'operator_sessions_end_source_check' AND pg_get_constraintdef(c.oid) LIKE '%''admin_released''%'))) <> 2 THEN
    RAISE EXCEPTION '092: operator_sessions.end_reason or its checks are missing';
  END IF;
END
$$;
