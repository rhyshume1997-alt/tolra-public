-- =====================================================================================================
-- 046: Pause for bench jobs (jobs with no machine). Rhys's decision: "Yes, add Pause".
--
-- Until now (044) a Start that named no machine stamped the job's start and made no run, so a job worked on the bench (no machine) had
-- nothing to pause. This migration gives such a job a JOB-LEVEL run: a row in machine_runs with machine_id NULL (a "bench run").
--
-- 1. machine_runs.machine_id may be NULL: a bench run. Its shape is fixed by a CHECK (no booking, no override, ended only by a Pause or a
--    Finish). THE GUARANTEES ARE IN THE TABLE, as for machine runs: a unique partial index allows ONE OPEN BENCH RUN PER JOB, and an
--    exclusion constraint forbids any two bench runs of one job whose [started_at, ended_at) intervals overlap, open or closed. The
--    per-machine rules of 044 are unchanged and still hold for every machine run (a NULL machine never equals another, so a bench run
--    never meets machine_runs_one_open_per_machine or machine_runs_no_overlap). A client key makes one bench run per company.
-- 2. start_machine_run (same signature, same checks, same lock order, same client-key replay through machine_run_ops) now also opens a
--    bench run when the Start names NO machine and either stamps the job's start now (a bench job starting) or resumes a bench run that
--    was paused (the job's latest bench run ended 'paused', or 'to_machine' and the machine runs have ended since). It opens nothing when the job already has an open bench run (answered as
--    already open), when the job holds a machine (on_machine), or when the job was started some other way and never had a bench run
--    (started_without_bench: the board's out-of-date Start keeps its "already started, time kept" answer, and jobs started before 046
--    are left as they were). The device time is kept when it is at or after the end of the job's last bench run; otherwise the server
--    time is used, the device time kept on the row (device_started_at), returned under time_conflicts (machine_id NULL, bench TRUE) and
--    audited MACHINE_RUN_TIME_CONFLICT, as 044 does for a machine. The answer gains bench_run (or NULL), bench_skipped and
--    job_start_stamped; runs stays the machine runs only.
--    pause_machine_run and finish_job are NOT changed: they already end every open run of the job (all of them, in the lock order), so a
--    bench run is paused or finished like a machine run, with the same end-time conflict handling (machine_run_end) and the same replay.
--    A Pause that names machines ends only those machines' runs (never the bench run). machine_run_end's booking mirror is a no-op for a
--    bench run (no booking).
-- 3. bench_runs_state(): read-only, the four company roles, the caller's company: per unfinished job its latest bench run (open or not,
--    how it ended, who started it by display name) and the job's ACTUAL active work (state): 'on_machine' while any machine run of the
--    job is open, 'on_bench' while its bench run is open, 'paused' only when no run of any kind is open and its latest bench run ended
--    'paused' or 'to_machine', else 'idle'. The board shows "Paused" and the Pause and Start buttons from it.
-- 4. BENCH -> MACHINE (reviewers' NO-GO): a job never has an open bench run and an open machine run at once. A Start that names machines
--    on a job whose bench run is open ENDS that bench run in the same transaction, under the same locks, before the machine runs are
--    written: end_reason 'to_machine', ended_at = the earliest new machine run's start (the device time, or the server time when the
--    device time is before the bench run's start or a machine's record; then the device time is kept on the rows, answered under
--    time_conflicts and audited MACHINE_RUN_TIME_CONFLICT), audited BENCH_TO_MACHINE (job, bench run, started_at, ended_at, machines,
--    runs, client key). MACHINE -> BENCH stays refused (bench_skipped 'on_machine') while a machine run is open. After the machine runs
--    end (Pause), Start with no machine resumes on the bench as after a Pause. THE TABLE HOLDS IT: machine_runs_bench_machine_no_overlap
--    (exclusion: same job, one bench run and one machine run, overlapping [started_at, ended_at)) refuses any bench time beside machine
--    time of the same job, open or closed, whatever writes; so a new bench run, and a new machine run, start no earlier than the job's
--    other kind of run ended (device time otherwise replaced by the server time, as above).
--
-- Machine time stays machine-only: machines_in_use() and machine_time() join machines, so a bench run is in neither. release_machine is
-- per machine and never touches a bench run (Pause or Finish ends it). jobs_finish_guard (044) already refuses a plain finish while ANY
-- run of the job is open, so a bench job with an open bench run is finished through finish_job, in the lock order.
--
-- LOCK ORDER (unchanged, 044): (1) the per-company advisory lock 'job-no:<org>'; (2) the job's row FOR UPDATE; (3) machine_runs (and
-- machine_run_ops) and machine_bookings. RLS and grants on machine_runs are unchanged: SELECT for the four roles of the company, no write
-- grant; every write goes through the SECURITY DEFINER functions.
--
-- Forward only, safe to run more than once. No backfill: no run is invented for a job started before 046.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Bench runs in machine_runs ---------------------------------------------------------------------------
ALTER TABLE public.machine_runs ALTER COLUMN machine_id DROP NOT NULL;
DO $do$
BEGIN
  -- A bench run has no booking and no override, and ends only by a Pause or a Finish.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_shape') THEN
    ALTER TABLE public.machine_runs ADD CONSTRAINT machine_runs_bench_shape
      CHECK (machine_id IS NOT NULL OR (booking_id IS NULL AND override_of IS NULL AND (end_reason IS NULL OR end_reason IN ('paused', 'finished', 'to_machine'))));
  END IF;
  -- 'to_machine' (a bench run ended because the job's work moved to a machine) is a bench run's reason only.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_end_reason_check'
                 AND pg_get_constraintdef(oid) LIKE '%to_machine%') THEN
    ALTER TABLE public.machine_runs DROP CONSTRAINT IF EXISTS machine_runs_end_reason_check;
    ALTER TABLE public.machine_runs ADD CONSTRAINT machine_runs_end_reason_check
      CHECK (end_reason IN ('paused', 'finished', 'override', 'admin_released', 'to_machine') AND (end_reason <> 'to_machine' OR machine_id IS NULL));
  END IF;
  -- No two bench runs of one job overlap in time, open or closed (an open run reaches to infinity; a zero-length run overlaps nothing).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_no_overlap') THEN
    ALTER TABLE public.machine_runs ADD CONSTRAINT machine_runs_bench_no_overlap
      EXCLUDE USING gist (job_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&) WHERE (machine_id IS NULL);
  END IF;
  -- No bench time beside machine time of the same job: a bench run and a machine run of one job never overlap, open or closed (machine
  -- runs of one job on several machines may overlap each other, as in 044; bench runs among themselves: the constraint above).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_machine_no_overlap') THEN
    ALTER TABLE public.machine_runs ADD CONSTRAINT machine_runs_bench_machine_no_overlap
      EXCLUDE USING gist (job_id WITH =, ((machine_id IS NULL)::INTEGER) WITH <>, tstzrange(started_at, ended_at, '[)') WITH &&);
  END IF;
