-- 049_paused_machine_ack.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 049: Job Board play/pause. The paused-machine warning (soft, audited), an explicit bench Start, and Start replays bound to the person
-- and the request. Plan: docs/packets/job-board-ux-plan.md (round 3: R3.1, R3.2, R3.5).
--
-- Rhys's decisions: one Play/Pause control; Pause stops the job's time and frees its machines (unchanged: pause_machine_run already does
-- that); someone starting or booking a machine whose last run was PAUSED on another unfinished job is warned to check with that operator
-- first. The warning is SOFT: it never refuses a Start or a booking. The person's confirmation is recorded against the paused run.
--
-- 1. paused_machine_current(org, machine, exclude job), internal: machine M's current paused run. M's latest run by ended_at, when no run
--    is open on M, that ended 'paused', whose job is not finished and has no open run anywhere, and is not the job being started or booked.
--    Bench runs (no machine) are never included. No time limit. start_machine_run, paused_machines and acknowledge_paused_machine all use
--    it, so the three can never disagree. machine_run_ops gains request_sha256 (nullable): the sha256 of the canonical request
--    (machine_run_request_sha256, internal, 045's canonical_jsonb). paused_ack_ops: the stored answer of each booking confirmation, keyed
--    by company and client key (RLS on, no policy, no grant: the function only).
-- 2. start_machine_run gains two arguments, p_paused_ack JSONB and p_bench BOOLEAN (both DEFAULT NULL). The 6-argument form is dropped
--    first, so there is ONE signature (two would make PostgREST's choice ambiguous); a 6-argument named call from the previous build
--    resolves to the new function through the defaults and gets 046's answers. 046's body is kept with every check, lock and bench/machine
--    rule; the additions:
--    a. a shape check of p_paused_ack before the lock and before any write (22023, HINT paused_ack_invalid, DETAIL {"index": n} only): NULL
--       or an array of at most 10 objects, each exactly {machine_id, paused_run_id} as UUID strings, no machine twice, every machine named
--       in p_machines. p_bench TRUE with machines is refused (22023, HINT bench_with_machines).
--    b. the replay of a client key (under the company lock, as 046) returns the stored answer only when the job, the kind, the person who
--       made it (created_by) and request_sha256 all match; anything else is 22023 client_op_reused. A row written before 049 has no hash: it
--       replays on job, kind and person only.
--    c. each acknowledgement is checked after the job's row lock, before any write: its run exists in the caller's company, on that
--       machine (so never a bench run) and ended 'paused'. Otherwise 22023 paused_ack_invalid with only the index (the same answer for a run
--       of another company, so nothing about it is revealed).
--    d. for each named machine with a current paused run R, one START_OVER_PAUSED_JOB event: acknowledged (the ack named R), superseded
--       (it named another paused run: re-paused in between; R goes into paused_warnings) or not acknowledged (no ack; R goes into
--       paused_warnings). An ack for a machine with no current paused run any more writes nothing. paused_warnings is part of the stored
--       answer, so a replay returns the same warnings and writes no second event.
--    e. p_bench: NULL keeps 046 exactly. TRUE on a job with no open machine run opens a bench run even where 046 answered
--       started_without_bench (a Start timer on a bulk-started job, or a bench Start after machine-only work). The 046 guards hold: an open
--       machine run still answers bench_skipped 'on_machine', an open bench run answers already; the exclusion constraints are untouched.
-- 3. paused_machines(): read-only, the four roles, the caller's company: each machine with a current paused run (the run, its job, the
--    operator's and the pauser's display names, never an e-mail, and when). The Job Board and the schedule show exactly these rows and
--    send back the run ids they showed.
-- 4. acknowledge_paused_machine(machine, paused run, job, client key): the schedule's "I've checked" before a booking. Second step, no
--    support session, admin, office or workshop; replay by (company, key) bound to the person, machine, job, run and request hash; the run
--    gets the check of 2c; audited BOOK_OVER_PAUSED_JOB; answers matched (the run named is still the machine's current paused run) and the
--    current paused run. The booking itself is saved by save_machine_booking, unchanged.
-- 5. In-migration assertions (046 section 5 style).
--
-- LOCK ORDER (unchanged, 044): (1) the per-company advisory lock 'job-no:<org>'; (2) the job's row FOR UPDATE; (3) machine_runs,
-- machine_run_ops, paused_ack_ops and machine_bookings.
--
-- Forward only, safe to run more than once. No backfill: rows of machine_run_ops written before 049 keep a NULL hash.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The booking confirmations, the request hash, the current paused run of a machine -------------------------------------
CREATE TABLE IF NOT EXISTS public.paused_ack_ops (
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  client_op_id    UUID NOT NULL,
  machine_id      UUID NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  paused_run_id   UUID NOT NULL REFERENCES public.machine_runs(id) ON DELETE CASCADE,
  request_sha256  TEXT NOT NULL,
  result          JSONB NOT NULL,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, client_op_id)
);
CREATE INDEX IF NOT EXISTS idx_paused_ack_ops_job ON public.paused_ack_ops (job_id);
CREATE INDEX IF NOT EXISTS idx_paused_ack_ops_run ON public.paused_ack_ops (paused_run_id);
ALTER TABLE public.paused_ack_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paused_ack_ops FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_same_org_machine_id ON public.paused_ack_ops;
CREATE TRIGGER zz_same_org_machine_id BEFORE INSERT OR UPDATE ON public.paused_ack_ops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines', 'machine_id');
DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.paused_ack_ops;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.paused_ack_ops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_paused_run_id ON public.paused_ack_ops;
CREATE TRIGGER zz_same_org_paused_run_id BEFORE INSERT OR UPDATE ON public.paused_ack_ops
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machine_runs', 'paused_run_id');
DROP TRIGGER IF EXISTS support_read_only ON public.paused_ack_ops;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.paused_ack_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.paused_ack_ops;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.paused_ack_ops
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- The canonical request a Start's client key is bound to (NULL on rows written before 049).
ALTER TABLE public.machine_run_ops ADD COLUMN IF NOT EXISTS request_sha256 TEXT;

-- Machine p_machine's current paused run (the warning's rule), or NULL. Internal: no API role may call it.
CREATE OR REPLACE FUNCTION public.paused_machine_current(p_org UUID, p_machine UUID, p_exclude_job UUID)
RETURNS public.machine_runs
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run public.machine_runs%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_machine IS NULL THEN
    RETURN NULL;
  END IF;
  -- A machine in use now: nothing paused on it to warn about.
  IF EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.machine_id = p_machine AND r.ended_at IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_run FROM public.machine_runs r
  WHERE r.organization_id = p_org AND r.machine_id = p_machine AND r.ended_at IS NOT NULL
  ORDER BY r.ended_at DESC, r.created_at DESC, r.id DESC
  LIMIT 1;
  IF v_run.id IS NULL OR v_run.end_reason IS DISTINCT FROM 'paused' OR v_run.job_id = p_exclude_job THEN
    RETURN NULL;
  END IF;
  -- Its job finished, or resumed anywhere (an open run of any kind): not paused any more.
  IF EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_run.job_id AND j.finished_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.job_id = v_run.job_id AND r.ended_at IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN v_run;
