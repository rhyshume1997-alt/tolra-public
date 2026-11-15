-- Post-144 release step 157 (jobs integrity guard: a recorded start time is kept and the first start is set only by Play, the bench Start or Finish, a finish time is set only by Finish,
-- a job can't be created with a start or finish time, a workshop-only user can't change a
-- job's customer or number or withdraw a passed inspection, and nobody ordinary-edits away the passed inspection of a despatched or invoiced job; registered in supabase/release-plan.json as phase 157, after 156; 155 is reserved and not
-- in this candidate; CI's post-144 step installs it). One transaction; never part of baseline replay. Not applied anywhere hosted: migration allowed
-- for development, scratch and CI only (PM, 15 Nov 2026); production only with Rhys's separate yes. Canonical source:
-- supabase/proposals/p157_jobs_integrity_guard.sql (its body between BEGIN; and COMMIT; is copied below verbatim between the fingerprint and the
-- self-check; read its header). Its guard needs the job objects of 022, 034, 035, 037, 044/061, 081, 083 and 113 only, not 156.
-- Verify: supabase/verify/jobs_integrity_guard_157.sql (every row true).
-- Rollback: supabase/release/157_jobs_integrity_guard.rollback.sql (drops the trigger and the function and puts 049's start_machine_run back byte for byte; touches no row). Running this file again once
-- applied changes nothing (the functions are 157's, the trigger exists and is not created again).
-- REFUSES, changing nothing, when a job object it relies on is missing or is not as the older releases left it (HINT jobs_integrity_prerequisite), or
-- when a function or trigger already named jobs_integrity_guard / jobs_zzz_integrity_guard is not 157's (HINT jobs_integrity_name_taken), or when public.start_machine_run is neither 049's nor 157's (HINT jobs_integrity_prerequisite).
-- Changes no row, no trigger, grant or policy and no function but two: jobs_integrity_guard (its own) and public.start_machine_run, re-created with 049's body verbatim plus two
-- transaction-local statements (PERFORM set_config('tolra.job_start', ...)) around its own update of the job's start time (PM ruling 15 Nov 2026, Option A). A before/after fingerprint of the jobs triggers,
-- policies and grants and of every other function in public must be identical, and start_machine_run's definer flag, settings, grants and signature must be unchanged and its body
-- identical but for those two statements, or the self-check stops the release.
-- BEHAVIOUR CHANGE (everyone; rule C6): a job's first start time is set only by Play, the bench Start (start_machine_run) or Finish (finish_job): editing the job to set it (including the offline
-- 'machine taken' fallback, until the separate Offline Synchronisation change) is refused (HINT start_via_rpc), and a job can't be INSERTed with a start or finish time (HINT start_via_rpc / finish_via_rpc).
-- BEHAVIOUR CHANGE (workshop users): editing the worksheet, stage, customer or job number of a job that has passed inspection is refused. Re-inspection,
-- rework and reopen are unchanged (docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md, L12).
-- BEHAVIOUR CHANGE (every browser role, office and admin too; rule C5, HINT released_pass_kept): once a job is despatched or invoiced, an ordinary edit that
-- would withdraw its passed inspection is refused. A correction goes through a failed inspection or rework (which record a reason), never a worksheet edit.
-- DEFINER RIGHTS (reviewed explicitly): public.jobs_integrity_guard() is SECURITY DEFINER with search_path = pg_catalog, public, following 044's
-- jobs_finish_guard, so C5 can see delivery notes and invoices whatever the caller may read (an Invoices-hidden office or admin member would otherwise
-- pass an invoker lookup). Its lookups are two EXISTS tests pinned to the job's own company and the job's own id / number and return only yes or no;
-- the refusal text is fixed and quotes no document number. EXECUTE stays revoked from PUBLIC, anon and authenticated (a trigger function needs none to
-- fire); service_role is left as 044 leaves it. See the comment at the top of the function body.
BEGIN;
DO $post_release_guard$
DECLARE
  v         TEXT;
  v_missing TEXT;
BEGIN
 SELECT string_agg(m.what, ', ' ORDER BY m.what) INTO v_missing FROM (
   SELECT 'trigger ' || r.tg AS what FROM unnest(ARRAY['jobs_worksheet_version', 'jobs_worksheet_version_release', 'jobs_zz_drawing_revision', 'zzz_actor_stamp',
                                                      'ad_finish_kept', 'ac_finish_guard', 'jobs_rework_stage_guard']) AS r(tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = r.tg AND NOT t.tgisinternal)
   UNION ALL
   SELECT 'function ' || f.fn || ' naming ' || f.flag FROM (VALUES
     ('finish_job', 'tolra.finish_job'), ('reopen_job', 'quoteflow.job_reopen'), ('_reopen_job_signed_off', 'quoteflow.job_reopen'),
     ('record_job_inspection', 'quoteflow.job_inspection'), ('fail_job_inspection', 'quoteflow.job_inspection'),
     ('open_replacement_rework', 'quoteflow.job_rework'), ('finish_job_rework', 'quoteflow.job_rework')) AS f(fn, flag)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.fn AND position(f.flag IN p.prosrc) > 0)
   UNION ALL
   SELECT 'function has_org_role(text[])' WHERE to_regprocedure('public.has_org_role(text[])') IS NULL
 ) m;
 IF v_missing IS NOT NULL THEN
  RAISE EXCEPTION '157: required job objects are missing or are not as releases 022 to 113 left them (%); stop and check release preflight', v_missing
    USING HINT = 'jobs_integrity_prerequisite';
 END IF;
 IF to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') IS NULL OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'start_machine_run') <> 1 THEN
  RAISE EXCEPTION '157: public.start_machine_run (049''s 8-argument function, once) is missing; stop and check release preflight' USING HINT = 'jobs_integrity_prerequisite';
 END IF;
 SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');
 IF v IS DISTINCT FROM '2147348075e8d7d38639bd11c9da0c30' AND v IS DISTINCT FROM 'e5a66b0a8b183e1f6a51927bca89953e' THEN
  RAISE EXCEPTION '157: public.start_machine_run is neither 049''s nor 157''s; stop and compare it first' USING HINT = 'jobs_integrity_prerequisite';
 END IF;
 IF to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()');
  IF v IS DISTINCT FROM '72b0718e820a59a960f01654b82c6d1d' THEN
   RAISE EXCEPTION '157: a function public.jobs_integrity_guard() exists and is not 157''s; stop and compare it first' USING HINT = 'jobs_integrity_name_taken';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal)
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 23 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                      AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
  RAISE EXCEPTION '157: a trigger named jobs_zzz_integrity_guard exists on public.jobs and is not 157''s; stop and compare it first' USING HINT = 'jobs_integrity_name_taken';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything on jobs and in public that 157 must not touch (the other triggers on jobs, its policies, its grants and row
-- security, and every other function in public: body, definer flag, grants, settings; start_machine_run is left out of it and has its own before/after check below). The self-check requires the identical fingerprint.
-- Session-only helper, dropped before COMMIT.
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
-- start_machine_run before: everything about it except its body (definer flag, settings, grants, result, arguments with their defaults, volatility, owner, language).
CREATE TEMP TABLE p157_smr_before ON COMMIT DROP AS SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');