END
$do$;
-- One open bench run per job, whatever writes the row.
CREATE UNIQUE INDEX IF NOT EXISTS machine_runs_one_open_bench_per_job ON public.machine_runs (job_id) WHERE machine_id IS NULL AND ended_at IS NULL;
-- A client key makes one bench run per company (machine runs keep machine_runs_client_op, per machine).
CREATE UNIQUE INDEX IF NOT EXISTS machine_runs_bench_client_op ON public.machine_runs (organization_id, client_op_id) WHERE machine_id IS NULL AND client_op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_machine_runs_bench_job ON public.machine_runs (job_id, started_at) WHERE machine_id IS NULL;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Opening a bench run (internal; start_machine_run calls it under the company lock and the job's row lock) ---------------
-- p_stamped: the Start stamped the job's start just now. Answers {run, why, conflict}: run is the open bench run (already TRUE when it
-- was open before) or NULL with why 'on_machine' / 'started_without_bench'; conflict is the device time that could not be used, or NULL.
CREATE OR REPLACE FUNCTION public.bench_run_open(p_org UUID, p_job UUID, p_at TIMESTAMPTZ, p_op UUID, p_uid UUID, p_stamped BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open_id   UUID;
  v_open_at   TIMESTAMPTZ;
  v_last      public.machine_runs%ROWTYPE;
  v_floor     TIMESTAMPTZ;
  v_floor_run UUID;
  v_run_at    TIMESTAMPTZ;
  v_run       UUID;
  v_conflict  JSONB;
BEGIN
  SELECT r.id, r.started_at INTO v_open_id, v_open_at FROM public.machine_runs r WHERE r.job_id = p_job AND r.machine_id IS NULL AND r.ended_at IS NULL;
  IF v_open_id IS NOT NULL THEN
    RETURN jsonb_build_object('run', jsonb_build_object('run_id', v_open_id, 'started_at', v_open_at, 'already', TRUE), 'why', NULL, 'conflict', NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = p_job AND r.machine_id IS NOT NULL AND r.ended_at IS NULL) THEN
    RETURN jsonb_build_object('run', NULL, 'why', 'on_machine', 'conflict', NULL);
  END IF;
  -- The job's last bench run (all are closed here): a resume needs it to have been paused, or ended when the work moved to a machine
  -- (whose runs are all closed here).
  SELECT * INTO v_last FROM public.machine_runs r WHERE r.job_id = p_job AND r.machine_id IS NULL ORDER BY coalesce(r.ended_at, r.started_at) DESC, r.created_at DESC LIMIT 1;
  IF NOT coalesce(p_stamped, FALSE) AND (v_last.id IS NULL OR v_last.end_reason IS DISTINCT FROM 'paused' AND v_last.end_reason IS DISTINCT FROM 'to_machine') THEN
    RETURN jsonb_build_object('run', NULL, 'why', 'started_without_bench', 'conflict', NULL);
  END IF;
  -- The floor for the new start: the end of the job's last run of ANY kind (bench or machine; all closed here), so bench time never
  -- overlaps the job's machine time (machine_runs_bench_machine_no_overlap).
  SELECT r.id, coalesce(r.ended_at, r.started_at) INTO v_floor_run, v_floor FROM public.machine_runs r WHERE r.job_id = p_job
  ORDER BY coalesce(r.ended_at, r.started_at) DESC, r.created_at DESC LIMIT 1;
  v_run_at := p_at;
  IF v_floor IS NOT NULL AND p_at < v_floor THEN
    v_run_at := greatest(now(), v_floor);
    v_conflict := jsonb_build_object('machine_id', NULL, 'machine', NULL, 'bench', TRUE, 'what', 'start', 'device_at', p_at, 'used_at', v_run_at,
                                     'why', 'before_last_run_end', 'run_id', v_floor_run, 'run_until', v_floor);
  END IF;
  BEGIN
    INSERT INTO public.machine_runs (organization_id, job_id, machine_id, booking_id, operator_id, started_at, client_op_id, created_by, device_started_at)
    VALUES (p_org, p_job, NULL, NULL, p_uid, v_run_at, p_op, p_uid, CASE WHEN v_run_at <> p_at THEN p_at END)
    RETURNING id INTO v_run;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'This job is already running on the bench. Reload the board.' USING ERRCODE = '42501', HINT = 'bench_run_open';
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'This job already has time recorded at that time. Reload the board and start it again.' USING ERRCODE = '23P01', HINT = 'run_overlap';
  END;
  RETURN jsonb_build_object('run', jsonb_build_object('run_id', v_run, 'started_at', v_run_at, 'already', FALSE), 'why', NULL, 'conflict', v_conflict);
END
$$;
REVOKE ALL ON FUNCTION public.bench_run_open(UUID, UUID, TIMESTAMPTZ, UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Start: as 044, plus the bench run of a Start that names no machine -------------------------------------------
-- p_machines: the machines to run on (none: a bench Start), at most 10, each once. p_client_op_id: the app's key for this Start (a replay
-- returns the first result). p_started_at: the time on the device (see machine_run_client_time). p_override: an admin taking over a
-- machine another job holds; then p_reason (why, in their words) is required and recorded.
CREATE OR REPLACE FUNCTION public.start_machine_run(p_job UUID, p_machines UUID[], p_client_op_id UUID, p_started_at TIMESTAMPTZ, p_override BOOLEAN, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org       UUID := public.current_user_organization_id();
  v_uid       UUID := auth.uid();
  v_job       public.jobs%ROWTYPE;
  v_machines  UUID[] := coalesce(p_machines, ARRAY[]::UUID[]);
  v_admin     BOOLEAN;
  v_at        TIMESTAMPTZ;
  v_machine   UUID;
  v_name      TEXT;
  v_open_id   UUID;
  v_open_job  UUID;
  v_open_no   TEXT;
  v_open_op   UUID;
  v_open_at   TIMESTAMPTZ;
  v_holder    TEXT;
  v_link      public.job_machines%ROWTYPE;
  v_link_booking UUID;
  v_link_hours   NUMERIC;
  v_booking   UUID;
  v_run       UUID;
  v_displaced UUID;
  v_runs      JSONB := '[]'::JSONB;
  v_overrides JSONB := '[]'::JSONB;
  v_added     JSONB := '[]'::JSONB;
  v_stamped   BOOLEAN := FALSE;
  v_pos       INTEGER;
  v_override  BOOLEAN := FALSE;
  v_reason    TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_op        public.machine_run_ops%ROWTYPE;
  v_floor     TIMESTAMPTZ;
  v_floor_run UUID;
  v_run_at    TIMESTAMPTZ;
  v_conflicts JSONB := '[]'::JSONB;
  v_bench     JSONB;
  v_bench_run JSONB;
  v_bench_id  UUID;
  v_bench_from TIMESTAMPTZ;
  v_job_floor TIMESTAMPTZ;
  v_job_floor_run UUID;
  v_bench_end TIMESTAMPTZ;
  v_bench_ended JSONB;
  v_why       TEXT;
  v_result    JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can start a job on a machine' USING ERRCODE = '42501';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);
  v_override := v_admin AND coalesce(p_override, FALSE);
  IF v_override AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'Give a reason for taking the machine over (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;
  IF length(coalesce(v_reason, '')) > 500 THEN
    RAISE EXCEPTION 'The reason is too long (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_machines) > 10 THEN
    RAISE EXCEPTION 'Up to 10 machines per start.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_machines) m WHERE m IS NULL) OR (SELECT count(DISTINCT m) FROM unnest(v_machines) m) <> cardinality(v_machines) THEN
    RAISE EXCEPTION 'Each machine can be started once.' USING ERRCODE = '22023';
  END IF;
  v_at := public.machine_run_client_time(p_started_at);

  -- Lock first (the same lock, in the same order, as create_job and save_machine_booking), then the job's row, then look, then write.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- A replay of a Start already recorded (same key, SAME JOB): the first answer, from machine_run_ops, and nothing else (no run, machine
  -- or bench, made or ended, whatever happened since). The same key sent for another job (or a Pause's key) is refused outright.
  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_op FROM public.machine_run_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_op.job_id = p_job AND v_op.kind = 'start' THEN
        RETURN v_op.result || jsonb_build_object('replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This Start was already recorded against another job. Reload the board and start the job again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'This job is finished: it can''t be started on a machine.' USING ERRCODE = '42501', HINT = 'job_finished';
  END IF;

  -- Every machine first: a refusal leaves nothing behind.
  FOREACH v_machine IN ARRAY v_machines LOOP
    SELECT m.name INTO v_name FROM public.machines m WHERE m.id = v_machine AND m.organization_id = v_org AND coalesce(m.active, TRUE);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
    END IF;
    v_open_id := NULL; v_open_job := NULL; v_open_no := NULL; v_open_op := NULL; v_open_at := NULL;
    SELECT r.id, r.job_id, j.job_no, r.operator_id, r.started_at INTO v_open_id, v_open_job, v_open_no, v_open_op, v_open_at
    FROM public.machine_runs r JOIN public.jobs j ON j.id = r.job_id
    WHERE r.machine_id = v_machine AND r.ended_at IS NULL;
    IF v_open_id IS NOT NULL AND v_open_job <> p_job AND NOT v_override THEN
      SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN 'someone' ELSE left(btrim(p.full_name), 80) END
        INTO v_holder FROM public.user_profiles p WHERE p.id = v_open_op;
      RAISE EXCEPTION '% is in use by % on % since %. Pick a free machine, or ask an admin to take it over.',
        v_name, coalesce(v_holder, 'someone'), v_open_no, to_char(v_open_at AT TIME ZONE 'Europe/London', 'DD/MM HH24:MI')
        USING ERRCODE = '42501', HINT = 'machine_in_use',
              DETAIL = jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'job_id', v_open_job, 'job_no', v_open_no, 'operator', coalesce(v_holder, 'someone'), 'since', v_open_at)::TEXT;
    END IF;
  END LOOP;

  -- The job's own start, when it is still empty (035 records who).
  IF v_job.started_at IS NULL THEN
    UPDATE public.jobs SET started_at = v_at WHERE id = p_job;
    v_stamped := TRUE;
  END IF;

  -- BENCH -> MACHINE (046): a Start that names machines ends the job's open bench run, here, before any machine run is written (the
  -- table refuses bench time beside machine time of one job). The bench run's row is locked now (runs, after the job's row, as 044).
  -- The job's floor: the end of its last bench run, or the start of the open one; no machine run of this Start starts before it.
  IF cardinality(v_machines) > 0 THEN
    SELECT r.id, r.started_at INTO v_bench_id, v_bench_from FROM public.machine_runs r
    WHERE r.job_id = p_job AND r.machine_id IS NULL AND r.ended_at IS NULL FOR UPDATE;
    SELECT r.id, coalesce(r.ended_at, r.started_at) INTO v_job_floor_run, v_job_floor FROM public.machine_runs r
    WHERE r.job_id = p_job AND r.machine_id IS NULL ORDER BY coalesce(r.ended_at, r.started_at) DESC, r.created_at DESC LIMIT 1;
    -- Each new machine run's start (the same rule as the loop below, which recomputes it identically): the bench run ends at the earliest.
    FOREACH v_machine IN ARRAY v_machines LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.machine_id = v_machine AND r.ended_at IS NULL AND r.job_id = p_job);
      v_floor := NULL;
      SELECT coalesce(r.ended_at, r.started_at) INTO v_floor FROM public.machine_runs r WHERE r.machine_id = v_machine
      ORDER BY coalesce(r.ended_at, r.started_at) DESC LIMIT 1;
      v_floor := greatest(v_floor, v_job_floor);
      v_bench_end := least(v_bench_end, CASE WHEN v_floor IS NOT NULL AND v_at < v_floor THEN greatest(now(), v_floor) ELSE v_at END);
    END LOOP;
    IF v_bench_id IS NOT NULL AND v_bench_end IS NOT NULL THEN
      -- v_bench_end is never before the bench run's start (the job's floor is that start), so machine_run_end keeps it exactly.
      v_bench_ended := public.machine_run_end(v_bench_id, v_bench_end, 'to_machine', p_client_op_id);
      IF v_at < v_bench_from THEN
        v_conflicts := v_conflicts || jsonb_build_object('machine_id', NULL, 'machine', NULL, 'bench', TRUE, 'what', 'end', 'device_at', v_at, 'used_at', v_bench_end,
                                                         'why', 'before_run_start', 'run_id', v_bench_id, 'run_started_at', v_bench_from);
      END IF;
    END IF;
  END IF;

  FOREACH v_machine IN ARRAY v_machines LOOP
    SELECT m.name INTO v_name FROM public.machines m WHERE m.id = v_machine;
    v_displaced := NULL;
    v_open_id := NULL; v_open_job := NULL; v_open_no := NULL; v_open_at := NULL;
    SELECT r.id, r.job_id, j.job_no, r.started_at INTO v_open_id, v_open_job, v_open_no, v_open_at
    FROM public.machine_runs r JOIN public.jobs j ON j.id = r.job_id
    WHERE r.machine_id = v_machine AND r.ended_at IS NULL;
    IF v_open_id IS NOT NULL AND v_open_job = p_job THEN
      -- This job already runs on that machine: the run stands.
      v_runs := v_runs || jsonb_build_object('run_id', v_open_id, 'machine_id', v_machine, 'machine', v_name, 'started_at', v_open_at, 'already', TRUE);
      CONTINUE;
    END IF;

    -- The time this run starts: the device's when it is at or after everything already recorded on the machine and the job's bench time (046), else the server's
    -- (with the device's kept on the row and reported as a time conflict).
    v_floor_run := NULL; v_floor := NULL;
    SELECT r.id, coalesce(r.ended_at, r.started_at) INTO v_floor_run, v_floor
    FROM public.machine_runs r WHERE r.machine_id = v_machine
    ORDER BY coalesce(r.ended_at, r.started_at) DESC LIMIT 1;
    v_why := CASE WHEN v_floor_run = v_open_id THEN 'before_displaced_run_start' ELSE 'before_last_run_end' END;
    IF v_job_floor IS NOT NULL AND (v_floor IS NULL OR v_job_floor > v_floor) THEN
      v_floor := v_job_floor; v_floor_run := v_job_floor_run;
      v_why := CASE WHEN v_job_floor_run = v_bench_id THEN 'before_bench_run_start' ELSE 'before_bench_run_end' END;
    END IF;
    v_run_at := v_at;
    IF v_floor IS NOT NULL AND v_at < v_floor THEN
      v_run_at := greatest(now(), v_floor);
      v_conflicts := v_conflicts || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'what', 'start', 'device_at', v_at, 'used_at', v_run_at,
                                                       'why', v_why, 'run_id', v_floor_run, 'run_until', v_floor);
    END IF;

    IF v_open_id IS NOT NULL THEN
      -- An admin taking the machine over: the other job's run ends when this one starts, recorded.
      v_displaced := v_open_id;
      v_overrides := v_overrides || (public.machine_run_end(v_open_id, v_run_at, 'override', NULL) || jsonb_build_object('job_no', v_open_no, 'machine', v_name));
    END IF;

    -- The plan row and the booking the run is against (044's rule, unchanged).
    SELECT * INTO v_link FROM public.job_machines jm WHERE jm.job_id = p_job AND jm.machine_id = v_machine;
    v_booking := v_link.booking_id;
    IF v_booking IS NULL THEN
      SELECT b.id INTO v_booking
      FROM public.machine_bookings b JOIN public.machines m ON m.id = b.machine_id
      WHERE b.organization_id = v_org AND b.job_id = p_job AND b.machine_id = v_machine AND b.status <> 'complete'
      ORDER BY EXISTS (SELECT 1 FROM public.booking_intervals(b.start_at, b.estimated_hours, m.hours_per_day, m.working_days, b.day_plan, b.status, b.hours_done, v_at) i WHERE i @> v_at) DESC,
               b.start_at
      LIMIT 1;
    END IF;
    IF v_link.id IS NULL THEN
      SELECT coalesce(max(jm.position), -1) + 1 INTO v_pos FROM public.job_machines jm WHERE jm.job_id = p_job;
      SELECT b.id, least(1000, greatest(0, coalesce(b.estimated_hours, 0))) INTO v_link_booking, v_link_hours
      FROM public.machine_bookings b
      WHERE b.id = v_booking AND NOT EXISTS (SELECT 1 FROM public.job_machines jm WHERE jm.booking_id = b.id);
      INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by)
      VALUES (v_org, p_job, v_machine, coalesce(v_link_hours, 0), v_link_booking, v_pos, v_uid)
      RETURNING * INTO v_link;
      v_added := v_added || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'hours', v_link.estimated_hours, 'booking_id', v_link_booking);
    END IF;

    BEGIN
      INSERT INTO public.machine_runs (organization_id, job_id, machine_id, booking_id, operator_id, started_at, override_of, client_op_id, created_by, device_started_at)
      VALUES (v_org, p_job, v_machine, v_booking, v_uid, v_run_at, v_displaced, p_client_op_id, v_uid, CASE WHEN v_run_at <> v_at THEN v_at END)
      RETURNING id INTO v_run;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION '% is in use by another job. Pick a free machine, or ask an admin to take it over.', v_name USING ERRCODE = '42501', HINT = 'machine_in_use';
      WHEN exclusion_violation THEN
        RAISE EXCEPTION '% already has a run at that time. Reload the board and start the job again.', v_name USING ERRCODE = '23P01', HINT = 'run_overlap';
    END;
    v_runs := v_runs || jsonb_build_object('run_id', v_run, 'machine_id', v_machine, 'machine', v_name, 'booking_id', v_booking, 'started_at', v_run_at, 'already', FALSE,
                                           'booking', public.machine_booking_mirror(v_booking, v_org, 'running', 0));
  END LOOP;

  -- A Start that names no machine: the job's bench run (046), when it starts the job now or resumes a paused bench run.
  IF cardinality(v_machines) = 0 THEN
    v_bench := public.bench_run_open(v_org, p_job, v_at, p_client_op_id, v_uid, v_stamped);
    v_bench_run := nullif(v_bench -> 'run', 'null'::JSONB);
    IF jsonb_typeof(v_bench -> 'conflict') = 'object' THEN
      v_conflicts := v_conflicts || (v_bench -> 'conflict');
    END IF;
  END IF;

  IF jsonb_array_length(v_runs) > 0 OR v_stamped OR coalesce((v_bench_run ->> 'already')::BOOLEAN = FALSE, FALSE) THEN
    PERFORM security_audit.log_named_event(v_org, 'START_MACHINE_RUN', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'started_at', v_at, 'job_start_stamped', v_stamped, 'runs', v_runs, 'machines_added_to_plan', v_added,
                         'bench_run', v_bench_run, 'client_op_id', p_client_op_id, 'client_started_at', p_started_at, 'time_conflicts', v_conflicts));
  END IF;
  IF v_bench_ended IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v_org, 'BENCH_TO_MACHINE', 'jobs', p_job::TEXT,
      jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'bench_run_id', v_bench_id, 'bench_started_at', v_bench_from,
                         'ended_at', v_bench_ended -> 'ended_at', 'hours', v_bench_ended -> 'hours', 'machine_ids', to_jsonb(v_machines),
                         'runs', v_runs, 'client_op_id', p_client_op_id, 'client_started_at', p_started_at, 'time_conflict', v_at < v_bench_from,
                         'actor_user_id', v_uid, 'at', now()));
  END IF;
  IF jsonb_array_length(v_overrides) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'OVERRIDE_MACHINE_IN_USE', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'reason', v_reason, 'conflicts', v_overrides, 'displaced', v_overrides,
                         'clashing_job_nos', (SELECT coalesce(jsonb_agg(DISTINCT o ->> 'job_no'), '[]'::JSONB) FROM jsonb_array_elements(v_overrides) o),
                         'actor_user_id', v_uid, 'at', now(), 'runs', v_runs, 'time_conflicts', v_conflicts));
  END IF;
  IF jsonb_array_length(v_conflicts) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'MACHINE_RUN_TIME_CONFLICT', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'operation', 'start', 'time_conflicts', v_conflicts, 'client_op_id', p_client_op_id,
                         'client_started_at', p_started_at, 'actor_user_id', v_uid, 'at', now()));
  END IF;

  v_result := jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'started_at', coalesce(v_job.started_at, v_at), 'runs', v_runs, 'overrides', v_overrides,
                                 'time_conflicts', v_conflicts, 'job_start_stamped', v_stamped, 'bench_run', v_bench_run, 'bench_skipped', v_bench ->> 'why',
                                 'bench_ended', v_bench_ended, 'replayed', FALSE);
  IF p_client_op_id IS NOT NULL THEN
    INSERT INTO public.machine_run_ops (organization_id, client_op_id, kind, job_id, result, created_by) VALUES (v_org, p_client_op_id, 'start', p_job, v_result, v_uid);
  END IF;
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Reading: each unfinished job's latest bench run ---------------------------------------------------------------
-- is_open: the bench run is open. state: the job's ACTUAL active work: 'on_machine' (a machine run of the job is open: never shown as
-- Paused or as on the bench), 'on_bench' (its bench run is open: Pause shows), 'paused' (no run of any kind open, its latest bench run
-- ended 'paused' or 'to_machine': Start resumes it on the bench), else 'idle'. The operator by display name only (never an e-mail, as
-- company_people). Read-only, the four roles, the caller's company. (DROP first: the row shape gained on_machine and state.)
DROP FUNCTION IF EXISTS public.bench_runs_state();
CREATE OR REPLACE FUNCTION public.bench_runs_state()
RETURNS TABLE (job_id UUID, run_id UUID, is_open BOOLEAN, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, end_reason TEXT, operator_id UUID, operator_name TEXT,
               on_machine BOOLEAN, state TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.job_id, b.id, b.is_open, b.started_at, b.ended_at, b.end_reason, b.operator_id, b.operator_name, b.on_machine,
         CASE WHEN b.on_machine THEN 'on_machine' WHEN b.is_open THEN 'on_bench' WHEN b.end_reason IN ('paused', 'to_machine') THEN 'paused' ELSE 'idle' END
  FROM (
    SELECT DISTINCT ON (r.job_id) r.job_id, r.id, r.ended_at IS NULL AS is_open, r.started_at, r.ended_at, r.end_reason, r.operator_id,
           CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END AS operator_name,
           EXISTS (SELECT 1 FROM public.machine_runs m WHERE m.job_id = r.job_id AND m.machine_id IS NOT NULL AND m.ended_at IS NULL) AS on_machine
    FROM public.machine_runs r
    JOIN public.jobs j ON j.id = r.job_id
    LEFT JOIN public.user_profiles p ON p.id = r.operator_id
    WHERE r.organization_id = v_org AND j.organization_id = v_org AND r.machine_id IS NULL AND j.finished_at IS NULL
    ORDER BY r.job_id, (r.ended_at IS NULL) DESC, r.started_at DESC, r.created_at DESC
  ) b;
END
$$;
REVOKE ALL ON FUNCTION public.bench_runs_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bench_runs_state() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. The second step (033) on the function this migration replaces -----------------------------------------------
DO $do$
BEGIN
  IF to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)') IS NULL
     OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)'))) = 0 THEN
    RAISE EXCEPTION '046: start_machine_run does not start with the second-step check';
  END IF;
END
$do$;