END
$$;
REVOKE ALL ON FUNCTION public.paused_machine_current(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The sha256 of a Start's canonical request: job, machines (sorted), the device time (UTC), override, reason, bench and the
-- acknowledgements (sorted by machine). Every value is text, a boolean or null (canonical_jsonb holds no numbers). Internal.
CREATE OR REPLACE FUNCTION public.machine_run_request_sha256(p_job UUID, p_machines UUID[], p_started_at TIMESTAMPTZ, p_override BOOLEAN, p_reason TEXT,
                                                            p_bench BOOLEAN, p_paused_ack JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(extensions.digest(convert_to(public.canonical_jsonb(jsonb_build_object(
    'job', p_job::TEXT,
    'machines', coalesce((SELECT jsonb_agg(m::TEXT ORDER BY m::TEXT) FROM unnest(coalesce(p_machines, ARRAY[]::UUID[])) m), '[]'::JSONB),
    'started_at', to_char(p_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'override', coalesce(p_override, FALSE),
    'reason', nullif(btrim(coalesce(p_reason, '')), ''),
    'bench', coalesce(p_bench, FALSE),
    'paused_ack', coalesce((SELECT jsonb_agg(jsonb_build_object('machine_id', lower(a ->> 'machine_id'), 'paused_run_id', lower(a ->> 'paused_run_id'))
                                             ORDER BY lower(a ->> 'machine_id'))
                            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_paused_ack) = 'array' THEN p_paused_ack ELSE '[]'::JSONB END) a), '[]'::JSONB)
  )), 'UTF8'), 'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION public.machine_run_request_sha256(UUID, UUID[], TIMESTAMPTZ, BOOLEAN, TEXT, BOOLEAN, JSONB) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Start: as 046, plus the paused-machine acknowledgements, an explicit bench Start and a request-bound replay -----------
-- One signature only: the 6-argument form goes first (a 6-argument named call resolves to this one through the defaults).
DROP FUNCTION IF EXISTS public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION public.start_machine_run(p_job UUID, p_machines UUID[], p_client_op_id UUID, p_started_at TIMESTAMPTZ, p_override BOOLEAN, p_reason TEXT,
                                                   p_paused_ack JSONB DEFAULT NULL, p_bench BOOLEAN DEFAULT NULL)
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
  v_hash      TEXT;
  v_ack       JSONB;
  v_i         INTEGER;
  v_seen      UUID[] := ARRAY[]::UUID[];
  v_ack_machine UUID;
  v_ack_run   UUID;
  v_cur       public.machine_runs%ROWTYPE;
  v_paused    JSONB := '[]'::JSONB;
  v_warnings  JSONB := '[]'::JSONB;
  v_p         JSONB;
  v_uuid_re   CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
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

  -- 049: the shape of the paused-machine acknowledgements, before the lock and before any write. Only the index of the first bad entry
  -- is reported.
  IF coalesce(p_bench, FALSE) AND cardinality(v_machines) > 0 THEN
    RAISE EXCEPTION 'A bench Start names no machine.' USING ERRCODE = '22023', HINT = 'bench_with_machines';
  END IF;
  IF p_paused_ack IS NOT NULL AND jsonb_typeof(p_paused_ack) <> 'null' THEN
    IF jsonb_typeof(p_paused_ack) <> 'array' THEN
      RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = '{"index": 0}';
    END IF;
    IF jsonb_array_length(p_paused_ack) > 10 THEN
      RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = '{"index": 10}';
    END IF;
    v_i := 0;
    FOR v_ack IN SELECT a FROM jsonb_array_elements(p_paused_ack) a LOOP
      -- One test at a time (an expression's parts may run in any order, and jsonb_object_keys refuses a non-object).
      IF jsonb_typeof(v_ack) <> 'object' THEN
        RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = jsonb_build_object('index', v_i)::TEXT;
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(v_ack)) <> 2
         OR jsonb_typeof(v_ack -> 'machine_id') IS DISTINCT FROM 'string' OR jsonb_typeof(v_ack -> 'paused_run_id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = jsonb_build_object('index', v_i)::TEXT;
      END IF;
      IF (v_ack ->> 'machine_id') !~ v_uuid_re OR (v_ack ->> 'paused_run_id') !~ v_uuid_re THEN
        RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = jsonb_build_object('index', v_i)::TEXT;
      END IF;
      v_ack_machine := (v_ack ->> 'machine_id')::UUID;
      IF v_ack_machine = ANY (v_seen) OR NOT (v_ack_machine = ANY (v_machines)) THEN
        RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = jsonb_build_object('index', v_i)::TEXT;
      END IF;
      v_seen := v_seen || v_ack_machine;
      v_i := v_i + 1;
    END LOOP;
  END IF;
  v_hash := public.machine_run_request_sha256(p_job, v_machines, p_started_at, p_override, p_reason, p_bench, p_paused_ack);
  v_at := public.machine_run_client_time(p_started_at);

  -- Lock first (the same lock, in the same order, as create_job and save_machine_booking), then the job's row, then look, then write.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- A replay of a Start already recorded (same key, SAME JOB, SAME PERSON, SAME REQUEST): the first answer, from machine_run_ops, and
  -- nothing else (no run, machine or bench, made or ended, no event, whatever happened since). A row written before 049 has no hash and
  -- replays on job, kind and person. Anything else under a used key is refused outright.
  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_op FROM public.machine_run_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
    IF FOUND THEN
      IF v_op.job_id = p_job AND v_op.kind = 'start' AND v_op.created_by = v_uid AND (v_op.request_sha256 IS NULL OR v_op.request_sha256 = v_hash) THEN
        RETURN v_op.result || jsonb_build_object('replayed', TRUE);
      END IF;
      RAISE EXCEPTION 'This Start was already recorded with different details. Reload the board and start the job again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
    END IF;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'This job is finished: it can''t be started on a machine.' USING ERRCODE = '42501', HINT = 'job_finished';
  END IF;

  -- 049: each acknowledgement names a paused run of this company on that machine (never a bench run). The same answer whatever is wrong.
  IF jsonb_typeof(p_paused_ack) = 'array' THEN
    v_i := 0;
    FOR v_ack IN SELECT a FROM jsonb_array_elements(p_paused_ack) a LOOP
      IF NOT EXISTS (SELECT 1 FROM public.machine_runs r WHERE r.id = (v_ack ->> 'paused_run_id')::UUID AND r.organization_id = v_org
                       AND r.machine_id = (v_ack ->> 'machine_id')::UUID AND r.end_reason = 'paused') THEN
        RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the board and start again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = jsonb_build_object('index', v_i)::TEXT;
      END IF;
      v_i := v_i + 1;
    END LOOP;
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
    -- 049: the machine's current paused run (another unfinished job paused on it), read before any run is written. Never a refusal.
    v_cur := public.paused_machine_current(v_org, v_machine, p_job);
    IF v_cur.id IS NOT NULL THEN
      v_ack_run := NULL;
      SELECT (a ->> 'paused_run_id')::UUID INTO v_ack_run FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_paused_ack) = 'array' THEN p_paused_ack ELSE '[]'::JSONB END) a
      WHERE (a ->> 'machine_id')::UUID = v_machine;
      v_paused := v_paused || jsonb_build_object(
        'machine_id', v_machine, 'machine', v_name, 'paused_run_id', v_cur.id, 'paused_job_id', v_cur.job_id,
        'paused_job_no', (SELECT j.job_no FROM public.jobs j WHERE j.id = v_cur.job_id),
        'operator_name', (SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END FROM public.user_profiles p WHERE p.id = v_cur.operator_id),
        'paused_by_name', (SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END FROM public.user_profiles p WHERE p.id = v_cur.ended_by),
        'paused_at', v_cur.ended_at, 'acknowledged', v_ack_run IS NOT NULL AND v_ack_run = v_cur.id,
        'superseded', v_ack_run IS NOT NULL AND v_ack_run <> v_cur.id, 'acknowledged_run_id', v_ack_run);
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

  -- A Start that names no machine: the job's bench run (046), when it starts the job now or resumes a paused bench run; or (049) when the
  -- person chose the bench explicitly (p_bench TRUE): then it opens even on a job started some other way. An open machine run still wins.
  IF cardinality(v_machines) = 0 THEN
    v_bench := public.bench_run_open(v_org, p_job, v_at, p_client_op_id, v_uid, v_stamped OR coalesce(p_bench, FALSE));
    v_bench_run := nullif(v_bench -> 'run', 'null'::JSONB);
    IF jsonb_typeof(v_bench -> 'conflict') = 'object' THEN
      v_conflicts := v_conflicts || (v_bench -> 'conflict');
    END IF;
  END IF;

  IF jsonb_array_length(v_runs) > 0 OR v_stamped OR coalesce((v_bench_run ->> 'already')::BOOLEAN = FALSE, FALSE) THEN
    PERFORM security_audit.log_named_event(v_org, 'START_MACHINE_RUN', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'started_at', v_at, 'job_start_stamped', v_stamped, 'runs', v_runs, 'machines_added_to_plan', v_added,
                         'bench_run', v_bench_run, 'client_op_id', p_client_op_id, 'client_started_at', p_started_at, 'time_conflicts', v_conflicts,
                         'bench_requested', coalesce(p_bench, FALSE)));
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
  -- 049: one event per machine started over another job's pause (soft warning: recorded, never refused). Unacknowledged and superseded
  -- ones are answered under paused_warnings.
  FOR v_p IN SELECT p FROM jsonb_array_elements(v_paused) p LOOP
    PERFORM security_audit.log_named_event(v_org, 'START_OVER_PAUSED_JOB', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'machine_id', v_p -> 'machine_id', 'machine', v_p -> 'machine', 'paused_run_id', v_p -> 'paused_run_id',
                         'paused_job_id', v_p -> 'paused_job_id', 'paused_job_no', v_p -> 'paused_job_no', 'operator_name', v_p -> 'operator_name',
                         'paused_by_name', v_p -> 'paused_by_name', 'paused_at', v_p -> 'paused_at', 'acknowledged', v_p -> 'acknowledged',
                         'superseded', v_p -> 'superseded', 'acknowledged_run_id', v_p -> 'acknowledged_run_id', 'client_op_id', p_client_op_id,
                         'actor_user_id', v_uid, 'at', now()));
    IF NOT (v_p ->> 'acknowledged')::BOOLEAN THEN
      v_warnings := v_warnings || jsonb_build_object('machine_id', v_p -> 'machine_id', 'machine', v_p -> 'machine', 'paused_run_id', v_p -> 'paused_run_id',
                                                     'job_no', v_p -> 'paused_job_no', 'operator_name', v_p -> 'operator_name',
                                                     'paused_by_name', v_p -> 'paused_by_name', 'paused_at', v_p -> 'paused_at');
    END IF;
  END LOOP;

  v_result := jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'started_at', coalesce(v_job.started_at, v_at), 'runs', v_runs, 'overrides', v_overrides,
                                 'time_conflicts', v_conflicts, 'job_start_stamped', v_stamped, 'bench_run', v_bench_run, 'bench_skipped', v_bench ->> 'why',
                                 'bench_ended', v_bench_ended, 'paused_warnings', v_warnings, 'replayed', FALSE);
  IF p_client_op_id IS NOT NULL THEN
    INSERT INTO public.machine_run_ops (organization_id, client_op_id, kind, job_id, result, created_by, request_sha256)
    VALUES (v_org, p_client_op_id, 'start', p_job, v_result, v_uid, v_hash);
  END IF;
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT, JSONB, BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Reading: the machines with a current paused run -------------------------------------------------------------------
-- Display names only (never an e-mail). Read-only, the four roles, the caller's company.
CREATE OR REPLACE FUNCTION public.paused_machines()
RETURNS TABLE (machine_id UUID, paused_run_id UUID, job_id UUID, job_no TEXT, operator_name TEXT, paused_by_name TEXT, paused_at TIMESTAMPTZ)
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
  SELECT m.id, r.id, r.job_id, j.job_no,
         CASE WHEN nullif(btrim(op.full_name), '') IS NULL OR op.full_name LIKE '%@%' THEN NULL ELSE left(btrim(op.full_name), 80) END,
         CASE WHEN nullif(btrim(pb.full_name), '') IS NULL OR pb.full_name LIKE '%@%' THEN NULL ELSE left(btrim(pb.full_name), 80) END,
         r.ended_at
  FROM public.machines m
  CROSS JOIN LATERAL public.paused_machine_current(v_org, m.id, NULL) r
  JOIN public.jobs j ON j.id = r.job_id AND j.organization_id = v_org
  LEFT JOIN public.user_profiles op ON op.id = r.operator_id
  LEFT JOIN public.user_profiles pb ON pb.id = r.ended_by
  WHERE m.organization_id = v_org AND r.id IS NOT NULL
  ORDER BY m.name, m.id;
