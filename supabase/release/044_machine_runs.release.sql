-- 044_machine_runs.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 044: live machine use (machine_runs), operator assignment, and the admin's override and release (M3).
--
-- Rhys's requirement A: "When an operator hits Start on a job, they pick (or confirm the booked) machine(s); that machine shows as IN USE
-- with who is running it, which job, and since when, visible to everyone in the company. Finish or pause frees the machine. Two jobs can't
-- silently claim the same machine: warn and let an admin override. This should feed machine_runs (machine time = union per machine)."
-- Requirement E: "jobs can be assigned to an operator; their name shows on the card. Start books the job onto the machine live."
--
-- 1. machine_runs: one row per machine, job and stretch of live use (started_at .. ended_at), with the operator (the person who pressed
--    Start), the booking it was running against, how it ended ('paused', 'finished', 'override', 'admin_released') and who ended it.
--    THE GUARANTEE IS IN THE TABLE: a unique partial index allows one open run (ended_at IS NULL) per machine, whatever path writes it, so
--    two jobs can never hold the same machine at once; and an exclusion constraint (btree_gist) forbids ANY two runs of one machine whose
--    [started_at, ended_at) intervals overlap, open or closed, so a delayed offline Start or an admin's take-over with an early time can't
--    rewrite or overlap history (a run never ends before it starts: CHECK). A run displaced by an admin's override names the run that
--    took its place (override_of on the new run). client_op_id is the key of a Start made offline and replayed.
--    DEVICE TIMES ARE KEPT WHEN VALID. When a device time can't be honoured (a Start earlier than the end of the machine's last run, or
--    than the start of the run an override displaces; an end earlier than the run's start) the server time is used, the device time is
--    kept on the row (device_started_at / device_ended_at), the answer carries it under time_conflicts and it is audited
--    MACHINE_RUN_TIME_CONFLICT: never a silent rewrite. Machine time is the UNION of a machine's run intervals (machine_time()).
--    Read by the four company roles; no insert, update or delete grant: every change goes through the functions below.
-- 1b. machine_run_ops: the durable answer of every Start and Pause sent with a client key (one row per company and key, whether or not a
--    run recorded it: a machine-less Start, a Pause that ended nothing). A replay returns that first answer and changes nothing. No API
--    role reads or writes it; only the functions below.
-- 2. jobs.assigned_to (+ assigned_at, assigned_by): the operator a job is assigned to. Informational (it does not decide who may press
--    Start). Written only by assign_job: the plain jobs UPDATE the board uses keeps the old value (jobs_assignment_keep, silently, as the
--    035 actor columns are kept).
-- 3. Functions (all SECURITY DEFINER, pinned search_path, assert_privileged_aal() first, the caller's company only, audited):
--    start_machine_run(job, machines, client_op_id, started_at, override, reason): under the per-company job lock (the one create_job,
--      save_machine_booking, convert_sales_order and set_job_machines take, so a run, a booking and a job number are never decided at the same moment), every
--      machine named must be active and in the company; a machine another job holds is refused (42501, hint machine_in_use, the holder
--      in the message) unless the caller is an admin who chose to take it over WITH A REASON (3 to 500 characters, as 042's booking
--      override), which ends the displaced run (end_reason 'override') and is audited as OVERRIDE_MACHINE_IN_USE with the runs the
--      function found, the reason, the actor and the time (the shape of OVERRIDE_MACHINE_CLASH). A machine
--      not in the job's plan is added to job_machines with 0 hours (the plan follows
--      reality). The job's own start time is stamped when it is still empty (035's trigger records who), never replaced. The booking the
--      run is against goes 'running'. A replay (same client_op_id) returns what the first call made and changes nothing. Start with no
--      machine still works: it stamps the job's start and makes no run.
--    pause_machine_run(job, machines, client_op_id, ended_at): ends the job's open runs (all, or the machines named) with 'paused' and
--      frees the machine (the booking goes back to 'booked', its hours done increased by the run); the job stays started.
--    finish_job(job, client_op_id, finished_at): the board's Finish (online, and the outbox replay): fills an empty finish time (and an
--      empty start, as the board did), stage 'inspection', then ends every open run of the job with 'finished' and completes their bookings,
--      all in the lock order below. A finish time already recorded is never replaced (changed=false). The plain jobs update may still
--      finish a job that holds NO machine (as before 044); while runs are open it is refused (42501, hint finish_via_rpc) by
--      jobs_finish_guard, so nothing ends a run outside the lock order.
--    release_machine(machine, reason): admin only, with a reason (3 to 500 characters), ends whatever run holds the machine with
--      'admin_released' (a forgotten Finish), audited with the run, the reason, the actor and the time.
--    assign_job(job, user): admin and office assign anyone; workshop staff may take a job themselves or hand their own back. The assignee
--      must be an active admin, office or workshop member of the company with an active account. Audited ASSIGN_JOB.
--    machines_in_use(): the open runs of the caller's company with the machine, the job, the operator's DISPLAY NAME (never an e-mail,
--      as company_people) and since when, plus whether the run looks forgotten (open for 12 hours or more). Read-only, the four roles.
--    assignable_people(): the people a job may be assigned to (active admin, office and workshop members), display names only.
--    machine_time(from, to): hours per machine in a window, the UNION of its runs (overlaps counted once), read-only, the four roles.
--    Client timestamps (an offline Start or Pause replayed later) are accepted when they are not in the future (clamped to now) and not
--    older than 30 days (refused), and kept when valid on the machine's timeline (else the server time, a recorded time conflict, as in
--    1.); the row also keeps created_at (server time). No pay or time-sheet arithmetic lives here.
-- 4. machine_bookings.status is mirrored from the runs ('running' while a run is open, 'booked' after a pause or a release, 'complete' at
--    Finish, hours done increased by the run) THROUGH 042's save_machine_booking (the only booking writer; a status or hours-done-up change
--    re-checks no clash there), never by a direct write; the app writes no booking for a run. The mirror (machine_booking_mirror) passes
--    the booking's own fields back; text longer than 042 allows (a booking from before 042) is cut to the limit for the mirror, and a
--    booking whose start is outside 2000..2100 is left as it is (recorded in the result) rather than failing a Pause or a Finish. Its status is advisory; the guarantee is
--    machine_runs. The booking a run is set against is the job's booking on that machine whose booking_intervals contain the start,
--    else its earliest unfinished one.
--    LOCK ORDER, the same as create_job, save_machine_booking and set_job_machines, in every function here: (1) the per-company advisory
--    lock 'job-no:<org>'; (2) the job's row FOR UPDATE; (3) machine_runs (and machine_run_ops) and machine_bookings. A replayed key is
--    looked up under (1), so two copies of one operation can't both act. No trigger takes the company lock: a
--    plain jobs update already holds the row, so finishing a job with open runs is refused there and goes through finish_job.
--
-- Every write starts with assert_privileged_aal() (033) and the new table carries the admin_mfa and support_read_only statement triggers
-- (033, 036). Nothing about the existing jobs, job_machines or machine_bookings policies changes; the worksheet-version fields are
-- unchanged.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The runs -----------------------------------------------------------------------------------------------
-- btree_gist: the machine (uuid, =) and the run's time range (&&) in one exclusion constraint. Available on Supabase and the local stack.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
CREATE TABLE IF NOT EXISTS public.machine_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  machine_id      UUID NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  booking_id      UUID REFERENCES public.machine_bookings(id) ON DELETE SET NULL,
  operator_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  end_reason      TEXT CHECK (end_reason IN ('paused', 'finished', 'override', 'admin_released')),
  ended_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  override_of     UUID REFERENCES public.machine_runs(id) ON DELETE SET NULL,
  client_op_id    UUID,
  ended_op_id     UUID,
  device_started_at TIMESTAMPTZ,
  device_ended_at   TIMESTAMPTZ,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT machine_runs_end_pair CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT machine_runs_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- The device's time when it could not be honoured (else NULL): the run starts or ends at the server's time instead, visibly.
