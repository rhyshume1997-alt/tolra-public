-- =====================================================================================================
-- 051: job labour (operator_sessions): who worked on which job, when. Time and pay plan, PR 2 (docs/plans/time-and-pay.md section 4).
-- Feeds the daily job sheet: the jobs a person worked on each day and the time on each.
--
-- 1. operator_sessions: one row per stretch of one person's work on one job (started_at .. ended_at; open while ended_at is NULL).
--    ONE OPEN SESSION PER PERSON AND JOB (unique partial index) and no two overlapping sessions of one person on one job (exclusion
--    constraint, voided rows excepted), whatever writes. A person may be on several jobs at once (minding two machines): the sheet
--    counts their time once (the union) and splits it equally between the jobs (lib/time-sheet.ts). Never deleted by the API: a wrong
--    session is VOIDED with a reason; a correction keeps the first times on the row (original_started_at / original_ended_at) and in
--    the audit log (log_row_change and LABOUR_CORRECTED / LABOUR_VOIDED / LABOUR_ADDED).
-- 2. Start / Pause / Finish write labour IN THE SAME TRANSACTION as the run, without replacing any existing function (044, 046, 049
--    and 061's bodies are untouched), through two triggers:
--    * machine_runs AFTER INSERT of an open run (a Start, machine or bench): opens a session for the person who pressed Start
--      (operator_id), unless they already have one open on that job. It starts at the run's start, or just after their last session
--      on that job ended (never overlapping; the run's time is kept as device_started_at when it can't be used).
--    * machine_runs AFTER UPDATE OF ended_at: EACH PERSON'S labour follows THEIR runs. When a run ends 'paused', 'finished' or
--      'override' (an admin took the machine), its operator's session on that job ends at the run's end once they have no other open
--      run on the job (Charlie pausing his machine ends Charlie's time while Lee's machine and Lee's time carry on). When a Pause or
--      Finish leaves the job with NO open run (Pause on the whole job, or Finish), EVERYONE's session on the job ends at that time,
--      including people who joined from the sheet. An admin's release ('admin_released', a forgotten Finish) and a bench run handed to
--      a machine ('to_machine') end no labour.
--    * jobs AFTER UPDATE OF finished_at (a Finish, through finish_job or the plain update for a job with no machine): everyone's
--      session on that job ends at the finish time.
--    Rows written by the database owner or the service role with no signed-in person (imports, fixtures) open nothing, nor does a run
--    inserted already ended. The labour side is a side effect: if it ever fails, the Start, Pause or Finish still goes through, the
--    labour change is skipped and LABOUR_WRITE_FAILED is written to the audit log with the error (and a WARNING) for an admin to fix.
--    One exception, checked BEFORE that, as record_labour_event does: a signed-in non-admin's Start, Pause or Finish that would write
--    someone's labour at a time at or before the approval of that person's week (a device time sent late) is REFUSED (42501, hint
--    week_approved), run and all, so approved hours can't be changed from the board either. Doing it now is never refused. The check
--    runs AFTER the person's labour lock is taken (see LOCK ORDER), never inside the best-effort catch.
-- 3. record_labour_event(key, job, 'start' | 'stop', time): Start and Stop on the daily job sheet for the caller's own labour (Join
--    and Leave in the plan), sent through the offline outbox with a key: a replay answers the first result. A Stop that reaches the
--    server before its Start (two devices) is kept as a pending stop and closes the session when the Start arrives. Device times as
--    044: future clamped to now, older than 14 days refused (time_too_old), a time that would overlap or end before the start uses the
--    server's time with the device's kept (time_conflict in the answer). The person's own Start/Stop (not an admin's) is refused at a
--    time in an approved week before the approval (050's time_week_locked_at; 052).
-- 4. add_labour_session / correct_labour_session / void_labour_session (a reason of 3 to 500 characters): the person on their own
--    sessions until the week is approved (052), an admin on anyone's at any time.
--
-- LOCK ORDER, the same as 042 to 046 everywhere here: (1) the per-company advisory lock 'job-no:<org>' (the functions; the triggers run
-- inside a caller that already holds it or holds the job row; 044/046/049's machine and run rows come under it), (2) the job's row,
-- (3) the company's audit-chain lock (050's time_company_lock: security_audit.set_audit_hash, 006, takes it for every audit row and
-- holds it to commit, so every one of these writes holds it from its first audit row anyway), (4) the per-person lock
-- 'labour:<org>:<user>', several people in user id order (labour_lock_job_people), then operator_sessions and labour_ops. labour_lock
-- takes (3) then (4), so no write can hold a person's lock while it waits for the audit chain. Attendance (050) takes (3) then its own
-- 'attendance:<org>:<user>', never (1), (2) or the labour lock; labour never takes attendance's.
-- APPROVED WEEKS (052): approve_time_week takes (3), then the person's 'attendance:' and 'labour:' locks, never (1) or (2), and works
-- out the week's revision only once it holds them. Every labour write takes the lock of each person it writes FIRST and only then asks
-- whether the week is approved (time_week_locked_at / time_week_locked, read in a statement that starts after the lock, so an approval
-- committed while it waited is seen): an approval and a labour write of one person are serialised, whichever comes first. The lock is
-- per person, so it covers every week of theirs (a write near midnight on a Sunday touches two weeks' revisions).
--
-- Read: each person their own sessions (admin, office, workshop); admin and office the company's; viewer none. No direct client
-- writes. Additive: two tables, two triggers on existing tables (AFTER, writing only the new tables and the audit log), sixteen
-- functions.
-- Forward only, safe to run more than once. Needs 050 (time_caller_org, attendance_client_time, time_week_of, time_week_locked,
-- time_week_locked_at).
-- Rollback: docs/RELEASE.md "Migration 051".
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.operator_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  job_id              UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  source              TEXT NOT NULL CHECK (source IN ('sheet', 'machine', 'manual')),
  end_source          TEXT CHECK (end_source IN ('sheet', 'machine_pause', 'machine_finish', 'machine_override', 'job_finish', 'pending_stop', 'correction')),
  ended_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  machine_run_id      UUID REFERENCES public.machine_runs(id) ON DELETE SET NULL,
  start_op_id         UUID,
  end_op_id           UUID,
  device_started_at   TIMESTAMPTZ,
  device_ended_at     TIMESTAMPTZ,
  original_started_at TIMESTAMPTZ,
  original_ended_at   TIMESTAMPTZ,
  corrected_at        TIMESTAMPTZ,
  corrected_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  correction_reason   TEXT,
  voided_at           TIMESTAMPTZ,
  voided_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason         TEXT,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_sessions_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT operator_sessions_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT operator_sessions_correction_reason CHECK (corrected_at IS NULL OR length(btrim(coalesce(correction_reason, ''))) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_sessions_one_open ON public.operator_sessions (user_id, job_id) WHERE ended_at IS NULL AND voided_at IS NULL;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.operator_sessions'::regclass AND conname = 'operator_sessions_no_overlap') THEN
    ALTER TABLE public.operator_sessions ADD CONSTRAINT operator_sessions_no_overlap
      EXCLUDE USING gist (user_id WITH =, job_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&) WHERE (voided_at IS NULL);
  END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS idx_operator_sessions_person ON public.operator_sessions (organization_id, user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_job ON public.operator_sessions (job_id);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_run ON public.operator_sessions (machine_run_id) WHERE machine_run_id IS NOT NULL;

ALTER TABLE public.operator_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operator_sessions rbac select" ON public.operator_sessions;
CREATE POLICY "operator_sessions rbac select" ON public.operator_sessions FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id()
         AND ((user_id = auth.uid() AND public.has_org_role(ARRAY['admin', 'office', 'workshop'])) OR public.has_org_role(ARRAY['admin', 'office'])));
REVOKE ALL ON public.operator_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.operator_sessions TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.operator_sessions;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.operator_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_machine_run_id ON public.operator_sessions;
CREATE TRIGGER zz_same_org_machine_run_id BEFORE INSERT OR UPDATE ON public.operator_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machine_runs', 'machine_run_id');
DROP TRIGGER IF EXISTS audit_operator_sessions_changes ON public.operator_sessions;
CREATE TRIGGER audit_operator_sessions_changes AFTER INSERT OR UPDATE OR DELETE ON public.operator_sessions
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.operator_sessions;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.operator_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.operator_sessions;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.operator_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- The durable answer of every keyed labour action (Start, Stop, Add), and a Stop that found nothing open (pending_at: it closes the
-- person's next session on that job that starts at or before it). No API role reads or writes it.
CREATE TABLE IF NOT EXISTS public.labour_ops (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_op_id    UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('start', 'stop', 'add')),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  result          JSONB NOT NULL,
  pending_at      TIMESTAMPTZ,
  consumed_by     UUID REFERENCES public.operator_sessions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, client_op_id),
  CONSTRAINT labour_ops_pending_is_stop CHECK (pending_at IS NULL OR kind = 'stop')
);
CREATE INDEX IF NOT EXISTS idx_labour_ops_pending ON public.labour_ops (organization_id, user_id, job_id, pending_at) WHERE pending_at IS NOT NULL AND consumed_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_labour_ops_job ON public.labour_ops (job_id);
ALTER TABLE public.labour_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.labour_ops FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.labour_ops;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.labour_ops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS support_read_only ON public.labour_ops;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.labour_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.labour_ops;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.labour_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- ---- Shared pieces -------------------------------------------------------------------------------------------------------------
-- A person's job time can't change while this is held: the company lock first (050's time_company_lock, see LOCK ORDER), then
-- 'labour:<org>:<user>'. Internal.
CREATE OR REPLACE FUNCTION public.labour_lock(p_org UUID, p_user UUID)
RETURNS VOID
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  SELECT public.time_company_lock(p_org);
  SELECT pg_advisory_xact_lock(hashtextextended('labour:' || p_org::TEXT || ':' || p_user::TEXT, 0));
$$;
REVOKE ALL ON FUNCTION public.labour_lock(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The labour locks of everyone with an open session on p_job, and of p_also when given, in user id order (the order every write of
-- several people's labour uses, so two of them can't deadlock). The caller holds the job row, so the set can't grow meanwhile. Internal.
CREATE OR REPLACE FUNCTION public.labour_lock_job_people(p_org UUID, p_job UUID, p_also UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user UUID;
BEGIN
  FOR v_user IN SELECT x.u FROM (SELECT s.user_id AS u FROM public.operator_sessions s
                                 WHERE s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL
                                 UNION SELECT p_also WHERE p_also IS NOT NULL) x ORDER BY x.u LOOP
    PERFORM public.labour_lock(p_org, v_user);
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION public.labour_lock_job_people(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.labour_answer(p_s public.operator_sessions, p_state TEXT, p_conflict BOOLEAN, p_device_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('state', p_state, 'session_id', p_s.id, 'user_id', p_s.user_id, 'job_id', p_s.job_id, 'started_at', p_s.started_at,
                            'ended_at', p_s.ended_at, 'time_conflict', coalesce(p_conflict, FALSE), 'device_at', p_device_at)
$$;
REVOKE ALL ON FUNCTION public.labour_answer(public.operator_sessions, TEXT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- Opens a session for p_user on p_job at p_at, never overlapping their earlier sessions on that job (it starts after the last one ended
-- when p_at falls inside one: the time asked for is kept as device_started_at). Returns the open session (an existing one when they
-- already have one open: p_existing TRUE). The caller holds the job row and labour_lock. Internal.
CREATE OR REPLACE FUNCTION public.labour_open(p_org UUID, p_user UUID, p_job UUID, p_at TIMESTAMPTZ, p_source TEXT, p_run UUID, p_op UUID,
                                              OUT session public.operator_sessions, OUT existing BOOLEAN, OUT conflict BOOLEAN)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_last  TIMESTAMPTZ;
  v_start TIMESTAMPTZ := p_at;
BEGIN
  existing := FALSE;
  conflict := FALSE;
  SELECT * INTO session FROM public.operator_sessions s
  WHERE s.user_id = p_user AND s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL;
  IF FOUND THEN
    existing := TRUE;
    RETURN;
  END IF;
  SELECT max(s.ended_at) INTO v_last FROM public.operator_sessions s
  WHERE s.user_id = p_user AND s.job_id = p_job AND s.voided_at IS NULL AND s.ended_at > p_at;
  IF v_last IS NOT NULL THEN
    conflict := TRUE;
    v_start := v_last;
  END IF;
  INSERT INTO public.operator_sessions (organization_id, user_id, job_id, started_at, source, machine_run_id, start_op_id, device_started_at, created_by)
  VALUES (p_org, p_user, p_job, v_start, p_source, p_run, p_op, CASE WHEN conflict THEN p_at END, coalesce(auth.uid(), p_user))
  RETURNING * INTO session;
END
$$;
REVOKE ALL ON FUNCTION public.labour_open(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Ends p_user's open session on p_job at p_at (at its start when p_at is earlier: never a negative stretch; the time asked for is kept
-- as device_ended_at). NULL when nothing is open. The caller holds the job row and labour_lock. Internal.
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

-- ---- Start / Pause / Finish on the Job Board write labour in the same transaction ----------------------------------------------
-- Ends every open session on p_job at p_at (at a session's own start when that is later). People are locked in user order, so two of
-- these on different jobs can't deadlock; the caller holds the job row. Returns how many ended. Internal.
CREATE OR REPLACE FUNCTION public.labour_close_all(p_org UUID, p_job UUID, p_at TIMESTAMPTZ, p_end_source TEXT, p_op UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user  UUID;
  v_start TIMESTAMPTZ;
  v_n     INTEGER := 0;
  v_r     RECORD;
BEGIN
  FOR v_user IN SELECT DISTINCT s.user_id FROM public.operator_sessions s
                WHERE s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL ORDER BY s.user_id LOOP
    PERFORM public.labour_lock(p_org, v_user);
    SELECT s.started_at INTO v_start FROM public.operator_sessions s
    WHERE s.user_id = v_user AND s.job_id = p_job AND s.ended_at IS NULL AND s.voided_at IS NULL;
    SELECT * INTO v_r FROM public.labour_close(v_user, p_job, greatest(p_at, v_start), p_end_source, p_op);
    IF (v_r.session).id IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.labour_close_all(UUID, UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- A labour write that failed inside a Start, Pause or Finish: logged (WARNING and LABOUR_WRITE_FAILED in the audit log), never allowed
-- to undo the run. Internal.
CREATE OR REPLACE FUNCTION public.labour_write_failed(p_org UUID, p_table TEXT, p_id UUID, p_what TEXT, p_state TEXT, p_message TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE WARNING 'labour % for % % skipped: % (%)', p_what, p_table, p_id, p_message, p_state;
  BEGIN
    PERFORM security_audit.log_named_event(p_org, 'LABOUR_WRITE_FAILED', p_table, p_id::TEXT,
      jsonb_build_object('what', p_what, 'sqlstate', p_state, 'error', left(p_message, 500)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'LABOUR_WRITE_FAILED could not be audited: %', SQLERRM;
  END;
END
$$;
REVOKE ALL ON FUNCTION public.labour_write_failed(UUID, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Refuses (42501, week_approved) when a signed-in caller who is not an admin would write p_user's labour at p_at, inside p_user's
-- approved week at or before its approval (050's time_week_locked_at, real from 052). The caller holds p_user's labour lock (so an
-- approval can't commit between this check and the write) and calls it outside any catch (a refusal undoes the whole action). Internal.
CREATE OR REPLACE FUNCTION public.labour_assert_week_open(p_org UUID, p_user UUID, p_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND p_user IS NOT NULL AND NOT public.has_org_role(ARRAY['admin'])
     AND public.time_week_locked_at(p_org, p_user, p_at) THEN
    RAISE EXCEPTION 'That time is in a week that has already been approved. Do it now, or ask an admin.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.labour_assert_week_open(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

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
DROP TRIGGER IF EXISTS zz_machine_runs_labour ON public.machine_runs;
CREATE TRIGGER zz_machine_runs_labour AFTER INSERT OR UPDATE OF ended_at ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.machine_runs_labour();

CREATE OR REPLACE FUNCTION public.jobs_finish_labour()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL THEN
    RETURN NULL;
  END IF;
  -- 1. The labour locks of everyone with time open on the job, in user id order (this row is held: the set can't grow).
  BEGIN
    PERFORM public.labour_lock_job_people(NEW.organization_id, NEW.id, NULL);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.labour_write_failed(NEW.organization_id, 'jobs', NEW.id, 'close_all', SQLSTATE, SQLERRM);
    RETURN NULL;
  END;
  -- 2. Approved hours, under the locks: every open session this Finish would close (refused whole, outside the catch).
  PERFORM public.labour_assert_week_open(NEW.organization_id, s.user_id, NEW.finished_at)
  FROM public.operator_sessions s WHERE s.job_id = NEW.id AND s.ended_at IS NULL AND s.voided_at IS NULL;
  -- 3. The write.
  BEGIN
    PERFORM public.labour_close_all(NEW.organization_id, NEW.id, NEW.finished_at, 'job_finish', NULL);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.labour_write_failed(NEW.organization_id, 'jobs', NEW.id, 'close_all', SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_finish_labour() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_jobs_finish_labour ON public.jobs;
CREATE TRIGGER zz_jobs_finish_labour AFTER UPDATE OF finished_at ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_finish_labour();

-- ---- Start and Stop on the daily job sheet ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_labour_event(p_client_op_id UUID, p_job UUID, p_action TEXT, p_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID;
  v_op     public.labour_ops%ROWTYPE;
  v_at     TIMESTAMPTZ;
  v_s      public.operator_sessions%ROWTYPE;
  v_exist  BOOLEAN;
  v_conf   BOOLEAN;
  v_stop   public.labour_ops%ROWTYPE;
  v_result JSONB;
  v_pending TIMESTAMPTZ;
  r        RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'A Start or Stop needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('start', 'stop') THEN
    RAISE EXCEPTION 'Unknown job time action.' USING ERRCODE = '22023', HINT = 'bad_action';
  END IF;
  -- Lock order: company, job row, person.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_op FROM public.labour_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_op.user_id = v_uid AND v_op.job_id = p_job AND v_op.kind = p_action THEN
      RETURN v_op.result || jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'This Start or Stop was already recorded for something else. Reload and try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  PERFORM 1 FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  v_at := public.attendance_client_time(p_at);
  PERFORM public.labour_lock(v_org, v_uid);
  -- Not into hours already approved (an admin may: they can correct anything). Asked under the person's lock, which approve_time_week
  -- takes too: an approval committed while this waited is seen.
  IF NOT public.has_org_role(ARRAY['admin']) AND public.time_week_locked_at(v_org, v_uid, v_at) THEN
    RAISE EXCEPTION 'That time is in a week that has already been approved. Ask an admin to add it.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
  IF p_action = 'start' THEN
    SELECT * INTO r FROM public.labour_open(v_org, v_uid, p_job, v_at, 'sheet', NULL, p_client_op_id);
    v_s := r.session;
    v_exist := r.existing;
    v_conf := r.conflict;
    IF v_exist THEN
      v_result := public.labour_answer(v_s, 'already', FALSE, NULL);
    ELSE
      -- A Stop that reached the server first (another device) closes it now: the earliest pending Stop at or after this Start.
      SELECT * INTO v_stop FROM public.labour_ops o
      WHERE o.organization_id = v_org AND o.user_id = v_uid AND o.job_id = p_job AND o.pending_at IS NOT NULL AND o.consumed_by IS NULL
        AND o.pending_at >= v_s.started_at
      ORDER BY o.pending_at LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        SELECT * INTO r FROM public.labour_close(v_uid, p_job, v_stop.pending_at, 'pending_stop', v_stop.client_op_id);
        v_s := r.session;
        UPDATE public.labour_ops SET consumed_by = v_s.id WHERE organization_id = v_org AND client_op_id = v_stop.client_op_id;
        v_result := public.labour_answer(v_s, 'started_and_stopped', v_conf, CASE WHEN v_conf THEN v_at END);
      ELSE
        v_result := public.labour_answer(v_s, 'started', v_conf, CASE WHEN v_conf THEN v_at END);
      END IF;
    END IF;
  ELSE
    SELECT * INTO r FROM public.labour_close(v_uid, p_job, v_at, 'sheet', p_client_op_id);
    v_s := r.session;
    v_conf := r.conflict;
    IF v_s.id IS NULL THEN
      v_pending := v_at;
      v_result := jsonb_build_object('state', 'nothing_open', 'session_id', NULL, 'user_id', v_uid, 'job_id', p_job, 'started_at', NULL,
                                     'ended_at', v_at, 'time_conflict', FALSE, 'device_at', NULL);
    ELSE
      v_result := public.labour_answer(v_s, 'stopped', v_conf, CASE WHEN v_conf THEN v_at END);
    END IF;
  END IF;
  INSERT INTO public.labour_ops (organization_id, client_op_id, kind, user_id, job_id, result, pending_at)
  VALUES (v_org, p_client_op_id, p_action, v_uid, p_job, v_result, v_pending);
  RETURN v_result || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.record_labour_event(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_labour_event(UUID, UUID, TEXT, TIMESTAMPTZ) TO authenticated;

-- ---- Add, correct, void (a reason; own sessions until the week is approved, an admin anyone's) ---------------------------------------
-- Checks the caller may change p_user's labour around p_at (and p_at2): returns whether the caller is an admin. Internal.
CREATE OR REPLACE FUNCTION public.labour_may_change(p_org UUID, p_user UUID, p_at TIMESTAMPTZ, p_at2 TIMESTAMPTZ, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin BOOLEAN := public.has_org_role(ARRAY['admin']);
BEGIN
  IF p_user <> auth.uid() AND NOT v_admin THEN
    RAISE EXCEPTION 'Only an admin can change someone else''s job time.' USING ERRCODE = '42501', HINT = 'admin_only';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Give a reason (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;
  IF NOT v_admin AND (public.time_week_locked(p_org, p_user, public.time_week_of(p_at))
                      OR (p_at2 IS NOT NULL AND public.time_week_locked(p_org, p_user, public.time_week_of(p_at2)))) THEN
    RAISE EXCEPTION 'That week has been approved. Ask an admin to change it.' USING ERRCODE = '42501', HINT = 'week_approved';
  END IF;
  RETURN v_admin;
END
$$;
REVOKE ALL ON FUNCTION public.labour_may_change(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;

-- Times for a manual session: a start, an end after it (or none: still open, only for a correction of an open session), not in the future.
CREATE OR REPLACE FUNCTION public.labour_check_times(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_end_required BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_start IS NULL OR (p_end_required AND p_end IS NULL) OR p_end < p_start OR p_start > now() + INTERVAL '1 minute' OR p_end > now() + INTERVAL '1 minute'
     OR p_start < TIMESTAMPTZ '2020-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'Give a start and an end after it, not in the future.' USING ERRCODE = '22023', HINT = 'bad_time';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.labour_check_times(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_labour_session(p_client_op_id UUID, p_user UUID, p_job UUID, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID;
  v_user UUID := coalesce(p_user, auth.uid());
  v_op   public.labour_ops%ROWTYPE;
  v_s    public.operator_sessions%ROWTYPE;
  v_res  JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  IF p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'Adding job time needs its key.' USING ERRCODE = '22023', HINT = 'client_op_missing';
  END IF;
  PERFORM public.labour_may_change(v_org, v_user, p_started_at, p_ended_at, p_reason);
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_org AND m.user_id = v_user AND NOT m.support) THEN
    RAISE EXCEPTION 'That person is not in this company.' USING ERRCODE = 'P0002', HINT = 'not_member';
  END IF;
  PERFORM public.labour_check_times(p_started_at, p_ended_at, TRUE);
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_op FROM public.labour_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_op.user_id = v_user AND v_op.job_id = p_job AND v_op.kind = 'add' THEN
      RETURN v_op.result || jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'This change was already recorded for something else. Reload and try again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;
  PERFORM 1 FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.labour_lock(v_org, v_user);
  -- Asked again under the person's lock (an approval may have committed while this waited).
  PERFORM public.labour_may_change(v_org, v_user, p_started_at, p_ended_at, p_reason);
  BEGIN
    INSERT INTO public.operator_sessions (organization_id, user_id, job_id, started_at, ended_at, source, end_source, ended_by, start_op_id,
                                          corrected_at, corrected_by, correction_reason, created_by)
    VALUES (v_org, v_user, p_job, p_started_at, p_ended_at, 'manual', 'correction', auth.uid(), p_client_op_id, now(), auth.uid(), btrim(p_reason), auth.uid())
    RETURNING * INTO v_s;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That overlaps time already recorded on this job. Correct that entry instead.' USING ERRCODE = '23P01', HINT = 'labour_overlap';
  END;
  v_res := public.labour_answer(v_s, 'added', FALSE, NULL);
  INSERT INTO public.labour_ops (organization_id, client_op_id, kind, user_id, job_id, result) VALUES (v_org, p_client_op_id, 'add', v_user, p_job, v_res);
  PERFORM security_audit.log_named_event(v_org, 'LABOUR_ADDED', 'operator_sessions', v_s.id::TEXT,
    jsonb_build_object('user_id', v_user, 'job_id', p_job, 'started_at', p_started_at, 'ended_at', p_ended_at, 'reason', btrim(p_reason)));
  RETURN v_res || jsonb_build_object('replayed', FALSE);
END
$$;
REVOKE ALL ON FUNCTION public.add_labour_session(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_labour_session(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;

-- New times for a session (an open session may get its end here: that ends it). The first times stay on the row. Repeating the same
-- correction changes nothing (same answer).
CREATE OR REPLACE FUNCTION public.correct_labour_session(p_session UUID, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
  v_s   public.operator_sessions%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  SELECT * INTO v_s FROM public.operator_sessions s WHERE s.id = p_session AND s.organization_id = v_org;
  IF NOT FOUND OR v_s.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'That job time was not found.' USING ERRCODE = 'P0002', HINT = 'session_missing';
  END IF;
  PERFORM public.labour_check_times(p_started_at, p_ended_at, v_s.ended_at IS NOT NULL);
  PERFORM public.labour_may_change(v_org, v_s.user_id, least(v_s.started_at, p_started_at), greatest(coalesce(v_s.ended_at, v_s.started_at), coalesce(p_ended_at, p_started_at)), p_reason);
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  PERFORM 1 FROM public.jobs j WHERE j.id = v_s.job_id FOR UPDATE;
  PERFORM public.labour_lock(v_org, v_s.user_id);
  SELECT * INTO v_s FROM public.operator_sessions s WHERE s.id = p_session FOR UPDATE;
  IF v_s.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'That job time was not found.' USING ERRCODE = 'P0002', HINT = 'session_missing';
  END IF;
  -- Asked again under the person's lock, on the row as it is now (an approval may have committed while this waited).
  PERFORM public.labour_may_change(v_org, v_s.user_id, least(v_s.started_at, p_started_at), greatest(coalesce(v_s.ended_at, v_s.started_at), coalesce(p_ended_at, p_started_at)), p_reason);
  IF v_s.started_at = p_started_at AND v_s.ended_at IS NOT DISTINCT FROM p_ended_at THEN
    RETURN public.labour_answer(v_s, 'unchanged', FALSE, NULL);
  END IF;
  BEGIN
    UPDATE public.operator_sessions
    SET original_started_at = coalesce(original_started_at, started_at),
        original_ended_at = CASE WHEN original_started_at IS NULL THEN ended_at ELSE original_ended_at END,
        started_at = p_started_at, ended_at = p_ended_at,
        end_source = CASE WHEN ended_at IS NULL AND p_ended_at IS NOT NULL THEN 'correction' ELSE end_source END,
        ended_by = CASE WHEN ended_at IS NULL AND p_ended_at IS NOT NULL THEN auth.uid() ELSE ended_by END,
        corrected_at = now(), corrected_by = auth.uid(), correction_reason = btrim(p_reason), updated_at = now()
    WHERE id = p_session
    RETURNING * INTO v_s;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That overlaps time already recorded on this job. Correct that entry instead.' USING ERRCODE = '23P01', HINT = 'labour_overlap';
  END;
  PERFORM security_audit.log_named_event(v_org, 'LABOUR_CORRECTED', 'operator_sessions', v_s.id::TEXT,
    jsonb_build_object('user_id', v_s.user_id, 'job_id', v_s.job_id, 'started_at', p_started_at, 'ended_at', p_ended_at,
                       'original_started_at', v_s.original_started_at, 'original_ended_at', v_s.original_ended_at, 'reason', btrim(p_reason)));
  RETURN public.labour_answer(v_s, 'corrected', FALSE, NULL);
END
$$;
REVOKE ALL ON FUNCTION public.correct_labour_session(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_labour_session(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_labour_session(p_session UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
  v_s   public.operator_sessions%ROWTYPE;
BEGIN
  PERFORM public.assert_privileged_aal();
  v_org := public.time_caller_org();
  SELECT * INTO v_s FROM public.operator_sessions s WHERE s.id = p_session AND s.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That job time was not found.' USING ERRCODE = 'P0002', HINT = 'session_missing';
  END IF;
  PERFORM public.labour_may_change(v_org, v_s.user_id, v_s.started_at, v_s.ended_at, p_reason);
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  PERFORM 1 FROM public.jobs j WHERE j.id = v_s.job_id FOR UPDATE;
  PERFORM public.labour_lock(v_org, v_s.user_id);
  SELECT * INTO v_s FROM public.operator_sessions s WHERE s.id = p_session FOR UPDATE;
  IF v_s.voided_at IS NOT NULL THEN
    RETURN public.labour_answer(v_s, 'voided', FALSE, NULL);
  END IF;
  -- Asked again under the person's lock, on the row as it is now (an approval may have committed while this waited).
  PERFORM public.labour_may_change(v_org, v_s.user_id, v_s.started_at, v_s.ended_at, p_reason);
  UPDATE public.operator_sessions
  SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason), updated_at = now()
  WHERE id = p_session
  RETURNING * INTO v_s;
  PERFORM security_audit.log_named_event(v_org, 'LABOUR_VOIDED', 'operator_sessions', v_s.id::TEXT,
    jsonb_build_object('user_id', v_s.user_id, 'job_id', v_s.job_id, 'started_at', v_s.started_at, 'ended_at', v_s.ended_at, 'reason', btrim(p_reason)));
  RETURN public.labour_answer(v_s, 'voided', FALSE, NULL);
END
$$;
REVOKE ALL ON FUNCTION public.void_labour_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_labour_session(UUID, TEXT) TO authenticated;