END
$$;
REVOKE ALL ON FUNCTION public.paused_machines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paused_machines() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Booking over a paused machine: the schedule's "I've checked" ------------------------------------------------------------
-- p_job: the job being booked. Each "I've checked" press sends a NEW key; a key is bound to the person, machine, job, run and request.
CREATE OR REPLACE FUNCTION public.acknowledge_paused_machine(p_machine UUID, p_paused_run UUID, p_job UUID, p_client_op_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_hash    TEXT;
  v_op      public.paused_ack_ops%ROWTYPE;
  v_run     public.machine_runs%ROWTYPE;
  v_cur     public.machine_runs%ROWTYPE;
  v_job_no  TEXT;
  v_current JSONB;
  v_matched BOOLEAN;
  v_result  JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF public.session_read_only() THEN
    RAISE EXCEPTION 'Support access is read-only. Ask for write access first.' USING ERRCODE = '42501', HINT = 'support_read_only';
  END IF;
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can book a machine' USING ERRCODE = '42501';
  END IF;
  IF p_machine IS NULL OR p_paused_run IS NULL OR p_job IS NULL OR p_client_op_id IS NULL THEN
    RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the schedule and book again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = '{"index": 0}';
  END IF;
  v_hash := encode(extensions.digest(convert_to(public.canonical_jsonb(jsonb_build_object(
              'machine', p_machine::TEXT, 'paused_run', p_paused_run::TEXT, 'job', p_job::TEXT)), 'UTF8'), 'sha256'), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- A replay (same company and key): the stored answer, only for the same person and the same request. Anything else is refused.
  SELECT * INTO v_op FROM public.paused_ack_ops o WHERE o.organization_id = v_org AND o.client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_op.created_by = v_uid AND v_op.machine_id = p_machine AND v_op.job_id = p_job AND v_op.paused_run_id = p_paused_run AND v_op.request_sha256 = v_hash THEN
      RETURN v_op.result || jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION 'This check was already recorded with different details. Press "I''ve checked" again.' USING ERRCODE = '22023', HINT = 'client_op_reused';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.machines m WHERE m.id = p_machine AND m.organization_id = v_org) THEN
    RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT j.job_no INTO v_job_no FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  -- The run named: a paused run of this company on that machine (never a bench run). The same answer whatever is wrong.
  SELECT * INTO v_run FROM public.machine_runs r WHERE r.id = p_paused_run AND r.organization_id = v_org AND r.machine_id = p_machine AND r.end_reason = 'paused';
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'The paused-machine check doesn''t match. Reload the schedule and book again.' USING ERRCODE = '22023', HINT = 'paused_ack_invalid', DETAIL = '{"index": 0}';
  END IF;
  IF v_run.job_id = p_job THEN
    RAISE EXCEPTION 'That machine was paused on this same job: there is nothing to check.' USING ERRCODE = '22023', HINT = 'paused_ack_same_job';
  END IF;

  v_cur := public.paused_machine_current(v_org, p_machine, p_job);
  v_matched := v_cur.id IS NOT NULL AND v_cur.id = p_paused_run;
  IF v_cur.id IS NOT NULL THEN
    SELECT jsonb_build_object('machine_id', p_machine, 'paused_run_id', v_cur.id, 'job_id', v_cur.job_id, 'job_no', j.job_no,
             'operator_name', (SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END FROM public.user_profiles p WHERE p.id = v_cur.operator_id),
             'paused_by_name', (SELECT CASE WHEN nullif(btrim(p.full_name), '') IS NULL OR p.full_name LIKE '%@%' THEN NULL ELSE left(btrim(p.full_name), 80) END FROM public.user_profiles p WHERE p.id = v_cur.ended_by),
             'paused_at', v_cur.ended_at)
      INTO v_current FROM public.jobs j WHERE j.id = v_cur.job_id;
    PERFORM security_audit.log_named_event(v_org, 'BOOK_OVER_PAUSED_JOB', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job_no, 'booking_job_id', p_job, 'machine_id', p_machine, 'paused_run_id', v_cur.id, 'paused_job_id', v_cur.job_id,
                         'paused_job_no', v_current -> 'job_no', 'operator_name', v_current -> 'operator_name', 'paused_by_name', v_current -> 'paused_by_name',
                         'paused_at', v_cur.ended_at, 'acknowledged', v_matched, 'superseded', NOT v_matched, 'acknowledged_run_id', p_paused_run,
                         'client_op_id', p_client_op_id, 'actor_user_id', v_uid, 'at', now()));
  END IF;

  v_result := jsonb_build_object('ack_id', p_client_op_id, 'matched', v_matched, 'machine_id', p_machine, 'acknowledged_run_id', p_paused_run,
                                 'current', v_current, 'replayed', FALSE);
  INSERT INTO public.paused_ack_ops (organization_id, client_op_id, machine_id, job_id, paused_run_id, request_sha256, result, created_by)
  VALUES (v_org, p_client_op_id, p_machine, p_job, p_paused_run, v_hash, v_result, v_uid);
  RETURN v_result;