ALTER TABLE public.machine_runs ADD COLUMN IF NOT EXISTS device_started_at TIMESTAMPTZ;
ALTER TABLE public.machine_runs ADD COLUMN IF NOT EXISTS device_ended_at TIMESTAMPTZ;
-- The guarantee: one open run per machine, enforced by the index whatever writes the row.
CREATE UNIQUE INDEX IF NOT EXISTS machine_runs_one_open_per_machine ON public.machine_runs (machine_id) WHERE ended_at IS NULL;
-- And no two runs of one machine overlap in time, open or closed: [started_at, ended_at) with an open run reaching to infinity. A run of
-- zero length is an empty range and overlaps nothing.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_no_overlap') THEN
    ALTER TABLE public.machine_runs ADD CONSTRAINT machine_runs_no_overlap
      EXCLUDE USING gist (machine_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&);
  END IF;
END
$do$;
-- Idempotency of a Start: the same client operation on the same machine in the same company is one run.
CREATE UNIQUE INDEX IF NOT EXISTS machine_runs_client_op ON public.machine_runs (organization_id, client_op_id, machine_id) WHERE client_op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_machine_runs_org ON public.machine_runs (organization_id);
CREATE INDEX IF NOT EXISTS idx_machine_runs_job ON public.machine_runs (job_id);
CREATE INDEX IF NOT EXISTS idx_machine_runs_machine_started ON public.machine_runs (machine_id, started_at);
CREATE INDEX IF NOT EXISTS idx_machine_runs_ended_op ON public.machine_runs (organization_id, ended_op_id) WHERE ended_op_id IS NOT NULL;

