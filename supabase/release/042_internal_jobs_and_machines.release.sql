-- 042_internal_jobs_and_machines.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 042: internal jobs, a new job straight from the Job Board, and the machines a job runs on (M1).
--
-- 1. Internal jobs (Rhys's requirement B). jobs.is_internal marks a job made for the company itself (rework of another job, tooling, a
--    fixture): no purchase order, the customer optional, the next number in the SAME J- sequence as converted jobs. Set when the job is
--    created and never changed (jobs_internal_immutable). A job can name one related job (jobs.related_job_id, same company, never
--    itself; the link is cleared if that job is removed); the board shows it both ways.
--    jobs.customer is no longer NOT NULL: a job without a customer must be internal (jobs_customer_unless_internal). An internal job is
--    never one converted from a sales order (jobs_internal_not_converted).
-- 2. The machines a job runs on (requirement A, data). job_machines: one row per job and machine with the estimated hours and the machine
--    booking made for it. Written only by create_job (no insert, update or delete grant for the API); read by everyone in the company
--    who reads jobs. M1 is create-only: a later change on the schedule does not write back here. Later work (machine runs, machines
--    carried over from sales-order lines) adds to this table rather than replacing it.
-- 3. public.create_job (requirement D, create): a job made directly on the Job Board, a customer job without a sales order or an internal
--    job, with its machines and their hours. In one transaction: the job number (the same per-company lock as convert_sales_order, then
--    next_doc_number('J')), the job, one machine booking per machine (the hours from its start, in parallel), the job_machines rows,
--    and the audit events CREATE_JOB (and OVERRIDE_MACHINE_CLASH when an admin books over another job).
--    A clash is found by the function itself from machine_bookings, against the stretches of time the schedule really draws (section 4:
--    the machine's working days and hours per day, day-split bookings, Europe/London wall clock). It is refused (42501, hint
--    machine_clash) unless the caller is an admin who books anyway WITH A REASON, which is recorded with the bookings found (ids, job
--    numbers, their times), who and when. The app's own list (p_clashes) is only a hint, recorded.
-- 4. The schedule's rule in SQL (booking_intervals and helpers) so every clash check, here and on the schedule, uses the same times.
-- 5. Every booking write goes through save_machine_booking / delete_machine_booking (SECURITY DEFINER; the same per-company lock as
--    create_job, taken BEFORE the clash check); authenticated loses INSERT, UPDATE and DELETE on machine_bookings (SELECT stays). The
--    schedule's "Book anyway" is an admin's recorded override with a reason, as on the Job Board.
-- 6. An internal job can't be despatched or invoiced (by its link or by a typed job number), and a delivery note's job must be the one
--    converted from its order: a trigger on delivery_notes and invoices, so the RPCs and any direct write are both held to it.
--
-- Every write starts with assert_privileged_aal() (033) and the new table carries the admin_mfa and support_read_only statement triggers
-- (033, 036). Nothing about the existing jobs or machine_bookings policies changes; the worksheet-version fields are unchanged.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. Internal jobs and the related job -----------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS related_job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ALTER COLUMN customer DROP NOT NULL;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_related_not_self;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_related_not_self CHECK (related_job_id IS NULL OR related_job_id <> id);
-- Every existing job has a customer (the column was NOT NULL until now), so validating is immediate. A blank customer on a new customer
-- job is refused by create_job; the table keeps the old rule (present), so imported rows with an empty name stay editable.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_customer_unless_internal;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_customer_unless_internal CHECK (is_internal OR customer IS NOT NULL) NOT VALID;
ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_customer_unless_internal;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_internal_not_converted;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_internal_not_converted CHECK (NOT is_internal OR converted_from_sales_order_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_jobs_related_job ON public.jobs (related_job_id) WHERE related_job_id IS NOT NULL;

DROP TRIGGER IF EXISTS zz_same_org_related_job_id ON public.jobs;
CREATE TRIGGER zz_same_org_related_job_id BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'related_job_id');