END
$$;
REVOKE ALL ON FUNCTION public.acknowledge_paused_machine(UUID, UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_paused_machine(UUID, UUID, UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Assertions: one start_machine_run (the 8-argument one) with the second step and 046's bench rules; no anon grant ----------
DO $do$
DECLARE
  v_start REGPROCEDURE := to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');
  v_def   TEXT;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'start_machine_run') <> 1 OR v_start IS NULL THEN
    RAISE EXCEPTION '049: start_machine_run must exist once, with 8 arguments';
  END IF;
  v_def := pg_get_functiondef(v_start);
  IF position('assert_privileged_aal' IN v_def) = 0 OR position('assert_privileged_aal' IN v_def) > position('v_org IS NULL' IN v_def) THEN
    RAISE EXCEPTION '049: start_machine_run does not start with the second-step check';
  END IF;
  IF position('bench_run_open' IN v_def) = 0 OR position('''to_machine''' IN v_def) = 0 OR position('BENCH_TO_MACHINE' IN v_def) = 0 THEN
    RAISE EXCEPTION '049: start_machine_run lost 046''s bench rules';
  END IF;
  IF position('assert_privileged_aal' IN pg_get_functiondef('public.acknowledge_paused_machine(uuid,uuid,uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '049: acknowledge_paused_machine does not start with the second-step check';
  END IF;
  IF has_function_privilege('anon', v_start, 'EXECUTE')
     OR has_function_privilege('anon', 'public.paused_machines()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.acknowledge_paused_machine(uuid,uuid,uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '049: anon may execute a 049 function';
  END IF;
  IF has_function_privilege('authenticated', 'public.paused_machine_current(uuid,uuid,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.machine_run_request_sha256(uuid,uuid[],timestamptz,boolean,text,boolean,jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '049: an internal 049 helper is callable through the API';
  END IF;
END
$do$;

COMMIT;
