-- =====================================================================================================
-- Optional per-day split on machine bookings (Rhys's decision, schedule page "Split by day").
--
-- machine_bookings gets one nullable column, day_plan: an ordered list of {"date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM"}. NULL
-- (every booking that exists today) keeps the default rule exactly as it is: a booking is worked from its start on the machine's working days,
-- or on consecutive calendar days when it starts on a day the machine does not normally work (lib/machine-schedule.ts). A booking with a plan
-- is worked exactly from start to end (local wall-clock time) on each date listed. The company's working hours only label a day as basic or
-- out of hours in the app; they never block a plan, and nothing here or in the app calculates pay.
--
-- The database refuses a plan that is not well formed (public.booking_day_plan_ok, used by one CHECK on the table):
--   * a JSON array of 1 to 62 objects, each with exactly the keys "date" (a real calendar date written YYYY-MM-DD, 2000 to 2100), "start"
--     (text "HH:MM", 00:00 to 23:59) and "end" (text "HH:MM", 00:01 to 24:00, later than start on the same date: no overnight wrap, so
--     work past midnight is two days, 22:00-24:00 then 00:00-06:00);
--   * dates strictly ascending (so no date twice);
--   * the minutes add up to the booking's estimated hours: SUM(end - start, in wall-clock minutes) = round(estimated_hours * 60).
--     Minutes are the source of truth (3.33h = 200 minutes). The database can't know the company's time zone, so a time that doesn't
--     exist on a clock-change day is refused by the form, not here.
-- A change to estimated_hours on a booking that has a plan is therefore refused unless the plan is changed in the same statement.
--
-- Nothing else changes: the four tenant policies on machine_bookings (003, 006), the same-company triggers, the audit and read-only
-- support triggers, and the table grants already cover every column, so the new column is read and written by exactly the people
-- (admin, office, workshop; viewers read) and in exactly the company that can read and write the booking today. No policy is added,
-- dropped or widened.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================
ALTER TABLE public.machine_bookings ADD COLUMN IF NOT EXISTS day_plan JSONB;

CREATE OR REPLACE FUNCTION public.booking_day_plan_ok(p_plan JSONB, p_estimated_hours NUMERIC)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_elem  JSONB;
  v_text  TEXT;
  v_date  DATE;
  v_prev  DATE;
  v_start INTEGER;
  v_end   INTEGER;
  v_total INTEGER := 0;
  v_count INTEGER;
BEGIN
  IF p_plan IS NULL THEN
    RETURN TRUE;
  END IF;
  IF p_estimated_hours IS NULL OR jsonb_typeof(p_plan) <> 'array' THEN
    RETURN FALSE;
  END IF;
  v_count := jsonb_array_length(p_plan);
  IF v_count < 1 OR v_count > 62 THEN
    RETURN FALSE;
  END IF;
  FOR v_elem IN SELECT e.value FROM jsonb_array_elements(p_plan) AS e LOOP
    IF jsonb_typeof(v_elem) <> 'object' OR NOT (v_elem ?& ARRAY['date', 'start', 'end'])
       OR (SELECT count(*) FROM jsonb_object_keys(v_elem)) <> 3 THEN
      RETURN FALSE; -- exactly the three keys date, start and end
    END IF;
    IF jsonb_typeof(v_elem -> 'date') <> 'string' OR jsonb_typeof(v_elem -> 'start') <> 'string' OR jsonb_typeof(v_elem -> 'end') <> 'string' THEN
      RETURN FALSE;
    END IF;
    v_text := v_elem ->> 'date';
    IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN FALSE;
    END IF;
    BEGIN
      v_date := v_text::DATE;
    EXCEPTION WHEN OTHERS THEN
      RETURN FALSE; -- not a real calendar date (30 February, month 13)
    END;
    IF v_date < DATE '2000-01-01' OR v_date > DATE '2100-12-31' THEN
      RETURN FALSE;
    END IF;
    IF v_prev IS NOT NULL AND v_date <= v_prev THEN
      RETURN FALSE; -- not strictly ascending, or the same date twice
    END IF;
    v_prev := v_date;
    v_text := v_elem ->> 'start';
    IF v_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RETURN FALSE; -- start is 00:00 to 23:59
    END IF;
    v_start := substr(v_text, 1, 2)::INTEGER * 60 + substr(v_text, 4, 2)::INTEGER;
    v_text := v_elem ->> 'end';
    IF v_text !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' THEN
      RETURN FALSE; -- end is 00:00 to 24:00 (00:00 is then refused below: it is never after a start)
    END IF;
    v_end := substr(v_text, 1, 2)::INTEGER * 60 + substr(v_text, 4, 2)::INTEGER;
    IF v_end <= v_start THEN
      RETURN FALSE; -- ends at or before its start: no empty day, no overnight wrap
    END IF;
    v_total := v_total + (v_end - v_start);
  END LOOP;
  RETURN v_total = round(p_estimated_hours * 60);
END;
$$;

REVOKE ALL ON FUNCTION public.booking_day_plan_ok(JSONB, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_day_plan_ok(JSONB, NUMERIC) TO authenticated, service_role;

ALTER TABLE public.machine_bookings DROP CONSTRAINT IF EXISTS machine_bookings_day_plan_check;
ALTER TABLE public.machine_bookings ADD CONSTRAINT machine_bookings_day_plan_check
  CHECK (day_plan IS NULL OR public.booking_day_plan_ok(day_plan, estimated_hours));
