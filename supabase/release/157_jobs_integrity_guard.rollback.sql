-- Rollback of release step 157 (jobs integrity guard). One transaction.
-- Drops the trigger jobs_zzz_integrity_guard from public.jobs and the function public.jobs_integrity_guard(), and puts 049's public.start_machine_run back byte for byte
-- (supabase/migrations/049_paused_machine_ack.sql: CREATE OR REPLACE keeps its grants; the check compares its definer flag, settings and grants before and after). No row is touched; no other function,
-- trigger, grant or policy is touched (a before/after fingerprint must be identical). Running it twice equals running it once. After it, the five
-- defects (a start time that can be replaced, cleared or first set by editing the job, a job created with a start or finish time, a finish time that can be set by editing the job, a workshop-only user
-- changing a job's customer or number, a workshop-only user withdrawing a passed inspection, and an office or admin edit withdrawing the passed inspection
-- of a despatched or invoiced job) are open again.
-- Refuses, changing nothing, if a function named jobs_integrity_guard or a trigger named jobs_zzz_integrity_guard exists and is not 157's, or if start_machine_run is neither 157's nor
-- 049's (stop and compare it first).
BEGIN;
DO $rollback_guard$
DECLARE
  v TEXT;
BEGIN
 IF to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') IS NULL OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'start_machine_run') <> 1 THEN
  RAISE EXCEPTION '157 rollback: public.start_machine_run (049''s 8-argument function, once) is missing; stop and compare it first';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');
 IF v IS DISTINCT FROM 'e5a66b0a8b183e1f6a51927bca89953e' AND v IS DISTINCT FROM '2147348075e8d7d38639bd11c9da0c30' THEN
  RAISE EXCEPTION '157 rollback: public.start_machine_run is neither 157''s nor 049''s; stop and compare it first';
 END IF;
 IF to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()');
  IF v IS DISTINCT FROM '72b0718e820a59a960f01654b82c6d1d' THEN
   RAISE EXCEPTION '157 rollback: public.jobs_integrity_guard() is not 157''s; stop and compare it first';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal)
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 23 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                      AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
  RAISE EXCEPTION '157 rollback: a trigger named jobs_zzz_integrity_guard exists on public.jobs and is not 157''s; stop and compare it first';
 END IF;
END $rollback_guard$;

-- Before: the same fingerprint the release takes (the other triggers on jobs, its policies, grants and row security, every other function in public).
CREATE FUNCTION pg_temp.p157_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p157fp$
  SELECT 'jobs triggers'::TEXT, md5(coalesce(string_agg(t.tgname || ' ' || pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::TEXT, E'\n' ORDER BY t.tgname COLLATE "C"), ''))
  FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND NOT t.tgisinternal AND t.tgname <> 'jobs_zzz_integrity_guard'
  UNION ALL SELECT 'jobs policies', md5(coalesce(string_agg(p.polname::TEXT || ' ' || p.polcmd::TEXT || ' ' || p.polpermissive::TEXT || ' ' || p.polroles::TEXT || ' '
                                                           || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\n' ORDER BY p.polname COLLATE "C"), ''))
  FROM pg_policy p WHERE p.polrelid = 'public.jobs'::regclass
  UNION ALL SELECT 'jobs grants and row security', md5(coalesce((SELECT c.relacl::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass), '') || '|'
                                                    || (SELECT c.relrowsecurity::TEXT || c.relforcerowsecurity::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass) || '|'
                                                    || coalesce((SELECT string_agg(a.attname::TEXT || ':' || a.attacl::TEXT, ',' ORDER BY a.attname COLLATE "C") FROM pg_attribute a
                                                                 WHERE a.attrelid = 'public.jobs'::regclass AND a.attacl IS NOT NULL), ''))
  UNION ALL SELECT 'public functions', md5(coalesce(string_agg(p.oid::regprocedure::TEXT || ' ' || md5(p.prosrc) || ' ' || p.prosecdef::TEXT || ' ' || coalesce(p.proacl::TEXT, '') || ' '
                                                              || coalesce(p.proconfig::TEXT, ''), E'\n' ORDER BY p.oid::regprocedure::TEXT COLLATE "C"), ''))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'jobs_integrity_guard' AND p.oid IS DISTINCT FROM to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)')
$p157fp$;
CREATE TEMP TABLE p157_before ON COMMIT DROP AS SELECT * FROM pg_temp.p157_fingerprint();
CREATE TEMP TABLE p157_smr_before ON COMMIT DROP AS SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');

DROP TRIGGER IF EXISTS jobs_zzz_integrity_guard ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_integrity_guard();

-- 049's start_machine_run, verbatim (supabase/migrations/049_paused_machine_ack.sql, the 8-argument form; no GRANT or REVOKE: CREATE OR REPLACE keeps the grants).
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

DO $rollback_self_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2147348075e8d7d38639bd11c9da0c30') THEN
    RAISE EXCEPTION '157 rollback self-check: public.start_machine_run must be 049''s body again';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_smr_before EXCEPT SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)'))
     OR EXISTS (SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') EXCEPT SELECT * FROM pg_temp.p157_smr_before) THEN
    RAISE EXCEPTION '157 rollback self-check: public.start_machine_run changed in more than its body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard')
     OR to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
    RAISE EXCEPTION '157 rollback self-check: the trigger jobs_zzz_integrity_guard and the function public.jobs_integrity_guard() must be gone';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_before EXCEPT SELECT * FROM pg_temp.p157_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p157_fingerprint() EXCEPT SELECT * FROM pg_temp.p157_before) THEN
    RAISE EXCEPTION '157 rollback self-check: another trigger, policy or grant on jobs, or another function in public (other than start_machine_run), changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p157_before;
DROP TABLE pg_temp.p157_smr_before;
DROP FUNCTION pg_temp.p157_fingerprint();
COMMIT;