-- ---- 1. start_machine_run, the trigger function and the trigger (the canonical body of the proposal, verbatim) ----------------------------------------
-- ---- start_machine_run: 049's function (supabase/migrations/049_paused_machine_ack.sql, the 8-argument form, which CI installs) BODY VERBATIM, plus exactly two
-- statements around its own update of the job's start time: PERFORM set_config('tolra.job_start', p_job::text, TRUE) immediately before
-- "UPDATE public.jobs SET started_at = v_at WHERE id = p_job" and PERFORM set_config('tolra.job_start', '', TRUE) immediately after it (transaction-local, as
-- finish_job brackets its own update with tolra.finish_job, 044/061). That names the job whose first start this function is writing, which is what the guard
-- (rule C1, first start) lets through. Same signature, SECURITY DEFINER, search_path, grants (CREATE OR REPLACE keeps them); nothing else in it changes:
-- the self-check compares its definer flag, settings and grants before and after, and that the only difference in its body is those two statements.
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
    PERFORM set_config('tolra.job_start', p_job::text, TRUE);
    UPDATE public.jobs SET started_at = v_at WHERE id = p_job;
    PERFORM set_config('tolra.job_start', '', TRUE);
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

CREATE OR REPLACE FUNCTION public.jobs_integrity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job       BOOLEAN := FALSE;
  v_withdraws BOOLEAN;
