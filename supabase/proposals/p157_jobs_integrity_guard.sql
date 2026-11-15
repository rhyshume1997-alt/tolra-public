-- =====================================================================================================
-- p157 (post-144 release 157, after 156 in supabase/release-plan.json; 155 is reserved for AI credentials and not in this candidate):
-- jobs_integrity_guard. One trigger function and one trigger on public.jobs, and a re-created public.start_machine_run (049's body plus two statements), that close six confirmed defects for BROWSER sessions
-- (anon, authenticated; also inside definer functions, as for 034's, 037's and 081's job locks):
--   C1  a recorded start time (jobs.started_at) could be replaced or cleared by editing the job. Who started it (jobs.started_by)
--       was replaced or blanked with it.
--   C2  a workshop-only user could withdraw a passed inspection (and move a Complete job back to Awaiting inspection) just by editing
--       the worksheet or the stage; the same on a despatched or invoiced job (P1).
--   C5  (PM ruling 12:40 and 13:30 UTC, 15 Nov 2026) office and admin could withdraw the passed inspection of a DESPATCHED or INVOICED job by an
--       ordinary worksheet edit (P0). Now refused for every browser role (HINT released_pass_kept); a correction is a failed inspection or rework.
--   C3  a workshop-only user could change a job's customer or job number (P2).
--   C4  a finish time (jobs.finished_at) could be set by editing the job, including a back-dated one, without the Finish workflow.
--   C6  (PM ruling 15 Nov 2026, 'Option A') a job's FIRST start time could be set by editing the job (any time, back-dated or far future), not only by Play, the bench
--       Start or Finish; and a job could be INSERTED with a start or finish time already set.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/157_jobs_integrity_guard.release.sql, which adds the guard (the 034, 035, 037, 044/061, 081 and 083 job
-- objects in place), a before/after fingerprint of everything else on jobs and the self-check. Migration allowed for exactly the
-- 157 files, for development, scratch and CI; nothing in production or in a hosted project (PM, 15 Nov 2026).
-- Verify: supabase/verify/jobs_integrity_guard_157.sql (every row true).
-- Rollback: supabase/release/157_jobs_integrity_guard.rollback.sql (drops the trigger and the function and puts 049's start_machine_run back byte for byte; touches no row).
--
-- INPUTS: none (one new function, one new trigger and one re-created function). OUTPUTS: public.jobs_integrity_guard(), the trigger
--   jobs_zzz_integrity_guard on public.jobs, and public.start_machine_run (049's body plus its two tolra.job_start statements). The trigger only REFUSES (SQLSTATE 42501, with a HINT); it never widens a permission and
--   never changes a row.
-- WHEN IT RUNS: BEFORE INSERT OR UPDATE ... FOR EACH ROW, not column-limited (one trigger; the function branches on TG_OP; tgtype 23). PostgreSQL fires BEFORE row triggers in byte order of their
--   names, so jobs_zzz_integrity_guard runs AFTER jobs_worksheet_version (022), jobs_worksheet_version_release (034: when the
--   worksheet changes on an inspected job it has already set inspected_at and inspected_by to NULL and moved stage complete to
--   inspection) and jobs_zz_drawing_revision (083), and BEFORE zzz_actor_stamp (035). So it sees the row the other locks have settled.
-- WHO: the service role, the database owner, the SQL editor and imports are exempt (the same test as 034's jobs_release_guard).
--   Admin and office are not touched by C2 or C3; C5 applies to every browser role.
-- RULES (each refuses with ERRCODE 42501):
--   C1  started_at: once set it can't be changed or cleared (HINT start_kept). The FIRST start (from empty) is allowed only through an authorised server-timed
--       transition: start_machine_run (Play, and the bench Start), which names the job in tolra.job_start around its own update, or finish_job (which sets
--       tolra.finish_job to 'on' around its own update and fills started_at with coalesce(started_at, v_at)); otherwise it is refused (HINT start_via_rpc) for
--       every browser role. start_machine_run keeps clamping the time it is given (it refuses 2001 and clamps 2099, machine_run_client_time). Neither setting can
--       be made by a browser (see the comment in the function). The offline "machine taken" fallback (lib/offline/sync.ts) writes started_at directly and is
--       now refused: the job stays unstarted until the separate Offline Synchronisation change.
--       WHO STARTED IT: jobs.started_by is the actor column of started_at (035). aa_actor_keep keeps it at its old value on every
--       browser update and zzz_actor_stamp rewrites it only when started_at itself moves. Protecting started_at therefore protects
--       the starter's name as well; no other column is protected.
--   C6  INSERT (browser sessions only; the same exemption): a job can't be created with started_at or finished_at already set (HINT start_via_rpc /
--       finish_via_rpc). No flag exempts it: create_job, convert_sales_order and the data imports (076/079/085 import_company_data_run, called through
--       the SliQ route too) create jobs with both empty, and import_legacy_tenant (supabase/import, owner only, EXECUTE revoked from every API role) runs as the
--       database owner, which is exempt. Rules C2, C3 and C5 do not apply to an INSERT; OLD is not referenced on the INSERT branch.
--   C4  finished_at: an update that sets it from empty is refused unless the statement runs inside finish_job (which sets
--       tolra.finish_job to 'on' around its own update; HINT finish_via_rpc). Clearing it stays governed by 081's ad_finish_kept and
--       reopen_job, not repeated here.
--   C3  customer, job_no: refused for a workshop-only user, alone or inside a wider update (HINT job_identity_office). Workshop-only
--       is has_org_role(['workshop']) AND NOT has_org_role(['admin','office']), the test reopen_job (081) uses.
--   C2  a workshop-only user can't withdraw a passed inspection: the update is refused when OLD.inspected_at is set and NEW.inspected_at
--       is empty (this is how a worksheet edit shows up after 034's jobs_release_guard ran), or when OLD.stage is 'complete' and
--       NEW.stage is not (HINT inspection_kept), UNLESS an authorised workflow names this job in quoteflow.job_inspection (034, 037:
--       record_job_inspection, fail_job_inspection, open_replacement_rework, finish_job_rework), quoteflow.job_rework (037) or
--       quoteflow.job_reopen (081 reopen_job, 113 _reopen_job_signed_off). inspect_job (083) sets none of them itself and reaches
--       them through the functions it calls. An office or admin edit of a Complete job that has NOT gone out or been invoiced still withdraws the pass as before (see C5).
--   C5  every browser role (HINT released_pass_kept): the update is refused when it would withdraw a passed inspection (the same two tests as C2) AND
--       none of quoteflow.job_inspection / quoteflow.job_rework / quoteflow.job_reopen names this job AND the job has gone out or been invoiced, by
--       reopen_job's own tests (081, 113): a delivery note of the same company, despatched, delivered or signed, linked by job_id or (job_id empty) by
--       job number; or an invoice of the same company for this job whose status is not draft, void, voided, cancelled or canceled. Order in the
--       function: C1, C4, then the withdrawal test (once), then C5 for every role, then C3 and C2 for a workshop-only user. A workshop-only user
--       withdrawing the pass of a despatched or invoiced job therefore gets released_pass_kept, not inspection_kept. No lookup runs unless a withdrawal
--       is actually happening. Authorised workflows (fail, rework, reopen) name the job and are not refused by C5 (reopen_job has its own refusal).
-- SECURITY DEFINER (reviewed explicitly; the 044 precedent, public.jobs_finish_guard): the function is SECURITY DEFINER with search_path =
--   pg_catalog, public, only so that C5's lookups are not filtered by the caller's row-level security: "invoices section access" (012) is RESTRICTIVE
--   and hides every invoice from an office or admin member whose Invoices section is hidden, who would otherwise slip past C5. The lookups are two
--   EXISTS tests scoped to OLD.organization_id and this job; they return yes or no to the trigger only, and the error text is fixed and quotes no
--   delivery-note or invoice number. The browser-session test (current_setting('role') then session_user) is unchanged by SECURITY DEFINER, as in
--   044; has_org_role (036) is itself a definer helper answering from auth.uid(), so C2 and C3 name the same caller as before. EXECUTE is revoked
--   from PUBLIC, anon and authenticated (a trigger function needs no grant to fire); service_role is left as 044 leaves it for jobs_finish_guard.
-- DRAWING REVISION: a workshop-only person can never reach C2 through job_files_revision_change (034: a drawing attached with a revision
--   re-saves the job, which counts as a worksheet change): job_files_guard (034) lets only an admin attach or set a revision, and
--   set_job_drawing_revision (083) refuses a Complete job for everyone. The admin path is unchanged by 157 (it still withdraws the pass).
-- MUST NOT CHANGE: any existing function but start_machine_run (and that only by the two tolra.job_start statements), any trigger, grant, RLS policy or row; any RPC
--   permission (start_machine_run keeps its grants: CREATE OR REPLACE); company isolation. The grants of the new function: callable by no API role (REVOKE ALL FROM PUBLIC, anon,
--   authenticated; no GRANT). service_role keeps the platform default EXECUTE on it, unchanged.
-- BEHAVIOUR CHANGE FOR WORKSHOP USERS: editing the worksheet, the stage, the customer or the job number of a job that has passed
--   inspection is now refused (it used to withdraw the pass). Re-inspection, rework and reopen work as before.
-- BEHAVIOUR CHANGE FOR EVERYONE (C5): an office or admin edit that would withdraw the passed inspection of a despatched or invoiced job is refused.
-- BEHAVIOUR CHANGE FOR EVERYONE (C6): a job's first start time is set only by Play, the bench Start or Finish (editing the job, or the offline 'machine taken' fallback,
--   no longer records one), and a job can't be created with a start or finish time.
-- =====================================================================================================
BEGIN;

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

COMMIT;