-- Internal or not is decided when the job is made and stays (for everyone: a customer job can't be relabelled internal, or back).
CREATE OR REPLACE FUNCTION public.jobs_internal_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_internal IS DISTINCT FROM OLD.is_internal THEN
    RAISE EXCEPTION 'Whether a job is internal is set when it is created and can''t be changed.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_internal_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_internal_immutable ON public.jobs;
CREATE TRIGGER jobs_internal_immutable BEFORE UPDATE OF is_internal ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_internal_immutable();

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The machines a job runs on ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_machines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  job_id          UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  machine_id      UUID NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
  estimated_hours NUMERIC NOT NULL CHECK (estimated_hours >= 0 AND estimated_hours <= 1000),
  booking_id      UUID REFERENCES public.machine_bookings(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_machines_one_per_machine UNIQUE (job_id, machine_id)
);
CREATE INDEX IF NOT EXISTS idx_job_machines_org ON public.job_machines (organization_id);
CREATE INDEX IF NOT EXISTS idx_job_machines_machine ON public.job_machines (machine_id);
CREATE INDEX IF NOT EXISTS idx_job_machines_booking ON public.job_machines (booking_id) WHERE booking_id IS NOT NULL;

ALTER TABLE public.job_machines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_machines rbac select" ON public.job_machines;
CREATE POLICY "job_machines rbac select" ON public.job_machines FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office', 'workshop', 'viewer']));
REVOKE ALL ON public.job_machines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_machines TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_job_id ON public.job_machines;
CREATE TRIGGER zz_same_org_job_id BEFORE INSERT OR UPDATE ON public.job_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('jobs', 'job_id');
DROP TRIGGER IF EXISTS zz_same_org_machine_id ON public.job_machines;
CREATE TRIGGER zz_same_org_machine_id BEFORE INSERT OR UPDATE ON public.job_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machines', 'machine_id');
DROP TRIGGER IF EXISTS zz_same_org_booking_id ON public.job_machines;
CREATE TRIGGER zz_same_org_booking_id BEFORE INSERT OR UPDATE ON public.job_machines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('machine_bookings', 'booking_id');

DROP TRIGGER IF EXISTS audit_job_machines_changes ON public.job_machines;
CREATE TRIGGER audit_job_machines_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_machines
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

DROP TRIGGER IF EXISTS support_read_only ON public.job_machines;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.job_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();
DROP TRIGGER IF EXISTS admin_mfa ON public.job_machines;
CREATE TRIGGER admin_mfa BEFORE INSERT OR UPDATE OR DELETE ON public.job_machines
  FOR EACH STATEMENT EXECUTE FUNCTION public.require_admin_mfa_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. Where a booking occupies its machine: the schedule's rule, in SQL ----------------------------------
-- lib/machine-schedule.ts (scheduleBooking, computeFinish, normaliseStart, planSegments) in SQL, so the database checks a clash against
-- the same stretches of time the schedule draws. Wall-clock times are Europe/London (the company's clock), never the session's zone.
--   * A booking split by day (038 day_plan): exactly its days, each from start to end on that date (24:00 = midnight at the end of the
--     day). A plan with any entry that is not a real date with valid times reads as no plan (as the app reads it); a time that doesn't
--     exist that day (the hour skipped in March) is skipped; a time that exists twice (the hour repeated in October) is the earlier
--     instant, as the browser reads it.
--   * Otherwise the default rule: from its start, hours counted inside the machine's day (08:00 to 08:00 + hours per day) on its working
--     days (ISO 1..7); a booking that STARTS on a day the machine doesn't work runs every day. No hours per day reads as 8; a machine with
--     negative hours or no working days is a plain stretch of start + hours. For a booking already started (p_now given), the hours left
--     (estimate minus hours done) are counted from now, as the schedule does; p_now NULL means "as planned from its start".
-- These are plain (invoker) functions with no table access; the SECURITY DEFINER writers below call them.
CREATE OR REPLACE FUNCTION public.booking_clock_minutes(p_text TEXT, p_allow_midnight_end BOOLEAN)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_allow_midnight_end AND p_text = '24:00' THEN 1440
              WHEN p_text ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN split_part(p_text, ':', 1)::INTEGER * 60 + split_part(p_text, ':', 2)::INTEGER END
$$;
REVOKE ALL ON FUNCTION public.booking_clock_minutes(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.booking_local_moment(p_date DATE, p_minutes INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_local TIMESTAMP;
  v_at    TIMESTAMPTZ;
BEGIN
  IF p_date IS NULL OR p_minutes IS NULL OR p_minutes < 0 OR p_minutes > 1440 THEN
    RETURN NULL;
  END IF;
  IF p_minutes = 1440 THEN
    RETURN ((p_date + 1)::TIMESTAMP) AT TIME ZONE 'Europe/London';
  END IF;
  v_local := p_date::TIMESTAMP + make_interval(mins => p_minutes);
  v_at := v_local AT TIME ZONE 'Europe/London';
  -- The hour the clocks go back (01:00 to 02:00 on the last Sunday of October) is on the wall clock twice. PostgreSQL reads it as the
  -- later instant (GMT); the browser's Date reads it as the EARLIER one (BST). The app's times are the reference, so the earlier instant
  -- is taken here whenever the hour before also reads as the same wall-clock time.
  IF ((v_at - INTERVAL '1 hour') AT TIME ZONE 'Europe/London') = v_local THEN
    v_at := v_at - INTERVAL '1 hour';
  END IF;
  -- A time the clocks skip (01:30 on the last Sunday of March) doesn't exist: the app refuses it; here it reads as none.
  IF (v_at AT TIME ZONE 'Europe/London') <> v_local THEN
    RETURN NULL;
  END IF;
  RETURN v_at;
END
$$;
REVOKE ALL ON FUNCTION public.booking_local_moment(DATE, INTEGER) FROM PUBLIC, anon, authenticated;

-- 08:00 Europe/London on the calendar day of p_at (plus p_days_ahead days): the start of a machine's day.
CREATE OR REPLACE FUNCTION public.booking_day_start(p_at TIMESTAMPTZ, p_days_ahead INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ((((p_at AT TIME ZONE 'Europe/London')::DATE + p_days_ahead)::TIMESTAMP) + INTERVAL '8 hours') AT TIME ZONE 'Europe/London'
$$;
REVOKE ALL ON FUNCTION public.booking_day_start(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.booking_is_working_day(p_at TIMESTAMPTZ, p_working_days INTEGER[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT extract(isodow FROM (p_at AT TIME ZONE 'Europe/London'))::INTEGER = ANY (coalesce(p_working_days, ARRAY[]::INTEGER[]))
$$;
REVOKE ALL ON FUNCTION public.booking_is_working_day(TIMESTAMPTZ, INTEGER[]) FROM PUBLIC, anon, authenticated;

-- First moment at or after p_from inside the machine's day (normaliseStart).
CREATE OR REPLACE FUNCTION public.booking_normalise_start(p_from TIMESTAMPTZ, p_hours_per_day NUMERIC, p_working_days INTEGER[], p_every_day BOOLEAN)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cursor TIMESTAMPTZ := p_from;
  v_start  TIMESTAMPTZ;
  v_end    TIMESTAMPTZ;
  i        INTEGER;
BEGIN
  IF coalesce(p_hours_per_day, 0) <= 0 OR coalesce(cardinality(p_working_days), 0) = 0 THEN
    RETURN p_from;
  END IF;
  FOR i IN 1..400 LOOP
    IF NOT p_every_day AND NOT public.booking_is_working_day(v_cursor, p_working_days) THEN
      v_cursor := public.booking_day_start(v_cursor, 1);
      CONTINUE;
    END IF;
    v_start := public.booking_day_start(v_cursor, 0);
    v_end := v_start + (p_hours_per_day * INTERVAL '1 hour');
    IF v_cursor < v_start THEN
      RETURN v_start;
    END IF;
    IF v_cursor >= v_end THEN
      v_cursor := public.booking_day_start(v_cursor, 1);
      CONTINUE;
    END IF;
    RETURN v_cursor;
  END LOOP;
  RETURN v_cursor;
END
$$;
REVOKE ALL ON FUNCTION public.booking_normalise_start(TIMESTAMPTZ, NUMERIC, INTEGER[], BOOLEAN) FROM PUBLIC, anon, authenticated;

-- End after p_hours of work from p_start, counting only the machine's hours (computeFinish). 20h on an 8h Mon-Fri machine from Fri 08:00
-- ends Tue 12:00; 16h from Fri 08:00 ends Mon 16:00 (Saturday and Sunday are not worked).
CREATE OR REPLACE FUNCTION public.booking_finish(p_start TIMESTAMPTZ, p_hours NUMERIC, p_hours_per_day NUMERIC, p_working_days INTEGER[], p_every_day BOOLEAN)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cursor    TIMESTAMPTZ;
  v_remaining NUMERIC := greatest(0, coalesce(p_hours, 0));
  v_end       TIMESTAMPTZ;
  v_avail     NUMERIC;
  i           INTEGER;
BEGIN
  IF coalesce(p_hours_per_day, 0) <= 0 OR coalesce(cardinality(p_working_days), 0) = 0 THEN
    RETURN p_start + (v_remaining * INTERVAL '1 hour');
  END IF;
  v_cursor := public.booking_normalise_start(p_start, p_hours_per_day, p_working_days, p_every_day);
  FOR i IN 1..800 LOOP
    EXIT WHEN v_remaining <= 0;
    v_end := public.booking_day_start(v_cursor, 0) + (p_hours_per_day * INTERVAL '1 hour');
    v_avail := extract(epoch FROM (v_end - v_cursor)) / 3600;
    IF v_remaining <= v_avail THEN
      RETURN v_cursor + (v_remaining * INTERVAL '1 hour');
    END IF;
    v_remaining := v_remaining - v_avail;
    v_cursor := public.booking_normalise_start(public.booking_day_start(v_cursor, 1), p_hours_per_day, p_working_days, p_every_day);
  END LOOP;
  RETURN v_cursor;
END
$$;
REVOKE ALL ON FUNCTION public.booking_finish(TIMESTAMPTZ, NUMERIC, NUMERIC, INTEGER[], BOOLEAN) FROM PUBLIC, anon, authenticated;

-- The stretches of machine time a booking occupies (scheduleBooking + intervalsOf), as half-open ranges [from, to).
CREATE OR REPLACE FUNCTION public.booking_intervals(p_start TIMESTAMPTZ, p_hours NUMERIC, p_hours_per_day NUMERIC, p_working_days INTEGER[],
                                                    p_day_plan JSONB, p_status TEXT, p_hours_done NUMERIC, p_now TIMESTAMPTZ)
RETURNS SETOF TSTZRANGE
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hpd    NUMERIC := CASE WHEN coalesce(p_hours_per_day, 0) = 0 THEN 8 ELSE p_hours_per_day END;
  v_days   INTEGER[] := coalesce(p_working_days, ARRAY[1, 2, 3, 4, 5]);
  v_elem   JSONB;
  v_date   DATE;
  v_s      INTEGER;
  v_e      INTEGER;
  v_from   TIMESTAMPTZ;
  v_to     TIMESTAMPTZ;
  v_ok     BOOLEAN := TRUE;
  v_any    BOOLEAN := FALSE;
  v_left   NUMERIC;
  v_every  BOOLEAN;
  v_finish TIMESTAMPTZ;
BEGIN
  IF p_start IS NULL THEN
    RETURN;
  END IF;
  IF p_day_plan IS NOT NULL AND jsonb_typeof(p_day_plan) = 'array' AND jsonb_array_length(p_day_plan) > 0 THEN
    -- First pass, as the app reads a row: one malformed entry and the whole plan is ignored (the default rule applies).
    FOR v_elem IN SELECT e.value FROM jsonb_array_elements(p_day_plan) AS e LOOP
      IF jsonb_typeof(v_elem) <> 'object' OR jsonb_typeof(v_elem -> 'date') <> 'string' OR jsonb_typeof(v_elem -> 'start') <> 'string'
         OR jsonb_typeof(v_elem -> 'end') <> 'string' OR (v_elem ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        v_ok := FALSE;
        EXIT;
      END IF;
      BEGIN
        v_date := (v_elem ->> 'date')::DATE;
      EXCEPTION WHEN OTHERS THEN
        v_ok := FALSE;
        EXIT;
      END;
      IF to_char(v_date, 'YYYY-MM-DD') <> (v_elem ->> 'date') THEN
        v_ok := FALSE;
        EXIT;
      END IF;
      v_s := public.booking_clock_minutes(v_elem ->> 'start', FALSE);
      v_e := public.booking_clock_minutes(v_elem ->> 'end', TRUE);
      IF v_s IS NULL OR v_e IS NULL OR v_e <= v_s THEN
        v_ok := FALSE;
        EXIT;
      END IF;
    END LOOP;
    IF v_ok THEN
      -- Second pass, as the app draws it: each day from its start to its end; a time the clocks skip is left out.
      FOR v_elem IN SELECT e.value FROM jsonb_array_elements(p_day_plan) AS e LOOP
        v_date := (v_elem ->> 'date')::DATE;
        v_from := public.booking_local_moment(v_date, public.booking_clock_minutes(v_elem ->> 'start', FALSE));
        v_to := public.booking_local_moment(v_date, public.booking_clock_minutes(v_elem ->> 'end', TRUE));
        CONTINUE WHEN v_from IS NULL OR v_to IS NULL OR v_to <= v_from;
        v_any := TRUE;
        RETURN NEXT tstzrange(v_from, v_to, '[)');
      END LOOP;
      IF v_any THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  v_left := CASE WHEN p_status = 'complete' THEN 0 ELSE greatest(0, coalesce(p_hours, 0) - coalesce(p_hours_done, 0)) END;
  v_every := NOT public.booking_is_working_day(p_start, v_days);
  IF p_status = 'complete' OR p_now IS NULL THEN
    v_finish := public.booking_finish(p_start, coalesce(p_hours, 0), v_hpd, v_days, v_every);
  ELSE
    v_finish := public.booking_finish(greatest(p_start, p_now), v_left, v_hpd, v_days, v_every);
  END IF;
  IF v_finish < p_start THEN
    v_finish := p_start;
  END IF;
  IF v_finish > p_start THEN
    RETURN NEXT tstzrange(p_start, v_finish, '[)');
  END IF;
  RETURN;
END
$$;
REVOKE ALL ON FUNCTION public.booking_intervals(TIMESTAMPTZ, NUMERIC, NUMERIC, INTEGER[], JSONB, TEXT, NUMERIC, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_intervals(TIMESTAMPTZ, NUMERIC, NUMERIC, INTEGER[], JSONB, TEXT, NUMERIC, TIMESTAMPTZ) TO authenticated;

-- The active bookings of a company on a machine whose time overlaps any of p_mine (the existing booking p_exclude left out when editing),
-- each with the stretches it occupies. Reads the table as the caller: only the SECURITY DEFINER writers call it.
CREATE OR REPLACE FUNCTION public.booking_clashes(p_org UUID, p_machine UUID, p_mine TSTZRANGE[], p_exclude UUID, p_now TIMESTAMPTZ)
RETURNS TABLE (booking_id UUID, job_no TEXT, intervals TSTZRANGE[])
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH theirs AS (
    SELECT b.id, b.job_no, array_agg(r ORDER BY lower(r)) AS intervals
    FROM public.machine_bookings b
    JOIN public.machines m ON m.id = b.machine_id
    CROSS JOIN LATERAL public.booking_intervals(b.start_at, b.estimated_hours, m.hours_per_day, m.working_days, b.day_plan, b.status, b.hours_done, p_now) AS r
    WHERE b.organization_id = p_org AND b.machine_id = p_machine AND b.status <> 'complete' AND (p_exclude IS NULL OR b.id <> p_exclude)
    GROUP BY b.id, b.job_no
  )
  SELECT t.id, t.job_no, t.intervals
  FROM theirs t
  WHERE EXISTS (SELECT 1 FROM unnest(t.intervals) AS i CROSS JOIN unnest(coalesce(p_mine, ARRAY[]::TSTZRANGE[])) AS mi WHERE i && mi)
  ORDER BY t.job_no, t.id
$$;
REVOKE ALL ON FUNCTION public.booking_clashes(UUID, UUID, TSTZRANGE[], UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. A new job from the Job Board ------------------------------------------------------------------------
-- p_machines: [{"machine_id": uuid, "hours": number 0..1000, "start_at": timestamptz}], at most 10, each machine once, active and in the
-- caller's company. Each machine gets its own booking from its own start (machines run in parallel). Starts and p_required must fall in
-- 2000-01-01 .. 2100-12-31.
-- Clashes are found HERE, from the table, with the schedule's own rule (section 4): for each requested machine, every booking of the
-- company on that machine that is not complete and whose stretches of time overlap the new booking's. The app's list (p_clashes, at most
-- 200 entries and 20000 characters) is accepted only as a hint and recorded; the list found here decides. Any clash: refused unless the
-- caller is an admin, p_clash_override is true and p_override_reason is given (3 to 500 characters); then audited as
-- OVERRIDE_MACHINE_CLASH with the reason, the bookings found (id, job number, times), the actor and the time.
DROP FUNCTION IF EXISTS public.create_job(TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB);
CREATE OR REPLACE FUNCTION public.create_job(p_customer TEXT, p_description TEXT, p_internal BOOLEAN, p_related UUID, p_required DATE,
                                             p_machines JSONB, p_clash_override BOOLEAN, p_clashes JSONB, p_override_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_internal   BOOLEAN := coalesce(p_internal, FALSE);
  v_customer   TEXT := nullif(btrim(coalesce(p_customer, '')), '');
  v_desc       TEXT := nullif(btrim(coalesce(p_description, '')), '');
  v_machines   JSONB := coalesce(p_machines, '[]'::JSONB);
  v_clashes    JSONB := coalesce(p_clashes, '[]'::JSONB);
  v_reason     TEXT := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_admin      BOOLEAN;
  v_related_no TEXT;
  v_clash_nos  TEXT[] := ARRAY[]::TEXT[];
  v_found      TEXT[];
  v_conf       JSONB;
  v_conflicts  JSONB := '[]'::JSONB;
  v_mine       TSTZRANGE[];
  v_job_id     UUID;
  v_job_no     TEXT;
  v_elem       JSONB;
  v_machine    UUID;
  v_name       TEXT;
  v_hpd        NUMERIC;
  v_wdays      INTEGER[];
  v_hours      NUMERIC;
  v_start      TIMESTAMPTZ;
  v_booking    UUID;
  v_pos        INTEGER := 0;
  v_seen       UUID[] := ARRAY[]::UUID[];
  v_plan       JSONB := '[]'::JSONB;
  v_done       JSONB := '[]'::JSONB;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can create jobs' USING ERRCODE = '42501';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);

  IF v_desc IS NULL OR length(v_desc) > 500 THEN
    RAISE EXCEPTION 'Enter a description (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  IF v_customer IS NULL AND NOT v_internal THEN
    RAISE EXCEPTION 'A customer job needs a customer. Tick Internal for a job made for the company itself.' USING ERRCODE = '22023';
  END IF;
  IF length(v_customer) > 200 THEN
    RAISE EXCEPTION 'The customer name is too long (up to 200 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_required IS NOT NULL AND (p_required < DATE '2000-01-01' OR p_required > DATE '2100-12-31') THEN
    RAISE EXCEPTION 'The date required must be between 2000 and 2100.' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason is too long (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  -- ELSIF is reached only when the list is an array, so jsonb_array_length never sees anything else.
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

  IF p_related IS NOT NULL THEN
    SELECT j.job_no INTO v_related_no FROM public.jobs j WHERE j.id = p_related AND j.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Related job not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- The per-company lock (the same one convert_sales_order and save_machine_booking take, held to the end of this transaction) is taken
  -- BEFORE the clash check, so clash check, job number and the inserts are one serialised step per company: two jobs asked for the same
  -- machine and time at the same moment can't both pass the check. A refusal happens before next_doc_number, so it burns no number.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  -- Check every machine and find what is already booked over its time, before anything is written or a number is taken.
  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_machines) AS e LOOP
    IF jsonb_typeof(v_elem) <> 'object' OR jsonb_typeof(v_elem -> 'hours') <> 'number' OR jsonb_typeof(v_elem -> 'machine_id') <> 'string'
       OR jsonb_typeof(v_elem -> 'start_at') <> 'string' THEN
      RAISE EXCEPTION 'Each machine needs a machine, its hours and a start.' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_machine := (v_elem ->> 'machine_id')::UUID;
      v_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Each machine needs a machine, its hours and a start.' USING ERRCODE = '22023';
    END;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    IF v_hours < 0 OR v_hours > 1000 THEN
      RAISE EXCEPTION 'Hours must be between 0 and 1000.' USING ERRCODE = '22023';
    END IF;
    IF v_start < TIMESTAMPTZ '2000-01-01 00:00:00+00' OR v_start >= TIMESTAMPTZ '2101-01-01 00:00:00+00' THEN
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

    -- The new booking's own stretches of time (the schedule's rule), and every active booking on the machine that overlaps them.
    v_mine := ARRAY(SELECT r FROM public.booking_intervals(v_start, v_hours, v_hpd, v_wdays, NULL, 'booked', 0, now()) AS r);
    SELECT jsonb_agg(jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'booking_id', c.booking_id, 'job_no', c.job_no,
                                        'intervals', (SELECT jsonb_agg(jsonb_build_array(lower(i), upper(i))) FROM unnest(c.intervals) AS i))),
           array_agg(DISTINCT coalesce(c.job_no, '(no job number)'))
      INTO v_conf, v_found
    FROM public.booking_clashes(v_org, v_machine, v_mine, NULL, now()) AS c;
    IF v_found IS NOT NULL THEN
      v_clash_nos := v_clash_nos || v_found;
      v_conflicts := v_conflicts || v_conf;
    END IF;

    v_plan := v_plan || jsonb_build_object('machine_id', v_machine, 'machine', v_name, 'hours', v_hours, 'start_at', v_start,
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

  -- The job number, under the lock taken above, so a job created here and an order converted at the same moment never take the same number.
  v_job_no := public.next_doc_number('J');

  INSERT INTO public.jobs (organization_id, job_no, customer, description, stage, status, due_date, date_required, drawings, is_internal, related_job_id)
  VALUES (v_org, v_job_no, v_customer, v_desc, 'material', 'on_track', p_required, p_required, '[]'::JSONB, v_internal, p_related)
  RETURNING id INTO v_job_id;

  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(v_plan) AS e LOOP
    v_machine := (v_elem ->> 'machine_id')::UUID;
    v_hours := (v_elem ->> 'hours')::NUMERIC;
    v_start := (v_elem ->> 'start_at')::TIMESTAMPTZ;
    INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, description, start_at, estimated_hours, status)
    VALUES (v_org, v_machine, v_job_id, v_job_no, v_desc, v_start, v_hours, 'booked')
    RETURNING id INTO v_booking;
    INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id, position, created_by)
    VALUES (v_org, v_job_id, v_machine, v_hours, v_booking, v_pos, auth.uid());
    v_done := v_done || (v_elem || jsonb_build_object('booking_id', v_booking));
    v_pos := v_pos + 1;
  END LOOP;

  PERFORM security_audit.log_named_event(v_org, 'CREATE_JOB', 'jobs', v_job_id::TEXT,
    jsonb_build_object('job_no', v_job_no, 'internal', v_internal, 'customer', v_customer, 'related_job_id', p_related,
                       'related_job_no', v_related_no, 'date_required', p_required, 'machines', v_done));
  IF cardinality(v_clash_nos) > 0 THEN
    PERFORM security_audit.log_named_event(v_org, 'OVERRIDE_MACHINE_CLASH', 'jobs', v_job_id::TEXT,
      jsonb_build_object('job_no', v_job_no, 'reason', v_reason, 'conflicts', v_conflicts, 'clashing_job_nos', to_jsonb(v_clash_nos),
                         'actor_user_id', auth.uid(), 'at', now(), 'machines', v_done, 'client_clashes', v_clashes));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id, 'job_no', v_job_no);
END
$$;
REVOKE ALL ON FUNCTION public.create_job(TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job(TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Every booking write goes through the database ---------------------------------------------------------
-- save_machine_booking makes or changes one booking (the schedule's booking form, its edit form, Mark running / complete): the same
-- per-company lock as create_job, taken BEFORE the clash check, so a booking made here and a job made on the Job Board at the same
-- moment can't both take the same machine time. The clash check runs when the booking is new or its machine time changes (machine, start,
-- hours, split days; hours done going down; a complete booking reopened); a status or notes change, or hours done going up, doesn't
-- re-check (it can't take more time). A clash is refused (42501, hint machine_clash) unless the caller is an admin who books anyway with a
-- reason (3 to 500 characters), recorded as OVERRIDE_MACHINE_CLASH on the booking with the bookings found, the actor and the time.
-- p_day_plan: NULL leaves an existing plan alone; p_clear_day_plan removes it (back to the default rule). The 038 plan check still applies.
-- A retired machine takes no new booking and no booking moved onto it; a booking already on a machine retired since stays editable.
-- Returns the row as stored. delete_machine_booking removes one (admin, office, workshop, own company); a job_machines row linked to it
-- stays, unlinked. M1 is create-only on the Job Board, but the plan in job_machines follows the schedule's edits (see the UPDATE below).
-- After this, authenticated has no INSERT, UPDATE or DELETE on machine_bookings (SELECT stays; the four 003 policies stay as written but
-- no longer grant anything): nothing writes the table but these functions and create_job.
CREATE OR REPLACE FUNCTION public.save_machine_booking(p_id UUID, p_machine UUID, p_job UUID, p_job_no TEXT, p_description TEXT, p_start TIMESTAMPTZ,
                                                       p_hours NUMERIC, p_hours_done NUMERIC, p_status TEXT, p_notes TEXT, p_day_plan JSONB,
                                                       p_clear_day_plan BOOLEAN, p_clash_override BOOLEAN, p_override_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_admin   BOOLEAN;
  v_hours   NUMERIC := coalesce(p_hours, 0);
  v_done    NUMERIC := coalesce(p_hours_done, 0);
  v_status  TEXT := coalesce(p_status, 'booked');
  v_reason  TEXT := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_old     public.machine_bookings%ROWTYPE;
  v_row     public.machine_bookings%ROWTYPE;
  v_hpd     NUMERIC;
  v_wdays   INTEGER[];
  v_plan    JSONB;
  v_check   BOOLEAN;
  v_mine    TSTZRANGE[];
  v_conf    JSONB;
  v_nos     TEXT[];
  v_active  BOOLEAN;
  v_jm      public.job_machines%ROWTYPE;
  v_jm_target UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can book machines' USING ERRCODE = '42501';
  END IF;
  v_admin := public.has_org_role(ARRAY['admin']);

  IF p_machine IS NULL THEN
    RAISE EXCEPTION 'Pick a machine.' USING ERRCODE = '22023';
  END IF;
  IF v_hours < 0 OR v_hours > 1000 THEN
    RAISE EXCEPTION 'Hours must be between 0 and 1000.' USING ERRCODE = '22023';
  END IF;
  IF v_done < 0 OR v_done > 1000 THEN
    RAISE EXCEPTION 'Hours done must be between 0 and 1000.' USING ERRCODE = '22023';
  END IF;
  IF v_status NOT IN ('booked', 'running', 'complete') THEN
    RAISE EXCEPTION 'Status must be booked, running or complete.' USING ERRCODE = '22023';
  END IF;
  IF p_start IS NULL OR p_start < TIMESTAMPTZ '2000-01-01 00:00:00+00' OR p_start >= TIMESTAMPTZ '2101-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'A start must be between 2000 and 2100.' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_job_no, '')) > 100 OR length(coalesce(p_description, '')) > 500 OR length(coalesce(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'The job number, description or notes are too long.' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason is too long (up to 500 characters).' USING ERRCODE = '22023';
  END IF;
  SELECT m.hours_per_day, m.working_days, coalesce(m.active, TRUE) INTO v_hpd, v_wdays, v_active FROM public.machines m
  WHERE m.id = p_machine AND m.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job AND j.organization_id = v_org) THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  -- Lock first (the same lock, in the same order, as create_job), then look, then write.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.machine_bookings b WHERE b.id = p_id AND b.organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0002';
    END IF;
    -- A booking stays editable on a machine retired since; nothing is moved ONTO a retired machine.
    IF NOT v_active AND v_old.machine_id IS DISTINCT FROM p_machine THEN
      RAISE EXCEPTION 'That machine is retired: pick an active one.' USING ERRCODE = '22023', HINT = 'machine_inactive';
    END IF;
    v_plan := CASE WHEN coalesce(p_clear_day_plan, FALSE) THEN NULL WHEN p_day_plan IS NULL THEN v_old.day_plan ELSE p_day_plan END;
    v_check := v_old.machine_id <> p_machine OR v_old.start_at <> p_start OR v_old.estimated_hours <> v_hours
               OR v_plan IS DISTINCT FROM v_old.day_plan OR v_done < coalesce(v_old.hours_done, 0)
               OR (v_old.status = 'complete' AND v_status <> 'complete');
  ELSE
    IF NOT v_active THEN
      RAISE EXCEPTION 'That machine is retired: pick an active one.' USING ERRCODE = '22023', HINT = 'machine_inactive';
    END IF;
    v_plan := CASE WHEN coalesce(p_clear_day_plan, FALSE) THEN NULL ELSE p_day_plan END;
    v_check := TRUE;
  END IF;
  IF v_status = 'complete' THEN
    v_check := FALSE; -- a complete booking occupies nothing
  END IF;

  IF v_check THEN
    v_mine := ARRAY(SELECT r FROM public.booking_intervals(p_start, v_hours, v_hpd, v_wdays, v_plan, v_status, v_done, now()) AS r);
    SELECT jsonb_agg(jsonb_build_object('booking_id', c.booking_id, 'job_no', c.job_no,
                                        'intervals', (SELECT jsonb_agg(jsonb_build_array(lower(i), upper(i))) FROM unnest(c.intervals) AS i))),
           array_agg(DISTINCT coalesce(c.job_no, '(no job number)') ORDER BY coalesce(c.job_no, '(no job number)'))
      INTO v_conf, v_nos
    FROM public.booking_clashes(v_org, p_machine, v_mine, p_id, now()) AS c;
    IF v_conf IS NOT NULL THEN
      IF NOT (v_admin AND coalesce(p_clash_override, FALSE)) THEN
        RAISE EXCEPTION 'This overlaps % on that machine. Pick a free time (only an admin can book over another job).',
          array_to_string(v_nos, ', ') USING ERRCODE = '42501', HINT = 'machine_clash';
      END IF;
      IF v_reason IS NULL OR length(v_reason) < 3 THEN
        RAISE EXCEPTION 'Give a reason for booking over another job (3 to 500 characters).' USING ERRCODE = '22023', HINT = 'override_reason';
      END IF;
    END IF;
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.machine_bookings
       SET machine_id = p_machine, job_id = p_job, job_no = coalesce(p_job_no, ''), description = p_description, start_at = p_start,
           estimated_hours = v_hours, hours_done = v_done, status = v_status, notes = p_notes, day_plan = v_plan
     WHERE id = p_id
     RETURNING * INTO v_row;
    -- The job's machine plan (job_machines, lead decision: the CURRENT plan, not a frozen estimate) follows a booking made for it:
    -- new hours (a split's total included) go to its row; a move to another machine re-points the row, or merges into the row the job
    -- already has for that machine (that row then names this booking); a booking given to another job leaves the row, unlinked.
    -- A booking with no job_machines row (one made on the schedule, or before this migration) changes nothing here.
    SELECT * INTO v_jm FROM public.job_machines jm WHERE jm.booking_id = p_id AND jm.organization_id = v_org;
    IF FOUND THEN
      IF p_job IS DISTINCT FROM v_jm.job_id THEN
        UPDATE public.job_machines SET booking_id = NULL WHERE id = v_jm.id;
      ELSIF v_jm.machine_id <> p_machine THEN
        SELECT jm.id INTO v_jm_target FROM public.job_machines jm WHERE jm.job_id = v_jm.job_id AND jm.machine_id = p_machine;
        IF v_jm_target IS NOT NULL THEN
          DELETE FROM public.job_machines WHERE id = v_jm.id;
          UPDATE public.job_machines SET booking_id = p_id, estimated_hours = v_hours WHERE id = v_jm_target;
        ELSE
          UPDATE public.job_machines SET machine_id = p_machine, estimated_hours = v_hours WHERE id = v_jm.id;
        END IF;
      ELSIF v_jm.estimated_hours <> v_hours THEN
        UPDATE public.job_machines SET estimated_hours = v_hours WHERE id = v_jm.id;
      END IF;
    END IF;
  ELSE
    INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, description, start_at, estimated_hours, hours_done, status, notes, day_plan)
    VALUES (v_org, p_machine, p_job, coalesce(p_job_no, ''), p_description, p_start, v_hours, v_done, v_status, p_notes, v_plan)
    RETURNING * INTO v_row;
  END IF;

  IF v_conf IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v_org, 'OVERRIDE_MACHINE_CLASH', 'machine_bookings', v_row.id::TEXT,
      jsonb_build_object('booking_id', v_row.id, 'job_no', v_row.job_no, 'machine_id', p_machine, 'reason', v_reason, 'conflicts', v_conf,
                         'clashing_job_nos', to_jsonb(v_nos), 'actor_user_id', auth.uid(), 'at', now(), 'new', p_id IS NULL));
  END IF;
  RETURN to_jsonb(v_row);
END
$$;
REVOKE ALL ON FUNCTION public.save_machine_booking(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_machine_booking(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, NUMERIC, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_machine_booking(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_id  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'Only admin, office or workshop staff can remove bookings' USING ERRCODE = '42501';
  END IF;
  -- A job's machine plan keeps its row; only the link to the removed booking goes (the foreign key does the same on its own).
  UPDATE public.job_machines SET booking_id = NULL WHERE booking_id = p_id AND organization_id = v_org;
  DELETE FROM public.machine_bookings b WHERE b.id = p_id AND b.organization_id = v_org RETURNING b.id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This booking couldn''t be removed: it was already removed, or you don''t have access to remove it.' USING ERRCODE = 'P0002';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.delete_machine_booking(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_machine_booking(UUID) TO authenticated;

REVOKE ALL ON public.machine_bookings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.machine_bookings TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. An internal job is never despatched or invoiced -------------------------------------------------------
-- On every insert and update of delivery_notes and invoices (a status change before despatch included):
--   * the linked job (job_id) can't be internal;
--   * a delivery note's free-text job reference (job_ref, typed on a manual note) is matched against this company's job numbers
--     (btrim(job_ref) = jobs.job_no, as 037's despatch check matches it): if it names an internal job it is refused; a reference that
--     names no job stays free text;
--   * when a delivery note's job or order link is set or changed, the job must be the one converted from that order (either side of
--     the link, as create_delivery_note accepts it). Rows already linked are not re-judged on this point by an unrelated update.
-- Named a_... so it runs before 037's delivery_notes_link_guard (triggers fire in name order) and an internal job is refused with
-- its own message. Runs as the owner so the job rows are read whatever the caller may see.
CREATE OR REPLACE FUNCTION public.job_despatch_billing_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_internal     BOOLEAN;
  v_order        UUID;
  v_job_no       TEXT;
  -- Read through jsonb: invoices have no sales_order_id or job_ref column, and a record field that doesn't exist can't be named.
  v_note_so      UUID := (to_jsonb(NEW) ->> 'sales_order_id')::UUID;
  v_old_so       UUID := CASE WHEN TG_OP = 'UPDATE' THEN (to_jsonb(OLD) ->> 'sales_order_id')::UUID END;
  v_ref          TEXT := nullif(btrim(coalesce(to_jsonb(NEW) ->> 'job_ref', '')), '');
  v_ref_internal BOOLEAN;
BEGIN
  IF v_ref IS NOT NULL THEN
    SELECT bool_or(j.is_internal) INTO v_ref_internal FROM public.jobs j WHERE j.organization_id = NEW.organization_id AND j.job_no = v_ref;
    IF coalesce(v_ref_internal, FALSE) THEN
      RAISE EXCEPTION 'Job % is internal: it has no customer order, so it can''t be despatched or invoiced.', v_ref
        USING ERRCODE = '42501', HINT = 'internal_job';
    END IF;
  END IF;
  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT j.is_internal, j.converted_from_sales_order_id, j.job_no INTO v_internal, v_order, v_job_no FROM public.jobs j WHERE j.id = NEW.job_id;
  IF coalesce(v_internal, FALSE) THEN
    RAISE EXCEPTION 'Job % is internal: it has no customer order, so it can''t be despatched or invoiced.', v_job_no
      USING ERRCODE = '42501', HINT = 'internal_job';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id AND v_note_so IS NOT DISTINCT FROM v_old_so THEN
    RETURN NEW;
  END IF;
  -- The link may be one-sided, as create_delivery_note accepts it (037): the order's converted_to_job_id naming the job counts too.
  IF v_note_so IS NOT NULL AND v_order IS DISTINCT FROM v_note_so
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = v_note_so AND so.converted_to_job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'Job % was not converted from this sales order, so it can''t go on this delivery note.', v_job_no
      USING ERRCODE = '42501', HINT = 'job_order_mismatch';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.job_despatch_billing_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_despatch_billing_guard ON public.delivery_notes;
DROP TRIGGER IF EXISTS a_job_despatch_billing_guard ON public.delivery_notes;
CREATE TRIGGER a_job_despatch_billing_guard BEFORE INSERT OR UPDATE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.job_despatch_billing_guard();
DROP TRIGGER IF EXISTS job_despatch_billing_guard ON public.invoices;
DROP TRIGGER IF EXISTS a_job_despatch_billing_guard ON public.invoices;
CREATE TRIGGER a_job_despatch_billing_guard BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.job_despatch_billing_guard();

COMMIT;