BEGIN
  -- 157 jobs_integrity_guard (marker; the release guard and the verify script recognise this body by it and by its checksum).
  -- SECURITY DEFINER, on the 044 precedent (public.jobs_finish_guard), for ONE reason: rule C5 must see the job's delivery notes and invoices
  -- whatever the caller may read. An office or admin member whose Invoices section is hidden is refused every invoices row by the RESTRICTIVE policy
  -- "invoices section access" (012, section_allowed('invoices')), so an invoker lookup would find nothing and C5 would fail open for exactly that person.
  -- What the definer rights are used for, and nothing else: the two EXISTS tests in C5, each pinned to organization_id = OLD.organization_id and to this
  -- job (its id; its job_no for a delivery note linked by reference only), answering the trigger only yes or no. No row, name or number is read out,
  -- returned, logged or put in a message. The error text is fixed: it quotes no delivery-note or invoice number, so a person who may not see invoices
  -- learns only that the job has gone out or been invoiced (reopen_job's message, which quotes them, is deliberately not copied).
  -- The function reads and writes nothing else, takes no argument, calls no dynamic SQL, and is a trigger function only: EXECUTE is revoked from PUBLIC,
  -- anon and authenticated below, so it is not callable from the browser. Every table and function is schema-qualified; the search_path is pinned.
  -- Who is a browser session is decided as in 044's definer jobs_finish_guard: current_setting('role') is the request role PostgREST sets for the
  -- request and SECURITY DEFINER does not change it (only current_user changes), and session_user is the login role; so the exemption below still
  -- identifies anon / authenticated sessions here, and the service role, the owner, the SQL editor and imports stay exempt.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- C6 (INSERT): a browser session creates a job with no start time and no finish time. Nothing below this branch is reached on an INSERT and OLD (NULL here;
  -- any OLD.column read would fail) is not referenced on it. No session flag lets a browser INSERT carry either time: every path that creates a job
  -- (create_job, convert_sales_order, the data imports) leaves both empty, and the one importer that writes them (import_legacy_tenant) runs as the database
  -- owner, which the exemption above lets through. Rules C3, C2 and C5 (customer, job number, the pass) do not apply to an INSERT.
  IF TG_OP = 'INSERT' THEN
    IF NEW.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'Job %: a job can''t be created with a start time; start it from the Job Board (Play or Start on the bench).', NEW.job_no
        USING ERRCODE = '42501', HINT = 'start_via_rpc';
    END IF;
    IF NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'Job %: a job can''t be created with a finish time; finish it from the Job Board (Finish).', NEW.job_no
        USING ERRCODE = '42501', HINT = 'finish_via_rpc';
    END IF;
    RETURN NEW;
  END IF;
  -- C1: a recorded start is kept (HINT start_kept).
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'Job %: its start time is kept as it was recorded and can''t be changed or cleared.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'start_kept';
  END IF;
  -- C1, first start: set from empty only inside start_machine_run (Play and the bench Start), which names this job in tolra.job_start around its own
  -- update and clears it straight after, or inside finish_job (tolra.finish_job = 'on', as for C4). Neither setting can be made by a browser: they are
  -- transaction-local settings made by those two definer functions with literal names; PostgREST runs every request (an RPC call, an update) in its OWN
  -- transaction, so a setting an earlier call made does not reach a later statement; the browser has no way to run set_config (pg_catalog is not an exposed
  -- schema) and no function in public takes a setting name (every set_config in the migrations names its setting literally).
  IF OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
     AND coalesce(current_setting('tolra.finish_job', TRUE), '') <> 'on'
     AND current_setting('tolra.job_start', TRUE) IS DISTINCT FROM NEW.id::TEXT THEN
    RAISE EXCEPTION 'Job %: start it from the Job Board (Play or Start on the bench); the start time can''t be set by editing the job.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'start_via_rpc';
  END IF;
  -- C4: a finish time is set only by finish_job, which names itself in tolra.finish_job for its own statement.
  IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND coalesce(current_setting('tolra.finish_job', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'Job %: finish it from the Job Board (Finish); the finish time can''t be set by editing the job.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'finish_via_rpc';
  END IF;
  -- Does this update withdraw a passed inspection? Worked out once. (034's jobs_worksheet_version_release has already turned a worksheet edit of an
  -- inspected job into inspected_at NULL and stage 'inspection', so a worksheet edit shows up here as one of these two.)
  v_withdraws := (OLD.inspected_at IS NOT NULL AND NEW.inspected_at IS NULL) OR (OLD.stage = 'complete' AND NEW.stage IS DISTINCT FROM 'complete');
  IF v_withdraws THEN
    -- An authorised workflow names this job: record_job_inspection, fail_job_inspection, open_replacement_rework, finish_job_rework (quoteflow.job_inspection),
    -- rework (quoteflow.job_rework) or reopen (quoteflow.job_reopen). It then withdraws the pass for every role, with its own reason recorded; neither C5 nor C2 applies.
    v_job := current_setting('quoteflow.job_inspection', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
          OR current_setting('quoteflow.job_rework', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
          OR current_setting('quoteflow.job_reopen', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
    -- C5, every browser role (office and admin included): once the job has gone out or been invoiced, an ordinary edit can't withdraw its passed inspection.
    -- Same tests as reopen_job (081, 113), copied faithfully, scoped to this company and this job with the definer's rights (see the top of this function):
    -- a delivery note of this company that is despatched, delivered or signed, linked by job_id or (job_id empty) by the job number; or an invoice of this
    -- company for this job that is not draft, void, voided, cancelled or canceled.
    IF NOT v_job AND (
         EXISTS (SELECT 1 FROM public.delivery_notes d
                 WHERE d.organization_id = OLD.organization_id AND d.status IN ('despatched', 'delivered', 'signed')
                   AND (d.job_id = OLD.id OR (d.job_id IS NULL AND nullif(btrim(d.job_ref), '') = OLD.job_no)))
         OR EXISTS (SELECT 1 FROM public.invoices i
                    WHERE i.job_id = OLD.id AND i.organization_id = OLD.organization_id
                      AND lower(coalesce(i.status, 'draft')) NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled'))) THEN
      RAISE EXCEPTION 'Job %: it has been despatched or invoiced, so its passed inspection stands. If something is wrong with it, record a failed inspection or raise rework.', OLD.job_no
        USING ERRCODE = '42501', HINT = 'released_pass_kept';
    END IF;
  END IF;
  -- C3 and C2 concern a workshop-only user (admin and office are unchanged by them). The role lookup runs only when one of them applies.
  -- has_org_role is itself SECURITY DEFINER (036) and answers from auth.uid() and the request's JWT claims, so it names the CALLER whether or not this function is definer.
  IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no OR v_withdraws THEN
    IF public.has_org_role(ARRAY['workshop']) AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
      IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no THEN
        RAISE EXCEPTION 'Job %: only admin and office staff change a job''s customer or job number.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'job_identity_office';
      END IF;
      IF v_withdraws AND NOT v_job THEN
        RAISE EXCEPTION 'Job %: its passed inspection is withdrawn only by the office or an admin, or by recording a failed inspection, raising rework or reopening the job.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'inspection_kept';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
-- Grants (044 precedent: REVOKE ALL FROM PUBLIC, anon, authenticated; no GRANT). service_role is left as the platform default has it, as 044 leaves it
-- for jobs_finish_guard: a trigger function needs no EXECUTE privilege to fire (it is checked when the trigger is created, by the owner), and service_role
-- is exempt inside the body anyway; revoking it (as 156 does for its RPC helpers) is not needed to keep the browser out.
REVOKE ALL ON FUNCTION public.jobs_integrity_guard() FROM PUBLIC, anon, authenticated;

-- One trigger, BEFORE INSERT OR UPDATE (one trigger; the function branches on TG_OP), created once (running this again changes nothing). Its name sorts after jobs_zz_drawing_revision and before zzz_actor_stamp.
DO $p157_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal) THEN
    CREATE TRIGGER jobs_zzz_integrity_guard BEFORE INSERT OR UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.jobs_integrity_guard();
  END IF;
END
$p157_trigger$;

DO $p157_self_check$
DECLARE
  v_s TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '72b0718e820a59a960f01654b82c6d1d'
                   AND p.prorettype = 'trigger'::regtype AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION '157 self-check: public.jobs_integrity_guard() must be 157''s trigger function, SECURITY DEFINER (as 044''s jobs_finish_guard), with its search_path pinned';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))) THEN
    RAISE EXCEPTION '157 self-check: public.jobs_integrity_guard() must be callable by no API role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                   AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 23 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                   AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
    RAISE EXCEPTION '157 self-check: jobs_zzz_integrity_guard must be the BEFORE INSERT OR UPDATE row trigger (no column list) running public.jobs_integrity_guard()';
  END IF;
  -- It runs after 022, 034 and 083's triggers and before 035's actor stamp (BEFORE row triggers fire in byte order of their names).
  IF NOT ('jobs_worksheet_version' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_worksheet_version_release' COLLATE "C" < 'jobs_zzz_integrity_guard'
          AND 'jobs_zz_drawing_revision' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_zzz_integrity_guard' COLLATE "C" < 'zzz_actor_stamp') THEN
    RAISE EXCEPTION '157 self-check: the trigger name must sort after the 022, 034 and 083 job triggers and before zzz_actor_stamp';
  END IF;
  -- start_machine_run: 157's body is 049's with exactly the two tolra.job_start statements added (each once); every other attribute (definer flag, settings, grants, signature, owner) is as before.
  SELECT regexp_replace(p.prosrc, '\s', '', 'g') INTO v_s FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)');
  IF v_s IS NULL OR md5(v_s) IS DISTINCT FROM 'e5a66b0a8b183e1f6a51927bca89953e'
     OR (length(v_s) - length(replace(v_s, 'PERFORMset_config(''tolra.job_start'',p_job::text,TRUE);', ''))) <> length('PERFORMset_config(''tolra.job_start'',p_job::text,TRUE);') OR (length(v_s) - length(replace(v_s, 'PERFORMset_config(''tolra.job_start'','''',TRUE);', ''))) <> length('PERFORMset_config(''tolra.job_start'','''',TRUE);')
     OR md5(replace(replace(v_s, 'PERFORMset_config(''tolra.job_start'',p_job::text,TRUE);', ''), 'PERFORMset_config(''tolra.job_start'','''',TRUE);', '')) IS DISTINCT FROM '2147348075e8d7d38639bd11c9da0c30' THEN
    RAISE EXCEPTION '157 self-check: public.start_machine_run must be 049''s body plus exactly the two tolra.job_start statements around its own update of the start time';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_smr_before EXCEPT SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)'))
     OR EXISTS (SELECT p.prosecdef::TEXT AS secdef, coalesce(p.proconfig::TEXT, '') AS config, coalesce(p.proacl::TEXT, '') AS acl, p.prorettype::TEXT AS ret, p.proargtypes::TEXT AS argtypes, pg_get_function_arguments(p.oid) AS args, p.provolatile::TEXT AS vol, p.proisstrict::TEXT AS strict, p.proleakproof::TEXT AS leakproof, p.proparallel::TEXT AS parallel, p.proowner::TEXT AS owner, p.prolang::TEXT AS lang FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') EXCEPT SELECT * FROM pg_temp.p157_smr_before) THEN
    RAISE EXCEPTION '157 self-check: public.start_machine_run changed in more than its body (definer flag, settings, grants, signature, owner or language)';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_before EXCEPT SELECT * FROM pg_temp.p157_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p157_fingerprint() EXCEPT SELECT * FROM pg_temp.p157_before) THEN
    RAISE EXCEPTION '157 self-check: another trigger, policy or grant on jobs, or another function in public (other than start_machine_run), changed';
  END IF;
END
$p157_self_check$;
DROP TABLE pg_temp.p157_before;
DROP TABLE pg_temp.p157_smr_before;
DROP FUNCTION pg_temp.p157_fingerprint();
COMMIT;