ALTER TABLE public.machine_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "machine_runs rbac select" ON public.machine_runs;
CREATE POLICY "machine_runs rbac select" ON public.machine_runs FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.machine_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.machine_runs TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.machine_runs;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_machine_id ON public.machine_runs;
CREATE TRIGGER zz_same_org_machine_id BEFORE INSERT OR UPDATE ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines', 'machine_id');
DROP TRIGGER IF EXISTS zz_same_org_booking_id ON public.machine_runs;
CREATE TRIGGER zz_same_org_booking_id BEFORE INSERT OR UPDATE ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machine_bookings', 'booking_id');
DROP TRIGGER IF EXISTS zz_same_org_override_of ON public.machine_runs;
CREATE TRIGGER zz_same_org_override_of BEFORE INSERT OR UPDATE ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machine_runs', 'override_of');

DROP TRIGGER IF EXISTS audit_machine_runs_changes ON public.machine_runs;
CREATE TRIGGER audit_machine_runs_changes AFTER INSERT OR UPDATE OR DELETE ON public.machine_runs
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

DROP TRIGGER IF EXISTS support_read_only ON public.machine_runs;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.machine_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.machine_runs;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.machine_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- ---- 1b. The durable answer of a client operation (Start or Pause sent with a key) ------------------------------------
-- One row per company and key, written in the same transaction as what the operation did (under the company lock), whether or not a
-- run records it. A replay of the key for the same job and kind returns `result` (marked replayed) and changes nothing; the key for
-- another job or kind is refused (client_op_reused). No API role reads or writes it (RLS on, no policy, no grant): the functions only.
CREATE TABLE IF NOT EXISTS public.machine_run_ops (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_op_id    UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('start', 'pause')),
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  result          JSONB NOT NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, client_op_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_run_ops_job ON public.machine_run_ops (job_id);
ALTER TABLE public.machine_run_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.machine_run_ops FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.machine_run_ops;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.machine_run_ops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS support_read_only ON public.machine_run_ops;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.machine_run_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.machine_run_ops;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.machine_run_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The operator a job is assigned to ---------------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_to ON public.jobs (assigned_to) WHERE assigned_to IS NOT NULL;

