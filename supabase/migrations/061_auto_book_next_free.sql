-- =====================================================================================================
-- 061: a machine picked on a job is booked on the schedule automatically at its NEXT FREE SLOT; a finished job comes off the schedule.
--
-- Rhys's decisions (15 Oct 2026): "When a machine is picked on a job, its booking goes on the machine schedule automatically at the NEXT
-- FREE SLOT: the machine's next free time in working hours, after its existing bookings, using the job's hours. Never moves other
-- bookings, so no clashes. Office can move it later." "Same rule for jobs created automatically from a sales order (machines planned on
-- the SO lines)." And: "when a job is finished it should come off the machine schedule automatically".
--
-- 1. machine_next_free_start(org, machine, hours, from, now) (internal: no API role may run it): the first moment at or after `from`
--    (never before `now`) that is inside the machine's day (08:00 to 08:00 + hours per day, Europe/London) on one of its working days,
--    AFTER the end of every stretch of time any active (booked or running) booking of the company occupies on that machine (042's
--    booking_intervals, counted from `now` as the schedule counts them), such that a booking of `hours` from there overlaps no active
--    booking (checked with 042's booking_clashes, the very check save_machine_booking makes). The machine's hours per day and working
--    days are read exactly as booking_intervals reads them (no hours per day: 8; no working days set: Monday to Friday; negative hours or
--    an empty list: a plain stretch of start + hours). A start on a working day keeps the booking to the working days (042's rule), so a
--    long job runs over the weekend only if the machine works it. NULL when the machine is not the company's.
-- 2. set_job_machines (the 043 body, same signature and result keys; new keys added to each machine of the result): a machine with no
--    start_at whose plan row is NEW in this call (just picked) and for which the job has no booking at all on that machine (linked,
--    adopted from the schedule, running or complete) is booked at machine_next_free_start, through save_machine_booking (042: the same
--    company lock, re-entered, its checks, its row audit), when its hours are above 0. Never with the clash override (a slot found here
--    never clashes; if it ever did, the save is refused). Optional per machine key "auto_book" (boolean): false keeps a new machine as a
--    plan row only; true also books an EXISTING plan row that has no booking (the app's "book at next free slot"). An explicit start_at
--    always wins (043's rule, unchanged). Hours 0: a plan row only, as before. Each machine of the result also carries auto_booked
--    (boolean) and finish_at (the booking's end by the schedule's rule, when a booking was written).
-- 3. carry_so_machines (the 043 body, used by convert_sales_order including 058's automatic path): every machine carried with hours
--    above 0 on an active machine is booked the same way, in plan order, each after the one before when two share a machine (they
--    can't: one row per machine). A retired machine, hours 0, or a booking refused (22023, 42501, P0002 from save_machine_booking, in a
--    sub-transaction) stays a plan row only; the reason is in the result and the CARRY_MACHINES event. LOCK ORDER as convert_sales_order:
--    the order's row, then the per-company lock 'job-no:<org>' (re-entered when called from convert_sales_order), then the job's row.
--    Before 061 a direct call took no company lock at all. The result keeps machines_carried, hours_carried and machines; adds
--    machines_booked; each machine adds booking_id, start_at, finish_at, booked and why.
-- 4. finish_job (the 044 body, same signature and result keys, plus bookings_completed): after the job's open runs end (their bookings
--    complete, as before), every remaining booking of THIS job that is not complete (booked, or running with no open run: never played,
--    paused, bench) is completed through 044's machine_booking_mirror (hence save_machine_booking, its row audit): hours done kept as
--    recorded (the runs' hours; nothing invented), estimate unchanged, so the machine's later time is free. One FINISH_COMPLETES_BOOKINGS
--    event lists them. A job already finished returns as before and changes nothing (idempotent replay). Other jobs' bookings are never
--    read for writing. LOCK ORDER (044): company lock, the job's row, then the booking rows.
--
-- Unchanged: save_machine_booking, delete_machine_booking, booking_intervals, booking_clashes (no body here), create_job (the New job
-- dialog already sends the machine's next free time), convert_sales_order (058's body calls carry_so_machines), RLS, grants on tables.
-- 056 (machine plan integrity, not on main) replaces save_machine_booking and machine_booking_mirror and calls set_job_machines; 061
-- calls them positionally with the 14 / 4 arguments both versions accept, so 061 and 056 apply in either order.
--
-- Forward only, safe to run more than once (CREATE OR REPLACE only; no data is written by the migration itself).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The machine's next free slot --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.machine_next_free_start(p_org UUID, p_machine UUID, p_hours NUMERIC, p_from TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now    TIMESTAMPTZ := coalesce(p_now, now());
  v_hpd    NUMERIC;
  v_days   INTEGER[];
  v_rhpd   NUMERIC;
  v_rdays  INTEGER[];
  v_cursor TIMESTAMPTZ;
  v_last   TIMESTAMPTZ;
  v_start  TIMESTAMPTZ;
  v_mine   TSTZRANGE[];
  v_clash  TIMESTAMPTZ;
  i        INTEGER;
BEGIN
  SELECT m.hours_per_day, m.working_days INTO v_rhpd, v_rdays FROM public.machines m WHERE m.id = p_machine AND m.organization_id = p_org;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- As booking_intervals reads the machine.
  v_hpd := CASE WHEN coalesce(v_rhpd, 0) = 0 THEN 8 ELSE v_rhpd END;
  v_days := coalesce(v_rdays, ARRAY[1, 2, 3, 4, 5]);
  v_cursor := greatest(coalesce(p_from, v_now), v_now);

  -- After every active booking on the machine: the end of the last stretch any of them occupies (the schedule's rule, from now).
  SELECT max(upper(r)) INTO v_last
  FROM public.machine_bookings b
  JOIN public.machines m ON m.id = b.machine_id
  CROSS JOIN LATERAL public.booking_intervals(b.start_at, b.estimated_hours, m.hours_per_day, m.working_days, b.day_plan, b.status, b.hours_done, v_now) AS r
  WHERE b.organization_id = p_org AND b.machine_id = p_machine AND b.status <> 'complete';
  IF v_last IS NOT NULL AND v_last > v_cursor THEN
    v_cursor := v_last;
  END IF;

  -- Into the machine's day, then proven free with the check save_machine_booking makes; past anything found (never expected) and again.
  FOR i IN 1..100 LOOP
    v_start := public.booking_normalise_start(v_cursor, v_hpd, v_days, FALSE);
    v_mine := ARRAY(SELECT r FROM public.booking_intervals(v_start, coalesce(p_hours, 0), v_rhpd, v_rdays, NULL, 'booked', 0, v_now) AS r);
    SELECT max(upper(iv)) INTO v_clash FROM public.booking_clashes(p_org, p_machine, v_mine, NULL, v_now) AS c CROSS JOIN LATERAL unnest(c.intervals) AS iv;
    IF v_clash IS NULL THEN
      RETURN v_start;
    END IF;
    v_cursor := greatest(v_clash, v_start + INTERVAL '1 minute');
  END LOOP;
  RAISE EXCEPTION 'No free time found on that machine.' USING ERRCODE = '22023', HINT = 'no_free_slot';
END
$$;
REVOKE ALL ON FUNCTION public.machine_next_free_start(UUID, UUID, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.machine_next_free_start(UUID, UUID, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ) IS
  '061: the machine''s next free start in working hours after every active booking, proven clash-free with booking_clashes. Internal.';

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Editing the machines on a job: a machine just picked goes on the schedule at its next free slot -----------------------------
-- The 043 body (see its header for the lock order and the clash rule), plus the automatic booking described in this file's header.
CREATE OR REPLACE FUNCTION public.set_job_machines(p_job UUID, p_machines JSONB, p_clash_override BOOLEAN, p_clashes JSONB, p_override_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_job        public.jobs%ROWTYPE;
  v_machines   JSONB := coalesce(p_machines, '[]'::JSONB);
  v_clashes    JSONB := coalesce(p_clashes, '[]'::JSONB);
  v_reason     TEXT := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_admin      BOOLEAN;
  v_clash_nos  TEXT[] := ARRAY[]::TEXT[];
  v_found      TEXT[];
  v_conf       JSONB;
  v_conflicts  JSONB := '[]'::JSONB;
  v_plan       JSONB := '[]'::JSONB;
  v_elem       JSONB;
  v_machine    UUID;
  v_name       TEXT;
  v_hpd        NUMERIC;
  v_wdays      INTEGER[];
  v_hours      NUMERIC;
  v_start      TIMESTAMPTZ;
  v_eff_start  TIMESTAMPTZ;
  v_check      BOOLEAN;
  v_auto       BOOLEAN;
  v_auto_ask   BOOLEAN;
  v_finish     TIMESTAMPTZ;
  v_link       public.job_machines%ROWTYPE;
  v_booking    public.machine_bookings%ROWTYPE;
  v_booking_id UUID;
  v_link_id    UUID;
  v_bstatus    TEXT;
  v_saved      JSONB;
  v_gone       RECORD;
  v_mine       TSTZRANGE[];
  v_pos        INTEGER := 0;
  v_seen       UUID[] := ARRAY[]::UUID[];
  v_before     JSONB;
  v_done       JSONB := '[]'::JSONB;
  v_removed    JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can change a job''s machines' USING ERRCODE = '42501';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);
  IF jsonb_typeof(v_machines) <> 'array' THEN
    RAISE EXCEPTION 'Machines must be a list.' USING ERRCODE = '22023';
  ELSIF jsonb_array_length(v_machines) > 10 THEN
    RAISE EXCEPTION 'Up to 10 machines per job.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_clashes) <> 'array' THEN
    RAISE EXCEPTION 'Clashes must be a list.' USING ERRCODE = '22023';
  ELSIF jsonb_array_length(v_clashes) > 200 THEN
    RAISE EXCEPTION 'Too many clashes listed (up to 200).' USING ERRCODE = '22023';
  ELSIF length(v_clashes::TEXT) > 20000 THEN
    RAISE EXCEPTION 'The clash list is too long (up to 20000 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for booking over another job (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
  END IF;

  -- Lock first (the company lock, as create_job and save_machine_booking take it first), then the job's row, then look, then write.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- Check every machine and find what another booking occupies over its time, before anything is written.
  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_machines) AS e LOOP
    IF jsonb_typeof(v_elem) <> 'object' OR coalesce(jsonb_typeof(v_elem -> 'hours'), 'missing') <> 'number' OR coalesce(jsonb_typeof(v_elem -> 'machine_id'), 'missing') <> 'string'
       OR (v_elem ? 'start_at' AND jsonb_typeof(v_elem -> 'start_at') NOT IN ('string', 'null'))
       OR (v_elem ? 'auto_book' AND jsonb_typeof(v_elem -> 'auto_book') NOT IN ('boolean', 'null')) THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours (and, to book it, a start).' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_machine := (v_elem ->> 'machine_id')::UUID;
      v_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Each machine needs a machine and its hours (and, to book it, a start).' USING ERRCODE = '22023';
    END;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    v_auto_ask := (v_elem ->> 'auto_book')::BOOLEAN;
    IF v_hours < 0 OR v_hours > 1000 THEN
      RAISE EXCEPTION 'Hours must be between 0 and 1000.' USING ERRCODE = '22023';
    END IF;
    IF v_start IS NOT NULL AND (v_start < TIMESTAMPTZ '2000-01-01 00:00:00+00' OR v_start >= TIMESTAMPTZ '2101-01-01 00:00:00+00') THEN
      RAISE EXCEPTION 'A start must be between 2000 and 2100.' USING ERRCODE = '22023';
    END IF;
    IF v_machine = ANY (v_seen) THEN
      RAISE EXCEPTION 'Each machine can be added once.' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_machine;
    SELECT m.name, m.hours_per_day, m.working_days INTO v_name, v_hpd, v_wdays
    FROM public.machines m WHERE m.id = v_machine AND m.organization_id = v_org AND coalesce(m.active, TRUE);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
    END IF;

    -- What this row does to the schedule: a new booking (a start given, or 061's next free slot), a booked booking moved or resized, or nothing.
    v_link_id := NULL; v_booking_id := NULL; v_bstatus := NULL; v_eff_start := v_start; v_check := v_start IS NOT NULL; v_auto := FALSE;
    SELECT * INTO v_link FROM public.job_machines jm WHERE jm.job_id = p_job AND jm.machine_id = v_machine;
    IF FOUND THEN
      v_link_id := v_link.id;
      IF v_link.booking_id IS NOT NULL THEN
        SELECT * INTO v_booking FROM public.machine_bookings b WHERE b.id = v_link.booking_id AND b.organization_id = v_org FOR UPDATE;
        IF FOUND THEN
          v_booking_id := v_booking.id;
          v_bstatus := v_booking.status;
          IF v_booking.status = 'booked' THEN
            v_eff_start := coalesce(v_start, v_booking.start_at);
            v_check := v_eff_start <> v_booking.start_at OR v_hours <> v_booking.estimated_hours;
          ELSE
            v_eff_start := NULL; -- running or complete: left as it is
            v_check := FALSE;
          END IF;
        END IF;
      END IF;
    END IF;

    -- 061: no start given, no booking: a machine just picked (or one the caller asks for with auto_book) goes on at the next free slot,
    -- unless the job already has any booking on that machine (one made on the schedule, running or complete): never a second booking.
    IF v_start IS NULL AND v_booking_id IS NULL AND v_hours > 0
       AND coalesce(v_auto_ask, v_link_id IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.machine_bookings b WHERE b.organization_id = v_org AND b.job_id = p_job AND b.machine_id = v_machine) THEN
      v_eff_start := public.machine_next_free_start(v_org, v_machine, v_hours, now(), now());
      v_auto := v_eff_start IS NOT NULL;
      v_check := v_auto;
    END IF;

    v_found := NULL;
    v_finish := NULL;
    IF v_check THEN
      -- The same inputs save_machine_booking will check with: the booking's real hours done; its day plan is cleared by that write, so none.
      v_mine := ARRAY(SELECT r FROM public.booking_intervals(v_eff_start, v_hours, v_hpd, v_wdays, NULL, 'booked',
                                                              CASE WHEN v_booking_id IS NOT NULL THEN coalesce(v_booking.hours_done, 0) ELSE 0 END, now()) AS r);
      v_finish := (SELECT max(upper(r)) FROM unnest(v_mine) AS r);
      SELECT jsonb_agg(jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'booking_id', c.booking_id, 'job_no', c.job_no,
                                          'intervals', (SELECT jsonb_agg(jsonb_build_array(lower(i), upper(i))) FROM unnest(c.intervals) AS i))),
             array_agg(DISTINCT coalesce(c.job_no, '(no job number)'))
        INTO v_conf, v_found
      FROM public.booking_clashes(v_org, v_machine, v_mine, v_booking_id, now()) AS c;
      IF v_found IS NOT NULL THEN
        v_clash_nos := v_clash_nos || v_found;
        v_conflicts := v_conflicts || v_conf;
      END IF;
    END IF;
    v_plan := v_plan || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'hours', v_hours, 'start_at', v_eff_start, 'write', v_check,
                                           'auto', v_auto, 'finish_at', v_finish,
                                           'link_id', v_link_id, 'booking_id', v_booking_id, 'booking_status', v_bstatus,
                                           'b_description', CASE WHEN v_booking_id IS NOT NULL THEN left(v_booking.description, 500) END,
                                           'b_done', CASE WHEN v_booking_id IS NOT NULL THEN v_booking.hours_done END,
                                           'b_notes', CASE WHEN v_booking_id IS NOT NULL THEN left(v_booking.notes, 2000) END,
                                           'clashes', to_jsonb(coalesce(v_found, ARRAY[]::TEXT[])));
  END LOOP;
  SELECT array_agg(DISTINCT n ORDER BY n) INTO v_clash_nos FROM unnest(v_clash_nos) AS n;
  v_clash_nos := coalesce(v_clash_nos, ARRAY[]::TEXT[]);

  -- Booking over another job: an admin's decision, with a reason, recorded; everyone else picks a free time.
  IF cardinality(v_clash_nos) > 0 THEN
    IF NOT (v_admin AND coalesce(p_clash_override, FALSE)) THEN
      RAISE EXCEPTION 'A machine is already booked at that time (%). Pick a free time (only an admin can book over another job).',
        array_to_string(v_clash_nos, ', ') USING ERRCODE = '42501', HINT = 'machine_clash';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 3 THEN
      RAISE EXCEPTION 'Give a reason for booking over another job (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('machine_id', jm.machine_id, 'hours', jm.estimated_hours, 'booking_id', jm.booking_id) ORDER BY jm.position), '[]'::JSONB)
    INTO v_before FROM public.job_machines jm WHERE jm.job_id = p_job;

  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_plan) AS e LOOP
    v_machine := (v_elem ->> 'machine_id')::UUID;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    v_eff_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    v_link_id := (v_elem ->> 'link_id')::UUID;
    v_booking_id := (v_elem ->> 'booking_id')::UUID;
    v_auto := (v_elem ->> 'auto')::BOOLEAN;
    IF v_link_id IS NULL THEN
      INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by)
      VALUES (v_org, p_job, v_machine, v_hours, NULL, v_pos, auth.uid())
      RETURNING id INTO v_link_id;
    END IF;
    IF v_booking_id IS NOT NULL THEN
      IF (v_elem ->> 'write')::BOOLEAN THEN
        -- Moved or resized through the schedule's own function: it re-checks under the same lock and its plan-follow writes the row's hours.
        -- A booking from before 042 may carry longer text than save_machine_booking takes: cut to its limits (job number 100, text 500, notes 2000).
        PERFORM public.save_machine_booking(v_booking_id, v_machine, p_job, left(v_job.job_no, 100), v_elem ->> 'b_description', v_eff_start, v_hours,
                                            (v_elem ->> 'b_done')::NUMERIC, 'booked', v_elem ->> 'b_notes', NULL, TRUE, p_clash_override, p_override_reason);
        UPDATE public.job_machines SET position = v_pos WHERE id = v_link_id AND position <> v_pos;
      ELSE
        UPDATE public.job_machines SET estimated_hours = v_hours, position = v_pos WHERE id = v_link_id AND (estimated_hours <> v_hours OR position <> v_pos);
      END IF;
    ELSIF v_eff_start IS NOT NULL THEN
      -- A new booking: from the start given (the caller's override applies), or at the next free slot (never an override: it is free).
      v_saved := public.save_machine_booking(NULL, v_machine, p_job, left(v_job.job_no, 100), left(coalesce(v_job.description, ''), 500), v_eff_start, v_hours,
                                             0, 'booked', NULL, NULL, FALSE,
                                             CASE WHEN v_auto THEN FALSE ELSE p_clash_override END, CASE WHEN v_auto THEN NULL ELSE p_override_reason END);
      v_booking_id := (v_saved ->> 'id')::UUID;
      UPDATE public.job_machines SET estimated_hours = v_hours, booking_id = v_booking_id, position = v_pos WHERE id = v_link_id;
    ELSE
      UPDATE public.job_machines SET estimated_hours = v_hours, position = v_pos WHERE id = v_link_id AND (estimated_hours <> v_hours OR position <> v_pos);
    END IF;
    v_done := v_done || jsonb_build_object('machine_id', v_machine, 'machine', v_elem ->> 'machine', 'hours', v_hours, 'start_at', v_eff_start,
                                           'booking_id', v_booking_id, 'clashes', v_elem -> 'clashes',
                                           'auto_booked', coalesce(v_auto, FALSE), 'finish_at', v_elem -> 'finish_at');
    v_pos := v_pos + 1;
  END LOOP;

  -- Machines left out: off the job, and their booking off the schedule (delete_machine_booking) while it is only booked.
  v_removed := '[]'::JSONB;
  FOR v_gone IN
    SELECT jm.id, jm.machine_id, jm.estimated_hours, jm.booking_id, b.status
    FROM public.job_machines jm LEFT JOIN public.machine_bookings b ON b.id = jm.booking_id
    WHERE jm.job_id = p_job AND NOT (jm.machine_id = ANY (v_seen))
    ORDER BY jm.position
  LOOP
    DELETE FROM public.job_machines WHERE id = v_gone.id;
    IF v_gone.booking_id IS NOT NULL AND v_gone.status = 'booked' THEN
      PERFORM public.delete_machine_booking(v_gone.booking_id);
    END IF;
    v_removed := v_removed || jsonb_build_object('machine_id', v_gone.machine_id, 'hours', v_gone.estimated_hours, 'booking_id', v_gone.booking_id,
                                                 'booking_removed', v_gone.booking_id IS NOT NULL AND v_gone.status = 'booked');
  END LOOP;

  -- One OVERRIDE_MACHINE_CLASH per overridden booking, written by save_machine_booking on that booking (as the schedule does); the job's own
  -- event carries the override too (reason, bookings found, the bookings written), so the job's activity shows it without a second event.
  PERFORM security_audit.log_named_event(v_org, 'SET_JOB_MACHINES', 'jobs', p_job::TEXT,
    jsonb_build_object('job_no', v_job.job_no, 'before', v_before, 'after', v_done, 'removed', v_removed,
                       'override', CASE WHEN cardinality(v_clash_nos) > 0 THEN
                         jsonb_build_object('reason', v_reason, 'clashing_job_nos', to_jsonb(v_clash_nos), 'conflicts', v_conflicts, 'client_clashes', v_clashes,
                                            'booking_ids', (SELECT coalesce(jsonb_agg(d -> 'booking_id'), '[]'::JSONB) FROM jsonb_array_elements(v_done) d
                                                            WHERE jsonb_array_length(d -> 'clashes') > 0 AND (d ->> 'booking_id') IS NOT NULL),
                                            'actor_user_id', auth.uid(), 'at', now()) END));

  RETURN jsonb_build_object('job_id', p_job, 'job_no', v_job.job_no, 'machines', v_done, 'removed', v_removed);
END
$$;
REVOKE ALL ON FUNCTION public.set_job_machines(UUID, JSONB, BOOLEAN, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_job_machines(UUID, JSONB, BOOLEAN, JSONB, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Carrying an order's plan to its job: each machine booked at its next free slot --------------------------------------------
-- The 043 body (one carry per job; rows of lines that no longer exist dropped first), plus the company lock between the order's and the
-- job's row (convert_sales_order's own order), and a booking for each carried machine as this file's header describes.
CREATE OR REPLACE FUNCTION public.carry_so_machines(p_order UUID, p_job UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job_no  TEXT;
  v_desc    TEXT;
  v_base    INTEGER;
  v_count   INTEGER := 0;
  v_hours   NUMERIC := 0;
  v_done    JSONB := '[]'::JSONB;
  v_booked  JSONB := '[]'::JSONB;
  v_nbooked INTEGER := 0;
  v_elem    JSONB;
  v_machine UUID;
  v_mhours  NUMERIC;
  v_active  BOOLEAN;
  v_hpd     NUMERIC;
  v_wdays   INTEGER[];
  v_start   TIMESTAMPTZ;
  v_finish  TIMESTAMPTZ;
  v_saved   JSONB;
  v_bid     UUID;
  v_why     TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can carry an order''s machines to its job' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  -- convert_sales_order's lock order: the order's row, then the company lock (re-entered when called from it), then the job's row.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
  SELECT j.job_no, j.description INTO v_job_no, v_desc FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.converted_to_job_id IS DISTINCT FROM p_job THEN
    RAISE EXCEPTION 'That job was not made from this order.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_machines jm WHERE jm.job_id = p_job)
     OR EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = v_org AND a.action = 'CARRY_MACHINES' AND a.entity_table = 'jobs' AND a.entity_id = p_job::TEXT) THEN
    RAISE EXCEPTION 'This job already has its machine plan: change it on the job.' USING ERRCODE = '42501', HINT = 'job_has_plan';
  END IF;

  UPDATE public.sales_order_line_machines m SET sales_order_line_id = l.id
  FROM public.sales_order_lines l
  WHERE m.sales_order_id = p_order AND m.sales_order_line_id IS NULL AND l.sales_order_id = p_order AND l.position = m.line_key;
  IF EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = p_order) THEN
    DELETE FROM public.sales_order_line_machines m
    WHERE m.sales_order_id = p_order AND NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = p_order AND l.position = m.line_key);
  END IF;

  v_base := 0;
  WITH plan AS (
    SELECT m.machine_id, sum(m.estimated_hours) AS hours,
           (array_agg(m.sales_order_line_id ORDER BY m.line_key, m.position))[1] AS source_line,
           min(m.line_key) AS first_line, min(m.position) AS first_pos,
           jsonb_agg(jsonb_build_object('line_key', m.line_key, 'line_id', m.sales_order_line_id, 'hours', m.estimated_hours) ORDER BY m.line_key, m.position) AS lines
    FROM public.sales_order_line_machines m
    WHERE m.sales_order_id = p_order AND m.organization_id = v_org
    GROUP BY m.machine_id
  ), carried AS (
    INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by, source_so_line_id)
    SELECT v_org, p_job, p.machine_id, p.hours, NULL, v_base + row_number() OVER (ORDER BY p.first_line, p.first_pos) - 1, auth.uid(), p.source_line
    FROM plan p
    ON CONFLICT (job_id, machine_id) DO NOTHING
    RETURNING machine_id, estimated_hours
  )
  SELECT count(*), coalesce(sum(c.estimated_hours), 0),
         coalesce(jsonb_agg(jsonb_build_object('machine_id', c.machine_id, 'machine', mc.name, 'hours', c.estimated_hours, 'lines', p.lines) ORDER BY p.first_line, p.first_pos), '[]'::JSONB)
    INTO v_count, v_hours, v_done
  FROM carried c JOIN plan p ON p.machine_id = c.machine_id JOIN public.machines mc ON mc.id = c.machine_id;

  -- 061: each carried machine on the schedule at its next free slot (in plan order), through the schedule's own function.
  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_done) AS e LOOP
    v_machine := (v_elem ->> 'machine_id')::UUID;
    v_mhours := (v_elem ->> 'hours')::NUMERIC;
    v_start := NULL; v_finish := NULL; v_bid := NULL; v_why := NULL;
    SELECT coalesce(m.active, TRUE), m.hours_per_day, m.working_days INTO v_active, v_hpd, v_wdays FROM public.machines m WHERE m.id = v_machine AND m.organization_id = v_org;
    IF coalesce(v_mhours, 0) <= 0 THEN
      v_why := 'no_hours';
    ELSIF NOT coalesce(v_active, FALSE) THEN
      v_why := 'machine_inactive';
    ELSE
      BEGIN
        v_start := public.machine_next_free_start(v_org, v_machine, v_mhours, now(), now());
        v_saved := public.save_machine_booking(NULL, v_machine, p_job, left(coalesce(v_job_no, ''), 100), left(coalesce(v_desc, ''), 500), v_start, v_mhours,
                                               0, 'booked', NULL, NULL, FALSE, FALSE, NULL);
        v_bid := (v_saved ->> 'id')::UUID;
        UPDATE public.job_machines SET booking_id = v_bid WHERE job_id = p_job AND machine_id = v_machine AND organization_id = v_org;
        v_finish := (SELECT max(upper(r)) FROM public.booking_intervals(v_start, v_mhours, v_hpd, v_wdays, NULL, 'booked', 0, now()) AS r);
        v_nbooked := v_nbooked + 1;
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '42501' OR SQLSTATE 'P0002' THEN
        v_start := NULL; v_bid := NULL; v_finish := NULL;
        v_why := coalesce(nullif(SQLERRM, ''), 'refused');
      END;
    END IF;
    v_booked := v_booked || (v_elem || jsonb_build_object('booked', v_bid IS NOT NULL, 'booking_id', v_bid, 'start_at', v_start, 'finish_at', v_finish, 'why', v_why));
  END LOOP;
  v_done := v_booked;

  IF v_count > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'CARRY_MACHINES', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job_no, 'so_number', v_order.so_number, 'order_id', p_order, 'machines', v_done, 'machines_booked', v_nbooked));
  END IF;
  RETURN jsonb_build_object('machines_carried', v_count, 'hours_carried', v_hours, 'machines', v_done, 'machines_booked', v_nbooked);
END
$$;
REVOKE ALL ON FUNCTION public.carry_so_machines(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.carry_so_machines(UUID, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Finish: the job's bookings come off the schedule ----------------------------------------------------------------------------
-- The 044 body (see its header), plus: every booking of this job still booked or running once its runs have ended is completed through
-- machine_booking_mirror (hours done as recorded), in start order, and listed in one FINISH_COMPLETES_BOOKINGS event.
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
  v_b     RECORD;
  v_ended JSONB := '[]'::JSONB;
  v_completed JSONB := '[]'::JSONB;
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. In-migration assertions -------------------------------------------------------------------------------------------------
DO $do$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.carry_so_machines(uuid,uuid)', 'public.set_job_machines(uuid,jsonb,boolean,jsonb,text)', 'public.finish_job(uuid,uuid,timestamp with time zone)']
  LOOP
    IF to_regprocedure(f) IS NULL OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(f))) = 0 THEN
      RAISE EXCEPTION '061: % does not start with the second-step check', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.machine_next_free_start(uuid,uuid,numeric,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.machine_next_free_start(uuid,uuid,numeric,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '061: machine_next_free_start must not be callable by an API role';
  END IF;
END
$do$;