-- The assignment columns are written by assign_job only (it sets tolra.assign_job for its own update). Any other update from the
-- signed-in API role keeps the old values, silently, as 035 keeps the actor columns: the board's generic jobs update can't assign.
CREATE OR REPLACE FUNCTION public.jobs_assignment_keep()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' THEN
    RETURN NEW; -- the service role, the owner, the SQL editor, the importer: exempt
  END IF;
  IF coalesce(current_setting('tolra.assign_job', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.assigned_to := NULL; NEW.assigned_at := NULL; NEW.assigned_by := NULL;
  ELSE
    NEW.assigned_to := OLD.assigned_to; NEW.assigned_at := OLD.assigned_at; NEW.assigned_by := OLD.assigned_by;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_assignment_keep() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ab_assignment_keep ON public.jobs;
CREATE TRIGGER ab_assignment_keep BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_assignment_keep();

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Shared pieces: a client time, the machine's holder, mirroring the booking ---------------------------------------
-- A time sent by the app (an offline Start or Pause replayed later): now when missing or in the future; refused when older than 30 days.
CREATE OR REPLACE FUNCTION public.machine_run_client_time(p_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_at IS NULL OR p_at > now() THEN
    RETURN now();
  END IF;
  IF p_at < now() - INTERVAL '30 days' THEN
    RAISE EXCEPTION 'That time is more than 30 days ago. Check the device''s clock and try again.' USING ERRCODE = '22023', HINT = 'time_too_old';
  END IF;
  RETURN p_at;
END
$$;
REVOKE ALL ON FUNCTION public.machine_run_client_time(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- Mirrors a run's state onto its booking through save_machine_booking (042; the caller's role and company have been checked and the
-- company lock is held): the status given and hours done increased by p_add_hours (capped at 1000). The booking's own fields go back as
-- they are (the estimated hours unchanged, so the job_machines plan that save keeps from them is unchanged too), except text longer than
-- 042 allows (a booking from before 042: job number 100, description 500, notes 2000) which is cut to the limit; a start outside
-- 2000..2100 or hours outside 0..1000, which 042 refuses, leave that booking alone and the result says so. A booking already complete,
-- or gone, is left alone. Internal.
CREATE OR REPLACE FUNCTION public.machine_booking_mirror(p_booking UUID, p_org UUID, p_status TEXT, p_add_hours NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_b public.machine_bookings%ROWTYPE;
BEGIN
  IF p_booking IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_b FROM public.machine_bookings b WHERE b.id = p_booking AND b.organization_id = p_org AND b.status <> 'complete';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('booking_id', p_booking, 'mirrored', FALSE, 'why', 'complete_or_gone');
  END IF;
  IF p_status = 'running' AND v_b.status <> 'booked' THEN
    RETURN jsonb_build_object('booking_id', p_booking, 'mirrored', FALSE, 'why', 'not_booked');
  END IF;
  IF v_b.start_at < TIMESTAMPTZ '2000-01-01 00:00:00+00' OR v_b.start_at >= TIMESTAMPTZ '2101-01-01 00:00:00+00' THEN
    RETURN jsonb_build_object('booking_id', p_booking, 'mirrored', FALSE, 'why', 'start_out_of_range');
  END IF;
  -- The booking's hours go back unchanged (save keeps job_machines as the current plan from them): hours 042 would refuse are left alone.
  IF v_b.estimated_hours IS NULL OR v_b.estimated_hours < 0 OR v_b.estimated_hours > 1000 THEN
    RETURN jsonb_build_object('booking_id', p_booking, 'mirrored', FALSE, 'why', 'hours_out_of_range');
  END IF;
  PERFORM public.save_machine_booking(v_b.id, v_b.machine_id, v_b.job_id, left(coalesce(v_b.job_no, ''), 100), left(v_b.description, 500), v_b.start_at,
                                      v_b.estimated_hours,
                                      least(1000, round(coalesce(v_b.hours_done, 0) + coalesce(p_add_hours, 0), 2)),
                                      p_status, left(v_b.notes, 2000), NULL, FALSE, FALSE, NULL);
  RETURN jsonb_build_object('booking_id', p_booking, 'mirrored', TRUE, 'status', p_status);
END
$$;
REVOKE ALL ON FUNCTION public.machine_booking_mirror(UUID, UUID, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;

-- Ends one run and mirrors its booking (machine_booking_mirror): 'booked' again after a pause or a release, 'complete' at Finish, hours
-- done increased by the run. An end time before the run's start can't be honoured (a run never ends before it starts, and is never
-- silently made zero-length): the run ends at the server's time instead, the time asked for is kept on the row (device_ended_at) and the
-- answer says time_conflict (the caller audits it). Internal: called by the functions below inside their own checks.
CREATE OR REPLACE FUNCTION public.machine_run_end(p_run UUID, p_at TIMESTAMPTZ, p_reason TEXT, p_op UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run    public.machine_runs%ROWTYPE;
  v_end    TIMESTAMPTZ;
  v_hours  NUMERIC;
  v_mirror JSONB;
  v_conflict BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_run FROM public.machine_runs WHERE id = p_run AND ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_end := coalesce(p_at, now());
  IF v_end < v_run.started_at THEN
    v_conflict := TRUE;
    v_end := greatest(now(), v_run.started_at);
  END IF;
  v_hours := round(extract(EPOCH FROM (v_end - v_run.started_at)) / 3600.0, 2);
  UPDATE public.machine_runs SET ended_at = v_end, end_reason = p_reason, ended_by = auth.uid(), ended_op_id = p_op,
                                 device_ended_at = CASE WHEN v_conflict THEN p_at END
  WHERE id = p_run;
  v_mirror := public.machine_booking_mirror(v_run.booking_id, v_run.organization_id, CASE WHEN p_reason = 'finished' THEN 'complete' ELSE 'booked' END, v_hours);
  RETURN jsonb_build_object('run_id', v_run.id, 'machine_id', v_run.machine_id, 'job_id', v_run.job_id, 'booking_id', v_run.booking_id,
                            'operator_id', v_run.operator_id, 'started_at', v_run.started_at, 'ended_at', v_end, 'end_reason', p_reason, 'hours', v_hours,
                            'booking', v_mirror, 'time_conflict', v_conflict, 'device_ended_at', CASE WHEN v_conflict THEN p_at END);
END
$$;

-- The time conflicts in a list of machine_run_end answers, in the shape start_machine_run uses (empty array: none).
CREATE OR REPLACE FUNCTION public.machine_run_end_conflicts(p_ended JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('run_id', e ->> 'run_id', 'machine_id', e ->> 'machine_id', 'what', 'end',
                                               'device_at', e -> 'device_ended_at', 'used_at', e -> 'ended_at', 'run_started_at', e -> 'started_at',
                                               'why', 'before_run_start')), '[]'::JSONB)
  FROM jsonb_array_elements(coalesce(p_ended, '[]'::JSONB)) e
  WHERE (e ->> 'time_conflict')::BOOLEAN
$$;
REVOKE ALL ON FUNCTION public.machine_run_end_conflicts(JSONB) FROM PUBLIC, anon, authenticated;

-- The hours covered by a set of time ranges, counted ONCE where they overlap (the union, not the sum). Empty and NULL ranges count 0;
-- every range must be bounded. Internal (machine_time() reads through it).
CREATE OR REPLACE FUNCTION public.tstz_union_hours(p_ranges TSTZRANGE[])
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT round(coalesce(sum(extract(EPOCH FROM (upper(u) - lower(u)))), 0) / 3600.0, 2)
  FROM unnest((SELECT range_agg(r) FROM unnest(p_ranges) r WHERE r IS NOT NULL AND NOT isempty(r))) u
$$;
REVOKE ALL ON FUNCTION public.tstz_union_hours(TSTZRANGE[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.machine_run_end(UUID, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Start: the job onto the machine, live --------------------------------------------------------------------
-- p_machines: the machines to run on (none: Start stamps the job only), at most 10, each once. p_client_op_id: the app's key for this
-- Start (a replay returns the first result). p_started_at: the time on the device (see machine_run_client_time). p_override: an admin
-- taking over a machine another job holds; then p_reason (why, in their words) is required and recorded.
DROP FUNCTION IF EXISTS public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN);
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

  -- Lock first (the same lock, in the same order, as create_job and save_machine_booking), then the job's row, then look, then write:
  -- the check for a machine's holder, the new run, the plan row and the booking are one serialised step per company. The unique index and
  -- the exclusion constraint are the guarantee if anything else ever writes a run.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- A replay of a Start already recorded (same key, SAME JOB): the first answer, from machine_run_ops, and nothing else (no run made or
  -- ended, whatever happened since). Read under the company lock, so two copies of one Start can't both run. The same key sent for another
  -- job (or a Pause's key) is a client fault, refused outright: never reported as replayed.
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

  -- The job's own start, when it is still empty (035 records who). A machine-less Start is exactly the board's old Start.
  IF v_job.started_at IS NULL THEN
    UPDATE public.jobs SET started_at = v_at WHERE id = p_job;
    v_stamped := TRUE;
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

    -- The time this run starts. The device's time when it is at or after everything already recorded on the machine: the end of every
    -- closed run and the start of the run an override displaces (an open run reaches to now, so a new run starting before any of these
    -- would overlap it or rewrite it). Otherwise the server's time, with the device's kept on the row and reported as a time conflict.
    SELECT r.id, coalesce(r.ended_at, r.started_at) INTO v_floor_run, v_floor
    FROM public.machine_runs r WHERE r.machine_id = v_machine
    ORDER BY coalesce(r.ended_at, r.started_at) DESC LIMIT 1;
    v_run_at := v_at;
    IF v_floor IS NOT NULL AND v_at < v_floor THEN
      v_run_at := greatest(now(), v_floor);
      v_conflicts := v_conflicts || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'what', 'start', 'device_at', v_at, 'used_at', v_run_at,
                                                       'why', CASE WHEN v_floor_run = v_open_id THEN 'before_displaced_run_start' ELSE 'before_last_run_end' END,
                                                       'run_id', v_floor_run, 'run_until', v_floor);
    END IF;

    IF v_open_id IS NOT NULL THEN
      -- An admin taking the machine over: the other job's run ends when this one starts, recorded.
      v_displaced := v_open_id;
      v_overrides := v_overrides || (public.machine_run_end(v_open_id, v_run_at, 'override', NULL) || jsonb_build_object('job_no', v_open_no, 'machine', v_name));
    END IF;

    -- The plan row and the booking the run is against. The booking: the plan's; else the job's unfinished booking on that machine whose
    -- booked time (booking_intervals, 042) contains this start; else its earliest unfinished one. A machine not planned for the job joins
    -- the plan (042's rule: job_machines is the CURRENT plan, following the bookings): linked to that booking with its hours when the
    -- job has one on the machine and no plan row claims it yet; with 0 hours and no booking otherwise.
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

  IF jsonb_array_length(v_runs) > 0 OR v_stamped THEN
    PERFORM security_audit.log_named_event(v_org, 'START_MACHINE_RUN', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'started_at', v_at, 'job_start_stamped', v_stamped, 'runs', v_runs, 'machines_added_to_plan', v_added,
                         'client_op_id', p_client_op_id, 'client_started_at', p_started_at, 'time_conflicts', v_conflicts));
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
                                 'time_conflicts', v_conflicts, 'replayed', FALSE);
  IF p_client_op_id IS NOT NULL THEN
    INSERT INTO public.machine_run_ops (organization_id, client_op_id, kind, job_id, result, created_by) VALUES (v_org, p_client_op_id, 'start', p_job, v_result, v_uid);
  END IF;
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Pause: the machine freed, the job still started ------------------------------------------------------------
-- p_machines NULL or empty: every open run of the job. A replay (same p_client_op_id) returns what the first call ended.
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Finish: the job done, its runs ended, in the lock order --------------------------------------------------
-- The board's Finish (and the outbox replay of one). Fills an empty finish time only (a recorded one is never replaced: changed=false,
-- the time kept is returned), an empty start too (as the board did), stage 'inspection'; then every open run of the job ends with
-- 'finished' at the finish time (never before a run's start) and its booking completes. p_finished_at: the device's time (clamped /
-- refused as a Start's). 035's triggers record who finished (and started) from the session.
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
  v_ended JSONB := '[]'::JSONB;
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
  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'finished_at', v_at, 'changed', TRUE, 'ended', v_ended, 'time_conflicts', v_conflicts);
END
$$;
REVOKE ALL ON FUNCTION public.finish_job(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_job(UUID, UUID, TIMESTAMPTZ) TO authenticated;

-- A plain jobs update (the API role's own UPDATE grant) may still finish a job that holds no machine, as before 044. While the job has
-- an open run it is refused: that path already holds the job's row and can't take the company lock first, so the runs are ended only by
-- finish_job (which sets tolra.finish_job around its own update). The service role, the owner and the SQL editor are exempt (035's rule).
CREATE OR REPLACE FUNCTION public.jobs_finish_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('tolra.finish_job', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.finished_at IS NOT NULL AND OLD.finished_at IS NULL
     AND EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = NEW.id AND r.ended_at IS NULL) THEN
    RAISE EXCEPTION 'This job is running on a machine: finish it from the Job Board, which frees the machine.' USING ERRCODE = '42501', HINT = 'finish_via_rpc';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_finish_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_finish_ends_runs ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_finish_ends_runs();
DROP TRIGGER IF EXISTS ac_finish_guard ON public.jobs;
CREATE TRIGGER ac_finish_guard BEFORE UPDATE OF finished_at ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_finish_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. Release: an admin frees a machine whose run was forgotten ----------------------------------------------------
DROP FUNCTION IF EXISTS public.release_machine(UUID);
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 8. Assignment ----------------------------------------------------------------------------------------------------
-- p_user NULL clears the assignment. Admin and office assign anyone assignable; workshop staff only themselves (take the job, or hand
-- their own back). Assignable: an active admin, office or workshop membership of the company, with an active account.
CREATE OR REPLACE FUNCTION public.assign_job(p_job UUID, p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_uid   UUID := auth.uid();
  v_job   public.jobs%ROWTYPE;
  v_name  TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can assign a job' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    -- Workshop: "Take this job" (to me) or hand back a job that is mine.
    IF NOT (coalesce(p_user = v_uid, FALSE) OR (p_user IS NULL AND v_job.assigned_to IS NOT DISTINCT FROM v_uid)) THEN
      RAISE EXCEPTION 'Workshop staff can take a job themselves or hand their own back; the office assigns other people.' USING ERRCODE = '42501', HINT = 'assign_self_only';
    END IF;
  END IF;
  IF p_user IS NOT NULL THEN
    SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END INTO v_name
    FROM public.organization_members m JOIN public.user_profiles p ON p.id = m.user_id
    WHERE m.organization_id = v_org AND m.user_id = p_user AND m.active AND p.active
      AND (m.role IN ('admin', 'office', 'workshop') OR m.secondary_role IN ('admin', 'office', 'workshop'));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That person isn''t an active member of the company who can work a job.' USING ERRCODE = 'P0002', HINT = 'assignee_not_allowed';
    END IF;
  END IF;
  IF v_job.assigned_to IS NOT DISTINCT FROM p_user THEN
    RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'assigned_to', p_user, 'assigned_name', v_name, 'changed', FALSE);
  END IF;
  PERFORM set_config('tolra.assign_job', 'on', TRUE);
  UPDATE public.jobs SET assigned_to = p_user, assigned_at = CASE WHEN p_user IS NULL THEN NULL ELSE now() END, assigned_by = CASE WHEN p_user IS NULL THEN NULL ELSE v_uid END
  WHERE id = p_job;
  PERFORM set_config('tolra.assign_job', 'off', TRUE);
  PERFORM security_audit.log_named_event(v_org, 'ASSIGN_JOB', 'jobs', p_job::TEXT,
    jsonb_build_object('job_no', v_job.job_no, 'from', v_job.assigned_to, 'to', p_user, 'to_name', v_name, 'self', coalesce(p_user = v_uid, FALSE)));
  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'assigned_to', p_user, 'assigned_name', v_name, 'changed', TRUE);
END
$$;
REVOKE ALL ON FUNCTION public.assign_job(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_job(UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 9. Reading: who is on what, and who can be assigned ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.machines_in_use()
RETURNS TABLE (run_id UUID, machine_id UUID, machine_name TEXT, job_id UUID, job_no TEXT, booking_id UUID, operator_id UUID, operator_name TEXT, started_at TIMESTAMPTZ, stale BOOLEAN)
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
  SELECT r.id, r.machine_id, m.name, r.job_id, j.job_no, r.booking_id, r.operator_id,
         CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END,
         r.started_at, r.started_at < now() - INTERVAL '12 hours'
  FROM public.machine_runs r
  JOIN public.machines m ON m.id = r.machine_id
  JOIN public.jobs j ON j.id = r.job_id
  LEFT JOIN public.user_profiles p ON p.id = r.operator_id
  WHERE r.organization_id = v_org AND r.ended_at IS NULL
  ORDER BY m.name, r.started_at;
END
$$;
REVOKE ALL ON FUNCTION public.machines_in_use() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.machines_in_use() TO authenticated;

CREATE OR REPLACE FUNCTION public.assignable_people()
RETURNS TABLE (user_id UUID, display_name TEXT)
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
  SELECT m.user_id,
         CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END
  FROM public.organization_members m
  JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = v_org AND m.active AND p.active
    AND (m.role IN ('admin', 'office', 'workshop') OR m.secondary_role IN ('admin', 'office', 'workshop'))
  ORDER BY 2 NULLS LAST, 1;
END
$$;
REVOKE ALL ON FUNCTION public.assignable_people() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignable_people() TO authenticated;

-- Machine time per machine between p_from and p_to: the UNION of its run intervals clipped to the window (an open run counts to now),
-- never the plain sum, so time is counted once even if runs ever overlapped. Read-only, the four roles, the caller's company. Hours only.
CREATE OR REPLACE FUNCTION public.machine_time(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (machine_id UUID, machine_name TEXT, hours NUMERIC, runs INTEGER)
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
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > INTERVAL '400 days' THEN
    RAISE EXCEPTION 'Give a window of up to 400 days (from before to).' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT m.id, m.name,
         public.tstz_union_hours(array_agg(tstzrange(greatest(r.started_at, p_from), least(coalesce(r.ended_at, greatest(now(), r.started_at)), p_to), '[)'))),
         count(r.id)::INTEGER
  FROM public.machine_runs r
  JOIN public.machines m ON m.id = r.machine_id
  WHERE r.organization_id = v_org AND r.started_at < p_to AND coalesce(r.ended_at, greatest(now(), r.started_at)) > p_from
  GROUP BY m.id, m.name
  ORDER BY m.name, m.id;
END
$$;
REVOKE ALL ON FUNCTION public.machine_time(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.machine_time(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 10. The second step (033) on every function this migration writes through ------------------------------
DO $do$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)',
    'public.finish_job(uuid,uuid,timestamptz)', 'public.release_machine(uuid,text)', 'public.assign_job(uuid,uuid)']
  LOOP
    IF to_regprocedure(f) IS NULL OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(f))) = 0 THEN
      RAISE EXCEPTION '044: % does not start with the second-step check', f;
    END IF;
  END LOOP;
END
$do$;

COMMIT;
